// `Carton.open`: the one entry point hosts, the CLI, the UI and the web client use (PLAN §15, wired as §3.1).
//
//   const carton = await Carton.open({ adapter: cardboardAdapter, store, hasher, actor,
//     sync: { transport, url, token }, media: { blobStore, encoders } });
//   const r = await carton.commit({ doc, base: header, author });   // {status: "confirmed", seq, ref} | pending | conflicts
//
// Every method is async because stores (IndexedDB, carton.db across processes) are. Removing `sync` and `media`
// leaves a working local Carton: history, cuts, fold in, `.cbproj`. Owner: foundation-core.
//
// How it persists: History (in memory, synchronous) is the model; every confirmed change is appended to the Store
// with an `absent` condition on its `[cut, seq]` key, which is the cross-process CAS of the local sequencer. Before
// each commit the cut's tail is re-read, so changes another process appended are seen; if another process still wins
// the race, the in-memory model is rebuilt from the store and the commit is retried (its id makes the retry safe).

import type { BlobStore, Hasher, HostAdapter, IdentitySource, ProxyEncoder, Store, StoreCondition, StoreWrite, Transport } from "./plugins.ts";
import type { Schema } from "./schema.ts";
import type { PresenceState } from "./sync/messages.ts";
import type { SyncStatus } from "./sync/index.ts";
import { STORE_TABLES as T, StateUnknown, type FoldOptions, type FoldPreview, type FoldResult, type HeldBase } from "./history/common.ts";
import { History, actorKey, groupOf, nodeId, parseNode, randomHex } from "./history/history.ts";
import * as E from "./engine/index.ts";
import type {
  Actor,
  CartonEvent,
  ChangeId,
  Choices,
  CommitResult,
  ConfirmedChange,
  CutKind,
  CutRecord,
  DagNode,
  DiffResult,
  Doc,
  EditKinds,
  Intent,
  MergeResult,
  NodeId,
  Notice,
  Op,
  PathKey,
  PinRow,
  Policy,
  Rec,
  ShallowExport,
  ShotDiff,
  StateRef,
  UndoEntry,
  Version,
} from "./types.ts";

export interface OpenOptions {
  adapter: HostAdapter;
  store: Store;
  /** SHA-256 provider; its sync form is installed for state hashes (node:crypto). Default: core's own SHA-256. */
  hasher?: Hasher;
  /** Who commits by default. An IdentitySource is asked per commit. */
  actor?: Actor | IdentitySource;
  /**
   * Create the project when the store is empty: a Main cut at `doc`, or (`import`) from a teammate's shallow `.cbproj`
   * of a project this machine doesn't have: their cuts become tracking cuts and a writable cut forks from their head.
   */
  init?: { doc: Doc; projectId?: string; cutName?: string } | { import: ShallowExport };
  /** `autoConnect: false`: the sync-lease holder connects itself, under its nonce (§6.2). */
  sync?: { transport: Transport; url: string; token: string | (() => Promise<string>); autoConnect?: boolean };
  media?: { blobStore: BlobStore; encoders?: ProxyEncoder[] };
  clock?: () => number;
  keyframeEvery?: number;
  /** A display name for this replica in lineage and dialogs ("Bob"). */
  name?: string;
}

/** A commit: the new state (`doc`) or ops, made on `base` (a header ref, an MCP rev, a pin, a held state, or the head). */
export interface CommitInput {
  doc?: Doc;
  ops?: Op[];
  /** Default: the head of `cut`. A string is a printed header ref (`main@57~3f9a1c0e b:… p:…`). */
  base?: StateRef | string | HeldBase;
  /** Default: the current cut. */
  cut?: string;
  /** Default: the handle's actor. */
  author?: Actor;
  intent?: Intent;
  kinds?: EditKinds;
  policy?: Policy;
  /** Decide cards a rebase raises (otherwise the result is `conflicts`). */
  choices?: Choices;
  /** Name the version this commit makes. */
  name?: string;
  /** A stable id (a retried `cb` call): a commit whose id is already confirmed returns that confirmation. */
  id?: ChangeId;
  /** Extra Store conditions for the append (a lease holder's `fence(nonce)`). */
  conditions?: StoreCondition[];
}

/** A read-only preview of a state (§9 R2-16): Compare and the A/B toggle render it; editing is disabled. */
export interface Preview {
  readonly ref: StateRef;
  readonly doc: Readonly<Doc>;
  readonly readOnly: true;
}

/** A pinned state for an out-of-process reader (agent, MCP, file view), with the header to print. */
export interface Pin {
  ref: StateRef;
  header: string;
}

export interface CartonSync {
  readonly status: SyncStatus;
  /** Start pushing (the lease holder passes its nonce, and stops when the store's nonce changes). */
  connect(opts?: { nonce?: string }): Promise<void>;
  /** Stop; `drain`: resolve once nothing is in flight (a hand-over). */
  disconnect(opts?: { drain?: boolean }): Promise<void>;
  presence(state: PresenceState | null): void;
}

export interface CartonMedia {
  /** Share a media file: hash it (1 MiB leaves), upload the tiers the project needs. Returns its media hash. */
  share(input: { path: string } | { blob: Blob }, opts?: { tiers?: ("T1" | "T2" | "T3")[] }): Promise<string>;
}

/** An open project. Cut ids are global ids; a cut's `name` is only a label. */
export interface Carton {
  readonly projectId: string;
  readonly schema: Schema;
  /** The current cut's id. */
  readonly cut: string;
  /** The Store this project was opened on (hosts keep their own local tables there, e.g. `views`). */
  readonly store: Store;

  /** Head of a cut (default: current): its ref and an owned copy of its state. */
  head(cut?: string): Promise<{ ref: StateRef; doc: Doc }>;
  /** The state at a ref (`git checkout` as a read). Throws StateUnknown for a ref it can't rebuild exactly. */
  checkout(ref: StateRef | string): Promise<Doc>;
  /** A ref's state and causal past (the pending ids a commit on it builds on). */
  resolve(ref: StateRef | string): Promise<{ doc: Doc; seq: number; causal: ChangeId[] }>;
  commit(input: CommitInput): Promise<CommitResult>;
  /** Pin a cut's head, or a held state (`doc`, e.g. a freeze view), for `owner` (a turn, view or MCP ref). */
  pin(opts: { owner: string; cut?: string; ttlMs?: number; doc?: Doc; by?: string }): Promise<Pin>;
  release(ref: StateRef, owner: string): Promise<void>;

  cuts(): Promise<CutRecord[]>;
  /** New cut (`cb cut new`): forks from `from` (default: the current cut's head). */
  fork(name: string, opts?: { from?: StateRef | string; kind?: CutKind }): Promise<CutRecord>;
  switchTo(cut: string): Promise<void>;
  /** Fold `from` (a cut id or a ref) into `into` (default: current cut). */
  /** With `check: true`, nothing is committed and `preview` tells what the fold would bring in. */
  fold(from: string | StateRef, opts?: FoldOptions & { into?: string }): Promise<FoldResult & { preview?: FoldPreview }>;
  /** Fold in some of it: everything except the rejected record paths, which an inverse change lists. */
  foldSome(from: string | StateRef, opts: FoldOptions & { into?: string; reject: PathKey[] }): Promise<FoldResult>;

  /** Compare: ops and plain-language changes from `a` to `b` (default `b`: current head), with the shot diff. */
  diff(a: StateRef | string, b?: StateRef | string, opts?: { shots?: boolean }): Promise<DiffResult>;
  /** Watch the changes: the shot diff alone. */
  shots(a: StateRef | string, b?: StateRef | string): Promise<ShotDiff>;
  /** History: versions of a cut, newest first. */
  log(opts?: { cut?: string; limit?: number; before?: number }): Promise<Version[]>;
  /** Name a version ("Sent to client, Monday"). */
  name(ref: StateRef | string, name: string): Promise<void>;
  /** Restore: the state at `ref`, saved as a new version on the current cut. */
  restore(ref: StateRef | string, opts?: { author?: Actor; cut?: string }): Promise<CommitResult>;
  /** Undo one change (revert by change). */
  revert(changeId: ChangeId, opts?: { author?: Actor; cut?: string }): Promise<CommitResult>;
  /** ⌘Z for an actor group (default: the handle actor's group). Remote teammates are never in it. */
  undo(group?: string, opts?: { cut?: string; author?: Actor }): Promise<CommitResult & { entry?: UndoEntry }>;
  undoStack(group?: string, opts?: { cut?: string }): Promise<UndoEntry[]>;
  /** Read-only preview of a state. */
  preview(ref: StateRef | string): Promise<Preview>;
  /** Credits: who last changed a record, down to the subagent. */
  credits(record: PathKey | readonly string[], opts?: { cut?: string }): Promise<Actor | null>;
  /** Notices for an actor (late conflicts, overwrites); `take` removes them. */
  notices(actor?: Actor, opts?: { take?: boolean }): Promise<Notice[]>;

  /** `.cbproj` collaboration (§13). */
  exportShallow(opts?: { cut?: string; to?: string }): Promise<ShallowExport>;
  importShallow(pkg: ShallowExport): Promise<{ status: string; cut?: string }>;

  on(listener: (event: CartonEvent) => void): () => void;
  /** Present when opened with `sync`. */
  readonly sync: CartonSync | null;
  /** Present when opened with `media`. */
  readonly media: CartonMedia | null;
  close(): Promise<void>;
}

const PROJECT = ["project"] as const;
interface ProjectMeta {
  projectId: string;
  schemaVersion: number;
  current: string;
  /** Every replica id that committed here (R10-02: claimed in hello). */
  rids: string[];
  exports?: [NodeId, { to: string; at: number }[]][];
  authors?: [NodeId, Record<PathKey, Actor>][];
}

export const Carton = {
  /** Open (or create, with `init`) a project in `store`. */
  async open(opts: OpenOptions): Promise<Carton> {
    if (opts.hasher?.sha256HexSync) E.setSyncHash(opts.hasher.sha256HexSync.bind(opts.hasher));
    const c = new CartonImpl(opts);
    await c.load();
    return c;
  },
};

class CartonImpl implements Carton {
  readonly schema: Schema;
  readonly store: Store;
  readonly sync: CartonSync | null = null;
  readonly media: CartonMedia | null = null;
  #opts: OpenOptions;
  #h!: History;
  #meta!: ProjectMeta;
  #rid = randomHex(12);
  /** Change number within this handle's rid. Kept here, not in History: a rebuild after a lost race must not reuse ids. */
  #n = 0;
  #listeners = new Set<(e: CartonEvent) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  #confirmed: { cut: string; change: ConfirmedChange }[] = [];
  #closed = false;

  constructor(opts: OpenOptions) {
    this.#opts = opts;
    this.schema = opts.adapter.schema;
    this.store = opts.store;
    if (opts.sync) {
      // The sync client lives in ./sync (owner: sync-sequencer); shared cuts route through it once it is wired in.
      this.sync = {
        status: "offline",
        connect: async () => {
          throw new Error("Carton sync: not wired yet (shared cuts land with the sync client)");
        },
        disconnect: async () => {},
        presence: () => {},
      };
    }
  }
  get projectId(): string {
    return this.#meta.projectId;
  }
  get cut(): string {
    return this.#h.current;
  }

  // ------------------------------------------------------------ load and persist
  async load(): Promise<void> {
    const s = this.store;
    let meta = await s.get<ProjectMeta>(T.meta, PROJECT);
    if (!meta) {
      const init = this.#opts.init;
      if (!init) throw new Error("Carton.open: the store holds no project (pass `init`)");
      if ("import" in init) return this.#createFromImport(init.import);
      const h = History.create(this.schema, init.doc, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, projectId: init.projectId ?? null, keyframeEvery: this.#opts.keyframeEvery, cut: init.cutName ?? "Main cut" });
      const cut = h.cut(h.current)!;
      meta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion, current: cut.id, rids: [this.#rid] };
      const ok = await s.write(
        [
          { table: T.meta, key: PROJECT, value: meta },
          { table: T.cuts, key: [cut.id], value: cut },
          { table: T.keyframes, key: [cut.id, 0], value: E.fork(init.doc, this.schema) },
        ],
        [{ table: T.meta, key: PROJECT, expect: "absent" }],
      );
      if (!ok) return this.load(); // another process created it first: open theirs
    }
    this.#meta = meta;
    await this.#rebuild();
  }
  async #createFromImport(pkg: ShallowExport): Promise<void> {
    const h = new History(this.schema, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, keyframeEvery: this.#opts.keyframeEvery });
    const res = h.importShallow(pkg);
    if (res.status !== "forked") throw new Error(`Carton.open: import gave ${res.status}`);
    const k = h.knowledge();
    const meta: ProjectMeta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion, current: h.current, rids: [this.#rid], authors: k.authors, exports: k.exports };
    const w: StoreWrite[] = [{ table: T.meta, key: PROJECT, value: meta }];
    for (const n of k.lineage) w.push({ table: T.lineage, key: [n.id], value: n });
    for (const [hash, doc] of k.states) w.push({ table: T.states, key: [hash], value: doc });
    for (const c of h.cuts()) w.push({ table: T.cuts, key: [c.id], value: c });
    if (!(await this.store.write(w, [{ table: T.meta, key: PROJECT, expect: "absent" }]))) return this.load();
    this.#meta = meta;
    await this.#rebuild();
  }
  // Rebuild the in-memory model from the store: knowledge first, then cuts parents-first, then names and pins.
  async #rebuild(): Promise<void> {
    const s = this.store;
    const meta = this.#meta;
    const h = new History(this.schema, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, projectId: meta.projectId, keyframeEvery: this.#opts.keyframeEvery });
    const lineage = (await s.range<DagNode>(T.lineage)).map((e) => e.value);
    const states = (await s.range<Doc>(T.states)).map((e): [string, Doc] => [e.key[0] as string, e.value]);
    h.loadKnowledge({ lineage, states, authors: meta.authors ?? [], exports: meta.exports ?? [] });
    const cuts = (await s.range<CutRecord>(T.cuts)).map((e) => e.value);
    const done = new Set<string>();
    const byId = new Map(cuts.map((c) => [c.id, c]));
    const add = async (c: CutRecord, stack: string[] = []): Promise<void> => {
      if (done.has(c.id)) return;
      if (stack.includes(c.id)) throw new Error("Carton: cut fork cycle");
      if (c.forkOf) {
        const p = byId.get(parseNode(c.forkOf).branchId);
        if (p) await add(p, [...stack, c.id]);
      }
      const root = c.forkOf || c.shallow ? null : ((await s.get<Doc>(T.keyframes, [c.id, 0])) ?? null);
      h.addCut({ id: c.id, name: c.name, forkOf: c.forkOf, root, ...(c.tracking ? { tracking: true } : {}), ...(c.shallow ? { shallow: true } : {}), owner: c.owner, kind: c.kind, ...(c.at !== undefined ? { at: c.at } : {}) });
      if (c.protected !== undefined || c.sequencer.kind !== "local") h.updateCut(c.id, { ...(c.protected !== undefined ? { protected: c.protected } : {}), sequencer: c.sequencer });
      done.add(c.id);
      if (!c.shallow) h.load(c.id, (await s.range<ConfirmedChange>(T.changes, { prefix: [c.id] })).map((e) => e.value));
    };
    for (const c of cuts) await add(c);
    for (const e of await s.range<{ name: string; at: number; by?: Actor }>(T.names)) h.nameVersion(nodeId(e.key[0] as string, e.key[1] as number), e.value.name, e.value.by);
    for (const e of await s.range<PinRow>(T.pins)) h.loadPin(e.value);
    if (byId.has(meta.current)) h.current = meta.current;
    h.onConfirmed = (cut, change) => this.#confirmed.push({ cut, change });
    this.#h = h;
  }
  // Re-read the tail of a cut (another process may have appended) and any new cuts.
  async #refresh(cut?: string): Promise<void> {
    const s = this.store;
    for (const e of await s.range<CutRecord>(T.cuts)) if (!this.#h.cut(e.key[0] as string)) return this.#rebuild();
    const cuts = cut ? [cut] : this.#h.cuts().filter((c) => !c.shallow).map((c) => c.id);
    for (const id of cuts) {
      const rows = (await s.range<ConfirmedChange>(T.changes, { prefix: [id], gt: [id, this.#h.headSeq(id)] })).map((e) => e.value);
      if (rows.length) this.#h.load(id, rows);
    }
  }
  /** Writes for every change History confirmed since the last flush, each conditioned on its slot being free. */
  async #flush(extra: StoreWrite[] = [], conditions: StoreCondition[] = []): Promise<boolean> {
    const confirmed = this.#confirmed.splice(0);
    const writes: StoreWrite[] = [...extra];
    const conds: StoreCondition[] = [...conditions];
    for (const { cut, change } of confirmed) {
      writes.push({ table: T.changes, key: [cut, change.seq], value: change }, { table: T.ids, key: [change.id], value: [cut, change.seq] });
      conds.push({ table: T.changes, key: [cut, change.seq], expect: "absent" });
      if (change.name) writes.push({ table: T.names, key: [cut, change.seq], value: { name: change.name, at: change.at, by: change.author } });
    }
    if (confirmed.length && !this.#meta.rids.includes(this.#rid)) {
      this.#meta = { ...this.#meta, rids: [...this.#meta.rids, this.#rid] };
      writes.push({ table: T.meta, key: PROJECT, value: this.#meta });
    }
    if (!writes.length) return true;
    const ok = await this.store.write(writes, conds);
    if (ok) for (const { cut, change } of confirmed) this.#emit({ type: "change", branchId: cut, seq: change.seq, change, local: true });
    return ok;
  }
  /** Run a History mutation under the handle's queue, persist what it confirmed, and retry after losing a race. */
  async #mutate<R>(cut: string | undefined, fn: () => R, opts: { extra?: () => StoreWrite[]; conditions?: StoreCondition[]; idempotent?: boolean } = {}): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.#closed) throw new Error("Carton: closed");
      for (let attempt = 0; ; attempt++) {
        await this.#refresh(cut);
        this.#confirmed.length = 0;
        const r = fn();
        if (await this.#flush(opts.extra?.() ?? [], opts.conditions ?? [])) return r;
        // another process appended first, or a caller's condition (a lease fence) failed: rebuild and retry
        await this.#rebuild();
        if (attempt >= 4 || !opts.idempotent) throw new Error("Carton: the store changed under this write (lost the append race or a condition failed)");
      }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }
  #emit(e: CartonEvent): void {
    for (const l of this.#listeners) l(e);
  }
  #actor(a?: Actor): Actor {
    if (a) return a;
    const x = this.#opts.actor;
    if (x && "current" in x) return x.current() ?? { kind: "human", id: "unknown" };
    return x ?? { kind: "human", id: "unknown" };
  }
  #node(ref: StateRef | string): NodeId {
    if (typeof ref !== "string") {
      const r = this.#h.resolve(ref);
      return nodeId(r.cutId, r.seq);
    }
    if (this.#h.cut(ref)) return this.#h.head(ref); // a cut id: its head
    if (/^[^~\s]+@\d+$/.test(ref) && this.#h.cut(parseNode(ref).branchId)) return ref; // a node id
    const r = this.#h.parseRef(ref);
    if ("legacy" in r) throw new StateUnknown(ref, "a 1.4.0 timestamp rev has no Carton state");
    this.#h.resolve(ref); // checks the hash: never a guess
    return nodeId(r.branchId, r.seq);
  }
  #doc(ref: StateRef | string): Doc {
    if (typeof ref === "string" && this.#h.cut(ref)) return this.#h.stateOf(this.#h.head(ref))!;
    if (typeof ref === "string" && /^[^~\s]+@\d+$/.test(ref)) {
      const d = this.#h.stateOf(ref);
      if (!d) throw new StateUnknown(ref, "state not held");
      return d;
    }
    return this.#h.resolve(ref).doc;
  }
  #notices(r: CommitResult): void {
    const ns = r.status === "confirmed" || r.status === "pending" ? r.notices : [];
    if (!ns.length) return;
    for (const n of ns) this.#emit({ type: "notice", notice: n });
  }
  async #saveNotices(r: CommitResult): Promise<void> {
    const ns = r.status === "confirmed" || r.status === "pending" ? r.notices : [];
    if (!ns.length) return;
    const at = this.#opts.clock?.() ?? Date.now();
    await this.store.write(ns.map((n, i) => ({ table: T.notices, key: [n.to, at, i, randomHex(4)], value: { ...n, at } })));
  }

  // ------------------------------------------------------------ reading
  async head(cut = this.#h.current) {
    await this.#queue;
    await this.#refresh(cut);
    return { ref: this.#h.ref(cut), doc: this.#h.stateOf(this.#h.head(cut))! };
  }
  async checkout(ref: StateRef | string) {
    await this.#refresh();
    return E.fork(this.#doc(ref), this.schema);
  }
  async resolve(ref: StateRef | string) {
    await this.#refresh();
    const r = this.#h.resolve(ref);
    return { doc: r.doc, seq: r.seq, causal: r.causal };
  }
  async cuts() {
    await this.#refresh();
    return this.#h.cuts();
  }
  async log(opts: { cut?: string; limit?: number; before?: number } = {}) {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    return this.#h.log(cut, opts);
  }
  async diff(a: StateRef | string, b?: StateRef | string, opts: { shots?: boolean } = {}): Promise<DiffResult> {
    await this.#refresh();
    const da = this.#doc(a),
      db = b === undefined ? this.#h.stateOf(this.#h.head(this.#h.current))! : this.#doc(b);
    const ops = E.diff(da, db, this.schema);
    const out: DiffResult = { ops, describe: E.describe(ops, da, this.schema) };
    if (opts.shots && this.schema.timeline) out.shots = E.shotDiff(da, db, this.schema);
    return out;
  }
  async shots(a: StateRef | string, b?: StateRef | string) {
    await this.#refresh();
    return E.shotDiff(this.#doc(a), b === undefined ? this.#h.stateOf(this.#h.head(this.#h.current))! : this.#doc(b), this.schema);
  }
  async preview(ref: StateRef | string): Promise<Preview> {
    await this.#refresh();
    const doc = E.fork(this.#doc(ref), this.schema);
    // read-only: the doc and its collection arrays are frozen (records are never mutated anyway)
    for (const k in this.schema.collections) if (Array.isArray(doc[k])) Object.freeze(doc[k]);
    const node = this.#node(ref);
    const { branchId, seq } = parseNode(node);
    return { ref: { branchId, seq, pending: [] }, doc: Object.freeze(doc), readOnly: true };
  }
  async credits(record: PathKey | readonly string[], opts: { cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    return this.#h.credits(cut, record);
  }
  async undoStack(group?: string, opts: { cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    return this.#h.undoStack(cut, group ?? groupOf(this.#actor()));
  }
  async notices(actor?: Actor, opts: { take?: boolean } = {}) {
    const key = actorKey(actor ?? this.#actor());
    const rows = await this.store.range<Notice>(T.notices, { prefix: [key] });
    if (opts.take && rows.length) await this.store.write(rows.map((r) => ({ table: T.notices, key: r.key, value: undefined })));
    return rows.map((r) => r.value);
  }

  // ------------------------------------------------------------ writing
  async commit(input: CommitInput): Promise<CommitResult> {
    const cut = input.cut ?? this.#h.current;
    const rec = this.#h.cut(cut);
    if (rec && rec.sequencer.kind !== "local") throw new Error("Carton: commits on a shared cut go through the sync client (not wired yet)");
    const author = this.#actor(input.author);
    const id = input.id ?? `${this.#rid}.${++this.#n}`;
    const r = await this.#mutate(
      cut,
      () =>
        this.#h.commit(cut, {
          ...(input.doc ? { doc: input.doc } : {}),
          ...(input.ops ? { ops: input.ops } : {}),
          author,
          ...(input.base !== undefined ? { base: input.base } : {}),
          intent: input.intent ?? null,
          kinds: input.kinds ?? null,
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.choices ? { choices: input.choices } : {}),
          ...(input.name ? { name: input.name } : {}),
          id,
        }),
      { conditions: input.conditions ?? [], idempotent: !input.conditions?.length },
    );
    const { retry: _r, ...out } = r as CommitResult & { retry?: unknown };
    this.#notices(out);
    await this.#saveNotices(out);
    return out;
  }
  async pin(opts: { owner: string; cut?: string; ttlMs?: number; doc?: Doc; by?: string }): Promise<Pin> {
    const cut = opts.cut ?? this.#h.current;
    const now = this.#opts.clock?.() ?? Date.now();
    let ref!: StateRef;
    await this.#mutate(cut, () => (ref = this.#h.pin({ cutId: cut, owner: opts.owner, expires: opts.ttlMs === undefined ? Infinity : now + opts.ttlMs, ...(opts.doc ? { doc: opts.doc } : {}) })), {
      extra: () => [{ table: T.pins, key: [ref.branchId, ref.seq, ref.hash8!], value: this.#h.pinRow(ref.branchId, ref.seq, ref.hash8!) }],
      idempotent: true,
    });
    return { ref, header: this.#h.refString(cut, ref.seq, ref.hash!, { printNonce: randomHex(4), ...(opts.by ? { by: opts.by } : {}) }) };
  }
  async release(ref: StateRef, owner: string): Promise<void> {
    const h8 = ref.hash8 ?? ref.hash?.slice(0, 8) ?? "";
    await this.#mutate(undefined, () => this.#h.release(ref, owner), {
      extra: () => [{ table: T.pins, key: [ref.branchId, ref.seq, h8], value: this.#h.pinRow(ref.branchId, ref.seq, h8) }],
      idempotent: true,
    });
  }
  async fork(name: string, opts: { from?: StateRef | string; kind?: CutKind } = {}): Promise<CutRecord> {
    let rec!: CutRecord;
    await this.#mutate(
      undefined,
      () => {
        const from = opts.from === undefined ? this.#h.head(this.#h.current) : this.#node(opts.from);
        rec = this.#h.cut(this.#h.fork(from, name, { kind: opts.kind ?? "variant", owner: this.#opts.name ?? this.#h.name }))!;
      },
      { extra: () => [{ table: T.cuts, key: [rec.id], value: rec }], idempotent: false },
    );
    return rec;
  }
  async switchTo(cut: string): Promise<void> {
    await this.#refresh();
    this.#h.current = cut;
    this.#meta = { ...this.#meta, current: cut };
    await this.store.write([{ table: T.meta, key: PROJECT, value: this.#meta }]);
  }
  async fold(from: string | StateRef, opts: FoldOptions & { into?: string } = {}): Promise<FoldResult & { preview?: FoldPreview }> {
    const into = opts.into ?? this.#h.current;
    const author = this.#actor(opts.author);
    const r = await this.#mutate(into, () => this.#h.fold(into, this.#node(from), { ...opts, author }), { idempotent: true });
    const { retry: _r, merge, base: _b, ...out } = r as FoldResult & { retry?: unknown; merge?: MergeResult; base?: unknown };
    // A dry run tells what the fold would bring in (Fold in dialog, `cb fold --check`).
    if (opts.check && merge) {
      const ours = this.#h.stateOf(this.#h.head(into))!;
      const ops = merge.ops;
      return { ...(out as FoldResult), preview: { ops, describe: E.describe(ops, ours, this.schema), warnings: merge.warnings } };
    }
    return out as FoldResult;
  }
  async foldSome(from: string | StateRef, opts: FoldOptions & { into?: string; reject: PathKey[] }): Promise<FoldResult> {
    const into = opts.into ?? this.#h.current;
    const author = this.#actor(opts.author);
    const r = await this.#mutate(into, () => this.#h.foldSome(into, this.#node(from), { ...opts, author }), { idempotent: true });
    const { fold: _f, ...out } = r as FoldResult & { fold?: unknown };
    return out as FoldResult;
  }
  async name(ref: StateRef | string, name: string): Promise<void> {
    let node!: NodeId;
    await this.#mutate(undefined, () => this.#h.nameVersion((node = this.#node(ref)), name, this.#actor()), {
      extra: () => {
        const { branchId, seq } = parseNode(node);
        return [{ table: T.names, key: [branchId, seq], value: { name, at: this.#opts.clock?.() ?? Date.now(), by: this.#actor() } }];
      },
      idempotent: true,
    });
  }
  async restore(ref: StateRef | string, opts: { author?: Actor; cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    return this.#mutate(cut, () => this.#h.restore(cut, this.#node(ref), { author: this.#actor(opts.author) }), { idempotent: false });
  }
  async revert(changeId: ChangeId, opts: { author?: Actor; cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    return this.#mutate(cut, () => this.#h.revert(cut, changeId, { author: this.#actor(opts.author) }), { idempotent: false });
  }
  async undo(group?: string, opts: { cut?: string; author?: Actor } = {}) {
    const cut = opts.cut ?? this.#h.current;
    const actor = this.#actor(opts.author);
    return this.#mutate(cut, () => this.#h.undo(cut, group ?? groupOf(actor), { author: actor }), { idempotent: false });
  }

  // ------------------------------------------------------------ .cbproj (§13)
  async exportShallow(opts: { cut?: string; to?: string } = {}): Promise<ShallowExport> {
    const cut = opts.cut ?? this.#h.current;
    let pkg!: ShallowExport;
    await this.#mutate(cut, () => (pkg = this.#h.exportShallow(cut, { ...(opts.to ? { to: opts.to } : {}) })), {
      // the export node is part of the lineage graph from now on (R4-01): persist it
      extra: () => {
        this.#meta = { ...this.#meta, exports: this.#h.knowledge().exports };
        return [{ table: T.meta, key: PROJECT, value: this.#meta }];
      },
      idempotent: true,
    });
    return pkg;
  }
  async importShallow(pkg: ShallowExport): Promise<{ status: string; cut?: string }> {
    let res!: ReturnType<History["importShallow"]>;
    const before = new Set(this.#h.cuts().map((c) => c.id));
    await this.#mutate(undefined, () => (res = this.#h.importShallow(pkg)), {
      extra: () => {
        const k = this.#h.knowledge();
        this.#meta = { ...this.#meta, projectId: this.#h.projectId ?? this.#meta.projectId, authors: k.authors, exports: k.exports, current: this.#h.current };
        const w: StoreWrite[] = [{ table: T.meta, key: PROJECT, value: this.#meta }];
        for (const n of k.lineage) w.push({ table: T.lineage, key: [n.id], value: n });
        for (const [hash, doc] of k.states) w.push({ table: T.states, key: [hash], value: doc });
        for (const c of this.#h.cuts()) if (!before.has(c.id)) w.push({ table: T.cuts, key: [c.id], value: c });
        return w;
      },
      idempotent: false,
    });
    return { status: res.status, ...("cut" in res ? { cut: res.cut } : {}) };
  }

  on(listener: (event: CartonEvent) => void) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
  async close() {
    await this.#queue;
    this.#closed = true;
    this.#listeners.clear();
  }
}

export type { Rec };
