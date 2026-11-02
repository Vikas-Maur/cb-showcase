// Laptop P2-1 (merge/prod-2 @ 3b2407c3, 3 of 3 by two people): Fold "Alt" in with the split left out (main@5 "merge (1
// left out)"), fold in the rest (main@6), then Ctrl+Z ① undid the rest (main@7) and Ctrl+Z ② (main@8, "Undid the fold of
// 'Alt' into 'Main cut'") brought the rest back in: `cb compare 7 8` read "Split 'clip.mp4' at 1.5 s". Ctrl+Z ③ undid
// the fold. The undo stack listed the fold-some's two changes (the fold and its partial revert) as two entries. Now a
// fold-some is one undo: ① the rest, ② the whole partial fold, each named for what it undid, and redo walks forward.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CommitResult, type Version } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
const top = async (c: Carton, cut: string): Promise<Version> => (await c.log({ cut, limit: 1, summary: true }))[0]!;
/** a's start, b's name and d's name: what the fold brings in (d is left out, then folded in as the rest). */
const state = async (c: Carton, cut: string) => {
  const d = (await c.head(cut)).doc;
  return [item(d, "a")!.startTime, item(d, "b")!.name, item(d, "d")!.name];
};
const BEFORE = [0, "b", "d"], SOME = [2, "Alternate opening", "d"], ALL = [2, "Alternate opening", "Lower third"];

async function review(c: Carton) {
  const v = await c.fork("Client review", { from: `${c.cut}@0` });
  await c.commit({ cut: v.id, ops: [set("a", "startTime", 2), set("a", "endTime", 7)], author: alice });
  await c.commit({ cut: v.id, ops: [set("b", "name", "Alternate opening")], author: alice });
  await c.commit({ cut: v.id, ops: [set("d", "name", "Lower third")], author: alice });
  return v;
}
const FOLD = "Undid the fold of 'Client review' into 'Main cut'";
const REST = "Undid the fold of the rest of 'Client review' into 'Main cut'";

test("P2-1: fold-some, the rest, then ⌘Z ① undoes the rest and ⌘Z ② the whole fold-some, each named right; redo walks forward", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const main = c.cut;
  const v = await review(c);
  assert.equal((await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice })).status, "confirmed");
  assert.equal((await top(c, main)).summary, "Folded 'Client review' into 'Main cut': 2 of 3 changes");
  const [left] = await c.leftOut(v.id, { into: main });
  assert.equal((await c.revert(left!.change, { cut: main, author: alice })).status, "confirmed");
  const rest = (await top(c, main)).ref.seq;
  assert.deepEqual(await state(c, main), ALL);

  assert.equal((await c.undo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [SOME, REST], "① the rest");
  const u2 = await c.undo(undefined, { cut: main, author: alice });
  assert.equal(u2.status, "confirmed");
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [BEFORE, FOLD], "② the whole partial fold");
  // `cb compare` of ① → ② is the fold-some's kept changes undone, never the rest brought back in
  const cmp = await c.diff(`${main}@${rest + 1}`, `${main}@${rest + 2}`);
  assert.deepEqual(cmp.describe, ["Moved 'a' 2.0 s → 0.0 s", 'Changed \'Alternate opening\' name "Alternate opening" → "b"']);
  assert.deepEqual(await c.undoStack(undefined, { cut: main }), [], "two actions, two presses: nothing is left to undo");
  assert.deepEqual(await c.leftOut(v.id, { into: main }), [], "and no rest to fold in: the partial fold is undone");

  assert.equal((await c.redo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [SOME, "Redid the fold of 'Client review' into 'Main cut'"]);
  assert.equal((await c.leftOut(v.id, { into: main })).length, 1, "the rest is left out again, to fold in");
  assert.equal((await c.redo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [ALL, "Redid the fold of the rest of 'Client review' into 'Main cut'"]);
  assert.deepEqual(await c.redoStack(undefined, { cut: main }), []);
  // and back again: the redid rest, then the redid partial fold
  await c.undo(undefined, { cut: main, author: alice });
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [SOME, REST]);
  await c.undo(undefined, { cut: main, author: alice });
  assert.deepEqual([await state(c, main), (await top(c, main)).summary], [BEFORE, FOLD]);
});

test("P2-1: a fold-some on its own: ⌘Z puts Main back as it was before it; undo, redo, undo; its Undo reads as the fold", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const main = c.cut;
  const v = await review(c);
  await c.foldSome(v.id, { into: main, reject: ["items/d"], author: alice });
  const [entry, ...more] = await c.undoStack(undefined, { cut: main });
  assert.equal(more.length, 0, "one entry");
  assert.equal(entry!.label, "Undo Moved 'a' 0.0 s → 2.0 s", "what the fold kept (as a whole fold's entry reads), not the partial revert's own change");
  // review #4: its undo, the redo stack and the redo read as a whole fold's do, never by the partial revert's kind
  const u = await c.undo(undefined, { cut: main, author: alice });
  assert.equal(u.entry?.label, "Undo merge");
  assert.equal((await c.redoStack(undefined, { cut: main }))[0]?.label, "Redo merge");
  const r = await c.redo(undefined, { cut: main, author: alice });
  assert.equal(r.entry?.label, "Redo merge");
  assert.equal((await c.undo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.equal((await c.redo(undefined, { cut: main, author: alice })).status, "confirmed");
  assert.deepEqual(await state(c, main), SOME);
  const said: string[] = [];
  for (const step of ["undo", "redo", "undo"] as const) {
    assert.equal((await c[step](undefined, { cut: main, author: alice })).status, "confirmed", step);
    said.push(`${(await top(c, main)).summary} ${JSON.stringify(await state(c, main))}`);
  }
  assert.deepEqual(said, [`${FOLD} ${JSON.stringify(BEFORE)}`, `Redid the fold of 'Client review' into 'Main cut' ${JSON.stringify(SOME)}`, `${FOLD} ${JSON.stringify(BEFORE)}`]);
  assert.equal(((await c.undo(undefined, { cut: main, author: alice })) as { empty?: boolean }).empty, true, "nothing more");
});

test("P2-1: on a shared cut, with a teammate's edits before the rest and before the undo: ① the rest, ② the fold-some, theirs kept", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), cutName: "Main cut" }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  try {
    const main = a.cut;
    const v = await review(a);
    const confirmed = async (r: Promise<CommitResult>) => {
      const x = await r;
      assert.equal(x.status, "pending", JSON.stringify(x));
      assert.equal((await a.sync!.waitFor((x as { id: string }).id, 5000)).status, "confirmed");
    };
    const bobs = async (id: string, name: string) => {
      assert.equal((await b.commit({ ops: [set(id, "name", name)], author: bob, wait: 5000 })).status, "confirmed");
      await until(async () => item((await a.head(main)).doc, id)!.name === name, 5000, `bob's ${id} at alice`);
    };
    await confirmed(a.foldSome(v.id, { into: main, reject: ["items/d"], author: alice }) as Promise<CommitResult>);
    await bobs("c", "Bob's c");
    const [left] = await a.leftOut(v.id, { into: main });
    await confirmed(a.revert(left!.change, { cut: main, author: alice }));
    assert.deepEqual(await state(a, main), ALL);
    await bobs("e", "Bob's e");
    await confirmed(a.undo(undefined, { cut: main, author: alice }));
    assert.deepEqual([await state(a, main), (await top(a, main)).summary], [SOME, REST], "① the rest");
    await confirmed(a.undo(undefined, { cut: main, author: alice }));
    assert.deepEqual([await state(a, main), (await top(a, main)).summary], [BEFORE, FOLD], "② the fold-some");
    const head = (await a.head(main)).doc;
    assert.deepEqual([item(head, "c")!.name, item(head, "e")!.name], ["Bob's c", "Bob's e"], "bob's edits kept");
    await until(async () => JSON.stringify(await state(b, main)) === JSON.stringify(BEFORE), 5000, "the undo at bob");
    // bob doesn't hold alice's local cut: his History names it as a cut it doesn't hold
    assert.equal((await top(b, main)).summary, "Undid the fold of another copy into 'Main cut'", "bob's History says what it undid");
    // redo walks forward on the shared cut too
    await confirmed(a.redo(undefined, { cut: main, author: alice }));
    assert.deepEqual(await state(a, main), SOME);
    await confirmed(a.redo(undefined, { cut: main, author: alice }));
    assert.deepEqual(await state(a, main), ALL);
  } finally {
    await a.close();
    await b.close();
    w.host.close();
  }
});

test("P2-1 (review #1, #3): on a shared cut, offline: the pending undo of a pending fold-some is named as a fold's; a teammate's edit of what it left out is kept", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), cutName: "Main cut" }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  try {
    const main = a.cut;
    const v = await review(a);
    // offline: the fold-some and its undo both wait in the queue, and the undo's entry still names a fold
    await a.sync!.disconnect();
    assert.equal((await a.foldSome(v.id, { into: main, reject: ["items/d"], author: alice })).status, "pending");
    const u = await a.undo(undefined, { cut: main, author: alice });
    assert.equal(u.status, "pending");
    assert.equal(u.entry?.label, "Undo merge", "named from the pending rows it was planned on");
    assert.deepEqual(await state(a, main), BEFORE);
    assert.equal((await a.redo(undefined, { cut: main, author: alice })).entry?.label, "Redo merge");
    assert.deepEqual(await state(a, main), SOME);
    // back online: everything confirmed; then bob edits d, which the fold left out, and alice undoes the fold-some
    assert.ok(await a.sync!.connect());
    await until(() => a.sync!.state(main).pending === 0, 10_000, "alice's queue confirmed");
    assert.equal((await b.commit({ ops: [set("d", "name", "Bob's d")], author: bob, wait: 5000 })).status, "confirmed");
    await until(async () => item((await a.head(main)).doc, "d")!.name === "Bob's d", 5000, "bob's d at alice");
    const z = await a.undo(undefined, { cut: main, author: alice });
    assert.equal(z.status, "pending", JSON.stringify(z));
    assert.equal((await a.sync!.waitFor((z as { id: string }).id, 5000)).status, "confirmed");
    assert.deepEqual(await state(a, main), [0, "b", "Bob's d"], "the fold-some undone, no card, bob's d kept");
  } finally {
    await a.close();
    await b.close();
    w.host.close();
  }
});
