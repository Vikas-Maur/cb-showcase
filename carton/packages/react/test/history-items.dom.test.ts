// The History panel and the Fold dialog in a DOM, over the real engine (UI audit 2026-11-02):
// - P1-5: a version of several changes shows its summary, and the full list on expand.
// - P1-4: the Fold dialog offers what an earlier partial fold left out ("Left out earlier"); its changes fold in, or
//   stay left out, together; "You can fold in the rest later" holds.
// - P1-10: the filter is "Agent turns".
// `npm test` runs it on React 19, then on preact/compat.
import { $, $$, React, byText, cleanup, click, closeDom, flush, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CartonProvider, FoldInDialog, HistoryPanel, fromCarton } from "../src/index.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: { tracks: { seq: true }, items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] } },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color: "red" });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });

async function open() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20)] }, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}

test(name("P1-5: a version of several changes shows its summary; expanding it lists every change"), async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "startTime", 2), set("a", "endTime", 7), set("b", "name", "B1"), set("c", "name", "C1")] });
  await ui.refresh();
  const m = await render(h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 600 })));
  await waitFor(() => /Moved 'A', changed 'B' and 'C'/.test(m.container.textContent ?? ""), "the summary");
  const row = $$(m.container, "[role=option]")[0]!;
  const more = $(row, ".carton-version-expand")!;
  assert.ok(more, "an expand control on the row");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal($(row, ".carton-version-details"), null, "collapsed: no list");
  await click(more);
  await flush();
  const open1 = $$(m.container, "[role=option]")[0]!;
  assert.equal($(open1, ".carton-version-expand")!.getAttribute("aria-expanded"), "true");
  const items = $$(open1, ".carton-version-details li").map((li) => li.textContent);
  assert.deepEqual(items, ["Moved 'A' 0.0 s → 2.0 s", 'Changed \'B\' name "B" → "B1"', 'Changed \'C\' name "C" → "C1"']);
  // the rows below make room: the next row starts below the expanded one
  const vrows = $$(m.container, ".carton-vrow");
  const y = (el: HTMLElement) => Number(/translateY\((\d+)px\)/.exec(el.style.transform)?.[1]);
  assert.ok(y(vrows[1]!) >= y(vrows[0]!) + Number.parseFloat(vrows[0]!.style.height), "the next row is below the expanded one");
  assert.ok(Number.parseFloat(vrows[0]!.style.height) > 52, "the expanded row is taller");
  await click($(open1, ".carton-version-expand"));
  await flush();
  assert.equal($($$(m.container, "[role=option]")[0]!, ".carton-version-details"), null, "collapsed again");
  // a version of one change has nothing to expand
  assert.equal($($$(m.container, "[role=option]").at(-1)!, ".carton-version-expand"), null);
  await m.unmount();
  ui.dispose();
});

test(name("P1-10: the turns filter reads 'Agent turns'"), async () => {
  const { ui } = await open();
  const m = await render(h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 400 })));
  assert.ok(byText(m.container, "[role=radio]", "Agent turns"));
  await click(byText(m.container, "[role=radio]", "Agent turns"));
  assert.match(m.container.textContent ?? "", /No agent turns yet/);
  await m.unmount();
  ui.dispose();
});

test(name("P1-4: Fold in offers what a partial fold left out, together; leaving it out keeps it for later"), async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("Alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "A1"), set("b", "name", "B1"), set("c", "name", "C1")] });
  await ui.refresh();
  await ui.planFold(v.id, main);
  assert.equal((await ui.fold(v.id, main, { leaveOut: ["items/b", "items/c"], choices: {} })).ok, true);
  let done = 0;
  const m = await render(h(CartonProvider, { ui }, h(FoldInDialog, { fromCutId: v.id, intoCutId: main, onClose: () => {}, onDone: () => void done++ })));
  await waitFor(() => $$(m.container, ".carton-fold-change").length === 2, "the two changes left out");
  assert.doesNotMatch(m.container.textContent ?? "", /Nothing to fold in/);
  const rows = $$(m.container, ".carton-fold-change");
  for (const r of rows) assert.match(r.textContent ?? "", /Left out earlier/);
  // they fold in together: unticking one unticks both, and the dialog promises the rest later
  await click($(rows[0]!, "input[type=checkbox]"));
  await flush();
  assert.deepEqual($$(m.container, ".carton-fold-change input[type=checkbox]").map((c) => (c as HTMLInputElement).checked), [false, false]);
  await click($($$(m.container, ".carton-fold-change")[1]!, "input[type=checkbox]"));
  await flush();
  assert.deepEqual($$(m.container, ".carton-fold-change input[type=checkbox]").map((c) => (c as HTMLInputElement).checked), [true, true]);
  await click(byText(m.container, "button", /^Fold in$/));
  await waitFor(() => done === 1, "folded");
  const head = (await carton.head(main)).doc;
  assert.deepEqual(["a", "b", "c"].map((id) => (head.items as Rec[]).find((i) => i.id === id)!.name), ["A1", "B1", "C1"]);
  await m.unmount();
  ui.dispose();
});
