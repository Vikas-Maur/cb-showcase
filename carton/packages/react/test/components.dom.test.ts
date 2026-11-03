// Component tests in a DOM. `npm test` runs this file twice: on React 19, then on preact/compat (test/preact-alias.ts).
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, mutationsDuring, render, renders, runtime, type, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  CartonProvider,
  ConflictList,
  CreditsPopover,
  CutsMenu,
  FoldInDialog,
  GhostLayer,
  HistoryPanel,
  PresenceAvatars,
  PreviewBanner,
  PublishedStatus,
  SyncStatusWords,
  UndoTurnButton,
} from "../src/index.ts";
import { createMockUi, people, type MockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

test(name("sync status words: Syncing · Up to date · Offline: N edits waiting, nothing when not shared"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(SyncStatusWords)));
  assert.equal(m.container.textContent, "Syncing");
  await act(() => ui.setSync({ kind: "upToDate" }));
  await flush();
  assert.equal(m.container.textContent, "Up to date");
  await act(() => ui.setSync({ kind: "offline", waiting: 3 }));
  await flush();
  assert.equal(m.container.textContent, "Offline: 3 edits waiting");
  assert.equal($(m.container, "[role=status]")?.getAttribute("aria-live"), "polite");
  await act(() => ui.setSync({ kind: "local" }));
  await flush();
  assert.equal(m.container.textContent, "");
  await m.unmount();
});

test(name("History renders a window of a 10k list, marks agent turns, named and not-yet-sent versions"), async () => {
  const ui = createMockUi({ versions: 10_000, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: "main@10000" })));
  const rows = $$(m.container, "[role=option]");
  assert.ok(rows.length > 5 && rows.length < 40, `${rows.length} rows in the DOM for 10,004 versions`);
  assert.ok(rows.some((r) => r.dataset.provisional !== undefined && /Not sent yet/.test(r.textContent ?? "")));
  // an agent's turn is titled by its prompt, in quotes; no engineer's badge (AUDIT H3)
  assert.ok(rows.some((r) => r.dataset.kind === "turn" && /“Tighten the intro and add a lower third”/.test(r.textContent ?? "") && /Claude Code/.test(r.textContent ?? "")));
  assert.ok(!rows.some((r) => /Checkpoint/i.test(r.textContent ?? "")));
  assert.ok(rows.some((r) => r.dataset.named !== undefined && /Sent to client/.test(r.textContent ?? "") && /Named by You/.test(r.textContent ?? "")));
  // The list's full height is there for the scrollbar: 10k versions over several days are grouped by day (UI audit
  // P2-17), every day but the newest folded to its named versions and turns, so the height is the rows shown.
  const inner = $(m.container, ".carton-vlist > div")!;
  const days = $$(m.container, ".carton-day");
  assert.ok(days.length >= 1 && days[0]!.getAttribute("aria-expanded") === "true", "the newest day is open");
  const height = parseFloat(inner.style.height);
  assert.ok(height > 600 && height < 10_004 * 56, `${height}px for the grouped list`);
  assert.equal(height % 2, 0);
  // Named filter, from the filter menu: only named versions (and their days), and the filter shows as a chip
  await click($(m.container, ".carton-filter-btn"));
  await click(byText(m.container, "[role=menuitemradio]", "Named versions"));
  const named = $$(m.container, ".carton-version");
  // (an agent's version with a name reads as its prompt, in quotes, as versionLabel names it: PLAN 0.9)
  assert.ok(named.length > 0 && named.every((r) => r.dataset.named !== undefined || r.dataset.prompt !== undefined));
  assert.ok(named.some((r) => r.dataset.named !== undefined));
  assert.equal($(m.container, ".carton-filter-chip-text")?.textContent, "Named versions");
  await m.unmount();
});

test(name("History: keyboard moves the active row; Enter opens its card and never changes what the editor shows"), async () => {
  const ui = createMockUi({ versions: 50 });
  let outer = 0;
  const m = await render(wrap(ui, h("div", { onKeyDown: (e: KeyboardEvent) => e.key === "Escape" && outer++ }, h(HistoryPanel, { initialHeight: 600 }))));
  const list = $(m.container, "[role=listbox]")!;
  // Today's header, then the newest two versions: the third row is your group of edits
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  const active = $$(m.container, "[role=option][aria-selected=true]");
  assert.equal(active.length, 1);
  assert.equal(list.getAttribute("aria-activedescendant"), active[0]!.id);
  await key(list, "Enter");
  await flush();
  assert.ok($(m.container, ".carton-card-version[role=region]"), "its card is open, under it");
  assert.equal(active[0]!.getAttribute("aria-expanded"), "true");
  assert.equal(ui.viewing(), null, "the editor still shows your edit (DESIGN §4.2)");
  // Esc closes the card (the innermost layer), and only it
  await key(list, "Escape");
  assert.equal($(m.container, ".carton-card-version"), null);
  assert.equal(outer, 0, "the panel around it never saw that Esc");
  await key(list, "Escape");
  assert.equal(outer, 1, "with no card open, Esc goes on to the panel (stop viewing, close)");
  await m.unmount();
});

test(name("History: name a version in place"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const row = $$(m.container, ".carton-version").find((r) => r.dataset.named === undefined && r.dataset.kind === "edit" && r.dataset.provisional === undefined && r.querySelector(".carton-version-more"))!;
  await click(row.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Name this version"));
  const input = $(m.container, "input.carton-input");
  assert.ok(input);
  await type(input, "Picture lock");
  await act(() => (input!.closest("form") as HTMLFormElement).requestSubmit());
  await flush();
  assert.ok(byText(m.container, ".carton-version-title", "Picture lock"));
  await m.unmount();
});

test(name("narrow subscriptions: ghosts and presence never touch History; a sync change never touches the rows"), async () => {
  const ui = createMockUi({ versions: 2000 });
  const m = await render(
    wrap(
      ui,
      h("div", { id: "hist" }, h(HistoryPanel, { initialHeight: 600 })),
      h("div", { id: "sync" }, h(SyncStatusWords)),
      h("div", { id: "people" }, h(PresenceAvatars)),
      h("div", { id: "ghosts", style: { position: "relative", width: "800px", height: "200px" } }, h(GhostLayer, { timeToX: (t: number) => t * 20, trackBand: () => ({ top: 10, height: 30 }) })),
    ),
  );
  const hist = $(m.container, "#hist")!, people_ = $(m.container, "#people")!;
  // 50 ghost moves: neither History nor the avatars change.
  const touched = await mutationsDuring(hist, async () => {
    const pm = await mutationsDuring(people_, async () => {
      for (let i = 0; i < 50; i++) {
        await act(() => ui.setGhosts([{ actorKey: people.bob.key, itemId: "x", trackId: "V1", start: i, end: i + 2 }]));
      }
      await flush();
    });
    assert.equal(pm, 0, "avatars untouched by ghost moves");
    await act(() => ui.setSync({ kind: "offline", waiting: 1 }));
    await flush();
  });
  assert.equal(touched, 0, "History untouched by ghosts and sync");
  // A new version touches History, but only adds a row: existing rows keep their DOM.
  const firstRows = $$(hist, "[role=option]").slice(1, 4);
  await act(() => void ui.addVersion({ author: people.bob }));
  await flush();
  for (const r of firstRows) assert.ok(r.isConnected, "existing row element kept");
  await m.unmount();
});

test(name("cuts menu (PLAN 6.1): who and when per cut, a dot but on Main, teammates' cuts View only, new cut from your edit, one Fold entry"), async () => {
  const ui = createMockUi({ versions: 10 });
  let folded: string | null = null;
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { label: string }, into: { label: string }) => (folded = `${from.label}→${into.label}`) })));
  const trigger = $(m.container, ".carton-menu-trigger")!;
  assert.match(trigger.textContent ?? "", /Main cut/);
  assert.equal($(trigger, ".carton-cut-dot"), null, "Main cut has no dot");
  await click(trigger);
  const item = (re: RegExp) => $$(m.container, "[role=menuitemradio]").find((e) => re.test(e.textContent ?? ""))!;
  assert.equal(item(/^Main cut/).getAttribute("aria-checked"), "true");
  assert.match(item(/^Main cut/).textContent ?? "", /You · /, "who changed it last, and when");
  assert.match(item(/^30s Instagram cut/).textContent ?? "", /Director · 2 h ago/);
  assert.ok($(item(/^30s Instagram cut/), ".carton-cut-dot"), "every other cut has its dot");
  // teammates' cuts under their own label, View only
  const labels = $$(m.container, ".carton-menu-label").map((e) => e.textContent);
  assert.deepEqual(labels, ["Cuts", "From teammates"]);
  assert.match(item(/^Bob's Main cut/).textContent ?? "", /View only/);
  assert.ok(byText(m.container, ".carton-cuts-note", "Agents work on the cut you're on."));
  await click(byText(m.container, "[role=menuitem]", "New cut from your edit"));
  await type($(m.container, "input.carton-input"), "Teaser");
  await act(() => ($(m.container, "form") as HTMLFormElement).requestSubmit());
  await flush();
  assert.equal(ui.cuts().find((c) => c.current)?.name, "Teaser");
  assert.match($(m.container, ".carton-menu-trigger")!.textContent ?? "", /Teaser/);
  assert.ok($(m.container, ".carton-menu-trigger .carton-cut-dot"), "a new cut gets its dot at once");
  await click($(m.container, ".carton-menu-trigger"));
  // into the cut you're on, from the cut changed most recently
  await click(byText(m.container, "[role=menuitem]", "Fold in changes from a cut…"));
  assert.equal(folded, "Main cut→Teaser");
  await m.unmount();
});

test(name("cuts menu (PLAN 6.1): one Fold entry however many cuts; scrolls past 8, a search past 12"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: () => {} })));
  const foldEntries = () => $$(m.container, "[role=menuitem]").filter((e) => /^Fold/.test(e.textContent ?? "")).length;
  await click($(m.container, ".carton-menu-trigger"));
  assert.equal(foldEntries(), 1, `${ui.cuts().length} cuts, one Fold entry`);
  assert.equal($(m.container, ".carton-cuts-scroll"), null, "5 cuts: no scrolling");
  await key(document.activeElement, "Escape");
  for (let i = 0; i < 9; i++) await act(async () => void (await ui.newCut(`Cut ${i}`, "main@1")));
  await click($(m.container, ".carton-menu-trigger"));
  assert.equal(foldEntries(), 1, `${ui.cuts().length} cuts, still one Fold entry`);
  assert.ok($(m.container, ".carton-cuts-scroll"), "past 8 cuts the list scrolls");
  const find = $(m.container, "input.carton-cuts-find");
  assert.ok(find, "past 12 cuts, a search field");
  await type(find, "instagram");
  assert.deepEqual($$(m.container, "[role=menuitemradio]").map((e) => e.querySelector(".carton-cut-name")?.textContent), ["30s Instagram cut"]);
  await key(find, "ArrowDown");
  assert.equal(document.activeElement, $(m.container, "[role=menuitemradio]"), "the arrows go from the field into the list");
  await m.unmount();
});

test(name("fold in (PLAN 6.3): from/into, the line, change rows, a lock, leave one out, pick inline, then Fold in N changes"), async () => {
  const ui = createMockUi({ versions: 10 });
  let call: unknown = null;
  const real = ui.fold.bind(ui);
  (ui as MockUi).fold = async (f, i, o) => ((call = o), real(f, i, o));
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  assert.equal($(dialog, ".carton-dialog-title")!.textContent, "Fold in changes");
  assert.deepEqual($$(dialog, ".carton-fold-cut").map((e) => e.getAttribute("aria-label")), ["From: 30s Instagram cut", "into: Main cut, you're on it"]);
  assert.match($(dialog, ".carton-fold-lead")!.textContent ?? "", /^Main cut gets what changed on “30s Instagram cut” since it was made from Main cut at \d+:\d\d [ap]m\.$/);
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1)! as HTMLButtonElement;
  assert.equal(go().textContent, "Fold in 4 changes");
  assert.ok(go().disabled, "can't fold before picking");
  assert.equal($(dialog, ".carton-fold-later")!.textContent, "Pick one for “Interview B”", "the button says why it waits");
  // a row: time in the edit, the kind of clip, the sentence, who
  const rows = $$(dialog, ".carton-fold-change");
  assert.deepEqual(rows.map((r) => r.querySelector(".carton-change-time")?.textContent), ["0:00", "0:03", "0:12", "—"]);
  assert.deepEqual(rows.map((r) => r.querySelector(".carton-change-chip")?.getAttribute("data-clip")), ["video", "title", "video", "project"]);
  assert.match(rows[0]!.textContent ?? "", /Director · 2 h ago/);
  // a project setting can't be left out: a lock, and the line says why
  assert.equal($$(dialog, "input[type=checkbox]").length, 3);
  assert.ok($(rows[3]!, ".carton-fold-lock"));
  assert.match(rows[3]!.textContent ?? "", /Can't be left out: it's a setting for the whole project/);
  assert.equal(byText(dialog, "button", "Select none")?.className, "carton-fold-select");
  await click($(rows[1]!, "input[type=checkbox]"));
  assert.equal(go().textContent, "Fold in 3 changes");
  assert.ok(byText(dialog, "button", "Select all"), "one link: Select all once one is out");
  // the conflict inline: both cuts' versions, as a radio group that names each cut
  const sides = $$(dialog, ".carton-fold-pick [role=radio]");
  assert.deepEqual(sides.map((e) => e.textContent), ["Main cut's: starts at 0:18· You", "30s Instagram cut's: starts at 0:20· Director"]);
  assert.equal($(dialog, ".carton-fold-pick-title")!.textContent, "Both cuts moved “Interview B”. Pick one:");
  await click(sides[0]);
  assert.equal(go().disabled, false);
  assert.equal($(dialog, ".carton-fold-later")!.textContent, "1 change is left out. It stays on “30s Instagram cut”, and you can fold it in later.");
  await click(go());
  // `count`: the button's "Fold in 3 changes", which the fold's toast repeats (PLAN 5.3)
  assert.deepEqual(call, { leaveOut: ["items/summer"], choices: { "timelineItems/item-interview-b/#time": "mine" }, count: 3 });
  await m.unmount();
});

test(name("fold in (PLAN 6.3): the pickers change the cuts; the nothing-to-fold and the rest states"), async () => {
  const ui = createMockUi({ versions: 10 });
  const asked: string[] = [];
  const planFold = ui.planFold.bind(ui);
  ui.planFold = async (f, i, o) => {
    asked.push(`${f}>${i}`);
    const p = await planFold(f, i, o);
    if (f === "cut-dir") return { ...p, changes: [], conflicts: [], warnings: [] };
    if (f === "cut-offline") return { ...p, conflicts: [], warnings: [], changes: [{ ...p.changes[2]!, leftOut: "fold-17", leftOutAt: new Date(2026, 9, 30, 16, 10).getTime() }] };
    return p;
  };
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = () => $(m.container, "[role=dialog]")!;
  // From: every cut but the one it goes into (a teammate's too); Into: only your own cuts
  await click($(dialog(), ".carton-fold-cut"));
  assert.deepEqual($$(dialog(), "[role=menuitemradio] .carton-cut-name").map((e) => e.textContent), ["30s Instagram cut", "Director's cut: punchier open", ui.cuts()[3]!.label, "Bob's Main cut"]);
  await click($$(dialog(), "[role=menuitemradio]")[1]);
  await flush();
  assert.equal(asked.at(-1), "cut-dir>cut-main");
  assert.equal($(dialog(), ".carton-fold-nothing")!.textContent, "Main cut already has everything from “Director's cut: punchier open”.");
  assert.deepEqual($$(dialog(), ".carton-dialog-foot button").map((b) => b.textContent), ["Close"]);
  await click($(dialog(), ".carton-fold-cut"));
  await click($$(dialog(), "[role=menuitemradio]")[2]);
  await flush();
  assert.equal($(dialog(), ".carton-fold-lead")!.textContent, "1 change was left out when you folded this cut in on Oct 30. It can come in now.");
  assert.match($(dialog(), ".carton-fold-change")!.textContent ?? "", /Left out on Oct 30/);
  assert.equal($$(dialog(), ".carton-dialog-foot button").at(-1)!.textContent, "Fold in the rest");
  await click($$(dialog(), ".carton-fold-cut")[1]);
  assert.deepEqual($$(dialog(), "[role=menuitemradio] .carton-cut-name").map((e) => e.textContent), ["Main cut", "30s Instagram cut", "Director's cut: punchier open"], "never into a teammate's cut");
  await m.unmount();
});

test(name("undo turn, published cut status and credits"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(UndoTurnButton), h(PublishedStatus), h(CreditsPopover, { itemId: "item-broll" })));
  await flush();
  assert.ok(byText(m.container, "button", "Undo Director: tighter intro"));
  assert.match(m.container.textContent ?? "", /Newer edits exist/);
  assert.match(m.container.textContent ?? "", /Director › Explore/);
  assert.match(m.container.textContent ?? "", /Credits for B-roll 3/);
  await click(byText(m.container, "button", "Undo Director: tighter intro"));
  const undo = byText(m.container, "button", "Undo turn") as HTMLButtonElement;
  assert.ok(undo?.disabled, "nothing left to undo");
  await click(byText(m.container, "button", "Publish again"));
  assert.match(m.container.textContent ?? "", /The share link shows the newest version/);
  await m.unmount();
});

test(name("presence groups each person with their agents and subagents"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(PresenceAvatars, { max: 5 })));
  const groups = $$(m.container, ".carton-presence-group");
  assert.equal(groups[0]!.querySelectorAll(".carton-avatar").length, 3, "you, your Director and its Explore subagent");
  const labels = $$(m.container, ".carton-avatar").map((a) => a.getAttribute("aria-label"));
  assert.ok(labels.includes("Director › Explore · Looking at the b-roll"));
  assert.ok(labels.some((l) => /Priya Shah · Idle/.test(l ?? "")));
  await m.unmount();
});

test(name("ghost layer draws remote drags without rendering through React"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h("div", { style: { position: "relative" } }, h(GhostLayer, { timeToX: (t: number) => t * 10, trackBand: (id: string) => (id === "V1" ? { top: 40, height: 24 } : null) }))));
  await waitFor(() => !!$(m.container, ".carton-ghost"), "the ghost to be drawn");
  const g = $(m.container, ".carton-ghost")!;
  assert.ok(g, "a ghost element");
  assert.equal(g.style.transform, "translate(125px, 40px)");
  assert.equal(g.style.width, "40px");
  assert.match(g.textContent ?? "", /Bob Okafor · B-roll city/);
  await act(() => ui.setGhosts([]));
  await waitFor(() => !$(m.container, ".carton-ghost"), "the ghost to go");
  assert.equal($(m.container, ".carton-ghost"), null);
  await m.unmount();
});

test(name("R1-14: Enter and arrows typed in the naming field belong to the field, not the list"), async () => {
  const ui = createMockUi({ versions: 30, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const row = $$(m.container, ".carton-version").find((r) => r.dataset.provisional === undefined && r.dataset.named === undefined && r.querySelector(".carton-version-more"))!;
  await click(row.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Name this version"));
  const input = $(m.container, "input.carton-input")!;
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(() => void input.dispatchEvent(ev));
  assert.equal(ev.defaultPrevented, false, "the list doesn't swallow Enter, so the form submits");
  assert.equal(ui.preview(), null, "and no preview opened");
  assert.equal(ui.viewing(), null);
  const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  await act(() => void input.dispatchEvent(arrow));
  assert.equal(arrow.defaultPrevented, false);
  await m.unmount();
});

test(name("R1-15: the context-menu key opens the active version's actions; still-syncing rows can't be opened"), async () => {
  const ui = createMockUi({ versions: 30, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const list = $(m.container, "[role=listbox]")!;
  await key(list, "ArrowDown"); // Today
  await key(list, "ArrowDown"); // the newest: not sent yet
  await key(list, "Enter");
  assert.equal(ui.viewing(), null, "nothing viewed");
  await key(list, "ContextMenu");
  const menu = $(m.container, "[role=menu]");
  assert.ok(menu, "actions menu open");
  // what waits for it to be sent says so, in a line under its name (no tooltip over the next item)
  const play = $$(menu!, "[role=menuitem]").find((e) => e.textContent?.startsWith("Play its changes"))!;
  assert.equal(play.getAttribute("aria-disabled"), "true");
  assert.match(play.textContent ?? "", /Available once it's sent/);
  assert.equal(document.activeElement?.closest("[role=menu]"), menu, "focus moved into the menu");
  await m.unmount();
});

test(name("an empty version (the start of an imported project) offers no Play, New cut or Restore, and says why"), async () => {
  const ui = createMockUi({ versions: 0 });
  const system = { key: "system/carton", kind: "system" as const, name: "" };
  ui.addVersion({ author: system, summary: "Started the cut", empty: true });
  ui.addVersion({ author: people.alice, summary: "Imported the project", kind: "import" });
  const restored: string[] = [];
  const restore = ui.restore.bind(ui);
  ui.restore = async (ref: string) => { restored.push(ref); return restore(ref); };
  const m = await render(wrap(ui, h("div", { style: { height: 600 } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const row = (text: string) => $$(m.container, "[role=option]").find((r) => r.textContent?.includes(text))!;
  await click(row("Started the cut").querySelector(".carton-version-more"));
  const menu = $(m.container, "[role=menu]")!;
  const items = () => $$(menu, "[role=menuitem]").map((e) => e.textContent ?? "");
  assert.ok(!items().some((t) => t.startsWith("Play")), "no Play");
  assert.ok(!items().some((t) => t.startsWith("New cut")), "no New cut");
  const r = $$(menu, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))!;
  assert.equal(r.getAttribute("aria-disabled"), "true", "Restore isn't offered");
  assert.match(r.textContent ?? "", /before the project was added/, "and it says why");
  await click(r);
  assert.deepEqual(restored, [], "a click does nothing");
  // opening the row (a click, Enter) views nothing
  await click(row("Started the cut"));
  await key($(m.container, "[role=listbox]")!, "Enter");
  assert.equal(ui.preview(), null);
  assert.equal(ui.viewing(), null);
  // the version after it is the project (and your edit now): New cut is there; there's nothing to restore to yet
  await click(row("Imported the project").querySelector(".carton-version-more"));
  const menu2 = $(m.container, "[role=menu]")!;
  assert.ok($$(menu2, "[role=menuitem]").some((e) => e.textContent?.startsWith("New cut from this version")));
  assert.equal($$(menu2, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore")), undefined, "no Restore on the newest version");
  await m.unmount();
});

test(name("a restore the app refuses says so in its card, with the app's reason in the tooltip"), async () => {
  const ui = createMockUi({ versions: 3 });
  ui.restore = async () => { throw new Error("Nothing to restore: that version is empty"); };
  const m = await render(wrap(ui, h("div", { style: { height: 600 } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const row = $$(m.container, ".carton-version").filter((r) => r.dataset.provisional === undefined && r.querySelector(".carton-version-more"))[1]!;
  await click(row.querySelector(".carton-version-more"));
  await click($$(m.container, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))!);
  await flush();
  // Restore… asks first, in the card, with what it does
  const card = $(m.container, ".carton-card-version")!;
  assert.match($(card, ".carton-card-confirm-title")!.textContent ?? "", /^Restore .+\?$/);
  await click(byText(card, "button", "Restore"));
  await waitFor(() => !!$(m.container, ".carton-card-version .carton-card-error[role=alert]"), "the error line");
  const err = $(m.container, ".carton-card-version .carton-card-error")!;
  assert.equal(err.textContent, "Couldn't restore this version. Try again.");
  assert.equal(err.getAttribute("title"), "Nothing to restore: that version is empty");
  await m.unmount();
});

test(name("R1-18: the Cuts menu offers Rename only when the engine can rename"), async () => {
  const ui = createMockUi({ versions: 10 });
  delete (ui as { renameCut?: unknown }).renameCut;
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await click($(m.container, ".carton-menu-trigger"));
  assert.equal(byText(m.container, "[role=menuitem]", "Rename “Main cut”"), null);
  assert.ok(byText(m.container, "[role=menuitem]", "New cut from your edit"));
  await m.unmount();
});

test(name("R1-18: a failed switch says so next to the menu"), async () => {
  const ui = createMockUi({ versions: 10 });
  ui.switchCut = async () => {
    throw new Error("That cut isn't available offline");
  };
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitemradio]", /^30s Instagram cut/));
  assert.match($(m.container, "[role=alert]")?.textContent ?? "", /isn't available offline/);
  await m.unmount();
});

// ---------------------------------------------------------------- review round 2

test(name("R2-5: when a fold comes back with new cards, the dialog shows the plan as it is now, with the new card"), async () => {
  const ui = createMockUi({ versions: 10 });
  const planFold = ui.planFold.bind(ui);
  let raced = false;
  const late = { id: "items/logo/name", title: "'Logo' name", mine: { author: people.alice, summary: "“Logo”" }, theirs: { author: people.bob, summary: "“New logo”" }, canKeepBoth: false };
  ui.planFold = async (f, i, o) => {
    const p = await planFold(f, i, o);
    return raced ? { ...p, conflicts: [...p.conflicts, late] } : p;
  };
  ui.fold = async () => {
    raced = true;
    return { ok: false, conflicts: [late] };
  };
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  await click(byText(dialog, "[role=radio]", /^Main cut's: /));
  await click($$(dialog, ".carton-dialog-foot button").at(-1));
  await flush();
  assert.match(dialog.textContent ?? "", /Something changed since you looked/);
  assert.ok(byText(dialog, ".carton-fold-pick-title", "Both cuts changed 'Logo' name. Pick one:"), "the new card is there to pick on");
  assert.equal(($$(dialog, ".carton-dialog-foot button").at(-1) as HTMLButtonElement).disabled, true, "can't fold until it's picked");
  await m.unmount();
});

test(name("R3-1: a card that comes back after a fold has no pick: it must be picked again"), async () => {
  const ui = createMockUi({ versions: 10 });
  const planFold = ui.planFold.bind(ui);
  let raced = false;
  ui.planFold = async (f, i, o) => {
    const p = await planFold(f, i, o);
    // The same card (same id), its source edited again since it was picked.
    return raced ? { ...p, conflicts: p.conflicts.map((c) => ({ ...c, theirs: { ...c.theirs, summary: "Moved it to start at 0:03.0" } })) } : p;
  };
  ui.fold = async () => {
    raced = true;
    const p = await ui.planFold("cut-ig", "cut-main");
    return { ok: false, conflicts: p.conflicts };
  };
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  await click(byText(dialog, "[role=radio]", /^30s Instagram cut's: /));
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1) as HTMLButtonElement;
  assert.equal(go().disabled, false);
  await click(go());
  await flush();
  assert.match(dialog.textContent ?? "", /Moved it to start at 0:03\.0/, "the card as it is now");
  assert.equal(go().disabled, true, "its old pick is gone: Fold in waits for a new one");
  assert.equal($$(dialog, ".carton-fold-pick [aria-checked=true]").length, 0);
  await m.unmount();
});

// ---------------------------------------------------------------- review round 4

test(name("R4-1: a card that changed while the plan reloaded loses its pick too, not only the cards the fold returned"), async () => {
  const ui = createMockUi({ versions: 10 });
  const card = (id: string, title: string, theirs: string) => ({ id, title, mine: { author: people.alice, summary: "“Mine”", where: "Main cut" }, theirs: { author: people.bob, summary: theirs, where: "30s Instagram cut" }, canKeepBoth: false, provisional: "mine" as const });
  const planFold = ui.planFold.bind(ui);
  let round = 0;
  ui.planFold = async (f, i, o) => {
    const p = await planFold(f, i, o);
    // First plan: A and B. After the fold raced: both changed (A returned by the fold, B changed during the reload).
    return round === 0 ? { ...p, conflicts: [card("A", "Card A", "“A1”"), card("B", "Card B", "“B1”")] } : { ...p, conflicts: [card("A", "Card A", "“A2”"), card("B", "Card B", "“B2”")] };
  };
  ui.fold = async () => {
    round = 1;
    return { ok: false, conflicts: [card("A", "Card A", "“A2”")] };
  };
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  const cardEl = (title: string) => $$(dialog, ".carton-fold-pick").find((e) => e.textContent?.includes(title))!;
  const theirs = (title: string) => byText(cardEl(title), "[role=radio]", /^30s Instagram cut's: /);
  await click(theirs("Card A"));
  await click(theirs("Card B"));
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1) as HTMLButtonElement;
  assert.equal(go().disabled, false);
  await click(go());
  await flush();
  assert.match(cardEl("Card B").textContent ?? "", /B2/);
  await click(theirs("Card A"));
  assert.equal(go().disabled, true, "B changed during the reload: its old pick doesn't count");
  await click(theirs("Card B"));
  assert.equal(go().disabled, false);
  await m.unmount();
});

// ---------------------------------------------------------------- Stage F: render counts under live sync (U6/U7)

test(name("U6/U7: versions arriving and ghosts moving re-render only History; avatars, ghosts, cuts, published and sync stay put"), async () => {
  const ui = createMockUi({ versions: 2000 });
  const m = await render(
    wrap(
      ui,
      h("div", { id: "bar" }, h(CutsMenu, {}), h(SyncStatusWords), h(PresenceAvatars), h(PublishedStatus)),
      h("div", { style: { height: "600px" } }, h(HistoryPanel, { initialHeight: 600 })),
      h("div", { style: { position: "relative", width: "800px", height: "200px" } }, h(GhostLayer, { timeToX: (t: number) => t * 20, trackBand: () => ({ top: 10, height: 30 }) })),
    ),
  );
  await flush();
  renders.clear();
  const published = $(m.container, ".carton-published")!;
  const pubMutations = await mutationsDuring(published, async () => {
    // Each version moves the current cut's head and bumps the published cut's newer-edit count, as a commit does.
    for (let i = 0; i < 10; i++) {
      await act(() => void ui.addVersion({ author: people.bob }));
      await act(() => ui.setGhosts([{ actorKey: people.bob.key, itemId: "x", trackId: "V1", start: i, end: i + 2 }]));
      await flush(1);
    }
  });
  const n = (name: string) => renders.get(name) ?? 0;
  assert.equal(n("PresenceAvatars"), 0, "avatars don't re-render for versions or ghosts");
  assert.equal(n("GhostLayer"), 0, "ghosts move without React");
  assert.equal(n("CutsMenu"), 0, "a head moving doesn't re-render the Cuts menu");
  assert.equal(n("PublishedStatus"), 0, "still 'newer edits exist': nothing it shows changed");
  assert.equal(n("SyncStatusWords"), 0);
  assert.equal(pubMutations, 0, "the published status's DOM is untouched");
  assert.ok(n("HistoryPanel") >= 1 && n("HistoryPanel") <= 10, `History re-renders at most once per version (${n("HistoryPanel")})`);
  assert.ok(n("VersionRow") <= 10 + 4, `only new rows render (${n("VersionRow")} for 10 versions)`);
  // And when something it shows does change, it re-renders: publishing clears "newer edits exist".
  await act(() => ui.publish("cut-main"));
  await flush();
  assert.equal(n("PublishedStatus"), 1);
  assert.match(published.textContent ?? "", /The share link shows the newest version/);
  await m.unmount();
});

test(name("F-5: Fold in hands the host the cuts as they are now, not the heads the menu last showed"), async () => {
  const ui = createMockUi({ versions: 10 });
  await act(() => ui.switchCut("cut-ig"));
  let got: { from: string; into: string } | null = null;
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { head: string }, into: { head: string }) => (got = { from: from.head, into: into.head }) })));
  await act(() => void ui.addVersion({ author: people.bob })); // moves the current cut's head; the menu doesn't re-render
  await flush();
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitem]", "Fold in changes from a cut…"));
  assert.equal(got!.into, ui.cuts().find((c) => c.id === "cut-ig")!.head, "the cut you're on, its head as it is now");
  assert.equal(got!.from, ui.cuts().find((c) => c.id === "cut-main")!.head);
  await m.unmount();
});
