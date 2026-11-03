// fromCarton()'s cuts and fold plans for the UX redesign's cuts menu and Fold dialog (docs/carton-ux PLAN 6.1, 6.3),
// over the real engine (Carton.open on store-memory): who changed each cut last, its colour dot, how the two cuts of a
// fold are related, and when an earlier partial fold left a change out. The counts and what folds are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CUT_COLORS, cutColor, cutColors, cutRef } from "../src/cuts.ts";
import { fromCarton } from "../src/from-carton.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase() });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director: Actor = { kind: "agent", id: "director", name: "Director", turn: "t1", chat: "c1", group: "alice@laptop" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });

async function open() {
  let now = Date.UTC(2026, 10, 3, 12, 0);
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] }, cutName: "Main cut" }, actor: alice, clock: () => (now += 60_000) });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}

test("cuts: who made each cut's newest version, and a colour dot for every cut but Main, in the order they were made", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const alt = await carton.fork("Alt");
  const teaser = await carton.fork("Teaser");
  await carton.commit({ cut: alt.id, ops: [set("a", "name", "Intro")], author: director });
  await carton.commit({ cut: main, ops: [set("b", "name", "Outro")] });
  await ui.refresh();
  const cuts = ui.cuts();
  const of = (id: string) => cuts.find((c) => c.id === id)!;
  assert.equal(of(main).color, undefined, "Main cut has no dot");
  assert.equal(cutColor(of(main)), undefined);
  assert.equal(of(alt.id).color, CUT_COLORS[0]);
  assert.equal(of(teaser.id).color, CUT_COLORS[1], "the first eight cuts never share one");
  assert.equal(of(alt.id).updatedBy?.name, "Director", "the Director made Alt's newest version");
  assert.equal(of(main).updatedBy?.isYou, true);
  // a head that moves keeps the colour, and the cut object changes only when what it shows does
  const before = ui.cuts();
  await ui.refresh();
  assert.equal(ui.cuts().find((c) => c.id === alt.id), before.find((c) => c.id === alt.id), "same object while nothing changed");
  ui.dispose();
});

test("fold plan: how the cuts are related (made from each other, and when), both ways; none for two siblings", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const alt = await carton.fork("Alt");
  const other = await carton.fork("Other");
  await carton.commit({ cut: alt.id, ops: [set("a", "name", "Intro")] });
  await ui.refresh();
  const made = (await carton.cuts()).find((c) => c.id === alt.id)!.at!;
  const into = await ui.planFold(alt.id, main);
  assert.deepEqual(into.made, { which: "from", at: made }, "Alt was made from Main cut");
  assert.equal(into.changes.length, 1, "the count is the count");
  const back = await ui.planFold(main, alt.id);
  assert.deepEqual(back.made, { which: "into", at: made }, "folding Main into Alt: Alt was made from it");
  const siblings = await ui.planFold(other.id, alt.id);
  assert.equal(siblings.made, undefined);
  ui.dispose();
});

test("fold plan: what an earlier partial fold left out says when (Left out on …); the fold of the rest is unchanged", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const alt = await carton.fork("Alt");
  await carton.commit({ cut: alt.id, ops: [set("a", "name", "A1"), set("b", "name", "B1")] });
  await ui.refresh();
  const plan = await ui.planFold(alt.id, main);
  assert.equal(plan.changes.length, 2);
  assert.equal((await ui.fold(alt.id, main, { leaveOut: ["items/b"], choices: {} })).ok, true);
  const folded = (await carton.log({ cut: main, limit: 1 }))[0]!;
  assert.equal(folded.leftOutChanges, 1, "what cb history says it left out");
  const rest = await ui.planFold(alt.id, main);
  assert.equal(rest.changes.length, 1, "only what was left out");
  assert.equal(rest.changes[0]!.leftOut !== undefined, true);
  assert.equal(rest.changes[0]!.leftOutAt, folded.at, "when it was left out");
  assert.equal((await ui.fold(alt.id, main, { leaveOut: [], choices: {} })).ok, true);
  const head = (await carton.head(main)).doc;
  assert.deepEqual((head.items as Rec[]).map((i) => i.name), ["A1", "B1", "C"]);
  ui.dispose();
});

test("fold plan (review P1): an older plan still running when another pair is planned never feeds the fold", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const a = await carton.fork("A");
  const b = await carton.fork("B");
  // A folded in with b left out: A's rest is b's rename
  await carton.commit({ cut: a.id, ops: [set("a", "name", "A1"), set("b", "name", "B1")] });
  await ui.refresh();
  await ui.planFold(a.id, main);
  assert.equal((await ui.fold(a.id, main, { leaveOut: ["items/b"], choices: {} })).ok, true);
  await carton.commit({ cut: b.id, ops: [set("c", "name", "C1")] });
  await ui.refresh();
  // The dialog's From goes from A to B while A's plan is still reading what was left out (slowed here)
  const leftOut = carton.leftOut.bind(carton);
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  (carton as { leftOut: typeof carton.leftOut }).leftOut = async (from, o) => {
    const list = await leftOut(from, o);
    if (from === a.id) await slow;
    return list;
  };
  const planA = ui.planFold(a.id, main);
  const planB = await ui.planFold(b.id, main);
  assert.deepEqual(planB.changes.map((c) => c.summary.length > 0), [true], "B: its one change");
  release();
  await planA; // finishes last
  assert.equal((await ui.fold(b.id, main, { leaveOut: [], choices: {} })).ok, true);
  const head = (await carton.head(main)).doc;
  assert.deepEqual((head.items as Rec[]).map((i) => i.name), ["A1", "B", "C1"], "B's change only: A's left-out rename stays out");
  ui.dispose();
});

test("queued switch (review P2): checked in the view model, a switch made since wins (onlyFrom)", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const x = await carton.fork("X");
  const y = await carton.fork("Y");
  await ui.refresh();
  // the page still thinks it's on Main; the handle was switched to Y meanwhile (by hand, or `cb cut switch`)
  await carton.switchTo(y.id);
  await ui.switchCut(x.id, { onlyFrom: main });
  assert.equal(carton.cut, y.id, "the queued switch to X didn't override Y");
  await ui.switchCut(x.id, { onlyFrom: y.id });
  assert.equal(carton.cut, x.id, "from the cut it was queued on, it switches");
  ui.dispose();
});

test("cut colours and names in sentences: a teammate's cut a palette colour none of yours has; Main cut bare, any other in quotes", () => {
  const leo = { key: "human/leo", kind: "human" as const, name: "Leo", color: "#f0a35e" };
  const colors = cutColors(
    [
      { id: "m", kind: "main", readOnly: false },
      { id: "x", kind: "cut", readOnly: false },
      { id: "leo-m", kind: "main", readOnly: true },
      { id: "y", kind: "director", readOnly: false },
    ],
    (id) => (id === "leo-m" ? leo : undefined),
  );
  // design QA G25: not the owner's presence colour, which may sit beside amber ("#f0a35e" here); the first free hue
  // from the owner's key, so two 8 px dots never read as one
  assert.deepEqual(new Map([...colors].filter(([id]) => id !== "leo-m")), new Map([["x", CUT_COLORS[0]], ["y", CUT_COLORS[1]]]));
  assert.ok(colors.get("leo-m") && ![CUT_COLORS[0], CUT_COLORS[1], "#f0a35e"].includes(colors.get("leo-m")!), String(colors.get("leo-m")));
  assert.equal(cutRef({ kind: "main", readOnly: false, label: "Main cut" }), "Main cut");
  assert.equal(cutRef({ kind: "cut", readOnly: false, label: "30s cut" }), "“30s cut”");
  assert.equal(cutRef({ kind: "main", readOnly: true, label: "Leo's Main cut" }), "“Leo's Main cut”");
});
