// Compare in the editor's parts (docs/carton-ux v2 DESIGN-V2 §1, N1), in a DOM, on React and on preact/compat: the
// compare bar's radio group, the three modes and the hole each leaves for the editor's own picture, Wipe's slider,
// Flip's pill, the change list (a row picked by a click or the keyboard, never by the focus it gets on opening), and the
// marks placed from the timeline's geometry.
import { $, $$, React, act, cleanup, click, closeDom, flush, key, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, CompareList, CompareMarks, CompareStageView } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import type { Change } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
const ui = createMockUi({ versions: 2 });
const wrap = (el: unknown) => h(CartonProvider, { ui }, el as never);
const left = { title: "Sent to client", detail: "yesterday at 4:10 pm", at: 1 };
const right = { title: "Your edit now", at: 1, step: "same" as const };

function stage(o: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const holes: (HTMLElement | null)[] = [];
  const el = wrap(h(CompareStageView, {
    left, right, label: "Comparing “Sent to client” with your edit", mode: "side", modes: ["side", "wipe", "flip"], ratio: 16 / 9, count: "7 changes",
    onMode: (m: string) => calls.push(["mode", m]), onDone: () => calls.push(["done"]), onFlip: (s: string, latch: boolean) => calls.push(["flip", s, latch]),
    onWipe: (p: number) => calls.push(["wipe", p]), onPlayBoth: () => calls.push(["play"]), holeRef: (e: HTMLElement | null) => holes.push(e),
    player: h("canvas", { "data-player": "" }), ...o,
  }));
  return { el, calls, holes };
}

test(name("Side by side: the left player and its label, the right side a hole for the editor's picture, the bar and Play both"), async () => {
  const s = stage();
  const m = await render(s.el);
  const root = $(m.container, ".carton-compare")!;
  assert.equal(root.getAttribute("aria-label"), "Comparing “Sent to client” with your edit");
  assert.equal(root.getAttribute("data-mode"), "side");
  assert.ok($(root, '[data-side="left"] canvas[data-player]'), "the second player on the left");
  const hole = $(root, '[data-side="right"] [data-hole]');
  assert.ok(hole && !hole.querySelector("canvas"), "the right: a hole, nothing over Cardboard's picture");
  assert.ok(s.holes.includes(hole as HTMLElement), "the host gets the hole");
  assert.deepEqual($$(root, ".carton-compare-label b").map((b) => b.textContent), ["Sent to client", "Your edit now"]);
  assert.match($(root, '[data-side="right"] .carton-compare-tc')!.textContent!, /same shot/);
  assert.equal($(root, ".carton-compare-count")?.textContent, "7 changes");
  await click($(root, ".carton-compare-done"));
  await click($$(root, ".carton-compare-transport button")[0]);
  assert.deepEqual(s.calls, [["done"], ["play"]]);
});

test(name("the modes are a radio group: ← → move and pick; Side by side greyed with its reason when the stage is narrow; compact"), async () => {
  const s = stage({ sideOff: true, mode: "wipe" });
  const m = await render(s.el);
  const radios = $$(m.container, "[role=radio]");
  assert.deepEqual(radios.map((r) => r.getAttribute("aria-checked")), ["false", "true", "false"]);
  assert.equal(radios[0]!.getAttribute("aria-disabled"), "true");
  assert.match(radios[0]!.getAttribute("data-carton-tip") ?? "", /needs a wider stage/);
  await click(radios[0]);
  assert.deepEqual(s.calls, [], "greyed: nothing");
  await key(radios[1], "ArrowRight");
  await key(radios[1], "ArrowLeft");
  assert.deepEqual(s.calls, [["mode", "flip"], ["mode", "flip"]], "← from Wipe skips the greyed Side by side, wrapping to Flip");
  await m.rerender(stage({ compact: true }).el);
  assert.deepEqual($$(m.container, "[role=radio]").map((r) => r.textContent), ["", "", "Flip"], "under 600 px: icons, Flip keeps its word");
  assert.equal($(m.container, ".carton-compare-done")?.textContent, "Done");
  assert.ok(!$(m.container, ".carton-compare-count"), "the count goes");
});

test(name("Wipe: one picture, the left player cut at the line; the line is a slider (← → Shift Home End, double-click)"), async () => {
  const s = stage({ mode: "wipe", wipe: 40 });
  const m = await render(s.el);
  const slider = $(m.container, "[role=slider]")!;
  assert.equal(slider.getAttribute("aria-valuenow"), "60");
  assert.equal(slider.getAttribute("aria-valuetext"), "60 % Your edit now");
  assert.match(($(m.container, ".carton-compare-wipe-left") as HTMLElement).style.clipPath, /inset\(0(px)? 60(\.00)?% 0(px)? 0(px)?\)/);
  assert.ok($(m.container, ".carton-compare-wipe-left canvas[data-player]"));
  assert.ok(s.holes.some((e) => e?.getAttribute("data-hole") === ""), "the picture's box is the hole");
  await key(slider, "ArrowRight");
  await key(slider, "Home");
  await act(() => void slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })));
  await flush();
  await act(() => void slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await flush();
  assert.deepEqual(s.calls, [["wipe", 45], ["wipe", 0], ["wipe", 39], ["wipe", 50]]);
});

test(name("Flip: one picture, its tag says which side; the pill: a press shows the left, a click latches it, the right side back"), async () => {
  const s = stage({ mode: "flip", flipped: false });
  const m = await render(s.el);
  assert.ok(!$(m.container, "canvas[data-player]"), "no second player in Flip");
  assert.match($(m.container, ".carton-compare-tag")!.textContent!, /Showing\s*Your edit now/);
  const [l, r] = $$(m.container, ".carton-compare-flipbar button");
  await act(() => void l!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
  await act(() => void l!.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })));
  await click(r);
  assert.deepEqual(s.calls, [["flip", "left", false], ["flip", "left", true], ["flip", "right", true]]);
  await m.rerender(stage({ mode: "flip", flipped: true }).el);
  assert.ok($(m.container, ".carton-compare-tag[data-left]"), "the left side shown: the tag turns blue");
  assert.match($(m.container, ".carton-compare-tag")!.textContent!, /Sent to client/);
});

const rows: Change[] = [
  { key: "timelineItems/a", itemId: "a", kind: "change", clip: "video", text: "Trimmed “Intro”, now ends at 0:05", at: 0, end: 5 },
  { key: "timelineItems/b", itemId: "b", kind: "add", clip: "video", text: "Added “Drone shot”", at: 12, end: 16 },
  { key: "timelineItems/c", itemId: "c", kind: "remove", clip: "video", text: "Removed “B-roll pier”", at: 5, end: 8 },
];

test(name("the change list: the range, the count, every row; a click or ↓ picks a row, the focus it gets on opening doesn't"), async () => {
  const picked: string[] = [];
  let back = 0;
  const list = (selected: string | null) => wrap(h(CompareList, { range: ["From “Sent to client”", "to your edit now"], count: "3 changes · 0:36", changes: rows, status: "ready", selected, onSelect: (c: Change) => picked.push(c.key), onBack: () => back++, footer: h("button", { className: "foot" }, "Restore…") }));
  const m = await render(list(null));
  await flush();
  assert.match($(m.container, ".carton-compare-range")!.textContent!, /From “Sent to client”\s*to your edit now/);
  assert.equal($(m.container, ".carton-compare-n")?.textContent, "3 changes · 0:36");
  assert.equal($$(m.container, ".carton-change").length, 3);
  assert.deepEqual(picked, [], "opening focuses the first row and picks nothing");
  await click($$(m.container, ".carton-change")[1]);
  assert.deepEqual(picked, ["timelineItems/b"]);
  await m.rerender(list("timelineItems/b"));
  assert.ok($(m.container, '.carton-change-selected[data-change-key="timelineItems/b"]'));
  const rowB = $(m.container, '.carton-change[data-change-key="timelineItems/b"]') as HTMLElement;
  await act(() => rowB.focus());
  await key(rowB, "ArrowDown");
  assert.deepEqual(picked, ["timelineItems/b", "timelineItems/c"], "↓: the next row, both players follow");
  await click($(m.container, ".carton-changes-nav button"));
  assert.equal(back, 1, "← History");
  assert.ok($(m.container, "footer .foot"));
});

test(name("the marks sit at start × pixels per second on their track's row; a seam for a removal that left no gap; a click picks"), async () => {
  const picked: string[] = [];
  const m = await render(wrap(h(CompareMarks, {
    pps: 20,
    rows: new Map([["v", { top: 30, height: 40 }]]),
    marks: [
      { key: "k1", itemId: "a", kind: "moved", trackId: "v", start: 16, end: 25, delta: -4, text: "Moved “Interview B” 4 s earlier" },
      { key: "k2", itemId: "b", kind: "added", trackId: "v", start: 12, end: 16, text: "Added" },
      { key: "k3", itemId: "c", kind: "removed", trackId: "v", start: 12, end: 12, text: "Removed “B-roll pier”" },
      { key: "k4", itemId: "d", kind: "changed", trackId: "gone", start: 1, end: 2, text: "no row" },
    ],
    selected: "k1",
    onPick: (k: string) => picked.push(k),
  })));
  const marks = $$(m.container, ".carton-tl-mark");
  assert.equal(marks.length, 2, "a track not on the timeline: no mark");
  const moved = marks.find((e) => e.getAttribute("data-kind") === "moved") as HTMLElement;
  assert.deepEqual([moved.style.left, moved.style.width, moved.style.top, moved.style.height], ["320px", "180px", "31px", "38px"]);
  assert.equal(moved.textContent, "←4 s");
  assert.equal(moved.getAttribute("data-selected"), "");
  assert.equal(marks.find((e) => e.getAttribute("data-kind") === "added")?.textContent, "+");
  const seam = $(m.container, ".carton-tl-seam") as HTMLElement;
  assert.equal(seam.style.left, "240px");
  await click(seam);
  await click(moved);
  assert.deepEqual(picked, ["k3", "k1"]);
  assert.equal($(m.container, ".carton-tl-marks")?.getAttribute("aria-hidden"), "true");
});

test(name("Play both's slates (DESIGN-V2 §1.4): a side with no shot there shows one in every mode, the right side's too, and “waiting” on the side that holds"), async () => {
  const slate = { title: "“B-roll pier” isn't in your edit", body: "Its shot plays on the other side." };
  for (const mode of ["side", "wipe", "flip"] as const) {
    const m = await render(stage({ mode, right: { ...right, step: null, slate } }).el);
    const s = $(m.container, ".carton-compare-slate");
    assert.ok(s, `${mode}: the right side's slate`);
    assert.match(s!.textContent!, /^“B-roll pier” isn't in your edit/);
    await m.unmount();
  }
  const m = await render(stage({ left: { ...left, step: "waiting" } }).el);
  assert.match($(m.container, '[data-side="left"] .carton-compare-tc')!.textContent!, /waiting/);
});
