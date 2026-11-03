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
  assert.deepEqual(calls[0], [director.ref, "item-broll", {}]);
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
  assert.deepEqual(calls[1], [director.ref, "item-jane", { remove: true }]);
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

// ------------------------------------------------------------------ landmarks (§2.1, §2.5, §2.6)

test(name("landmarks: tagged rows with a picture tile; the Landmarks filter lists only them"), async () => {
  const ui = story();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-landmark=exported]"), "the exported row");
  const exported = $(m.container, ".carton-version[data-landmark=exported]")!;
  assert.equal($(exported, ".carton-landmark-tag")!.textContent, "Exported");
  assert.match(exported.textContent ?? "", /1080p for the client/);
  assert.doesNotMatch(exported.textContent ?? "", /only you see this/, "an export is everyone's (DESIGN-V2 §2.1)");
  assert.match($(m.container, ".carton-version[data-landmark=before]")!.textContent ?? "", /Kept for you.*only you see this/, "a Before is yours only");
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
  await click(byText(m.container, ".carton-compare-menu .carton-menu-item", "30s Instagram cut"));
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
  assert.deepEqual(views[0], { kind: "version", versionId: sent.id });
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
