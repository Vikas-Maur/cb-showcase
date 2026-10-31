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
import type { FieldSpec, Schema } from "./schema.ts";
import type { PresenceState } from "./sync/messages.ts";
import type { SyncStatus } from "./sync/index.ts";
import { ReplicaQueue, type HistoryFields, type QueuedChange } from "./sync/queue.ts";
import { SharedCut, type SharedCutEvent, type SyncState, type WriteOutcome } from "./sync/replica.ts";
import { STORE_TABLES as T, StateUnknown, type FoldOptions, type FoldPreview, type FoldResult, type HeldBase, type Planned, type Tail } from "./history/common.ts";
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
   * `join`: a cut a host already sequences, opened from an invite on a machine that holds nothing of the project.
   */
  init?: { doc: Doc; projectId?: string; cutName?: string; asChange?: boolean } | { import: ShallowExport } | { join: JoinInit };
  /** `autoConnect: false`: the sync-lease holder connects itself, under its nonce (§6.2). */
  sync?: {
    transport: Transport;
    url: string;
    token: string | (() => Promise<string>);
    autoConnect?: boolean;
    /**
     * The host's blob store (or a client for it): messages over 1 MiB travel as envelopes both ways, and the largest
     * message the server reads (declared in its welcome) becomes this client's limit. Without it every message goes
     * inline, up to `maxMessageBytes`.
     */
    blobs?: BlobStore;
    /**
     * The largest message this client sends (default 32 MiB inline, 64 MiB with `blobs`, until the server declares
     * its own): a change over it is refused before it is sent, `rejected` / "too large", and the edits after it go on.
     */
    maxMessageBytes?: number;
  };
  media?: { blobStore: BlobStore; encoders?: ProxyEncoder[] };
  clock?: () => number;
  keyframeEvery?: number;
  /** A display name for this replica in lineage and dialogs ("Bob"). */
  name?: string;
}

/**
 * Joining a shared cut from nothing (an invite link opened in a browser): the cut's record as the host knows it
 * (`sequencer.kind` "server", not a fork) and its state at seq 0. The confirmed rows come from the host when sync
 * connects. `rootHash`, when given, is checked against `doc0` (`hashDoc`) before anything is stored.
 */
export interface JoinInit {
  projectId: string;
  cut: CutRecord;
  doc0: Doc;
  rootHash?: string;
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
   * `conditions` (the holder's `fence(nonce)` as a Store condition) go with every write that settles the server's
   * answers: a holder replaced before its own fence noticed writes nothing, reloads what the store holds and stops
   * (a `sync` event, status `stopped`), so its replacement alone records outcomes and authors' notices.
   */
  connect(opts?: { nonce?: string; fence?: (nonce: string) => boolean; conditions?: StoreCondition[]; timeoutMs?: number }): Promise<boolean>;
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
  /**
   * Optional compaction (§5.4): on this replica's local cuts, squash the micro-changes of every auto-version older than
   * `olderThanDays` (default 90) into the auto-version's last change. Returns how many changes were squashed.
   */
  compact(opts?: { cut?: string; olderThanDays?: number }): Promise<{ squashed: number }>;
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
  /** Its place in the queue (re-queued in this order after a restart). */
  order: number;
  intent: Intent | null;
  kinds: EditKinds | null;
  policy: Policy;
  history?: HistoryFields;
}
const pendingRow = (p: QueuedChange, order: number): PendingRow => {
  const v = p.versions[p.versions.length - 1]!;
  return { id: p.id, author: p.author, ops: v.ops, at: p.created, order, intent: v.intent, kinds: v.kinds, policy: v.policy, ...(p.history ? { history: p.history } : {}) };
};
/** The append turn (`lease` table, local): who may append while others wait (see `#mutate`). */
const TURN = ["append-turn"] as const;
/** A turn its holder never gave back is free after this long (a crashed writer; one append takes far less). */
const TURN_MS = 5000;
/** Only a write that keeps failing for a reason other than contention gives up, after this long. */
const MUTATE_BACKSTOP_MS = 60_000;
/** A keyframe also after this many bytes of ops since the last one (a big import), so opening never replays more. */
const KF_BYTES = 1 << 20;
const PROJECT = ["project"] as const;
const CURRENT = ["current"] as const;
const NODE_RE = /^[^~\s]+@\d+$/;
const emptyDoc = (schema: Schema): Doc => Object.fromEntries(Object.keys(schema.collections).map((k) => [k, []]));
interface ProjectMeta {
  projectId: string;
  schemaVersion: number;
  /** The document schema's fingerprint (`schemaFingerprint`), checked by every process that opens the project. */
  schema?: string;
}

/**
 * What decides how states hash, diff and merge: the collections (keys, field kinds, groups, parents, order), the root
 * fields and the timeline's fields; the host's callbacks (validators, labels, shot rules) are left out. Two processes
 * on one store with different fingerprints would compute different state hashes for the same rows, so refs and pins one
 * makes the other can't check (`StateUnknown`).
 */
export function schemaFingerprint(schema: Schema): string {
  const spec = (f: FieldSpec): unknown =>
    f.kind === "leaf" ? ["leaf", !!f.atomic, !!f.text, !!f.blob]
    : f.kind === "object" ? ["object", f.deep, f.only, fields(f.fields)]
    : f.kind === "keyed" ? ["keyed", f.key, fields(f.fields)]
    : ["ephemeral"];
  const fields = (fs: Readonly<Record<string, FieldSpec>>) => Object.fromEntries(Object.entries(fs).map(([k, f]) => [k, spec(f)]));
  const tl = schema.timeline;
  return E.sha256Hex(
    E.canonical({
      root: fields(schema.root.fields),
      collections: Object.fromEntries(
        Object.entries(schema.collections).map(([n, c]) => [n, { key: c.key, seq: !!c.seq, only: !!c.only, parent: c.parent ?? null, groups: c.groups.map((g) => [g.name, [...g.fields]]), record: fields(c.record.fields) }]),
      ),
      timeline: tl && [tl.collection, tl.lanes, tl.lane, tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed],
    }),
  );
}

export const Carton = {
  /** Open (or create, with `init`) a project in `store`. */
  async open(opts: OpenOptions): Promise<Carton> {
    if (opts.hasher?.sha256HexSync) E.setSyncHash(opts.hasher.sha256HexSync.bind(opts.hasher));
    const c = new CartonImpl(opts);
    await c.load();
    // a handle opened with sync holds its shared cuts' queues at once (pending edits and status show before any
    // write), and starts syncing them unless the lease holder connects it under its nonce
    if (opts.sync) await c.initShared();
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
  /** Store conditions every settling write carries (`connect({ conditions })`); `#fenced` once one failed. */
  #settleConds: StoreCondition[] = [];
  #fenced = false;
  /** Pending rows being written, by change id: a settle waits for them, never running before a row it settles exists. */
  #inflight = new Map<ChangeId, Promise<unknown>>();
  /**
   * The author of each change this handle queued, until its own outcome is settled: an earlier settlement may already
   * have dropped its pending row (it left the queue), and its notice must still go to its author.
   */
  #authors = new Map<ChangeId, Actor>();
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
  /** Joined cuts whose lineage is still to fetch from their server (meta ["join", cut]). */
  #joining = new Set<string>();
  /** History fetches running per cut (a joined cut's lineage, a keyframe catch-up's stretch). */
  #fetching = new Map<string, Promise<void>>();
  /** Per cut: the newest periodic keyframe this handle knows of, and the op bytes confirmed since the last keyframe. */
  #kf = new Map<string, { periodic: number; bytes: number }>();
  /** Rows a backfill fetched and checked, by cut and seq, for the next settlement to store in place of placeholders. */
  #filled = new Map<string, Map<number, ConfirmedChange>>();

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
          self.#settleConds = o.conditions ?? [];
          self.#fenced = false;
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
          const b = cut ?? self.#h.current;
          const sc = self.#shared.get(b);
          if (sc) {
            const o = await sc.waitFor(id, ms);
            // a settled outcome answers once it is in the store and History (its author's notice written, its pending
            // row gone, the confirmed row in log() and credits()), so a caller that reports it can mark that notice
            // delivered rather than have it told again on the next call
            if (o.status !== "pending") await self.#settle(b, { type: "remote", rows: [] });
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
      if ("join" in init) return this.#createFromJoin(init.join);
      const h = History.create(this.schema, init.asChange ? emptyDoc(this.schema) : init.doc, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, projectId: init.projectId ?? null, keyframeEvery: this.#opts.keyframeEvery, cut: init.cutName ?? "Main cut" });
      const cut = h.cut(h.current)!;
      meta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion, schema: schemaFingerprint(this.schema) };
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
    this.#meta = await this.#checkSchema(meta);
    await this.#rebuild();
  }
  /**
   * Every process on a project must hash and merge its states alike (R2-03): one whose schema differs from the one the
   * project was made with, at the same schema version, is refused here, rather than failing later on every ref the
   * other makes ("rebuilt state does not match"). A project made before fingerprints gets this process's.
   */
  async #checkSchema(meta: ProjectMeta): Promise<ProjectMeta> {
    const mine = schemaFingerprint(this.schema);
    if (meta.schemaVersion !== this.#opts.adapter.schemaVersion || meta.schema === mine) return meta;
    if (meta.schema === undefined) {
      const next = { ...meta, schema: mine };
      return (await this.store.write([{ table: T.meta, key: PROJECT, value: next }], [{ table: T.meta, key: PROJECT, expect: { equals: meta } }])) ? next : this.#checkSchema((await this.store.get<ProjectMeta>(T.meta, PROJECT))!);
    }
    throw new Error(`Carton.open: this project was made with another document schema than ${this.#opts.adapter.name}'s (schema version ${meta.schemaVersion}, fingerprint ${meta.schema.slice(0, 8)}, this process ${mine.slice(0, 8)}); its states would hash and merge differently here`);
  }
  async #createFromImport(pkg: ShallowExport): Promise<void> {
    const h = new History(this.schema, { name: this.#opts.name ?? "replica", rid: this.#rid, nextId: () => `${this.#rid}.${++this.#n}`, clock: this.#opts.clock, keyframeEvery: this.#opts.keyframeEvery });
    const res = h.importShallow(pkg);
    if (res.status !== "forked") throw new Error(`Carton.open: import gave ${res.status}`);
    const meta: ProjectMeta = { projectId: h.projectId!, schemaVersion: this.#opts.adapter.schemaVersion, schema: schemaFingerprint(this.schema) };
    const w: StoreWrite[] = [{ table: T.meta, key: PROJECT, value: meta }, { table: T.meta, key: CURRENT, value: h.current }, ...this.#knowledgeWrites(h)];
    for (const c of h.cuts()) w.push({ table: T.cuts, key: [c.id], value: c });
    if (!(await this.store.write(w, [{ table: T.meta, key: PROJECT, expect: "absent" }]))) return this.load();
    this.#meta = meta;
    await this.#rebuild();
  }
  // A shared cut joined from nothing: the project, the cut's record and its root are stored exactly as a hand-off left
  // them on the sharer's machine, so from here on it opens like any shared cut (its rows arrive on connect).
  async #createFromJoin(j: JoinInit): Promise<void> {
    if (j.cut.sequencer.kind !== "server") throw new Error("Carton.open: `join` needs a cut a host sequences (sequencer kind \"server\")");
    if (!this.#opts.sync) throw new Error("Carton.open: `join` needs `sync` (the rows come from the host)");
    if (j.rootHash !== undefined && E.hashDoc(j.doc0, this.schema) !== j.rootHash) throw new Error("Carton.open: the joined cut's root doesn't match its hash");
    const meta: ProjectMeta = { projectId: j.projectId, schemaVersion: this.#opts.adapter.schemaVersion, schema: schemaFingerprint(this.schema) };
    const ok = await this.store.write(
      [
        { table: T.meta, key: PROJECT, value: meta },
        { table: T.meta, key: CURRENT, value: j.cut.id },
        // a fork's record gets its fork point once its lineage is here (a fork node's state comes with it): until then
        // `doc0` is its root, as for any joined cut. ["join", cut] says the lineage is still to fetch (Stage F2).
        { table: T.cuts, key: [j.cut.id], value: { ...j.cut, forkOf: null } },
        { table: T.keyframes, key: [j.cut.id, 0], value: j.doc0 },
        { table: T.meta, key: ["join", j.cut.id], value: { forkOf: j.cut.forkOf ?? null } },
      ],
      [{ table: T.meta, key: PROJECT, expect: "absent" }],
    );
    if (!ok) return this.load(); // another process (tab) joined first: open theirs
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
      if (c.shallow) return;
      // §5.4: from the cut's newest keyframe; only the rows after it are replayed
      const rows = (await s.range<ConfirmedChange>(T.changes, { prefix: [c.id] })).map((e) => e.value);
      const kf = (await s.range<Doc>(T.keyframes, { prefix: [c.id], gt: [c.id, 0], lte: [c.id, rows.length], reverse: true, limit: 1 }))[0];
      const at = kf ? (kf.key[1] as number) : 0;
      h.load(c.id, rows, kf ? [[at, kf.value]] : []);
      let bytes = 0;
      for (const r of rows.slice(at)) bytes += JSON.stringify(r.ops).length;
      kfState.set(c.id, { periodic: at && !h.milestone(nodeId(c.id, at)) ? at : 0, bytes });
    };
    const kfState = new Map<string, { periodic: number; bytes: number }>();
    for (const c of cuts) await add(c);
    for (const e of await s.range<{ name: string; at: number; by?: Actor }>(T.names)) h.nameVersion(nodeId(e.key[0] as string, e.key[1] as number), e.value.name, e.value.by);
    await this.#loadPins(h);
    for (const e of await s.range<[string, number]>(T.meta, { prefix: ["noop"] })) h.noteNoop(e.key[1] as string, e.value[0], e.value[1]);
    const current = await s.get<string>(T.meta, CURRENT);
    if (current && byId.has(current)) h.current = current;
    this.#joining = new Set((await s.range(T.meta, { prefix: ["join"] })).map((e) => e.key[1] as string));
    this.#kf = kfState;
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
  /**
   * Keyframes to persist after these confirmed rows of `cut` (§5.4): every K changes or KF_BYTES of ops since the last
   * keyframe, and at every named, fold, export or Published version. A periodic keyframe replaces the previous periodic
   * one (opening starts from the newest; milestones stay, as states folds and exports come back to). Returns the writes
   * and the state to keep once they are stored.
   */
  #keyframeWrites(cut: string, rows: readonly ConfirmedChange[]): { writes: StoreWrite[]; next: { periodic: number; bytes: number } } {
    const K = this.#opts.keyframeEvery ?? 64;
    const next = { ...(this.#kf.get(cut) ?? { periodic: 0, bytes: 0 }) };
    const writes: StoreWrite[] = [];
    for (const r of rows) {
      next.bytes += JSON.stringify(r.ops).length;
      const node = nodeId(cut, r.seq);
      const milestone = this.#h.milestone(node);
      if (!milestone && r.seq % K !== 0 && next.bytes < KF_BYTES) continue;
      const doc = this.#h.stateOf(node);
      if (!doc) continue;
      writes.push({ table: T.keyframes, key: [cut, r.seq], value: doc });
      next.bytes = 0;
      if (milestone) continue;
      if (next.periodic > 0 && next.periodic < r.seq && !this.#h.milestone(nodeId(cut, next.periodic))) writes.push({ table: T.keyframes, key: [cut, next.periodic], value: undefined });
      next.periodic = r.seq;
    }
    return { writes, next };
  }
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
      // the cut is still what this handle believes (local, not handed off meanwhile: §5.3, review R5-1)
      const rec = this.#h.cut(cut);
      if (rec && !extra.some((w) => w.table === T.cuts && w.key[0] === cut)) conds.push({ table: T.cuts, key: [cut], expect: { equals: rec } });
      if (change.name) writes.push({ table: T.names, key: [cut, change.seq], value: { name: change.name, at: change.at, by: change.author } });
    }
    // every replica id that committed here (R10-02: claimed in hello), one key each
    if (confirmed.length && !this.#ridSaved) writes.push({ table: T.meta, key: ["rid", this.#rid], value: { at: this.#opts.clock?.() ?? Date.now() } });
    // keyframes go in the same batch as their rows: a keyframe never exists without the rows it summarizes
    const kfs = new Map<string, { periodic: number; bytes: number }>();
    for (const cut of new Set(confirmed.map((c) => c.cut))) {
      const k = this.#keyframeWrites(cut, confirmed.filter((c) => c.cut === cut).map((c) => c.change));
      writes.push(...k.writes);
      kfs.set(cut, k.next);
    }
    if (!writes.length) return true;
    const ok = await this.store.write(writes, conds);
    if (ok) for (const [cut, k] of kfs) this.#kf.set(cut, k);
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
      // Starvation-free appends (VERIFIED S8): a writer that lost the race twice takes the append turn, and while it
      // holds it every other writer's append waits (each carries "no one else holds the turn"); its own append gives
      // the turn back in the same batch. A turn left by a crashed writer expires. Uncontended, a write costs one extra
      // condition and nothing else. Only a write that keeps failing for another reason runs out of time.
      const deadline = Date.now() + MUTATE_BACKSTOP_MS;
      let turn: { owner: string; until: number } | null = null;
      try {
        for (let lost = 0; ; ) {
          await this.#refresh(cut);
          await this.#noopOf(opts.id);
          this.#confirmed.length = 0;
          this.#noops.length = 0;
          let ok: boolean, r: R;
          try {
            r = fn();
            const x = opts.extra?.() ?? {};
            ok = await this.#flush([...(x.writes ?? []), ...(turn ? [{ table: T.lease, key: TURN, value: undefined }] : [])], [...(opts.conditions ?? []), ...(x.conds ?? []), { table: T.lease, key: TURN, expect: turn ? { equals: turn } : "absent" }]);
          } catch (e) {
            // the model may hold changes the store never got (a write that threw): drop them before anything else runs
            this.#confirmed.length = 0;
            this.#noops.length = 0;
            await this.#rebuild();
            throw e;
          }
          if (ok) {
            turn = null; // given back with the append
            return r;
          }
          // another process appended first, someone holds the turn, or a caller's condition (a lease fence) failed:
          // rebuild, then retry; a caller's condition that no longer holds is never retried (it would fail again)
          await this.#rebuild();
          if (!opts.idempotent || (opts.conditions?.length && !(await this.store.write([], opts.conditions)))) throw new Error("Carton: the store changed under this write (lost the append race or a condition failed)");
          if (Date.now() > deadline) throw new Error("Carton: this write kept failing for a minute (a store condition that never holds)");
          // a turn of ours that lapsed may have been taken over: take it again rather than wait on our own stale row
          if (turn && turn.until <= Date.now()) turn = null;
          // lost twice, or someone holds the turn: wait for the turn instead of recomputing against a moving head
          if (!turn && (++lost >= 2 || (await this.store.get(T.lease, TURN)) !== undefined)) turn = await this.#takeTurn(deadline);
        }
      } finally {
        // a write that failed for another reason gives back a turn it still holds
        if (turn) await this.store.write([{ table: T.lease, key: TURN, value: undefined }], [{ table: T.lease, key: TURN, expect: { equals: turn } }]).catch(() => {});
      }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }
  /**
   * Take the append turn, waiting while another writer holds it (it is given back with that writer's append, or
   * expires if the writer died). Never computes while waiting: the turn's holder lands first.
   */
  async #takeTurn(deadline: number): Promise<{ owner: string; until: number }> {
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      const mine = { owner: `${this.#rid}.${randomHex(4)}`, until: Date.now() + TURN_MS };
      if (await this.store.write([{ table: T.lease, key: TURN, value: mine }], [{ table: T.lease, key: TURN, expect: "absent" }])) return mine;
      const held = await this.store.get<{ owner: string; until: number }>(T.lease, TURN);
      // a turn its holder can't give back any more (it crashed, or took longer than TURN_MS): cleared for everyone
      if (held && held.until <= Date.now()) await this.store.write([{ table: T.lease, key: TURN, value: undefined }], [{ table: T.lease, key: TURN, expect: { equals: held } }]);
      else if (held) await new Promise((r) => setTimeout(r, wait * (0.5 + Math.random())));
      if (Date.now() > deadline) throw new Error("Carton: couldn't take the append turn for a minute");
    }
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
    const sc = this.#isShared(cut) && this.#opts.sync ? await this.#ensureShared(cut) : undefined;
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
    const sc = this.#shared.get(cut);
    if (sc) await this.#queue;
    await this.#refresh(cut);
    // a shared cut's edits still waiting to sync are its newest entries (and a waiting undo hides its change)
    if (sc) this.#feedQueue(cut);
    const tail = sc && sc.queue.headSeq(cut) === this.#h.headSeq(cut) ? this.#tail(cut, sc) : undefined;
    const n = this.#h.headSeq(cut);
    const log = tail ? [...this.#h.changes(cut), ...tail.rows] : this.#h.changes(cut);
    // a named version's label is its name, given with the edit or after it (as a teammate who joined sees it, on the
    // row); an unnamed edit's says what it did ("Undo Director: Trimmed 'Intro' end 6.0 s → 5.0 s")
    const names = new Map(this.#h.names());
    return this.#h.undoStack(cut, group ?? groupOf(this.#actor()), tail).map((e) => {
      const c = log[e.seq - 1]!;
      const name = e.seq <= n ? names.get(nodeId(cut, e.seq))?.name : undefined;
      if (name) return { ...e, label: undoLabel(c, name) };
      if (c.name || c.intent?.kind) return e;
      const before = e.seq - 1 > n ? tail!.states[e.seq - n - 2] : this.#h.stateOf(nodeId(cut, e.seq - 1));
      const what = E.describe(c.ops, before ?? {}, this.schema, c.intent)[0];
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
        // retried while the caller's conditions still hold (#mutate checks): it is idempotent under its id
        idempotent: true,
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
    // a shared cut's state includes this replica's pending edits: they are the pin's causal past (§5.2)
    const sc = this.#isShared(cut) && this.#opts.sync ? await this.#ensureShared(cut) : null;
    if (sc) {
      await this.#queue;
      if (this.#h.headSeq(cut) < sc.queue.headSeq(cut)) await this.#settleShared(cut, { type: "remote", rows: [] });
    }
    await this.#mutate(cut, () => {
      // a state derived from an older seq (a freeze view) builds on that seq alone
      // `causal`: the caller's own list of what the held state already holds after `seq`
      const pending = opts.causal?.length
        ? opts.causal.map((id) => ({ id, ops: [] }))
        : sc && opts.seq === undefined && this.#h.headSeq(cut) === sc.queue.headSeq(cut)
          ? sc.queue.pending(cut).map((p) => ({ id: p.id, ops: p.versions[p.versions.length - 1]!.ops }))
          : [];
      ref = this.#h.pin({ cutId: cut, owner: opts.owner, expires: opts.ttlMs === undefined ? Infinity : now + opts.ttlMs, ...(pending.length ? { pending } : {}), ...(opts.doc ? { doc: opts.doc } : {}), ...(opts.seq !== undefined ? { seq: opts.seq } : {}) });
    }, {
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
    if (this.#isShared(into)) return this.#foldShared(into, from, opts);
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
        // a named version keeps a keyframe (§5.4)
        const doc = seq > 0 && !this.#h.cut(branchId)?.shallow ? this.#h.stateOf(node) : null;
        return { writes: [{ table: T.names, key: [branchId, seq], value: { name, at: this.#opts.clock?.() ?? Date.now(), by: this.#actor() } }, ...(doc ? [{ table: T.keyframes, key: [branchId, seq], value: doc }] : [])] };
      },
      idempotent: true,
    });
  }
  async restore(ref: StateRef | string, opts: { author?: Actor; cut?: string; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    const target = () => (typeof ref === "string" && this.#h.cut(ref) ? this.#h.head(ref) : ref);
    if (this.#isShared(cut)) return this.#planShared(cut, opts.id, () => ({ doc: this.#h.restoreTarget(target()), author: this.#actor(opts.author), kind: "restore" }));
    // History resolves headers and StateRefs itself, pins included, so a held state is restored as held; a cut id is
    // its head as of now (inside the mutation, after the refresh), never a cached one
    return this.#mutate(undefined, () => this.#h.restore(cut, target(), { author: this.#actor(opts.author), ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
  }
  async revert(changeId: ChangeId, opts: { author?: Actor; cut?: string; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    if (this.#isShared(cut)) return this.#planShared(cut, opts.id, (tail) => this.#h.planRevert(cut, changeId, { author: this.#actor(opts.author), tail }));
    return this.#mutate(opts.id ? undefined : cut, () => this.#h.revert(cut, changeId, { author: this.#actor(opts.author), ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
  }
  async undo(group?: string, opts: { cut?: string; author?: Actor; id?: ChangeId } = {}) {
    const cut = opts.cut ?? this.#h.current;
    const actor = this.#actor(opts.author);
    if (this.#isShared(cut)) return this.#planShared(cut, opts.id, (tail) => this.#h.planUndo(cut, group ?? groupOf(actor), { author: actor, tail }));
    return this.#mutate(opts.id ? undefined : cut, () => this.#h.undo(cut, group ?? groupOf(actor), { author: actor, ...(opts.id ? { id: opts.id } : {}) }), { idempotent: !!opts.id, ...(opts.id ? { id: opts.id } : {}) });
  }

  // ------------------------------------------------------------ retention (§5.4)
  /**
   * Changes are kept forever; compaction is optional. An auto-version (PLAN §0.1: a save batch, a Director turn) is a run
   * of consecutive changes by one actor group and turn; its micro-changes are squashed into its last change, which then
   * holds their combined effect and remap. Never squashed, and each ending a run: named, fold, export and Published
   * versions, undo / revert / restore changes and what they undid, fork points, folded-in versions, pinned versions, and
   * the last K changes. Only local cuts (a shared cut's rows are its server's). Seqs and ids stay, so refs, dedup and
   * credits keep working; a squashed version leaves the log and its state is no longer held ("state unknown").
   */
  async compact(opts: { cut?: string; olderThanDays?: number } = {}): Promise<{ squashed: number }> {
    let squashed = 0;
    const plan: StoreWrite[] = [];
    await this.#mutate(
      undefined,
      () => {
        plan.length = 0;
        squashed = 0;
        const cutoff = (this.#opts.clock?.() ?? Date.now()) - (opts.olderThanDays ?? 90) * 864e5;
        for (const rec of this.#h.cuts()) {
          if ((opts.cut && rec.id !== opts.cut) || rec.sequencer.kind !== "local" || rec.tracking || rec.shallow || rec.kind === "published") continue;
          squashed += this.#compactCut(rec.id, cutoff, plan);
        }
      },
      { extra: () => ({ writes: plan }), idempotent: true },
    );
    if (squashed) {
      // rows were rewritten, not appended: History is rebuilt from the store, behind every other write
      const p = this.#queue.then(() => this.#rebuild());
      this.#queue = p.catch(() => {});
      await p;
    }
    return { squashed };
  }
  #compactCut(cut: string, cutoff: number, writes: StoreWrite[]): number {
    const h = this.#h;
    const log = h.changes(cut);
    const keep = new Set<number>();
    const seqOf = new Map(log.map((c) => [c.id, c.seq]));
    for (const c of log) {
      if (c.kind && c.kind !== "edit") keep.add(c.seq); // undo, revert, restore, fold, partial revert
      for (const id of Array.isArray(c.reverts) ? c.reverts : c.reverts ? [c.reverts] : []) if (seqOf.has(id)) keep.add(seqOf.get(id)!);
    }
    for (const other of h.cuts()) {
      if (other.forkOf) {
        const f = parseNode(h.canon(other.forkOf));
        if (f.branchId === cut) keep.add(f.seq);
      }
      for (const c of h.changes(other.id)) if (c.mergeOf?.branchId === cut) keep.add(c.mergeOf.seq);
    }
    for (const p of h.pinRows()) if (p.branchId === cut) keep.add(p.seq);
    const last = log.length - (this.#opts.keyframeEvery ?? 64);
    let n = 0;
    let run: ConfirmedChange[] = [];
    const flush = () => {
      if (run.length >= 2) n += this.#squash(cut, run, writes);
      run = [];
    };
    for (const c of log.slice(0, Math.max(0, last))) {
      if (c.squashedInto) continue; // already squashed: transparent inside a run
      const eligible = c.at < cutoff && !keep.has(c.seq) && !h.milestone(nodeId(cut, c.seq)) && !c.mergeOf;
      if (!eligible) {
        flush();
        continue;
      }
      const p = run[run.length - 1];
      if (p && (groupOf(p.author) !== groupOf(c.author) || p.author.turn !== c.author.turn)) flush();
      run.push(c);
    }
    flush();
    return n;
  }
  /** One auto-version's changes squashed into its last: that one gets their combined ops and remap, the rest none. */
  #squash(cut: string, run: readonly ConfirmedChange[], writes: StoreWrite[]): number {
    const h = this.#h;
    const lastRow = run[run.length - 1]!;
    const from = run[0]!.squashedFrom ?? run[0]!.seq;
    const before = h.stateOf(nodeId(cut, from - 1)),
      after = h.stateOf(nodeId(cut, lastRow.seq));
    if (!before || !after) return 0;
    const maps = E.composeMaps(...run.map((c) => c.intent?.maps));
    writes.push({ table: T.changes, key: [cut, lastRow.seq], value: { ...lastRow, ops: E.diff(before, after, this.schema), intent: E.isEmptyMap(maps) ? null : { maps }, kinds: null, squashedFrom: from } });
    let n = 0;
    for (const c of h.changes(cut).slice(from - 1, lastRow.seq - 1)) {
      // rows squashed earlier point at this run's last change now; their keyframes go (their states are gone)
      writes.push({ table: T.changes, key: [cut, c.seq], value: { ...c, ops: [], intent: null, kinds: null, squashedInto: lastRow.seq } }, { table: T.keyframes, key: [cut, c.seq], value: undefined });
      if (!c.squashedInto) n++;
    }
    return n;
  }

  // ------------------------------------------------------------ .cbproj (§13)
  async exportShallow(opts: { cut?: string; to?: string } = {}): Promise<ShallowExport> {
    const cut = opts.cut ?? this.#h.current;
    let pkg!: ShallowExport;
    await this.#mutate(cut, () => (pkg = this.#h.exportShallow(cut, { ...(opts.to ? { to: opts.to } : {}) })), {
      // the export node is part of the lineage graph from now on (R4-01): persist it, one key per export
      extra: () => {
        const made = this.#h.knowledge().exports.find(([n]) => n === pkg.head)?.[1].at(-1);
        // an exported version keeps a keyframe (§5.4): a later fold of the copy comes back to it
        const { branchId, seq } = parseNode(pkg.head);
        const doc = seq > 0 && branchId === cut ? this.#h.stateOf(pkg.head) : null;
        return { writes: [...(made ? [{ table: T.meta, key: ["export", pkg.head, made.at, randomHex(4)], value: made }] : []), ...(doc ? [{ table: T.keyframes, key: [branchId, seq], value: doc }] : [])] };
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
  /** (Carton.open) The queue of every shared cut, with this store's pending edits re-queued. */
  async initShared(): Promise<void> {
    for (const c of this.#h.cuts()) if (this.#isShared(c.id)) await this.#ensureShared(c.id);
  }
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
      client: { adoptPayload: () => this.#adoptPayload(cut), ...(sync.blobs ? { blobs: sync.blobs } : {}), ...(sync.maxMessageBytes ? { maxMessageBytes: sync.maxMessageBytes } : {}) },
    });
    this.#shared.set(cut, sc);
    // edits an earlier session queued and the server never answered: back in the queue in their queue order. Each row
    // holds its latest version's ops, relative to the stored confirmed head plus the rows before it (rewritten at every
    // settlement), so re-queuing them in order rebuilds the same optimistic state
    const pending = (await this.store.range<PendingRow>(T.pending, { prefix: [cut] })).map((e) => e.value).sort((x, y) => x.order - y.order);
    for (const p of pending) {
      if (this.#h.confirmedById(p.id) || sc.queue.pending(cut).some((q) => q.id === p.id)) continue;
      this.#authors.set(p.id, p.author);
      sc.commit({ id: p.id, author: p.author, ops: p.ops, at: p.at, intent: p.intent, kinds: p.kinds, policy: p.policy, inferIntent: false, ...(p.history ? { history: p.history } : {}) });
    }
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
  /**
   * §5.3 hand-off: the rows the server adopts, keyed (cut, n, stateHash@n), and the ancestry closure, shallow (lineage,
   * fork, merge and export states, last authors). A name given to a version after the fact lives in this store's
   * names table: it goes up on its row, so a teammate who joins sees it in the log.
   */
  #adoptPayload(cut: string) {
    const rec = this.#h.cut(cut)!;
    const n = rec.sequencer.kind === "handingOff" ? rec.sequencer.n : this.#h.headSeq(cut);
    const names = new Map(this.#h.names());
    const rows = this.#h.changes(cut).slice(0, n).map((r) => {
      const name = names.get(nodeId(cut, r.seq))?.name;
      return name && r.name !== name ? { ...r, name } : r;
    });
    return { rows, rec, doc0: this.#h.stateOf(nodeId(cut, 0))!, closure: this.#h.closure(cut, n) };
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
    }
    void this.#settle(cut, e);
    if (e.type !== "error") this.#fetchHistory(cut);
  }
  /**
   * Confirmed rows go into the store and then History, pending rows are rewritten from the queue, late conflicts
   * become notices, and a finished hand-off is recorded on the cut; serialized behind every other write of this
   * handle. A write that fails leaves History where the store is, and the next event settles again.
   */
  #settle(cut: string, e: SharedCutEvent): Promise<void> {
    // after every pending row still being written, checked again after each wait (a write that starts while the
    // settle waits, of a change confirmed meanwhile, counts too): a change settled at once (refused before it was sent)
    // must find its author there, and no row may land after the settle rewrote or removed it (it would come back
    // pending). A few rounds at most, so a burst of commits can't hold the settle back for good: a later settle
    // rewrites the pending rows again anyway.
    const run = async () => {
      const waited = new Set<Promise<unknown>>();
      for (let round = 0; round < 8; round++) {
        const busy = [...this.#inflight.values()].filter((w) => !waited.has(w));
        if (!busy.length) break;
        for (const w of busy) waited.add(w);
        await Promise.allSettled(busy);
      }
      return this.#settleShared(cut, e);
    };
    return (this.#queue = this.#queue.then(run, run).catch((err: unknown) => {
      this.#emit({ type: "notice", notice: { to: actorKey(this.#actor()), kind: "rejected", text: `couldn't save what the server confirmed (it is retried): ${String(err)}` } });
    }));
  }
  async #settleShared(cut: string, e: SharedCutEvent): Promise<void> {
    const sc = this.#shared.get(cut);
    if (!sc || this.#closed || this.#fenced) return;
    const q = sc.queue;
    const writes: StoreWrite[] = [];
    // rows the server confirmed (ours and others'), up to the first stretch known only through a keyframe
    const rows = q.rows(cut);
    const fresh: ConfirmedChange[] = [];
    const filled = this.#filled.get(cut);
    for (let i = this.#h.headSeq(cut); i < rows.length; i++) {
      const r = rows[i]!;
      // a stretch known only through a keyframe: the rows a backfill fetched and checked, or stop here
      const f = r.placeholder ? filled?.get(r.seq) : (r as ConfirmedChange);
      if (!f) break;
      fresh.push(f);
    }
    for (const r of fresh) {
      writes.push({ table: T.changes, key: [cut, r.seq], value: r });
      // an id already mapped (to another cut, by misuse) keeps its first mapping: dedup by id is global
      const known = await this.store.get(T.ids, [r.id]);
      if (known === undefined) writes.push({ table: T.ids, key: [r.id], value: [cut, r.seq] });
    }
    // pending rows: exactly the queue's pending changes, each its latest version in queue order
    const stored = await this.store.range<PendingRow>(T.pending, { prefix: [cut] });
    const live = q.pending(cut);
    const liveIds = new Set(live.map((p) => p.id));
    for (const r of stored) if (!liveIds.has(r.value.id)) writes.push({ table: T.pending, key: r.key, value: undefined });
    live.forEach((p, order) => writes.push({ table: T.pending, key: [cut, p.id], value: pendingRow(p, order) }));
    // a pending change that came back with cards after its write had returned (a late conflict, §6.2), or that the
    // server refused: a notice for its author, in the same batch, returned at the start of that actor's next cb/MCP
    // result and by the Stop hook
    const notices: Notice[] = [];
    const authorOf = (id: string) => this.#authors.get(id) ?? stored.find((r) => r.value.id === id)?.value.author ?? this.#h.findChange(id)?.author ?? this.#actor();
    const late = e.type === "confirmed" ? e.lateCards : e.type === "absorbed" ? e.cards : [];
    if (late.length && (e.type === "confirmed" || e.type === "absorbed")) notices.push({ to: actorKey(authorOf(e.id)), kind: "late-conflict", text: `Your change ${e.id} conflicted after it was made: ${late.map((c) => c.path).join(", ")} kept the other side's value`, change: e.id, cards: late });
    // refused for good (validation, or "too large" before it was sent): its author is told, not this handle's actor
    if (e.type === "rejected") notices.push({ to: actorKey(authorOf(e.id)), kind: "rejected", text: `Your change ${e.id} wasn't saved: ${e.reason === "too large" ? "it is larger than the server accepts; the edits after it still went through" : e.reason}`, change: e.id });
    const at = this.#opts.clock?.() ?? Date.now();
    notices.forEach((n, i) => writes.push({ table: T.notices, key: [n.to, at, i, randomHex(4)], value: { ...n, at } }));
    // the hand-off finished (handingOff → server{since}): the cut's record says so from now on
    const qs = q.branch(cut).sequencer;
    const rec = this.#h.cut(cut)!;
    const handed = E.canonical(qs) !== E.canonical(rec.sequencer) ? { ...rec, sequencer: qs } : null;
    if (handed) writes.push({ table: T.cuts, key: [cut], value: handed });
    // the store first: History only moves to what is saved. Under the holder's fence: a holder the lease has moved on
    // from records nothing more, reloads what the store holds and stops; its replacement settles the same answers once
    if (writes.length && !(await this.store.write(writes, this.#settleConds))) {
      // Its queues already dropped outcomes it couldn't record: they go too, and a later connect (this handle under a
      // new nonce) builds them again from the store, whose pending rows are pushed again and answered once more
      this.#fenced = true;
      this.#connected = null;
      await this.#rebuild();
      for (const s of this.#shared.values()) {
        await s.disconnect();
        s.close();
      }
      this.#shared.clear();
      this.#rq = null;
      this.#emit({ type: "sync", status: "stopped", waiting: 0 });
      return;
    }
    if (fresh.length) {
      this.#h.load(cut, fresh);
      // keyframes for rows the server confirmed: a write of their own (a lost one only means a longer replay at open)
      const k = this.#keyframeWrites(cut, fresh);
      if (k.writes.length && (await this.store.write(k.writes, this.#settleConds))) this.#kf.set(cut, k.next);
    }
    if (filled) for (const r of fresh) filled.delete(r.seq);
    if (handed) this.#h.updateCut(cut, { sequencer: qs });
    if (e.type === "confirmed" || e.type === "absorbed" || e.type === "rejected") this.#authors.delete(e.id);
    for (const r of fresh) this.#emit({ type: "change", branchId: cut, seq: r.seq, change: r, local: r.id.startsWith(this.#rid + ".") });
    for (const n of notices) this.#emit({ type: "notice", notice: n });
  }
  /**
   * History a connection makes available (Stage F): a joined cut's lineage (F2) and the rows a keyframe catch-up
   * jumped over (F3). One fetch per cut at a time; one that fails (offline) is tried again on the next sync event.
   */
  #fetchHistory(cut: string): void {
    if (this.#closed || this.#fetching.has(cut) || !(this.#joining.has(cut) || this.#gap(cut))) return;
    const run = (async () => {
      try {
        if (this.#joining.has(cut)) await this.#joinLineage(cut);
        if (this.#gap(cut)) await this.#backfill(cut);
      } catch {
        // not connected, or the server couldn't answer: the next event tries again
      } finally {
        this.#fetching.delete(cut);
      }
    })();
    this.#fetching.set(cut, run);
  }
  /** The first stretch of placeholders (rows known only through a keyframe) above History's head: (lo, hi]. */
  #gap(cut: string): { lo: number; hi: number } | null {
    const q = this.#shared.get(cut)?.queue;
    if (!q) return null;
    const rows = q.rows(cut);
    let i = this.#h.headSeq(cut);
    while (i < rows.length && !rows[i]!.placeholder) i++;
    if (i >= rows.length) return null;
    let hi = i;
    while (hi < rows.length && rows[hi]!.placeholder) hi++;
    return { lo: i, hi };
  }
  /** F2: a joined cut's ancestry closure from its server, kept as tracking knowledge; a fork gets its fork point. */
  async #joinLineage(cut: string): Promise<void> {
    const sc = this.#shared.get(cut)!;
    const j = await this.store.get<{ forkOf: NodeId | null }>(T.meta, ["join", cut]);
    if (j) {
      const { lineage = [] } = await sc.history(0, 0, { lineage: true });
      let prior!: ReturnType<History["knowledge"]>, before!: Set<string>;
      await this.#mutate(
        undefined,
        () => {
          prior = this.#h.knowledge();
          before = new Set(this.#h.cuts().map((c) => c.id));
          this.#h.loadClosure(lineage);
        },
        {
          extra: () => {
            const w = this.#knowledgeWrites(this.#h, prior);
            for (const c of this.#h.cuts()) if (!before.has(c.id)) w.push({ table: T.cuts, key: [c.id], value: c });
            if (j.forkOf) w.push({ table: T.cuts, key: [cut], value: { ...this.#h.cut(cut)!, forkOf: j.forkOf } });
            w.push({ table: T.meta, key: ["join", cut], value: undefined });
            return { writes: w };
          },
          idempotent: true,
        },
      );
      // the cut's record changed shape (its fork point): History is rebuilt from the store, behind every other write
      if (j.forkOf) {
        const p = this.#queue.then(() => this.#rebuild());
        this.#queue = p.catch(() => {});
        await p;
      }
    }
    this.#joining.delete(cut);
  }
  /**
   * F3: the rows of a stretch a keyframe catch-up jumped, from the server. They are checked to rebuild the keyframe's
   * state exactly (its hash), then stored and loaded into History by the next settlement like any confirmed rows, so
   * log, credits and diff work across the stretch.
   */
  async #backfill(cut: string): Promise<void> {
    const sc = this.#shared.get(cut)!;
    const gap = this.#gap(cut)!;
    const { rows } = await sc.history(gap.lo, gap.hi);
    let doc = E.fork(sc.queue.confirmedState(cut, gap.lo), this.schema);
    rows.forEach((r, i) => {
      if (r.seq !== gap.lo + 1 + i) throw new Error(`backfill: row ${r.seq} where ${gap.lo + 1 + i} was expected`);
      doc = E.apply(doc, r.ops, this.schema);
    });
    if (rows.length !== gap.hi - gap.lo || E.hashDoc(doc, this.schema) !== E.hashDoc(sc.queue.confirmedState(cut, gap.hi), this.schema)) throw new Error("backfill: the rows don't rebuild the keyframe");
    const m = this.#filled.get(cut) ?? this.#filled.set(cut, new Map()).get(cut)!;
    for (const r of rows) m.set(r.seq, r);
    await this.#settle(cut, { type: "remote", rows: [] });
  }
  /** Everything a shared write reads first: the cut's queue, the stored rows, other processes' ids, the caller's fence. */
  async #prepShared(cut: string, id: ChangeId, conditions: readonly StoreCondition[] = []): Promise<{ sc: SharedCut; done: CommitResult | null }> {
    // the sequencer binds the part before the first dot to the device that first pushed it (§6.3): refuse here what it
    // would refuse later, after the edit had shown as pending
    if (id.indexOf(".") < 1) throw new Error(`Carton: change id "${id}" isn't \`<rid>.<n>\`; a shared cut's sequencer refuses it`);
    const sc = await this.#ensureShared(cut);
    await this.#queue;
    await this.#refresh(); // every cut: an id another process confirmed anywhere is known before this one is used
    await this.#noopOf(id);
    const mapped = await this.store.get<[string, number]>(T.ids, [id]);
    if (mapped && !this.#h.findChange(id)) await this.#rebuild();
    if (this.#h.headSeq(cut) < sc.queue.headSeq(cut)) await this.#settleShared(cut, { type: "remote", rows: [] });
    this.#feedQueue(cut);
    const done = this.#h.confirmedById(id);
    if (done) return { sc, done };
    if (sc.queue.pending(cut).some((p) => p.id === id)) return { sc, done: { status: "pending", id, ref: this.#sharedRef(cut), notices: [] } };
    // a lease fence (or any caller condition) must hold before the edit enters the queue (§6.2 fencing)
    if (conditions.length && !(await this.store.write([], conditions))) throw new Error("Carton: the store changed under this write (a condition failed)");
    return { sc, done: null };
  }
  /** Queue a change synchronously (nothing may run between computing `ops` on the optimistic state and this). */
  #enqueue(sc: SharedCut, cut: string, id: ChangeId, author: Actor, ops: Op[], input: Pick<CommitInput, "policy" | "intent" | "kinds" | "name">, history?: HistoryFields): CommitResult {
    const hist: HistoryFields | undefined = history ?? (input.name ? { name: input.name } : undefined);
    const at = this.#opts.clock?.() ?? Date.now();
    this.#authors.set(id, author);
    const r = sc.commit({ id, author, ops, at, ...(input.policy ? { policy: input.policy } : {}), ...(input.intent ? { intent: input.intent } : {}), ...(input.kinds ? { kinds: input.kinds } : {}), ...(hist ? { history: hist } : {}) });
    if (r.status === "confirmed") {
      // nothing to record: the id is spent anyway (`#persistEnqueued` records it), named at the version History holds
      this.#authors.delete(id);
      const seq = this.#h.headSeq(cut);
      return { status: "confirmed", seq, ref: { branchId: cut, seq, pending: [] }, change: null, empty: true, rebased: 0, notices: [] };
    }
    return { status: "pending", id, ref: this.#sharedRef(cut), notices: [] };
  }
  /** Keep what `#enqueue` did: the pending row (in queue order), or the spent id of an empty write. */
  async #persistEnqueued(sc: SharedCut, cut: string, id: ChangeId, r: CommitResult, wait?: number, also: readonly ChangeId[] = [], extra: StoreWrite[] = []): Promise<CommitResult> {
    if (r.status === "confirmed") {
      // a no-op only if nobody answered this id meanwhile (a holder that replaced this one: the lease conditions), so a
      // retry answers empty and never applies the edit later over someone else's; otherwise the store's answer is it
      const ok = await this.store.write([{ table: T.meta, key: ["noop", id], value: [cut, r.seq] }, ...extra], [
        { table: T.meta, key: ["noop", id], expect: "absent" },
        { table: T.ids, key: [id], expect: "absent" },
        { table: T.pending, key: [cut, id], expect: "absent" },
        ...this.#settleConds,
      ]);
      if (!ok) {
        await this.#refresh();
        await this.#noopOf(id);
        const won = this.#h.confirmedById(id);
        if (won) return won;
        if (await this.store.get(T.pending, [cut, id])) return { status: "pending", id, ref: this.#sharedRef(cut), notices: [] };
        throw new Error("Carton: the store changed under this write (the sync lease moved to another holder)");
      }
      this.#h.noteNoop(id, cut, r.seq);
      // the answer its retry gets too (the same version)
      return this.#h.confirmedById(id)!;
    }
    // every id given goes into the store in one write (a fold-some's fold and inverse are kept together, or neither)
    const writes: StoreWrite[] = [];
    sc.queue.pending(cut).forEach((p, order) => (p.id === id || also.includes(p.id)) && writes.push({ table: T.pending, key: [cut, p.id], value: pendingRow(p, order) }));
    // started before anything can settle it: a settle waits for #inflight
    if (writes.length || extra.length) {
      const w = this.store.write([...writes, ...extra]);
      const ids = [id, ...also];
      for (const x of ids) this.#inflight.set(x, w);
      try {
        await w;
      } finally {
        for (const x of ids) if (this.#inflight.get(x) === w) this.#inflight.delete(x);
      }
    }
    if (!wait) return r;
    const o = await sc.waitFor(id, wait);
    // a confirmation is answered once History holds the row (the result carries the change)
    if (o.status === "confirmed") await this.#settle(cut, { type: "remote", rows: [] });
    return this.#outcome(cut, o);
  }
  async #commitShared(cut: string, input: CommitInput, author: Actor, id: ChangeId): Promise<CommitResult> {
    const { sc, done } = await this.#prepShared(cut, id, input.conditions ?? []);
    if (done) return done;
    // from here to the enqueue, nothing awaits: the optimistic state the ops are made on is the one they join
    const opt = sc.queue.optimistic(cut).doc;
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
    // `undoOf` (cb undo --turn through a save): the change records what it undoes, as on a local cut
    const r = this.#enqueue(sc, cut, id, author, ops, input, input.undoOf?.length ? { kind: "undo", reverts: [...input.undoOf], ...(input.name ? { name: input.name } : {}) } : undefined);
    const cardWrites = resolved.length && input.cardsWrite ? input.cardsWrite(resolved, null) : [];
    const out = await this.#persistEnqueued(sc, cut, id, r, input.wait, [], cardWrites);
    return resolved.length && (out.status === "pending" || out.status === "confirmed") ? { ...out, resolved } : out;
  }
  #outcome(cut: string, o: WriteOutcome): CommitResult {
    if (o.status === "confirmed") return { status: "confirmed", seq: o.seq, ref: { branchId: cut, seq: o.seq, pending: [] }, change: this.#h.findChange(o.id), rebased: 0, notices: [] };
    if (o.status === "conflicts") return { status: "conflicts", cards: o.cards, ref: this.#sharedRef(cut) };
    if (o.status === "rejected") return { status: "rejected", reason: o.reason };
    // spent with no effect of its own (an identical edit was already there): saved, in effect, with nothing to record
    if (o.status === "absorbed") return { status: "confirmed", seq: o.seq, ref: { branchId: cut, seq: o.seq, pending: [] }, change: null, empty: true, rebased: 0, notices: [] };
    return { status: "pending", id: o.id, ref: this.#sharedRef(cut), notices: [] };
  }
  async share(cut: string = this.#h.current): Promise<CutRecord> {
    if (!this.#opts.sync) throw new Error("Carton.share: open Carton with `sync` (transport, url, token) to share a cut");
    if (!this.#isShared(cut)) {
      let was!: CutRecord, rec!: CutRecord, n = 0;
      await this.#mutate(
        undefined,
        () => {
          was = this.#h.cut(cut)!;
          n = this.#h.headSeq(cut);
          // from now on local commits on it are pending, never confirmed, so no local seq after n can collide (§5.3)
          rec = this.#h.updateCut(cut, { sequencer: { kind: "handingOff", n, stateHash: this.#h.hashOf(nodeId(cut, n))! } });
        },
        // the record we read is the stored one, and nothing was appended after n: a local edit another process confirmed
        // meanwhile makes this write fail (and retry on the new n), so the server never adopts a log missing it
        { extra: () => ({ writes: [{ table: T.cuts, key: [cut], value: rec }], conds: [{ table: T.cuts, key: [cut], expect: { equals: was } }, { table: T.changes, key: [cut, n + 1], expect: "absent" }] }), idempotent: true },
      );
    }
    await this.#ensureShared(cut);
    return this.#h.cut(cut)!;
  }
  /**
   * Folds onto a shared cut: History computes the fold on the confirmed head, the SharedCut queues it as a fold. With
   * `reject` (fold-some), the inverse of the rejected paths is queued right after it as `<id>.inverse`.
   */
  async #foldShared(into: string, from: string | StateRef, opts: FoldOptions & { reject?: PathKey[] }): Promise<FoldResult & { preview?: FoldPreview }> {
    const id = opts.id ?? `${this.#rid}.${++this.#n}`;
    const inverse = opts.reject ? `${id}.inverse` : null;
    const { sc, done } = await this.#prepShared(into, inverse ?? id);
    if (done && opts.id) return done;
    // from the pending check to the enqueue nothing awaits, so no edit can slip in between the fold and its queuing
    const waiting = sc.queue.pending(into).length;
    if (waiting && !opts.check) throw new Error(`Carton.fold: ${waiting} edit${waiting === 1 ? "" : "s"} waiting to sync on this cut; fold once it is up to date`);
    const author = this.#actor(opts.author);
    const y = this.#foldable(from);
    const some = opts.reject ? this.#h.planFoldSome(into, y, { ...opts, reject: opts.reject, author }) : null;
    if (some && !("reject" in some)) {
      const { merge: _m, base: _b, doc: _d, retry: _r, ...out } = some as FoldResult & { merge?: unknown; base?: unknown; doc?: unknown; retry?: unknown };
      return out as FoldResult;
    }
    const r = some ? some.dry : this.#h.fold(into, y, { ...opts, check: true, author });
    const { merge, base, doc, retry: _r, ...out } = r;
    if (r.status !== "confirmed" || !doc) return out as FoldResult;
    const ours = this.#h.stateOf(this.#h.head(into))!;
    const ops = E.diff(ours, doc, this.schema);
    if (opts.check) return { ...(out as FoldResult), preview: { ops, describe: E.describe(ops, ours, this.schema), warnings: merge?.warnings ?? [] } };
    // the fold's DAG fields travel with the change (the queue keeps them through rebases), and so do the authors of
    // what it brings in: credits name who made a record on the cut folded in, not who folded
    const history: HistoryFields = {
      kind: "merge",
      mergeOf: parseNode(this.#h.canon(y)),
      mergeEdges: merge ? { first: merge.edges.ours, second: merge.edges.theirs } : { first: {}, second: {} },
      mergeBase: base?.node ? [base.node] : base?.nodes ?? [],
      lastAuthors: this.#h.authorsFrom(ops, y, author),
    };
    const res = this.#enqueue(sc, into, id, author, ops, {}, history);
    if (!some) return this.#persistEnqueued(sc, into, id, res);
    const inv = this.#enqueue(sc, into, inverse!, author, some.ops, {}, { kind: "partial-revert", rejected: some.reject, reverts: id });
    return this.#persistEnqueued(sc, into, inverse!, inv, undefined, [id]);
  }
  /**
   * Undo, revert and restore on a shared cut: planned on the optimistic state (this replica's pending edits included,
   * so ⌘Z right after an edit undoes it) and queued as an ordinary change with its intent, kind and `reverts` under a
   * stable id: pending, then confirmed or rebased like any edit, and credited to its author.
   */
  async #planShared<R extends object>(cut: string, given: ChangeId | undefined, plan: (tail: Tail) => (Omit<Planned, "extra"> & { extra?: Planned["extra"] } & R) | (CommitResult & { status: "conflicts" }) | null): Promise<CommitResult & Partial<R>> {
    const id = given ?? `${this.#rid}.${++this.#n}`;
    const { sc, done } = await this.#prepShared(cut, id);
    if (done) return done;
    // from the plan to the enqueue nothing awaits: it is made on the state it joins
    const p = plan(this.#tail(cut, sc));
    if (p && "status" in p) return { ...p, ref: this.#sharedRef(cut) };
    // nothing to undo: an empty write, so a retry under the same id stays a no-op
    if (!p) return this.#persistEnqueued(sc, cut, id, this.#enqueue(sc, cut, id, this.#actor(), [], {}));
    const { doc, author, kind, intent, extra, ...rest } = p;
    const ops = E.diff(sc.queue.optimistic(cut).doc, doc, this.schema);
    const r = this.#enqueue(sc, cut, id, author, ops, intent ? { intent } : {}, { kind, ...extra });
    return { ...(await this.#persistEnqueued(sc, cut, id, r)), ...(rest as Partial<R>) };
  }
  /** A shared cut's pending changes as History's newest changes, each with the optimistic state after it. */
  #tail(cut: string, sc: SharedCut): Tail {
    const q = sc.queue;
    let seq = this.#h.headSeq(cut);
    if (q.headSeq(cut) !== seq) throw new Error(`Carton: cut ${this.#h.cut(cut)!.name} is still loading its history from the server; try again once it has caught up`);
    let doc = this.#h.stateOf(this.#h.head(cut))!;
    const rows: ConfirmedChange[] = [],
      states: Doc[] = [];
    for (const p of q.pending(cut)) {
      const v = p.versions[p.versions.length - 1]!;
      if (v.ops.length) doc = E.apply(E.fork(doc, this.schema), v.ops, this.schema);
      rows.push({ ...p.history, id: p.id, author: p.author, branchId: cut, seq: ++seq, ops: v.ops, intent: v.intent, kinds: v.kinds, policy: v.policy, at: p.created } as ConfirmedChange);
      states.push(doc);
    }
    return { rows, states };
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
