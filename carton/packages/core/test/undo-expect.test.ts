// UX redesign PLAN 5.3 (review of workstream 5 #1): a toast's Undo takes back what its action made, or nothing. The
// host checked the undo stack and then wrote: an edit that landed in between was the one taken back, and the answer
// said "confirmed". `expect` is checked while the step is planned, inside the write (a retry checks again): another
// entry on top means StackMoved, and nothing changes. Undo and redo, on a local cut and on the Carton handle.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { History, groupOf } from "../src/history/index.ts";
import { Carton } from "../src/index.ts";
import type { Doc, Op } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const schema = defineSchema({ collections: { items: { key: "id" } } });
const film = (): Doc => ({ name: "Film", items: ["a", "b"].map((id) => ({ id, name: id })) }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };
const ME = groupOf(me);
const set = (id: string, name: string): Op => ({ op: "set", path: ["items", id, "name"], value: name });
const names = (h: History, cut: string) => Object.fromEntries((h.stateOf(h.head(cut)) as unknown as { items: { id: string; name: string }[] }).items.map((r) => [r.id, r.name]));

test("PLAN 5.3: undo with `expect` takes back that entry, or, with another on top, nothing (StackMoved)", () => {
  const h = History.create(schema, film(), { cut: "Main cut" });
  const main = h.current;
  h.commit(main, { ops: [set("a", "A")], author: me });
  const action = h.changes(main).at(-1)!;
  // an edit lands after the action (an agent turn the person started, a GUI save): it is on top now
  h.commit(main, { ops: [set("b", "B")], author: me });
  const seq = h.headSeq(main);
  assert.throws(() => h.undo(main, ME, { author: me, expect: action.id }), (e: Error & { code?: string }) => e.code === "STACK_MOVED", "the toast's Undo would take back the newer edit: refused");
  assert.equal(h.headSeq(main), seq, "nothing written");
  assert.deepEqual(names(h, main), { a: "A", b: "B" });
  // the newer edit's own id: taken back, as Ctrl+Z would
  const newer = h.changes(main).at(-1)!;
  assert.equal(h.undo(main, ME, { author: me, expect: newer.id }).status, "confirmed");
  assert.deepEqual(names(h, main), { a: "A", b: "b" });
  // now the action is on top: its Undo works
  assert.equal(h.undo(main, ME, { author: me, expect: action.id }).status, "confirmed");
  assert.deepEqual(names(h, main), { a: "a", b: "b" });
  // redo: the newest undo only
  const undoOfAction = h.changes(main).at(-1)!;
  const undoOfNewer = h.changes(main).at(-2)!;
  assert.throws(() => h.redo(main, ME, { author: me, expect: undoOfNewer.id }), (e: Error & { code?: string }) => e.code === "STACK_MOVED");
  assert.equal(h.redo(main, ME, { author: me, expect: undoOfAction.id }).status, "confirmed");
  assert.deepEqual(names(h, main), { a: "A", b: "b" });
  // an empty stack is no entry either
  const h2 = History.create(schema, film(), { cut: "Main cut" });
  assert.throws(() => h2.undo(h2.current, ME, { author: me, expect: "nope" }), (e: Error & { code?: string }) => e.code === "STACK_MOVED");
});

test("PLAN 5.3: Carton.undo/redo pass `expect` through, and a refusal leaves the handle as it was (no rebuild needed)", async () => {
  const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: film(), cutName: "Main cut" }, actor: me });
  try {
    const a = await c.commit({ ops: [set("a", "A")] });
    assert.equal(a.status, "confirmed");
    const action = a.status === "confirmed" ? a.change!.id : "";
    await c.commit({ ops: [set("b", "B")] });
    const before = (await c.log()).length;
    await assert.rejects(c.undo(ME, { expect: action }), (e: Error & { code?: string }) => e.code === "STACK_MOVED");
    assert.equal((await c.log()).length, before, "nothing written");
    const top = (await c.undoStack(ME, { limit: 1 }))[0]!;
    assert.equal((await c.undo(ME, { expect: top.changeId })).status, "confirmed", "the handle goes on as before");
    assert.equal((await c.undo(ME, { expect: action })).status, "confirmed");
    const doc = (await c.head()).doc as unknown as { items: { id: string; name: string }[] };
    assert.deepEqual(doc.items.map((i) => i.name), ["a", "b"]);
  } finally {
    await c.close();
  }
});
