// Laptop P2-1 (merge/prod-2 @ 3b2407c3): after a fold-some ("Fold in 2 of 3") and then "fold in the rest", the second
// Ctrl+Z went the wrong way. A fold-some is two changes, the fold and its partial revert `<fold id>.inverse`, shown as one
// version; the undo stack listed them as two entries, so Ctrl+Z ② reverted only the partial revert (it brought the rest
// back in, the state of Ctrl+Z ①'s version again, read "Undid the fold of …") and Ctrl+Z ③ finally undid the fold. A
// fold-some on its own did the same: its Ctrl+Z brought in what was left out. A fold-some is one action and one undo.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { History, groupOf, nodeId } from "../src/history/index.ts";
import type { Doc, Op } from "../src/types.ts";

const schema = defineSchema({ collections: { items: { key: "id" } } });
const film = (): Doc => ({ name: "Film", items: ["a", "b", "d"].map((id) => ({ id, name: id })) }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };
const bob = { kind: "human" as const, id: "bob" };
const ME = groupOf(me);
const set = (id: string, name: string): Op => ({ op: "set", path: ["items", id, "name"], value: name });
const names = (h: History, cut: string) => Object.fromEntries((h.stateOf(h.head(cut)) as unknown as { items: { id: string; name: string }[] }).items.map((r) => [r.id, r.name]));
const BEFORE = { a: "a", b: "b", d: "d" };
const SOME = { a: "A", b: "B", d: "d" };
const ALL = { a: "A", b: "B", d: "D" };

/** Main, and a cut "Alt" changing a, b and d; Main folds in a and b, leaving d out. */
function folded() {
  const h = History.create(schema, film(), { cut: "Main cut" });
  const main = h.current;
  const alt = h.fork(nodeId(main, 0), "Alt");
  h.commit(alt, { ops: [set("a", "A"), set("b", "B"), set("d", "D")], author: me });
  const r = h.foldSome(main, h.head(alt), { reject: ["items/d"], author: me });
  assert.equal(r.status, "confirmed");
  const [fold, inverse] = h.changes(main).slice(-2);
  assert.equal(inverse!.id, `${fold!.id}.inverse`);
  assert.deepEqual(names(h, main), SOME);
  return { h, main, alt, fold: fold!, inverse: inverse! };
}

test("P2-1: a fold-some is one undo entry; Ctrl+Z puts Main back as it was before it, and names both changes", () => {
  const { h, main, alt, fold, inverse } = folded();
  const stack = h.undoStack(main, ME);
  assert.deepEqual(stack.map((e) => e.changeId), [inverse.id], "one entry, the version's own (its partial revert), not the fold under it");
  const r = h.undo(main, ME, { author: me });
  assert.equal(r.status, "confirmed");
  assert.deepEqual(names(h, main), BEFORE, "the whole fold-some undone: nothing of 'Alt' comes in, d stays out");
  assert.deepEqual(h.changes(main).at(-1)!.reverts, [fold.id, inverse.id]);
  assert.deepEqual(h.undoStack(main, ME), [], "nothing left to undo");
  assert.deepEqual(h.leftOut(main, alt), [], "nothing left out either: the partial fold is undone");
  // redo brings back the partial fold, not the whole fold; undo after it goes back again
  assert.equal(h.redo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), SOME);
  assert.deepEqual(h.redoStack(main, ME), []);
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), BEFORE);
});

test("P2-1: after a fold-some and the rest, Ctrl+Z ① undoes the rest, ② the fold-some; redo walks forward the same way", () => {
  const { h, main, alt, inverse } = folded();
  assert.equal(h.revert(main, h.leftOut(main, alt)[0]!.id, { author: me }).status, "confirmed", "fold in the rest");
  assert.deepEqual(names(h, main), ALL);
  const seen: Record<string, string>[] = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
    seen.push(names(h, main));
  }
  assert.deepEqual(seen, [SOME, BEFORE], "① the rest, ② the partial fold: two actions, two presses, never the same two states");
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  assert.equal(h.changes(main).at(-1)!.kind, "undo", "the last real undo is still the head");
  assert.deepEqual(names(h, main), BEFORE, "a third press finds nothing");
  assert.deepEqual(h.leftOut(main, alt), []);
  assert.equal(h.redo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), SOME, "redo ①: the partial fold");
  assert.deepEqual(h.leftOut(main, alt).map((c) => c.id), [inverse.id], "and its rest is left out again");
  assert.equal(h.redo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), ALL, "redo ②: the rest");
  assert.deepEqual(h.redoStack(main, ME), []);
});

test("P2-1: a teammate's change between the fold and its partial revert (a shared cut's queue): still one undo, theirs kept", () => {
  const h = History.create(schema, film(), { cut: "Main cut" });
  const main = h.current;
  const alt = h.fork(nodeId(main, 0), "Alt");
  h.commit(alt, { ops: [set("a", "A"), set("d", "D")], author: me });
  const f = h.fold(main, h.head(alt), { author: me });
  assert.equal(f.status, "confirmed");
  const fold = h.changes(main).at(-1)!;
  h.commit(main, { ops: [set("b", "Bob's")], author: bob });
  h.commit(main, { ops: [set("d", "d")], author: me, kind: "partial-revert", id: `${fold.id}.inverse`, extra: { rejected: ["items/d"], reverts: fold.id } });
  assert.equal(h.log(main).filter((v) => v.ref.seq > 0).length, 3, "two versions of the fold-some, as History lists them");
  assert.deepEqual(h.undoStack(main, ME).map((e) => e.changeId), [`${fold.id}.inverse`]);
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), { a: "a", b: "Bob's", d: "d" }, "the fold-some undone, bob's edit kept");
});

test("P2-1: a partial revert an earlier build undid on its own leaves its fold to undo, as it did", () => {
  const { h, main, fold, inverse } = folded();
  // the earlier build's Ctrl+Z ②: the partial revert alone (the rest came in)
  h.commit(main, { doc: h.stateOf(nodeId(main, fold.seq))!, author: me, kind: "undo", extra: { reverts: inverse.id } });
  assert.deepEqual(names(h, main), ALL);
  assert.deepEqual(h.undoStack(main, ME).map((e) => e.changeId), [fold.id], "the fold is the next undo");
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  assert.deepEqual(names(h, main), BEFORE);
});

test("P2-1: an agent turn's fold-some is undone with the rest of its turn, each change once", () => {
  const h = History.create(schema, film(), { cut: "Main cut" });
  const main = h.current;
  const alt = h.fork(nodeId(main, 0), "Alt");
  h.commit(alt, { ops: [set("a", "A"), set("d", "D")], author: me });
  const director = { kind: "agent" as const, id: "director", group: "me/director", turn: "t1" };
  h.commit(main, { ops: [set("b", "B")], author: director });
  assert.equal(h.foldSome(main, h.head(alt), { reject: ["items/d"], author: director }).status, "confirmed");
  assert.deepEqual(names(h, main), { a: "A", b: "B", d: "d" });
  assert.equal(h.undoStack(main, "me/director").length, 2, "the edit and the fold-some");
  assert.equal(h.undo(main, "me/director", { author: director }).status, "confirmed");
  assert.deepEqual(names(h, main), BEFORE);
  const reverts = h.changes(main).at(-1)!.reverts as string[];
  assert.equal(reverts.length, 3);
  assert.equal(new Set(reverts).size, 3, "each change named once");
});
