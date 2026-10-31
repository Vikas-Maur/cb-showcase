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
import { History, actorKey, groupOf, nodeId, parseNode, randomHex, undoLabel } from "./history/history.ts";
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
   * `asChange`: §16 migration of an existing project: the cut starts empty and `doc` is `main@1`, one insert-all
   * change by `{kind: "system", id: "import"}` (otherwise `doc` is the root state at seq 0).
   */
  init?: { doc: Doc; projectId?: string; cutName?: string; asChange?: boolean } | { import: ShallowExport };
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
  /** Cards a list or map of `choices` doesn't name: "card" (default) returns them as conflicts; "prefer" decides them. */
  unchosen?: "card" | "prefer";
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

/** Who last changed a record, when, and in which change (`at`/`change` are null for a record from an imported `.cbproj`). */
export interface Credit {
  actor: Actor;
  at: number | null;
  change: ChangeId | null;
}

/** A Published cut, the cut it was published from, and whether that cut has moved on since. */
export interface Publication {
  cut: CutRecord;
  /** The version published (`<cutId>@<seq>`). */
  from: NodeId;
  /** The cut it came from. */
  source: string;
  /** The source cut has edits newer than what was published. */
  newer: boolean;
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
  /** Rename a cut (its id never changes; the name is only a label). */
  renameCut(cut: string, name: string): Promise<CutRecord>;
  /** Publish a version (default: the current cut's head) as a Published cut: what the share link shows. */
  publish(opts?: { from?: StateRef | string; name?: string }): Promise<CutRecord>;
  /** Published cuts, each with the cut it came from and whether that cut has edits newer than what was published. */
  publications(): Promise<Publication[]>;
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
  /** History: versions of a cut, newest first; `summary`: each says what it did in plain words. */
  log(opts?: { cut?: string; limit?: number; before?: number; summary?: boolean }): Promise<Version[]>;
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
  /** Credits: who last changed a record, down to the subagent; `detail`: also when, and in which change. */
  credits(record: PathKey | readonly string[], opts?: { cut?: string; detail?: false }): Promise<Actor | null>;
  credits(record: PathKey | readonly string[], opts: { cut?: string; detail: true }): Promise<Credit | null>;
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

// The meta table: ["project"] is written once; everything that grows is under its own key, so two processes adding
// to it never overwrite each other: ["rid", rid], ["export", node, at, nonce], ["authors", node]; ["current"] is this
// machine's current cut (last writer wins).
const PROJECT = ["project"] as const;
const CURRENT = ["current"] as const;
const NODE_RE = /^[^~\s]+@\d+$/;
const emptyDoc = (schema: Schema): Doc => Object.fromEntries(Object.keys(schema.collections).map((k) => [k, []]));
interface ProjectMeta {
  projectId: string;
  schemaVersion: number;
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
  #pinSnap = new Map<string, PinRow>();
  #ridSaved = false;
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
      const h = History.create(this.schema, init.asChange ? emptyDoc(this.schema) : init.doc, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, projectId: init.projectId ?? null, keyframeEvery: this.#opts.keyframeEvery, cut: init.cutName ?? "Main cut" });
      const cut = h.cut(h.current)!;
      meta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion };
      const ok = await s.write(
        [
          { table: T.meta, key: PROJECT, value: meta },
          { table: T.meta, key: CURRENT, value: cut.id },
          { table: T.cuts, key: [cut.id], value: cut },
          { table: T.keyframes, key: [cut.id, 0], value: h.stateOf(nodeId(cut.id, 0)) },
        ],
        [{ table: T.meta, key: PROJECT, expect: "absent" }],
      );
      if (!ok) return this.load(); // another process created it first: open theirs
      if (init.asChange) {
        this.#meta = meta;
        await this.#rebuild();
        await this.#mutate(cut.id, () => this.#h.commit(cut.id, { doc: init.doc, author: { kind: "system", id: "import", name: "Import" }, kind: "import", id: `import.${this.#meta.projectId}` }), { idempotent: true });
        return;
      }
    }
    this.#meta = meta;
    await this.#rebuild();
  }
  async #createFromImport(pkg: ShallowExport): Promise<void> {
    const h = new History(this.schema, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, keyframeEvery: this.#opts.keyframeEvery });
    const res = h.importShallow(pkg);
    if (res.status !== "forked") throw new Error(`Carton.open: import gave ${res.status}`);
    const meta: ProjectMeta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion };
    const w: StoreWrite[] = [{ table: T.meta, key: PROJECT, value: meta }, { table: T.meta, key: CURRENT, value: h.current }, ...this.#knowledgeWrites(h)];
    for (const c of h.cuts()) w.push({ table: T.cuts, key: [c.id], value: c });
    if (!(await this.store.write(w, [{ table: T.meta, key: PROJECT, expect: "absent" }]))) return this.load();
    this.#meta = meta;
    await this.#rebuild();
  }
  // Rebuild the in-memory model from the store: knowledge first, then cuts parents-first, then names and pins.
  async #rebuild(): Promise<void> {
    const s = this.store;
    const h = new History(this.schema, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, projectId: this.#meta.projectId, keyframeEvery: this.#opts.keyframeEvery });
    const lineage = (await s.range<DagNode>(T.lineage)).map((e) => e.value);
    const states = (await s.range<Doc>(T.states)).map((e): [string, Doc] => [e.key[0] as string, e.value]);
    const authors = (await s.range<Record<PathKey, Actor>>(T.meta, { prefix: ["authors"] })).map((e): [NodeId, Record<PathKey, Actor>] => [e.key[1] as string, e.value]);
    const exportsBy = new Map<NodeId, { to: string; at: number }[]>();
    for (const e of await s.range<{ to: string; at: number }>(T.meta, { prefix: ["export"] })) (exportsBy.get(e.key[1] as string) ?? exportsBy.set(e.key[1] as string, []).get(e.key[1] as string)!).push(e.value);
    h.loadKnowledge({ lineage, states, authors, exports: [...exportsBy] });
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
    await this.#loadPins(h);
    const current = await s.get<string>(T.meta, CURRENT);
    if (current && byId.has(current)) h.current = current;
    h.onConfirmed = (cut, change) => this.#confirmed.push({ cut, change });
    this.#h = h;
  }
  // Pins as the store holds them (other processes pin too), and a snapshot to condition our pin writes on.
  async #loadPins(h: History): Promise<void> {
    const rows = await this.store.range<PinRow>(T.pins);
    h.setPins(rows.map((e) => e.value));
    this.#pinSnap = new Map(rows.map((e) => [e.key.join("|"), e.value]));
  }
  // Re-read the tail of a cut (another process may have appended), any new cuts, and the pins.
  async #refresh(cut?: string): Promise<void> {
    const s = this.store;
    for (const e of await s.range<CutRecord>(T.cuts)) if (!this.#h.cut(e.key[0] as string)) return this.#rebuild();
    const cuts = cut ? [cut] : this.#h.cuts().filter((c) => !c.shallow).map((c) => c.id);
    for (const id of cuts) {
      const rows = (await s.range<ConfirmedChange>(T.changes, { prefix: [id], gt: [id, this.#h.headSeq(id)] })).map((e) => e.value);
      if (rows.length) this.#h.load(id, rows);
    }
    await this.#loadPins(this.#h);
  }
  /** A pin row write conditioned on the row being what we last read, so two processes' owner sets never overwrite. */
  #pinWrite(ref: StateRef): { write: StoreWrite; cond: StoreCondition } {
    const key = [ref.branchId, ref.seq, ref.hash8 ?? ref.hash?.slice(0, 8) ?? ""];
    const was = this.#pinSnap.get(key.join("|"));
    return {
      write: { table: T.pins, key, value: this.#h.pinRow(key[0] as string, key[1] as number, key[2] as string) },
      cond: { table: T.pins, key, expect: was === undefined ? "absent" : { equals: was } },
    };
  }
  #knowledgeWrites(h: History, prior?: ReturnType<History["knowledge"]>): StoreWrite[] {
    const k = h.knowledge();
    const w: StoreWrite[] = [];
    const seenNodes = new Set(prior?.lineage.map((n) => n.id));
    const seenStates = new Set(prior?.states.map(([x]) => x));
    const seenAuthors = new Set(prior?.authors.map(([x]) => x));
    for (const n of k.lineage) if (!seenNodes.has(n.id) || prior!.lineage.find((x) => x.id === n.id)!.kinds.length !== n.kinds.length) w.push({ table: T.lineage, key: [n.id], value: n });
    for (const [hash, doc] of k.states) if (!seenStates.has(hash)) w.push({ table: T.states, key: [hash], value: doc });
    for (const [node, a] of k.authors) if (!seenAuthors.has(node)) w.push({ table: T.meta, key: ["authors", node], value: a });
    return w;
  }
  /** Writes for every change History confirmed since the last flush, each conditioned on its slot being free. */
  async #flush(extra: StoreWrite[] = [], conditions: StoreCondition[] = []): Promise<boolean> {
    const confirmed = this.#confirmed.splice(0);
    const writes: StoreWrite[] = [...extra];
    const conds: StoreCondition[] = [...conditions];
    for (const { cut, change } of confirmed) {
      writes.push({ table: T.changes, key: [cut, change.seq], value: change }, { table: T.ids, key: [change.id], value: [cut, change.seq] });
      // the slot is free and the id was never confirmed anywhere (dedup by id spans every cut and process)
      conds.push({ table: T.changes, key: [cut, change.seq], expect: "absent" }, { table: T.ids, key: [change.id], expect: "absent" });
      if (change.name) writes.push({ table: T.names, key: [cut, change.seq], value: { name: change.name, at: change.at, by: change.author } });
    }
    // every replica id that committed here (R10-02: claimed in hello), one key each
    if (confirmed.length && !this.#ridSaved) writes.push({ table: T.meta, key: ["rid", this.#rid], value: { at: this.#opts.clock?.() ?? Date.now() } });
    if (!writes.length) return true;
    const ok = await this.store.write(writes, conds);
    if (ok && confirmed.length) this.#ridSaved = true;
    if (ok) for (const { cut, change } of confirmed) this.#emit({ type: "change", branchId: cut, seq: change.seq, change, local: true });
    return ok;
  }
  /** Run a History mutation under the handle's queue, persist what it confirmed, and retry after losing a race. */
  async #mutate<R>(cut: string | undefined, fn: () => R, opts: { extra?: () => { writes?: StoreWrite[]; conds?: StoreCondition[] }; conditions?: StoreCondition[]; idempotent?: boolean } = {}): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.#closed) throw new Error("Carton: closed");
      for (let attempt = 0; ; attempt++) {
        await this.#refresh(cut);
        this.#confirmed.length = 0;
        let ok: boolean, r: R;
        try {
          r = fn();
          const x = opts.extra?.() ?? {};
          ok = await this.#flush(x.writes ?? [], [...(opts.conditions ?? []), ...(x.conds ?? [])]);
        } catch (e) {
          // the model may hold changes the store never got (a write that threw): drop them before anything else runs
          this.#confirmed.length = 0;
          await this.#rebuild();
          throw e;
        }
        if (ok) return r;
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
  async log(opts: { cut?: string; limit?: number; before?: number; summary?: boolean } = {}) {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    const versions = this.#h.log(cut, opts);
    if (!opts.summary || !versions.length) return versions;
    // one state per page, walked forward: each version is described against the state just before it
    const lo = versions[versions.length - 1]!.ref.seq;
    const log = this.#h.changes(cut);
    let doc = E.fork(this.#h.stateOf(nodeId(cut, Math.max(0, lo - 1)))!, this.schema);
    const summary = new Map<number, string>();
    for (let s = Math.max(1, lo); s <= versions[0]!.ref.seq; s++) {
      const c = log[s - 1]!;
      const first = c.name ?? E.describe(c.ops, doc, this.schema, c.intent)[0];
      if (first) summary.set(s, first);
      doc = E.apply(doc, c.ops, this.schema);
    }
    return versions.map((v) => (summary.has(v.ref.seq) ? { ...v, summary: summary.get(v.ref.seq)! } : v));
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
  credits(record: PathKey | readonly string[], opts?: { cut?: string; detail?: false }): Promise<Actor | null>;
  credits(record: PathKey | readonly string[], opts: { cut?: string; detail: true }): Promise<Credit | null>;
  async credits(record: PathKey | readonly string[], opts: { cut?: string; detail?: boolean } = {}): Promise<Actor | Credit | null> {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    return opts.detail ? this.#h.creditsDetail(cut, record) : this.#h.credits(cut, record);
  }
  async undoStack(group?: string, opts: { cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    await this.#refresh(cut);
    // an unnamed edit's label says what it did ("Undo Director: Trimmed 'Intro' end 6.0 s → 5.0 s")
    return this.#h.undoStack(cut, group ?? groupOf(this.#actor())).map((e) => {
      const c = this.#h.changes(cut)[e.seq - 1]!;
      if (c.name || c.intent?.kind) return e;
      const what = E.describe(c.ops, this.#h.stateOf(nodeId(cut, e.seq - 1)) ?? {}, this.schema, c.intent)[0];
      return what ? { ...e, label: undoLabel(c, what) } : e;
    });
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
    if (rec?.kind === "published") throw new Error("Carton: a Published cut is read-only; publish again to update it");
    const author = this.#actor(input.author);
    const id = input.id ?? `${this.#rid}.${++this.#n}`;
    // the base is fixed on the first attempt: a retry after losing a race must rebase on it, never treat what the other
    // process just wrote as something this commit removes
    let base = input.base;
    const r = await this.#mutate(
      input.id ? undefined : cut, // an explicit id: look for it on every cut (dedup by id)
      (): CommitResult => {
        const dup = input.id ? this.#h.findChange(input.id) : null;
        if (dup) return { status: "confirmed", seq: dup.seq, ref: { branchId: dup.branchId, seq: dup.seq, pending: [] }, change: dup, rebased: 0, notices: [] };
        base ??= { branchId: cut, seq: this.#h.headSeq(cut), pending: [] };
        return this.#h.commit(cut, {
          ...(input.doc ? { doc: input.doc } : {}),
          ...(input.ops ? { ops: input.ops } : {}),
          author,
          base,
          intent: input.intent ?? null,
          kinds: input.kinds ?? null,
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.choices ? { choices: input.choices } : {}),
          ...(input.unchosen ? { unchosen: input.unchosen } : {}),
          ...(input.name ? { name: input.name } : {}),
          id,
        });
      },
      { conditions: input.conditions ?? [], idempotent: !input.conditions?.length },
    );
    const { retry: _r, ...out } = r as CommitResult & { retry?: unknown };
    this.#notices(out);
    if (out.status === "confirmed" && out.warnings?.length) this.#emit({ type: "warning", branchId: cut, warnings: out.warnings });
    await this.#saveNotices(out);
    return out;
  }
  async pin(opts: { owner: string; cut?: string; ttlMs?: number; doc?: Doc; by?: string }): Promise<Pin> {
    const cut = opts.cut ?? this.#h.current;
    const now = this.#opts.clock?.() ?? Date.now();
    let ref!: StateRef;
    await this.#mutate(cut, () => (ref = this.#h.pin({ cutId: cut, owner: opts.owner, expires: opts.ttlMs === undefined ? Infinity : now + opts.ttlMs, ...(opts.doc ? { doc: opts.doc } : {}) })), {
      extra: () => {
        const pw = this.#pinWrite(ref);
        return { writes: [pw.write], conds: [pw.cond] };
      },
      idempotent: true,
    });
    return { ref, header: this.#h.refString(cut, ref.seq, ref.hash!, { printNonce: randomHex(4), ...(opts.by ? { by: opts.by } : {}) }) };
  }
  async release(ref: StateRef, owner: string): Promise<void> {
    await this.#mutate(undefined, () => this.#h.release(ref, owner), {
      extra: () => {
        const pw = this.#pinWrite(ref);
        return { writes: [pw.write], conds: [pw.cond] };
      },
      idempotent: true,
    });
  }
  /** A ref's node, and the held state when it names a pin that isn't a confirmed version (a freeze view, a draft). */
  #held(ref: StateRef | string): { node: NodeId; doc: Doc | null } {
    const node = this.#node(ref);
    if (typeof ref === "string" && (this.#h.cut(ref) || NODE_RE.test(ref))) return { node, doc: null };
    const p = this.#h.parseRef(ref);
    const h8 = "legacy" in p ? undefined : (p.hash8 ?? p.hash?.slice(0, 8));
    if (!h8 || this.#h.hashOf(node)!.startsWith(h8)) return { node, doc: null };
    return { node, doc: this.#h.resolve(ref).doc };
  }
  async fork(name: string, opts: { from?: StateRef | string; kind?: CutKind; author?: Actor } = {}): Promise<CutRecord> {
    let rec!: CutRecord;
    await this.#mutate(
      undefined,
      () => {
        const from = opts.from === undefined ? { node: this.#h.head(this.#h.current), doc: null } : this.#held(opts.from);
        rec = this.#h.cut(this.#h.fork(from.node, name, { kind: opts.kind ?? "variant", owner: this.#opts.name ?? this.#h.name }))!;
        // forking from a held state: the cut forks at its version and the held edits are its first change
        if (from.doc) this.#h.commit(rec.id, { doc: from.doc, author: this.#actor(opts.author) });
      },
      { extra: () => ({ writes: [{ table: T.cuts, key: [rec.id], value: rec }] }), idempotent: false },
    );
    return rec;
  }
  async switchTo(cut: string): Promise<void> {
    await this.#refresh();
    this.#h.current = cut;
    await this.store.write([{ table: T.meta, key: CURRENT, value: cut }]);
  }
  async renameCut(cut: string, name: string): Promise<CutRecord> {
    let rec!: CutRecord;
    let was!: CutRecord | undefined;
    await this.#mutate(
      undefined,
      () => {
        was = this.#h.cut(cut);
        if (!was) throw new Error(`Carton.renameCut: no cut ${cut}`);
        rec = this.#h.updateCut(cut, { name });
      },
      // conditioned on the record we read, so a concurrent change to it (a hand-off) is never overwritten
      { extra: () => ({ writes: [{ table: T.cuts, key: [cut], value: rec }], conds: [{ table: T.cuts, key: [cut], expect: { equals: was } }] }), idempotent: true },
    );
    return rec;
  }
  async publish(opts: { from?: StateRef | string; name?: string } = {}): Promise<CutRecord> {
    return this.fork(opts.name ?? "Published cut", { kind: "published", ...(opts.from !== undefined ? { from: opts.from } : {}) });
  }
  async publications(): Promise<Publication[]> {
    await this.#refresh();
    const out: Publication[] = [];
    for (const cut of this.#h.cuts()) {
      if (cut.kind !== "published" || !cut.forkOf) continue;
      const from = this.#h.canon(cut.forkOf);
      const source = parseNode(from).branchId;
      const src = this.#h.cut(source);
      out.push({ cut, from, source, newer: !!src && !src.shallow && this.#h.head(source) !== from });
    }
    return out;
  }
  #foldable(from: string | StateRef): NodeId {
    const h = this.#held(from);
    if (h.doc) throw new Error("Carton.fold: that ref is a pinned state, not a version; commit it to a cut first");
    return h.node;
  }
  async fold(from: string | StateRef, opts: FoldOptions & { into?: string } = {}): Promise<FoldResult & { preview?: FoldPreview }> {
    const into = opts.into ?? this.#h.current;
    const author = this.#actor(opts.author);
    // refresh every cut: the one folded in may have grown in another process
    const r = await this.#mutate(undefined, () => this.#h.fold(into, this.#foldable(from), { ...opts, author }), { idempotent: true });
    const { retry: _r, merge, base: _b, doc: _d, ...out } = r as FoldResult & { retry?: unknown; merge?: MergeResult; base?: unknown; doc?: unknown };
    // a dry run tells what the fold would bring in (the Fold in dialog, `cb fold --check`): with choices, the resolved
    // state; without, every card on its provisional side
    if (opts.check && merge) {
      const ours = this.#h.stateOf(this.#h.head(into))!;
      const ops = (r as { doc?: Doc }).doc ? E.diff(ours, (r as { doc: Doc }).doc, this.schema) : merge.ops;
      return { ...(out as FoldResult), preview: { ops, describe: E.describe(ops, ours, this.schema), warnings: merge.warnings } };
    }
    return out as FoldResult;
  }
  async foldSome(from: string | StateRef, opts: FoldOptions & { into?: string; reject: PathKey[] }): Promise<FoldResult> {
    const into = opts.into ?? this.#h.current;
    const author = this.#actor(opts.author);
    const r = await this.#mutate(undefined, () => this.#h.foldSome(into, this.#foldable(from), { ...opts, author }), { idempotent: true });
    const { fold: _f, merge: _m, base: _b, doc: _d, ...out } = r as FoldResult & { fold?: unknown; merge?: unknown; base?: unknown; doc?: unknown };
    return out as FoldResult;
  }
  async name(ref: StateRef | string, name: string): Promise<void> {
    let node!: NodeId;
    await this.#mutate(undefined, () => this.#h.nameVersion((node = this.#node(ref)), name, this.#actor()), {
      extra: () => {
        const { branchId, seq } = parseNode(node);
        return { writes: [{ table: T.names, key: [branchId, seq], value: { name, at: this.#opts.clock?.() ?? Date.now(), by: this.#actor() } }] };
      },
      idempotent: true,
    });
  }
  async restore(ref: StateRef | string, opts: { author?: Actor; cut?: string } = {}) {
    const cut = opts.cut ?? this.#h.current;
    // History resolves headers and StateRefs itself, pins included, so a held state is restored as held; a cut id is
    // its head as of now (inside the mutation, after the refresh), never a cached one
    return this.#mutate(undefined, () => this.#h.restore(cut, typeof ref === "string" && this.#h.cut(ref) ? this.#h.head(ref) : ref, { author: this.#actor(opts.author) }), { idempotent: false });
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
      // the export node is part of the lineage graph from now on (R4-01): persist it, one key per export
      extra: () => {
        const made = this.#h.knowledge().exports.find(([n]) => n === pkg.head)?.[1].at(-1);
        return { writes: made ? [{ table: T.meta, key: ["export", pkg.head, made.at, randomHex(4)], value: made }] : [] };
      },
      idempotent: true,
    });
    return pkg;
  }
  async importShallow(pkg: ShallowExport): Promise<{ status: string; cut?: string }> {
    let res!: ReturnType<History["importShallow"]>;
    let prior!: ReturnType<History["knowledge"]>;
    let before!: Set<string>;
    await this.#mutate(
      undefined,
      () => {
        prior = this.#h.knowledge();
        before = new Set(this.#h.cuts().map((c) => c.id));
        res = this.#h.importShallow(pkg);
      },
      {
        extra: () => {
          const w = this.#knowledgeWrites(this.#h, prior);
          for (const c of this.#h.cuts()) if (!before.has(c.id)) w.push({ table: T.cuts, key: [c.id], value: c });
          return { writes: w };
        },
        idempotent: true,
      },
    );
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
