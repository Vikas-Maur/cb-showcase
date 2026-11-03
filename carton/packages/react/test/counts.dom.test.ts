// One counting rule for changes, over the real engine (laptop re-check, 2026-11-02):
// - P3 fold counts: after folding a cut into Main with only its split left out, the Fold dialog said "2 changes" (the
//   split one row), the History row "1 of 4 changes" and `cb history` "merge (3 left out)". A split is one change.
// - P3-11: Compare said "3 changes" where Watch the changes said "2 changes · Change 1 of 2" for the same pair. Both
//   count changes the same way; Watch's counter steps through the sections of the edit that differ.
// - P3-10: Compare's "Clips: 7 clips" counted titles as clips.
// `npm test` runs it on React 19, then on preact/compat.
import { $, $$, React, byText, cleanup, click, closeDom, flush, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CartonProvider, CompareCard, FoldInDialog, HistoryPanel, WatchTheChanges, fromCarton } from "../src/index.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    // as Cardboard's: a text item is a title, not a clip
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", nounOf: (r) => (r.type === "text" ? "title" : undefined), groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: "clip.mp4", ...more });
const title = (id: string, s: number, e: number): Rec => ({ id, type: "text", trackId: "t2", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };

async function open() {
  const doc = { tracks: [{ id: "t1", [POS]: "V" }, { id: "t2", [POS]: "W" }], items: [clip("a", 0, 6), clip("b", 6, 10, { mediaItemId: "m2", name: "other.mp4" }), title("W1", 0, 2), title("W2", 2, 4)] };
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}
/** The editor's Split at playhead of 'a' at 2.0 s, and a rename of 'b': two changes. */
const splitAndRename = () => {
  const a = clip("a", 0, 6);
  return [
    { op: "remove" as const, path: ["items", "a"] },
    { op: "insert" as const, path: ["items", "p1"], value: { ...a, id: "p1", endTime: 2, trimEnd: 2 } },
    { op: "insert" as const, path: ["items", "p2"], value: { ...a, id: "p2", startTime: 2, trimStart: 2 } },
    { op: "set" as const, path: ["items", "b", "name"], value: "Outro" },
  ];
};

test(name("P3: the Fold dialog, the History row and the fold agree: a split left out is one change of two"), async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("Alt");
  await carton.commit({ cut: v.id, ops: splitAndRename() });
  await ui.refresh();
  let done = 0;
  const m = await render(h(CartonProvider, { ui }, h(FoldInDialog, { fromCutId: v.id, intoCutId: main, onClose: () => {}, onDone: () => void done++ })));
  await waitFor(() => $$(m.container, ".carton-fold-change").length === 2, "two rows: the split and the rename");
  assert.match(m.container.textContent ?? "", /2 changes/);
  const split = $$(m.container, ".carton-fold-change").find((r) => /Split “clip\.mp4”/.test(r.textContent ?? ""))!;
  await click($(split, "input[type=checkbox]"));
  await flush();
  await click(byText(m.container, "button", /^Fold in 1 of 2$/));
  await waitFor(() => done === 1, "folded");
  await m.unmount();
  await ui.refresh();
  const p = await render(h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 600 })));
  await waitFor(() => /Folded in “Alt”/.test(p.container.textContent ?? ""), "the fold's row");
  assert.equal((await carton.log({ cut: main, limit: 1 }))[0]!.leftOutChanges, 1, "what cb history says it left out");
  await p.unmount();
  ui.dispose();
});

test(name("P3-11, P3-10: Compare and Watch the changes count the same changes; Compare's clips leave titles apart"), async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  await carton.commit({ ops: splitAndRename() });
  await ui.refresh();
  const a = `${main}@0`, b = `${main}@1`;
  const c = await render(h(CartonProvider, { ui }, h(CompareCard, { a, b })));
  await waitFor(() => /changes ·/.test(c.container.textContent ?? ""), "Compare's summary");
  // two changes (the split and the rename), whatever the lines; titles are no clips
  assert.match(c.container.textContent ?? "", /2 changes · /);
  assert.match(c.container.textContent ?? "", /2 clips, 2 titles/, "before: a and b, and two titles");
  assert.match(c.container.textContent ?? "", /3 clips, 2 titles/, "after: the split's two parts and b");
  await c.unmount();
  const w = await render(h(CartonProvider, { ui }, h(WatchTheChanges, { a, b, inPlayer: true })));
  await waitFor(() => /changes ·/.test(w.container.textContent ?? ""), "Watch's summary");
  assert.match($(w.container, ".carton-watch-summary")!.textContent ?? "", /^2 changes · /, "the same count as Compare");
  assert.match($(w.container, ".carton-watch-count")?.textContent ?? "", /^1 of \d+$/, "the counter steps through sections");
  await w.unmount();
  ui.dispose();
});
