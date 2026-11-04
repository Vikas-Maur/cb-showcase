// The History panel's view model over the real engine, for the UI audit 2026-11-02 items:
// - P1-3: a partial fold is one row, titled as a fold, by whoever folded; the change left out is never a row.
// - P1-4: "You can fold in the rest later": the next Fold in offers what was left out, and folds it in.
// - P1-5: a version of several changes is summed up, with every change listed (details).
// - P1-10: Director and Claude Code turns are both turns: the filter lists every agent's, with or without a turn id.
// - panel-author (laptop #2): a panel write's Undo entry is current when the write returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import { words } from "../src/words.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color: "red" });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20)] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", name: "Bob" };
const director: Actor = { kind: "agent", id: "director/c1", name: "Director" };
const claude: Actor = { kind: "agent", id: "claude-code/ab12cd34", name: "Claude Code", group: "alice@laptop" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const item = (d: Doc, id: string) => (d.items as Rec[]).find((i) => i.id === id)!;

const live = new Set<ReturnType<typeof fromCarton>>();
const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.all([...live].map((h) => h.settled()));
};
async function open() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  live.add(ui);
  await ui.ready;
  return { carton, ui };
}
/** Every row, newest first, with its summary read (as a list on screen asks). */
async function rows(ui: ReturnType<typeof fromCarton>) {
  const h = ui.history();
  for (let i = 0; i < h.count("all"); i++) h.at("all", i);
  await settle();
  return Array.from({ length: h.count("all") }, (_, i) => h.at("all", i)!);
}
/** "Alt" with three changes by three authors, and Main's view model. */
async function alt() {
  const o = await open();
  const main = o.carton.cut;
  const v = await o.carton.fork("Alt");
  await o.carton.commit({ cut: v.id, ops: [set("a", "startTime", 1), set("a", "endTime", 6)], author: bob });
  await o.carton.commit({ cut: v.id, ops: [set("b", "name", "Opening")], author: director });
  await o.carton.commit({ cut: v.id, ops: [set("d", "color", "black")], author: claude });
  await o.ui.refresh();
  return { ...o, main, v };
}

test("P1-3: a partial fold is one row, titled as a fold, by you; the change left out is never a row", async () => {
  const { carton, ui, main, v } = await alt();
  const before = ui.history().count("all");
  const plan = await ui.planFold(v.id, main);
  assert.deepEqual(plan.changes.map((c) => c.id).sort(), ["items/a", "items/b", "items/d"]);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} })).ok, true);
  const check = async (h: ReturnType<typeof fromCarton>, how: string) => {
    const list = await rows(h);
    assert.equal(list.length, before + 1, `${how}: one row for the fold`);
    const f = list[0]!;
    assert.equal(f.kind, "fold");
    assert.equal(f.summary, "Folded 'Alt' into 'Main cut': 2 of 3 changes", how);
    assert.equal(f.author.isYou, true, `${how}: credited to whoever folded`);
    assert.deepEqual(f.details, ["Moved 'A' 0.0 s → 1.0 s", 'Changed \'B\' name "B" → "Opening"'], `${how}: exactly the chosen changes`);
    for (const r of list) assert.doesNotMatch(`${r.summary} ${(r.details ?? []).join(" ")}`, /'D'|black/, `${how}: ${r.summary}`);
  };
  await check(ui, "live");
  // a fresh panel (History read from the store)
  const again = fromCarton(carton, { me: alice });
  live.add(again);
  await again.ready;
  await check(again, "reloaded");
  ui.dispose();
  again.dispose();
});

test("P1-4: after a partial fold, Fold in offers what was left out and folds it in; then nothing is left", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} })).ok, true);
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.changes.length, 1, "the change left out is offered, not 'Nothing to fold in'");
  const rest = plan.changes[0]!;
  assert.match(rest.summary, /'D'.*color.*black/);
  assert.ok(rest.leftOut, "marked as left out earlier");
  assert.equal(rest.author.name, "Claude Code", "credited to who made it");
  // leaving it out again keeps it for later
  assert.equal((await ui.fold(v.id, main, { leaveOut: [rest.id], choices: {} })).ok, true, "nothing chosen: nothing done");
  assert.equal(item((await carton.head(main)).doc, "d").color, "red");
  assert.equal((await ui.planFold(v.id, main)).changes.length, 1, "still offered");
  assert.equal((await ui.fold(v.id, main, { leaveOut: [], choices: {} })).ok, true);
  assert.equal(item((await carton.head(main)).doc, "d").color, "black", "the rest is in Main");
  assert.equal((await ui.planFold(v.id, main)).changes.length, 0, "now nothing is left");
  const top = (await rows(ui))[0]!;
  assert.equal(top.summary, "Folded the rest of 'Alt' into 'Main cut': 1 change");
  ui.dispose();
});

test("P1-4: new changes and what was left out fold in together; a partial fold's left-out changes come as one", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/b", "items/d"], choices: {} })).ok, true);
  await carton.commit({ cut: v.id, ops: [set("c", "name", "Closer")], author: bob });
  const plan = await ui.planFold(v.id, main);
  const ids = plan.changes.map((c) => c.id);
  assert.equal(plan.changes.length, 3, ids.join(", "));
  const restRows = plan.changes.filter((c) => c.leftOut);
  assert.equal(restRows.length, 2, "b and d, left out earlier");
  assert.equal(new Set(restRows.map((c) => c.leftOut)).size, 1, "one partial fold: they fold in together");
  assert.equal((await ui.fold(v.id, main, { leaveOut: [], choices: {} })).ok, true);
  const head = (await carton.head(main)).doc;
  assert.deepEqual([item(head, "a").startTime, item(head, "b").name, item(head, "c").name, item(head, "d").color], [1, "Opening", "Closer", "black"]);
  assert.equal((await ui.planFold(v.id, main)).changes.length, 0);
  ui.dispose();
});

test("P1-5: a version of several changes reads as a summary, every change in its details", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "startTime", 2), set("a", "endTime", 7), set("b", "name", "B1"), set("c", "name", "C1")], author: alice });
  const top = (await rows(ui))[0]!;
  assert.equal(top.summary, "Moved 'A', changed 'B' and 'C'");
  assert.equal(top.details?.length, 3);
  await carton.restore(`${carton.cut}@0`, { author: alice });
  const r = (await rows(ui))[0]!;
  assert.equal(r.summary, "Restored an earlier version");
  assert.equal(r.details?.length, 3);
  ui.dispose();
});

test("P1-10: the turns filter is every agent's turns: Director and Claude Code, with or without a turn id", async () => {
  assert.equal(words.historyFilters.turns, "Agent turns");
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "name", "x")], author: director }); // a Director version with no turn recorded
  await carton.commit({ ops: [set("b", "name", "y")], author: alice });
  await carton.commit({ ops: [set("c", "name", "z")], author: claude });
  await carton.commit({ ops: [set("d", "name", "w")], author: claude });
  await settle();
  const h = ui.history();
  const turns = Array.from({ length: h.count("turns") }, (_, i) => h.at("turns", i)!);
  assert.deepEqual(turns.map((t) => [t.author.name, t.turn?.edits]), [["Claude Code", 2], ["Director", 1]]);
  // a turn's end names its last version: the next edit by the same agent starts the next turn
  await ui.nameVersion(h.at("all", 0)!.id, "Tighter intro");
  await carton.commit({ ops: [set("a", "name", "again")], author: claude });
  await settle();
  const after = Array.from({ length: h.count("turns") }, (_, i) => h.at("turns", i)!);
  assert.deepEqual(after.map((t) => [t.author.name, t.turn?.edits, t.name ?? ""]), [["Claude Code", 1, ""], ["Claude Code", 2, "Tighter intro"], ["Director", 1, ""]]);
  // a fresh panel groups them the same way
  const again = fromCarton(carton, { me: alice });
  live.add(again);
  await again.ready;
  const h2 = again.history();
  assert.deepEqual(Array.from({ length: h2.count("turns") }, (_, i) => [h2.at("turns", i)!.author.name, h2.at("turns", i)!.turn?.edits]), [["Claude Code", 1], ["Claude Code", 2], ["Director", 1]]);
  ui.dispose();
  again.dispose();
});

test("panel-author: a restore's or a fold of the rest's Undo is offered as soon as the write returns", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  const inv = (await rows(ui))[0]!;
  assert.equal((await ui.foldRest(inv.id)).ok, true);
  const rest = (await carton.log({ cut: main, limit: 1 }))[0]!;
  assert.equal(ui.undoTurn()?.id, rest.change, "Undo is the fold of the rest's");
  await ui.restore(`${main}@0`);
  const restore = (await carton.log({ cut: main, limit: 1 }))[0]!;
  assert.equal(ui.undoTurn()?.id, restore.change, "Undo is the restore's, not the version before it");
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true);
  ui.dispose();
});

test("P1-4 (review #1): a left-out change edited on Main since isn't offered, and folding in the others never trips on it", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/b", "items/d"], choices: {} })).ok, true);
  await carton.commit({ cut: main, ops: [set("b", "name", "Main's own")], author: alice });
  const plan = await ui.planFold(v.id, main);
  assert.deepEqual(plan.changes.map((c) => c.summary), ["Changed 'D' color \"red\" → \"black\""], "only what is still left out");
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: {} });
  assert.deepEqual([r.ok, r.conflicts?.length ?? 0, ui.conflicts().length], [true, 0, 0], "no card for the change Main made since");
  const head = (await carton.head(main)).doc;
  assert.deepEqual([item(head, "b").name, item(head, "d").color], ["Main's own", "black"]);
  assert.equal((await ui.planFold(v.id, main)).changes.length, 0, "nothing left");
  ui.dispose();
});

// Laptop P2-1: Fold in with one change left out, then "Fold in the rest", then History's Undo twice: the second Undo
// brought the rest back in (and read "Undid the fold of 'Alt'…"), and only a third undid the fold. Two actions, two
// Undos; and the Undo offered for the partial fold names what the fold took, not the change it left out.
test("P2-1: History's Undo after a partial fold and its rest: the rest, then the whole partial fold, then nothing", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  assert.doesNotMatch(ui.undoTurn()!.label, /'D'|color/, `the partial fold's Undo names what it took: ${ui.undoTurn()!.label}`);
  assert.equal((await ui.foldRest((await rows(ui))[0]!.id)).ok, true);
  await settle();
  const shown = async () => { const d = (await carton.head(main)).doc; return [item(d, "a").startTime, item(d, "b").name, item(d, "d").color]; };
  assert.deepEqual(await shown(), [1, "Opening", "black"]);
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true, "Undo the rest");
  assert.deepEqual(await shown(), [1, "Opening", "red"]);
  await settle();
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true, "Undo the partial fold");
  assert.deepEqual(await shown(), [0, "B", "red"], "Main as it was before the fold");
  await settle();
  assert.equal(ui.undoTurn(), null, "nothing of the fold is left to undo");
  ui.dispose();
});

test("P1-4 (review #2): undoing 'Fold in the rest' offers the rest again, on its row and in Fold in", async () => {
  const { carton, ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  const inv = (await rows(ui))[0]!;
  assert.equal(inv.foldRest, true);
  assert.equal((await ui.foldRest(inv.id)).ok, true);
  await settle();
  assert.equal((await ui.planFold(v.id, main)).changes.length, 0);
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true, "Undo the fold of the rest");
  assert.equal(item((await carton.head(main)).doc, "d").color, "red");
  await settle();
  const row = ui.history().at("all", ui.history().indexOf("all", inv.id))!;
  assert.equal(row.foldRest, true, "its row offers the rest again");
  assert.equal((await ui.planFold(v.id, main)).changes.length, 1, "and Fold in lists it");
  ui.dispose();
});

// Final re-check, baseline P3-12b: "Folded the rest of 'Alt' into 'Main cut'" had the ↺ mark, as a revert. It is a fold
// (core's `restOf`); its undo is an undo.
test("baseline P3-12b: the rest of a partial fold is a fold row; its undo an undo row", async () => {
  const { ui, main, v } = await alt();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  assert.equal((await ui.foldRest((await rows(ui))[0]!.id)).ok, true);
  const rest = (await rows(ui))[0]!;
  assert.equal(rest.summary, "Folded the rest of 'Alt' into 'Main cut': 1 change");
  assert.equal(rest.kind, "fold");
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true);
  assert.equal((await rows(ui))[0]!.kind, "undo");
  ui.dispose();
});

// Final re-check, baseline P3-2: the panel's row for an Undo right after a Restore says what it undid.
test("baseline P3-2: an Undo right after a Restore reads \"Undid the restore\", its changes in its details", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "name", "A1"), set("b", "name", "B1")], author: alice });
  await ui.restore(`${carton.cut}@0`);
  await settle();
  assert.equal((await rows(ui))[0]!.summary, "Restored an earlier version");
  assert.equal((await ui.undo(ui.undoTurn()!.id)).ok, true);
  const u = (await rows(ui))[0]!;
  assert.deepEqual([u.kind, u.summary, u.details?.length], ["undo", "Undid the restore", 2]);
  ui.dispose();
});
