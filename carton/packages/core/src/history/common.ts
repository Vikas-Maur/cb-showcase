// Shared names of the history layer: the Store table layout, the "state unknown" error, and History's option types.

import type { Actor, ChangeId, ChangeKind, Choices, CommitResult, ConfirmedChange, ConflictCard, Doc, EditKinds, Intent, NodeId, Op, Policy, StateRef } from "../types.ts";
import type { SoftWarning } from "../schema.ts";

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
export const LOCAL_TABLES: ReadonlySet<string> = new Set(["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap", "comments_pending", "comments_meta"]);

/** "state unknown: re-print": a ref that can't be reconstructed exactly (§4.4). Never a guess. */
export class StateUnknown extends Error {
  readonly code = "STATE_UNKNOWN";
  readonly ref: unknown;
  constructor(ref: unknown, why: string) {
    super(`state unknown: re-print (${why})`);
    this.ref = ref;
  }
}

/**
 * A restore of an empty version (`isBlank`), or a cut made from one: the root an imported project's history starts from
 * holds nothing of the project, not even its name, so either would leave a project with nothing in it.
 */
export class EmptyVersion extends Error {
  readonly code = "EMPTY_VERSION";
  readonly ref: unknown;
  constructor(ref: unknown, what: string) {
    super(`Nothing to ${what}: that version is empty (the history starts there, before the project was in it)`);
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
  /** Change ids for commits that don't pass one (default `${rid}.${n}`). A handle that rebuilds its History passes its own. */
  nextId?: () => string;
}

/**
 * A shared cut's pending changes on top of its confirmed log, with the state after each (newest last). Undo, revert and
 * the undo stack see them as the cut's newest changes: ⌘Z right after an edit undoes that edit before the server
 * answers, and an undo still waiting to sync hides its change from the stack.
 */
export interface Tail {
  rows: readonly ConfirmedChange[];
  states: readonly Doc[];
}

/**
 * What importing a shallow `.cbproj` did (§13): forked a writable cut from the sender's head (a project this replica
 * didn't have), imported its lineage, refused another project's file, or found no shared lineage under the same
 * project id, in which case the copy gets `newProjectId` and is opened as a project of its own.
 */
export type ShallowImport =
  | { status: "forked"; cut: string; head: NodeId }
  | { status: "imported"; head: NodeId }
  | { status: "other-project" }
  | { status: "no-shared-lineage"; newProjectId: string };

/** What an undo or a revert writes, computed but not committed (a shared cut queues it). */
export interface Planned {
  doc: Doc;
  author: Actor;
  kind: ChangeKind;
  intent?: Intent;
  extra: { reverts: ChangeId | ChangeId[] };
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
  /** Cards that `choices` (a list or map) doesn't name: "card" (default) returns them as conflicts; "prefer" decides them. */
  unchosen?: "card" | "prefer";
  /** The one change a Published cut takes: the held state it publishes (internal: Carton.publish). */
  publish?: boolean;
  /** Unused (the prototype's flag): an empty commit is confirmed empty; an empty fold or undo is always recorded. */
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
  /** A stable id (a retried `cb fold`): a fold already confirmed under it is returned, never made twice. */
  id?: ChangeId;
  /**
   * Cards a list or map of `choices` doesn't name (new since the caller reviewed the plan): "card" (default) returns
   * them as conflicts; "prefer" decides them by `prefer`. A function decides every card itself.
   */
  unchosen?: "card" | "prefer";
}

/**
 * What a dry-run fold would bring in (`check: true`), for the Fold in dialog's list and partial accept: the ops that
 * turn the target cut's head into the folded state (cards on their provisional side), described, plus the soft
 * warnings on the result. Added for @carton/react (agent ui's f064dd1, absorbed by foundation-core).
 */
export interface FoldPreview {
  ops: Op[];
  describe: string[];
  warnings: SoftWarning[];
}
