// Regression tests for review round 1 (reviews/ui.md): each test names the finding it pins. Real engine, no mocks,
// except where a test plays an engine event or result that store-memory can't produce yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type CartonEvent, type ConflictCard, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton, shotLabels, type FromCartonOptions } from "../src/from-carton.ts";

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
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("x/y", 10, 15), clip("d", 15, 20)] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", turn, chat: "c1", group: "alice@laptop" });
const bob: Actor = { kind: "human", id: "bob", name: "Bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const settle = () => new Promise((r) => setTimeout(r, 80));
const item = async (c: Carton, id: string, cut?: string) => ((await c.head(cut)).doc.items as Rec[]).find((i) => i.id === id)!;

async function open(extra: Partial<FromCartonOptions> = {}) {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const taps: ((e: CartonEvent) => void)[] = [];
  const realOn = carton.on.bind(carton);
  (carton as { on: typeof carton.on }).on = (l) => {
    taps.push(l);
    return realOn(l);
  };
  const ui = fromCarton(carton, { me: alice, ...extra });
  await ui.ready;
  return { carton, ui, emit: (e: CartonEvent) => taps.forEach((l) => l(e)) };
}

test("R1-1: a card that appears after the plan was reviewed is never decided by core: the fold stops and shows it", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs")], author: bob });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.conflicts.length, 0, "a clean plan");
  await carton.commit({ ops: [set("a", "name", "Mine")] }); // someone edits the target meanwhile
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: {} });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts?.[0]?.id, "items/a/name");
  assert.equal((await item(carton, "a")).name, "Mine", "nothing folded in");
  assert.notEqual((await carton.fold(v.id, { check: true })).status, "up-to-date", "the source is not recorded as merged");
  ui.dispose();
});

test("R1-1: with cards picked, a new card still stops the fold before anything is committed", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs"), set("b", "name", "B2")], author: bob });
  await carton.commit({ ops: [set("a", "name", "Mine")] });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.conflicts.length, 1);
  await carton.commit({ ops: [set("b", "name", "B-main")] });
  const seq = (await carton.log({ limit: 1 }))[0]!.ref.seq;
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: { "items/a/name": "theirs" } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts?.map((c) => c.id), ["items/b/name"]);
  assert.equal((await carton.log({ limit: 1 }))[0]!.ref.seq, seq, "no commit");
  ui.dispose();
});

test("R1-2: Keep both reads the real card, not a placeholder", async () => {
  const { carton, ui } = await open({ keepBoth: (card: ConflictCard) => ({ value: `${card.ours} + ${card.theirs}` }) });
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs")], author: bob });
  await carton.commit({ ops: [set("a", "name", "Mine")] });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.conflicts[0]!.canKeepBoth, true);
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: { "items/a/name": "both" } });
  assert.equal(r.ok, true);
  assert.equal((await item(carton, "a")).name, "Mine + Theirs");
  ui.dispose();
});

test("R1-3 (core fixed in 3cb8140): a project-level change can be left out like a clip", async () => {
  const { carton, ui } = await open();
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [{ op: "set", path: ["name"], value: "Film 2" }, set("b", "name", "B2")], author: bob });
  await ui.refresh();
  const plan = await ui.planFold(v.id, carton.cut);
  assert.equal(plan.changes.find((c) => c.id === "name")?.locked, undefined);
  assert.equal((await ui.fold(v.id, carton.cut, { leaveOut: ["name"], choices: {} })).ok, true);
  const head = (await carton.head()).doc;
  assert.equal(head.name, "Film", "left out, and still a plain value");
  assert.equal((await item(carton, "b")).name, "B2");
  ui.dispose();
});

test("R1-4: leaving out a clip whose id contains '/' leaves exactly that clip out", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("x/y", "color", "blue"), set("b", "color", "blue")], author: bob });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  const xy = plan.changes.find((c) => c.id === "items/x~1y");
  assert.ok(xy, "the change is keyed by the escaped path");
  const r = await ui.fold(v.id, main, { leaveOut: [xy!.id], choices: {} });
  assert.equal(r.ok, true);
  assert.equal((await item(carton, "x/y")).color, "red", "left out");
  assert.equal((await item(carton, "b")).color, "blue", "folded in");
  ui.dispose();
});

test("R1-5: a card belongs to its cut: hidden on other cuts, and resolving it commits there", async () => {
  const { carton, ui, emit } = await open();
  const main = carton.cut;
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [{ kind: "field", path: "items/a/name", base: "A", ours: "Head", theirs: "Mine" }] } });
  const id = ui.conflicts()[0]!.id;
  const other = await carton.fork("alt");
  await ui.switchCut(other.id);
  assert.equal(ui.conflicts().length, 0, "not shown on another cut");
  await ui.resolve(id, "mine");
  assert.equal((await item(carton, "a", main)).name, "Mine", "applied on its own cut");
  assert.equal((await item(carton, "a", other.id)).name, "A", "the other cut is untouched");
  ui.dispose();
});

test("R1-6: an undo card offers the value the undo would restore; picking it applies it", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t1") });
  await carton.commit({ ops: [set("a", "color", "green")], author: bob });
  await settle();
  const turn = ui.undoTurn()!;
  const r = await ui.undo(turn.id);
  assert.equal(r.ok, false);
  const card = ui.conflicts()[0]!;
  assert.equal(card.mine.summary, "“red”", "your side: what the undo restores");
  assert.equal(card.theirs.summary, "“green”", "shown now: the teammate's value");
  await ui.resolve(card.id, "mine");
  assert.equal((await item(carton, "a")).color, "red");
  ui.dispose();
});

test("R1-7: a commit that lands while History is loading is kept", async () => {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realLog = carton.log.bind(carton);
  let first = true;
  (carton as { log: typeof carton.log }).log = async (o) => {
    const got = await realLog(o);
    if (first) {
      first = false;
      await gate;
    }
    return got;
  };
  const ui = fromCarton(carton, { me: alice });
  await carton.commit({ ops: [set("a", "name", "Intro")] });
  await settle();
  release();
  await ui.ready;
  await settle();
  assert.equal(ui.history().count("all"), 2);
  assert.equal(ui.history().at("all", 0)!.seq, 1);
  ui.dispose();
});

test("R1-8: a second conflict on the same field, with other values, is its own card", async () => {
  const { ui, emit } = await open();
  const card = (ours: string, theirs: string) => ({ kind: "field" as const, path: "items/a/name", base: "A", ours, theirs });
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [card("H1", "M1")] } });
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [card("H1", "M1")] } });
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [card("H2", "M2")] } });
  assert.equal(ui.conflicts().length, 2, "the same card twice is shown once; other values are another card");
  ui.dispose();
});

test("R1-9: fold in the rest of a partial fold, once", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("b", "color", "blue"), set("d", "color", "blue")], author: bob });
  await ui.refresh();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} })).ok, true);
  assert.equal((await item(carton, "d")).color, "red");
  const inv = ui.history().at("all", 0)!;
  assert.equal(inv.foldRest, true, "the partial fold's version offers the rest");
  assert.equal((await ui.foldRest(inv.id)).ok, true);
  assert.equal((await item(carton, "d")).color, "blue", "the rest is folded in");
  await settle();
  assert.equal(ui.history().at("all", 1)!.foldRest, undefined, "no longer offered");
  assert.equal((await ui.foldRest(inv.id)).ok, false, "a second time does nothing");
  assert.equal((await item(carton, "d")).color, "blue");
  ui.dispose();
});

test("R1-10, R2-3, R2-6: 'every difference shown as a card' folds through core with the picks, Keep both included", async () => {
  const { carton, ui } = await open({ keepBoth: (card: ConflictCard) => ({ value: { name: `${(card.ours as Rec).name} + ${(card.theirs as Rec).name}` } }) });
  const main = carton.cut;
  const v = await carton.fork("alt");
  // store-memory can't make a missing base: play core's answers, and check what the adapter asks core to do.
  const cards: ConflictCard[] = [
    { kind: "compare", path: "items/a", base: null, ours: { name: "A" }, theirs: { name: "Theirs" }, ops: [] },
    { kind: "compare", path: "items/b", base: null, ours: { name: "B" }, theirs: { name: "B2" }, ops: [] },
    { kind: "compare", path: "items/d", base: null, ours: { name: "D" }, theirs: { name: "D2" }, ops: [] },
  ];
  const calls: { choices?: unknown; missingBase?: string }[] = [];
  const realFold = carton.fold.bind(carton);
  (carton as { fold: typeof carton.fold }).fold = async (from, o) => {
    if (o?.missingBase !== "all-cards") return realFold(from, o);
    calls.push({ choices: o.choices, missingBase: o.missingBase });
    if (o.check || !o.choices) return { status: "compare", dialog: { text: "", options: ["ask", "all-cards"], lca: null }, cards };
    return { status: "confirmed", seq: 1, ref: { branchId: main, seq: 1, pending: [] }, change: null, rebased: 0, notices: [] };
  };
  const plan = await ui.planFold(v.id, main, { allCards: true });
  assert.equal(plan.conflicts.length, 3);
  assert.equal(plan.partial, false);
  // Core's compare2 applies {value} choices (99db79c): compare cards offer Keep both again (R3-3 lifted).
  assert.ok(plan.conflicts.every((c) => c.canKeepBoth));
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: { "items/a": "theirs", "items/b": "mine", "items/d": "both" }, allCards: true });
  assert.equal(r.ok, true);
  const last = calls.at(-1)!;
  assert.equal(last.missingBase, "all-cards", "core makes the all-cards fold (with its base and its merge record)");
  const pick = last.choices as (c: ConflictCard, i: number) => unknown;
  assert.equal(pick(cards[0]!, 0), "theirs");
  assert.equal(pick(cards[1]!, 1), "ours");
  assert.deepEqual(pick(cards[2]!, 2), { value: { name: "D + D2" } }, "Keep both goes to core as the host's value");
  assert.throws(() => pick({ ...cards[0]!, theirs: { name: "Changed since" } }, 0), "a card whose values changed is not the one reviewed");
  ui.dispose();
});

test("R1-11 and R1-12: a provisional row can't be previewed or restored, and an absorbed one goes away", async () => {
  const previews: unknown[] = [];
  const { carton, ui, emit } = await open({ onPreview: (p) => previews.push(p) });
  emit({ type: "pending", branchId: carton.cut, id: "rid.7" });
  const v = ui.history().at("all", 0)!;
  assert.equal(v.provisional, true);
  ui.openPreview(v.ref, "x");
  assert.equal(ui.preview(), null);
  await assert.rejects(ui.restore(v.ref), /waiting to sync/);
  emit({ type: "absorbed", branchId: carton.cut, id: "rid.7", cards: [] });
  assert.equal(ui.history().at("all", 0)!.provisional, undefined);
  assert.equal(ui.history().count("all"), 1);
  assert.deepEqual(previews, []);
  ui.dispose();
});

test("R1-11: a preview whose state can't be rebuilt closes instead of failing silently", async () => {
  const previews: unknown[] = [];
  const { carton, ui } = await open({ onPreview: (p) => previews.push(p) });
  ui.openPreview(`${carton.cut}@99`, "gone");
  assert.equal(ui.preview()?.label, "gone");
  await settle();
  assert.equal(ui.preview(), null);
  assert.deepEqual(previews, [null]);
  ui.dispose();
});

test("R1-16 and R1-17: an append changes only the tail; a refresh with nothing new keeps every object", async () => {
  const { carton, ui } = await open();
  for (let i = 0; i < 20; i++) await carton.commit({ ops: [set("a", "color", `c${i}`)] });
  await settle();
  const h = ui.history();
  const rev = h.revision();
  const before = h.all!();
  await carton.commit({ ops: [set("b", "color", "x")] });
  await settle();
  assert.ok(h.firstChangedSince!(rev) >= before.length - 1, "only the tail changed");
  const snap = h.all!();
  const r2 = h.revision();
  await ui.refresh();
  assert.equal(h.revision(), r2, "nothing changed");
  const after = h.all!();
  assert.ok(after.every((v, i) => v === snap[i]), "same objects: memoized rows don't re-render, the bridge sends nothing");
  ui.dispose();
});

test("R1-18 (core added renameCut): rename a cut", async () => {
  const { carton, ui } = await open();
  const v = await carton.fork("alt");
  await ui.refresh();
  await ui.renameCut!(v.id, "30s Instagram cut");
  assert.equal(ui.cuts().find((c) => c.id === v.id)?.name, "30s Instagram cut");
  ui.dispose();
});

test("R1-19: shot labels in one sweep match the plain per-shot search", () => {
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 30; round++) {
    const items: Rec[] = [];
    for (let i = 0; i < 40; i++) {
      const s = Math.floor(rnd() * 50), e = s + 1 + Math.floor(rnd() * 10);
      items.push({ id: `i${i}`, trackId: "t1", startTime: s, endTime: e, name: `N${i}` });
    }
    const shots: { start: number; end: number }[] = [];
    for (let t = 0; t < 60; t += 1 + Math.floor(rnd() * 3)) shots.push({ start: t, end: t + 1 + Math.floor(rnd() * 2) });
    for (let i = 1; i < shots.length; i++) shots[i]!.start = shots[i - 1]!.end, (shots[i]!.end = Math.max(shots[i]!.end, shots[i]!.start + 1));
    const doc = { tracks: [], items };
    const naive = shots.map((s) => {
      let best: Rec | undefined;
      for (const it of items) if ((it.startTime as number) <= s.start && (it.endTime as number) >= s.end) best = it;
      return best ? String(best.name) : undefined;
    });
    assert.deepEqual(shotLabels(doc, shots, schema), naive);
  }
});
