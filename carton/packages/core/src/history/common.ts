// Shared names of the history layer: the Store table layout, the "state unknown" error, and History's option types.

import type { Actor, ChangeId, Choices, CommitResult, ConflictCard, Doc, EditKinds, Intent, NodeId, Op, Policy, StateRef } from "../types.ts";
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
  /** Change ids for commits that don't pass one (default `${rid}.${n}`). A handle that rebuilds its History passes its own. */
  nextId?: () => string;
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
}

/**
 * What a dry-run fold would bring in (`check: true`), for the Fold in dialog's list and partial accept: the ops that
 * turn the target cut's head into the folded state (cards on their provisional side), described, plus the soft
 * warnings on the result. Added for @carton/react (contract(core) by agent ui).
 */
export interface FoldPreview {
  ops: Op[];
  describe: string[];
  warnings: SoftWarning[];
}
