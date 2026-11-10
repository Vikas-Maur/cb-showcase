// The cuts menu and Fold in of the UX redesign (docs/carton-ux PLAN 6.1–6.3), on the mock. `pnpm test` runs it on React
// 19, then on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, CutsMenu, FoldInDialog, HistoryPanel, TeammateCutActions, cancelQueuedSwitch, openCutsMenu, queuedSwitch, switchWhenDone } from "../src/index.ts";
import { createMockUi, people, type MockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const current = (ui: CartonUi) => ui.cuts().find((c) => c.current)!.id;
/** Count switchCut calls on the mock. */
const countSwitches = (ui: MockUi) => {
  const calls: string[] = [];
  const real = ui.switchCut.bind(ui);
  ui.switchCut = async (id) => (calls.push(id), real(id));
  return calls;
};

test(name("queued switch (PLAN 6.1): it runs once, when the turn ends"), async () => {
  const ui = createMockUi({ versions: 10 });
  const calls = countSwitches(ui);
  ui.setWorking("director");
  await switchWhenDone(ui, "cut-ig");
  assert.equal(queuedSwitch(ui)?.cutId, "cut-ig");
  assert.equal(current(ui), "cut-main", "nothing moves while the turn holds the timeline");
  // the turn goes on: its edits move the head and count its changes, which is no end
  ui.addVersion({ author: people.director });
  ui.addVersion({ author: people.director });
  assert.equal(current(ui), "cut-main");
  ui.setWorking(null);
  await flush();
  assert.deepEqual(calls, ["cut-ig"]);
  assert.equal(current(ui), "cut-ig");
  assert.equal(queuedSwitch(ui), null);
  // another turn later doesn't switch again
  ui.setWorking("director");
  ui.setWorking(null);
  await flush();
  assert.deepEqual(calls, ["cut-ig"], "once");
});

test(name("queued switch (PLAN 6.1): dropped when the person switches by hand first, or says Don't switch"), async () => {
  const ui = createMockUi({ versions: 10 });
  const calls = countSwitches(ui);
  ui.setWorking("director");
  await switchWhenDone(ui, "cut-ig");
  await ui.switchCut("cut-dir"); // by hand (or `cb cut switch`)
  assert.equal(queuedSwitch(ui), null, "the switch by hand wins");
  ui.setWorking(null);
  await flush();
  assert.deepEqual(calls, ["cut-dir"], "the queued one never runs");
  ui.setWorking("director");
  await switchWhenDone(ui, "cut-main");
  cancelQueuedSwitch(ui);
  ui.setWorking(null);
  await flush();
  assert.deepEqual(calls, ["cut-dir"]);
  // with no agent working it is a switch, now
  await switchWhenDone(ui, "cut-ig");
  assert.deepEqual(calls, ["cut-dir", "cut-ig"]);
});

test(name("cuts menu during a turn (PLAN 6.1): a cut opens in place; Switch when it finishes queues it and says so"), async () => {
  const ui = createMockUi({ versions: 10 });
  const calls = countSwitches(ui);
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await act(() => ui.setWorking({ actor: people.terminal, label: "Tighten the intro", edits: 1, since: Date.now(), cutId: "cut-main" }));
  await click($(m.container, ".carton-menu-trigger"));
  const item = (re: RegExp) => $$(m.container, "[role=menuitemradio]").find((e) => re.test(e.textContent ?? ""))!;
  assert.match(item(/^Main cut/).textContent ?? "", /Claude Code · working now/);
  await click(item(/^30s Instagram cut/));
  assert.deepEqual(calls, [], "no switch while Claude Code works");
  assert.equal(item(/^30s Instagram cut/).getAttribute("aria-expanded"), "true");
  assert.equal($(m.container, ".carton-cut-turn-text")!.textContent, "Claude Code is working on Main cut, and agents work on the cut you're on.");
  const choices = $$(m.container, ".carton-cut-turn [role=menuitem]");
  assert.deepEqual(choices.map((b) => b.textContent), ["Switch when it finishes", "Switch now"]);
  assert.equal(document.activeElement, choices[0], "focus on the default");
  await click(choices[0]);
  assert.equal($(m.container, "[role=menu]"), null, "the menu closes");
  assert.equal($(m.container, ".carton-cuts-queued-text")!.textContent, "Switches to “30s Instagram cut” when Claude Code finishes.");
  await act(() => ui.setWorking(null));
  await flush();
  assert.deepEqual(calls, ["cut-ig"]);
  assert.equal($(m.container, ".carton-cuts-queued"), null, "the line goes once it ran");
  assert.match($(m.container, ".carton-menu-trigger")!.textContent ?? "", /30s Instagram cut/);
  await m.unmount();
});

test(name("cuts menu during a turn: Switch now switches at once; the queued line's Don't switch drops it"), async () => {
  const ui = createMockUi({ versions: 10 });
  const calls = countSwitches(ui);
  const m = await render(wrap(ui, h(CutsMenu, {})));
  await act(() => ui.setWorking("director"));
  const open = async (re: RegExp) => {
    await click($(m.container, ".carton-menu-trigger"));
    await click($$(m.container, "[role=menuitemradio]").find((e) => re.test(e.textContent ?? "")));
  };
  await open(/^Director's cut/);
  await click(byText(m.container, "[role=menuitem]", "Switch when it finishes"));
  assert.ok($(m.container, ".carton-cuts-queued"));
  await click(byText(m.container, ".carton-cuts-queued button", "Don't switch"));
  assert.equal(queuedSwitch(ui), null);
  await act(() => ui.setWorking(null));
  await act(() => ui.setWorking("director"));
  assert.deepEqual(calls, []);
  await open(/^30s Instagram cut/);
  await click(byText(m.container, "[role=menuitem]", "Switch now"));
  await flush();
  assert.deepEqual(calls, ["cut-ig"]);
  await m.unmount();
});

test(name("openCutsMenu (PLAN 2.2 v1): the chip opens the mounted menu with focus in it, or the next one to mount"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(CutsMenu, {})));
  let opened = false;
  await act(async () => void (opened = await openCutsMenu(ui)));
  await flush();
  assert.equal(opened, true);
  assert.ok($(m.container, "[role=menu]"), "open");
  assert.ok($(m.container, "[role=menu]")!.contains(document.activeElement), "focus in the menu");
  assert.equal(document.activeElement?.getAttribute("role"), "menuitemradio", "on the first cut");
  await key(document.activeElement, "Escape");
  assert.equal($(m.container, "[role=menu]"), null);
  assert.equal(document.activeElement, $(m.container, ".carton-menu-trigger"), "Esc gives focus back to the cut button");
  await m.unmount();
  // History not open yet: the request waits for the menu that mounts next
  const later = openCutsMenu(ui, { within: 2000 });
  const m2 = await render(wrap(ui, h(CutsMenu, {})));
  await act(async () => void (opened = await later));
  await flush();
  assert.equal(opened, true);
  assert.ok($(m2.container, "[role=menu]"), "the menu that mounted opened itself");
  await m2.unmount();
  // nobody mounts one: false, after the wait
  assert.equal(await openCutsMenu(ui, { within: 20 }), false);
});

test(name("a teammate's cut (PLAN 6.2): View only in the menu, viewed with its way back; fold it in or copy it, no Restore"), async () => {
  const ui = createMockUi({ versions: 10 });
  const folds: string[] = [];
  const m = await render(wrap(ui, h("div", { className: "bar" }, h(CutsMenu, {})), h(TeammateCutActions, { onFoldIn: (f: { id: string }, i: { id: string }) => folds.push(`${f.id}>${i.id}`) })));
  assert.equal($(m.container, ".carton-teammate-cut"), null, "nothing on your own cut");
  await click($(m.container, ".carton-menu-trigger"));
  await click($$(m.container, "[role=menuitemradio]").find((e) => /^Bob's Main cut/.test(e.textContent ?? "")));
  await flush();
  assert.match($(m.container, ".carton-menu-trigger")!.textContent ?? "", /Bob's Main cut/);
  assert.ok($(m.container, ".carton-menu-trigger .carton-cut-dot"), "its dot (its owner's colour)");
  assert.match($(m.container, ".carton-cuts-viewing")!.textContent ?? "", /Viewing/);
  const actions = $$(m.container, ".carton-teammate-cut-actions button").map((b) => b.textContent);
  assert.deepEqual(actions, ["Fold into Main cut…", "New cut from it"]);
  assert.ok(!actions.some((t) => /Restore/.test(t ?? "")));
  await click(byText(m.container, "button", "Fold into Main cut…"));
  assert.deepEqual(folds, ["cut-bob-main>cut-main"]);
  // the menu's actions go to your own cut: no Rename of theirs
  await click($(m.container, ".carton-menu-trigger"));
  assert.equal($$(m.container, "[role=menuitem]").find((e) => /^Rename/.test(e.textContent ?? "")), undefined);
  await key(document.activeElement, "Escape");
  // ✕ goes back to the cut you came from
  await click($(m.container, ".carton-cuts-viewing button"));
  await flush();
  assert.equal(current(ui), "cut-main");
  assert.equal($(m.container, ".carton-cuts-viewing"), null);
  assert.equal($(m.container, ".carton-teammate-cut"), null);
  await m.unmount();
});

test(name("a teammate's cut (PLAN 6.2): its versions in History offer no Restore; your own cut's do"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, currentRef: ui.cuts()[0]!.head })));
  const menuItems = async () => {
    // an older version's menu (the newest is your edit itself: History offers no Restore of it, Workstream 3)
    await click($$(m.container, ".carton-version-more")[1]!);
    const items = $$(m.container, "[role=menuitem]").map((e) => e.textContent ?? "");
    await key(document.activeElement, "Escape");
    return items;
  };
  assert.ok((await menuItems()).some((t) => t.startsWith("Restore")), "your own cut: Restore");
  await act(() => ui.switchCut("cut-bob-main"));
  await flush();
  assert.ok(!(await menuItems()).some((t) => t.startsWith("Restore")), "Bob's cut: no Restore");
  await m.unmount();
});

test(name("a teammate's cut: New cut from it copies its newest version as a cut of yours"), async () => {
  const ui = createMockUi({ versions: 10 });
  const made: [string, string][] = [];
  const newCut = ui.newCut.bind(ui);
  ui.newCut = async (n, from) => (made.push([n, from]), newCut(n, from));
  await ui.switchCut("cut-bob-main");
  const m = await render(wrap(ui, h(TeammateCutActions, {})));
  await click(byText(m.container, "button", "New cut from it"));
  const input = $(m.container, "input.carton-input") as HTMLInputElement;
  assert.equal(document.activeElement, input);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(() => {
    setter.call(input, "Bob's take");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => ($(m.container, "form") as HTMLFormElement).requestSubmit());
  await flush();
  assert.deepEqual(made, [["Bob's take", "bobmain@88"]]);
  assert.equal(ui.cuts().find((c) => c.current)?.name, "Bob's take");
  await m.unmount();
});

test(name("fold dialog (PLAN 6.3): focus starts on the dialog; the pick is a radio group the arrows move"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} })));
  await flush();
  const dialog = $(m.container, "[role=dialog]")!;
  assert.equal(document.activeElement, dialog, "the dialog itself, as Cardboard's Export");
  const group = $(dialog, "[role=radiogroup]")!;
  assert.equal(group.getAttribute("aria-label"), "Both cuts moved “Interview B”. Pick one:");
  const radios = $$(group, "[role=radio]");
  assert.deepEqual(radios.map((r) => r.getAttribute("tabindex")), ["0", "-1"], "one tab stop before a pick");
  (radios[0] as HTMLElement).focus();
  await key(radios[0], "ArrowDown");
  assert.deepEqual($$(group, "[role=radio]").map((r) => r.getAttribute("aria-checked")), ["false", "true"], "the arrows pick");
  assert.equal(document.activeElement, $$(group, "[role=radio]")[1]);
  // a row's click toggles it, as its box does; the locked one doesn't
  const rows = () => $$(dialog, ".carton-fold-change");
  await click($(rows()[0]!, ".carton-change-text"));
  assert.equal(($(rows()[0]!, "input") as HTMLInputElement).checked, false);
  await click($(rows()[3]!, ".carton-change-text"));
  assert.ok($(rows()[3]!, ".carton-fold-lock") && !rows()[3]!.hasAttribute("data-left"), "the locked row stays in");
  // three rows taken, and the conflict picked the other cut's way: four changes come in, as History will count them
  assert.equal($$(dialog, ".carton-dialog-foot button").at(-1)!.textContent, "Fold in 4 changes");
  await m.unmount();
});
