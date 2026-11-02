// The laptop's regression check of the release candidate (merge/prod-2, 2026-11-02), in a DOM: what it found in the real
// app. `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, click, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel, PreviewBanner } from "../src/index.ts";
import { VirtualList } from "../src/virtual.ts";
import { createMockUi } from "../src/mock.ts";
import { commentsSkin } from "../src/comments/skin.ts";
import { cardboardSkin } from "../src/skin/cardboard.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const ty = (el: Element) => parseFloat(((el as HTMLElement).style.transform.match(/translateY\(([\d.]+)px\)/) ?? [])[1] ?? "NaN");

// Regress #2: a reader who picked a version, then scrolled away from it (into an older day), was pulled back to it when a
// new version arrived: the active row's index and the rows' layout moved, and the list kept the active row in view.
for (const [label, hour, grouped] of [["grouped by day, scrolled into an older day", 1, true], ["one day", 14, false]] as const)
  test(name(`regress #2: a new version keeps the reader's place after they picked a row and scrolled away (${label})`), async () => {
    const ui = createMockUi({ versions: 120, now: new Date(2026, 10, 2, hour, 0).getTime() });
    const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
    await flush();
    const list = $(m.container, ".carton-history-list")!;
    assert.equal($$(m.container, ".carton-day").length > 0, grouped, grouped ? "the History spans two days" : "one day: no day headers");
    const scrollTo = async (y: number) => {
      list.scrollTop = y;
      await act(async () => { list.dispatchEvent(new Event("scroll")); await new Promise((r) => setTimeout(r, 10)); });
    };
    // the person picks a version near the top
    await click($$(m.container, ".carton-version")[3]!);
    assert.equal($$(m.container, ".carton-version[data-active]").length, 1, "a picked row");
    // and scrolls far below it: in the grouped History, into yesterday
    await scrollTo(2400);
    if (grouped) {
      const days = $$(m.container, ".carton-day").map((d) => d.textContent ?? "");
      assert.ok(days.some((d) => d.startsWith("Yesterday")), "yesterday's header is on screen: " + days.join(" | "));
    }
    const before = list.scrollTop;
    const topRow = () => $$(m.container, ".carton-vrow").map((r) => [r, ty(r)] as const).filter(([, y]) => y <= list.scrollTop).sort((a, b) => b[1] - a[1])[0]![0].querySelector("[role=option]")!.id;
    const was = topRow();
    await act(async () => { ui.addVersion(); });
    await flush();
    assert.equal(list.scrollTop, before + 52, "shifted by the row that arrived above, never back to the picked row");
    assert.equal(topRow(), was, "the same row is still at the top");
    // the picked row is still the picked one, wherever it is now
    assert.equal($$(m.container, ".carton-version[data-active]").length, 0, "the picked row is off screen (it stays picked)");
    await m.unmount();
  });

// Regress #4 (UI audit P2-1): Esc in a preview did nothing, as focus is on the page itself (<body>) there. It returns
// from the preview, as the banner's button does, when the key was nobody else's, whichever listened first: not from a
// field, not when a handler took it (a Radix layer in the capture phase; the chat's approval card, which can appear
// during the preview and so listens after the banner), and not when it cleared the editor's clip selection (Cardboard's
// properties panel does that on Esc without taking the key). Review of fix/ui-regress #1.
test(name("regress #4: Esc returns from a preview when the key was nobody else's, whichever handler listened first"), async () => {
  const ui = createMockUi({ versions: 10 });
  let selection: string[] = ["clip-1"];
  const m = await render(wrap(ui, h(PreviewBanner, { escapeState: () => selection })));
  const esc = async (target: EventTarget) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(e); await new Promise((r) => setTimeout(r, 5)); });
    return e;
  };
  await act(async () => { ui.openPreview("main@3", "the version from 12:41"); });
  assert.ok($(m.container, ".carton-preview-banner"), "previewing");
  assert.equal($(m.container, ".carton-preview-banner .carton-btn")!.getAttribute("aria-keyshortcuts"), "Escape", "the button says its key");
  // typing in a field: its Esc
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  await esc(field);
  assert.ok(ui.preview(), "a field's Esc stays the field's");
  field.remove();
  // a layer took it in the capture phase (Radix)
  const capture = (e: Event) => e.preventDefault();
  document.addEventListener("keydown", capture, true);
  await esc(document.body);
  document.removeEventListener("keydown", capture, true);
  assert.ok(ui.preview(), "a key a layer took stays theirs");
  // the chat's approval card, shown during the preview: its window listener comes after the banner's, skips a key
  // already taken, else takes it
  let skipped = 0;
  const approval = (e: KeyboardEvent) => { if (e.defaultPrevented) return; if (e.key === "Escape") { e.preventDefault(); skipped++; } };
  window.addEventListener("keydown", approval);
  await esc(document.body);
  window.removeEventListener("keydown", approval);
  assert.equal(skipped, 1, "the approval card got the key");
  assert.ok(ui.preview(), "and the preview stays");
  // the properties panel clears the selection on Esc, taking nothing: that Esc was the editor's
  const deselect = (e: KeyboardEvent) => { if (e.key === "Escape" && selection.length) selection = []; };
  window.addEventListener("keydown", deselect);
  await esc(document.body);
  assert.deepEqual(selection, [], "the clip was deselected");
  assert.ok(ui.preview(), "and the preview stays");
  // nothing selected now: the next Esc is nobody else's, and returns. The banner takes no key from anyone.
  const e = await esc(document.body);
  window.removeEventListener("keydown", deselect);
  assert.equal(ui.preview(), null, "Esc returned from the preview");
  assert.equal(e.defaultPrevented, false, "without taking the key from a handler after it");
  assert.equal($(m.container, ".carton-preview-banner"), null);
  await m.unmount();
});

// Review of fix/ui-regress #2: keeping the reader's place must not stop the picked row's own list of changes, opened near
// the bottom of the view, from scrolling into view (the row is the same, but taller).
for (const grouped of [false, true])
  test(name(`regress #2: opening the picked row's changes near the bottom brings them into view (${grouped ? "day headers" : "fixed rows"})`), async () => {
    const base = { count: 30, rowHeight: 52, rowKey: (i: number) => `row${i}`, label: "History", initialHeight: 260, renderRow: (i: number) => h("div", null, `row${i}`), ...(grouped ? { heightOf: (i: number) => (i === 0 ? 32 : 52), layoutKey: "same" } : {}) };
    const view = (active: number, extra: number) => h(VirtualList, { ...base, active, expanded: extra ? { index: 4, extra } : null });
    const m = await render(view(-1, 0));
    const list = $(m.container, ".carton-vlist") as HTMLElement;
    Object.defineProperty(list, "clientHeight", { value: 260, configurable: true });
    await m.rerender(view(4, 0));
    await flush();
    assert.equal(list.scrollTop, 0, "row 4 fits: no scroll");
    await m.rerender(view(4, 90));
    await flush();
    const row = $$(m.container, ".carton-vrow")[4]!;
    assert.ok(ty(row) + parseFloat(row.style.height) <= list.scrollTop + 260, `its changes are in view (row ends at ${ty(row) + parseFloat(row.style.height)}, view at ${list.scrollTop + 260})`);
    await m.unmount();
  });

// Regress #5 (UI audit P2-20): the comment box still showed a textarea's resize grip. The comments skin said
// `resize:none` for it, then a later rule of the same weight (every rule is in :where()) said `resize:vertical` and won.
// What a box gets is the last declaration among the rules that reach it, in the order the skins are injected.
test(name("regress #5: the comment box has no resize grip, and its height stops where the box stops growing (160 px)"), () => {
  const decls = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => /\.carton-comment-text\b/.test(sel!))
    .flatMap(([, , body]) => body!.split(";").map((d) => d.split(":").map((x) => x.trim()) as [string, string]));
  const last = (prop: string) => [...decls(cardboardSkin), ...decls(commentsSkin)].filter(([k]) => k === prop).at(-1)?.[1];
  assert.equal(last("resize"), "none", "no resize grip");
  assert.equal(last("max-height"), "160px", "the box grows with its text to 160 px (TextBox), and no further");
});
