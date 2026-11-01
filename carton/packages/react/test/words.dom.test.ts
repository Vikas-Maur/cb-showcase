// ui-words, in a DOM (React, then preact/compat): a card between two of your own edits tells them apart (never two
// identical buttons); a History row's author has no tooltip that only repeats its name (Windows draws it over the row
// below); a subagent's tooltip says its type; a system row names no one.
import { $, $$, React, byText, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, ConflictList, HistoryPanel } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { Actor, CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

test(name("a card between two of your own edits: 'Your earlier edit' and 'Your later edit', Keep earlier / Keep later"), async () => {
  const ui = createMockUi({ versions: 5 });
  const at = new Date(2026, 10, 1, 10, 4).getTime();
  ui.setConflicts([
    {
      id: "items/c1/#time",
      title: "'Dragon-take2.mp4' timing",
      // core's convention as fromCarton gives it: head (shown now) is your earlier save, `mine` your later one
      mine: { author: people.alice, summary: "Moved 1.5 s → 4.0 s" },
      theirs: { author: people.alice, summary: "Moved 1.5 s → 3.0 s", at },
      canKeepBoth: false,
      provisional: "theirs",
    },
  ]);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const card = $(m.container, ".carton-conflict")!;
  const names = $$(card, ".carton-conflict-who .carton-actor-name").map((e) => e.textContent);
  assert.equal(names.length, 2);
  assert.match(names[1]!, /^Your earlier edit \(\d\d?[:.]\d\d/);
  assert.equal(names[0], "Your later edit");
  const buttons = $$(card, "button").map((b) => b.textContent);
  assert.deepEqual(buttons, ["Keep later", "Keep earlier"]);
  assert.notEqual(buttons[0], buttons[1], "never two identical buttons");
  await m.unmount();
});

test(name("a teammate's two edits read as theirs, earlier and later; two different people keep their names"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([
    { id: "a", title: "'Intro' opacity", mine: { author: people.bob, summary: "0.9", at: 2000 }, theirs: { author: people.bob, summary: "0.5", at: 1000 }, canKeepBoth: false, provisional: "theirs" },
    { id: "b", title: "'Outro' opacity", mine: { author: people.alice, summary: "0.9" }, theirs: { author: people.bob, summary: "0.5" }, canKeepBoth: false, provisional: "theirs" },
  ]);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const [a, b] = $$(m.container, ".carton-conflict");
  assert.ok(byText(a!, "button", "Keep earlier") && byText(a!, "button", "Keep later"));
  assert.match(a!.textContent ?? "", /Bob Okafor's later edit/);
  assert.ok(byText(b!, "button", "Keep yours") && byText(b!, "button", "Keep Bob Okafor's"));
  await m.unmount();
});

test(name("History rows: no tooltip that repeats the author; a subagent's says its type; a system row names no one"), async () => {
  const ui = createMockUi({ versions: 3 });
  const system: Actor = { key: "system/carton", kind: "system", name: "" };
  ui.addVersion({ author: system, summary: "Started the cut" });
  ui.addVersion({ author: people.explore, summary: "Trimmed 'Intro' end 6.0 s → 5.0 s" });
  ui.addVersion({ author: people.alice, summary: "Moved 'Intro' 1.5 s → 3.0 s" });
  const m = await render(wrap(ui, h("div", { style: { height: 600 } }, h(HistoryPanel, { initialHeight: 600 }))));
  await flush();
  const row = (text: string) => $$(m.container, ".carton-version").find((r) => r.textContent?.includes(text))!;
  // You: the name, no title; the avatar beside it has no tooltip and is hidden from screen readers
  const you = row("Moved 'Intro'");
  assert.equal($(you, ".carton-actor-name")!.textContent, "You");
  assert.equal($(you, ".carton-actor-name")!.getAttribute("title"), null);
  assert.equal($(you, ".carton-avatar")!.getAttribute("data-carton-tip"), null);
  assert.equal($(you, ".carton-avatar")!.getAttribute("aria-hidden"), "true");
  // a subagent: its agent in the slot, its type in the tooltip
  const sub = row("Trimmed 'Intro'");
  assert.equal($(sub, ".carton-actor-name .carton-more-short")!.textContent, "Director");
  // its type shows in place on hover (laptop report: no tooltip over the next row)
  assert.equal($(sub, ".carton-actor-name")!.getAttribute("title"), null);
  assert.equal($(sub, ".carton-actor-name .carton-more-long")!.textContent, "Director › Explore");
  // the cut's start: no avatar, no name
  const start = row("Started the cut");
  assert.equal($(start, ".carton-avatar"), null);
  assert.equal($(start, ".carton-actor-name"), null);
  await m.unmount();
});

test(name("the floating stack: newest on top with the rest peeking, collapses to a pill, a card set aside stays open and listed"), async () => {
  const { ConflictStack } = await import("../src/index.ts");
  const ui = createMockUi({ versions: 5 });
  const card = (id: string, title: string) => ({ id, title, mine: { author: people.alice, summary: "0.9" }, theirs: { author: people.director, summary: "0.5" }, canKeepBoth: false, provisional: "theirs" as const, item: "item-" + id });
  ui.setConflicts([card("c3", "'Outro' opacity"), card("c2", "'Logo' timing"), card("c1", "'Intro' text")]);
  const seen: string[] = [];
  const m = await render(wrap(ui, h(ConflictStack, { onPreview: (c: { id: string }, side: string, label: string) => seen.push(`preview ${c.id} ${side} ${label}`), onReveal: (c: { id: string }) => seen.push(`reveal ${c.id}`) })));
  await flush();
  const top = () => $(m.container, ".carton-stack-cards .carton-conflict")!;
  assert.match(top().textContent ?? "", /'Outro' opacity/, "the newest on top");
  assert.equal($$(m.container, ".carton-stack-peek").length, 2, "the two behind peek out");
  // See it: Preview the side not showing (yours), Show on timeline
  (byText(top(), "button", "Preview") as HTMLElement).click();
  (byText(top(), "button", "Show on timeline") as HTMLElement).click();
  await flush();
  assert.deepEqual(seen, ["preview c3 mine Your edit", "reveal c3"]);
  // Not now: set aside, the next comes up; it is listed under "Set aside", never resolved
  ($(top(), "[aria-label='Not now']") as HTMLElement).click();
  await flush();
  assert.match(top().textContent ?? "", /'Logo' timing/);
  assert.equal(ui.conflicts().length, 3, "setting aside decides nothing");
  (byText(m.container, "button", "Set aside (1)") as HTMLElement).click();
  await flush();
  assert.match($(m.container, ".carton-stack-aside")!.textContent ?? "", /'Outro' opacity/);
  // collapse to the pill, and back
  ($(m.container, "[aria-label='Hide conflicts']") as HTMLElement).click();
  await flush();
  assert.equal($(m.container, ".carton-stack-pill")!.textContent, "3 conflicts");
  assert.equal($(m.container, ".carton-stack-cards"), null);
  ($(m.container, ".carton-stack-pill") as HTMLElement).click();
  await flush();
  assert.ok($(m.container, ".carton-stack-cards .carton-conflict"));
  await m.unmount();
});
