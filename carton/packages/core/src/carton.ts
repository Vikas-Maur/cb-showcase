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

import type { BlobStore, Hasher, HostAdapter, IdentitySource, OwnFn, ProxyEncoder, Store, StoreCondition, StoreWrite, Transport } from "./plugins.ts";
import type { Schema } from "./schema.ts";
import type { PresenceState } from "./sync/messages.ts";
import type { SyncStatus } from "./sync/index.ts";
import { ReplicaQueue, type HistoryFields } from "./sync/queue.ts";
import { SharedCut, type SharedCutEvent, type SyncState, type WriteOutcome } from "./sync/replica.ts";
import { STORE_TABLES as T, StateUnknown, type FoldOptions, type FoldPreview, type FoldResult, type HeldBase } from "./history/common.ts";
import { History, actorKey, groupOf, nodeId, parseNode, randomHex, undoLabel, unseenCards } from "./history/history.ts";
import * as E from "./engine/index.ts";
import type {
  Actor,
  CartonEvent,
  ChangeId,
  Choices,
  ConflictCard,
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
  /** A shared cut: wait up to this many ms for the sequencer's answer (`cb` waits 5 s); default: return pending. */
  wait?: number;
  /** Extra Store conditions for the append (a lease holder's `fence(nonce)`). */
  conditions?: StoreCondition[];
  /**
   * Record the change as an undo of these changes (`kind: "undo"`, `reverts`), so the actor group's undo stack treats
   * them as undone: `cb undo --turn` inverts a whole agent turn as one change.
   */
  undoOf?: ChangeId[];
  /**
   * Extra Store writes made from the cards `choices` decided, written in the same atomic batch as the append (so a
   * caller that keeps those cards, e.g. as a notice for `cb resolve`, can't lose them to a crash after the append).
   */
  cardsWrite?: (cards: ConflictCard[], change: ConfirmedChange | null) => StoreWrite[];
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
  /** The current cut's sync status ("offline" for a cut this replica sequences itself). */
  readonly status: SyncStatus;
  /** Status, edits waiting, and the words people see ("Up to date", "Offline: 3 edits waiting"). */
  state(cut?: string): SyncState;
  /**
   * Start pushing every shared cut (the lease holder passes its nonce; `fence(nonce)` is asked before every step that
   * touches the queue, and false stops the client for good). Resolves once caught up, or after `timeoutMs`.
   */
  connect(opts?: { nonce?: string; fence?: (nonce: string) => boolean; timeoutMs?: number }): Promise<boolean>;
  /** Stop; `drain`: push nothing new and resolve once nothing is in flight (a lease hand-over). */
  disconnect(opts?: { drain?: boolean; timeoutMs?: number }): Promise<void>;
  presence(state: PresenceState | null): void;
  /**
   * What a write learned within `ms` (a `cb` write waits up to 5 s, §6.2): confirmed, conflicts, rejected or pending.
   * A settled outcome resolves once it is in the store too (its author's notice written, its pending row gone), so a
   * caller that reports it can mark that notice delivered rather than have it told again on the next call.
   */
  waitFor(id: ChangeId, ms: number, cut?: string): Promise<WriteOutcome>;
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
  /**
   * Pin a cut's head, or a held state (`doc`, e.g. a freeze view), for `owner` (a turn, view or MCP ref). `seq`: the
   * confirmed seq the held state was derived from (default: head), so a commit on it is checked against every change
   * confirmed after that seq rather than treated as having seen them. `causal`: the ids of changes after `seq` whose
   * effect `doc` already holds (a freeze view's merged agent saves), so a commit on it doesn't meet them again.
   */
  pin(opts: { owner: string; cut?: string; ttlMs?: number; doc?: Doc; by?: string; seq?: number; causal?: ChangeId[] }): Promise<Pin>;
  /** M4: did `author` create element `id` of the sequence at `seqKey`? For host conversions (`HostAdapter.fromHost`'s `own`). */
  own(author: Actor): OwnFn;
  /**
   * A fresh change id of this replica (`<rid>.<n>`), for a caller that must record it before committing so a retry
   * commits with the same id and gets the original confirmation back (dedup by id) instead of a second change.
   */
  newChangeId(): ChangeId;
  release(ref: StateRef, owner: string): Promise<void>;

  cuts(): Promise<CutRecord[]>;
  /** Rename a cut (its id never changes; the name is only a label). */
  renameCut(cut: string, name: string): Promise<CutRecord>;
  /** Publish a version (default: the current cut's head) as a Published cut: what the share link shows. */
  publish(opts?: { from?: StateRef | string; name?: string; id?: string }): Promise<CutRecord>;
  /** Published cuts, each with the cut it came from and whether that cut has edits newer than what was published. */
  publications(): Promise<Publication[]>;
  /** New cut (`cb cut new`): forks from `from` (default: the current cut's head). */
  /** `id`: a stable cut id, so a retried call returns the cut it already made. */
  fork(name: string, opts?: { from?: StateRef | string; kind?: CutKind; author?: Actor; id?: string }): Promise<CutRecord>;
  switchTo(cut: string): Promise<void>;
  /** Fold `from` (a cut id or a ref) into `into` (default: current cut). */
  /** With `check: true`, nothing is committed and `preview` tells what the fold would bring in. */
  fold(from: string | StateRef, opts?: FoldOptions & { into?: string }): Promise<FoldResult & { preview?: FoldPreview }>;
  /**
   * Share a cut (§5.3): it hands its log to the server (`sync.url`) and from then on the server sequences it. The cut is
   * `handingOff` until the server confirms (local commits wait as pending meanwhile), then `server`.
   */
  share(cut?: string): Promise<CutRecord>;
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
  restore(ref: StateRef | string, opts?: { author?: Actor; cut?: string; id?: ChangeId }): Promise<CommitResult>;
  /** Undo one change (revert by change). */
  revert(changeId: ChangeId, opts?: { author?: Actor; cut?: string; id?: ChangeId }): Promise<CommitResult>;
  /** ⌘Z for an actor group (default: the handle actor's group). Remote teammates are never in it. */
  /**
   * Like commit, undo (and fold, fold-some, restore, revert, fork) takes a stable `id`: a call retried with an id
   * already confirmed returns that confirmation and never makes a second change.
   */
  undo(group?: string, opts?: { cut?: string; author?: Actor; id?: ChangeId }): Promise<CommitResult & { entry?: UndoEntry }>;
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
/** A shared cut's edit the server hasn't answered yet, as the store keeps it (table `pending`, key [cut, id]). */
interface PendingRow {
  id: ChangeId;
  author: Actor;
  ops: Op[];
  at: number;
  intent: Intent | null;
  kinds: EditKinds | null;
  policy: Policy;
  history?: HistoryFields;
}
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
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
    // a handle opened with sync starts syncing its shared cuts, unless the lease holder connects it under its nonce
    if (opts.sync && opts.sync.autoConnect !== false) void c.sync!.connect().catch(() => {});
    return c;
  },
};

class CartonImpl implements Carton {
  readonly schema: Schema;
  readonly store: Store;
  readonly sync: CartonSync | null = null;
  /** The replica's confirmed log plus pending queue for its shared cuts, and one SharedCut (queue + pusher) per cut. */
  #rq: ReplicaQueue | null = null;
  #shared = new Map<string, SharedCut>();
  #connected: { nonce: string; fence?: (nonce: string) => boolean } | null = null;
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
  #noops: { id: ChangeId; cut: string; seq: number }[] = [];
  #pinSnap = new Map<string, PinRow>();
  #ridSaved = false;
  #closed = false;

  constructor(opts: OpenOptions) {
    this.#opts = opts;
    this.schema = opts.adapter.schema;
    this.store = opts.store;
    if (opts.sync) {
      const self = this;
      const offline: SyncState = { status: "offline", pending: 0, label: "Offline: 0 edits waiting" };
      this.sync = {
        get status() {
          return this.state().status;
        },
        state: (cut?: string) => self.#shared.get(cut ?? self.#h.current)?.state() ?? offline,
        connect: async (o = {}) => {
          self.#connected = { nonce: o.nonce ?? randomHex(8), ...(o.fence ? { fence: o.fence } : {}) };
          let ok = true;
          for (const c of self.#h.cuts()) if (self.#isShared(c.id)) ok = (await (await self.#ensureShared(c.id)).connect({ ...self.#connected, timeoutMs: o.timeoutMs ?? 5000 })) && ok;
          return ok;
        },
        disconnect: async (o = {}) => {
          self.#connected = null;
          for (const sc of self.#shared.values()) await sc.disconnect(o);
        },
        presence: (state) => self.#shared.get(self.#h.current)?.sendPresence(self.#actor(), state),
        waitFor: async (id, ms, cut) => {
          const sc = self.#shared.get(cut ?? self.#h.current);
          if (sc) {
            const o = await sc.waitFor(id, ms);
            // the event that settled it queued its store writes (#settleShared) before this wait could resume
            if (o.status !== "pending") await self.#queue;
            return o;
          }
          const done = self.#h.confirmedById(id);
          return done ? { status: "confirmed", id, seq: done.seq } : { status: "pending", id };
        },
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
      if (c.protected !== undefined || c.sequencer.kind !== "local" || c.source) h.updateCut(c.id, { ...(c.protected !== undefined ? { protected: c.protected } : {}), sequencer: c.sequencer, ...(c.source ? { source: c.source } : {}) });
      done.add(c.id);
      if (!c.shallow) h.load(c.id, (await s.range<ConfirmedChange>(T.changes, { prefix: [c.id] })).map((e) => e.value));
    };
    for (const c of cuts) await add(c);
    for (const e of await s.range<{ name: string; at: number; by?: Actor }>(T.names)) h.nameVersion(nodeId(e.key[0] as string, e.key[1] as number), e.value.name, e.value.by);
    await this.#loadPins(h);
    for (const e of await s.range<[string, number]>(T.meta, { prefix: ["noop"] })) h.noteNoop(e.key[1] as string, e.value[0], e.value[1]);
    const current = await s.get<string>(T.meta, CURRENT);
    if (current && byId.has(current)) h.current = current;
    h.onConfirmed = (cut, change) => this.#confirmed.push({ cut, change });
    h.onNoop = (id, cut, seq) => this.#noops.push({ id, cut, seq });
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
    for (const e of await s.range<CutRecord>(T.cuts)) {
      const known = this.#h.cut(e.key[0] as string);
      if (!known) return this.#rebuild();
      // another process renamed it (or changed its kind, protection, sequencer): take the stored record
      if (E.canonical(known) !== E.canonical(e.value)) this.#h.updateCut(e.value.id, { name: e.value.name, kind: e.value.kind, sequencer: e.value.sequencer, ...(e.value.protected !== undefined ? { protected: e.value.protected } : {}), ...(e.value.source ? { source: e.value.source } : {}) });
    }
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
    // ids whose write changed nothing: kept, so a retry (here or in another process) stays a no-op
    for (const n of this.#noops.splice(0)) {
      writes.push({ table: T.meta, key: ["noop", n.id], value: [n.cut, n.seq] });
      conds.push({ table: T.meta, key: ["noop", n.id], expect: "absent" }, { table: T.ids, key: [n.id], expect: "absent" });
    }
    for (const { cut, change } of confirmed) {
      writes.push({ table: T.changes, key: [cut, change.seq], value: change }, { table: T.ids, key: [change.id], value: [cut, change.seq] });
      // the slot is free and the id was never confirmed anywhere (dedup by id spans every cut and process)
      // the id was never confirmed anywhere, nor recorded as a no-op (dedup by id spans every cut and process)
      conds.push({ table: T.changes, key: [cut, change.seq], expect: "absent" }, { table: T.ids, key: [change.id], expect: "absent" }, { table: T.meta, key: ["noop", change.id], expect: "absent" });
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
  /** A write with an id: if another process recorded it as a no-op, this handle learns it before acting (by id, not a scan). */
  async #noopOf(id: ChangeId | undefined): Promise<void> {
    if (!id) return;
    const n = await this.store.get<[string, number]>(T.meta, ["noop", id]);
    if (n) this.#h.noteNoop(id, n[0], n[1]);
  }
  /** Run a History mutation under the handle's queue, persist what it confirmed, and retry after losing a race. */
  async #mutate<R>(cut: string | undefined, fn: () => R, opts: { extra?: () => { writes?: StoreWrite[]; conds?: StoreCondition[] }; conditions?: StoreCondition[]; idempotent?: boolean; id?: ChangeId } = {}): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.#closed) throw new Error("Carton: closed");
      for (let attempt = 0; ; attempt++) {
        await this.#refresh(cut);
        await this.#noopOf(opts.id);
        this.#confirmed.length = 0;
        this.#noops.length = 0;
        let ok: boolean, r: R;
        try {
          r = fn();
          const x = opts.extra?.() ?? {};
          ok = await this.#flush(x.writes ?? [], [...(opts.conditions ?? []), ...(x.conds ?? [])]);
        } catch (e) {
          // the model may hold changes the store never got (a write that threw): drop them before anything else runs
          this.#confirmed.length = 0;
          this.#noops.length = 0;
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
    // a shared cut's head is its optimistic state: confirmed rows plus this replica's pending edits
    const sc = this.#shared.get(cut);
    if (sc) {
      this.#feedQueue(cut);
      return { ref: this.#sharedRef(cut), doc: E.fork(sc.queue.optimistic(cut).doc, this.schema) };
    }
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
    if (rec?.kind === "published") throw new Error("Carton: a Published cut is read-only; publish again to update it");
    const author = this.#actor(input.author);
    const id = input.id ?? `${this.#rid}.${++this.#n}`;
    if (this.#isShared(cut)) return this.#commitShared(cut, input, author, id);
    // the base is fixed on the first attempt: a retry after losing a race must rebase on it, never treat what the other
    // process just wrote as something this commit removes
    let base = input.base;
    let last: CommitResult | null = null;
    const r = await this.#mutate(
      input.id ? undefined : cut, // an explicit id: look for it on every cut (dedup by id)
      (): CommitResult => {
        // each attempt starts clean: an attempt that lost the append race must not leave its cards for a later one
        // (a duplicate of a change another copy of this request already confirmed writes no cards at all)
        last = null;
        const dup = this.#h.confirmedById(input.id);
        if (dup) return dup;
        base ??= { branchId: cut, seq: this.#h.headSeq(cut), pending: [] };
        return (last = this.#h.commit(cut, {
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
          ...(input.undoOf?.length ? { kind: "undo" as const, extra: { reverts: [...input.undoOf] } } : {}),
          id,
        }));
      },
      {
        conditions: input.conditions ?? [],
        idempotent: !input.conditions?.length,
        id,
        ...(input.cardsWrite
          ? { extra: () => { const x = last as (CommitResult & { resolved?: ConflictCard[] }) | null; return { writes: x?.status === "confirmed" && x.resolved?.length ? input.cardsWrite!(x.resolved, x.change) : [] }; } }
          : {}),
      },
    );
    const { retry: _r, ...out } = r as CommitResult & { retry?: unknown };
    this.#notices(out);
    if (out.status === "confirmed" && out.warnings?.length) this.#emit({ type: "warning", branchId: cut, warnings: out.warnings });
    await this.#saveNotices(out);
    return out;
  }
  own(author: Actor): OwnFn {
    return this.#h.own(author);
  }
  newChangeId(): ChangeId {
    return `${this.#rid}.${++this.#n}`;
  }
  async pin(opts: { owner: string; cut?: string; ttlMs?: number; doc?: Doc; by?: string; seq?: number; causal?: ChangeId[] }): Promise<Pin> {
    const cut = opts.cut ?? this.#h.current;
    const now = this.#opts.clock?.() ?? Date.now();
    let ref!: StateRef;
    await this.#mutate(cut, () => (ref = this.#h.pin({ cutId: cut, owner: opts.owner, expires: opts.ttlMs === undefined ? Infinity : now + opts.ttlMs, ...(opts.doc ? { doc: opts.doc } : {}), ...(opts.seq !== undefined ? { seq: opts.seq } : {}), ...(opts.causal?.length ? { pending: opts.causal.map((id) => ({ id, ops: [] })) } : {}) })), {
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
  async fork(name: string, opts: { from?: StateRef | string; kind?: CutKind; author?: Actor; id?: string; source?: string } = {}): Promise<CutRecord> {
    let rec!: CutRecord;
    let made = false;
    await this.#mutate(
      undefined,
      () => {
        made = false;
        const known = opts.id ? this.#h.cut(opts.id) : undefined;
        if (known) return void (rec = known); // a retried fork: the cut it already made
        const from = opts.from === undefined ? { node: this.#h.head(this.#h.current), doc: null } : this.#held(opts.from);
        rec = this.#h.cut(this.#h.fork(from.node, name, { kind: opts.kind ?? "variant", owner: this.#opts.name ?? this.#h.name, ...(opts.id ? { id: opts.id } : {}), ...(opts.source ? { source: opts.source } : {}) }))!;
        made = true;
        // forking from a held state: the cut forks at its version and the held edits are its first change
        if (from.doc) this.#h.commit(rec.id, { doc: from.doc, author: this.#actor(opts.author), publish: opts.kind === "published", ...(opts.id ? { id: `${opts.id}.held` } : {}) });
        rec = this.#h.cut(rec.id)!;
      },
      { extra: () => (made ? { writes: [{ table: T.cuts, key: [rec.id], value: rec }], conds: [{ table: T.cuts, key: [rec.id], expect: "absent" }] } : {}), idempotent: !!opts.id },
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
  async publish(opts: { from?: StateRef | string; name?: string; id?: string } = {}): Promise<CutRecord> {
    // the cut it comes from, said explicitly: a fork node is canonical, so an unedited variant's would name its parent;
    // refreshed first, so a cut another process made is known by its full id
    await this.#refresh();
    const from = opts.from;
    const source = from === undefined ? this.#h.current : typeof from === "string" && this.#h.cut(from) ? from : typeof from === "string" && NODE_RE.test(from) ? parseNode(from).branchId : (() => {
      const p = this.#h.parseRef(from);
      return "legacy" in p ? this.#h.current : p.branchId;
    })();
    return this.fork(opts.name ?? "Published cut", { kind: "published", source, ...(from !== undefined ? { from } : {}), ...(opts.id ? { id: opts.id } : {}) });
  }
  async publications(): Promise<Publication[]> {
    await this.#refresh();
    const out: Publication[] = [];
    for (const cut of this.#h.cuts()) {
      if (cut.kind !== "published" || !cut.forkOf) continue;
      const from = this.#h.canon(cut.forkOf);
      const source = cut.source ?? parseNode(from).branchId;
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
    if (this.#isShared(into)) return this.#foldShared(into, from, opts);
    const author = this.#actor(opts.author);
    // refresh every cut: the one folded in may have grown in another process
    const r = await this.#mutate(undefined, () => this.#h.fold(into, this.#foldable(from), { ...opts, author }), { idempotent: true, ...(opts.id ? { id: opts.id } : {}) });
    const { retry: _r, merge, base: _b, doc: _d, ...out } = r as FoldResult & { retry?: unknown; merge?: MergeResult; base?: unknown; doc?: unknown };
    // a dry run tells what the fold would bring in (the Fold in dialog, `cb fold --check`): with choices, the resolved
    // state; without, every card on its provisional side
    const resolved = (r as { doc?: Doc }).doc;
    if (opts.check && (merge || resolved)) {
      const ours = this.#h.stateOf(this.#h.head(into))!;
      const ops = resolved ? E.diff(ours, resolved, this.schema) : merge!.ops;
      return { ...(out as FoldResult), preview: { ops, describe: E.describe(ops, ours, this.schema), warnings: merge?.warnings ?? [] } };
    }
    return out as FoldResult;
  }
  async foldSome(from: string | StateRef, opts: FoldOptions & { into?: string; reject: PathKey[] }): Promise<FoldResult> {
    const into = opts.into ?? this.#h.current;
    this.#localOnly(into, "foldSome");
    const author = this.#actor(opts.author);
    const r = await this.#mutate(undefined, () => this.#h.foldSome(into, this.#foldable(from), { ...opts, author }), { idempotent: true, ...(opts.id ? { id: opts.id } : {}) });
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
  async restore(ref: StateRef | string, opts: { author?: Actor; cut?: string; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    this.#localOnly(cut, "restore");
    // History resolves headers and StateRefs itself, pins included, so a held state is restored as held; a cut id is
    // its head as of now (inside the mutation, after the refresh), never a cached one
    return this.#mutate(undefined, () => this.#h.restore(cut, typeof ref === "string" && this.#h.cut(ref) ? this.#h.head(ref) : ref, { author: this.#actor(opts.author), ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
  }
  async revert(changeId: ChangeId, opts: { author?: Actor; cut?: string; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    this.#localOnly(cut, "revert");
    return this.#mutate(opts.id ? undefined : cut, () => this.#h.revert(cut, changeId, { author: this.#actor(opts.author), ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
  }
  async undo(group?: string, opts: { cut?: string; author?: Actor; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    this.#localOnly(cut, "undo");
    const actor = this.#actor(opts.author);
    return this.#mutate(opts.id ? undefined : cut, () => this.#h.undo(cut, group ?? groupOf(actor), { author: actor, ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
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

  // ------------------------------------------------------------ shared cuts (§5.3, §6.2, §12): through SharedCut
  #isShared(cut: string): boolean {
    const k = this.#h.cut(cut)?.sequencer.kind;
    return k === "server" || k === "handingOff";
  }
  /** The cut's SharedCut, made on first use from History's confirmed rows, with this store's pending edits re-queued. */
  async #ensureShared(cut: string): Promise<SharedCut> {
    const have = this.#shared.get(cut);
    if (have) return have;
    const sync = this.#opts.sync;
    const rec = this.#h.cut(cut)!;
    if (!sync) throw new Error(`Carton: cut ${rec.name} is shared; open Carton with \`sync\` to edit it`);
    this.#rq ??= new ReplicaQueue(this.schema, this.#opts.keyframeEvery ? { keyframeEvery: this.#opts.keyframeEvery } : {});
    const sc = new SharedCut({
      queue: this.#rq,
      branch: { id: rec.id, name: rec.name, kind: rec.kind, sequencer: rec.sequencer, forkOf: rec.forkOf ? parseNode(this.#h.canon(rec.forkOf)) : null },
      doc0: this.#h.stateOf(nodeId(cut, 0))!,
      rows: [...this.#h.changes(cut)],
      transport: sync.transport,
      url: sync.url,
      token: sync.token,
      schemaVersion: this.#opts.adapter.schemaVersion,
      client: { adoptPayload: () => this.#adoptPayload(cut) },
    });
    this.#shared.set(cut, sc);
    // edits an earlier session queued and the server never confirmed: back in the queue, in their order
    const pending = (await this.store.range<PendingRow>(T.pending, { prefix: [cut] })).map((e) => e.value).sort((a, b) => a.at - b.at || cmpStr(a.id, b.id));
    for (const p of pending) if (!this.#h.confirmedById(p.id) && !sc.queue.pending(cut).some((q) => q.id === p.id)) sc.commit({ id: p.id, author: p.author, ops: p.ops, at: p.at, intent: p.intent, kinds: p.kinds, policy: p.policy, inferIntent: false, ...(p.history ? { history: p.history } : {}) });
    sc.on((e) => this.#onShared(cut, e));
    if (this.#connected) void sc.connect(this.#connected);
    return sc;
  }
  /** Rows another process (the lease holder) already stored: into this process's queue, so its base is current. */
  #feedQueue(cut: string): void {
    const q = this.#shared.get(cut)?.queue;
    if (!q) return;
    const rows = this.#h.changes(cut);
    if (rows.length > q.headSeq(cut)) q.integrate(cut, rows.slice(q.headSeq(cut)));
  }
  #sharedRef(cut: string): StateRef {
    const q = this.#shared.get(cut)!.queue;
    return { branchId: cut, seq: q.headSeq(cut), pending: q.pending(cut).map((p) => p.id) };
  }
  /** §5.3 hand-off: the rows the server adopts, keyed (cut, n, stateHash@n); the closure goes later (L5). */
  #adoptPayload(cut: string) {
    const rec = this.#h.cut(cut)!;
    const n = rec.sequencer.kind === "handingOff" ? rec.sequencer.n : this.#h.headSeq(cut);
    return { rows: this.#h.changes(cut).slice(0, n) as ConfirmedChange[], rec, doc0: this.#h.stateOf(nodeId(cut, 0))!, closure: [] };
  }
  #onShared(cut: string, e: SharedCutEvent): void {
    switch (e.type) {
      case "state":
        this.#emit({ type: "sync", status: e.state.status === "connecting" ? "syncing" : e.state.status, waiting: e.state.pending });
        break;
      case "presence":
        this.#emit({ type: "presence", branchId: e.branchId, actor: e.actor as Actor, state: e.state });
        return;
      case "absorbed":
        this.#emit({ type: "absorbed", branchId: cut, id: e.id, cards: e.cards });
        break;
      case "rejected":
        break; // a notice for the change's author is written when it settles (#settleShared)
    }
    // confirmed rows go into History and the store, settled edits leave the pending table, and a finished hand-off
    // is recorded on the cut; serialized behind every other write of this handle
    const run = () => this.#settleShared(cut, e);
    this.#queue = this.#queue.then(run, run).catch(() => {});
  }
  async #settleShared(cut: string, e: SharedCutEvent): Promise<void> {
    const sc = this.#shared.get(cut);
    if (!sc || this.#closed) return;
    const writes: StoreWrite[] = [];
    // rows the server confirmed (ours and others'), up to the first stretch known only through a keyframe
    const rows = sc.queue.rows(cut);
    const fresh: ConfirmedChange[] = [];
    for (let i = this.#h.headSeq(cut); i < rows.length; i++) {
      const r = rows[i]!;
      if (r.placeholder) break;
      fresh.push(r as ConfirmedChange);
    }
    if (fresh.length) {
      this.#h.load(cut, fresh);
      for (const r of fresh) writes.push({ table: T.changes, key: [cut, r.seq], value: r }, { table: T.ids, key: [r.id], value: [cut, r.seq] }, { table: T.pending, key: [cut, r.id], value: undefined });
    }
    // a pending change that came back with cards after its write had returned (a late conflict, §6.2): a notice for
    // its author, in the same batch, returned at the start of that actor's next cb/MCP result and by the Stop hook
    const late = e.type === "confirmed" ? e.lateCards : e.type === "absorbed" ? e.cards : [];
    const lateId = e.type === "confirmed" || e.type === "absorbed" ? e.id : null;
    let lateNotice: Notice | null = null;
    if (e.type === "rejected") {
      // refused for good (validation, or "too large" before it was sent): its author is told, not this handle's actor
      const author = (await this.store.get<PendingRow>(T.pending, [cut, e.id]))?.author;
      if (author) {
        const at = this.#opts.clock?.() ?? Date.now();
        const why = e.reason === "too large" ? "it is larger than the server accepts; the edits after it still went through" : e.reason;
        lateNotice = { to: actorKey(author), kind: "rejected", text: `Your change ${e.id} wasn't saved: ${why}`, change: e.id, at };
        writes.push({ table: T.notices, key: [lateNotice.to, at, 0, randomHex(4)], value: lateNotice });
      }
    } else if (late.length && lateId) {
      const author = (e.type === "confirmed" ? this.#h.findChange(lateId)?.author : undefined) ?? (await this.store.get<PendingRow>(T.pending, [cut, lateId]))?.author;
      if (author) {
        const at = this.#opts.clock?.() ?? Date.now();
        lateNotice = { to: actorKey(author), kind: "late-conflict", text: `Your change ${lateId} conflicted after it was made: ${late.map((c) => c.path).join(", ")} kept the other side's value`, change: lateId, cards: late, at };
        writes.push({ table: T.notices, key: [lateNotice.to, at, 0, randomHex(4)], value: lateNotice });
      }
    }
    if (e.type === "absorbed" || e.type === "rejected") writes.push({ table: T.pending, key: [cut, e.id], value: undefined });
    // the hand-off finished (handingOff → server{since}): the cut's record says so from now on
    const qs = sc.queue.branch(cut).sequencer;
    if (E.canonical(qs) !== E.canonical(this.#h.cut(cut)!.sequencer)) writes.push({ table: T.cuts, key: [cut], value: this.#h.updateCut(cut, { sequencer: qs }) });
    if (writes.length) await this.store.write(writes);
    for (const r of fresh) this.#emit({ type: "change", branchId: cut, seq: r.seq, change: r, local: r.id.startsWith(this.#rid + ".") });
    if (lateNotice) this.#emit({ type: "notice", notice: lateNotice });
  }
  async #commitShared(cut: string, input: CommitInput, author: Actor, id: ChangeId, history?: HistoryFields): Promise<CommitResult> {
    const sc = await this.#ensureShared(cut);
    const q = sc.queue;
    await this.#refresh(cut);
    await this.#noopOf(id);
    this.#feedQueue(cut);
    const done = this.#h.confirmedById(id);
    if (done) return done;
    if (q.pending(cut).some((p) => p.id === id)) return { status: "pending", id, ref: this.#sharedRef(cut), notices: [] };
    const opt = q.optimistic(cut).doc;
    let ops: Op[];
    // the cards `choices` decided merging a stale base onto the optimistic head (written with the queued row)
    let resolved: ConflictCard[] = [];
    if (input.base === undefined) ops = input.ops ?? E.diff(opt, input.doc!, this.schema);
    else {
      // a stale base (an agent's header): merge it onto the optimistic state here, as a local cut's commit would
      const b = input.base;
      const baseDoc = typeof b === "object" && "baseDoc" in b ? b.baseDoc : this.#h.resolve(b as StateRef | string).doc;
      const mine = input.doc ?? E.apply(E.fork(baseDoc, this.schema), input.ops ?? [], this.schema);
      if (E.hashDoc(baseDoc, this.schema) === E.hashDoc(opt, this.schema)) ops = E.diff(opt, mine, this.schema);
      else {
        const m = E.merge3(baseDoc, opt, mine, this.schema, { ...(input.intent?.maps ? { remaps: { theirs: { maps: input.intent.maps } } } : {}), kinds: { theirs: input.kinds ?? {} }, rekeys: "ours" });
        const unseen = input.unchosen === "prefer" ? [] : unseenCards(m.conflicts, input.choices);
        if (m.conflicts.length && (!input.choices || unseen.length)) return { status: "conflicts", cards: m.conflicts, ref: this.#sharedRef(cut), merge: m, ...(input.choices ? { unseen: unseen.map((c) => c.path) } : {}) };
        ops = E.diff(opt, m.conflicts.length ? E.resolve(m, input.choices!) : m.doc, this.schema);
        if (m.conflicts.length) resolved = m.conflicts;
      }
    }
    const at = this.#opts.clock?.() ?? Date.now();
    const hist: HistoryFields | undefined = history ?? (input.name ? { name: input.name } : undefined);
    const r = sc.commit({ id, author, ops, at, ...(input.policy ? { policy: input.policy } : {}), ...(input.intent ? { intent: input.intent } : {}), ...(input.kinds ? { kinds: input.kinds } : {}), ...(hist ? { history: hist } : {}) });
    const cardWrites = resolved.length && input.cardsWrite ? input.cardsWrite(resolved, null) : [];
    if (r.status === "confirmed") {
      if (cardWrites.length) await this.store.write(cardWrites);
      return { status: "confirmed", seq: q.headSeq(cut), ref: this.#sharedRef(cut), change: null, empty: true, rebased: 0, notices: [], ...(resolved.length ? { resolved } : {}) };
    }
    // queued: kept in the store until the server answers, so a restart pushes it again under the same id
    const row: PendingRow = { id, author, ops, at, intent: input.intent ?? null, kinds: input.kinds ?? null, policy: input.policy ?? "merge", ...(hist ? { history: hist } : {}) };
    await this.store.write([{ table: T.pending, key: [cut, id], value: row }, ...cardWrites]);
    if (input.wait) return this.#outcome(cut, await sc.waitFor(id, input.wait));
    return { status: "pending", id, ref: this.#sharedRef(cut), notices: [], ...(resolved.length ? { resolved } : {}) };
  }
  #outcome(cut: string, o: WriteOutcome): CommitResult {
    if (o.status === "confirmed") return { status: "confirmed", seq: o.seq, ref: { branchId: cut, seq: o.seq, pending: [] }, change: this.#h.findChange(o.id), rebased: 0, notices: [] };
    if (o.status === "conflicts") return { status: "conflicts", cards: o.cards, ref: this.#sharedRef(cut) };
    if (o.status === "rejected") return { status: "rejected", reason: o.reason };
    return { status: "pending", id: o.id, ref: this.#sharedRef(cut), notices: [] };
  }
  async share(cut: string = this.#h.current): Promise<CutRecord> {
    if (!this.#opts.sync) throw new Error("Carton.share: open Carton with `sync` (transport, url, token) to share a cut");
    if (!this.#isShared(cut)) {
      let was!: CutRecord, rec!: CutRecord;
      await this.#mutate(
        undefined,
        () => {
          was = this.#h.cut(cut)!;
          const n = this.#h.headSeq(cut);
          // from now on local commits on it are pending, never confirmed, so no local seq after n can collide (§5.3)
          rec = this.#h.updateCut(cut, { sequencer: { kind: "handingOff", n, stateHash: this.#h.hashOf(nodeId(cut, n))! } });
        },
        { extra: () => ({ writes: [{ table: T.cuts, key: [cut], value: rec }], conds: [{ table: T.cuts, key: [cut], expect: { equals: was } }] }), idempotent: true },
      );
    }
    await this.#ensureShared(cut);
    return this.#h.cut(cut)!;
  }
  /** Folds onto a shared cut: History computes the fold on the confirmed head, the SharedCut queues it as a fold. */
  async #foldShared(into: string, from: string | StateRef, opts: FoldOptions): Promise<FoldResult & { preview?: FoldPreview }> {
    const sc = await this.#ensureShared(into);
    await this.#queue;
    await this.#refresh();
    if (this.#h.headSeq(into) < sc.queue.headSeq(into)) await this.#settleShared(into, { type: "remote", rows: [] });
    const waiting = sc.queue.pending(into).length;
    if (waiting && !opts.check) throw new Error(`Carton.fold: ${waiting} edit${waiting === 1 ? "" : "s"} waiting to sync on this cut; fold once it is up to date`);
    const done = this.#h.confirmedById(opts.id);
    if (done) return done;
    const author = this.#actor(opts.author);
    const y = this.#foldable(from);
    const r = this.#h.fold(into, y, { ...opts, check: true, author }) as FoldResult & { merge?: MergeResult; base?: ReturnType<History["mergeBase"]>; doc?: Doc; retry?: unknown };
    const { merge, base, doc, retry: _r, ...out } = r;
    if (r.status !== "confirmed" || !doc) return out as FoldResult;
    const ours = this.#h.stateOf(this.#h.head(into))!;
    const ops = E.diff(ours, doc, this.schema);
    if (opts.check) return { ...(out as FoldResult), preview: { ops, describe: E.describe(ops, ours, this.schema), warnings: merge?.warnings ?? [] } };
    // the fold's DAG fields travel with the change (the queue keeps them through rebases)
    const history: HistoryFields = {
      kind: "merge",
      mergeOf: parseNode(this.#h.canon(y)),
      mergeEdges: merge ? { first: merge.edges.ours, second: merge.edges.theirs } : { first: {}, second: {} },
      mergeBase: base?.node ? [base.node] : base?.nodes ?? [],
    };
    return this.#commitShared(into, { ops }, author, opts.id ?? `${this.#rid}.${++this.#n}`, history);
  }
  /** Writes History can't make on a shared cut yet: they say so instead of confirming locally. */
  #localOnly(cut: string, what: string): void {
    if (this.#isShared(cut)) throw new Error(`Carton.${what}: not available on a shared cut yet (commit and fold are)`);
  }

  on(listener: (event: CartonEvent) => void) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
  async close() {
    await this.#queue;
    for (const sc of this.#shared.values()) sc.close();
    this.#shared.clear();
    this.#closed = true;
    this.#listeners.clear();
  }
}

export type { Rec };
