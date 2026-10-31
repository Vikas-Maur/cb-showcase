// Regression tests for review round 2 (reviews/ui.md), on the real engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type CartonEvent, type ConflictCard, type Doc, type Rec } from "@carton/core";
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
// Every view model a test opens, so settle() waits for their own scheduled and running work, never a guessed time
// (Windows wakes timers at about 15.6 ms; a fixed wait races the 50 ms refresh debounce: verify-ci #8).
const live = new Set<ReturnType<typeof fromCarton>>();
const make = (...a: Parameters<typeof fromCarton>) => {
  const h = fromCarton(...a);
  live.add(h);
  return h;
};
const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.all([...live].map((h) => h.settled()));
};
const item = async (c: Carton, id: string, cut?: string) => ((await c.head(cut)).doc.items as Rec[]).find((i) => i.id === id)!;

async function open(extra: Partial<FromCartonOptions> = {}, store = createMemoryStore()) {
  const carton = await Carton.open({ adapter, store, init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const taps: ((e: CartonEvent) => void)[] = [];
  const realOn = carton.on.bind(carton);
  (carton as { on: typeof carton.on }).on = (l) => {
    taps.push(l);
    return realOn(l);
  };
  const ui = make(carton, { me: alice, ...extra });
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
  const again = make(carton, { me: alice });
  await again.ready;
  await settle();
  assert.equal(again.history().at("all", 0)!.foldRest, true);
  assert.equal((await again.foldRest(inv.id)).ok, true);
  again.dispose();
  ui.dispose();
  // And after it was done, a fresh adapter no longer offers it.
  const third = make(carton, { me: alice });
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

// ---------------------------------------------------------------- review round 3

test("R3-2: a cut made after a partial fold doesn't offer the rest of the fold it inherited", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} })).ok, true);
  await settle();
  const inv = ui.history().at("all", 0)!;
  assert.equal(inv.foldRest, true, "offered on Main");
  const working = await ui.newCut("working", ui.cuts().find((c) => c.current)!.head);
  await settle();
  const inherited = ui.history().at("all", ui.history().indexOf("all", inv.id))!;
  assert.equal(inherited.foldRest, undefined, "not offered on the new cut");
  assert.equal((await ui.foldRest(inv.id)).ok, false);
  assert.equal((await item(carton, "d", main)).color, "red", "Main untouched");
  assert.equal(carton.cut, working.id);
  ui.dispose();
});

test("R3-4: ghosts follow the cut: a drag on Main isn't shown over another cut, and comes back with Main", async () => {
  const { carton, ui, emit } = await open();
  const main = carton.cut;
  emit({ type: "presence", branchId: main, actor: bob, state: { ghosts: [{ item: "a", track: "t1", start: 1, end: 3 }] } });
  assert.equal(ui.ghosts().length, 1);
  const other = await carton.fork("alt");
  await ui.switchCut(other.id);
  assert.equal(ui.ghosts().length, 0, "cleared on switch");
  await ui.switchCut(main);
  assert.equal(ui.ghosts().length, 1, "back on Main");
  ui.dispose();
});

test("R3-5: a decided partial fold is not diffed again on later refreshes", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  await ui.foldRest(ui.history().at("all", 0)!.id);
  await settle();
  let diffs = 0;
  const realDiff = carton.diff.bind(carton);
  (carton as { diff: typeof carton.diff }).diff = (...a) => (diffs++, realDiff(...a));
  const again = make(carton, { me: alice });
  await again.ready;
  await settle();
  const first = diffs;
  assert.ok(first <= 1, "checked once");
  await again.refresh();
  await carton.commit({ ops: [set("a", "color", "x")] });
  await settle();
  await again.refresh();
  assert.equal(diffs, first, "not checked again");
  again.dispose();
  ui.dispose();
});

// ---------------------------------------------------------------- review round 4

test("R4-2: a failed check is retried, not cached", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  // The first check fails (a read error); the next refresh must check again.
  const realCheckout = carton.checkout.bind(carton);
  let fail = true;
  (carton as { checkout: typeof carton.checkout }).checkout = async (ref) => {
    if (fail) throw new Error("read failed");
    return realCheckout(ref);
  };
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  await ui.refresh();
  const inv = ui.history().at("all", 0)!;
  assert.equal(inv.foldRest, undefined, "while reads fail, nothing is offered");
  fail = false; // the store recovers
  await ui.refresh();
  await settle();
  assert.equal(ui.history().at("all", 0)!.foldRest, true, "offered after the retry");
  ui.dispose();
});

test("R4-2: when the left-out records change, the decision is checked again (both ways)", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  const invId = ui.history().at("all", 0)!.id;
  const flag = () => ui.history().at("all", ui.history().indexOf("all", invId))!.foldRest;
  assert.equal(flag(), true);
  await carton.commit({ ops: [set("d", "color", "green")] }); // someone edits the left-out clip
  await settle();
  await ui.refresh();
  await settle();
  assert.equal(flag(), undefined, "no longer left out");
  await carton.commit({ ops: [set("d", "color", "red")] }); // and back to what the partial fold left
  await settle();
  await ui.refresh();
  await settle();
  assert.equal(flag(), true, "left out again: offered again");
  await carton.commit({ ops: [set("a", "color", "x")] }); // an unrelated edit keeps the decision without a recheck
  await settle();
  assert.equal(flag(), true);
  ui.dispose();
});

// ---------------------------------------------------------------- review round 5

async function partialFold(carton: Carton, ui: ReturnType<typeof fromCarton>) {
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  await settle();
  const invId = ui.history().at("all", 0)!.id;
  return { main, invId, flag: () => ui.history().at("all", ui.history().indexOf("all", invId))?.foldRest };
}

test("R5-1: an edit on another cut never stands in for an edit on this one", async () => {
  const { carton, ui } = await open();
  const { main, flag } = await partialFold(carton, ui);
  await carton.commit({ ops: [set("d", "color", "green")] });
  await settle();
  await ui.refresh();
  await settle();
  assert.equal(flag(), undefined, "decided: not left out");
  const other = await carton.fork("other");
  await ui.switchCut(other.id);
  await carton.commit({ cut: other.id, ops: [set("a", "color", "x")] }); // unrelated, on the other cut
  await carton.commit({ cut: main, ops: [set("d", "color", "red")] }); // relevant, on Main, while away
  await settle();
  await ui.switchCut(main);
  await settle();
  assert.equal(flag(), true, "back on Main, the change made there while away is taken into account");
  ui.dispose();
});

test("R5-2: a read that started before a change can't put back a decision the change made obsolete", async () => {
  const store = createMemoryStore();
  const { carton, ui } = await open({}, store);
  const { flag } = await partialFold(carton, ui);
  assert.equal(flag(), true);
  // Another handle writes (no event here): the next refresh must check again; pause that check's head read.
  const otherHandle = await Carton.open({ adapter, store, actor: bob });
  await otherHandle.commit({ ops: [set("a", "color", "x")] });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inRead = new Promise<void>((r) => (entered = r));
  const realHead = carton.head.bind(carton);
  let armed = true;
  (carton as { head: typeof carton.head }).head = async (cut) => {
    const h = await realHead(cut);
    if (armed) {
      armed = false;
      entered();
      await gate; // the read saw d red; meanwhile d turns green
    }
    return h;
  };
  const p = ui.refresh();
  await inRead;
  await carton.commit({ ops: [set("d", "color", "green")] }); // through this handle: an event invalidates
  release();
  await p;
  await settle();
  assert.equal(flag(), undefined, "the stale 'still left out' was discarded; the fresh read says it isn't");
  ui.dispose();
});

test("R5-2: writes from another handle (no events) invalidate a 'still left out' decision on refresh", async () => {
  const store = createMemoryStore();
  const { carton, ui } = await open({}, store);
  const { flag } = await partialFold(carton, ui);
  assert.equal(flag(), true);
  const otherHandle = await Carton.open({ adapter, store, actor: bob });
  await otherHandle.commit({ ops: [set("d", "color", "green")] });
  await ui.refresh();
  await settle();
  assert.equal(flag(), undefined);
  ui.dispose();
});

// ---------------------------------------------------------------- Stage F (verify-ci #3: the windows facade)

test("Stage F: cards a host reports keep its own fields; cardFor maps a Conflict back; sides follow core; resolve removes only that card", async () => {
  const { carton, ui } = await open();
  // A stale GUI save's clash, as the windows facade reports it (core's convention, with its own card ids):
  // ours = head on screen (the change that was kept), theirs = the person's own edit.
  const card = (cid: string, head: number, mine: number) => ({ kind: "field" as const, path: "items/a/fontSize", base: 150, ours: head, theirs: mine, cid });
  ui.reportConflicts([card("k1", 160, 170), card("k2", 180, 170)]);
  const shown = ui.conflicts();
  assert.equal(shown.length, 2, "two kept cards for one field");
  type HostCard = ConflictCard & { cid: string };
  const first = shown.find((c) => ui.cardFor<HostCard>(c.id)?.cid === "k1")!;
  assert.equal(first.path, "items/a/fontSize", "path says which field");
  assert.equal(first.mine.summary, "170", "mine is the person's own edit (core's theirs)");
  assert.equal(first.theirs.summary, "160", "theirs is the change that was kept (core's ours, head)");
  assert.equal(first.provisional, "theirs", "the kept change is what shows now");
  assert.notEqual(first.id, first.path, "Conflict.id is opaque: never the path");
  await ui.resolve(first.id, "theirs"); // keep what shows: no commit, the card goes
  assert.deepEqual(ui.conflicts().map((c) => ui.cardFor<HostCard>(c.id)?.cid), ["k2"], "only that card went");
  assert.equal(ui.cardFor(first.id), undefined);
  await settle();
  assert.equal((await carton.log()).length, 1, "nothing committed for keeping what shows");
  ui.dispose();
});
