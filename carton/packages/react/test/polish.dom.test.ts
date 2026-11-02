// The UI audit of 2026-11-02 (docs/ui-audit/REPORT.md on audit/ui-2026-11-02), in a DOM: keyboard, Esc and focus in
// every layer, the words, and the states it found wrong. `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime, type } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, CommentsPanel, CutsMenu, FoldInDialog, HistoryPanel, WatchTheChanges, createMockComments } from "../src/index.ts";
import { timecode } from "../src/components/WatchTheChanges.ts";
import { createMockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

test(name("P1-7, P2-6, P3-13: Watch puts Before/After above the picture, counts changes, and never shows a made-up frame"), async () => {
  const ui = createMockUi({ versions: 10 });
  let closed = 0;
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9", inPlayer: true, onClose: () => closed++ })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  // Before / After has its own row above the picture, not at the end of the controls (where it ran out of the panel).
  const abRow = $(root, ".carton-watch-abrow")!;
  assert.ok(abRow.querySelector("[role=radiogroup]"), "the A/B toggle in its own row");
  assert.equal($(root, ".carton-watch-controls [role=radiogroup]"), null, "not in the controls row");
  assert.ok(abRow.compareDocumentPosition($(root, ".carton-watch-stage")!) & 4, "the toggle comes before the picture");
  // The summary and the counter speak of the same thing: changes.
  assert.match($(root, ".carton-watch-summary")!.textContent ?? "", /^4 changes · \d+\.\d s of \d+\.\d s$/);
  assert.match(root.textContent ?? "", /Change 1 of 4/);
  assert.doesNotMatch(root.textContent ?? "", /shots? \//);
  // No stand-in card: where the picture is, in words.
  assert.equal($(root, ".carton-stage-shot"), null);
  assert.match($(root, ".carton-stage-note")!.textContent ?? "", /Shown in the player, read-only/);
  // Cardboard's timecode: "0:00 / 0:12", in the text face.
  assert.match($(root, ".carton-watch-clock")!.textContent ?? "", /^\d+:\d\d \/ \d+:\d\d$/);
  // Focus came in, so Esc reaches it, and closes only this layer.
  assert.equal(document.activeElement, root);
  await key(root, "Escape");
  assert.equal(closed, 1);
  await m.unmount();
});

test(name("P2-6: a host with no player of its own says there is no picture, not that the player shows it"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9" })));
  await flush();
  assert.match($(m.container, ".carton-stage-note")!.textContent ?? "", /Preview not available here/);
  await m.unmount();
});

test(name("P2-1: the Before/After toggle is one tab stop and moves with the arrow keys, which don't also skip a change"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9" })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  const [before, after] = $$(root, "[role=radio]");
  assert.equal(after!.getAttribute("aria-checked"), "true");
  assert.deepEqual([before!.tabIndex, after!.tabIndex], [-1, 0]);
  after!.focus();
  await key(after!, "ArrowLeft");
  assert.equal(before!.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, before);
  assert.match(root.textContent ?? "", /Change 1 of 4/, "the arrow moved the toggle, not the change");
  assert.equal(ui.preview()?.ref, "main@3");
  await m.unmount();
});

test("timecode reads as Cardboard's player does", () => {
  assert.equal(timecode(0, 6), "0:00 / 0:06");
  assert.equal(timecode(65.9, 125), "1:05 / 2:05");
  assert.equal(timecode(3725, 3725), "1:02:05 / 1:02:05");
});

const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const rect = (el: Element, r: { top: number; bottom: number; left?: number; right?: number }) => {
  (el as HTMLElement).getBoundingClientRect = () => ({ x: 0, y: r.top, top: r.top, bottom: r.bottom, left: r.left ?? 0, right: r.right ?? 384, width: (r.right ?? 384) - (r.left ?? 0), height: r.bottom - r.top, toJSON() {} }) as DOMRect;
};

test(name("P2-2, P2-1: a row looks picked while its menu is open, not after; Esc gives focus back to the list"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: "main@30" })));
  const rows = $$(m.container, "[role=option]");
  await click(rows[2]!.querySelector(".carton-version-more"));
  assert.ok($(m.container, "[role=menu]"), "the menu is open");
  assert.equal(rows[2]!.dataset.menu, "", "its row looks picked");
  assert.equal(rows[2]!.dataset.active, undefined, "without becoming the active row");
  assert.equal((document.activeElement as HTMLElement).getAttribute("role"), "menuitem", "focus is in the menu");
  await key(document.activeElement, "Escape");
  await raf();
  assert.equal($(m.container, "[role=menu]"), null);
  assert.equal($$(m.container, "[role=option]")[2]!.dataset.menu, undefined, "no highlight left behind");
  assert.ok((document.activeElement as HTMLElement).classList.contains("carton-history-list"), "focus is back on the list, not <body>");
  await m.unmount();
});

test(name("P2-3: a row's menu opens above it when there's no room below"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: "main@30" })));
  rect($(m.container, ".carton-history")!, { top: 0, bottom: 600 });
  const [first, , , last] = [...$$(m.container, "[role=option] .carton-version-more").slice(0, 3), $$(m.container, "[role=option] .carton-version-more").at(-1)!];
  rect(first!, { top: 60, bottom: 86 });
  await click(first);
  const below = $(m.container, ".carton-history-menu")!;
  assert.ok(below.style.top && !below.style.bottom, "below a row near the top: " + below.getAttribute("style"));
  await key(document.activeElement, "Escape");
  rect(last, { top: 560, bottom: 586 });
  await click(last);
  const above = $(m.container, ".carton-history-menu")!;
  assert.equal(above.style.bottom, "44px", "above a row near the bottom: " + above.getAttribute("style"));
  assert.equal(above.style.top, "");
  await m.unmount();
});

test(name("P2-1, P2-5: the Compare card takes focus, Esc closes only it, and the compared row is marked"), async () => {
  const ui = createMockUi({ versions: 30 });
  let outer = 0;
  // the side panel around it closes on Esc (scripts/carton/ui.js: a React handler, as here)
  const m = await render(wrap(ui, h("div", { onKeyDown: (e: KeyboardEvent) => e.key === "Escape" && outer++ }, h(HistoryPanel, { initialHeight: 600, currentRef: "main@30" }))));
  await click($$(m.container, "[role=option]")[3]!.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Compare with current"));
  await flush();
  const card = $(m.container, ".carton-compare")!;
  assert.equal(document.activeElement, card);
  assert.equal($$(m.container, "[role=option]")[3]!.dataset.compared, "");
  await key(card, "Escape");
  await raf();
  assert.equal($(m.container, ".carton-compare"), null);
  assert.equal(outer, 0, "the panel around it never saw that Esc");
  assert.ok((document.activeElement as HTMLElement).classList.contains("carton-history-list"));
  await m.unmount();
});

test(name("P2-1: the History filters are one tab stop and move with the arrow keys"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const radios = $$(m.container, "[role=radio]");
  assert.deepEqual(radios.map((r) => r.tabIndex), [0, -1, -1]);
  radios[0]!.focus();
  await key(radios[0]!, "ArrowRight");
  assert.equal($$(m.container, "[role=radio]")[1]!.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, $$(m.container, "[role=radio]")[1]);
  await m.unmount();
});

test(name("P2-7: the preview banner names the version by its time and author, not by a change's summary"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const plain = $$(m.container, "[role=option]").find((r) => r.dataset.named === undefined && r.dataset.provisional === undefined && r.dataset.kind !== "turn")!;
  rect(plain, { top: 0, bottom: 52 });
  plain.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await flush();
  assert.match(ui.preview()?.label ?? "", /^the version from \d{1,2}:\d{2}(\s?[AP]M)? \(.+\)$/);
  await m.unmount();
});

test(name("P2-19, P2-1: Main's cut menu folds another cut in here; leaving New cut with Esc keeps the menu's focus"), async () => {
  const ui = createMockUi({ versions: 10 });
  const folds: [string, string][] = [];
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { id: string }, into: { id: string }) => folds.push([from.id, into.id]) })));
  const trigger = $(m.container, ".carton-menu-trigger")!;
  assert.equal(trigger.getAttribute("aria-label"), "Cut: Main cut");
  await click(trigger);
  await click(byText(m.container, "[role=menuitem]", "Fold “30s Instagram cut” in here"));
  assert.deepEqual(folds, [["cut-ig", "cut-main"]]);
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitem]", "New cut from here"));
  const input = $(m.container, ".carton-menu-form input")!;
  assert.equal(document.activeElement, input);
  await key(input, "Escape");
  assert.ok($(m.container, "[role=menu]"), "back to the menu");
  assert.equal((document.activeElement as HTMLElement).getAttribute("role"), "menuitemradio", "focus in the menu, so a second Esc closes it");
  await key(document.activeElement, "Escape");
  assert.equal($(m.container, "[role=menu]"), null);
  await m.unmount();
});

test(name("P3-5: the Fold in dialog takes focus itself, not its ✕"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose() {} })));
  await flush();
  assert.equal((document.activeElement as HTMLElement).getAttribute("role"), "dialog");
  await m.unmount();
});

test(name("P2-1, P2-20: Esc on a typed reply asks once before discarding it; the box has no resize grip"), async () => {
  const ui = createMockComments();
  const m = await render(h(CommentsPanel, { comments: ui }));
  const thread = $$(m.container, "[role=listitem]")[0]!;
  await click(byText(thread, "button", "Reply"));
  const box = $(thread, "textarea")!;
  await type(box, "Can we trim this?");
  await key(box, "Escape");
  assert.ok($(thread, "textarea"), "the reply is still there");
  assert.match($(thread, ".carton-comment-esc")?.textContent ?? "", /Press Esc again to discard it/);
  await key($(thread, "textarea")!, "Escape");
  assert.equal($(thread, "textarea"), null, "a second Esc discards it");
  await m.unmount();
});

test(name("review finding 4: Space and the arrows in Watch never reach Cardboard's own shortcuts, nor does a button's Space"), async () => {
  const ui = createMockUi({ versions: 10 });
  let reached = 0;
  const m = await render(wrap(ui, h("div", { onKeyDown: () => reached++ }, h(WatchTheChanges, { a: "main@3", b: "main@9" }))));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  for (const k of [" ", "ArrowRight", "ArrowLeft"]) await key(root, k);
  await key(byText(root, "button", "Play changes") ?? byText(root, "button", "Pause"), " ");
  assert.equal(reached, 0);
  await m.unmount();
});

test(name("review finding 5: Shift+Tab from the dialog itself wraps to its last control"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose() {} })));
  await flush();
  const dialog = document.activeElement as HTMLElement;
  assert.equal(dialog.getAttribute("role"), "dialog");
  const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => { dialog.dispatchEvent(ev); });
  assert.equal(ev.defaultPrevented, true);
  const controls = $$(dialog, "button:not([disabled]), input:not([disabled])");
  assert.equal(document.activeElement, controls.at(-1));
  await m.unmount();
});

test(name("review finding 7: with another row's menu open, only that row looks picked"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await click($$(m.container, "[role=option]")[1]!);
  assert.equal($$(m.container, "[role=option]")[1]!.dataset.active, "");
  await click($$(m.container, "[role=option]")[4]!.querySelector(".carton-version-more"));
  assert.equal($(m.container, ".carton-history")!.dataset.menuOpen, "", "the panel says a menu is open (its skin then dims the active row)");
  assert.equal($$(m.container, "[role=option]")[4]!.dataset.menu, "");
  await key(document.activeElement, "Escape");
  assert.equal($(m.container, ".carton-history")!.dataset.menuOpen, undefined);
  await m.unmount();
});

test(name("P2-17: a long History is grouped by day; a folded day keeps its anchors and opens with a click or Enter"), async () => {
  const ui = createMockUi({ versions: 10_000 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const today = $$(m.container, ".carton-day")[0]!;
  assert.equal(today.getAttribute("aria-expanded"), "true", "today is open");
  assert.match(today.textContent ?? "", /^Today\d[\d,]* versions$/);
  assert.ok($$(m.container, "[role=option]").length < 40, "still a window of rows at 10k");
  // fold today: the older days, folded from the start, come into view
  await click(today);
  const days = $$(m.container, ".carton-day");
  assert.equal(days[0]!.getAttribute("aria-expanded"), "false");
  assert.ok(days.length >= 3, `${days.length} day headers on screen`);
  const folded = days[1]!;
  assert.equal(folded.getAttribute("aria-expanded"), "false");
  assert.match(folded.textContent ?? "", /\d versions?( · \d+ named)?$/, "a folded day says how many versions it holds (and its named ones, still shown)");
  await click(folded);
  const again = $$(m.container, ".carton-day").find((d) => d.id === folded.id)!;
  assert.equal(again.getAttribute("aria-expanded"), "true", "a click opens it");
  // keyboard: Enter on a day's header folds it again
  const list = $(m.container, "[role=listbox]")!;
  const idx = $$(m.container, "[role=option]").indexOf(again);
  for (let i = 0; i <= idx; i++) await key(list, "ArrowDown");
  assert.equal(list.getAttribute("aria-activedescendant"), again.id);
  await key(list, "Enter");
  assert.equal($$(m.container, ".carton-day").find((d) => d.id === folded.id)!.getAttribute("aria-expanded"), "false");
  await m.unmount();
});

test(name("P3-9: the filters get a divider once the list scrolls under them"), async () => {
  const ui = createMockUi({ versions: 500 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const list = $(m.container, ".carton-history-list")!;
  assert.equal($(m.container, ".carton-history")!.dataset.scrolled, undefined);
  list.scrollTop = 300;
  await act(async () => { list.dispatchEvent(new Event("scroll")); await raf(); await new Promise((r) => setTimeout(r, 10)); });
  assert.equal($(m.container, ".carton-history")!.dataset.scrolled, "");
  list.scrollTop = 0;
  await act(async () => { list.dispatchEvent(new Event("scroll")); await raf(); await new Promise((r) => setTimeout(r, 10)); });
  assert.equal($(m.container, ".carton-history")!.dataset.scrolled, undefined);
  await m.unmount();
});

test(name("P2-17: the reader keeps their place in a grouped History while versions arrive above"), async () => {
  const ui = createMockUi({ versions: 10_000 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const list = $(m.container, ".carton-history-list")!;
  const scrollTo = async (y: number) => {
    list.scrollTop = y;
    await act(async () => { list.dispatchEvent(new Event("scroll")); await new Promise((r) => setTimeout(r, 10)); });
  };
  await scrollTo(5200); // 100 rows down
  const before = list.scrollTop;
  const topRow = () => $$(m.container, ".carton-vrow").map((r) => [r, parseFloat((r.style.transform.match(/translateY\(([\d.]+)px\)/) ?? [])[1] ?? "0")] as const).filter(([, y]) => y <= list.scrollTop).sort((a, b) => b[1] - a[1])[0]![0].querySelector("[role=option]")!.id;
  const was = topRow();
  await act(async () => { ui.addVersion(); ui.addVersion(); });
  await flush();
  assert.equal(list.scrollTop, before + 2 * 52, "shifted by the two rows that arrived above");
  assert.equal(topRow(), was, "the same row is still at the top");
  await m.unmount();
});

void act;
