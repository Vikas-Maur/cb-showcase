// The sync protocol's messages (PLAN §6.3, §12, §5.3), as the system-v11 prototype sends them. JSON over any
// Transport. Owned by `sync-sequencer`; the foundation wrote the first version from system-v11 `sync.mjs`/`server.mjs`.

import type { Actor, ChangeId, ConfirmedChange, Change, CutRecord, Doc, DagNode } from "../types.ts";

/** The protocol version both sides speak; `hello` carries the document schema version too. */
export const PROTOCOL = 1;

/** A pending id the server already confirmed (R10-01): the client drops it from its queue before rebasing. */
export interface ConfirmedId {
  id: ChangeId;
  seq: number;
  rebase?: number;
}

/** A pending id and the oldest base it was ever pushed on (the server scans only `(base, base + K + 1]`). */
export interface PendingClaim {
  id: ChangeId;
  base: number;
}

/** Why a push was refused. Validation reasons can't be fixed by resubmitting: the change leaves the queue. */
export type RejectReason =
  | "overlap"
  | "behind"
  | "base unknown"
  | "unknown branch"
  // validation
  | "invalid"
  | "exists"
  | "read of a missing record"
  | "span missing"
  | "foreign id"
  | "no ops"
  | "lww on structure"
  // FIFO hand-off contingency (§6.1), unused unless enabled
  | "reserved";

export const VALIDATION_REASONS: ReadonlySet<RejectReason> = new Set(["invalid", "exists", "read of a missing record", "span missing", "foreign id", "no ops", "lww on structure"]);

/** Live presence (§12): 10–20 Hz while dragging, 1 Hz while active, stops after 30 s idle. Never stored. */
export interface PresenceState {
  /** Playhead or cursor, seconds. */
  at?: number;
  selection?: string[];
  /** Drag ghosts: where items would land if released now. */
  ghosts?: { item: string; track: string; start: number; end: number }[];
  dragging?: boolean;
  /** Free-form host state (view, zoom). */
  [extra: string]: unknown;
}

// ------------------------------------------------------------------ client -> server

/**
 * Join a branch: what the client has, every pending id with its oldest base (so the server lists those it already
 * confirmed), and every replica id this replica has used (bound to the connection's device credential, §6.3).
 */
export interface HelloMsg {
  type: "hello";
  branchId: string;
  have: number;
  pending: PendingClaim[];
  rids: string[];
  schemaVersion: number;
  protocol?: number;
}
/** Pipelined push of pending changes in queue order. A reject kills the rest of that `epoch`. */
export interface PushMsg {
  type: "push";
  branchId: string;
  epoch: number;
  changes: Change[];
}
/** A pending change a rebase absorbed (empty): its id is spent, so a late push of it is acked as withdrawn (H1). */
export interface WithdrawMsg {
  type: "withdraw";
  branchId: string;
  id: ChangeId;
  epoch: number;
}
/** Hand-off (§5.3): does the server already hold this branch? Asked on reconnect while `handingOff`. */
export interface BranchStatusMsg {
  type: "branchStatus";
  branchId: string;
}
/**
 * Hand-off upload: the branch's confirmed rows 1..n (or a shallow root), keyed `(branchId, n, stateHash@n)` so a
 * repeated upload gets the same answer, plus the ancestry closure as shallow tracking branches.
 */
export interface AdoptMsg {
  type: "adopt";
  branchId: string;
  n: number;
  stateHash: string;
  rows: ConfirmedChange[];
  rec: CutRecord;
  doc0: Doc | null;
  closure: { branchId: string; rec: CutRecord; nodes: DagNode[] }[];
}
export interface PresenceMsg {
  type: "presence";
  branchId: string;
  actor: Actor;
  state: PresenceState | null;
}
export type ClientMessage = HelloMsg | PushMsg | WithdrawMsg | BranchStatusMsg | AdoptMsg | PresenceMsg;

// ------------------------------------------------------------------ server -> client

/** Answer to hello: rows since `have` (or a keyframe plus the tail when far behind) and the confirmed pending ids. */
export interface WelcomeMsg {
  type: "hello";
  branchId: string;
  head: number;
  rows: ConfirmedChange[];
  keyframe?: { seq: number; doc: Doc };
  confirmed: ConfirmedId[];
}
/** New confirmed rows, fanned out to every subscriber. */
export interface ChangesMsg {
  type: "changes";
  branchId: string;
  rows: ConfirmedChange[];
}
/** Accepted (or already confirmed: `duplicate`; or spent by a withdraw: `withdrawn`). */
export interface AckMsg {
  type: "ack";
  id: ChangeId;
  seq: number;
  epoch: number;
  duplicate?: boolean;
  withdrawn?: boolean;
}
/** Refused. `concurrent` = rows after the change's base (empty for `behind` and validation rejects). */
export interface RejectMsg {
  type: "reject";
  id: ChangeId | undefined;
  reason: RejectReason;
  head: number;
  concurrent: ConfirmedChange[];
  epoch: number;
  confirmed?: ConfirmedId[];
  detail?: string;
}
export interface StatusMsg {
  type: "status";
  branchId: string;
  adopted: boolean;
  adoptKey: string | null;
  since: number | null;
  head: number;
}
export interface AdoptedMsg {
  type: "adopted";
  branchId: string;
  since: number;
  repeat?: boolean;
}
export interface AdoptErrorMsg {
  type: "adoptError";
  branchId: string;
  reason: string;
}
export interface UnknownBranchMsg {
  type: "unknownBranch";
  branchId: string;
}
/** An lww push overwrote this change's leaf: the overwritten author's client shows the toast. */
export interface OverwrittenMsg {
  type: "overwritten";
  branchId: string;
  id: ChangeId;
  by: ChangeId;
  author: Actor;
}
/** FIFO hand-off contingency: the span is yours, push now. */
export interface GoMsg {
  type: "go";
  branchId?: string;
}
export interface PresenceFanoutMsg {
  type: "presence";
  branchId: string;
  actor: Actor;
  state: PresenceState | null;
}
export interface ErrorMsg {
  type: "error";
  reason: string;
}
export type ServerMessage =
  | WelcomeMsg
  | ChangesMsg
  | AckMsg
  | RejectMsg
  | StatusMsg
  | AdoptedMsg
  | AdoptErrorMsg
  | UnknownBranchMsg
  | OverwrittenMsg
  | GoMsg
  | PresenceFanoutMsg
  | ErrorMsg;
