// Component tests in a DOM. `npm test` runs this file twice: on React 19, then on preact/compat (test/preact-alias.ts).
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, mutationsDuring, render, runtime, type } from "./dom.ts";
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
  const ui = createMockUi({ versions: 10_000 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: "main@10000" })));
  const rows = $$(m.container, "[role=option]");
  assert.ok(rows.length > 5 && rows.length < 40, `${rows.length} rows in the DOM for 10,004 versions`);
  assert.ok(rows.some((r) => r.dataset.provisional !== undefined && /Waiting to sync/.test(r.textContent ?? "")));
  assert.ok(rows.some((r) => r.dataset.kind === "turn" && /Checkpoint/.test(r.textContent ?? "") && /tighter intro/.test(r.textContent ?? "")));
  assert.ok(rows.some((r) => r.dataset.named !== undefined && /Sent to client, Monday/.test(r.textContent ?? "")));
  // The list's full height is there for the scrollbar.
  const inner = $(m.container, ".carton-vlist > div")!;
  assert.equal(inner.style.height, `${10_004 * 52}px`);
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
  assert.match(m.container.textContent ?? "", /Previewing/);
  await click(byText(m.container, "button", "Return to current to edit"));
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
  assert.match(m.container.textContent ?? "", /2 conflict cards waiting/);
  const card = $$(m.container, ".carton-conflict")[1]!;
  assert.match(card.textContent ?? "", /Summer sale/);
  assert.match(card.textContent ?? "", /Summer launch/);
  assert.ok(byText(card, "button", "Keep both"), "Keep both offered when both can be kept");
  await click(byText(card, "button", "Keep theirs"));
  assert.equal($$(m.container, ".carton-conflict").length, 1);
  assert.match(m.container.textContent ?? "", /1 conflict card waiting/);
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
  const items = $$(m.container, "[role=menuitemradio]").map((e) => e.textContent);
  assert.ok(items.includes("Bob's Main cut"));
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
  await click(byText(dialog, "button", "Keep mine"));
  assert.equal((go() as HTMLButtonElement).disabled, false);
  await click(go());
  assert.deepEqual(call, { leaveOut: ["items/interview-a"], choices: { "items/intro/#time": "mine" } });
  await m.unmount();
});

test(name("compare card: time, author, clips, length and N shots / X s of Y s differ"), async () => {
  const ui = createMockUi({ versions: 10 });
  let watched: string[] | null = null;
  const m = await render(wrap(ui, h(CompareCard, { a: "main@3", b: "main@9", onWatch: (a: string, b: string) => (watched = [a, b]) })));
  await flush();
  const text = m.container.textContent ?? "";
  assert.match(text, /\d+ shots \/ \d+\.\d s of \d+\.\d s differ/);
  assert.match(text, /clips/);
  assert.match(text, /\d:\d\d\.\d/);
  await click(byText(m.container, "button", "Watch the changes"));
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
  assert.match(m.container.textContent ?? "", /Credits for B-roll city/);
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
  await act(() => new Promise((r) => setTimeout(r, 40)));
  const g = $(m.container, ".carton-ghost")!;
  assert.ok(g, "a ghost element");
  assert.equal(g.style.transform, "translate(125px, 40px)");
  assert.equal(g.style.width, "40px");
  assert.match(g.textContent ?? "", /Bob Okafor · B-roll city/);
  await act(() => ui.setGhosts([]));
  await act(() => new Promise((r) => setTimeout(r, 40)));
  assert.equal($(m.container, ".carton-ghost"), null);
  await m.unmount();
});

test(name("watch the changes: aligned strips, change count, next, A/B toggle and a read-only preview"), async () => {
  const ui = createMockUi({ versions: 10 });
  const frames: [string, number][] = [];
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9", onFrame: (s: string, t: number) => frames.push([s, t]) })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  assert.match(root.textContent ?? "", /Change 1 of 4/);
  assert.equal($$(root, ".carton-strip").length, 2);
  assert.ok($$(root, "[data-kind=fold]").length >= 2, "unchanged runs folded");
  assert.ok($$(root, "[data-tone=removed]").length === 1 && $$(root, "[data-tone=added]").length === 1);
  await click($(root, "[aria-label='Next change']"));
  assert.match(root.textContent ?? "", /Change 2 of 4/);
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
  const ui = createMockUi({ versions: 30 });
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
  const ui = createMockUi({ versions: 30 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  const list = $(m.container, "[role=listbox]")!;
  await key(list, "ArrowDown"); // the newest: still waiting to sync
  await key(list, "Enter");
  assert.equal(ui.preview(), null, "nothing to preview yet");
  await key(list, "ContextMenu");
  const menu = $(m.container, "[role=menu]");
  assert.ok(menu, "actions menu open");
  assert.equal(byText(menu!, "[role=menuitem]", "Restore")?.getAttribute("aria-disabled"), "true");
  assert.equal(document.activeElement?.closest("[role=menu]"), menu, "focus moved into the menu");
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
