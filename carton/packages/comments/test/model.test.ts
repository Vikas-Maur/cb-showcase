// The comment rules (model.ts): what a patch may hold, who may do what, retries, merging pending patches, threads.
import test from "node:test";
import assert from "node:assert/strict";
import { applyPatch, mergePatch, patchProblem, threadsOf, newCommentId, validId } from "../src/model.ts";
import type { Comment, CommentPatch } from "../src/types.ts";
import { ME, BOB } from "./helpers.ts";

const NOW = 1_000_000;
const none = () => undefined;
const add = (body: string, extra: Partial<NonNullable<CommentPatch["add"]>> = {}, author = ME): CommentPatch => ({ add: { body, cut: "main", at: NOW, ...extra }, at: NOW, author });
function created(id = "c1", body = "Too long here", author = ME): Comment {
  const r = applyPatch(undefined, id, add(body, {}, author), author, none, NOW);
  assert.ok(r.ok);
  return r.row;
}

test("a new comment is its author's, on its cut, at its time", () => {
  const c = created();
  assert.deepEqual(c, { id: "c1", author: ME, body: "Too long here", cut: "main", at: NOW });
});

test("only the author edits or deletes; anyone who may comment resolves and reopens", () => {
  const c = created();
  const edited = applyPatch(c, "c1", { body: "Too long", at: NOW + 1, author: BOB }, BOB, none, NOW);
  assert.deepEqual(edited.ok ? null : edited.refused, "forbidden");
  const del = applyPatch(c, "c1", { deleted: true, at: NOW + 1, author: BOB }, BOB, none, NOW);
  assert.deepEqual(del.ok ? null : del.refused, "forbidden");
  const res = applyPatch(c, "c1", { resolved: true, at: NOW + 2, author: BOB }, BOB, none, NOW);
  assert.ok(res.ok && res.changed);
  assert.deepEqual(res.row.resolved, { by: BOB, at: NOW + 2 });
  const reopened = applyPatch(res.row, "c1", { resolved: false, at: NOW + 3, author: ME }, ME, none, NOW);
  assert.ok(reopened.ok && reopened.changed && reopened.row.resolved === undefined);
  const mine = applyPatch(c, "c1", { body: "Too long", at: NOW + 4, author: ME }, ME, none, NOW);
  assert.ok(mine.ok && mine.row.body === "Too long" && mine.row.editedAt === NOW + 4);
});

test("a deleted comment keeps its place for its replies: no body, no more edits", () => {
  const c = created();
  const d = applyPatch(c, "c1", { deleted: true, at: NOW + 1, author: ME }, ME, none, NOW);
  assert.ok(d.ok && d.row.deleted && d.row.body === "");
  const e = applyPatch(d.row, "c1", { body: "back", at: NOW + 2, author: ME }, ME, none, NOW);
  assert.equal(e.ok ? null : e.refused, "not-found");
});

test("replies go to a thread's first comment and take its cut; a reply can't be resolved", () => {
  const root = created();
  const r = applyPatch(undefined, "r1", add("Agreed", { replyTo: "c1", cut: "other" }, BOB), BOB, (id) => (id === "c1" ? root : undefined), NOW);
  assert.ok(r.ok);
  assert.equal(r.row.cut, "main", "a reply is on its thread's cut whatever the writer said");
  const nested = applyPatch(undefined, "r2", add("Nested", { replyTo: "r1" }), ME, (id) => (id === "r1" ? r.row : undefined), NOW);
  assert.equal(nested.ok ? null : nested.refused, "bad-request");
  const missing = applyPatch(undefined, "r3", add("?", { replyTo: "nope" }), ME, none, NOW);
  assert.equal(missing.ok ? null : missing.refused, "not-found");
  const res = applyPatch(r.row, "r1", { resolved: true, at: NOW, author: ME }, ME, none, NOW);
  assert.equal(res.ok ? null : res.refused, "bad-request");
});

test("a retried add is not stored twice; its text, edited since, lands as an edit; another author can't take the id", () => {
  const c = created();
  const same = applyPatch(c, "c1", add("Too long here"), ME, none, NOW);
  assert.ok(same.ok && !same.changed && same.row === c);
  const editedSince = applyPatch(c, "c1", add("Much too long here"), ME, none, NOW);
  assert.ok(editedSince.ok && editedSince.changed && editedSince.row.body === "Much too long here");
  const taken = applyPatch(c, "c1", add("mine now", {}, BOB), BOB, none, NOW);
  assert.equal(taken.ok ? null : taken.refused, "conflict");
});

test("a patch that changes nothing changes nothing (a retried resolve, an unchanged body)", () => {
  const c = created();
  for (const p of [{ resolved: false }, { body: c.body }]) {
    const r = applyPatch(c, "c1", { ...p, at: NOW, author: ME }, ME, none, NOW);
    assert.ok(r.ok && !r.changed && r.row === c);
  }
});

test("a writer's clock far ahead is pulled back to the receiver's plus 5 minutes", () => {
  const r = applyPatch(undefined, "c1", { add: { body: "x", cut: "main", at: NOW + 3_600_000 }, at: NOW + 3_600_000, author: ME }, ME, none, NOW);
  assert.ok(r.ok && r.row.at === NOW + 300_000);
});

test("patches are checked for shape and size", () => {
  const ok = add("fine", { anchor: { cut: "main", seq: 3, state: "ab12", range: [1, 2], items: [{ id: "a", at: 1 }], sig: "00ff" } });
  assert.equal(patchProblem(ok), undefined);
  const bad: [string, unknown][] = [
    ["not an object", 7],
    ["empty body", add("   ")],
    ["too long", add("x".repeat(10_001))],
    ["unknown field", { ...add("x"), admin: true }],
    ["changes nothing", { at: NOW, author: ME }],
    ["bad author", { body: "x", at: NOW, author: { id: "", name: "x" } }],
    ["anchor cut differs", add("x", { anchor: { cut: "other", seq: 1, state: "ab" } })],
    ["reversed range", add("x", { anchor: { cut: "main", seq: 1, state: "ab", range: [5, 2] } })],
    ["infinite time", add("x", { anchor: { cut: "main", seq: 1, state: "ab", range: [0, Infinity] } })],
    ["state not hex", add("x", { anchor: { cut: "main", seq: 1, state: "zz" } })],
    ["too many items", add("x", { anchor: { cut: "main", seq: 1, state: "ab", items: Array.from({ length: 17 }, (_, i) => ({ id: `i${i}`, at: 0 })) } })],
    ["a reply with an anchor", add("x", { replyTo: "c1", anchor: { cut: "main", seq: 1, state: "ab" } })],
    ["deleted false", { deleted: false, at: NOW, author: ME }],
  ];
  for (const [what, p] of bad) assert.ok(patchProblem(p), what);
  assert.ok(validId(newCommentId()) && newCommentId() !== newCommentId());
  assert.ok(!validId("a b") && !validId("x".repeat(101)) && !validId(""));
});

test("pending patches of one comment merge into one that does what both did", () => {
  const a = add("first");
  const m1 = mergePatch(a, { body: "second", at: NOW + 1, author: ME });
  assert.deepEqual(m1.add?.body, "second");
  assert.equal(m1.body, undefined, "an unsent add carries the latest text");
  const m2 = mergePatch(m1, { resolved: true, at: NOW + 2, author: ME });
  const m3 = mergePatch(m2, { deleted: true, at: NOW + 3, author: ME });
  assert.deepEqual({ resolved: m3.resolved, deleted: m3.deleted, at: m3.at }, { resolved: true, deleted: true, at: NOW + 3 });
  const r = applyPatch(undefined, "c1", m3, ME, none, NOW);
  assert.ok(r.ok && r.row.deleted && r.row.resolved);
  const e = mergePatch({ body: "a", at: 1, author: ME }, { resolved: false, at: 2, author: ME });
  assert.deepEqual(e, { body: "a", resolved: false, at: 2, author: ME });
});

test("threads: first comments with their replies, oldest first; an orphan reply waits", () => {
  const t1 = { ...created("t1"), at: 10 };
  const t2 = { ...created("t2"), at: 5 };
  const r1 = { id: "r1", replyTo: "t1", author: BOB, body: "b", cut: "main", at: 30 };
  const r0 = { id: "r0", replyTo: "t1", author: BOB, body: "a", cut: "main", at: 20 };
  const orphan = { id: "o", replyTo: "zzz", author: BOB, body: "?", cut: "main", at: 1 };
  const th = threadsOf([r1, t1, orphan, t2, r0]);
  assert.deepEqual(th.map((t) => [t.root.id, t.replies.map((r) => r.id)]), [["t2", []], ["t1", ["r0", "r1"]]]);
});
