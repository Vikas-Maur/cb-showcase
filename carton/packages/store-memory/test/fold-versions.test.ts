// History's fold, restore and several-change versions (UI audit 2026-11-02):
// - P1-3: a partial fold recorded a change nobody made ("Changed 'W4' font size 60 → 100", the inverse of what was left
//   out) and its fold row said only "Moved 'clip.mp4' …". It is one version, titled as a fold, credited to whoever
//   folded, holding exactly the chosen changes.
// - P1-4: "You can fold in the rest later": leftOut() finds a partial fold's left-out part until it is folded in.
// - P1-5: a version of several changes read as its first one; a restore didn't say it was one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type Version } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director: Actor = { kind: "agent", id: "director/c1/t1", name: "Director", chat: "c1", turn: "t1" };
const claude: Actor = { kind: "agent", id: "claude-code/ab12cd34", name: "Claude Code" };
const open = () => Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });

/** A cut "Client review" with three changes by three authors, as in the audit. */
async function review() {
  const c = await open();
  const main = c.cut;
  const v = await c.fork("Client review");
  await c.commit({ cut: v.id, ops: [set("a", "startTime", 2), set("a", "endTime", 7)], author: alice });
  await c.commit({ cut: v.id, ops: [set("b", "name", "Alternate opening")], author: director });
  await c.commit({ cut: v.id, ops: [set("d", "name", "Lower third")], author: claude });
  return { c, main, v };
}
const top = async (c: Carton, cut: string): Promise<Version> => (await c.log({ cut, limit: 1, summary: true }))[0]!;

test("P1-3: a partial fold is one version, titled as a fold, by whoever folded, with exactly the chosen changes", async () => {
  const { c, main, v } = await review();
  const before = (await c.log({ cut: main })).length;
  const r = await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  assert.equal(r.status, "confirmed");
  const log = await c.log({ cut: main, summary: true });
  assert.equal(log.length, before + 1, "one version for the fold, not the fold and its inverse");
  const f = log[0]!;
  assert.equal(f.author?.id, "alice", "credited to whoever folded");
  // a fold reads as a fold (cb history, agents): kind merge, with what it left out
  assert.deepEqual([f.kind, f.rejected], ["merge", ["items/d"]]);
  assert.equal(f.summary, "Folded 'Client review' into 'Main cut': 2 of 3 changes");
  assert.deepEqual(f.details, ["Moved 'a' 0.0 s → 2.0 s", 'Changed \'b\' name "b" → "Alternate opening"'], "exactly the chosen changes, nothing about 'd'");
  // the version's state is the chosen one, and nothing in History says 'd' changed
  const head = await c.checkout(`${main}@${f.ref.seq}`);
  assert.deepEqual([item(head, "a")!.startTime, item(head, "b")!.name, item(head, "d")!.name], [2, "Alternate opening", "d"]);
  for (const x of log) assert.doesNotMatch(`${x.summary ?? ""} ${(x.details ?? []).join(" ")}`, /'d'/, `${x.kind} ${x.summary}`);
  // the same through log() pages: the pair is never split into two versions
  const paged = await c.log({ cut: main, before: f.ref.seq, limit: 1 });
  assert.notEqual(paged[0]?.kind, "merge", "the fold's own row isn't a version");
});

test("P1-5: a full fold and a restore say what they did; a version of several changes is summed up, all listed", async () => {
  const { c, main, v } = await review();
  assert.equal((await c.fold(v.id, { into: main, author: alice })).status, "confirmed");
  const f = await top(c, main);
  assert.equal(f.summary, "Folded 'Client review' into 'Main cut': 3 changes");
  assert.equal(f.details?.length, 3);
  await c.commit({ ops: [set("a", "startTime", 0), set("a", "endTime", 5), set("c", "name", "C1"), set("e", "name", "E1")], author: alice });
  const e = await top(c, main);
  assert.equal(e.summary, "Moved 'a', changed 'c' and 'e'");
  assert.equal(e.details?.length, 3);
  await c.restore(`${main}@0`, { author: alice });
  const r = await top(c, main);
  assert.equal(r.summary, "Restored an earlier version");
  assert.ok((r.details?.length ?? 0) >= 3, "what the restore changed is listed");
  // one change: its line, nothing to expand
  await c.commit({ ops: [set("f", "name", "F1")], author: alice });
  const one = await top(c, main);
  assert.equal(one.summary, 'Changed \'f\' name "f" → "F1"');
  assert.equal(one.details, undefined);
});

test("P1-4: a partial fold's left-out part stays foldable: leftOut() finds it until it is folded in", async () => {
  const { c, main, v } = await review();
  assert.deepEqual(await c.leftOut(v.id, { into: main }), [], "nothing left out yet");
  await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  const left = await c.leftOut(v.id, { into: main });
  assert.equal(left.length, 1);
  assert.deepEqual(left[0]!.rejected, ["items/d"]);
  assert.equal((await c.fold(v.id, { into: main, check: true })).status, "up-to-date", "a plain fold still finds nothing new (§5.3)");
  // folding in the rest: the head gets 'd', and nothing is left out any more
  assert.equal((await c.revert(left[0]!.change, { cut: main, author: alice })).status, "confirmed");
  assert.equal(item((await c.head(main)).doc, "d")!.name, "Lower third");
  assert.deepEqual(await c.leftOut(v.id, { into: main }), []);
  const rest = await top(c, main);
  assert.equal(rest.summary, "Folded the rest of 'Client review' into 'Main cut': 1 change");
  // another cut's partial folds aren't this one's
  const w = await c.fork("Other", { from: `${v.id}@0` });
  assert.deepEqual(await c.leftOut(w.id, { into: main }), []);
});

test("P1-4: a left-out part changed on Main since is no longer offered as left out", async () => {
  const { c, main, v } = await review();
  await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  await c.commit({ cut: main, ops: [set("d", "name", "Main's own")], author: alice });
  assert.deepEqual(await c.leftOut(v.id, { into: main }), []);
});

test("P1-3: a Published cut's newer versions count a partial fold once, as log() lists it", async () => {
  const { c, main, v } = await review();
  await c.publish({ from: main, author: alice });
  await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  const [p] = await c.publications();
  assert.equal(p!.versions, 1, "one version since the publication");
  assert.equal(p!.newer, true);
});

test("P1-4 (review #2): folding in the rest, then undoing that, leaves the rest left out, and foldable again", async () => {
  const { c, main, v } = await review();
  await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  const [left] = await c.leftOut(v.id, { into: main });
  assert.equal((await c.revert(left!.change, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual(await c.leftOut(v.id, { into: main }), []);
  assert.equal((await c.undo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.equal(item((await c.head(main)).doc, "d")!.name, "d", "the undo left 'd' out again");
  assert.deepEqual((await c.leftOut(v.id, { into: main })).map((x) => x.change), [left!.change], "and it can be folded in again");
  // a redo folds it in again: nothing left out
  assert.equal((await c.redo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual(await c.leftOut(v.id, { into: main }), []);
});

// Final re-check, baseline P3-2: an Undo right after a Restore read as a fresh edit ("Added effect 'sharpen' on
// 'clip.mp4'"), with nothing naming the restore. It says what it undid, as a restore and a fold say what they were;
// its changes are its details. The redo of it says so too.
test("baseline P3-2: the undo of a restore says it undid the restore, its redo that it redid it; the changes are listed", async () => {
  const c = await open();
  const main = c.cut;
  await c.commit({ ops: [set("a", "name", "A1")], author: alice });
  await c.commit({ ops: [set("b", "name", "B1")], author: alice });
  await c.restore(`${main}@1`, { author: alice });
  assert.equal((await top(c, main)).summary, "Restored an earlier version");
  assert.equal((await c.undo(undefined, { author: alice })).status, "confirmed");
  const u = await top(c, main);
  assert.equal(u.kind, "undo");
  assert.equal(u.summary, "Undid the restore");
  assert.deepEqual(u.details, ['Changed \'b\' name "b" → "B1"'], "what the undo changed");
  assert.equal((await c.redo(undefined, { author: alice })).status, "confirmed");
  const r = await top(c, main);
  assert.equal(r.summary, "Redid the restore");
  assert.deepEqual(r.details, ['Changed \'B1\' name "B1" → "b"']);
  // any other undo still reads as what it did
  await c.commit({ ops: [set("c", "name", "C1")], author: alice });
  await c.undo(undefined, { author: alice });
  assert.equal((await top(c, main)).summary, 'Changed \'C1\' name "C1" → "c"');
});
