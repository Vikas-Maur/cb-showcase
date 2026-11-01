// The comment model and its wire messages (PLAN §1 C6 "timecoded comments", §9 anchors, §14 the commenter role).
//
// Comments are not versions: adding, editing, resolving or replying never makes a change, never meets an edit in a
// merge and never shows in History. They live in their own tables (locally beside the project's history in
// carton.db, on the server beside the sequencer's) and travel as their own messages.

/** Who wrote a comment: the person. Once shared, `id` is the server's session account, never what a client claims. */
export interface CommentAuthor {
  id: string;
  /** What teammates see ("Alice Chen"). */
  name: string;
  /** An agent that wrote it for the person ("Director"), as it declared itself. Display only. */
  agent?: string;
}

/**
 * Where a comment was made: the version (its cut, seq and full state hash) and, for a timecoded comment, the place on
 * the timeline. Everything needed to say later whether that place still shows the same thing is kept here, so a later
 * version can be checked without rebuilding the old one (`reanchor`).
 */
export interface Anchor {
  cut: string;
  seq: number;
  /** The version's full state hash (`StateRef.hash`). */
  state: string;
  /** Seconds on the timeline, `[start, end]`; `start === end` is a moment. Absent: the comment is on the whole version. */
  range?: [number, number];
  /**
   * Visible items under the range at that version, top first (at most `LIMITS.anchorItems`), each with the source-media
   * timecode it showed there: what a moved, trimmed or split clip is followed by.
   */
  items?: AnchorItem[];
  /** The shot signature of the range at that version (16 hex): what "may be outdated" is checked against. */
  sig?: string;
}

/** An item under an anchor and the source-media time it showed at the anchor's start. */
export interface AnchorItem {
  id: string;
  /** Seconds into its source media at the range's start (at `dt` for an item that starts inside the range). */
  at: number;
  /** For an item that starts inside the range: how far into the range (seconds). */
  dt?: number;
  /** Its media (the host's media field, e.g. Cardboard's `mediaItemId`): a clip found by nothing else is looked for by it. */
  media?: string;
}

/** A comment: a thread's first comment (with an anchor) or a reply to one. Immutable: a change makes a new object. */
export interface Comment {
  id: string;
  /** The thread's first comment, for a reply. Threads are one level deep. */
  replyTo?: string;
  author: CommentAuthor;
  body: string;
  /** Where it was made; a thread's first comment only. */
  anchor?: Anchor;
  /** The cut the thread is on (its anchor's), kept on replies too: what the server's read scope checks. */
  cut: string;
  /** When it was written (ms, the writer's clock). */
  at: number;
  editedAt?: number;
  /** A thread's first comment only. */
  resolved?: { by: CommentAuthor; at: number };
  /** Deleted by its author: the body is gone, the replies stay. */
  deleted?: true;
  /** Its place in the project's comment stream once the server has it (absent: not shared yet). */
  seq?: number;
}

/**
 * What a person did to one comment, as one patch: created it, and/or changed its body, resolved or reopened it, deleted
 * it. Edits made before the server answered fold into one patch per comment (`mergePatch`), so a project that was never
 * shared uploads one patch per comment when it is.
 */
export interface CommentPatch {
  add?: { replyTo?: string; body: string; anchor?: Anchor; cut: string; at: number };
  body?: string;
  resolved?: boolean;
  deleted?: true;
  /** When the latest of these edits was made (ms). */
  at: number;
  /** The person as they show; the server replaces `id` with the session's account. */
  author: CommentAuthor;
}

/** A patch waiting for the server (or, in a project that was never shared, for the day it is). */
export interface PendingPatch {
  id: string;
  patch: CommentPatch;
  /** Goes up on every local edit of this row: the server's answer clears it only if nothing was added since it was sent. */
  v: number;
}

/** Why a patch was refused. `rate-limited` is retried later; the others are final. */
export type CommentRefusal = "forbidden" | "not-found" | "bad-request" | "rate-limited" | "too-many" | "conflict";

// ------------------------------------------------------------------ wire messages (client <-> server)
// Carried by the project's existing host on the same Transport as the sync protocol, as their own message kinds and
// tables, never as document changes. Every client message names a cut (`branchId`), like the sync protocol's: a
// watch-link session names its Published cut, and the server's read scope works unchanged.

/** Subscribe to the project's comments and get the rows after `since` (a page; `more` asks again). */
export interface CommentsRequest {
  type: "comments";
  branchId: string;
  since: number;
}
/** One comment's patch. `n` is the writer's own counter, echoed in the answer. */
export interface CommentPatchMsg {
  type: "comment";
  branchId: string;
  n: number;
  id: string;
  patch: CommentPatch;
}
export type CommentClientMessage = CommentsRequest | CommentPatchMsg;

/**
 * Rows of the comment stream: the answer to `comments` (a page: `more` until caught up) and the fan-out of others'
 * patches. A row is a comment as it now is; `head` is the newest seq the server had when it sent this.
 */
export interface CommentsRowsMsg {
  type: "comments";
  branchId: string;
  rows: Comment[];
  head: number;
  more?: boolean;
  /** The answer to a `comments` request (fan-out has none). */
  reply?: true;
  /**
   * The server has fewer rows than `since` claims (its storage was reset, or another project's): forget the server's
   * rows kept here (pending ones stay, and are sent again) and take these, which start from 0.
   */
  reset?: true;
}
/** The answer to a `comment`: its row as stored (`row`), or why not. */
export interface CommentAnswerMsg {
  type: "commentAnswer";
  branchId: string;
  n: number;
  id: string;
  row?: Comment;
  refused?: CommentRefusal;
  reason?: string;
  /** With `rate-limited`: when to try again (ms). */
  retryMs?: number;
}
export type CommentServerMessage = CommentsRowsMsg | CommentAnswerMsg;

// ------------------------------------------------------------------ limits (the server checks; clients check first)
export const LIMITS = {
  /** A body, in UTF-16 code units. */
  body: 10_000,
  /** A name, an agent name, a cut id, an item id. */
  name: 200,
  id: 100,
  anchorItems: 16,
  /** The largest `comment` message (JSON bytes). */
  messageBytes: 64 * 1024,
  /** Comments per project, so a free host's storage is bounded (§17, L6). */
  perProject: 100_000,
  /** Rows per page of `comments`, and its size (JSON characters; at least one row). */
  page: 500,
  pageBytes: 512 * 1024,
  /** Per connection: patches at once, then per second (like presence's bucket, slower: people type comments). */
  burst: 10,
  perSec: 2,
  /** Timeline times, seconds. */
  maxTime: 1e7,
} as const;
