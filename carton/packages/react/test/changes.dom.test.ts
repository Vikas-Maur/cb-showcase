// The Changes view, Play and Before (docs/carton-ux PLAN 4.1–4.3), in a DOM, on React and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, renders, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, ChangesView, HistoryPanel } from "../src/index.ts";
import { createMockUi, STORY_LENGTH, type MockUi } from "../src/mock.ts";
import type { CartonUi, Version, ViewTarget } from "../src/model.ts";
import type { Clock } from "../src/player.ts";
import type { PlayHost } from "../src/components/Play.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

/** A clock the test steps by hand (frames of 250 ms or less: the player's cap). */
function fakeClock() {
  let now = 0, next: ((t: number) => void) | null = null, id = 0;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), ++id), cancel: () => void (next = null) };
  return {
    clock,
    async frames(n: number, ms = 100) {
      for (let i = 0; i < n; i++)
        await act(() => {
          now += ms;
          const fn = next;
          next = null;
          fn?.(now);
        });
    },
  };
}

/** The story's versions by what they are: Claude Code's turn on top (head), the Director's turn, your last change. */
function story(ui: MockUi) {
  const all = ui.history().all!();
  const find = (f: (v: Version) => boolean) => [...all].reverse().find(f)!;
  return {
    head: all.at(-1)!,
    director: find((v) => v.kind === "turn" && v.author.name === "Director"),
    yours: find((v) => v.author.key === "human/alice" && v.kind === "edit" && !v.name),
  };
}

function host(extra: Partial<PlayHost> = {}) {
  const fc = fakeClock();
  const frames: number[] = [], seeks: number[] = [], prefetched: string[] = [];
  const play: PlayHost = { clock: fc.clock, onFrame: (t) => frames.push(t), seek: (t) => seeks.push(t), prefetch: (r) => prefetched.push(r), length: () => STORY_LENGTH, ...extra };
  return { fc, frames, seeks, prefetched, play };
}

/** A pointer press on Before, held for `ms` (Date.now moved on meanwhile), then let go. */
async function hold(el: HTMLElement, ms: number, release = true) {
  await act(() => void el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true, pointerId: 1 })));
  await flush();
  if (!release) return;
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    await act(() => void el.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 })));
    await flush();
  } finally {
    Date.now = real;
  }
}

test(name("the Changes view says the range in words, lists every change in timeline order, and never touches the stage"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(ChangesView, { from: director, onBack: () => {}, host: hs.play })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  assert.match($(root, ".carton-changes-title")!.textContent!, /^Changes since \d{1,2}:\d{2} (am|pm)$/);
  assert.equal($(root, ".carton-changes-sub")!.textContent, "From Director's “Add captions to the interview” to your edit now");
  const list = await ui.changes(director.ref, ui.cuts().find((c) => c.current)!.head);
  const rows = $$(root, ".carton-change");
  assert.equal(rows.length, list.length, "one row per change, as changes() counts them");
  const ats = list.map((c) => c.at ?? Infinity);
  assert.deepEqual(ats, [...ats].sort((x, y) => x - y), "timeline order, the changes with no place last");
  assert.equal(rows.at(-1)!.querySelector(".carton-change-time")!.textContent, "—", "the frame rate has no place");
  assert.match(rows[0]!.textContent!, /^0:0\d/);
  assert.equal($(root, ".carton-changes-ends")!.lastElementChild!.textContent, `${list.length} changes · 0:38`);
  // a tick per change with a place (two of one kind within 1/240 of the edit share one: ChangeMap)
  const ticks = $$(root, ".carton-map-tick").length;
  assert.ok(ticks > 0 && ticks <= list.filter((c) => c.at != null).length, `${ticks} ticks`);
  // mixed authors: each row says who and when
  assert.ok(rows.every((r) => /(Claude Code|You|Director) · \d/.test(r.querySelector(".carton-change-who")?.textContent ?? "")));
  assert.equal(ui.viewing(), null, "opening it shows nothing on the stage");
  // a click on a row moves the editor's playhead there, without playing or viewing
  await click(rows[1]);
  assert.deepEqual(hs.seeks, [list[1]!.at]);
  assert.equal(ui.viewing(), null);
  assert.equal(byText(root, "button", "Restore this version…") != null, true);
  assert.equal($(root, ".carton-before"), null, "Before only while playing");
  await m.unmount();
});

test(name("Play all on your edit: nothing viewed, the rows light in order, the playhead follows, and no React render per frame"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(ChangesView, { from: director, onBack: () => {}, host: hs.play })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  await click(byText(root, "button", "Play all"));
  assert.equal(ui.viewing(), null, "the newer side is your edit: no viewing");
  assert.ok(hs.prefetched.includes(director.ref), "Before's side is loaded ahead when playing starts");
  assert.ok(byText(root, "button", "Pause"));
  const lit = () => $$(root, ".carton-change[data-playing], .carton-change[data-active]").map((r) => r.querySelector(".carton-change-time")!.textContent);
  const first = lit();
  assert.ok(first.length >= 1, "the first spot is lit");
  assert.ok($(root, ".carton-before"), "Before while playing");

  // frames: the progress line and the map's playhead move by transform, the host's playhead follows, React stays still
  renders.clear();
  await hs.fc.frames(5);
  const bar = $(root, ".carton-change[data-playing] .carton-change-progress-fill")!;
  assert.match(bar.style.transform, /^scaleX\(0\.\d+\)$/);
  const head = $(root, ".carton-map-playhead")!;
  assert.equal(head.hidden, false, "the map shows the playhead");
  assert.match(head.style.transform, /^translateX\(\d+(\.\d+)?%\)$/);
  assert.equal(hs.frames.length >= 5, true);
  assert.ok(hs.frames.every((t, i) => i === 0 || t >= hs.frames[i - 1]!), "the playhead only moves on");
  const perFrame = [...renders.entries()].filter(([n]) => /ChangesView|ChangeRow|ChangeMap/.test(n));
  assert.deepEqual(perFrame, [], `no render while a spot plays: ${JSON.stringify(perFrame)}`);
  // on to the next spot: a coarse render (the counter does see them), and another row lit
  await hs.fc.frames(150);
  assert.notDeepEqual(lit(), first, "the lit row is where you are");
  const coarse = [...renders.entries()].filter(([n]) => /ChangeRow/.test(n)).reduce((a, [, k]) => a + k, 0);
  assert.ok(coarse > 0 && coarse < 150, `${coarse} row renders over 150 frames: only when the lit row moved`);
  // the lit row's own button reads Pause, and pauses: the place is kept
  const own = $(root, ".carton-change[data-playing] .carton-change-play")!;
  assert.equal(own.getAttribute("aria-label"), "Pause");
  await click(own);
  assert.ok(byText(root, "button", "Play all"), "paused");
  assert.equal($$(root, ".carton-change[data-active]").length, 1, "still lit where it paused");
  // Space (the list has focus, and it stops there) goes on
  let reached = 0;
  m.container.parentElement!.addEventListener("keydown", () => reached++);
  await key($(root, ".carton-change"), " ");
  assert.ok(byText(root, "button", "Pause"), "playing again");
  assert.equal(reached, 0, "Cardboard's own Space never sees it");
  assert.equal(ui.viewing(), null);
  await m.unmount();
});

test(name("Play on an older version views it first; Before held shows the older side, let go comes back; a click latches"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director, yours } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(ChangesView, { from: director, to: yours, onBack: () => {}, host: hs.play })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  assert.match($(root, ".carton-changes-title")!.textContent!, /^Changes from \d{1,2}:\d{2} (am|pm) to \d{1,2}:\d{2} (am|pm)$/);
  assert.match($(root, ".carton-changes-sub")!.textContent!, /^From Director's “Add captions to the interview” to your edit from /);
  await click(byText(root, "button", "Play all"));
  await waitFor(() => ui.viewing()?.ref === yours.ref, "the newer side viewed");
  assert.equal(ui.viewing()!.kind, "version");
  const before = $(root, ".carton-before")!;
  // held: the older side, at the same moment; let go: back to the newer side
  await hold(before, 600, false);
  assert.equal(ui.viewing()?.ref, director.ref);
  assert.equal(before.getAttribute("aria-pressed"), "true");
  const real = Date.now;
  Date.now = () => real() + 600;
  await act(() => void before.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 })));
  Date.now = real;
  await flush();
  assert.equal(ui.viewing()?.ref, yours.ref, "let go: back where Play was");
  assert.equal(before.getAttribute("aria-pressed"), "false");
  // a click latches it; another click lets go
  await hold(before, 50);
  assert.equal(ui.viewing()?.ref, director.ref, "latched");
  assert.equal($(root, ".carton-before")!.getAttribute("aria-pressed"), "true");
  await hold($(root, ".carton-before")!, 50);
  assert.equal(ui.viewing()?.ref, yours.ref);
  // B held while the list has focus does the same; it stops there (the editor's own B never sees it)
  let reached = 0;
  document.addEventListener("keydown", () => reached++);
  const listEl = $(root, ".carton-change")!;
  await act(() => void listEl.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })));
  await flush();
  assert.equal(ui.viewing()?.ref, director.ref);
  Date.now = () => real() + 600;
  await act(() => void listEl.dispatchEvent(new KeyboardEvent("keyup", { key: "b", bubbles: true, cancelable: true })));
  Date.now = real;
  await flush();
  assert.equal(ui.viewing()?.ref, yours.ref);
  assert.equal(reached, 0, "B stopped in the panel");
  // B only holds: a quick tap comes back at once, it never latches (only a click on the button does)
  await act(() => void listEl.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })));
  await flush();
  assert.equal(ui.viewing()?.ref, director.ref);
  await act(() => void listEl.dispatchEvent(new KeyboardEvent("keyup", { key: "b", bubbles: true, cancelable: true })));
  await flush();
  assert.equal(ui.viewing()?.ref, yours.ref, "a tap of B: back");
  assert.equal($(root, ".carton-before")!.getAttribute("aria-pressed"), "false");
  await m.unmount();
});

test(name("Before on your edit: let go is back to your edit; an Esc elsewhere lets Before go and Play goes on; leaving lets go"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(ChangesView, { from: director, onBack: () => {}, host: hs.play })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  await click(byText(root, "button", "Play all"));
  await hold($(root, ".carton-before")!, 50); // latched
  assert.equal(ui.viewing()?.ref, director.ref);
  // somebody else brings the stage back to your edit (Esc, the chip's ✕): Before lets go, Play goes on
  await act(() => ui.view(null));
  await flush();
  assert.equal($(root, ".carton-before")!.getAttribute("aria-pressed"), "false");
  assert.ok(byText(root, "button", "Pause"), "still playing on your edit");
  // latched again, then the view closes: Before lets go (back to your edit)
  await hold($(root, ".carton-before")!, 50);
  assert.equal(ui.viewing()?.ref, director.ref);
  await m.unmount();
  await flush();
  assert.equal(ui.viewing(), null, "closing the view lets Before go");
});

test(name("Play on an older version stops when something else takes the stage; a version that can't load says so and stays on your edit"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director, yours } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(ChangesView, { from: director, to: yours, onBack: () => {}, host: hs.play })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  await click(byText(root, "button", "Play all"));
  await waitFor(() => ui.viewing()?.ref === yours.ref, "viewing the newer side");
  await act(() => ui.view(null)); // Esc: back to your edit
  await flush();
  assert.ok(byText(root, "button", "Play all"), "Play stopped: it never moves a playhead it didn't open");
  assert.equal($$(root, ".carton-change[data-playing], .carton-change[data-active]").length, 0);
  await m.unmount();
  // a view that fails
  const failing = Object.assign(Object.create(ui), { view: (t: ViewTarget | null) => (t ? Promise.reject(new Error("gone")) : ui.view(null)) }) as CartonUi;
  const m2 = await render(wrap(failing, h(ChangesView, { from: director, to: yours, onBack: () => {}, host: host().play })));
  await flush();
  const r2 = $(m2.container, ".carton-changes-view")!;
  await click(byText(r2, "button", "Play all"));
  await flush();
  assert.equal($(r2, ".carton-changes-error")?.textContent, "Couldn't load this version. Try again.");
  assert.equal(ui.viewing(), null, "the editor stays on your edit");
  assert.ok(byText(r2, "button", "Play all"));
  await m2.unmount();
});

test(name("no differences: said in words, with nothing to play; Esc and Backspace go back"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { head } = story(ui);
  let back = 0;
  const m = await render(wrap(ui, h(ChangesView, { from: head, onBack: () => back++ })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  assert.match($(root, ".carton-changes-title")!.textContent!, /^No changes since /);
  assert.equal($(root, ".carton-changes-sub")!.textContent, "Your edit is the same as Claude Code's “Tighten the intro and add a lower third”.");
  assert.equal($(root, ".carton-changes-transport"), null);
  await key(root, "Escape");
  await key(root, "Backspace");
  assert.equal(back, 2);
  await m.unmount();
});

test(name("Restore this version… says what it undoes first; Restore restores it"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director } = story(ui);
  let back = 0;
  const m = await render(wrap(ui, h(ChangesView, { from: director, onBack: () => back++ })));
  await flush();
  const root = $(m.container, ".carton-changes-view")!;
  const n = $$(root, ".carton-change").length;
  await click(byText(root, "button", "Restore this version…"));
  assert.match($(root, ".carton-changes-confirm-title")!.textContent!, /^Restore Director's “Add captions…”\?$/);
  assert.match($(root, ".carton-changes-confirm-body")!.textContent!, new RegExp(`The ${n} changes made since are undone`));
  await key($(root, ".carton-changes-confirm"), "Escape");
  assert.equal($(root, ".carton-changes-confirm"), null, "Esc: the confirmation goes, not the view");
  assert.equal(back, 0);
  await click(byText(root, "button", "Restore this version…"));
  const v0 = ui.history().count("all");
  await click(byText(root, "button", "Restore"));
  assert.equal(ui.history().count("all"), v0 + 1, "restored: a new version on top");
  assert.equal(back, 1);
  await m.unmount();
});

test(name("on a teammate's cut the Changes view offers no Restore, as its History doesn't (PLAN 6.2)"), async () => {
  const ui = createMockUi({ versions: 20 });
  await act(() => ui.switchCut("cut-bob-main"));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  const dir = $$(m.container, ".carton-version").find((r) => /Add captions to the interview/.test(r.textContent ?? ""))!;
  await click(dir.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Compare with your edit"));
  const root = $(m.container, ".carton-changes-view")!;
  assert.ok(root, "the Changes view");
  assert.equal(byText(root, "button", "Restore this version…"), null);
  await m.unmount();
});

test(name("a long range is a virtual list: only the rows on screen exist, and Enter plays the active one"), async () => {
  const ui = createMockUi({ versions: 400, seed: 5 });
  const all = ui.history().all!();
  const from = all[3]!;
  const m = await render(wrap(ui, h("div", { style: { height: "600px", display: "flex", flexDirection: "column" } }, h(ChangesView, { from, onBack: () => {}, host: host().play }))));
  await flush();
  const total = (await ui.changes(from.ref, ui.cuts().find((c) => c.current)!.head)).length;
  assert.ok(total > 50, `${total} changes`);
  const root = $(m.container, ".carton-changes-view")!;
  assert.equal(root.dataset.compact, "");
  const shown = $$(root, ".carton-change").length;
  assert.ok(shown > 0 && shown < total, `${shown} of ${total} rows in the DOM`);
  const list = $(root, ".carton-vlist")!;
  await key(list, "ArrowDown");
  await key(list, "Enter");
  assert.ok($(root, ".carton-change[data-playing]"), "Enter played it");
  await m.unmount();
});

test(name("History: Compare with your edit opens the Changes view in place of the list, ← History comes back; Shift+click picks two"), async () => {
  const ui = createMockUi({ versions: 30 });
  const calls0 = ui.counts.changes;
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  assert.equal(ui.counts.changes, calls0, "the list alone asks for no changes");
  const rows = () => $$(m.container, ".carton-version");
  const dir = rows().find((r) => /Add captions to the interview/.test(r.textContent ?? ""))!;
  await click(dir.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Compare with your edit"));
  assert.ok($(m.container, ".carton-changes-view"), "the Changes view");
  assert.equal($(m.container, ".carton-history-list"), null, "in place of the list");
  assert.equal(ui.counts.changes, calls0 + 1);
  assert.equal(ui.viewing(), null);
  await click(byText(m.container, "button", "History"));
  assert.ok($(m.container, ".carton-history-list"), "back to the list");
  assert.equal($(m.container, ".carton-version[data-active]")?.textContent?.includes("Add captions"), true, "on the row it came from");
  // Shift+click a second version: the Changes view between the two
  const r = rows();
  await click(r[1]);
  await act(() => void r[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
  await flush();
  assert.match($(m.container, ".carton-changes-title")?.textContent ?? "", /^(Changes from|No changes from) /);
  await key($(m.container, ".carton-changes-view"), "Escape");
  assert.ok($(m.container, ".carton-history-list"));
  // Shift+↓ from the active row: the Changes view with the row below
  await key($(m.container, ".carton-history-list"), "ArrowDown");
  await act(() => void $(m.container, ".carton-history-list")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })));
  await flush();
  assert.ok($(m.container, ".carton-changes-view"), "Shift+↓ opened it");
  assert.equal(ui.viewing(), null, "none of it changed the stage");
  await m.unmount();
});

// ---------------------------------------------------------------- History's card, on Play and the Changes view
// (Workstream 3's VersionCard: its Play all, ▶, Pause, See them and Before go to this workstream's player and view)
const card = (root: HTMLElement) => $(root, ".carton-card-version")!;
const historyRow = (root: HTMLElement, text: string) => $$(root, ".carton-version").find((r) => r.textContent?.includes(text)) ?? null;
async function openCardOf(root: HTMLElement, text: string) {
  await click(historyRow(root, text));
  await waitFor(() => !!card(root) && !!byText(card(root), "button", "Play all") && !(byText(card(root), "button", "Play all") as HTMLButtonElement).disabled, "the card's Play all");
}

test(name("History's card: Play all on an older version views it; its Before (held, or B) shows how it was before it; Pause, then Play all goes on"), async () => {
  const ui = createMockUi({ versions: 20 });
  const { director } = story(ui);
  const hs = host();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, play: hs.play })));
  await flush();
  await openCardOf(m.container, "Add captions to the interview");
  await click(byText(card(m.container), "button", "Play all"));
  await waitFor(() => ui.viewing()?.ref === director.ref, "the Director's version viewed");
  assert.ok($(card(m.container), ".carton-change[data-playing]"), "its row lit");
  assert.ok(hs.prefetched.includes(director.base!), "before it, loaded ahead");
  const before = $(card(m.container), ".carton-before")!;
  assert.ok(before, "Before while it plays");
  await hold(before, 600, false);
  assert.equal(ui.viewing()?.kind, "before");
  assert.equal(ui.viewing()?.ref, director.base, "how it was before the Director's turn");
  assert.match(ui.viewing()?.label ?? "", /^Before Director's “Add captions/);
  const real = Date.now;
  Date.now = () => real() + 600;
  await act(() => void before.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 })));
  Date.now = real;
  await flush();
  assert.equal(ui.viewing()?.ref, director.ref, "let go: back on the version playing");
  // B held in History, stopped there
  let reached = 0;
  m.container.parentElement!.addEventListener("keydown", () => reached++);
  const list = $(m.container, ".carton-history-list")!;
  await act(() => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })));
  await flush();
  assert.equal(ui.viewing()?.kind, "before");
  Date.now = () => real() + 600;
  await act(() => void list.dispatchEvent(new KeyboardEvent("keyup", { key: "b", bubbles: true, cancelable: true })));
  Date.now = real;
  await flush();
  assert.equal(ui.viewing()?.ref, director.ref);
  assert.equal(reached, 0, "the editor's own B never saw it");
  // the frames go on the editor's playhead; Pause, then Play all goes on from there, not from the top
  await hs.fc.frames(5);
  const at = hs.frames.at(-1)!;
  await click(byText(card(m.container), "button", "Pause"));
  assert.ok(byText(card(m.container), "button", "Play all"));
  await click(byText(card(m.container), "button", "Play all"));
  await hs.fc.frames(1);
  assert.ok(hs.frames.at(-1)! >= at, "went on where it paused");
  await m.unmount();
});

test(name("History's card: See them opens the Changes view in place of the list, ← History comes back to the card's row; Shift+↓ compares two"), async () => {
  const ui = createMockUi({ versions: 20 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, play: host().play })));
  await flush();
  await openCardOf(m.container, "Add captions to the interview");
  await click(byText(card(m.container), "button", "See them"));
  const view = $(m.container, ".carton-changes-view")!;
  assert.ok(view, "the Changes view");
  assert.match($(view, ".carton-changes-sub")!.textContent!, /^From Director's “Add captions to the interview” to your edit now$/);
  assert.equal($(m.container, ".carton-history-list"), null, "in place of the list");
  await click(byText(view, "button", "History"));
  assert.ok($(m.container, ".carton-history-list"));
  assert.match($(m.container, ".carton-version[data-active]")?.textContent ?? "", /Add captions to the interview/, "back on its row");
  // Shift+↓ from the active row: the changes between it and the next version
  const list = $(m.container, ".carton-history-list")!;
  await act(() => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })));
  await flush();
  assert.match($(m.container, ".carton-changes-title")?.textContent ?? "", /^(Changes from|No changes from) /);
  assert.equal(ui.viewing(), null, "none of it changed the stage");
  await m.unmount();
});
