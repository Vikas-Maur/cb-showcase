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
import { compareMarks } from "../src/compare.ts";

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

test(name("a greyed Side by side the host can make room for: clickable, its words as the tooltip; a failed start greys Side by side and Wipe, and a pick tries again"), async () => {
  let made = 0;
  const tip = "Side by side needs a wider stage. Click to close History and make room.";
  const s = stage({ sideOff: true, mode: "flip", sideTip: tip, onSideOff: () => made++ });
  const m = await render(s.el);
  let radios = $$(m.container, "[role=radio]");
  assert.ok(radios[0]!.hasAttribute("data-off"), "greyed");
  assert.equal(radios[0]!.getAttribute("aria-disabled"), null, "not disabled: its click does something");
  assert.equal(radios[0]!.getAttribute("data-carton-tip"), tip);
  assert.equal(radios[0]!.getAttribute("aria-description"), tip);
  await click(radios[0]);
  assert.equal(made, 1, "the host makes the room");
  assert.deepEqual(s.calls, [], "and no mode is picked here");
  // the keyboard reaches it (review): → from Flip wraps onto it and only focuses it (its click is Enter or Space,
  // never an arrow passing over it); → again picks Wipe
  await key(radios[2], "ArrowRight");
  assert.ok(document.activeElement === radios[0], "Side by side focused");
  assert.equal(made, 1, "an arrow doesn't close History");
  assert.deepEqual(s.calls, []);
  await key(radios[0], "ArrowRight");
  assert.deepEqual(s.calls, [["mode", "wipe"]], "from it, → picks Wipe");
  // the host's own words without a click: disabled, as before
  await m.rerender(stage({ sideOff: true, mode: "flip", sideTip: "Side by side needs a wider stage. Close History and the chat, or widen the window." }).el);
  radios = $$(m.container, "[role=radio]");
  assert.equal(radios[0]!.getAttribute("aria-disabled"), "true");
  assert.match(radios[0]!.getAttribute("data-carton-tip") ?? "", /Close History and the chat, or widen the window\.$/);
  // the second picture didn't start: Side by side and Wipe greyed, each a pick that tries again; Flip as usual
  const r = stage({ mode: "flip", retry: "Couldn't show both sides here. Click to try again." });
  await m.rerender(r.el);
  radios = $$(m.container, "[role=radio]");
  assert.deepEqual(radios.map((x) => x.hasAttribute("data-off")), [true, true, false]);
  assert.deepEqual(radios.map((x) => x.getAttribute("aria-disabled")), [null, null, null]);
  assert.equal(radios[1]!.getAttribute("data-carton-tip"), "Couldn't show both sides here. Click to try again.");
  await click(radios[1]);
  await click(radios[0]);
  assert.deepEqual(r.calls, [["mode", "wipe"], ["mode", "side"]]);
});

test(name("the frame's own label (History closed): its words open History, its ✕ is Done comparing"), async () => {
  let opened = 0;
  const s = stage({ frameLabel: "Comparing “Sent to client” with your edit · 7 changes", onFrameLabel: () => opened++ });
  const m = await render(s.el);
  const root = $(m.container, ".carton-compare")!;
  assert.ok(root.hasAttribute("data-label"), "the bar moves down for it");
  const words = $(root, ".carton-compare-frame-open")!;
  assert.equal(words.tagName, "BUTTON");
  assert.equal(words.textContent, "Comparing “Sent to client” with your edit · 7 changes");
  assert.equal(words.getAttribute("title"), "Show the changes in History");
  await click(words);
  assert.equal(opened, 1);
  await click($(root, ".carton-compare-frame-label .carton-frame-back"));
  assert.deepEqual(s.calls, [["done"]]);
  // a host without the click: the words as text, as before
  await m.rerender(stage({ frameLabel: "Comparing “Sent to client” with your edit" }).el);
  assert.equal($(m.container, ".carton-compare-frame-open"), null);
  assert.equal($(m.container, ".carton-compare-frame-label > span")?.textContent, "Comparing “Sent to client” with your edit");
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
  // in timeline order, as the marks read (the engine gives them by clip: design QA v2)
  assert.deepEqual($$(m.container, ".carton-change").map((r) => r.getAttribute("data-change-key")), ["timelineItems/a", "timelineItems/c", "timelineItems/b"]);
  assert.deepEqual(picked, [], "opening focuses the first row and picks nothing");
  await click($$(m.container, ".carton-change")[1]);
  assert.deepEqual(picked, ["timelineItems/c"]);
  await m.rerender(list("timelineItems/c"));
  assert.ok($(m.container, '.carton-change-selected[data-change-key="timelineItems/c"]'));
  const rowC = $(m.container, '.carton-change[data-change-key="timelineItems/c"]') as HTMLElement;
  await act(() => rowC.focus());
  await key(rowC, "ArrowDown");
  assert.deepEqual(picked, ["timelineItems/c", "timelineItems/b"], "↓: the next row, both players follow");
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

test(name("design QA v2 G17: a removed clip's ghost names it from 24 px wide (a narrow caption too); narrower, its tooltip does"), async () => {
  const marks = compareMarks(
    [
      { key: "timelineItems/cap", itemId: "cap", kind: "remove", clip: "caption", text: "Removed “our new”", at: 4, end: 5 },
      { key: "timelineItems/cap2", itemId: "cap2", kind: "remove", clip: "caption", text: "Removed “in half”", at: 8, end: 8.5 },
    ],
    { timelineItems: [{ id: "cap", trackId: "t", startTime: 4, endTime: 5 }, { id: "cap2", trackId: "t", startTime: 8, endTime: 8.5 }], tracks: [{ id: "t" }] },
    { timelineItems: [], tracks: [{ id: "t" }] },
  );
  assert.deepEqual(marks.map((x) => x.name), ["our new", "in half"]);
  const m = await render(wrap(h(CompareMarks, { pps: 30, rows: new Map([["t", { top: 0, height: 24 }]]), marks })));
  const ghosts = $$(m.container, ".carton-tl-rem");
  assert.equal(ghosts.length, 2);
  // 1 s at 30 px a second: 30 px, under the tags' 36 px, and named
  assert.equal($(ghosts[0]!, ".carton-tl-ghost-name")?.textContent, "our new");
  // 0.5 s: 15 px, no room for words; the tooltip says what it was
  assert.equal($(ghosts[1]!, ".carton-tl-ghost-name"), null);
  assert.equal(ghosts[1]!.getAttribute("title"), "Removed “in half”");
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
