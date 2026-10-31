// History (PLAN §5, §8, §13): changes with stable ids, versions, StateRefs and pins with owner sets, cuts with global
// ids and tracking cuts, the merge DAG (LCA over fork and merge edges, recursive virtual base for criss-cross folds),
// partial accept, restore, undo by actor group, keyframes and retention, view-save bases (§6.4) and shallow and full
// `.cbproj` exports. Port of the verified core-v5 prototype (`proofs/core-v5/history.mjs`). Owner: foundation-core.
//
// `History` is the synchronous in-memory model of one replica; `Carton` (../carton.ts) persists it through a Store.

import type { Schema } from "../schema.ts";
import type {
  Actor,
  ChangeId,
  Choices,
  CommitResult,
  ConfirmedChange,
  CutRecord,
  Doc,
  EditKinds,
  FullExport,
  Intent,
  MergeResult,
  NodeId,
  Op,
  PathKey,
  Policy,
  ShallowExport,
  StateRef,
  UndoEntry,
  Version,
  ConflictCard,
} from "../types.ts";
import { notImplemented } from "../todo.ts";

/**
 * Tables core keeps in a Store, and their keys. Stores treat them as opaque; this is the layout `store-*` packages
 * and the `.cbproj` full export see. Tables marked local are never exported (R3-07, §13).
 */
export const STORE_TABLES = {
  /** `[name]` -> JSON: projectId, schemaVersion, rids used (R10-02), current cut. */
  meta: "meta",
  /** `[cutId]` -> CutRecord. */
  cuts: "cuts",
  /** `[cutId, seq]` -> ConfirmedChange. The local sequencer appends with an `absent` condition on `[cutId, seq]`. */
  changes: "changes",
  /** `[changeId]` -> `[cutId, seq]`: dedup by id. */
  ids: "ids",
  /** `[cutId, seq]` -> Doc. A cache: states are rebuilt from the log. `[cutId, 0]` is a root cut's initial doc. */
  keyframes: "keyframes",
  /** `[hash]` -> Doc: carried states of imported lineage nodes. */
  states: "states",
  /** `[nodeId]` -> DagNode: imported lineage. */
  lineage: "lineage",
  /** `[cutId, seq]` -> {name, at, by}: named versions. */
  names: "names",
  /** `[cutId, order]` -> PendingChange (local). */
  pending: "pending",
  /** `[cutId, seq, hash8]` -> PinRow (local). */
  pins: "pins",
  /** `[actorKey, at, n]` -> Notice (local). */
  notices: "notices",
  /** `[name]` -> view metadata: header, print nonce, last applied state hash (local). */
  views: "views",
  /** `[key]` -> ephemeral host data (local). */
  ephemeral: "ephemeral",
  /** `["sync"]` -> {pid, nonce, socketPath, heartbeat} (local, §6.2). */
  lease: "lease",
  /** `[path]` -> absolute media paths (local; never exported). */
  pathMap: "pathMap",
} as const;
export const LOCAL_TABLES: ReadonlySet<string> = new Set(["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"]);

/** "state unknown: re-print": a ref that can't be reconstructed exactly (§4.4). Never a guess. */
export class StateUnknown extends Error {
  readonly code = "STATE_UNKNOWN";
  readonly ref: unknown;
  constructor(ref: unknown, why: string) {
    super(`state unknown: re-print (${why})`);
    this.ref = ref;
  }
}

export interface HistoryOptions {
  name?: string;
  /** Replica id: 96 random bits as hex. Change ids are `${rid}.${n}`. */
  rid?: string;
  clock?: () => number;
  projectId?: string | null;
  /** A keyframe every K confirmed changes (default 64). */
  keyframeEvery?: number;
}

/** A commit's base when the caller holds the doc (GUI base in engine memory, a view's last applied state). */
export interface HeldBase {
  baseDoc: Doc;
  baseSeq: number;
  causal?: ChangeId[];
}

export interface HistoryCommit {
  doc?: Doc;
  ops?: Op[];
  author: Actor;
  base?: StateRef | string | HeldBase;
  intent?: Intent | null;
  kinds?: EditKinds | null;
  policy?: Policy;
  choices?: Choices;
  id?: ChangeId;
  allowEmpty?: boolean;
  name?: string;
}

export type FoldResult =
  | CommitResult
  | { status: "up-to-date" }
  | { status: "missing-base"; dialog: MissingBaseDialog }
  | { status: "compare"; dialog: MissingBaseDialog; cards: ConflictCard[] };

/** §13: the LCA's state isn't held. Never falls back to an older base. */
export interface MissingBaseDialog {
  text: string;
  options: ["ask", "all-cards"];
  lca: NodeId | null;
}

export interface FoldOptions {
  author?: Actor;
  choices?: Choices;
  prefer?: "ours" | "theirs";
  /** "all-cards": bring it in as a 2-way compare with every difference a card. */
  missingBase?: "dialog" | "all-cards";
  /** Dry run (`cb fold --check`): report cards without committing. */
  check?: boolean;
}

/** One replica's history, in memory and synchronous. Port of core-v5 `Replica`. */
export class History {
  readonly schema: Schema;
  constructor(schema: Schema, opts?: HistoryOptions) {
    this.schema = schema;
    notImplemented("History");
  }
  static create(schema: Schema, doc: Doc, opts?: HistoryOptions & { cut?: string }): History {
    return notImplemented("History.create");
  }
  get current(): string {
    return notImplemented("History.current");
  }
  cuts(): CutRecord[] {
    return notImplemented("History.cuts");
  }
  fork(from: NodeId | StateRef, name: string): string {
    return notImplemented("History.fork");
  }
  headSeq(cutId: string): number {
    return notImplemented("History.headSeq");
  }
  head(cutId: string): NodeId {
    return notImplemented("History.head");
  }
  /** The state at a node; null when it isn't held (a shallow node whose state wasn't carried). Never the live head object. */
  stateOf(node: NodeId): Doc | null {
    return notImplemented("History.stateOf");
  }
  hashOf(node: NodeId): string | null {
    return notImplemented("History.hashOf");
  }
  ref(cutId: string): StateRef {
    return notImplemented("History.ref");
  }
  refString(cutId: string, seq: number, hash: string, extra?: { printNonce?: string; by?: string }): string {
    return notImplemented("History.refString");
  }
  parseRef(ref: string | StateRef): StateRef | { legacy: number } {
    return notImplemented("History.parseRef");
  }
  /** -> {doc, seq, causal}; an unknown, released, expired or mismatching ref throws StateUnknown. */
  resolve(ref: string | StateRef, now?: number): { doc: Doc; seq: number; causal: ChangeId[] } {
    return notImplemented("History.resolve");
  }
  /** A pin row for an out-of-process reader of a local optimistic state; `owner` joins its owner set. */
  pin(o: { cutId: string; seq?: number; pending?: ConfirmedChange[]; owner: string; expires?: number }): StateRef {
    return notImplemented("History.pin");
  }
  release(ref: StateRef, owner: string): void {
    notImplemented("History.release");
  }
  expirePins(now: number): void {
    notImplemented("History.expirePins");
  }
  commit(cutId: string, o: HistoryCommit): CommitResult & { retry?: (choices: Choices) => CommitResult } {
    return notImplemented("History.commit");
  }
  log(cutId: string, opts?: { limit?: number; before?: number }): Version[] {
    return notImplemented("History.log");
  }
  isAncestor(a: NodeId, d: NodeId): boolean {
    return notImplemented("History.isAncestor");
  }
  lca(x: NodeId, y: NodeId): NodeId[] {
    return notImplemented("History.lca");
  }
  /** Merge base over the DAG; criss-cross LCAs merge into a virtual base where disagreements keep their own base value. */
  mergeBase(x: NodeId, y: NodeId): { node?: NodeId | null; nodes?: NodeId[]; doc?: Doc; virtual?: boolean; missing?: NodeId | null; noCommon?: boolean } {
    return notImplemented("History.mergeBase");
  }
  /** "Fold into …": a DAG merge of node `from` into cut `into`. */
  fold(into: string, from: NodeId, opts?: FoldOptions): FoldResult & { merge?: MergeResult } {
    return notImplemented("History.fold");
  }
  /** "Fold in some of it" (R2-14): a full fold, then an inverse change for the rejected records that lists them. */
  foldSome(into: string, from: NodeId, opts: FoldOptions & { reject: PathKey[] }): FoldResult {
    return notImplemented("History.foldSome");
  }
  /** Undo a change: its inverse at the head, as a 3-way merge (git revert). Intents invert as intents. */
  revert(cutId: string, changeId: ChangeId, opts?: { author?: Actor }): CommitResult {
    return notImplemented("History.revert");
  }
  /** "Accept the rest later": revert a partial accept's inverse. */
  acceptRest(cutId: string, inverseId: ChangeId, opts?: { author?: Actor }): CommitResult {
    return notImplemented("History.acceptRest");
  }
  /** Restore: the state at `ref`, saved as a new version on the cut. */
  restore(cutId: string, ref: NodeId | StateRef, opts?: { author?: Actor }): CommitResult {
    return notImplemented("History.restore");
  }
  /** ⌘Z for an actor group (§8): the newest of the group's changes not yet undone, inverted at the head. */
  undoStack(cutId: string, group: string): UndoEntry[] {
    return notImplemented("History.undoStack");
  }
  undo(cutId: string, group: string, opts?: { author?: Actor }): CommitResult & { entry?: UndoEntry } {
    return notImplemented("History.undo");
  }
  /** Credits: who last changed a record, down to the subagent (`[coll, id]` or its path key). */
  credits(cutId: string, record: PathKey | readonly string[], at?: number): Actor | null {
    return notImplemented("History.credits");
  }
  exportShallow(cutId: string, opts?: { to?: string }): ShallowExport {
    return notImplemented("History.exportShallow");
  }
  importShallow(pkg: ShallowExport): { status: "forked"; cut: string; head: NodeId } | { status: "imported"; head: NodeId } | { status: "other-project" } | { status: "no-shared-lineage"; newProjectId: string } {
    return notImplemented("History.importShallow");
  }
  exportFull(): FullExport {
    return notImplemented("History.exportFull");
  }
  importFull(pkg: FullExport): void {
    notImplemented("History.importFull");
  }
}
