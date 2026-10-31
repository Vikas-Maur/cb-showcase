// Regression tests for review round 2 (reviews/ui.md), on the real engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type CartonEvent, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton, type FromCartonOptions } from "../src/from-carton.ts";
import { remoteUi, serveUi } from "../src/remote.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color: "red" });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20)] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", turn, chat: "c1", group: "alice@laptop" });
const bob: Actor = { kind: "human", id: "bob", name: "Bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const settle = () => new Promise((r) => setTimeout(r, 80));
const item = async (c: Carton, id: string, cut?: string) => ((await c.head(cut)).doc.items as Rec[]).find((i) => i.id === id)!;

async function open(extra: Partial<FromCartonOptions> = {}, store = createMemoryStore()) {
  const carton = await Carton.open({ adapter, store, init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const taps: ((e: CartonEvent) => void)[] = [];
  const realOn = carton.on.bind(carton);
  (carton as { on: typeof carton.on }).on = (l) => {
    taps.push(l);
    return realOn(l);
  };
  const ui = fromCarton(carton, { me: alice, ...extra });
  await ui.ready;
  return { carton, ui, store, emit: (e: CartonEvent) => taps.forEach((l) => l(e)) };
}

test("R2-1: an undo's cards belong to the cut it ran on, even after a switch while it ran", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t1") });
  await carton.commit({ ops: [set("a", "color", "green")], author: bob });
  const other = await carton.fork("alt");
  await settle();
  const turn = ui.undoTurn()!;
  // Switch cuts while the undo is in flight.
  const realUndo = carton.undo.bind(carton);
  (carton as { undo: typeof carton.undo }).undo = async (g, o) => {
    const r = await realUndo(g, o);
    await ui.switchCut(other.id);
    return r;
  };
  const r = await ui.undo(turn.id);
  assert.equal(r.ok, false);
  assert.equal(ui.conflicts().length, 0, "not shown on the cut switched to");
  await ui.switchCut(main);
  const card = ui.conflicts()[0]!;
  await ui.resolve(card.id, "mine");
  assert.equal((await item(carton, "a", main)).color, "red", "applied on the undo's cut");
  assert.equal((await item(carton, "a", other.id)).color, "green", "the other cut is untouched");
  ui.dispose();
});

test("R2-2: a reviewed card whose source changed since stops the fold; the new value is never accepted unseen", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs")], author: bob });
  await carton.commit({ ops: [set("a", "name", "Mine")] });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.conflicts.length, 1);
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs, changed")], author: bob });
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: { "items/a/name": "theirs" } });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts?.[0]?.theirs.summary, "“Theirs, changed”", "the card as it is now comes back");
  assert.equal((await item(carton, "a")).name, "Mine", "nothing folded in");
  ui.dispose();
});

test("R2-4: the same card on two cuts is two cards", async () => {
  const { carton, ui, emit } = await open();
  const card = { kind: "field" as const, path: "items/a/name", base: "A", ours: "Head", theirs: "Mine" };
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [card] } });
  const other = await carton.fork("alt");
  await ui.switchCut(other.id);
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [card] } });
  assert.equal(ui.conflicts().length, 1, "shown on the second cut too");
  ui.dispose();
});

test("R2-7: a human edit after a turn, or the next turn, keeps the earlier checkpoint's edit count", async () => {
  const { carton, ui } = await open();
  for (let i = 0; i < 3; i++) await carton.commit({ ops: [set("a", "color", `t1-${i}`)], author: director("t1") });
  await settle();
  const turn1 = () => ui.history().at("turns", ui.history().count("turns") - 1)!;
  assert.equal(turn1().turn?.edits, 3);
  await carton.commit({ ops: [set("b", "color", "x")] });
  await settle();
  assert.equal(turn1().turn?.edits, 3, "after a human edit");
  await carton.commit({ ops: [set("c", "color", "y")], author: director("t2") });
  await carton.commit({ ops: [set("d", "color", "z")], author: director("t2") });
  await settle();
  assert.equal(turn1().turn?.edits, 3, "after the next turn");
  assert.equal(ui.history().at("turns", 0)!.turn?.edits, 2);
  assert.equal(ui.history().count("turns"), 2);
  ui.dispose();
});

test("R2-7: a turn that continues across appends has one checkpoint, its newest version", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "color", "1")], author: director("t1") });
  await settle();
  await carton.commit({ ops: [set("b", "color", "2")], author: director("t1") });
  await settle();
  assert.equal(ui.history().count("turns"), 1);
  assert.equal(ui.history().at("all", 0)!.kind, "turn");
  assert.equal(ui.history().at("all", 0)!.turn?.edits, 2);
  assert.equal(ui.history().at("all", 1)!.kind, "edit");
  ui.dispose();
});

test("R2-8: the bridge reads only the changed tail after an append", async () => {
  const { carton, ui } = await open();
  for (let i = 0; i < 40; i++) await carton.commit({ ops: [set("a", "color", `c${i}`)] });
  await settle();
  const h = ui.history();
  let allCalls = 0;
  const realAll = h.all!.bind(h);
  (h as { all: typeof realAll }).all = () => (allCalls++, realAll());
  const slices: number[] = [];
  const realSlice = h.slice!.bind(h);
  (h as { slice: typeof realSlice }).slice = (from) => (slices.push(from), realSlice(from));
  let client!: ReturnType<typeof remoteUi>;
  const server = serveUi(ui, (m) => setTimeout(() => client.receive(structuredClone(m)), 0));
  client = remoteUi((m) => setTimeout(() => server.receive(structuredClone(m)), 0));
  await client.ready;
  const initCalls = allCalls;
  await carton.commit({ ops: [set("b", "color", "new")] });
  await settle();
  assert.equal(allCalls, initCalls, "no full copy after the init");
  assert.ok(slices.length > 0 && slices.every((f) => f >= 40), `slices from ${slices.join(",")}`);
  assert.equal(client.ui.history().count("all"), 42);
  server.close();
  ui.dispose();
});

test("R2-9: 'fold in the rest' stays done after the adapter is recreated, and is offered again only while left out", async () => {
  const store = createMemoryStore();
  const { carton, ui } = await open({}, store);
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} })).ok, true);
  await settle();
  const inv = ui.history().at("all", 0)!;
  assert.equal(inv.foldRest, true);
  // A fresh adapter over the same project still offers it (derived from state, not session memory).
  const again = fromCarton(carton, { me: alice });
  await again.ready;
  await settle();
  assert.equal(again.history().at("all", 0)!.foldRest, true);
  assert.equal((await again.foldRest(inv.id)).ok, true);
  again.dispose();
  ui.dispose();
  // And after it was done, a fresh adapter no longer offers it.
  const third = fromCarton(carton, { me: alice });
  await third.ready;
  await settle();
  assert.equal(third.history().at("all", 1)!.foldRest, undefined);
  assert.equal((await third.foldRest(inv.id)).ok, false);
  assert.equal((await item(carton, "d")).color, "blue");
  third.dispose();
});

test("core APIs: credits say when, publications say newer edits", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("c", "color", "blue")], author: bob });
  await settle();
  const cr = await ui.credits("c");
  assert.equal(cr.lines[0]!.author.name, "Bob");
  assert.equal(typeof cr.lines[0]!.at, "number", "credits carry the time now");
  const main = ui.cuts().find((c) => c.current)!;
  await ui.publish(main.id);
  assert.equal(ui.published()?.newerEdits, 0);
  await carton.commit({ ops: [set("a", "color", "blue")] });
  await settle();
  await settle();
  assert.equal(ui.published()?.newerEdits, 1);
  ui.dispose();
});
