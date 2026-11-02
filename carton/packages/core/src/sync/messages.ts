// The sync protocol's messages (PLAN §6.3, §12, §5.3), as the system-v11 prototype sends them, with PLAN v14's fixes
// (H1 withdraw, H2 lww retry, bounded confirmed-id lists). JSON over any Transport: spans carry `hi: null` for an open
// end, so nothing needs a custom codec. Owner: sync-sequencer.

import type { Actor, ChangeId, ConfirmedChange, Change, CutRecord, Doc, DagNode, NodeId, PathKey } from "../types.ts";
import type { EnvelopeMsg } from "./envelope.ts";

/** The protocol version both sides speak; `hello` carries the document schema version too. */
export const PROTOCOL = 1;

/** A pending id the server already confirmed or withdrew (R10-01): the client drops it before rebasing. */
export interface ConfirmedId {
  id: ChangeId;
  seq: number;
  /** The version that was confirmed (its rebase count): late cards come only from the rebases up to it (M3). */
  rebase?: number;
  /** Spent by a withdraw (H1): it changed nothing. */
  withdrawn?: boolean;
}

/**
 * A pending id the client sent and never saw acked, with every base it was pushed on. A push on base `b` can only
 * have been confirmed in `(b, b + K + 1]` (the K cap), so the server reads at most K + 1 ids per base (§6.3, R12-01).
 */
export interface PendingClaim {
  id: ChangeId;
  bases: number[];
}

/** Why a push was refused. Validation reasons can't be fixed by resubmitting: the change leaves the queue. */
export type RejectReason =
  | "overlap"
  | "behind"
  | "base unknown"
  /** lww on a change with a span or a group path (R11-01): resubmitted as `merge`, never dropped (H2). */
  | "lww on structure"
  // validation
  | "unknown branch"
  | "read-only branch"
  | "forbidden"
  | "invalid"
  | "exists"
  | "read of a missing record"
  | "span missing"
  | "undeclared path"
  | "foreign id"
  | "no ops"
  | "too large"
  | "bad change";

export const VALIDATION_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "unknown branch",
  "read-only branch",
  "forbidden",
  "invalid",
  "exists",
  "read of a missing record",
  "span missing",
  "undeclared path",
  "foreign id",
  "no ops",
  "too large",
  "bad change",
]);

/** The most JSON one presence message may carry: the server drops bigger ones (never relayed, never stored). */
export const PRESENCE_BYTES = 64 * 1024;

/**
 * Live presence (§12): 10–20 Hz while dragging, 1 Hz while active, stops after 30 s idle. Never stored. At most
 * `PRESENCE_BYTES` of JSON with its actor; the server drops bigger ones.
 */
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

/** A state the server stores for catch-up: produced by a replica, keyed by seq, checked by its hash on load. */
export interface KeyframeData {
  seq: number;
  stateHash: string;
  doc: Doc;
}

// ------------------------------------------------------------------ client -> server

/**
 * Join a branch: what the client has, every pending id it sent with the bases it sent it on (so the server lists
 * those it already confirmed), and every replica id this replica has used (bound to the connection's device
 * credential, §6.3).
 */
export interface HelloMsg {
  type: "hello";
  branchId: string;
  have: number;
  pending: PendingClaim[];
  rids: string[];
  schemaVersion: number;
  protocol?: number;
  /** Rows only, no keyframe (the client found a keyframe's hash wrong). */
  noKeyframe?: boolean;
  /** The client reads envelopes (it has the blob store): the server may send it messages over 1 MiB as references. */
  envelopes?: boolean;
  /** A continuation of the claims (`WelcomeMsg.checkedThrough`): they were checked through this seq already. */
  claimsAfter?: number;
  /** The person at this replica (`IdentityMsg`); a server that keeps no people ignores it. */
  identity?: Person;
  /**
   * The client waits out a host's write limit (`ErrorMsg` code `write-limit`): the server may drop the rest of a push's
   * epoch it couldn't store, as a reject does, and the client sends those changes again after the limit's time.
   */
  writeLimit?: boolean;
}
/** Pipelined push of pending changes in queue order. A reject kills the rest of that `epoch`. */
export interface PushMsg {
  type: "push";
  branchId: string;
  epoch: number;
  changes: Change[];
}
/**
 * A pending change a rebase absorbed (empty): its id is spent with a withdraw row, so a late push of it (a dead
 * helper's) is acked as withdrawn, never confirmed (H1). `base` is the client's head when it withdrew.
 */
export interface WithdrawMsg {
  type: "withdraw";
  branchId: string;
  id: ChangeId;
  base: number;
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
 * `doc0` is the state at `rootSeq` (0 with full history; n for "Share without history", with no rows).
 */
export interface AdoptMsg {
  type: "adopt";
  branchId: string;
  n: number;
  stateHash: string;
  rows: ConfirmedChange[];
  rec: CutRecord;
  doc0: Doc | null;
  rootSeq?: number;
  /** `hashDoc(doc0)`, so a joiner from nothing can check the root keyframe (the client fills it in). */
  rootHash?: string;
  closure: ClosureEntry[];
}
/**
 * One branch of a hand-off's ancestry closure (§5.3, R4-07), kept by the server as a read-only tracking branch: its
 * lineage nodes, the states of its fork, merge and export nodes (the states a merge base can need), and the last author
 * per record at the nodes the shared cut's credits stop at. No micro-changes.
 */
export interface ClosureEntry {
  branchId: string;
  rec: CutRecord;
  nodes: DagNode[];
  states?: { seq: number; hash: string; doc: Doc }[];
  authors?: [NodeId, Record<PathKey, Actor>][];
}
/**
 * A replica's request for history it doesn't hold (Stage F): the rows `(after, upTo]`, paged like catch-up, and with
 * `lineage` the branch's ancestry closure. A joiner loads them into History (log, credits, diff), as does a keyframe
 * catch-up for the stretch it jumped. `req` names the answer.
 */
export interface HistoryMsg {
  type: "history";
  branchId: string;
  req: number;
  after: number;
  upTo: number;
  lineage?: boolean;
  /**
   * With `lineage`, page it (SF1-8): where this page starts, `{entry: 0, state: 0}` for the first, then the previous
   * reply's `lineageNext`. Without it the whole lineage comes in one reply (clients from before paging).
   */
  lineageFrom?: LineageCursor;
}
/** A place in a branch's lineage: the closure entry, and the state (an index into that entry's `nodes`). */
export interface LineageCursor {
  entry: number;
  state: number;
}
/** A shared variant made on the server: O(1), no rows copied; it reads the parent at `seq` (§6.3). */
export interface ForkMsg {
  type: "fork";
  branchId: string;
  from: string;
  seq: number;
  rec: CutRecord;
  /** The state at the fork point: the fork's root, so a joiner that doesn't hold the parent can start from it. */
  root?: { stateHash: string; doc: Doc };
}
/** The keyframe the server asked for (`AckMsg.keyframeWanted`), for far-behind catch-up (§6.3). */
export interface KeyframeMsg {
  type: "keyframe";
  branchId: string;
  keyframe: KeyframeData;
}
export interface PresenceMsg {
  type: "presence";
  branchId: string;
  actor: Actor;
  state: PresenceState | null;
}
/** The person at a replica (windows-sync R3): the session's account (`AuthContext.account`) and the name it shows. */
export interface Person {
  id: string;
  name: string;
}
/** A person and every replica id bound to their device credential (§6.3): changes with those ids are theirs. */
export interface PersonRids extends Person {
  rids: string[];
}
/**
 * This replica's person, kept by the server for the connection's device credential: `id` must be the session's
 * account (else `forbidden`), the name is the person's own choice. Also sent in `hello`; sent alone only to a server
 * whose welcome had `people`.
 */
export interface IdentityMsg {
  type: "identity";
  branchId: string;
  identity: Person;
}
/** Any message over 1 MiB, either way, travels as an envelope (`envelope.ts`). */
export type ClientMessage = HelloMsg | PushMsg | WithdrawMsg | BranchStatusMsg | AdoptMsg | ForkMsg | KeyframeMsg | PresenceMsg | HistoryMsg | IdentityMsg | EnvelopeMsg;

// ------------------------------------------------------------------ server -> client

/** Answer to hello: rows since `have` (or a keyframe plus the tail when far behind) and the confirmed pending ids. */
export interface WelcomeMsg {
  type: "hello";
  branchId: string;
  head: number;
  rows: ConfirmedChange[];
  keyframe?: KeyframeData;
  confirmed: ConfirmedId[];
  /** More rows follow: send `hello` again with the new `have`. */
  more?: boolean;
  /** The largest client message the server reads (its envelope limit, for a client that sends envelopes). */
  maxMessageBytes?: number;
  /**
   * A Published cut's source: the cut it came from, the version published (`at`) and that cut's head now. A watcher
   * learns that newer edits exist (head > at) without being able to read them.
   */
  source?: { branchId: string; at: number; head: number };
  /**
   * The server checked the claims only on bases below this one (a cap per message): ask again for the rest before
   * acting on the list. Unchecked ids are never to be taken as unconfirmed.
   */
  uncheckedFrom?: number;
  /**
   * With `uncheckedFrom`: the list reached the page's byte budget inside the claims from that base, which were checked
   * through this seq; ask again with `claimsAfter` set to it. Such a page holds the list alone (no rows, no keyframe).
   */
  checkedThrough?: number;
  /**
   * Every person of the project with the replica ids bound to them (on a page that subscribes). Present, even empty,
   * when the server keeps people: the client may then send `identity` on this connection.
   */
  people?: PersonRids[];
}
/** New confirmed rows, fanned out to every subscriber (the pusher too, before its ack). */
export interface ChangesMsg {
  type: "changes";
  branchId: string;
  rows: ConfirmedChange[];
}
/** Accepted (or already confirmed: `duplicate`; or spent by a withdraw: `withdrawn`). */
export interface AckMsg {
  type: "ack";
  branchId: string;
  id: ChangeId;
  seq: number;
  epoch: number;
  duplicate?: boolean;
  withdrawn?: boolean;
  /** The server holds no keyframe at this seq yet: upload one (`KeyframeMsg`). */
  keyframeWanted?: number;
}
/**
 * Refused. `concurrent` names the rows after the change's base it clashed with; their bodies already reached the
 * client on this connection (the server fans every row out before it answers the next push).
 */
export interface RejectMsg {
  type: "reject";
  branchId: string;
  id: ChangeId | undefined;
  reason: RejectReason;
  head: number;
  concurrent: { seq: number; id: ChangeId }[];
  epoch: number;
  confirmed?: ConfirmedId[];
  /** As `WelcomeMsg.uncheckedFrom`: the list is incomplete; catch up with `hello` before rebasing. */
  uncheckedFrom?: number;
  detail?: string;
}
export interface StatusMsg {
  type: "status";
  branchId: string;
  adopted: boolean;
  adoptKey: string | null;
  since: number | null;
  head: number;
  /** As `WelcomeMsg.maxMessageBytes`, for the upload a hand-off makes right after this answer (a server with blobs). */
  maxMessageBytes?: number;
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
  /** `write-limit`: the host refused to store the upload for a while (as `ErrorMsg`'s); ask again after `retryAfterMs`. */
  code?: "write-limit";
  retryAt?: number;
  retryAfterMs?: number;
}
export interface ForkedMsg {
  type: "forked";
  branchId: string;
  from: string;
  seq: number;
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
export interface PresenceFanoutMsg {
  type: "presence";
  branchId: string;
  actor: Actor;
  state: PresenceState | null;
}
export type ErrorCode = "schema-too-new" | "unauthorized" | "forbidden" | "bad-request" | "write-limit";
export interface ErrorMsg {
  type: "error";
  reason: string;
  /**
   * What kind of refusal, for a client to act on (`reason` is for people): `schema-too-new` (the client's documents are
   * newer than the server accepts: update the server), `unauthorized` (the token expired, or is for another project),
   * `forbidden` (outside this token's cuts or role), `bad-request` (a malformed message), `write-limit` (the host
   * refused to store a write for a while: its daily write cap). Absent: anything else.
   */
  code?: ErrorCode;
  /** A message of this connection was lost (an envelope the server couldn't read): reconnect and catch up. */
  reconnect?: boolean;
  /**
   * `write-limit`: when the host takes writes again (ms since the epoch, by the host's clock, for showing), and how long
   * that is from when it was sent (what a client waits, whatever its own clock says).
   */
  retryAt?: number;
  retryAfterMs?: number;
  /**
   * `write-limit` on a push, to a client whose hello said `writeLimit`: its cut and epoch. The server dropped the rest
   * of that epoch, as a reject does; the client sends those changes again, in a new epoch, after `retryAfterMs`.
   */
  branchId?: string;
  epoch?: number;
}

/**
 * When a refused write may be tried again (ms since the epoch), if `e` is a refusal for a while (BlobStore's contract:
 * an error carrying `retryAt`, as server-cloudflare's daily write cap throws); null for any other error.
 */
export function writeLimitOf(e: unknown): number | null {
  const at = (e as { retryAt?: unknown } | null | undefined)?.retryAt;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}
/** Answer to `history`: a page of rows (`more`: ask again after the last), the closure when asked, or why not. */
export interface HistoryReplyMsg {
  type: "history";
  branchId: string;
  req: number;
  rows: ConfirmedChange[];
  more?: boolean;
  /**
   * The lineage, or with `lineageFrom` one page of it: entries in closure order within the server's catch-up byte
   * budget, at least one state (or one entry with none) per page. An entry split across pages comes again with the
   * same `branchId` and `rec`, its later states only (`nodes` empty; `nodes` and `authors` come with its first page):
   * concatenate entries by `branchId`. A state may name a node added after that first page (a later adoption).
   */
  lineage?: ClosureEntry[];
  /** More lineage: ask again with `lineageFrom` set to this (rows and lineage page independently). */
  lineageNext?: LineageCursor;
  error?: string;
}

/**
 * A change to the people (a person set or renamed, a replica id newly bound to one), to every connection of the
 * project, before the rows of a newly bound replica id. An entry for a replica id replaces what the client had for it.
 */
export interface PeopleMsg {
  type: "people";
  branchId: string;
  people: PersonRids[];
}

export type ServerMessage =
  | WelcomeMsg
  | PeopleMsg
  | HistoryReplyMsg
  | ChangesMsg
  | AckMsg
  | RejectMsg
  | StatusMsg
  | AdoptedMsg
  | AdoptErrorMsg
  | ForkedMsg
  | UnknownBranchMsg
  | OverwrittenMsg
  | PresenceFanoutMsg
  | ErrorMsg
  | EnvelopeMsg;
