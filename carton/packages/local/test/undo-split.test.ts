// The app's Ctrl+Z of a split after a drag of one of its pieces, through @carton/local's write path on Cardboard's own
// schema (laptop report #2, bug 6): the editor's saves as the library worker commits them (projectGuiSave, the split as
// the editor's `gui` intent), then `undo` and `redo` with the app's scope, as the worker sends Ctrl+Z, Ctrl+Shift+Z and
// Ctrl+Y. The drag's undo pulled the piece back over the gap it left and was recorded as a ripple delete, so the
// split's undo clashed with it: a card, nothing undone, and redo then redid the drag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type Rec } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cardboardAdapter, projectGuiSave } from "@carton/cardboard";
import { localGroup } from "../src/identity.ts";
import { runWrite } from "../src/writes.ts";

const clip = (id: string, s: number, e: number, ts = 0): Rec => ({ id, mediaItemId: "m1", trackId: "t1", startTime: s, endTime: e, trimStart: ts, trimEnd: ts + e - s, type: "video" });
// the clips as [id, start, end, trimStart], in time order
const shape = (items: Rec[]) => items.slice().sort((p, q) => (p.startTime as number) - (q.startTime as number)).map((i) => [i.id, i.startTime, i.endTime, i.trimStart]);

test("the app's Ctrl+Z ×2 after a split and a drag gives the clip back; Ctrl+Shift+Z the split, Ctrl+Y the drag", async () => {
  let now = 1000;
  const c = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: cardboardAdapter.fromHost({ name: "P", tracks: [{ id: "t1", name: "Mine", order: 0 }], timelineItems: [clip("x", 0, 3)] }, null) }, clock: () => (now += 10) });
  const person: Actor = { kind: "human", id: "person", group: localGroup(), app: true };
  const since = now;
  const items = async () => (await c.head()).doc.timelineItems as Rec[];
  // a GUI save as the worker commits it: the editor's document projected onto its base, its intents as `gui`
  const save = async (timelineItems: Rec[], gui?: unknown[]) => {
    const h = await c.head();
    const doc = projectGuiSave(h.doc, { ...cardboardAdapter.toHost(h.doc), timelineItems }, (x) => x);
    const r = await c.commit({ doc, base: h.ref, author: person, ...(gui ? { intent: { gui } as never } : {}) });
    assert.equal(r.status, "confirmed");
  };
  await save([clip("a", 0, 1.5), clip("b", 1.5, 3, 1.5)], [{ kind: "split", id: "x", at: 1.5, into: ["a", "b"] }]);
  const split = shape(await items());
  await save([clip("a", 0, 1.5), clip("b", 4.5, 6, 1.5)]);
  const dragged = shape(await items());
  const step = async (kind: "undo" | "redo", n: number) => {
    const r = await runWrite(c, { id: `app.${kind}${n}`, actor: person, gui: true, op: { kind, group: localGroup(), since, app: true } });
    assert.equal(r.status, "confirmed", `${kind} #${n}: ${r.status} ${JSON.stringify(r.status === "conflicts" ? r.conflicts.map((k) => k.reason) : "")}`);
    assert.ok(!(r.status === "confirmed" && r.empty), `${kind} #${n} changed something`);
  };
  await step("undo", 1);
  assert.deepEqual(shape(await items()), split, "Ctrl+Z #1: the drag undone");
  await step("undo", 2);
  assert.deepEqual(shape(await items()), [["x", 0, 3, 0]], "Ctrl+Z #2: the split undone, the one clip back");
  assert.deepEqual(await c.undoStack(localGroup(), { since, app: true }), [], "nothing left to undo");
  await step("redo", 1);
  assert.deepEqual(shape(await items()), split, "Ctrl+Shift+Z: the split");
  await step("redo", 2);
  assert.deepEqual(shape(await items()), dragged, "Ctrl+Y: the drag");
  assert.deepEqual(await c.redoStack(localGroup(), { since, app: true }), [], "nothing left to redo");
  await c.close();
});

test("`cb undo --turn` (its own 3-way inverse, not core's planned undo) still records the gap a turn's ripple closed", async () => {
  let now = 1000;
  const c = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: cardboardAdapter.fromHost({ name: "P", tracks: [{ id: "t1", name: "Mine", order: 0 }], timelineItems: [clip("p", 0, 2), clip("q", 2, 4), clip("r", 6, 8), clip("s", 8, 10)] }, null) }, clock: () => (now += 10) });
  const agent: Actor = { kind: "agent", id: "director/c1/T", name: "Director", turn: "T", group: localGroup(), app: true };
  const changes: { intent?: unknown }[] = [];
  c.on((e) => { if (e.type === "change") changes.push(e.change); });
  // the turn closes the gap [4, 6): r and s pulled left together (a file save: the ripple is inferred)
  const h = await c.head();
  const doc = cardboardAdapter.fromHost({ ...cardboardAdapter.toHost(h.doc), timelineItems: [clip("p", 0, 2), clip("q", 2, 4), clip("r", 4, 6), clip("s", 6, 8)] }, h.doc);
  assert.equal((await c.commit({ doc, base: h.ref, author: agent })).status, "confirmed");
  const r = await runWrite(c, { id: "cb.undo-turn", actor: agent, op: { kind: "undoTurn", turn: "T" } });
  assert.equal(r.status, "confirmed");
  assert.deepEqual(shape((await c.head()).doc.timelineItems as Rec[]), [["p", 0, 2, 0], ["q", 2, 4, 0], ["r", 6, 8, 0], ["s", 8, 10, 0]]);
  assert.deepEqual((changes.at(-1)?.intent as { maps?: unknown } | undefined)?.maps, { t1: [{ d: [], i: [[4, 2]] }] }, "the gap re-inserted, as before");
  await c.close();
});
