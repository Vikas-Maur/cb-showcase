// Component tests in a DOM. `npm test` runs this file twice: on React 19, then on preact/compat (test/preact-alias.ts).
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, mutationsDuring, render, renders, runtime, type, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  CartonProvider,
  CompareCard,
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
  WatchTheChanges,
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

test(name("History renders a window of a 10k list, marks checkpoints, named and waiting versions"), async () => {
  const ui = createMockUi({ versions: 10_000, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: "main@10000" })));
  const rows = $$(m.container, "[role=option]");
  assert.ok(rows.length > 5 && rows.length < 40, `${rows.length} rows in the DOM for 10,004 versions`);
  assert.ok(rows.some((r) => r.dataset.provisional !== undefined && /Not sent yet/.test(r.textContent ?? "")));
  assert.ok(rows.some((r) => r.dataset.kind === "turn" && !/Checkpoint/.test(r.textContent ?? "") && /Tighten the intro/.test(r.textContent ?? "")));
  assert.ok(rows.some((r) => r.dataset.named !== undefined && /Sent to client/.test(r.textContent ?? "")));
  // The list's full height is there for the scrollbar: 10k versions over several days are grouped by day (UI audit
  // P2-17), every day but the newest folded to its named versions and turns, so the height is the rows shown.
  const inner = $(m.container, ".carton-vlist > div")!;
  const days = $$(m.container, ".carton-day");
  assert.ok(days.length >= 1 && days[0]!.getAttribute("aria-expanded") === "true", "the newest day is open");
  const height = parseFloat(inner.style.height);
  assert.ok(height > 600 && height < 10_004 * 52, `${height}px for the grouped list`);
  assert.equal(height % 2, 0);
  // Named filter.
  await click(byText(m.container, "[role=radio]", "Named"));
  const named = $$(m.container, "[role=option]");
  assert.ok(named.length > 0 && named.every((r) => r.dataset.named !== undefined));
  await m.unmount();
});

test(name("History: keyboard moves the active row and Enter opens a read-only preview"), async () => {
  const ui = createMockUi({ versions: 50 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 }), h(PreviewBanner)));
  const list = $(m.container, "[role=listbox]")!;
  // The two newest versions are still waiting to sync: the third is the Director's checkpoint.
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  const active = $$(m.container, "[role=option][aria-selected=true]");
  assert.equal(active.length, 1);
  assert.equal(list.getAttribute("aria-activedescendant"), active[0]!.id);
  await key(list, "Enter");
  assert.ok(ui.preview(), "a preview is open");
  assert.match(m.container.textContent ?? "", /You're looking at/);
  assert.doesNotMatch(m.container.textContent ?? "", /Read-only|Previewing/);
  await click(byText(m.container, "button", "Back to my edit"));
  assert.equal(ui.preview(), null);
  await m.unmount();
});

test(name("History: name a version in place"), async () => {
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const row = $$(m.container, "[role=option]").find((r) => r.dataset.named === undefined && r.dataset.kind === "edit" && r.dataset.provisional === undefined)!;
  await click(row.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Name this version"));
  const input = $(m.container, "input.carton-input");
  assert.ok(input);
  await type(input, "Picture lock");
  await act(() => (input!.closest("form") as HTMLFormElement).requestSubmit());
  await flush();
  assert.ok(byText(m.container, ".carton-version-text", "Picture lock"));
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

test(name("conflict cards: both edits shown, Keep theirs resolves and the card goes away"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(ConflictList)));
  assert.match(m.container.textContent ?? "", /2 conflicts to pick/);
  const card = $$(m.container, ".carton-conflict")[1]!;
  assert.match(card.textContent ?? "", /Summer sale/);
  assert.match(card.textContent ?? "", /Summer launch/);
  assert.ok(byText(card, "button", "Keep both"), "Keep both offered when both can be kept");
  // Each choice says whose edit it keeps; on one cut there is no "where".
  assert.ok(byText(card, "button", "Keep yours"));
  await click(byText(card, "button", "Keep Bob Okafor's"));
  assert.equal($$(m.container, ".carton-conflict").length, 1);
  assert.match(m.container.textContent ?? "", /1 conflict to pick/);
  assert.equal(byText(m.container, "button", "Keep both"), null, "the timing card can't keep both");
  await m.unmount();
});

test(name("cuts menu: lists cuts (Bob's read-only), new cut from here, rename"), async () => {
  const ui = createMockUi({ versions: 10 });
  let folded: string | null = null;
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { label: string }, into: { label: string }) => (folded = `${from.label}→${into.label}`) })));
  const trigger = $(m.container, ".carton-menu-trigger")!;
  assert.match(trigger.textContent ?? "", /Main cut/);
  await click(trigger);
  // a read-only cut says why on a second line under its name (no tooltip)
  const items = $$(m.container, "[role=menuitemradio]").map((e) => e.textContent);
  assert.ok(items.some((t) => t?.startsWith("Bob's Main cut")));
  assert.ok(items.includes("30s Instagram cut"));
  await click(byText(m.container, "[role=menuitem]", "New cut from here"));
  await type($(m.container, "input.carton-input"), "Teaser");
  await act(() => ($(m.container, "form") as HTMLFormElement).requestSubmit());
  await flush();
  assert.equal(ui.cuts().find((c) => c.current)?.name, "Teaser");
  assert.match($(m.container, ".carton-menu-trigger")!.textContent ?? "", /Teaser/);
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitem]", "Fold into Main cut"));
  assert.equal(folded, "Teaser→Main cut");
  await m.unmount();
});

test(name("fold in: leave a change out, pick on the card, then fold in N of M"), async () => {
  const ui = createMockUi({ versions: 10 });
  let call: unknown = null;
  const real = ui.fold.bind(ui);
  (ui as MockUi).fold = async (f, i, o) => ((call = o), real(f, i, o));
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  assert.match(dialog.textContent ?? "", /Fold “30s Instagram cut” into “Main cut”/);
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1)!;
  assert.equal(go().textContent, "Fold in");
  assert.ok((go() as HTMLButtonElement).disabled, "can't fold before picking on the card");
  const boxes = $$(dialog, "input[type=checkbox]");
  assert.equal(boxes.length, 6);
  await click(boxes[1]);
  assert.equal(go().textContent, "Fold in 5 of 6");
  assert.match(dialog.textContent ?? "", /You can fold in the rest later/);
  // In a fold each choice names whose edit and which cut, so "mine" is never ambiguous.
  assert.ok(byText(dialog, "button", "Keep Director's (30s Instagram cut)"));
  assert.ok($$(dialog, ".carton-conflict-where").some((e) => e.textContent === "30s Instagram cut"));
  await click(byText(dialog, "button", "Keep yours (Main cut)"));
  assert.equal((go() as HTMLButtonElement).disabled, false);
  await click(go());
  assert.deepEqual(call, { leaveOut: ["items/interview-a"], choices: { "items/intro/#time": "mine" } });
  await m.unmount();
});

test(name("compare card: time, author, clips, length, and what changed (N changes · X s of Y s differ)"), async () => {
  const ui = createMockUi({ versions: 10 });
  let watched: string[] | null = null;
  const m = await render(wrap(ui, h(CompareCard, { a: "main@3", b: "main@9", onWatch: (a: string, b: string) => (watched = [a, b]) })));
  await flush();
  const text = m.container.textContent ?? "";
  assert.match(text, /\d+ changes? · \d+\.\d s of \d+\.\d s differ/);
  assert.doesNotMatch(text, /shots? \//, "never shots (UI audit P2-5)");
  assert.match(text, /clips/);
  assert.match(text, /\d:\d\d\.\d/);
  await click(byText(m.container, "button", "Play all"));
  assert.deepEqual(watched, ["main@3", "main@9"]);
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

test(name("watch the changes: aligned strips, change count, next, A/B toggle and a read-only preview"), async () => {
  const ui = createMockUi({ versions: 10 });
  const frames: [string, number][] = [];
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9", onFrame: (s: string, t: number) => frames.push([s, t]) })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  assert.match(root.textContent ?? "", /1 of 4/);
  assert.equal($$(root, ".carton-strip").length, 2);
  assert.ok($$(root, "[data-kind=fold]").length >= 2, "unchanged runs folded");
  assert.ok($$(root, "[data-tone=removed]").length === 1 && $$(root, "[data-tone=added]").length === 1);
  await click($(root, "[aria-label='Next']"));
  assert.match(root.textContent ?? "", /2 of 4/);
  const before = byText(root, "[role=radio]", "Before")!;
  await click(before);
  assert.equal(before.getAttribute("aria-checked"), "true");
  assert.equal(ui.preview()?.ref, "main@3", "Before is shown as a read-only preview");
  assert.ok(frames.length > 0 && frames.at(-1)![0] === "a");
  await m.unmount();
  assert.equal(ui.preview(), null, "closing Watch the changes closes the preview");
});

// ---------------------------------------------------------------- review round 1 (reviews/ui.md)

test(name("R1-13: switching Watch the changes to the current side closes its preview"), async () => {
  const ui = createMockUi({ versions: 10 });
  const head = ui.cuts().find((c) => c.current)!.head;
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: head })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  assert.equal(ui.preview(), null, "After is the current head: no preview");
  await click(byText(root, "[role=radio]", "Before"));
  assert.equal(ui.preview()?.ref, "main@3");
  await click(byText(root, "[role=radio]", "After"));
  assert.equal(ui.preview(), null, "back on the current side: the preview is closed");
  await m.unmount();
});

test(name("R1-14: Enter and arrows typed in the naming field belong to the field, not the list"), async () => {
  const ui = createMockUi({ versions: 30, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const row = $$(m.container, "[role=option]").find((r) => r.dataset.provisional === undefined && r.dataset.named === undefined)!;
  await click(row.querySelector(".carton-version-more"));
  await click(byText(m.container, "[role=menuitem]", "Name this version"));
  const input = $(m.container, "input.carton-input")!;
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(() => void input.dispatchEvent(ev));
  assert.equal(ev.defaultPrevented, false, "the list doesn't swallow Enter, so the form submits");
  assert.equal(ui.preview(), null, "and no preview opened");
  const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  await act(() => void input.dispatchEvent(arrow));
  assert.equal(arrow.defaultPrevented, false);
  await m.unmount();
});

test(name("R1-15: the context-menu key opens the active version's actions; still-syncing rows can't be opened"), async () => {
  const ui = createMockUi({ versions: 30, provisional: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const list = $(m.container, "[role=listbox]")!;
  await key(list, "ArrowDown"); // the newest: still waiting to sync
  await key(list, "Enter");
  assert.equal(ui.preview(), null, "nothing to preview yet");
  await key(list, "ContextMenu");
  const menu = $(m.container, "[role=menu]");
  assert.ok(menu, "actions menu open");
  // Restore's hint is a line under its name (no tooltip over the next item)
  assert.equal($$(menu!, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))?.getAttribute("aria-disabled"), "true");
  assert.equal(document.activeElement?.closest("[role=menu]"), menu, "focus moved into the menu");
  await m.unmount();
});

test(name("an empty version (the start of an imported project) offers no Preview, New cut from here or Restore, and says why"), async () => {
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
  assert.ok(!items().some((t) => t.startsWith("Preview")), "no Preview");
  assert.ok(!items().some((t) => t.startsWith("New cut from here")), "no New cut from here");
  const r = $$(menu, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))!;
  assert.equal(r.getAttribute("aria-disabled"), "true", "Restore isn't offered");
  assert.match(r.textContent ?? "", /before the project was added/, "and it says why");
  await click(r);
  assert.deepEqual(restored, [], "a click does nothing");
  // opening the row (Enter, double-click) previews nothing
  await click(row("Started the cut"));
  await key($(m.container, "[role=listbox]")!, "Enter");
  assert.equal(ui.preview(), null);
  // the version after it is the project: every action is there
  await click(row("Imported the project").querySelector(".carton-version-more"));
  const menu2 = $(m.container, "[role=menu]")!;
  assert.ok($$(menu2, "[role=menuitem]").some((e) => e.textContent?.startsWith("New cut from here")));
  assert.equal($$(menu2, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))!.getAttribute("aria-disabled"), null);
  await m.unmount();
});

test(name("a restore the app refuses says why in the panel"), async () => {
  const ui = createMockUi({ versions: 3 });
  ui.restore = async () => { throw new Error("Nothing to restore: that version is empty"); };
  const m = await render(wrap(ui, h("div", { style: { height: 600 } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const row = $$(m.container, "[role=option]").find((r) => r.dataset.provisional === undefined)!;
  await click(row.querySelector(".carton-version-more"));
  await click($$(m.container, "[role=menuitem]").find((e) => e.textContent?.startsWith("Restore"))!);
  await waitFor(() => !!$(m.container, ".carton-history-error[role=alert]"), "the error line");
  assert.equal($(m.container, ".carton-history-error")!.textContent, "Nothing to restore: that version is empty");
  await m.unmount();
});

test(name("R1-18: the Cuts menu offers Rename only when the engine can rename"), async () => {
  const ui = createMockUi({ versions: 10 });
  delete (ui as { renameCut?: unknown }).renameCut;
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await click($(m.container, ".carton-menu-trigger"));
  assert.equal(byText(m.container, "[role=menuitem]", "Rename cut"), null);
  assert.ok(byText(m.container, "[role=menuitem]", "New cut from here"));
  await m.unmount();
});

test(name("R1-18: a failed switch says so next to the menu"), async () => {
  const ui = createMockUi({ versions: 10 });
  ui.switchCut = async () => {
    throw new Error("That cut isn't available offline");
  };
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitemradio]", "30s Instagram cut"));
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
  await click(byText(dialog, "button", "Keep yours (Main cut)"));
  await click($$(dialog, ".carton-dialog-foot button").at(-1));
  await flush();
  assert.match(dialog.textContent ?? "", /Something changed since you looked/);
  assert.ok(byText(dialog, ".carton-card-title", "'Logo' name"), "the new card is there to pick on");
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
  await click(byText(dialog, "button", "Keep Director's (30s Instagram cut)"));
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1) as HTMLButtonElement;
  assert.equal(go().disabled, false);
  await click(go());
  await flush();
  assert.match(dialog.textContent ?? "", /Moved it to start at 0:03\.0/, "the card as it is now");
  assert.equal(go().disabled, true, "its old pick is gone: Fold in waits for a new one");
  assert.equal($$(dialog, ".carton-conflict [aria-pressed=true]").length, 0);
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
  const cardEl = (title: string) => $$(dialog, ".carton-conflict").find((e) => e.textContent?.includes(title))!;
  await click(byText(cardEl("Card A"), "button", "Keep Bob Okafor's (30s Instagram cut)"));
  await click(byText(cardEl("Card B"), "button", "Keep Bob Okafor's (30s Instagram cut)"));
  const go = () => $$(dialog, ".carton-dialog-foot button").at(-1) as HTMLButtonElement;
  assert.equal(go().disabled, false);
  await click(go());
  await flush();
  assert.match(cardEl("Card B").textContent ?? "", /B2/);
  await click(byText(cardEl("Card A"), "button", "Keep Bob Okafor's (30s Instagram cut)"));
  assert.equal(go().disabled, true, "B changed during the reload: its old pick doesn't count");
  await click(byText(cardEl("Card B"), "button", "Keep Bob Okafor's (30s Instagram cut)"));
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

test(name("F-5: Fold into Main hands the host the cuts as they are now, not the heads the menu last showed"), async () => {
  const ui = createMockUi({ versions: 10 });
  await act(() => ui.switchCut("cut-ig"));
  let got: { from: string; into: string } | null = null;
  const m = await render(wrap(ui, h(CutsMenu, { onFoldIn: (from: { head: string }, into: { head: string }) => (got = { from: from.head, into: into.head }) })));
  await act(() => void ui.addVersion({ author: people.bob })); // moves the current cut's head; the menu doesn't re-render
  await flush();
  await click($(m.container, ".carton-menu-trigger"));
  await click(byText(m.container, "[role=menuitem]", "Fold into Main cut"));
  assert.equal(got!.from, ui.cuts().find((c) => c.id === "cut-ig")!.head, "the source's head as it is now");
  await m.unmount();
});
