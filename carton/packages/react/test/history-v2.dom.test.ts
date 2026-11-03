// Carton UX v2, History (N2: docs/carton-ux/v2 DESIGN-V2 §2–§4) on the mock's story: Go back… and its four choices,
// Bring back one clip, search, landmark rows and the Landmarks filter, pick mode and the Compare button (through the
// editor's openCompare, or the panel's own Changes view without it), and hold to peek. `npm test` runs it on React 19
// and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, mutationsDuring, render, runtime, type, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, FIND_DEBOUNCE_MS, HistoryPanel, PEEK_HOLD_MS } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import type { CartonUi, ViewTarget } from "../src/model.ts";

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
const story = (o: { versions?: number } = {}) => createMockUi({ versions: o.versions ?? 8, now: noon48(), landmarks: true });
const row = (root: HTMLElement, text: string | RegExp) => $$(root, ".carton-version").find((r) => (typeof text === "string" ? r.textContent?.includes(text) : text.test(r.textContent ?? ""))) ?? null;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const menuOf = async (root: HTMLElement, text: string) => {
  await click(row(root, text)?.querySelector(".carton-version-more"));
  await flush();
};
const item = (root: HTMLElement, text: string | RegExp) => byText(root, ".carton-menu-item", text instanceof RegExp ? text : new RegExp(`^${text}`));
const pointer = async (el: Element, type: string, o: PointerEventInit = {}) => {
  await act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...o }));
  });
};

// ------------------------------------------------------------------ Go back… (§3.1)

test(name("Go back… on an older agent turn: four choices, smallest first, nothing picked; each button names its action"), async () => {
  const ui = story();
  const restored: string[] = [];
  const restore = ui.restore.bind(ui);
  ui.restore = (ref) => (restored.push(ref), restore(ref));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!byText(m.container, ".carton-card-version .carton-btn", "Go back…"), "Go back… on the card");
  assert.equal(byText(m.container, ".carton-card-version .carton-btn", "Restore…"), null, "Restore… is Go back… now");
  await click(byText(m.container, ".carton-card-version .carton-btn", "Go back…"));
  await waitFor(() => !!$(m.container, ".carton-goback"), "the chooser");
  assert.match($(m.container, ".carton-goback-title")!.textContent ?? "", /^Go back to \d+:\d\d (am|pm), Director's turn$/);
  await waitFor(() => /made after it/.test($(m.container, ".carton-goback-sub")?.textContent ?? ""), "how many after it");
  const choices = $$(m.container, ".carton-goback-choice");
  assert.deepEqual(choices.map((c) => $(c, ".carton-goback-name")!.textContent), ["Bring back one clip", "Undo Director's turn", "Restore the whole edit", "Start a new cut from here"]);
  assert.ok(choices.every((c) => c.getAttribute("aria-checked") === "false"), "nothing is picked when it opens");
  const primary = () => $(m.container, ".carton-goback .carton-btn[data-variant=primary]") as HTMLButtonElement;
  assert.equal(primary().textContent, "Choose one");
  assert.ok(primary().disabled);
  // every choice's button reads differently (never two the same)
  const labels: string[] = [];
  for (const c of choices) {
    await click(c);
    labels.push(primary().textContent ?? "");
  }
  assert.deepEqual(labels, ["Choose a clip…", "Undo Director's turn", "Restore the whole edit", "Name the new cut…"]);
  assert.equal(new Set(labels).size, labels.length);
  // Restore the whole edit: its line says what it does, and the button does it
  await click(choices[2]);
  assert.match(choices[2]!.textContent ?? "", /Your edit becomes this version\. The \d+ changes after it are undone\. They stay in History\./);
  const before = ui.history().count("all");
  await click(primary());
  await waitFor(() => restored.length === 1, "restore called");
  assert.equal(restored[0], ui.history().all!().find((v) => v.name === "Add captions to the interview")!.ref);
  await waitFor(() => ui.history().count("all") === before + 1 && !$(m.container, ".carton-goback"), "a new version, the card closed");
  await m.unmount();
});

test(name("⋯ Restore…, Undo this turn and New cut open Go back… with theirs picked; Esc goes back a step at a time"), async () => {
  const ui = story();
  let undone: string | null = null;
  ui.undoTurnOf = async (id) => ((undone = id), { ok: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  await menuOf(m.container, "Add captions to the interview");
  assert.ok(item(m.container, "Compare with…"), "Compare with… in ⋯");
  await click(item(m.container, "Undo this turn"));
  await waitFor(() => !!$(m.container, ".carton-goback"), "the chooser");
  assert.equal($(m.container, ".carton-goback-choice[aria-checked=true] .carton-goback-name")!.textContent, "Undo Director's turn");
  assert.match($(m.container, ".carton-goback-choice[aria-checked=true] .carton-goback-line")!.textContent ?? "", /^Takes out only its 12 changes\./);
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  await waitFor(() => undone !== null, "undoTurnOf called");
  assert.equal(undone, ui.history().all!().find((v) => v.name === "Add captions to the interview")!.id);
  // Restore… on your six changes: Restore the whole edit picked
  await menuOf(m.container, "Moved “Interview B” 2 s later");
  await click(item(m.container, "Restore…"));
  await waitFor(() => !!$(m.container, ".carton-goback"), "the chooser again");
  assert.equal($(m.container, ".carton-goback-choice[aria-checked=true] .carton-goback-name")!.textContent, "Restore the whole edit");
  assert.equal($(m.container, ".carton-goback-choice[data-choice=turn]"), null, "no Undo turn on a person's changes");
  // Esc: out of the chooser, back to the card (not closed)
  await act(() => {
    $(m.container, ".carton-goback-choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  assert.equal($(m.container, ".carton-goback"), null);
  assert.ok($(m.container, ".carton-card-version"), "the card stays");
  await m.unmount();
});

// ------------------------------------------------------------------ Bring back one clip (§3.2)

test(name("Bring back one clip: the clips that differ, in three groups; a deleted one comes back, one not there then is taken out"), async () => {
  const ui = story();
  const calls: [string, string, unknown][] = [];
  const restoreClip = ui.restoreClip!.bind(ui);
  ui.restoreClip = (ref, id, o) => (calls.push([ref, id, o ?? {}]), restoreClip(ref, id, o));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  const director = ui.history().all!().find((v) => v.name === "Add captions to the interview")!;
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!byText(m.container, ".carton-card-version .carton-btn", "Go back…"), "Go back…");
  await click(byText(m.container, ".carton-card-version .carton-btn", "Go back…"));
  await click($(m.container, ".carton-goback-choice[data-choice=clip]"));
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  await waitFor(() => $$(m.container, ".carton-bringback-row").length > 0, "the clip list");
  const groups = $$(m.container, ".carton-bringback-group").map((g) => g.textContent);
  assert.deepEqual(groups.map((g) => g!.replace(/ · \d+$/, "").replace(/ at .*$/, "")), ["Changed since", "Deleted since", "Not there yet"]);
  const names = (how: string) => $$(m.container, `.carton-bringback-row[data-how=${how}] .carton-bringback-name`).map((e) => e.textContent);
  assert.deepEqual(names("deleted"), ["“B-roll 3”"]);
  assert.deepEqual(names("added"), ["“Jane Smith, Founder”"]);
  assert.ok(names("changed").includes("“Intro”") && names("changed").includes("“Interview B”"));
  assert.ok(!$$(m.container, ".carton-bringback-name").some((e) => /frame rate/.test(e.textContent ?? "")), "a change with no clip isn't listed");
  // a deleted clip: its confirmation, then it comes back as a new version
  const broll = $(m.container, ".carton-bringback-row[data-how=deleted]")!;
  assert.equal($(broll, ".carton-bringback-btn")!.textContent, "Bring back");
  await click($(broll, ".carton-bringback-btn"));
  assert.equal($(m.container, ".carton-bringback-confirm .carton-card-confirm-title")!.textContent, "Bring back “B-roll 3”?");
  assert.equal($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]")!.textContent, "Bring back “B-roll 3”");
  const before = ui.history().count("all");
  await click($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => calls.length === 1 && ui.history().count("all") === before + 1, "restoreClip and its version");
  assert.deepEqual(calls[0], [director.ref, "item-broll", { expect: "absent" }], "with the clip as shown (N0b: gone now)");
  await waitFor(() => !$(m.container, ".carton-card-version"), "the card closes");
  // one that wasn't there then: Take out, with remove
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!byText(m.container, ".carton-card-version .carton-btn", "Go back…"), "Go back… again");
  await click(byText(m.container, ".carton-card-version .carton-btn", "Go back…"));
  await click($(m.container, ".carton-goback-choice[data-choice=clip]"));
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  await waitFor(() => !!$(m.container, ".carton-bringback-row[data-how=added]"), "the list again");
  const jane = $(m.container, ".carton-bringback-row[data-how=added]")!;
  assert.equal($(jane, ".carton-bringback-btn")!.textContent, "Take out");
  await click($(jane, ".carton-bringback-btn"));
  assert.equal($(m.container, ".carton-bringback-confirm .carton-card-confirm-title")!.textContent, "Take out “Jane Smith, Founder”?");
  await click($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => calls.length === 2, "restoreClip with remove");
  assert.equal((calls[1]![2] as { remove?: boolean }).remove, true);
  assert.deepEqual(calls[1]!.slice(0, 2), [director.ref, "item-jane"]);
  assert.match((calls[1]![2] as { expect?: string }).expect ?? "", /^mock:item-jane:/, "with the clip as shown");
  await m.unmount();
});

test(name("a clip selected on the timeline that differs since: Go back… picks Bring back one clip for it, by name"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900, selectedClip: () => ({ id: "item-intro", name: "Intro" }) })));
  await flush();
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => !!byText(m.container, ".carton-card-version .carton-btn", "Go back…"), "Go back…");
  await click(byText(m.container, ".carton-card-version .carton-btn", "Go back…"));
  await waitFor(() => $(m.container, ".carton-goback-choice[data-choice=clip]")?.getAttribute("aria-checked") === "true", "Bring back one clip picked");
  assert.equal($(m.container, ".carton-goback .carton-btn[data-variant=primary]")!.textContent, "Bring back “Intro” as it was");
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  assert.equal($(m.container, ".carton-bringback-confirm .carton-card-confirm-title")!.textContent, "Bring back “Intro”?", "straight to its confirmation");
  await m.unmount();
});

// ------------------------------------------------------------------ search (§2.3)

test(name("search: debounced (one search for a word typed), the matching versions only, marked; Esc clears it"), async () => {
  const ui = story();
  const asked: string[] = [];
  const find = ui.find!.bind(ui);
  ui.find = (q, o) => (asked.push(q), find(q, o));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  const all = $$(m.container, ".carton-version").length;
  const input = $(m.container, ".carton-search-input") as HTMLInputElement;
  assert.equal(input.placeholder, "Find a clip, a word, a person…");
  for (const t of ["i", "in", "int", "intr", "intro"]) await type(input, t);
  assert.deepEqual(asked, [], "no search while typing");
  await wait(FIND_DEBOUNCE_MS + 40);
  await waitFor(() => !!$(m.container, ".carton-find-count"), "the results");
  assert.deepEqual(asked, ["intro"], "one search, for the last text");
  const rows = $$(m.container, ".carton-version");
  assert.ok(rows.length > 0 && rows.length < all, `${rows.length} of ${all} rows`);
  assert.ok(rows.every((r) => /intro/i.test(r.textContent ?? "")), "every row mentions it");
  assert.ok($$(m.container, ".carton-version mark.carton-hit").length > 0, "the match is marked");
  assert.ok($(m.container, ".carton-find-clip"), "the clip first: “Intro”, the clip");
  assert.match($(m.container, ".carton-find-clip")!.textContent ?? "", /Only this clip/);
  assert.equal((m.container.querySelector(".carton-search-input") as HTMLInputElement).value, "intro", "the field keeps its text while results come");
  // Esc in the field clears it, and the whole History is back
  await act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  assert.equal(input.value, "");
  await waitFor(() => $$(m.container, ".carton-version").length === all, "all rows again");
  await m.unmount();
});

test(name("search: nothing found says what to try and where it searched, with Clear search"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  await type($(m.container, ".carton-search-input"), "drone at night");
  await waitFor(() => !!$(m.container, ".carton-find-empty"), "the empty state");
  assert.equal($(m.container, ".carton-find-empty-title")!.textContent, "No versions mention “drone at night”");
  assert.match($(m.container, ".carton-find-empty")!.textContent ?? "", /Try a clip's name.*Searched Main cut\./);
  await click(byText(m.container, ".carton-find-empty .carton-btn", "Clear search"));
  await waitFor(() => !$(m.container, ".carton-find-empty") && $$(m.container, ".carton-version").length > 0, "History again");
  await m.unmount();
});

test(name("search from a scrolled list: the results start at the top, with no ↑ Newest over them; nor once cleared (design QA v2)"), async () => {
  const ui = createMockUi({ versions: 300, seed: 5, now: noon48(), landmarks: true });
  const m = await render(wrap(ui, h("div", { style: { height: "500px" } }, h(HistoryPanel, { initialHeight: 500 }))));
  await flush();
  const list = $(m.container, ".carton-history-list")!;
  list.scrollTop = 1500;
  await act(async () => {
    list.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 10));
  });
  await flush();
  assert.ok($(m.container, ".carton-newest-btn"), "scrolled: ↑ Newest");
  await type($(m.container, ".carton-search-input"), "intro");
  await wait(FIND_DEBOUNCE_MS + 40);
  await waitFor(() => !!$(m.container, ".carton-find-count"), "the results");
  assert.equal($(m.container, ".carton-history-list")!.scrollTop, 0, "the results from their top");
  assert.equal($(m.container, ".carton-newest"), null, "no ↑ Newest over the newest results");
  await click($(m.container, ".carton-search-x"));
  await waitFor(() => !$(m.container, ".carton-find-count"), "History again");
  await flush();
  assert.equal($(m.container, ".carton-history-list")!.scrollTop > 0, !!$(m.container, ".carton-newest"), "↑ Newest only when the list is scrolled");
  await m.unmount();
});

// ------------------------------------------------------------------ landmarks (§2.1, §2.5, §2.6)

test(name("landmarks: tagged rows with a picture tile; the Landmarks filter lists only them"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-landmark=exported]"), "the exported row");
  const exported = $(m.container, ".carton-version[data-landmark=exported]")!;
  assert.equal($(exported, ".carton-landmark-tag")!.textContent, "Exported");
  assert.match(exported.textContent ?? "", /1080p for the client/);
  // (an export stays on this computer until the server carries it, N0's `local`: only you see it, and the row says so)
  assert.match(exported.textContent ?? "", /only you see this/);
  assert.match($(m.container, ".carton-version[data-landmark=before]")!.textContent ?? "", /Kept for you.*only you see this/, "a Before is yours only");
  // its title says which restore, from the row after it (DESIGN-V2 §2.1; design QA v2: it read "an earlier version")
  const restoredRow = $$(m.container, ".carton-version").find((r) => /^Restored the \d{1,2}:\d{2} [ap]m version/.test($(r, ".carton-version-title")?.textContent ?? ""));
  assert.ok(restoredRow, "the restore's row");
  const what = /^Restored (the \d{1,2}:\d{2} [ap]m version)/.exec($(restoredRow, ".carton-version-title")!.textContent!)![1];
  assert.match($(m.container, ".carton-version[data-landmark=before] .carton-version-title")!.textContent ?? "", new RegExp(`Restoring ${what}`));
  assert.ok($(exported, ".carton-landmark-tile"), "a picture tile in place of the avatar");
  await waitFor(() => !!$(exported, ".carton-landmark-tile img"), "its picture, read once its row shows");
  const named = row(m.container, "Sent to client")!;
  assert.equal(named.getAttribute("data-landmark"), "named");
  assert.match(named.textContent ?? "", /also sent/);
  // a turn keeps its agent's mark (no tag)
  assert.equal($(row(m.container, "Add captions to the interview")!, ".carton-landmark-tag"), null);
  // the Landmarks filter
  await click($(m.container, ".carton-filter-btn"));
  const lm = item(m.container, "Landmarks")!;
  assert.match(lm.textContent ?? "", /Exports, sends, names, agent turns, each day's start/);
  await click(lm);
  await flush();
  assert.equal($(m.container, ".carton-filter-chip-text")!.textContent, "Landmarks");
  const landmarkIds = new Set((await ui.landmarks!()).map((l) => l.versionId));
  const shown = $$(m.container, ".carton-version");
  assert.ok(shown.length > 0);
  assert.ok(!row(m.container, "Moved “Interview B” 2 s later"), "your six plain changes aren't a landmark");
  for (const r of shown) assert.ok(r.getAttribute("data-landmark") || /Director|Claude Code/.test(r.textContent ?? ""), `a landmark row: ${r.textContent}`);
  assert.ok(shown.length <= landmarkIds.size);
  await m.unmount();
});

// ------------------------------------------------------------------ pick mode and the Compare button (§4)

test(name("Compare with…: pick mode, the From pill; a click on a second row opens Compare in the editor (openCompare)"), async () => {
  const ui = story();
  const opened: [string, string | null | undefined][] = [];
  ui.openCompare = async (a, b) => void opened.push([a, b]);
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await flush();
  const sent = ui.history().all!().find((v) => v.name === "Sent to client")!;
  const claude = ui.history().all!().find((v) => v.name === "Tighten the intro and add a lower third")!;
  await menuOf(m.container, "Sent to client");
  await click(item(m.container, "Compare with…"));
  assert.match($(m.container, ".carton-pick-line")!.textContent ?? "", /^Comparing from “Sent to client”/);
  assert.ok($(row(m.container, "Sent to client")!, ".carton-pick-from"), "the From pill");
  assert.ok($(m.container, ".carton-history[data-picking]"));
  await click(row(m.container, "Tighten the intro"));
  await waitFor(() => opened.length === 1, "openCompare");
  assert.deepEqual(opened[0], [sent.ref, claude.ref]);
  assert.equal($(m.container, ".carton-pick-line"), null, "pick mode is over");
  assert.equal($(m.container, ".carton-card-version"), null, "and no card opened");
  // Esc leaves pick mode
  await menuOf(m.container, "Sent to client");
  await click(item(m.container, "Compare with…"));
  await act(() => {
    $(m.container, ".carton-history-list")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  assert.equal($(m.container, ".carton-pick-line"), null);
  await m.unmount();
});

test(name("the Compare button: the version you sent, the last export, another cut, pick a version; without openCompare, the panel's own"), async () => {
  const ui = story();
  const opened: [string, string | null | undefined][] = [];
  ui.openCompare = async (a, b) => void opened.push([a, b]);
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await waitFor(() => !!$(m.container, ".carton-compare-btn"), "the button");
  await flush();
  await click($(m.container, ".carton-compare-btn"));
  await waitFor(() => !!$(m.container, ".carton-compare-menu"), "its menu");
  const texts = $$(m.container, ".carton-compare-menu .carton-menu-item").map((e) => e.textContent ?? "");
  assert.ok(texts[0]!.startsWith("The version you sent"), texts.join(" | "));
  assert.ok(texts.some((t) => t.startsWith("The last export1080p for the client")), texts.join(" | "));
  assert.ok(texts.some((t) => t.startsWith("Another cut")));
  assert.ok(texts.some((t) => t.startsWith("Pick a version…")));
  const lands = await ui.landmarks!();
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^The last export/));
  await waitFor(() => opened.length === 1, "openCompare");
  assert.deepEqual(opened[0], [lands.find((l) => l.kind === "exported")!.ref, null], "that version with your edit now");
  await click($(m.container, ".carton-compare-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^Another cut/));
  // (N2c) another cut's History to pick from; its first row is that cut as it is now
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 1, "that cut's History");
  await click($(m.container, ".carton-cut-pick-row[data-now]"));
  await waitFor(() => opened.length === 2, "openCompare across cuts");
  assert.deepEqual(opened[1], ["cut-ig", null]);
  await click($(m.container, ".carton-compare-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^Pick a version…/));
  assert.match($(m.container, ".carton-pick-line")!.textContent ?? "", /Comparing with your edit now/);
  await click(row(m.container, "Add captions to the interview"));
  await waitFor(() => opened.length === 3, "picked against your edit");
  assert.deepEqual(opened[2], [ui.history().all!().find((v) => v.name === "Add captions to the interview")!.ref, null]);
  await m.unmount();
  // a host without the editor's Compare: its onCompare, between two refs of the cut (your edit: the head)
  const ui2 = story();
  const asked: [string, string][] = [];
  const m2 = await render(wrap(ui2, h(HistoryPanel, { initialHeight: 900, onCompare: (a: string, b: string) => void asked.push([a, b]) })));
  await flush();
  await menuOf(m2.container, "Sent to client");
  await click(item(m2.container, "Compare with…"));
  await click(row(m2.container, "Add captions to the interview"));
  await waitFor(() => asked.length === 1, "onCompare");
  const v2 = ui2.history().all!();
  assert.deepEqual(asked[0], [v2.find((v) => v.name === "Sent to client")!.ref, v2.find((v) => v.name === "Add captions to the interview")!.ref]);
  await m2.unmount();
});

// ------------------------------------------------------------------ hold to peek (§2.4)

test(name("hold a row to peek: viewing while held, Holding on the row, back on release; the release's click opens nothing"), async () => {
  const ui = story();
  const views: (ViewTarget | null)[] = [];
  const view = ui.view.bind(ui);
  ui.view = (t) => (views.push(t), view(t));
  const fetched: string[] = [];
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400, play: { prefetch: (ref: string) => void fetched.push(ref) } })));
  await flush();
  const sent = ui.history().all!().find((v) => v.name === "Sent to client")!;
  const r = $(row(m.container, "Sent to client")!, ".carton-version-title")!;
  // resting on it fetches it ahead (once)
  await pointer(r, "pointerover");
  await wait(200);
  assert.deepEqual(fetched, [sent.ref]);
  await pointer(r, "pointerdown");
  await wait(PEEK_HOLD_MS + 60);
  // the chip says what is held, by its landmark (DESIGN-V2 §2.4; design QA v2 G19: it said the plain version label)
  assert.deepEqual(views[0], { kind: "version", versionId: sent.id, label: "“Sent to client” · holding" });
  await waitFor(() => ui.viewing()?.label === "“Sent to client” · holding", "the viewing's label");
  await waitFor(() => row(m.container, "Sent to client")!.hasAttribute("data-hold"), "Holding");
  assert.match(row(m.container, "Sent to client")!.textContent ?? "", /Holding/);
  await pointer(r, "pointerup");
  await act(() => (r as HTMLElement).click());
  await flush();
  assert.equal(views[1], null, "back to your edit on release");
  assert.equal($(m.container, ".carton-card-version"), null, "the release's click opened no card");
  assert.ok(!row(m.container, "Sent to client")!.hasAttribute("data-hold"));
  // a short click opens the card, and views nothing
  await pointer(r, "pointerdown");
  await wait(50);
  await pointer(r, "pointerup");
  await click(r);
  assert.equal(views.length, 2, "no peek for a click");
  assert.ok($(m.container, ".carton-card-version"), "the card");
  await m.unmount();
});

// ------------------------------------------------------------------ cost (§6): typing never touches the list; 12,000 stays virtual

test(name("typing in the search field touches nothing in the list until the search runs"), async () => {
  const ui = story({ versions: 2000 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 800 })));
  await flush();
  const list = $(m.container, ".carton-history-list")!;
  // (the landmarks and their pictures arrive after mount: let them land first)
  for (let i = 0; i < 40 && (await mutationsDuring(list, () => wait(30))) > 0; i++);
  const input = $(m.container, ".carton-search-input")!;
  const n = await mutationsDuring(list, async () => {
    for (const t of ["c", "ca", "cap", "capt", "capti"]) await type(input, t);
  });
  assert.equal(n, 0, "no row re-rendered or moved while typing");
  await waitFor(() => !!$(m.container, ".carton-find-count"), "then the results");
  await m.unmount();
});

test(name("12,000 versions with landmarks, searched and filtered to landmarks: only the rows on screen are in the DOM"), async () => {
  const ui = createMockUi({ versions: 12_000, seed: 3, landmarks: true });
  const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const max = Math.ceil(600 / 32) + 1 + 2 * 6;
  const count = () => $$(m.container, ".carton-vrow").length;
  assert.ok(count() <= max, `${count()} rows`);
  // a search that matches thousands
  await type($(m.container, ".carton-search-input"), "you");
  await waitFor(() => !!$(m.container, ".carton-find-count"), "the results", 20_000);
  assert.ok(count() <= max, `searched: ${count()} rows in the DOM`);
  await type($(m.container, ".carton-search-input"), "");
  await waitFor(() => !$(m.container, ".carton-find-count"), "the list again", 20_000);
  // the Landmarks filter (every day's start, named versions, turns)
  await click($(m.container, ".carton-filter-btn"));
  await click(item(m.container, "Landmarks"));
  await flush();
  assert.ok($$(m.container, ".carton-version").length > 0);
  assert.ok(count() <= max, `landmarks: ${count()} rows in the DOM`);
  assert.deepEqual([ui.counts.changes, ui.counts.changesIn], [0, 0], "nothing described: no card open");
  await m.unmount();
});

// ------------------------------------------------------------------ design QA v2 G10: past days read as a story (§2.5)

for (const n of [1_200, 12_000])
  test(name(`G10: an opened past day lists its landmarks and one line per run (${n} versions); a click opens a run in place; it stays virtual`), async () => {
    // (20 past midnight: Today holds a few versions, so yesterday's header is on screen)
    const d = new Date();
    d.setHours(0, 20, 0, 0);
    const ui = createMockUi({ versions: n, seed: 3, now: d.getTime(), landmarks: true });
    const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
    await waitFor(() => !!$(m.container, ".carton-version[data-landmark]"), "the landmarks");
    const max = Math.ceil(600 / 32) + 1 + 2 * 6;
    const count = () => $$(m.container, ".carton-vrow").length;
    const days = () => $$(m.container, ".carton-day:not(.carton-run)");
    // Today keeps its rows as they were (no runs); a long History's past days start folded
    assert.equal($$(m.container, ".carton-run").length, 0, "Today is never folded into runs");
    assert.equal(days()[1]!.getAttribute("data-collapsed"), "", "a long History's past days start folded");
    await click(days()[1]);
    await flush();
    await waitFor(() => $$(m.container, ".carton-run").length > 0, "the day's runs");
    const runs = $$(m.container, ".carton-run");
    for (const r of runs) assert.match(r.textContent ?? "", /^\d[\d,]* changes? by [A-Z]/, `a run says how many and who: ${r.textContent}`);
    assert.ok(runs.every((r) => !/human\/|agent\/|claude-|codex/.test(r.textContent ?? "")), "no ids or tool names");
    // yesterday's rows between its runs are landmarks (and agent turns, which are landmarks too)
    const vrows = $$(m.container, ".carton-vrow");
    const between = vrows.slice(vrows.findIndex((x) => x.contains(days()[1]!)) + 1).filter((x) => !!$(x, ".carton-version"));
    assert.ok(between.length > 0 && between.every((x) => !!$(x, ".carton-version[data-landmark]") || /Director|Claude Code/.test(x.textContent ?? "")), "landmarks (and agent turns) between the runs");
    assert.ok(count() <= max, `${count()} rows in the DOM`);
    // a click opens the run in place: its rows follow it, grouped; again closes it
    const first = runs[0]!;
    const before = count();
    assert.equal(first.getAttribute("aria-expanded"), "false");
    await click(first);
    await flush();
    const opened = $(m.container, ".carton-run[data-open]")!;
    assert.ok(opened, "the run is open");
    assert.equal(opened.getAttribute("aria-expanded"), "true");
    const next = opened.closest(".carton-vrow")!.nextElementSibling;
    assert.ok(next && $(next, ".carton-version") && !$(next, ".carton-version[data-landmark]"), "its first change follows it");
    assert.ok(count() >= Math.min(before, max - 1) && count() <= max, `opened: ${count()} rows in the DOM`);
    await click(opened);
    await flush();
    assert.equal($(m.container, ".carton-run[data-open]"), null, "closed again");
    // a filter lists what it matches: no runs
    await click($(m.container, ".carton-filter-btn"));
    await click(item(m.container, "Agent turns"));
    await flush();
    assert.equal($$(m.container, ".carton-run").length, 0, "a filtered list has no runs");
    assert.deepEqual([ui.counts.changes, ui.counts.changesIn], [0, 0], "nothing described: no card open");
    await m.unmount();
  });

// ------------------------------------------------------------------ review of feat/ux2-n2 (GPT-6.1 Sol): the fixes

const openGoBack = async (root: HTMLElement) => {
  await click(row(root, "Add captions to the interview"));
  await waitFor(() => !!byText(root, ".carton-card-version .carton-btn", "Go back…"), "Go back…");
  await click(byText(root, ".carton-card-version .carton-btn", "Go back…"));
  await waitFor(() => !!$(root, ".carton-goback"), "the chooser");
};

test(name("N0b: a clip that changed again since its confirmation showed is refused with the engine's words; asked again, it comes back"), async () => {
  const ui = story();
  const calls: [string, unknown][] = [];
  const restoreClip = ui.restoreClip!.bind(ui);
  ui.restoreClip = (ref, id, o) => (calls.push([id, o]), restoreClip(ref, id, o));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900, selectedClip: () => ({ id: "item-intro", name: "Intro" }) })));
  await flush();
  await openGoBack(m.container);
  await waitFor(() => $(m.container, ".carton-goback .carton-btn[data-variant=primary]")?.textContent === "Bring back “Intro” as it was", "Intro picked");
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  assert.equal($(m.container, ".carton-bringback-confirm .carton-card-confirm-title")!.textContent, "Bring back “Intro”?");
  assert.match($(m.container, ".carton-bringback-confirm .carton-card-confirm-body")!.textContent ?? "", /: its timing, text, look and settings\. Nothing else moves\. Ctrl\+Z takes it back\.$/);
  const shown = ((await ui.bringBackChoices!(ui.history().all!().find((v) => v.name === "Add captions to the interview")!.ref)).changed.find((c) => c.itemId === "item-intro")!.token);
  // an agent trims “Intro” again meanwhile
  await act(() => void ui.addVersion({ kind: "edit" }, [{ key: "timelineItems/item-intro", itemId: "item-intro", clip: "video", kind: "change", text: "Trimmed “Intro”, now ends at 0:04", at: 0, end: 4 }]));
  await click($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => !!$(m.container, ".carton-goback-warn"), "the refusal's words");
  assert.deepEqual(calls[0], ["item-intro", { expect: shown }], "the clip as the confirmation showed it");
  assert.equal($(m.container, ".carton-goback-warn")!.textContent, "“Intro” just changed again. Nothing was brought back.");
  assert.equal($(m.container, ".carton-bringback-confirm .carton-card-confirm-title")!.textContent, "Bring back “Intro”?", "asked again");
  const before = ui.history().count("all");
  await click($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => ui.history().count("all") === before + 1, "brought back on the second click, with the new token");
  assert.notEqual((calls[1]![1] as { expect: string }).expect, shown);
  await m.unmount();
});

test(name("review of feat/ux2-n2b: a refusal whose clip can't be read again goes back to the list; another refusal is that failure"), async () => {
  const confirmIntro = async (root: HTMLElement) => {
    await openGoBack(root);
    await waitFor(() => $(root, ".carton-goback .carton-btn[data-variant=primary]")?.textContent === "Bring back “Intro” as it was", "Intro picked");
    await click($(root, ".carton-goback .carton-btn[data-variant=primary]"));
    assert.ok($(root, ".carton-bringback-confirm"));
  };
  // #1: ChangedSince, and the clip as it is now can't be read: never asked again over the old preview
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900, selectedClip: () => ({ id: "item-intro", name: "Intro" }) })));
  await flush();
  await confirmIntro(m.container);
  const choices = ui.bringBackChoices!.bind(ui);
  ui.restoreClip = async () => {
    ui.bringBackChoices = async () => { throw new Error("offline"); };
    throw Object.assign(new Error("“Intro” just changed again. Nothing was brought back."), { code: "CHANGED_SINCE", token: "t2" });
  };
  await click($(m.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => !$(m.container, ".carton-bringback-confirm"), "out of the confirmation");
  assert.equal($(m.container, ".carton-goback-note")!.textContent, "“Intro” just changed again. Nothing was brought back.");
  ui.bringBackChoices = choices;
  await m.unmount();
  // #2: another refusal (its own code), while the clip also changed: said as that failure, not as "changed again"
  const ui2 = story();
  const m2 = await render(wrap(ui2, h(HistoryPanel, { initialHeight: 900, selectedClip: () => ({ id: "item-intro", name: "Intro" }) })));
  await flush();
  await confirmIntro(m2.container);
  ui2.restoreClip = async () => {
    ui2.addVersion({ kind: "edit" }, [{ key: "timelineItems/item-intro", itemId: "item-intro", clip: "video", kind: "change", text: "Trimmed “Intro”, now ends at 0:04", at: 0, end: 4 }]);
    throw Object.assign(new Error("The project file couldn't be written"), { code: "EACCES" });
  };
  await click($(m2.container, ".carton-bringback-confirm .carton-btn[data-variant=primary]"));
  await waitFor(() => !!$(m2.container, ".carton-card-error"), "the failure");
  assert.equal($(m2.container, ".carton-card-error")!.textContent, "Couldn't bring it back. Try again.");
  assert.equal($(m2.container, ".carton-card-error")!.getAttribute("title"), "The project file couldn't be written");
  assert.equal($(m2.container, ".carton-goback-warn"), null);
  await m2.unmount();
});

test(name("review #2, #9, #10: the chooser takes the keyboard when it opens; a ⋯ preset opens it afresh; Esc in the new cut's step goes back to the choices"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  await openGoBack(m.container);
  await waitFor(() => !!document.activeElement && $(m.container, ".carton-goback")!.contains(document.activeElement), "focus in the chooser, not <body>");
  await click($(m.container, ".carton-goback-choice[data-choice=clip]"));
  // ⋯ Restore… on the same row, the chooser open with another choice picked: Restore the whole edit, picked
  await menuOf(m.container, "Add captions to the interview");
  await click(item(m.container, "Restore…"));
  await waitFor(() => $(m.container, ".carton-goback-choice[aria-checked=true]")?.getAttribute("data-choice") === "restore", "Restore picked");
  // Start a new cut from here → Name the new cut… → Esc on its Cancel button: back to the choices, not out of the chooser
  await click($(m.container, ".carton-goback-choice[data-choice=newCut]"));
  await click($(m.container, ".carton-goback .carton-btn[data-variant=primary]"));
  await waitFor(() => !!$(m.container, ".carton-card-newcut"), "the name field");
  const cancel = byText(m.container, ".carton-card-newcut button", "Cancel")!;
  await act(() => {
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  assert.ok($(m.container, ".carton-goback-choices"), "the choices again");
  await m.unmount();
});

test(name("review #4, #8: a search within the Landmarks filter lists landmarks only; a new version that matches joins the results"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-landmark]"), "landmarks");
  await click($(m.container, ".carton-filter-btn"));
  await click(item(m.container, "Landmarks"));
  await type($(m.container, ".carton-search-input"), "you");
  await waitFor(() => !!$(m.container, ".carton-find-count"), "the results");
  const ids = new Set((await ui.landmarks!()).map((l) => l.versionId));
  const rows = $$(m.container, ".carton-version");
  assert.ok(rows.length > 0);
  assert.ok(!row(m.container, "Moved “Interview B” 2 s later"), "your plain changes aren't landmarks");
  await click($(m.container, ".carton-filter-chip-x"));
  // a search for words nothing has yet, then a version named with them
  await type($(m.container, ".carton-search-input"), "picture lock");
  await waitFor(() => !!$(m.container, ".carton-find-empty"), "nothing yet");
  await act(() => void ui.addVersion({ kind: "edit", name: "Picture lock" }));
  await waitFor(() => !!row(m.container, "Picture lock"), "it joins the results", 4000);
  assert.ok(ids.size > 0);
  await m.unmount();
});

test(name("review #12: a cancelled press ends a peek but swallows no later click"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await flush();
  const r = $(row(m.container, "Sent to client")!, ".carton-version-title")!;
  await pointer(r, "pointerdown");
  await wait(PEEK_HOLD_MS + 60);
  await pointer(r, "pointercancel");
  await flush();
  assert.equal(ui.viewing(), null, "back to your edit");
  await click(r);
  assert.ok($(m.container, ".carton-card-version"), "the next click opens the card");
  await m.unmount();
});

// ------------------------------------------------------------------ N2c: Compare with… a version on another cut

test(name("N2c: Compare with… on another cut shows its History to pick from: a version there opens Compare across cuts; Back returns"), async () => {
  const ui = story();
  const opened: [string, string | null | undefined][] = [];
  ui.openCompare = async (a, b) => void opened.push([a, b]);
  const asked: [string, unknown][] = [];
  const cutHistory = ui.cutHistory!.bind(ui);
  ui.cutHistory = (cut, o) => (asked.push([cut, o]), cutHistory(cut, o));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  assert.deepEqual(asked, [], "nothing read until a cut is picked");
  const sent = ui.history().all!().find((v) => v.name === "Sent to client")!;
  await menuOf(m.container, "Sent to client");
  await click(item(m.container, "Compare with…"));
  await click($(m.container, ".carton-pick-cut-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 1, "its History");
  assert.equal($(m.container, ".carton-cut-picker-title")!.textContent, "Pick a version on “30s Instagram cut”");
  assert.equal($(m.container, ".carton-cut-picker-back")!.textContent, "Back to Main cut");
  assert.equal($(m.container, ".carton-cut-pick-row[data-now] .carton-version-title")!.textContent, "“30s Instagram cut” as it is now", "as it is now, first");
  assert.deepEqual(asked[0], ["cut-ig", { limit: 100 }]);
  assert.ok($(m.container, ".carton-pick-line"), "still picking, from “Sent to client”");
  // Back: your cut's list again, still picking
  await click($(m.container, ".carton-cut-picker-back"));
  assert.equal($(m.container, ".carton-cut-picker"), null);
  assert.ok(row(m.container, "Sent to client"));
  // again, and a version there: Compare between the two cuts' versions
  await click($(m.container, ".carton-pick-cut-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 1, "its History again");
  const second = $$(m.container, ".carton-cut-pick-row")[2]!;
  await click(second);
  await waitFor(() => opened.length === 1, "openCompare");
  assert.equal(opened[0]![0], sent.ref);
  assert.match(opened[0]![1] ?? "", /^ig@\d+$/, "a version of the other cut");
  assert.equal($(m.container, ".carton-cut-picker"), null, "pick mode is over");
  assert.equal($(m.container, ".carton-pick-line"), null);
  await m.unmount();
});

test(name("N2c: a cut of 12,000 versions is read a page at a time (the first when shown), and stays virtual"), async () => {
  const ui = story();
  const big = ui.cuts().map((c) => (c.id === "cut-ig" ? { ...c, head: "ig@12000" } : c));
  ui.cuts = () => big;
  const asked: unknown[] = [];
  const cutHistory = ui.cutHistory!.bind(ui);
  ui.cutHistory = (cut, o) => (asked.push(o), cutHistory(cut, o));
  const m = await render(wrap(ui, h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  await click($(m.container, ".carton-compare-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^Another cut/));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 1, "its first page");
  assert.equal(asked.length, 1, "one page");
  const max = Math.ceil(600 / 52) + 1 + 2 * 6;
  // (the next page as the list nears its end: needsMore, below; in a real browser: the capture page's n2c states)
  assert.ok($$(m.container, ".carton-vrow").length <= max, `${$$(m.container, ".carton-vrow").length} rows in the DOM`);
  await m.unmount();
});

test(name("review of feat/ux2-n2c: the other cut's list takes the keyboard (↓, Enter), and the search field searches that cut"), async () => {
  const ui = story();
  const opened: [string, string | null | undefined][] = [];
  ui.openCompare = async (a, b) => void opened.push([a, b]);
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 900 })));
  await flush();
  await click($(m.container, ".carton-compare-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^Another cut/));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 2, "its History");
  assert.equal($(m.container, ".carton-filter-btn"), null, "your cut's filter steps aside");
  // ↓ then Enter: the version under "as it is now"
  const list = $(m.container, ".carton-cut-picker-list")!;
  list.focus();
  for (const k of ["ArrowDown", "Enter"]) {
    await act(() => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
    await flush();
  }
  await waitFor(() => opened.length === 1, "Enter opens Compare");
  assert.deepEqual(opened[0], [(await ui.cutHistory!("cut-ig", { limit: 1 })).versions[0]!.ref, null], "that cut's newest version with your edit");
  // the search field, on that cut's History: its versions that say so
  await click($(m.container, ".carton-compare-btn"));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", /^Another cut/));
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "A version on 30s Instagram cut…"));
  await waitFor(() => $$(m.container, ".carton-cut-pick-row").length > 2, "its History again");
  await type($(m.container, ".carton-search-input"), "outro");
  await waitFor(() => $$(m.container, ".carton-cut-pick-row .carton-hit").length > 0, "the matches, marked");
  const rows = $$(m.container, ".carton-cut-pick-row").slice(1);
  assert.ok(rows.length > 0 && rows.every((r) => /Outro/.test(r.textContent ?? "")), rows.map((r) => r.textContent).join(" | "));
  await click(rows[0]!);
  await waitFor(() => opened.length === 2, "a match opens Compare");
  assert.match(opened[1]![0], /^ig@\d+$/);
  await m.unmount();
});
