// The data model shared by every Carton package: documents, ops, changes, refs, cuts, the merge DAG, conflict cards,
// diffs, undo and the cb status. Formats follow the verified prototypes (core-v5 `engine.mjs`/`history.mjs`,
// system-v11 `store.mjs`/`server.mjs`); PLAN §4, §5, §7, §8, §9.
//
// Names (§0.1): a *version* is a confirmed state (git: commit), a *cut* is a branch, *fold in* is a merge, a
// *conflict card* is a merge conflict, *credits* is blame, *restore* is revert. Code keeps `change`, `sequencer`,
// `pin`, `StateRef` and `seq`, and says `branch` for the sequencer's unit.

import type { TimeEdit, SoftWarning } from "./schema.ts";

// ------------------------------------------------------------------ documents and ops

/**
 * An engine document: root fields plus one array of records per schema collection. Plain JSON.
 *
 * Ownership: `apply` mutates a doc's collection arrays in place but never mutates a record (a changed record is
 * path-copied). `fork(doc)` is the cheap way to get an owned copy. Records are never mutated after they are shared, so
 * callers may keep references to them (the engine caches per-record hashes on that basis).
 */
export type Doc = Record<string, unknown>;
/** One record of a collection, or one element of a keyed array. */
export type Rec = Record<string, unknown>;

/** Path segment: a field name, a record id, or a keyed-array element key. */
export type PathSeg = string | number;
/** `[collection, id, field, ...]` for records, `[rootField, ...]` for root fields. */
export type Path = readonly PathSeg[];
/** `pathKey(path)`: segments joined by `/`, with `~` and `/` escaped as `~0` and `~1` (JSON-pointer style). */
export type PathKey = string;

/** The field that orders a sequence (an ordered collection or keyed array): a fractional-index key (§4.1, M4). */
export const POS = "#pos";

/** Intended neighbours of an insert or move, `[leftId, rightId]`; `pos` is derived from them (R4-05). */
export type Neighbours = readonly [left: PathSeg | null, right: PathSeg | null];

/** Create a record (`[coll, id]`) or a keyed-array element (`[..., arrayField, key]`). */
export interface InsertOp {
  op: "insert";
  path: Path;
  value: unknown;
  nb?: Neighbours;
}
/** Remove a record or element. Removing an absent one is a no-op. */
export interface RemoveOp {
  op: "remove";
  path: Path;
}
/** Set a field. Intermediate objects are created; a set under a missing record is a no-op ("lost to delete"). */
export interface SetOp {
  op: "set";
  path: Path;
  value: unknown;
  nb?: Neighbours;
  /** An order-preserving re-key of `#pos` (a rebalance); never a move, never a card. */
  rk?: true;
}
/** Remove a field. Unsetting an absent path is a no-op. */
export interface UnsetOp {
  op: "unset";
  path: Path;
}
/**
 * A remap intent stored as one op (§6.1, P5): every item on the mapped lanes whose extent maps cleanly moves to its
 * image. Replicas expand it deterministically, so a 200-item ripple is one op and one row, not 200 sets.
 * `path` is the constant `["#remap"]`, so generic path code never mistakes it for a record write.
 */
export interface RemapOp {
  op: "remap";
  path: readonly ["#remap"];
  maps: RemapMaps;
  lineage?: Lineage;
  /** The item ids it moved on the state it was made on (credits and descriptions; apply re-derives them). */
  ids?: string[];
}
export type Op = InsertOp | RemoveOp | SetOp | UnsetOp | RemapOp;

/** Why an op had no effect when applied (§4.4: apply is total). */
export interface ApplyNote {
  op: Op;
  lost: "missing";
}

// ------------------------------------------------------------------ remaps (§7)

/**
 * One step of a piecewise time map, in its input coordinates: `d` deleted ranges `[a, b)` (later times pull left) and
 * `i` inserted gaps `[at, length]` (later times push right), all simultaneous.
 */
export interface RemapStep {
  d: [number, number][];
  i: [number, number][];
}
/** Steps applied in order. */
export type RemapChain = RemapStep[];
/** Per lane: `{trackId: chain}`. */
export type RemapMaps = Record<string, RemapChain>;
/** A split's lineage: old item id -> the ids of its pieces, so the other side's edits follow to every piece. */
export type Lineage = Record<string, string[]>;

/** What a change meant, beyond its ops: recorded by named actions (H7) or inferred at commit when unambiguous (L9). */
export interface Intent {
  /** e.g. `ripple-delete`, `ripple-insert`, `split`, `delete-gaps`, `remove-silences`. */
  kind?: string;
  maps?: RemapMaps;
  lineage?: Lineage;
  /** Inferred from an unrecorded edit (an agent's file save) rather than recorded by a named action. */
  inferred?: boolean;
}

/** Recorded time-group edit kinds per item id (§4.1 "recorded kinds win"). */
export type EditKinds = Record<string, TimeEdit>;

// ------------------------------------------------------------------ declarations and the overlap rule (§6.1)

/**
 * A half-open time interval `[lo, hi)` on one lane that a change's placement or timing touches. `hi: null` is open
 * ended (a remap's `[t0, ∞)`; JSON has no Infinity).
 */
export interface Span {
  track: string;
  lo: number;
  hi: number | null;
  /** The item whose op produced it (null for a remap). */
  item?: string | null;
  /** Produced by an insert, remove, lane change or remap. Spans only conflict when one side is structural. */
  structural?: boolean;
}

/** What a change declares to the sequencer, computed by `declare()` at commit from the base it was made on. */
export interface Declaration {
  /** Every op's path key, plus a group path (`items/X/#time`) per record field group it touches. */
  paths: PathKey[];
  /** Existence reads: the records it sets, the lane it places items on, the `#pos` of insert/move neighbours. */
  reads: PathKey[];
  spans: Span[];
  /** Lanes whose order (`#pos`) it changes. */
  trackOrder: string[];
  /** It inserts or removes an item, changes a lane, or carries a remap. */
  structural?: boolean;
}

/** How two declarations overlap (all absent: they don't). */
export interface Overlap {
  path?: PathKey;
  read?: PathKey;
  span?: { track: string; a: [number, number | null]; b: [number, number | null] };
  order?: string;
}

// ------------------------------------------------------------------ actors (§5.1, §8, §10)

export type ActorKind = "human" | "agent" | "subagent" | "external" | "system";

/**
 * Who made a change, down to the subagent. `group` is the undo group (§8): every local actor on the same machine and OS
 * user (your edits, the agent turns you started, a terminal's `cb`), as `cb undo` and History's Undo see it; a
 * teammate is never in yours. The app's Ctrl+Z sees only the part of it marked `app`, made in the editor's session.
 */
export interface Actor {
  kind: ActorKind;
  id: string;
  name?: string;
  group?: string;
  /**
   * Made from the app: the person at the editor, or an agent turn they started there (an agent the app started, which
   * names it in `CARDBOARD_ACTOR`). Never a terminal's `cb`. The app's Ctrl+Z and redo see only these (UndoScope).
   */
  app?: boolean;
  chat?: string;
  turn?: string;
  agentId?: string;
  agentType?: string;
  provider?: string;
  model?: string;
  /**
   * Told, never recorded: the person behind the replica that made an agent's change (`log`, `credits`), so a teammate's
   * agent can be named as theirs ("Leo's Director"). Absent when no person is known. A commit drops it.
   */
  owner?: { id: string; name: string };
}

/** Stable key of an actor for maps and notices: `kind/id[/agentId]`. */
export type ActorKey = string;

// ------------------------------------------------------------------ changes (§5.1)

/** `<rid>.<n>`: `rid` is a random 96-bit id per process (hex); stable across rebases (dedup is by id). */
export type ChangeId = string;
/** Default "merge" (rejected on overlap, rebased with merge3; the plan also calls this `cas`). `lww` only for plain leaf style edits. */
export type Policy = "merge" | "lww";

export type ChangeKind = "edit" | "merge" | "revert" | "partial-revert" | "restore" | "undo" | "rebalance" | "import" | "external";

/** A change's base: the confirmed seq it was made on plus the author's earlier pending ids (its causal past). */
export interface ChangeBase {
  seq: number;
  pending: ChangeId[];
}

/** A node of one branch, as an object. Serialized as `<branchId>@<seq>` (`NodeId`). */
export interface NodeRef {
  branchId: string;
  seq: number;
}
/** `<branchId>@<seq>`. `(b, 0)` of a forked branch canonicalizes to its fork node. */
export type NodeId = string;

/**
 * A change as made by a replica and pushed to its branch's sequencer. Immutable as created; a rebase keeps `id`,
 * bumps `rebase` and records `supersedes`.
 */
export interface Change extends Declaration {
  id: ChangeId;
  /** SHA-256 hex of canonical `{author, base, ops, intent, mergeOf}`. */
  hash: string;
  author: Actor;
  branchId: string;
  base: ChangeBase;
  ops: Op[];
  intent: Intent | null;
  kinds: EditKinds | null;
  policy: Policy;
  /** Wall-clock ms when made. */
  at: number;
  kind?: ChangeKind;
  rebase?: number;
  supersedes?: ChangeId[];
  /** A fold-in: the node merged into this branch. */
  mergeOf?: NodeRef;
  /** A fold-in's per-parent edge maps (the transform applied to each parent's content), for remaps per lineage edge. */
  mergeEdges?: { first: RemapMaps; second: RemapMaps; lineage?: [Lineage, Lineage] };
  /** The merge base node(s) used (several for a criss-cross's virtual base). */
  mergeBase?: NodeId[];
  /** revert/undo/restore: the change(s) it inverts. */
  reverts?: ChangeId | ChangeId[];
  /** Partial accept: the record paths it rejected ("fold in some of it"). */
  rejected?: PathKey[];
  /** A fold-in: last author per record it touched, so credits survive the merge. */
  lastAuthors?: Record<PathKey, Actor>;
  /** Ops over 1 MB are stored as one blob; `ops` is then empty and this is the blob key (R2-13). */
  blob?: string;
  /** A version name given to the state this change produces ("Sent to client, Monday"). */
  name?: string;
}

/** A change confirmed by its sequencer: a row of the `changes` table. */
export interface ConfirmedChange extends Change {
  seq: number;
  /**
   * Compaction (§5.4): this change now holds the micro-changes from `squashedFrom` up to it, as one change; the
   * changes it holds keep their seq and id but no ops (`squashedInto` names this one) and their versions are gone.
   */
  squashedFrom?: number;
  squashedInto?: number;
  /** A squashed change: the hash of its version's state before it was squashed (its identity in others' lineage). */
  squashedHash?: string;
  /**
   * A shared cut's withdraw row (H1): the server spent the id of an edit a rebase emptied (no ops, authored
   * `{kind: "system", id: "withdraw"}`). It keeps its seq and id, so the id can never land later, but it is never a
   * version: `log()` leaves it out (so History, `cb history`, the Compare and Fold pickers and their counts do), and a
   * `change` event carrying it only moves the head. Its ref names the same state as the seq before it.
   */
  withdrawn?: boolean;
}

/** A pending change in a replica's queue: every version it had (each rebase adds one), newest last. */
export interface PendingChange {
  id: ChangeId;
  author: Actor;
  branchId: string;
  created: number;
  versions: Change[];
  /** Cards its latest rebase raised and resolved provisionally (head's value kept). */
  cards?: ConflictCard[];
}

// ------------------------------------------------------------------ refs and pins (§5.2)

/**
 * A state reference. On a confirmed state `pending` is empty and the ref prints as `main@57`. On a local optimistic
 * state a pin row holds `(branchId, seq, pending ids, stateHash)`, keyed `(branchId, seq, hash8)`, and rebuilding it
 * recomputes and checks the full hash. An unknown, released, expired or mismatching ref is an error ("state unknown:
 * re-print"), never a guess (§4.4, principle 9).
 */
export interface StateRef {
  branchId: string;
  seq: number;
  /** First 8 hex chars of the state hash. */
  hash8?: string;
  hash?: string;
  pending?: ChangeId[];
}

/**
 * The header Carton writes into printed files:
 * `// cardboard:rev main@57~3f9a1c0e b:<branchId8> p:<printNonce> by <actor>`. A bare 13-digit number is a 1.4.0
 * timestamp rev (parses, but has no Carton state).
 */
export interface RefHeader {
  name: string;
  seq: number;
  hash8: string;
  branch8: string;
  printNonce?: string;
  by?: string;
}

/** One owner of a pin: a turn, a view, or an MCP ref. The row is released when its last owner releases or expires. */
export interface PinOwner {
  owner: string;
  /** ms epoch; agent pins end with their turn, MCP refs after 7 days. null: no expiry (until released). */
  expires: number | null;
}

export interface PinRow {
  branchId: string;
  seq: number;
  hash8: string;
  hash: string;
  /** The causal past a commit on this pin builds on. */
  pending: ChangeId[];
  /** Ops on top of the confirmed state at `seq`: the pending changes' ops, or a held state's delta (a freeze view). */
  delta: Op[];
  owners: PinOwner[];
}

/** Thrown when a ref can't be reconstructed exactly. `code` is always `STATE_UNKNOWN`. */
export interface StateUnknownError extends Error {
  code: "STATE_UNKNOWN";
  ref: unknown;
}

// ------------------------------------------------------------------ cuts, versions and the DAG (§5.3, §5.4, §13)

/** Who sequences a branch: this replica's store, a hand-off in progress, or a server (§5.3 state machine). */
export type SequencerState =
  | { kind: "local"; storeId?: string }
  | { kind: "handingOff"; n: number; stateHash: string }
  | { kind: "server"; url?: string; since: number };

export type CutKind = "main" | "variant" | "director" | "offline" | "published";

/**
 * A cut (branch record). `id` is a global id; `name` is only shown to people (two cuts may both be "Main cut").
 * A replica writes only to cuts it sequences or to shared cuts through their server; imported cuts are `tracking`
 * (read-only). `shallow` cuts hold only lineage nodes and carried states, not a log.
 */
export interface CutRecord {
  id: string;
  name: string;
  forkOf: NodeId | null;
  owner: string;
  kind: CutKind;
  protected?: boolean;
  tracking?: boolean;
  shallow?: boolean;
  sequencer: SequencerState;
  /** ms epoch of creation. */
  at?: number;
  /** A Published cut: the cut it was published from (its fork node alone can't say: a fork node is canonical). */
  source?: string;
}

/** A version: a confirmed state, optionally named. `ref` prints as `main@57`. */
export interface Version {
  ref: StateRef;
  /** Full state hash, when already known (the head, named versions); `hashOf(ref)` computes any other. */
  hash?: string;
  change: ChangeId | null;
  /** Who: the generic person told by person where known (Carton.setIdentity), the actor as recorded in `authoredAs`. */
  author: Actor | null;
  authoredAs?: Actor;
  at: number;
  name?: string;
  kind: ChangeKind | "root" | "fork";
  /**
   * What the version did in one line, when asked for (`log({summary: true})`): its name; a fold, a partial fold ("Folded
   * 'Client review' into 'Main cut': 2 of 3 changes"), the rest of one, a restore or the import by what it was; else
   * its change, or its changes summed up ("Moved 'a', changed 'b' and 'c'", `describeVersion`).
   */
  summary?: string;
  /**
   * A cut's start (seq 0) with nothing in it: the empty root an imported project's history starts from (§16), or a cut
   * made from it. `restore` and `fork` refuse it (`EmptyVersion`), so a UI doesn't offer them.
   */
  blank?: true;
  /** Every change the version made, one line each (describe()), when the summary doesn't already say it all. */
  details?: string[];
  /**
   * A partial fold ("fold in some of it"): what it left out, by path. Its fold and the partial revert after it are one
   * version (UI audit P1-3), of kind `merge`; `change` is the partial revert's id, which "fold in the rest" reverts.
   */
  rejected?: PathKey[];
  /**
   * How many changes a partial fold left out, counted as History, the Fold dialog and Compare count them: a record each,
   * a split one (`countChanges`). With `rejected`.
   */
  leftOutChanges?: number;
  /**
   * "Fold in the rest" of a partial fold (a `revert` of its partial revert): that partial fold's `change`. A list marks
   * it as the fold it is, not as an undo (final re-check, baseline P3-12b). Its undo and the redo of that have none.
   */
  restOf?: ChangeId;
  /**
   * A redo (a `revert` of an undo change): the undo it takes back. A list shows it as a redo, as it shows an undo as an
   * undo (laptop: `cb history` listed it as `revert`). Set by `Carton.log()`.
   */
  redoOf?: ChangeId;
}

export type LineageKind = "head" | "root" | "fork" | "merge" | "export" | "import";

/**
 * A node of the lineage graph carried by shallow `.cbproj` exports (§13): fork, merge, export, root and head nodes.
 * Each parent edge carries the composed remap along it (a merge node: one edge map per parent).
 */
export interface DagNode {
  id: NodeId;
  branchId: string;
  seq: number;
  hash: string;
  kinds: LineageKind[];
  parents: { id: NodeId; remap: RemapMaps; lineage?: Lineage }[];
  owner?: string;
  branchName?: string;
}

/** A shallow export (`carton-shallow/1`): the head state, its lineage graph and the states of its fork, merge and
 * export nodes (delta-encoded against the head), plus the last author per record. No history, no local tables. */
export interface ShallowExport {
  format: "carton-shallow/1";
  projectId: string;
  sender: string;
  head: NodeId;
  headHash: string;
  branches: Record<string, { name: string; owner?: string }>;
  nodes: DagNode[];
  states: Record<string, { doc: Doc } | { delta: Op[] }>;
  lastAuthor: Record<PathKey, Actor>;
}

/** A full-history export (`carton-full/1`): every cut's log, with the local tables dropped. */
export interface FullExport {
  format: "carton-full/1";
  projectId: string;
  /** `by`: who made the cut (a fork), its fork version's author; absent when not known. */
  branches: { id: string; name: string; forkOf: NodeId | null; owner: string; root: Doc | null; log: ConfirmedChange[]; by?: Actor }[];
}

// ------------------------------------------------------------------ merge, conflict cards (§7)

export type ConflictKind = "parent" | "record" | "invalid" | "remap" | "group" | "text" | "field" | "order" | "compare";

/** A diff3 hunk of a `text` field that both sides changed in overlapping or adjacent lines. */
export interface TextHunk {
  at: number;
  base: string;
  ours: string;
  theirs: string;
}

/**
 * A conflict card: both edits kept as data, nothing lost. `path` is the card's root (a field, a record, or a group
 * path `items/X/#time`); `related` lists the other paths decided with it.
 */
export interface ConflictCard {
  kind: ConflictKind;
  path: PathKey;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  reason?: string;
  hunks?: TextHunk[];
  related?: PathKey[];
  /** compare2 cards: the ops that take `theirs`. */
  ops?: Op[];
}

/**
 * A card's resolution: one side, the base, or a value (a group card takes `{field: value}`). "Keep both" is the
 * host adapter's to express (Cardboard: a new track or `alternatives`), as a value or extra ops.
 */
export type Choice = "ours" | "theirs" | "base" | { value: unknown };
/** By card index, or by card path. */
export type Choices = Choice[] | Record<PathKey, Choice> | ((card: ConflictCard, index: number) => Choice);

/** The result of `merge3(base, ours, theirs)`. `doc` holds every card provisionally on `prefer`'s side. */
export interface MergeResult {
  doc: Doc;
  conflicts: ConflictCard[];
  warnings: SoftWarning[];
  remaps: { ours: RemapMaps; theirs: RemapMaps; inferred: [boolean, boolean] };
  /** Each side's edge map: the other side's remaps expressed in that side's coordinates. */
  edges: { ours: RemapMaps; theirs: RemapMaps };
  stats: { ours: number; theirs: number; composed: PathKey[]; mapped: PathKey[]; followed: number };
  /** The ops that turn `ours` into `doc` (computed on first use). */
  readonly ops: Op[];
}

export interface MergeOptions {
  /** Provisional side of every card (default "ours"). */
  prefer?: "ours" | "theirs";
  /** Recorded remaps since base, per side. A side without one is inferred when unambiguous unless `infer: false`. */
  remaps?: { ours?: { maps: RemapMaps; lineage?: Lineage }; theirs?: { maps: RemapMaps; lineage?: Lineage } };
  infer?: boolean;
  /** Recorded time-group edit kinds per side. */
  kinds?: { ours?: EditKinds; theirs?: EditKinds };
  /** Whose concurrent rebalance wins (default: symmetric, by content). */
  rekeys?: "ours" | "theirs";
  /** false: every both-sides time-group edit is a card (measurement only). */
  algebra?: boolean;
}

// ------------------------------------------------------------------ diff, describe, shots (§9)

/** One shot: a maximal output interval over which the visible stack and its source mapping are continuous. */
export interface Shot {
  start: number;
  end: number;
  layers: number;
  /** Interned content signature (equal signatures look and sound the same, wherever they sit). */
  sig: number;
}

/** A shot diff aligned like a text diff: matched shots, and the changed runs on each side (`null`: none there). */
export interface ShotDiff {
  shotsA: number;
  shotsB: number;
  unchanged: number;
  /** Matched shots that moved in time. */
  shifted: number;
  changed: { a: [number, number] | null; b: [number, number] | null; aAt: number; bAt: number }[];
}

/** Compare (§9): the ops from a to b, a plain-language list, and the shot diff. */
export interface DiffResult {
  ops: Op[];
  describe: string[];
  shots?: ShotDiff;
}

// ------------------------------------------------------------------ undo (§8)

/** One entry of an actor group's undo stack: a change at the head it can invert. */
export interface UndoEntry {
  changeId: ChangeId;
  seq: number;
  branchId: string;
  /** "Undo Director: tighter intro", "Undo Claude Code: ...". */
  label: string;
  author: Actor;
  at: number;
}

// ------------------------------------------------------------------ results and notices (§6.2)

/**
 * What every commit (and every `cb`/MCP write) returns: `confirmed@seq`, `pending` (queued for the server), or
 * `conflicts` (cards that need a choice). `rejected` is a validation failure that resubmitting can't fix.
 */
export type CommitResult =
  | { status: "confirmed"; seq: number; ref: StateRef; change: ConfirmedChange | null; rebased: number; notices: Notice[]; empty?: boolean; warnings?: SoftWarning[]; /** cards `choices` decided (the proposals that didn't land) */ resolved?: ConflictCard[] }
  | { status: "pending"; id: ChangeId; ref: StateRef; notices: Notice[]; /** cards `choices` decided merging a stale base */ resolved?: ConflictCard[] }
  | { status: "conflicts"; cards: ConflictCard[]; ref: StateRef; merge?: MergeResult; unseen?: PathKey[] }
  | { status: "rejected"; reason: string; invalid?: { path?: PathKey; error: string } };

export type NoticeKind = "overwritten" | "lost-to-delete" | "late-conflict" | "rejected" | "other-changes";

/** A message for one actor, returned at the start of its next `cb`/MCP result (late conflicts, overwrites). */
export interface Notice {
  to: ActorKey;
  /** The cut the change was made on (late conflicts and rejections), so its cards are resolved there. */
  cut?: string;
  kind: NoticeKind;
  text: string;
  path?: PathKey;
  by?: Actor;
  change?: ChangeId;
  cards?: ConflictCard[];
  at?: number;
}

/** Events a Carton handle emits. */
export type CartonEvent =
  | { type: "change"; branchId: string; seq: number; change: ConfirmedChange; local: boolean }
  | { type: "pending"; branchId: string; id: ChangeId }
  | { type: "notice"; notice: Notice }
  | { type: "sync"; status: "offline" | "syncing" | "up-to-date" | "stopped"; waiting: number }
  /**
   * A pending change a rebase emptied (its effect was already at the head, or a card took its place): withdrawn (H1).
   * Emitted once the rows that came with it are settled into History (after their `change` events), so state read in
   * the handler (credits for a card's other side, head, log) is current (web-demo REQ-U1). A settle that couldn't store
   * it tells it with the one that does; after a keyframe catch-up, once the skipped rows are in History (fetched, or
   * loaded from the store another handle saved them to). If they can't be fetched (offline, a server that can't serve
   * history), or the handle stops or closes first, it is told on what History holds: credits for those rows are then
   * unknown. A settle's `notice` events (a late conflict's cards) come the same way (review R6-8, R6-10, R6-11).
   */
  | { type: "absorbed"; branchId: string; id: ChangeId; cards: ConflictCard[] }
  | { type: "presence"; branchId: string; actor: Actor; state: unknown }
  | { type: "warning"; branchId: string; warnings: SoftWarning[] }
  /**
   * The host refused or failed this replica's sync of a cut (a hello refused, a token the host doesn't accept, a host
   * it can't reach, an upload over the host's limit): `error`, until a later welcome or ack clears it (`null`).
   */
  | { type: "sync-error"; branchId: string; error: SyncError | null }
  /** Who is behind a replica changed (`setIdentity`, or the server's people): authors in log() and credits() may read differently. */
  | { type: "people" }
  /**
   * The cuts changed: one made (with no edit yet too), renamed, gone, or its kind, protection or sync changed. By this
   * handle, by a sync, or by another process on the same store (told once this handle reads the store again: any read
   * such as log() or cuts() does). cuts() says how they are now.
   */
  | { type: "cuts" };

/**
 * Why a cut's sync is failing, for a sync status line. `code`: `update-server` (the host is older than this app's
 * document schema), `unauthorized` (its token or scope), `unreachable` (no connection), `unknown-cut`, `too-large`,
 * `write-limit` (the host's daily limit is reached: edits are kept, and sync on their own at `until`), or `server`
 * (anything else the host said). `message`: the host's or connection's own words.
 */
export interface SyncError {
  code: "update-server" | "unauthorized" | "unreachable" | "unknown-cut" | "too-large" | "write-limit" | "server";
  message: string;
  /** `write-limit`: when the edits held back sync (ms since the epoch). */
  until?: number;
}
