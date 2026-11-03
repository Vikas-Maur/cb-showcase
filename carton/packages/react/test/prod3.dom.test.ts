// The Fold dialog over the real engine (laptop re-check of merge/prod-2, regress prod3, 2026-11-02):
// - P3-B: a row read "Moved 'W1' to track another track, font size 100 → 150": the version also adds track 'Text 1'
//   and moves W1 onto it, and each row was described alone against Main, which hasn't that track yet.
// - P3-C: a title's own media entry (Cardboard adds "Text: W1" per title) is the title's: one row with it, left out
//   with it, and counted once, as History's row, its list and the fold's count tell it.
// `npm test` runs it on React 19, then on preact/compat.
import { $$, React, byText, cleanup, click, closeDom, flush, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, getIn, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CartonProvider, FoldInDialog, fromCarton } from "../src/index.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    // as Cardboard's: a text item is a title; a title's own media entry is no media file
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", nounOf: (r) => (r.type === "text" ? "title" : undefined), groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
    media: { noun: "media", nounOf: (r) => (r.type === "text" ? null : undefined), partOf: { collection: "items", field: "mediaItemId" } },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const title = (id: string, s: number, more: Rec = {}): Rec => ({ id, type: "text", trackId: "t2", mediaItemId: `m-${id}`, startTime: s, endTime: s + 1, trimStart: 0, trimEnd: 1, name: id, ...more });
const own = (id: string): Rec => ({ id: `m-${id}`, type: "text", name: `Text: ${id}` });

async function open() {
  const doc = {
    tracks: [{ id: "t1", name: "Video 1", [POS]: "V" }, { id: "t2", name: "Titles", [POS]: "W" }],
    items: [{ id: "a", type: "video", trackId: "t1", mediaItemId: "m1", startTime: 0, endTime: 6, trimStart: 0, trimEnd: 6, name: "clip.mp4" }, title("W1", 1, { fontSize: 100 }), title("W2", 2)],
    media: [{ id: "m1", type: "video", name: "clip.mp4" }, own("W1"), own("W2")],
  };
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}

test(name("prod3 P3-B, P3-C: the dialog names a track the fold adds; a title and its own media entry are one row"), async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("Alt");
  // the stage toolbar's font size, which also put W1 on a new track 'Text 1'
  await carton.commit({ cut: v.id, ops: [
    { op: "insert", path: ["tracks", "t3"], value: { id: "t3", name: "Text 1", [POS]: "X" } },
    { op: "set", path: ["items", "W1", "trackId"], value: "t3" },
    { op: "set", path: ["items", "W1", "fontSize"], value: 150 },
  ] });
  // a new title, with the media entry Cardboard adds for it
  await carton.commit({ cut: v.id, ops: [
    { op: "insert", path: ["items", "W3"], value: title("W3", 3) },
    { op: "insert", path: ["media", "m-W3"], value: own("W3") },
  ] });
  await ui.refresh();
  let done = 0;
  const m = await render(h(CartonProvider, { ui }, h(FoldInDialog, { fromCutId: v.id, intoCutId: main, onClose: () => {}, onDone: () => void done++ })));
  await waitFor(() => $$(m.container, ".carton-fold-change").length > 0, "the rows");
  const rows = $$(m.container, ".carton-fold-change").map((r) => r.querySelector(".carton-fold-text")?.textContent ?? "");
  assert.ok(rows.includes("Moved “W1” to track “Text 1”, made it bigger (font size 100 → 150)"), rows.join(" | "));
  assert.ok(!rows.some((r) => /another track|Text: W3/.test(r)), rows.join(" | "));
  assert.equal(rows.length, 3, `the track, W1, and W3 with its entry: ${rows.join(" | ")}`);
  assert.match(m.container.textContent ?? "", /3 changes/);
  // leaving W3 out leaves its entry out with it
  const w3 = $$(m.container, ".carton-fold-change").find((r) => /W3/.test(r.textContent ?? ""))!;
  await click(w3.querySelector("input[type=checkbox]")!);
  await flush();
  await click(byText(m.container, "button", /^Fold in 2 of 3$/));
  await waitFor(() => done === 1, "folded");
  await m.unmount();
  const head = (await carton.head(main)).doc;
  assert.equal(getIn(head, ["items", "W3"], schema), undefined);
  assert.equal(getIn(head, ["media", "m-W3"], schema), undefined, "its media entry was left out with it");
  assert.equal((getIn(head, ["items", "W1"], schema) as Rec).trackId, "t3");
  const [f] = await carton.log({ cut: main, limit: 1, summary: true });
  assert.equal(f!.summary, "Folded 'Alt' into 'Main cut': 2 of 3 changes");
  assert.equal(f!.leftOutChanges, 1, "what cb history says it left out");
  ui.dispose();
});

// Review: a title and its duplicate share one media entry (Cardboard's Duplicate keeps mediaItemId). The entry is
// neither's alone: leaving the first title out must not take the entry its accepted duplicate shows.
test(name("prod3 P3-C (review): an entry two titles share is its own row; leaving one title out keeps it"), async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("Alt");
  await carton.commit({ cut: v.id, ops: [
    { op: "insert", path: ["items", "W3"], value: title("W3", 3) },
    { op: "insert", path: ["items", "W4"], value: title("W4", 4, { mediaItemId: "m-W3" }) },
    { op: "insert", path: ["media", "m-W3"], value: own("W3") },
  ] });
  await ui.refresh();
  let done = 0;
  const m = await render(h(CartonProvider, { ui }, h(FoldInDialog, { fromCutId: v.id, intoCutId: main, onClose: () => {}, onDone: () => void done++ })));
  await waitFor(() => $$(m.container, ".carton-fold-change").length > 0, "the rows");
  const rows = $$(m.container, ".carton-fold-change");
  assert.equal(rows.length, 3, rows.map((r) => r.textContent).join(" | "));
  const w3 = rows.find((r) => /“W3”/.test(r.querySelector(".carton-fold-text")?.textContent ?? ""))!;
  await click(w3.querySelector("input[type=checkbox]")!);
  await flush();
  await click(byText(m.container, "button", /^Fold in 2 of 3$/));
  await waitFor(() => done === 1, "folded");
  await m.unmount();
  const head = (await carton.head(main)).doc;
  assert.equal(getIn(head, ["items", "W3"], schema), undefined);
  assert.ok(getIn(head, ["items", "W4"], schema), "the duplicate came in");
  assert.ok(getIn(head, ["media", "m-W3"], schema), "with the entry it shows");
  ui.dispose();
});
