// The History list and the version card, redesigned (docs/carton-ux PLAN workstream 3, DESIGN §5.2, §6.1, §7), on the
// mock's story: Main cut today, Claude Code's turn on top at 12:48 pm, your six changes before it (one group row), the
// Director's turn, Sent to client, a fold, a restore and a Codex trim. `npm test` runs it on React 19 and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, CutsMenu, HistoryPanel, TeammateCutActions, openCutsMenu, remoteUi, serveUi } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { CartonUi, HistorySource } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const noon48 = () => {
  const d = new Date();
  d.setHours(12, 48, 0, 0);
  return d.getTime();
};
const story = (o: { versions?: number } = {}) => createMockUi({ versions: o.versions ?? 8, now: noon48() });
const row = (root: HTMLElement, text: string | RegExp) => $$(root, ".carton-version").find((r) => (typeof text === "string" ? r.textContent?.includes(text) : text.test(r.textContent ?? ""))) ?? null;
const press = async (target: EventTarget, k: string, o: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o });
  await act(async () => {
    target.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 5));
  });
  await flush();
  return e;
};

test(name("12,000 versions: only the rows on screen are in the DOM, and no row's changes are asked for"), async () => {
  const ui = createMockUi({ versions: 12_000, seed: 3 });
  const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const list = $(m.container, ".carton-history-list")!;
  // overscan 6 above and below; the shortest row is a day's header (32 px)
  const max = Math.ceil(600 / 32) + 1 + 2 * 6;
  assert.ok($$(m.container, ".carton-vrow").length <= max, `${$$(m.container, ".carton-vrow").length} rows for 12,000 versions (at most ${max})`);
  for (const y of [3000, 9000, 1e9]) {
    list.scrollTop = y;
    await act(async () => {
      list.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.ok($$(m.container, ".carton-vrow").length <= max, `scrolled to ${y}: ${$$(m.container, ".carton-vrow").length} rows`);
  }
  assert.deepEqual([ui.counts.changes, ui.counts.changesIn], [0, 0], "nothing described but what's on screen; no card open, no changes read");
  await m.unmount();
});

test(name("only the open card asks what changed: its own changes, and the count since it (an older version)"), async () => {
  const ui = story({ versions: 3000 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onCompare: () => {} })));
  await flush();
  assert.deepEqual([ui.counts.changes, ui.counts.changesIn], [0, 0]);
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!$(m.container, ".carton-card-since"), "the since line");
  assert.equal(ui.counts.changesIn, 1, "one version described: the one opened");
  assert.equal(ui.counts.changes, 1, "one count: from it to your edit");
  // "relative to my work" first (DESIGN §5.2): 7 changes since the Director's turn (Claude Code's 4, your 3 clips)
  assert.equal($(m.container, ".carton-card-since")!.textContent, "Your edit has 7 changes since thisSee them");
  assert.equal($(m.container, ".carton-card-since b")!.textContent, "7 changes");
  // its first four changes, in timeline order, then "and 8 more"
  assert.equal($$(m.container, ".carton-card-version .carton-change").length, 4);
  assert.equal($(m.container, ".carton-card-more")!.textContent, "and 8 more");
  await click($(m.container, ".carton-card-more"));
  assert.equal($$(m.container, ".carton-card-version .carton-change").length, 12, "a click shows them all");
  // a second card closes the first: one at a time
  await click(row(m.container, "Tighten the intro"));
  await flush();
  assert.equal($$(m.container, ".carton-card-version").length, 1);
  assert.equal($(m.container, ".carton-card-since"), null, "the newest version has no \"since this\"");
  assert.equal(ui.counts.changes, 1, "and asks for no count");
  await m.unmount();
});

test(name("a click, Enter or a double-click on a row never changes what the editor shows; Play on the newest plays on your edit"), async () => {
  const ui = story();
  const sought: number[] = [], frames: number[] = [];
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onSeek: (t: number) => sought.push(t), play: { onFrame: (t: number) => frames.push(t) } })));
  await flush();
  const dir = row(m.container, "Add captions to the interview")!;
  await click(dir);
  dir.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await flush();
  await press($(m.container, "[role=listbox]")!, "Enter");
  assert.equal(ui.viewing(), null);
  // Play all on the newest (Claude Code's turn): your own edit, nothing viewed; the playhead goes to its first change
  await click(row(m.container, "Tighten the intro"));
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all") && !(byText(m.container, ".carton-card-version button", "Play all") as HTMLButtonElement).disabled, "Play all");
  await click(byText(m.container, ".carton-card-version button", "Play all"));
  assert.equal(ui.viewing(), null, "the newest plays on your edit (DESIGN §5.3)");
  assert.equal(frames[0], 1, "the playhead goes to a second before its first change, at 0:02");
  assert.deepEqual(sought, [], "Play moves the playhead through the player, not a seek");
  assert.ok($(m.container, ".carton-card-version .carton-change[data-playing]"), "its row is lit");
  assert.ok(byText(m.container, ".carton-card-version button", "Pause"));
  // a change row's click moves the playhead there, without playing
  await click($$(m.container, ".carton-card-version .carton-change")[2]!);
  assert.equal(sought.at(-1), 12);
  await m.unmount();
});

test(name("keys (DESIGN §7): → opens a card or a group, ← closes it, Space plays, F2 names, Esc closes the card first"), async () => {
  const ui = story();
  let outer = 0;
  const m = await render(wrap(ui, h("div", { onKeyDown: (e: KeyboardEvent) => e.key === "Escape" && outer++ }, h(HistoryPanel, { initialHeight: 800 }))));
  await flush();
  const list = $(m.container, "[role=listbox]")!;
  const activeRow = () => document.getElementById(list.getAttribute("aria-activedescendant") ?? "") as HTMLElement | null;
  await press(list, "ArrowDown"); // Today
  await press(list, "ArrowDown"); // Claude Code's turn
  await press(list, "ArrowRight");
  assert.ok($(m.container, ".carton-card-version"), "→ opens its card");
  await press(list, "ArrowLeft");
  assert.equal($(m.container, ".carton-card-version"), null, "← closes it");
  await press(list, "ArrowDown"); // your six changes
  assert.match(activeRow()!.textContent ?? "", /6 changes/);
  await press(list, "ArrowRight");
  assert.equal($$(m.container, ".carton-version[data-child]").length, 5, "→ on a group lists its older versions (its newest is its own row: design QA G10)");
  await press(list, "ArrowDown");
  assert.equal(activeRow()!.dataset.child, "", "↓ goes into them");
  await press(list, "ArrowLeft");
  assert.match(activeRow()!.textContent ?? "", /6 changes/, "← from one goes back to its group");
  await press(list, "ArrowLeft");
  assert.equal($$(m.container, ".carton-version[data-child]").length, 0, "← again closes the group");
  // Space on the Director's (older) turn: its card opens and plays, which views it
  await press(list, "ArrowDown");
  assert.match(activeRow()!.textContent ?? "", /Add captions/);
  const space = await press(list, " ");
  assert.equal(space.defaultPrevented, true);
  await waitFor(() => ui.viewing() !== null, "viewing the Director's turn");
  assert.equal(ui.viewing()!.kind, "version");
  assert.match(ui.viewing()!.label, /^Director's “Add captions…”$/);
  // Esc, one layer at a time (design QA G2): viewing stops first and the card stays, then the card closes (the panel
  // around it never sees either), then the panel's own
  await press(list, "Escape");
  await waitFor(() => ui.viewing() === null, "Esc: back to your edit");
  assert.ok($(m.container, ".carton-card-version"), "the card stays");
  assert.equal(outer, 0);
  await press(list, "Escape");
  assert.equal($(m.container, ".carton-card-version"), null);
  assert.equal(outer, 0);
  await press(list, "Escape");
  assert.equal(outer, 1);
  // F2 names the active version in place
  await press(list, "F2");
  assert.ok($(m.container, ".carton-version input.carton-input"), "F2: the name field");
  await m.unmount();
});

test(name("the filter: a menu (not a bar), Your changes, Only “clip” for the selected clip with its credits, a chip that removes it"), async () => {
  const ui = story();
  let clip: { id: string; name: string } | null = null;
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, selectedClip: () => clip })));
  await flush();
  await click($(m.container, ".carton-filter-btn"));
  assert.equal(byText(m.container, "[role=menuitemradio]", /^Only/), null, "no clip selected: no Only “clip”");
  await click(byText(m.container, "[role=menuitemradio]", "Your changes"));
  assert.ok($$(m.container, ".carton-version:not(.carton-start)").every((r) => /You/.test(r.textContent ?? "")), "only yours");
  assert.equal($(m.container, ".carton-filter-chip-text")!.textContent, "Your changes");
  // a clip selected on the timeline (read when the menu opens)
  clip = { id: "item-interview-b", name: "Interview B" };
  await click($(m.container, ".carton-filter-btn"));
  const only = byText(m.container, "[role=menuitemradio]", /Only “Interview B”/)!;
  assert.match(only.textContent ?? "", /The clip selected on the timeline/);
  await click(only);
  await waitFor(() => !!$(m.container, ".carton-clip-credits"), "the clip's credits");
  assert.equal($(m.container, ".carton-filter-chip-text")!.textContent, "Only “Interview B”");
  // the teammate by first name (design QA G27); a timing line with no change to read says "timing changed", never
  // "retimed" (G7)
  assert.match($(m.container, ".carton-clip-credits")!.textContent ?? "", /^“Interview B”Added by Bob on /);
  assert.doesNotMatch($(m.container, ".carton-clip-credits")!.textContent ?? "", /retimed/);
  const rows = $$(m.container, ".carton-version");
  assert.ok(rows.length >= 2);
  assert.ok(rows.some((r) => /Add captions to the interview/.test(r.textContent ?? "")), "the Director's turn moved it");
  assert.ok(!rows.some((r) => /Tighten the intro/.test(r.textContent ?? "")), "Claude Code's turn didn't touch it");
  // the chip's ✕: back to every version
  await click($(m.container, ".carton-filter-chip-x"));
  assert.equal($(m.container, ".carton-filter-chip"), null);
  assert.ok(row(m.container, "Tighten the intro"));
  await m.unmount();
});

test(name("each filter's empty list says what would appear there"), async () => {
  const ui = createMockUi({ versions: 0 });
  ui.addVersion({ author: people.bob, kind: "edit" });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  for (const [f, words] of [["Named versions", /^No named versions yet\. Name one to find it again\.$/], ["Agent turns", /^No agent turns yet\. When an agent edits, its turn shows here\.$/], ["Your changes", /^No changes of yours yet\.$/]] as const) {
    await click($(m.container, ".carton-filter-btn"));
    await click(byText(m.container, "[role=menuitemradio]", f));
    assert.match($(m.container, ".carton-empty")!.textContent ?? "", words);
  }
  await m.unmount();
});

test(name("rows: Now on the newest, prompts in quotes, a named version, a group of your changes, a fold's 2 of 3, each agent's mark, one start row"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 2000 })));
  await flush();
  const claude = row(m.container, "Tighten the intro")!;
  assert.equal($(claude, ".carton-version-title")!.textContent, "“Tighten the intro and add a lower third”");
  assert.equal($(claude, ".carton-version-when")!.textContent, "Now");
  assert.equal(claude.querySelector("[data-icon]")!.getAttribute("data-icon"), "burst");
  assert.equal(row(m.container, "Add captions")!.querySelector("[data-icon]")!.getAttribute("data-icon"), "bars", "the Director's own mark");
  assert.equal(row(m.container, "Product close-up")!.querySelector("[data-icon]")!.getAttribute("data-icon"), "knot", "Codex's own mark");
  const group = $(m.container, ".carton-version[data-group]")!;
  assert.equal($(group, ".carton-version-title")!.textContent, "Moved “Interview B” 2 s later (now starts at 0:06)");
  assert.match($(group, ".carton-version-meta")!.textContent ?? "", /^You6 changes$/);
  assert.match($(group, ".carton-version-when")!.textContent ?? "", /^12:41 pm/, "a clock time with am/pm, never \"7 min ago\"");
  const sent = row(m.container, "Sent to client")!;
  assert.equal(sent.dataset.named, "");
  assert.match($(sent, ".carton-version-meta")!.textContent ?? "", /^Named by You1 change/);
  assert.equal(sent.querySelector("[data-icon]")!.getAttribute("data-icon"), "bookmarkFill");
  assert.match($(row(m.container, "Folded in “30s cut”")!, ".carton-version-meta")!.textContent ?? "", /2 of 3 changes/);
  // the start: one row, at the bottom, with no menu
  const start = $(m.container, ".carton-start")!;
  // under its own day's header: no date again (design QA G16)
  assert.match(start.textContent ?? "", /^Project created\d/);
  assert.equal($(start, ".carton-version-more"), null);
  assert.equal($$(m.container, "[role=option]").at(-1), start);
  assert.doesNotMatch(m.container.textContent ?? "", /Started the cut|Checkpoint|Imported the project/);
  await m.unmount();
});

test(name("the row menu: Play its changes, Compare with your edit, Name, New cut, Restore… with its line"), async () => {
  const ui = story();
  const compared: [string, string][] = [];
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onCompare: (a: string, b: string) => compared.push([a, b]) })));
  await flush();
  const dir = row(m.container, "Add captions to the interview")!;
  await click($(dir, ".carton-version-more"));
  const items = $$(m.container, "[role=menu] [role=menuitem]");
  assert.deepEqual(items.map((i) => $(i, ".carton-menu-text")!.firstChild!.textContent), ["Play its changes", "Compare with your edit", "Name this version", "New cut from this version…", "Restore…"]);
  assert.match(items[4]!.textContent ?? "", /Go back to this version\. Later changes stay in History\./);
  await click(items[1]!);
  const theTurn = [...ui.history().all!()].reverse().find((v) => v.turn?.label === "Add captions to the interview")!;
  assert.deepEqual(compared, [[theTurn.ref, ui.cuts().find((c) => c.current)!.head]], "the Changes view: this version to your edit");
  await m.unmount();
});

test(name("Restore… asks in the card, with how many later changes it undoes; Undo this turn on the newest agent turn"), async () => {
  const ui = story();
  const restored: string[] = [];
  const restore = ui.restore.bind(ui);
  ui.restore = async (ref: string) => {
    restored.push(ref);
    return restore(ref);
  };
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onCompare: () => {} })));
  await flush();
  const group = $(m.container, ".carton-version[data-group]")!;
  await click($(group, ".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", /^Restore…/));
  await waitFor(() => /The 4 changes/.test($(m.container, ".carton-card-confirm-body")?.textContent ?? ""), "the count");
  assert.match($(m.container, ".carton-card-confirm-title")!.textContent ?? "", /^Restore your edit from 12:41 pm\?$/);
  assert.equal($(m.container, ".carton-card-confirm-body")!.textContent, "Your edit goes back to how it was then. The 4 changes made since are undone. They stay in History, and Ctrl+Z brings them back.");
  assert.ok(byText(m.container, ".carton-card-confirm button", "See the 4"));
  await click(byText(m.container, ".carton-card-confirm button", "Cancel"));
  assert.equal($(m.container, ".carton-card-confirm"), null);
  assert.deepEqual(restored, [], "nothing restored by asking");
  // the newest (Claude Code's turn): Undo this turn, which takes out only its changes
  await click(row(m.container, "Tighten the intro"));
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Undo this turn"), "Undo this turn");
  const undo = byText(m.container, ".carton-card-version button", "Undo this turn")!;
  assert.equal(undo.closest("button")!.getAttribute("data-carton-tip"), "Takes out only these 4 changes. Later changes stay.");
  assert.equal(byText(m.container, ".carton-card-version button", "Restore…"), null, "the newest has nothing to restore to");
  const n = ui.history().count("all");
  await click(undo.closest("button"));
  await flush();
  assert.equal(ui.history().count("all"), n + 1, "an undo is a new version");
  await m.unmount();
});

test(name("a group's card lists every change of its versions, with who made each when the list mixes authors"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  await click($(m.container, ".carton-version[data-group]"));
  await waitFor(() => $$(m.container, ".carton-card-version .carton-change").length > 0, "the group's changes");
  assert.equal(ui.counts.changesIn, 6, "its six versions, read when it opened");
  assert.equal($(m.container, ".carton-card-more")!.textContent, "and 2 more");
  assert.equal($(m.container, ".carton-change-who"), null, "all yours: no who");
  await m.unmount();
});

test(name("your run of changes grows as you edit: its open card and its listed versions stay open on it"), async () => {
  const ui = story();
  // your six changes are the newest row but one: make them the newest, so your next edit joins them
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await flush();
  const group = () => $$(m.container, ".carton-version[data-group]")[0]!;
  assert.match($(group(), ".carton-version-meta")!.textContent ?? "", /2 changes/);
  await click($(group(), ".carton-version-group"));
  await click(group());
  await waitFor(() => $$(m.container, ".carton-card-version .carton-change").length > 0, "its card");
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await flush();
  assert.match($(group(), ".carton-version-meta")!.textContent ?? "", /3 changes/, "the new edit joined the row");
  assert.equal(group().getAttribute("aria-expanded"), "true", "its card is still open");
  assert.ok($(m.container, ".carton-card-version"));
  assert.equal($$(m.container, ".carton-version[data-child]").length, 2, "and its older versions still listed (the new one is the row's own)");
  await m.unmount();
});

// ---------------------------------------------------------------- with Workstream 6 (the integration branch)

test(name("a teammate's cut (PLAN 6.2): its actions under the cut bar; no Restore and no Undo this turn, in the menu or the card"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, cuts: h(CutsMenu, {}), actions: h(TeammateCutActions, { onFoldIn: () => {} }) })));
  await flush();
  assert.equal($(m.container, ".carton-teammate-cut"), null, "your own cut: nothing under the bar");
  await act(() => ui.switchCut("cut-bob-main"));
  await flush();
  const actions = $(m.container, ".carton-teammate-cut")!;
  assert.ok(actions, "Bob's cut: what you can do with it");
  assert.equal(actions.previousElementSibling, $(m.container, ".carton-cutbar"), "right under the cut bar, above the list");
  assert.ok($(m.container, ".carton-cutbar .carton-cuts-viewing"), "the cut bar says it's viewing");
  // the row menu of an older version: no Restore
  await click($(row(m.container, "Add captions to the interview")!, ".carton-version-more"));
  assert.equal(byText(m.container, "[role=menuitem]", /^Restore/), null);
  await press(document.activeElement!, "Escape");
  // the cards: Play stays; no Restore…, no Undo this turn
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all"), "the older card");
  assert.equal(byText(m.container, ".carton-card-version button", "Restore…"), null);
  await click(row(m.container, "Tighten the intro"));
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all"), "the newest card");
  assert.equal(byText(m.container, ".carton-card-version button", "Undo this turn"), null);
  await m.unmount();
});

test(name("the title bar's chip opens the cuts menu in History's cut bar (openCutsMenu)"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, cuts: h(CutsMenu, {}) })));
  await flush();
  let opened = false;
  await act(async () => {
    opened = await openCutsMenu(ui, { within: 500 });
  });
  await flush();
  assert.equal(opened, true);
  assert.ok($(m.container, ".carton-cutbar [role=menu]"), "the menu, open in the cut bar");
  assert.ok(document.activeElement?.closest(".carton-cutbar [role=menu]"), "with focus in it");
  await m.unmount();
});

// ---------------------------------------------------------------- the review of feat/ux-3-history (GPT-6.1 Sol)

test(name("review #1: a group listed open, then hidden (its day folded, a filter), closes, with no render loop"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  await click($(m.container, ".carton-version[data-group] .carton-version-group"));
  assert.equal($$(m.container, ".carton-version[data-child]").length, 5);
  // fold Today (its header is the first row): the group goes; React would throw "Maximum update depth exceeded" here
  await click($$(m.container, ".carton-day")[0]!);
  await flush();
  assert.equal($$(m.container, ".carton-day")[0]!.getAttribute("aria-expanded"), "false");
  await click($$(m.container, ".carton-day")[0]!);
  await flush();
  assert.equal($$(m.container, ".carton-version[data-child]").length, 0, "open again, its group is closed");
  // and through a filter
  await click($(m.container, ".carton-version[data-group] .carton-version-group"));
  await click($(m.container, ".carton-filter-btn"));
  await click(byText(m.container, "[role=menuitemradio]", "Agent turns"));
  await click($(m.container, ".carton-filter-chip-x"));
  assert.ok(row(m.container, "Tighten the intro"), "back to every version, still alive");
  await m.unmount();
});

test(name("review #4: a card opened on a version not sent yet reads it again once it is confirmed"), async () => {
  const ui = createMockUi({ versions: 8, now: noon48(), provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  await click($$(m.container, ".carton-version[data-provisional]")[0]!);
  await waitFor(() => $$(m.container, ".carton-card-version .carton-change").length > 0, "its card");
  const asked = ui.counts.changesIn;
  await act(async () => ui.confirmAll());
  await flush();
  assert.ok(ui.counts.changesIn > asked, "confirmed: its new ref and content are read");
  assert.equal($(m.container, ".carton-version[data-provisional]"), null);
  assert.ok($(m.container, ".carton-card-version"), "the card stays open");
  await m.unmount();
});

test(name("review #5: Play on the newest after an older version was viewed goes back to your edit first"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onSeek: () => {} })));
  await flush();
  const playAll = async (text: string) => {
    await click(row(m.container, text));
    await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all") && !(byText(m.container, ".carton-card-version button", "Play all") as HTMLButtonElement).disabled, "Play all");
    await click(byText(m.container, ".carton-card-version button", "Play all"));
    await flush();
  };
  await playAll("Add captions to the interview");
  assert.equal(ui.viewing()?.kind, "version", "the older one is viewed");
  await playAll("Tighten the intro");
  assert.equal(ui.viewing(), null, "the newest plays on your edit");
  await m.unmount();
});

test(name("review #6: a group's changes are each their own row: unique keys, and ▶ lights only the one played"), async () => {
  const ui = story();
  const errors: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800, onSeek: () => {} })));
    await flush();
    await click($(m.container, ".carton-version[data-group]"));
    await waitFor(() => $$(m.container, ".carton-card-version .carton-change").length > 0, "the group's changes");
    await click($(m.container, ".carton-card-more"));
    const rows = $$(m.container, ".carton-card-version .carton-change");
    assert.equal(rows.length, 6, "six changes, three of them to “Interview B”");
    const keys = rows.map((r) => r.dataset.changeKey);
    assert.equal(new Set(keys).size, 6, "each its own key");
    const ib = rows.find((r) => /Interview B/.test(r.textContent ?? ""))!;
    await click($(ib, ".carton-change-play"));
    assert.equal($$(m.container, ".carton-card-version .carton-change[data-playing]").length, 1, "only the one played is lit");
    await m.unmount();
  } finally {
    console.error = err;
  }
  assert.deepEqual(errors.filter((e) => /same key|unique "key"/i.test(e)), []);
});

test(name("review #7: your run of changes growing at the top never pulls a reader back up the list"), async () => {
  const ui = story({ versions: 600 });
  const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  // your edits on top (newest), the group picked and open
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await flush();
  await click($$(m.container, ".carton-version[data-group]")[0]!);
  const list = $(m.container, ".carton-history-list")!;
  list.scrollTop = 2400;
  await act(async () => {
    list.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 10));
  });
  const before = list.scrollTop;
  await act(async () => void ui.addVersion({ author: people.alice, kind: "edit", at: Date.now() }));
  await flush();
  assert.ok(list.scrollTop >= before, `the reader stays down the list (${before} → ${list.scrollTop})`);
  await m.unmount();
});

test(name("review #8: leaving New cut or Restore… with Esc or Cancel keeps the keyboard in the card; the next Esc closes it"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const dir = row(m.container, "Add captions to the interview")!;
  await click($(dir, ".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", /^New cut from this version/));
  await waitFor(() => !!$(m.container, ".carton-card-newcut input"), "the new cut's field");
  const input = $(m.container, ".carton-card-newcut input")!;
  input.focus();
  await press(input, "Escape");
  assert.equal($(m.container, ".carton-card-newcut"), null);
  // (focus comes back on the next frame; preact's act holds frames, so wait for it rather than for a frame)
  await waitFor(() => document.activeElement === $(m.container, ".carton-card-version"), "focus on the card, not <body>");
  await press(document.activeElement!, "Escape");
  assert.equal($(m.container, ".carton-card-version"), null, "the next Esc closes the card");
  await m.unmount();
});

test(name("an agent working: a live row on top with its line; the newest version shows its time"), async () => {
  const ui = story();
  ui.setWorking("director");
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const live = $(m.container, ".carton-working")!;
  assert.equal($$(m.container, "[role=option]")[1], live, "under Today, on top");
  assert.match(live.textContent ?? "", /“Add music under the interview”/);
  assert.match(live.textContent ?? "", /Working/);
  assert.match(live.textContent ?? "", /2 changes so far/);
  assert.match(live.textContent ?? "", /Keep editing\. Director sees your changes when its turn ends\./);
  assert.ok($(live, ".carton-version-mark[data-live]"));
  assert.match($(row(m.container, "Tighten the intro")!, ".carton-version-when")!.textContent ?? "", /^12:4\d pm/);
  await act(() => ui.setWorking(null));
  await flush();
  assert.equal($(m.container, ".carton-working"), null, "gone when the turn ends");
  assert.equal($(row(m.container, "Tighten the intro")!, ".carton-version-when")!.textContent, "Now");
  await m.unmount();
});

test(name("not sent yet: a pill; Play and Restore wait for it, and say so"), async () => {
  const ui = createMockUi({ versions: 8, now: noon48(), provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const waiting = $$(m.container, ".carton-version[data-provisional]")[0]!;
  assert.match(waiting.textContent ?? "", /Not sent yet/);
  await click(waiting);
  await waitFor(() => !!byText(m.container, ".carton-card-version button", "Play all"), "its card");
  const play = byText(m.container, ".carton-card-version button", "Play all")!.closest("button")!;
  assert.equal(play.disabled, true);
  assert.equal(play.getAttribute("aria-description"), "Available once it's sent");
  await m.unmount();
});

test(name("↑ Newest shows once the list is scrolled, in its own strip, and brings the top back; the day scrolled into keeps its header"), async () => {
  const ui = createMockUi({ versions: 3000, seed: 5 });
  const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const list = $(m.container, ".carton-history-list")!;
  assert.equal($(m.container, ".carton-newest"), null);
  list.scrollTop = 2000;
  await act(async () => {
    list.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 10));
  });
  await flush();
  assert.ok($(m.container, ".carton-newest-btn"), "↑ Newest");
  assert.equal($(m.container, ".carton-newest")!.closest(".carton-history-body")!.lastElementChild, $(m.container, ".carton-newest"), "a strip under the list, over no row");
  assert.equal($(m.container, ".carton-day-sticky .carton-day-label")!.textContent, "Today", "today's header, pinned while its rows scroll by");
  await click($(m.container, ".carton-newest-btn"));
  await flush();
  assert.equal(list.scrollTop, 0);
  assert.equal($(m.container, ".carton-newest"), null);
  await m.unmount();
});

test(name("loading: three grey rows, never \"Loading…\"; a remote History says it is loading until its first message"), async () => {
  const served = story();
  let deliver: (() => void) | null = null;
  const sent: unknown[] = [];
  const { ui, receive } = remoteUi((msg) => sent.push(msg));
  const server = serveUi(served, (m) => {
    const go = () => receive(m);
    if (deliver === null) deliver = go;
    else go();
  });
  assert.equal(ui.history().status!("all").loading, true);
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  assert.equal($$(m.container, ".carton-skeleton-row").length, 3);
  assert.doesNotMatch(m.container.textContent ?? "", /Loading|history starts here/);
  for (const msg of sent) server.receive(msg as never);
  await waitFor(() => deliver !== null, "the first message");
  await act(async () => deliver!());
  await flush();
  assert.equal($(m.container, ".carton-history-skeleton"), null);
  assert.ok(row(m.container, "Tighten the intro"), "the rows, once History is known");
  await m.unmount();
});

test(name("empty: what History is, in one paragraph, and when the cut started; no filter"), async () => {
  const ui = createMockUi({ versions: 0 });
  const d = new Date();
  d.setHours(9, 12, 0, 0);
  ui.addVersion({ at: d.getTime(), author: people.alice, kind: "edit", summary: "Project created", start: "created", changes: 0 }, [{ key: "s", text: "Project created", kind: "add", clip: "project" }]);
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  assert.equal($(m.container, ".carton-history-empty-title")!.textContent, "Your edit's history starts here");
  assert.equal($(m.container, ".carton-history-empty-body")!.textContent, "Every change, yours or an agent's, is saved as a version. Look back at any of them, play what changed, or restore one. Nothing is lost.");
  assert.equal($(m.container, ".carton-history-empty-cut")!.textContent, "Main cut · started today at 9:12 am");
  assert.equal($(m.container, ".carton-filter-btn"), null);
  void (null as unknown as HistorySource);
  await m.unmount();
});

test(name("a version viewed: its row says so, with ✕ back to your edit, and no ⋯ over it"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const dir = [...ui.history().all!()].reverse().find((v) => v.turn?.label === "Add captions to the interview")!;
  await act(() => ui.view({ kind: "version", versionId: dir.id }));
  await flush();
  const viewed = $(m.container, ".carton-version[data-viewing]")!;
  assert.match($(viewed, ".carton-version-when")!.textContent ?? "", /^Viewing/);
  assert.equal($(viewed, ".carton-version-back")!.getAttribute("aria-label"), "Back to my edit (Esc)");
  await click($(viewed, ".carton-version-back"));
  assert.equal(ui.viewing(), null);
  assert.equal($(m.container, ".carton-version[data-viewing]"), null);
  void key;
  await m.unmount();
});

