// The comment rules, shared by the local store, the client and the server so all three agree: what a patch may
// contain, who may do what, and how a patch changes a comment. Pure functions over plain records.

import { LIMITS, type Anchor, type Comment, type CommentAuthor, type CommentPatch, type CommentRefusal } from "./types.ts";

export type PatchResult = { ok: true; row: Comment; changed: boolean } | { ok: false; refused: CommentRefusal; reason: string };

const ID_RE = /^[A-Za-z0-9._:~-]+$/;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e14;
const isSec = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= LIMITS.maxTime;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const extra = (o: Record<string, unknown>, allowed: readonly string[]): string | undefined => Object.keys(o).find((k) => !allowed.includes(k));

/** A comment id: what clients make (`newCommentId`), at most `LIMITS.id` characters of `[A-Za-z0-9._:~-]`. */
export function validId(id: unknown): id is string {
  return isStr(id, LIMITS.id) && ID_RE.test(id);
}

/** A body: some text that isn't only white space, at most `LIMITS.body` UTF-16 code units. */
export function validBody(body: unknown): body is string {
  return typeof body === "string" && body.length <= LIMITS.body && body.trim().length > 0;
}

/** Why an author record is malformed, or undefined. */
function authorProblem(a: unknown): string | undefined {
  if (!isPlain(a)) return "author must be an object";
  if (extra(a, ["id", "name", "agent"])) return "author has an unknown field";
  if (!isStr(a.id, LIMITS.name)) return "author.id must be a short string";
  if (typeof a.name !== "string" || a.name.length > LIMITS.name) return "author.name must be a short string";
  if (a.agent !== undefined && !isStr(a.agent, LIMITS.name)) return "author.agent must be a short string";
  return undefined;
}

/** Why an anchor is malformed, or undefined. */
export function anchorProblem(a: unknown): string | undefined {
  if (!isPlain(a)) return "anchor must be an object";
  if (extra(a, ["cut", "seq", "state", "range", "items", "sig"])) return "anchor has an unknown field";
  if (!isStr(a.cut, LIMITS.name)) return "anchor.cut must be a cut id";
  if (typeof a.seq !== "number" || !Number.isInteger(a.seq) || a.seq < 0) return "anchor.seq must be a version number";
  if (!isStr(a.state, 128) || !/^[0-9a-f]+$/.test(a.state)) return "anchor.state must be a state hash";
  if (a.range !== undefined) {
    const r = a.range;
    if (!Array.isArray(r) || r.length !== 2 || !isSec(r[0]) || !isSec(r[1]) || r[1] < r[0]) return "anchor.range must be [start, end] seconds";
  }
  if (a.items !== undefined) {
    if (!Array.isArray(a.items) || a.items.length > LIMITS.anchorItems) return "anchor.items must be at most 16 items";
    for (const it of a.items) {
      if (!isPlain(it) || extra(it, ["id", "at", "dt", "media"]) || !isStr(it.id, LIMITS.name)) return "anchor.items must be {id, at, dt?, media?}";
      if (typeof it.at !== "number" || !Number.isFinite(it.at) || Math.abs(it.at) > LIMITS.maxTime) return "anchor.items[].at must be seconds";
      if (it.dt !== undefined && !isSec(it.dt)) return "anchor.items[].dt must be seconds";
      if (it.media !== undefined && !isStr(it.media, LIMITS.name)) return "anchor.items[].media must be a short string";
    }
  }
  if (a.sig !== undefined && !(isStr(a.sig, 64) && /^[0-9a-f]+$/.test(a.sig))) return "anchor.sig must be hex";
  return undefined;
}

/** Why a patch is malformed (shape and sizes only; who may apply it is `applyPatch`'s question), or undefined. */
export function patchProblem(p: unknown): string | undefined {
  if (!isPlain(p)) return "patch must be an object";
  if (extra(p, ["add", "body", "resolved", "deleted", "at", "author"])) return "patch has an unknown field";
  if (!isTime(p.at)) return "patch.at must be a time";
  const ap = authorProblem(p.author);
  if (ap) return ap;
  if (p.add !== undefined) {
    const a = p.add;
    if (!isPlain(a) || extra(a, ["replyTo", "body", "anchor", "cut", "at"])) return "patch.add must be {replyTo?, body, anchor?, cut, at}";
    if (!validBody(a.body)) return "a comment needs some text, at most 10,000 characters";
    if (!isStr(a.cut, LIMITS.name)) return "patch.add.cut must be a cut id";
    if (!isTime(a.at)) return "patch.add.at must be a time";
    if (a.replyTo !== undefined) {
      if (!validId(a.replyTo)) return "patch.add.replyTo must be a comment id";
      if (a.anchor !== undefined) return "a reply has no anchor of its own";
    }
    if (a.anchor !== undefined) {
      const why = anchorProblem(a.anchor);
      if (why) return why;
      if ((a.anchor as Anchor).cut !== a.cut) return "patch.add.cut must be the anchor's cut";
    }
  }
  if (p.body !== undefined && !validBody(p.body)) return "a comment needs some text, at most 10,000 characters";
  if (p.resolved !== undefined && typeof p.resolved !== "boolean") return "patch.resolved must be true or false";
  if (p.deleted !== undefined && p.deleted !== true) return "patch.deleted must be true";
  if (p.add === undefined && p.body === undefined && p.resolved === undefined && p.deleted === undefined) return "patch changes nothing";
  return undefined;
}

/** How far ahead of the receiver's clock a writer's time may be (clock skew); later times are pulled back. */
const SKEW_MS = 5 * 60_000;

/**
 * Apply a patch to a comment (`cur`, undefined for a new one) as `who`. The rules:
 * - anyone who may comment adds comments and replies (the caller checks the role and the cut scope);
 * - only a comment's author changes its body or deletes it;
 * - anyone who may comment resolves or reopens a thread (its first comment);
 * - a retried add by its author is not an error: what it carries is applied as an edit (exactly once in effect);
 * - a patch that changes nothing changes nothing (`changed: false`), so a retry is never stored twice.
 * `parent` looks up a thread's first comment for a reply. `now` caps writers' times at the receiver's clock plus skew.
 */
export function applyPatch(cur: Comment | undefined, id: string, p: CommentPatch, who: CommentAuthor, parent: (id: string) => Comment | undefined, now: number): PatchResult {
  const when = Math.min(p.at, now + SKEW_MS);
  let row: Comment;
  if (p.add) {
    if (cur) {
      if (cur.author.id !== who.id) return { ok: false, refused: "conflict", reason: "this comment id is someone else's" };
      row = cur;
      // the add was applied before (a retry whose answer was lost); the text it carries now is an edit
      if (p.add.body !== cur.body && !cur.deleted) row = { ...row, body: p.add.body, editedAt: when };
    } else {
      let cut = p.add.cut;
      if (p.add.replyTo !== undefined) {
        const top = parent(p.add.replyTo);
        if (!top) return { ok: false, refused: "not-found", reason: "the comment this replies to isn't there" };
        if (top.replyTo !== undefined) return { ok: false, refused: "bad-request", reason: "a reply goes to a thread's first comment" };
        cut = top.cut;
      }
      row = {
        id,
        ...(p.add.replyTo !== undefined ? { replyTo: p.add.replyTo } : {}),
        author: who,
        body: p.add.body,
        ...(p.add.anchor ? { anchor: p.add.anchor } : {}),
        cut,
        at: Math.min(p.add.at, now + SKEW_MS),
      };
    }
  } else {
    if (!cur) return { ok: false, refused: "not-found", reason: "no such comment" };
    row = cur;
  }
  const mine = row.author.id === who.id;
  if (p.body !== undefined && p.body !== row.body) {
    if (!mine) return { ok: false, refused: "forbidden", reason: "only its author can edit a comment" };
    if (row.deleted) return { ok: false, refused: "not-found", reason: "this comment was deleted" };
    row = { ...row, body: p.body, editedAt: when };
  }
  if (p.resolved !== undefined && p.resolved !== !!row.resolved) {
    if (row.replyTo !== undefined) return { ok: false, refused: "bad-request", reason: "a thread is resolved by its first comment" };
    if (p.resolved) row = { ...row, resolved: { by: who, at: when } };
    else {
      const { resolved: _, ...rest } = row;
      row = rest;
    }
  }
  if (p.deleted && !row.deleted) {
    if (!mine) return { ok: false, refused: "forbidden", reason: "only its author can delete a comment" };
    const { editedAt: _, ...rest } = row;
    row = { ...rest, body: "", deleted: true, editedAt: when };
  }
  return { ok: true, row, changed: row !== cur };
}

/** Two patches of one comment as one (`older` was made first). The result does what both did, in order. */
export function mergePatch(older: CommentPatch, newer: CommentPatch): CommentPatch {
  const out: CommentPatch = { at: newer.at, author: newer.author };
  const add = older.add ?? newer.add;
  const body = newer.body ?? older.body;
  if (add) out.add = body !== undefined ? { ...add, body } : add;
  else if (body !== undefined) out.body = body;
  const resolved = newer.resolved ?? older.resolved;
  if (resolved !== undefined) out.resolved = resolved;
  if (older.deleted || newer.deleted) out.deleted = true;
  return out;
}

/** A thread: its first comment and the replies, oldest first. */
export interface Thread {
  root: Comment;
  replies: Comment[];
}

const byTime = (a: Comment, b: Comment) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Comments as threads, oldest thread first. A reply whose thread isn't known yet waits (it isn't shown alone). */
export function threadsOf(comments: Iterable<Comment>): Thread[] {
  const roots = new Map<string, Thread>();
  const replies: Comment[] = [];
  for (const c of comments) {
    if (c.replyTo === undefined) roots.set(c.id, { root: c, replies: [] });
    else replies.push(c);
  }
  for (const r of replies) roots.get(r.replyTo!)?.replies.push(r);
  const out = [...roots.values()];
  for (const t of out) t.replies.sort(byTime);
  return out.sort((a, b) => byTime(a.root, b.root));
}

/** A fresh comment id: 16 random hex characters after a `c` (ids are made by the writer, so a retry keeps its id). */
export function newCommentId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "c";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
