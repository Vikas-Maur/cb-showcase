// ui-words, in a DOM (React, then preact/compat): a History row's author has no tooltip that only repeats its name
// (Windows draws it over the row below); a subagent's tooltip says its type; a system row names no one. (A conflict
// card's words: conflicts.dom.test.ts.)
import { $, $$, React, byText, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { Actor, CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

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

