// The UI audit of 2026-11-02 (docs/ui-audit/REPORT.md on audit/ui-2026-11-02), in a DOM: keyboard, Esc and focus in
// every layer, the words, and the states it found wrong. `pnpm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime, type, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, CommentsPanel, CutsMenu, FoldInDialog, HistoryPanel, createMockComments } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

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

test(name("P2-1, P2-5 (the Changes view, PLAN 4.1): it takes focus, Esc closes only it, and focus is back on the row it came from"), async () => {
  const ui = createMockUi({ versions: 30 });
  let outer = 0;
  // the side panel around it closes on Esc (scripts/carton/ui.js: a React handler, as here)
  const m = await render(wrap(ui, h("div", { onKeyDown: (e: KeyboardEvent) => e.key === "Escape" && outer++ }, h(HistoryPanel, { initialHeight: 600 }))));
  const row = $$(m.container, ".carton-version")[2]!;
  const title = row.querySelector(".carton-version-title")!.textContent;
  await click(row.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Compare with your edit"));
  await flush();
  const view = $(m.container, ".carton-changes-view")!;
  assert.ok(view.contains(document.activeElement), "focus is in the Changes view");
  await key(document.activeElement, "Escape");
  await raf();
  assert.equal($(m.container, ".carton-changes-view"), null);
  assert.equal(outer, 0, "the panel around it never saw that Esc");
  assert.ok((document.activeElement as HTMLElement).classList.contains("carton-history-list"));
  assert.equal($(m.container, ".carton-version[data-active] .carton-version-title")?.textContent, title, "on the row it came from");
  await m.unmount();
});

test(name("P2-1: the History filter is one button whose menu moves with the arrow keys; Esc gives focus back to it"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const btn = $(m.container, ".carton-filter-btn")!;
  assert.equal(btn.getAttribute("aria-haspopup"), "menu");
  assert.equal($$(m.container, "[role=radio]").length, 0, "no segmented bar taking a row of its own (AUDIT H6)");
  await click(btn);
  const items = $$(m.container, "[role=menuitemradio]");
  assert.deepEqual(items.map((i) => i.textContent), ["All versions", "Named versions", "Agent turns", "Your changes"]);
  assert.equal(items[0]!.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, items[0], "focus is in the menu");
  await key(document.activeElement, "ArrowDown");
  assert.equal(document.activeElement, $$(m.container, "[role=menuitemradio]")[1]);
  await key(document.activeElement, "Escape");
  assert.equal($(m.container, "[role=menu]"), null);
  assert.equal(document.activeElement, $(m.container, ".carton-filter-btn"), "focus back on the filter button");
  await m.unmount();
});

test(name("P2-7: Play on an older version views it, named by its time and author, not by a change's summary"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  // a plain edit of yours, not the newest: "Trimmed “Product close-up”…" is Codex's; your group is "Moved “Interview B”…"
  const plain = $$(m.container, ".carton-version").find((r) => r.dataset.group !== undefined)!;
  plain.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await flush();
  assert.equal(ui.viewing(), null, "a double-click views nothing (DESIGN §4.2)");
  await click(plain);
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all") && !(byText(m.container, ".carton-card-version button", "Play all") as HTMLButtonElement).disabled, "Play all");
  await click(byText(m.container, ".carton-card-version button", "Play all"));
  await flush();
  // one label for a version (PLAN 0.9): who and when, always with am/pm
  assert.match(ui.viewing()?.label ?? "", /^(Your|.+'s) edit from \d{1,2}:\d{2} [ap]m$/);
  assert.equal(ui.viewing()?.kind, "version");
  // its row says so: "Viewing ✕"
  const viewed = $(m.container, ".carton-version[data-viewing]")!;
  assert.match(viewed.textContent ?? "", /Viewing/);
  await click($(viewed, ".carton-version-back"));
  assert.equal(ui.viewing(), null, "its ✕ goes back to your edit");
  await m.unmount();
});

test(name("P2-19, P2-1: Main's cut menu folds another cut in here; leaving New cut with Esc keeps the menu's focus"), async () => {
  const ui = createMockUi({ versions: 10 });
  const folds: [string, string][] = [];
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { id: string }, into: { id: string }) => folds.push([from.id, into.id]) })));
  const trigger = $(m.container, ".carton-menu-trigger")!;
  assert.equal(trigger.getAttribute("aria-label"), "Cut: Main cut");
  await click(trigger);
  // into the cut you're on (Main), from the cut changed most recently: the Director's
  await click(byText(m.container, "[role=menuitem]", "Fold in changes from a cut…"));
  assert.deepEqual(folds, [["cut-dir", "cut-main"]]);
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitem]", "New cut from your edit"));
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
  assert.equal(today.textContent, "Today", "an open day shows no count (docs/carton-ux DESIGN §6.1)");
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
  const ty = (r: HTMLElement) => parseFloat((r.style.transform.match(/translateY\(([\d.]+)px\)/) ?? [])[1] ?? "0");
  const topRow = () => $$(m.container, ".carton-vrow").map((r) => [r, ty(r)] as const).filter(([, y]) => y <= list.scrollTop).sort((a, b) => b[1] - a[1])[0]![0];
  const was = topRow(), id = was.querySelector("[role=option]")!.id, y0 = ty(was);
  // two versions by two teammates, so each is a row of its own (a person's run of edits is one row: DESIGN §6.1)
  await act(async () => { ui.addVersion({ author: people.bob }); ui.addVersion({ author: people.priya }); });
  await flush();
  const now = $$(m.container, ".carton-vrow").find((r) => r.querySelector("[role=option]")?.id === id)!;
  assert.equal(ty(now) - y0, 2 * 56, "the two rows that arrived above moved it down");
  assert.equal(list.scrollTop, before + 2 * 56, "and the view moved with it");
  assert.equal(topRow().querySelector("[role=option]")!.id, id, "the same row is still at the top");
  await m.unmount();
});

test(name("P2-17 with P1-5: a version's card opens in place inside a History grouped by day"), async () => {
  const ui = createMockUi({ versions: 10_000 });
  await act(async () => {
    ui.addVersion({ author: people.bob, summary: "Folded in “Client review”", kind: "fold" }, [
      { key: "a", text: "Moved “clip.mp4” 2 s later (now starts at 0:02)", kind: "change", clip: "video", at: 2, end: 6 },
      { key: "b", text: "Changed “W2” to “Hello”", kind: "change", clip: "title", at: 4, end: 8 },
      { key: "c", text: "Trimmed “Intro”, now ends at 0:05", kind: "change", clip: "video", at: 0, end: 5 },
    ]);
  });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const top = (el: Element) => parseFloat(((el as HTMLElement).style.transform.match(/translateY\(([\d.]+)px\)/) ?? [])[1] ?? "NaN");
  const vrows = () => $$(m.container, ".carton-vrow");
  // the day header, then the new version, then the rest of today
  assert.ok(vrows()[0]!.querySelector(".carton-day"), "today's header first");
  const row = vrows()[1]!, next = vrows()[2]!;
  const nextTop = top(next), rowHeight = parseFloat(row.style.height);
  await click(row.querySelector(".carton-version"));
  await flush();
  const opened = vrows()[1]!;
  assert.equal(opened.querySelector(".carton-version")!.getAttribute("aria-expanded"), "true");
  // its changes in timeline order, as change rows: where, what kind of clip, what happened
  assert.deepEqual($$(opened, ".carton-change-time").map((t) => t.textContent), ["0:00", "0:02", "0:04"]);
  assert.equal($$(opened, ".carton-change-chip[data-clip=title]").length, 1);
  const extra = parseFloat(opened.style.height) - rowHeight;
  assert.ok(extra > 0, "the opened row is taller");
  assert.equal(top(vrows()[2]!), nextTop + extra, "the rows below it move down by exactly that, in the grouped layout");
  assert.equal(top(vrows()[0]!), 0, "the day header stays put");
  await m.unmount();
});

void act;
