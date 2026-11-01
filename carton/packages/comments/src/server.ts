// The server half of comments (`@carton/comments/server`): pure rules over the sequencer's own storage
// (`SequencerStorage`: the Durable Object's SQL or node:sqlite), so every SequencerHost carries comments the same way.
// The sequencer core (`@carton/server`, owned by hosts-plugins) routes the two message kinds here; nothing here
// orders, merges or reads document changes. Comments never become changes.
//
// Rules (PLAN §14):
// - owners, editors and commenters comment, reply and resolve; viewers read only;
// - a session scoped to some cuts (a Published cut's watch link) reads only comments on those cuts, and, with a
//   commenting role, comments only there; an unscoped session reads every comment;
// - only a comment's author edits or deletes it; the author is the session's account, never what a client claims;
// - each connection has a token bucket like presence's (LIMITS.burst at once, LIMITS.perSec after), and a project at
//   most LIMITS.perProject comments.
//
// Storage: three tables, created on first use. `comments` holds each comment as it now is; `comment_log` orders the
// stream: one row per comment, at the seq of its latest change (the older row is deleted), so catching up from any
// position reads each changed comment once. A change writes 3 rows (P5-style accounting: a comment costs what a
// change costs, about).
//   comments     (id TEXT PRIMARY KEY, seq INTEGER, cut TEXT, row TEXT)   WITHOUT ROWID
//   comment_log  (seq INTEGER PRIMARY KEY, id TEXT, cut TEXT)            WITHOUT ROWID
//   comment_meta (k TEXT PRIMARY KEY, v INTEGER)                         WITHOUT ROWID   -- "count"

import type { AuthContext, SequencerStorage } from "@carton/core/plugins";
import { applyPatch, patchProblem, validId } from "./model.ts";
import { LIMITS, type Comment, type CommentAnswerMsg, type CommentPatchMsg, type CommentRefusal, type CommentsRequest, type CommentServerMessage } from "./types.ts";

/** A connection as the comment room sees it. */
export interface CommentPeer {
  readonly auth: AuthContext;
  send(msg: CommentServerMessage): void;
}

export interface CommentRoomOptions {
  storage: SequencerStorage;
  clock?: () => number;
  /** The name the server knows for a session's person (its `people` table), preferred over the one a patch carries. */
  nameOf?: (auth: AuthContext) => string | undefined;
  limits?: { perProject?: number; page?: number; pageBytes?: number; burst?: number; perSec?: number };
}

export interface CommentRoom {
  /**
   * A `comments` request: answer a page of rows after `since`. The host keeps the connection subscribed from then on
   * (in its per-connection state, so a hibernated Durable Object keeps it) and passes it to `onComment`'s `peers`.
   */
  onComments(c: CommentPeer, m: CommentsRequest): void;
  /** A `comment`: check it, store it, answer `c`, and send the row to every peer in `peers` that may read it. */
  onComment(c: CommentPeer, m: CommentPatchMsg, peers: Iterable<CommentPeer>): void;
  /** A connection closed: forget its rate bucket. */
  forget(c: CommentPeer): void;
  /** The stream's newest seq. */
  head(): number;
}

const WRITE_ROLES: ReadonlySet<string> = new Set(["owner", "editor"]);
/** Roles that may comment (PLAN §14): everyone but viewers. */
export const COMMENT_ROLES: ReadonlySet<string> = new Set(["owner", "editor", "commenter"]);

/** May this session read comments on `cut`? (A scoped reader, such as a watch link, only its cuts.) */
export function mayReadComments(auth: AuthContext, cut: string): boolean {
  return WRITE_ROLES.has(auth.role) || !auth.branches || auth.branches.includes(cut);
}

/** May this session comment on `cut`? */
export function mayComment(auth: AuthContext, cut: string): boolean {
  return COMMENT_ROLES.has(auth.role) && (!auth.branches || auth.branches.includes(cut));
}

const DDL = [
  "CREATE TABLE IF NOT EXISTS comments (id TEXT NOT NULL PRIMARY KEY, seq INTEGER NOT NULL, cut TEXT NOT NULL, row TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS comment_log (seq INTEGER NOT NULL PRIMARY KEY, id TEXT NOT NULL, cut TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS comment_meta (k TEXT NOT NULL PRIMARY KEY, v INTEGER NOT NULL) WITHOUT ROWID",
];

export function createCommentRoom(opts: CommentRoomOptions): CommentRoom {
  const db = opts.storage;
  const clock = opts.clock ?? (() => Date.now());
  const lim = { ...LIMITS, ...opts.limits };
  let ready = false;
  const init = () => {
    if (ready) return;
    for (const s of DDL) db.exec(s);
    ready = true;
  };
  const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0);
  const head = (): number => {
    init();
    return num(db.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM comment_log")[0]?.m ?? 0);
  };
  const get = (id: string): Comment | undefined => {
    const r = db.exec<{ row: string }>("SELECT row FROM comments WHERE id = ?", id)[0];
    return r ? (JSON.parse(r.row) as Comment) : undefined;
  };
  const count = (): number => num(db.exec<{ v: number }>("SELECT v FROM comment_meta WHERE k = 'count'")[0]?.v ?? 0);

  // per connection: LIMITS.burst patches at once, refilled at LIMITS.perSec (presence's bucket, slower)
  const buckets = new WeakMap<CommentPeer, { tokens: number; at: number }>();
  const take = (c: CommentPeer): number => {
    const now = clock();
    const b = buckets.get(c) ?? { tokens: lim.burst, at: now };
    b.tokens = Math.min(lim.burst, b.tokens + ((now - b.at) / 1000) * lim.perSec);
    b.at = now;
    buckets.set(c, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) / lim.perSec) * 1000));
  };

  const answer = (c: CommentPeer, m: CommentPatchMsg, a: Partial<CommentAnswerMsg>) =>
    c.send({ type: "commentAnswer", branchId: m.branchId, n: m.n, id: typeof m.id === "string" ? m.id.slice(0, LIMITS.id) : "", ...a });
  const refuse = (c: CommentPeer, m: CommentPatchMsg, refused: CommentRefusal, reason: string, retryMs?: number) => answer(c, m, { refused, reason, ...(retryMs ? { retryMs } : {}) });

  return {
    head,
    forget(c) {
      buckets.delete(c);
    },
    onComments(c, m) {
      init();
      const since = typeof m.since === "number" && Number.isInteger(m.since) && m.since >= 0 ? m.since : 0;
      const top = head();
      // a position past the stream's end: this server's rows were reset (or the client's are another server's)
      const reset = since > top;
      const from = reset ? 0 : since;
      const scanned = db.exec<{ seq: number; cut: string; row: string }>(
        "SELECT l.seq AS seq, l.cut AS cut, c.row AS row FROM comment_log l JOIN comments c ON c.id = l.id WHERE l.seq > ? ORDER BY l.seq LIMIT ?",
        from,
        lim.page,
      );
      const rows: Comment[] = [];
      // a page stops at its byte budget (at least one row), so it never needs an envelope: 500 rows of 10,000-character
      // bodies would be 5 MB
      let bytes = 0,
        last = from;
      for (const r of scanned) {
        if (rows.length && bytes + r.row.length > lim.pageBytes) break;
        last = num(r.seq);
        if (!mayReadComments(c.auth, r.cut)) continue;
        rows.push(JSON.parse(r.row) as Comment);
        bytes += r.row.length;
      }
      const more = last < top && (scanned.length === lim.page || last < num(scanned[scanned.length - 1]?.seq ?? last));
      c.send({ type: "comments", branchId: m.branchId, rows, head: more ? last : top, reply: true, ...(more ? { more: true } : {}), ...(reset ? { reset: true } : {}) });
    },
    onComment(c, m, peers) {
      init();
      if (typeof m.n !== "number") return; // nothing to answer to
      if (!validId(m.id)) return refuse(c, m, "bad-request", "a comment id is up to 100 of [A-Za-z0-9._:~-]");
      let bytes = 0;
      try {
        bytes = JSON.stringify(m.patch).length;
      } catch {
        return refuse(c, m, "bad-request", "patch isn't JSON");
      }
      if (bytes > LIMITS.messageBytes) return refuse(c, m, "bad-request", "a comment is at most 64 KB");
      const why = patchProblem(m.patch);
      if (why) return refuse(c, m, "bad-request", why);
      // the thread's cut decides who may see and write it; a cut this session can't read gets the answer an absent
      // comment gets, so a scoped link learns nothing of other cuts' comments
      const p = m.patch;
      const cur = get(m.id);
      const parent = p.add?.replyTo !== undefined ? get(p.add.replyTo) : undefined;
      const cut = cur?.cut ?? parent?.cut ?? (p.add?.replyTo === undefined ? p.add?.cut : undefined);
      // (a new thread names its own cut: refused below as forbidden, which tells the writer nothing it didn't say)
      const own = !cur && !parent && p.add?.replyTo === undefined;
      if (cut === undefined || (!own && !mayReadComments(c.auth, cut))) return refuse(c, m, "not-found", p.add?.replyTo !== undefined && !cur ? "the comment this replies to isn't there" : "no such comment");
      if (!mayComment(c.auth, cut)) return refuse(c, m, "forbidden", c.auth.role === "viewer" ? "viewers can read comments but not write them" : "this link can't comment on that cut");
      const wait = take(c);
      if (wait) return refuse(c, m, "rate-limited", "too many comments at once", wait);
      if (!cur && p.add && count() >= lim.perProject) return refuse(c, m, "too-many", `a project has at most ${lim.perProject} comments`);
      const name = (opts.nameOf?.(c.auth) ?? p.author.name).slice(0, LIMITS.name);
      const who = { id: c.auth.account, name, ...(p.author.agent ? { agent: p.author.agent } : {}) };
      const res = applyPatch(cur, m.id, p, who, (id) => (id === p.add?.replyTo ? parent : get(id)), clock());
      if (!res.ok) return refuse(c, m, res.refused, res.reason);
      if (!res.changed) return answer(c, m, { row: cur });
      let row!: Comment;
      db.transaction(() => {
        const seq = head() + 1;
        row = { ...res.row, seq };
        if (cur?.seq !== undefined) db.exec("DELETE FROM comment_log WHERE seq = ?", cur.seq);
        db.exec("INSERT INTO comment_log (seq, id, cut) VALUES (?, ?, ?)", seq, m.id, row.cut);
        db.exec("INSERT INTO comments (id, seq, cut, row) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, cut = excluded.cut, row = excluded.row", m.id, seq, row.cut, JSON.stringify(row));
        if (!cur) db.exec("INSERT INTO comment_meta (k, v) VALUES ('count', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1");
      });
      answer(c, m, { row });
      for (const o of peers) if (o !== c && mayReadComments(o.auth, row.cut)) o.send({ type: "comments", branchId: row.cut, rows: [row], head: row.seq! });
    },
  };
}
