// Laptop re-check of merge/prod-2 (P3): the History panel over the real engine (Carton.open on store-memory, no mocks).
// #1 A cut made by another process (`cb cut new`, no edit yet) or renamed there shows in the cut menu once the
//    panel's handle reads the store again (the app's panel reads the head every second), without switching to it.
// #2 A split clip is one change in the Fold dialog, worded as the split, and left out whole.
// N-1 (laptop, merge/prod-2) A title deleted with its own media entry is one row too, the title's, left out with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
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
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: "clip.mp4", ...more });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 6), clip("b", 6, 10, { mediaItemId: "m2", name: "other.mp4" })] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };

test("#1: a cut another process makes (no edit yet) or renames shows in the cut menu at the panel's next read", async () => {
  const store = createMemoryStore();
  const carton = await Carton.open({ adapter, store, init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const cb = await Carton.open({ adapter, store, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  try {
    await ui.ready;
    let told = 0;
    const off = ui.subscribe("cuts", () => void told++);
    assert.deepEqual(ui.cuts().map((c) => c.name), ["Main cut"]);

    const alt = await cb.fork("Alt cut"); // cb cut new
    await carton.log({ limit: 1 }); // the panel's poll of the head (scripts/carton: one small read a second)
    await ui.settled();
    assert.deepEqual(ui.cuts().map((c) => c.name).sort(), ["Alt cut", "Main cut"], "the new cut is in the menu");
    assert.equal(ui.cuts().find((c) => c.current)?.name, "Main cut", "without switching to it");
    assert.ok(told >= 1, "the cuts topic was told");

    await cb.renameCut(alt.id, "30s Instagram cut");
    await carton.log({ limit: 1 });
    await ui.settled();
    assert.equal(ui.cuts().find((c) => c.id === alt.id)?.name, "30s Instagram cut", "the rename shows");
    off();
  } finally {
    ui.dispose();
    await cb.close();
    await carton.close();
  }
});

test("#2: a split is one change in the Fold dialog, 'Split 'clip.mp4' at 2.0 s', left out whole", async () => {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  try {
    await ui.ready;
    const main = carton.cut;
    const alt = await carton.fork("Alt cut");
    await carton.switchTo(alt.id);
    // the editor's Split at playhead: the clip goes, two parts take its place
    const a = clip("a", 0, 6);
    await carton.commit({
      ops: [
        { op: "remove", path: ["items", "a"] },
        { op: "insert", path: ["items", "p1"], value: { ...a, id: "p1", endTime: 2, trimEnd: 2 } },
        { op: "insert", path: ["items", "p2"], value: { ...a, id: "p2", startTime: 2, trimStart: 2 } },
        { op: "set", path: ["items", "b", "name"], value: "Outro" },
      ],
    });
    await ui.settled();
    const plan = await ui.planFold(alt.id, main);
    const words = plan.changes.map((c) => c.summary).sort();
    assert.deepEqual(words, ["Changed 'other.mp4' name \"other.mp4\" → \"Outro\"", "Split 'clip.mp4' at 2.0 s"], "one row for the split: " + JSON.stringify(words));
    const split = plan.changes.find((c) => c.summary.startsWith("Split"))!;
    assert.equal(split.author.name, "Alice", "credited to who split it");

    // left out: none of its three records comes in
    assert.deepEqual(await ui.fold(alt.id, main, { choices: {}, leaveOut: [split.id] }), { ok: true });
    const ids = ((await carton.head(main)).doc.items as Rec[]).map((r) => r.id).sort();
    assert.deepEqual(ids, ["a", "b"], "the split stays out whole");
    // folded in later (Fold in the rest): one row again, and the parts come in
    await ui.settled();
    const rest = await ui.planFold(alt.id, main);
    assert.deepEqual(rest.changes.map((c) => c.summary), ["Split 'clip.mp4' at 2.0 s"], "the row left out is still one row");
  } finally {
    ui.dispose();
    await carton.close();
  }
});

test("review P2: a split row left out stays out whole when its part was split again after the plan was shown", async () => {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  try {
    await ui.ready;
    const main = carton.cut;
    const alt = await carton.fork("Alt cut");
    await carton.switchTo(alt.id);
    const a = clip("a", 0, 6);
    const p2 = { ...a, id: "p2", startTime: 2, trimStart: 2 };
    await carton.commit({ ops: [{ op: "remove", path: ["items", "a"] }, { op: "insert", path: ["items", "p1"], value: { ...a, id: "p1", endTime: 2, trimEnd: 2 } }, { op: "insert", path: ["items", "p2"], value: p2 }] });
    await ui.settled();
    const plan = await ui.planFold(alt.id, main);
    const split = plan.changes.find((c) => c.summary.startsWith("Split"))!;
    assert.ok(split, JSON.stringify(plan.changes));
    // while the dialog is open, the right part is split again on the cut folded in
    await carton.commit({ cut: alt.id, ops: [{ op: "remove", path: ["items", "p2"] }, { op: "insert", path: ["items", "p3"], value: { ...p2, id: "p3", endTime: 4, trimEnd: 4 } }, { op: "insert", path: ["items", "p4"], value: { ...p2, id: "p4", startTime: 4, trimStart: 4 } }] });
    const r = await ui.fold(alt.id, main, { choices: {}, leaveOut: [split.id] });
    assert.deepEqual(r, { ok: true });
    const ids = ((await carton.head(main)).doc.items as Rec[]).map((x) => x.id).sort();
    assert.deepEqual(ids, ["a", "b"], "none of the split's parts came in");
  } finally {
    ui.dispose();
    await carton.close();
  }
});

// a media collection whose text entries are part of the title that uses them (Cardboard's nounOf: null)
const withMedia = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
    media: { nounOf: (r) => ((r.data as Rec | undefined)?.type === "text" ? null : undefined) },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as { data?: Rec } | undefined)?.data?.fileName ?? coll),
});
const mediaAdapter: HostAdapter<Doc> = { name: "test-media", schema: withMedia, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };

test("N-1: a title deleted with its own media entry is one row in the Fold dialog, the title's, left out with it", async () => {
  const title = (k: number): Rec => ({ id: `w${k}`, type: "text", trackId: "t1", mediaItemId: `tm${k}`, startTime: k, endTime: k + 1, trimStart: 0, trimEnd: 1, name: `W${k}` });
  const entry = (k: number): Rec => ({ id: `tm${k}`, data: { type: "text", fileName: `Text: W${k}` } });
  const doc: Doc = { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [title(1), title(2)], media: [entry(1), entry(2)] };
  const carton = await Carton.open({ adapter: mediaAdapter, store: createMemoryStore(), init: { doc, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  try {
    await ui.ready;
    const main = carton.cut;
    const alt = await carton.fork("Alt cut");
    await carton.switchTo(alt.id);
    await carton.commit({ ops: [{ op: "remove", path: ["items", "w2"] }, { op: "remove", path: ["media", "tm2"] }] });
    await ui.settled();
    const plan = await ui.planFold(alt.id, main);
    assert.deepEqual(plan.changes.map((c) => c.summary), ["Deleted text 'W2'"], "one row, the title's");
    assert.deepEqual(await ui.fold(alt.id, main, { choices: {}, leaveOut: [plan.changes[0]!.id] }), { ok: true });
    const head = (await carton.head(main)).doc;
    assert.deepEqual([(head.items as Rec[]).map((r) => r.id).sort(), (head.media as Rec[]).map((r) => r.id).sort()], [["w1", "w2"], ["tm1", "tm2"]], "left out together");
  } finally {
    ui.dispose();
    await carton.close();
  }
});
