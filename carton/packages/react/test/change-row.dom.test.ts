// The change row and the change map (docs/carton-ux DESIGN §5.1, §5.2), shared by History's version card (Workstream
// 3), the Changes view (4) and the Fold dialog (6). `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, cleanup, click, closeDom, render, renders, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, ChangeList, ChangeMap, ChangeRow, mapLength, moveMapPlayhead, setChangeProgress, type Change } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

const trim: Change = { key: "timelineItems/intro", text: "Trimmed “Intro”, now ends at 0:05", kind: "change", clip: "video", itemId: "intro", at: 2, end: 5, author: people.terminal, when: Date.now() };
const added: Change = { key: "timelineItems/jane", text: "Added lower third “Jane Smith, Founder”", kind: "add", clip: "title", at: 12, end: 17, author: people.alice, when: Date.now() };
const removed: Change = { key: "timelineItems/broll", text: "Removed “B-roll 3”", kind: "remove", clip: "video", at: 22, end: 26 };
const rate: Change = { key: "frameRate", text: "Changed the frame rate to 30 fps", kind: "change", clip: "project" };

test(name("a change row: where, what kind of clip and what happened, who only when asked, ▶ plays and a click seeks"), async () => {
  const ui = createMockUi({ versions: 4 });
  const played: string[] = [], sought: string[] = [], hovered: (string | null)[] = [];
  const m = await render(
    wrap(
      ui,
      h(ChangeList, { label: "Changes" },
        h(ChangeRow, { change: trim, onPlay: (c: Change) => played.push(c.key), onSelect: (c: Change) => sought.push(c.key), onHover: (k: string | null) => hovered.push(k) }),
        h(ChangeRow, { change: added, showAuthor: true }),
        h(ChangeRow, { change: rate }),
      ),
    ),
  );
  const [a, b, c] = $$(m.container, ".carton-change");
  assert.equal($(a!, ".carton-change-time")!.textContent, "0:02");
  assert.equal($(c!, ".carton-change-time")!.textContent, "—", "a change with no place on the timeline");
  // the chip: the kind of clip (its colour, by data-clip) and what happened, in words for a screen reader
  assert.equal($(a!, ".carton-change-chip")!.getAttribute("aria-label"), "Video, changed");
  assert.equal($(b!, ".carton-change-chip")!.getAttribute("aria-label"), "Title, added");
  assert.equal($(b!, ".carton-change-badge")!.textContent, "+");
  assert.equal($(a!, ".carton-change-words")!.textContent, "Trimmed “Intro”, now ends at 0:05");
  assert.equal($(a!, ".carton-change-who"), null, "no who unless the list mixes authors");
  assert.match($(b!, ".carton-change-who")!.textContent ?? "", /^You · \d{1,2}:\d{2} [ap]m$/);
  // ▶ only where a row can play; it plays and only plays (the row's click seeks)
  assert.equal($(b!, ".carton-change-play"), null);
  assert.equal($(a!, ".carton-change-play")!.getAttribute("aria-label"), "Play this change");
  await click($(a!, ".carton-change-play"));
  assert.deepEqual([played, sought], [["timelineItems/intro"], []]);
  await click(a!);
  assert.deepEqual(sought, ["timelineItems/intro"]);
  // Enter on a row plays it
  a!.focus();
  await act(() => void a!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(played, ["timelineItems/intro", "timelineItems/intro"]);
  a!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await m.unmount();
});

test(name("a change list: ↓ and ↑ move between rows, and its keys are its own (data-own-keys)"), async () => {
  const ui = createMockUi({ versions: 4 });
  const m = await render(wrap(ui, h(ChangeList, { label: "Changes" }, ...[trim, added, removed].map((c) => h(ChangeRow, { key: c.key, change: c })))));
  const list = $(m.container, "[role=list]")!;
  assert.equal(list.getAttribute("aria-label"), "Changes");
  assert.ok(list.hasAttribute("data-own-keys"));
  const rows = $$(list, ".carton-change");
  rows[0]!.focus();
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  await act(() => void rows[0]!.dispatchEvent(down));
  assert.equal(document.activeElement, rows[1]);
  assert.equal(down.defaultPrevented, true);
  await act(() => void rows[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rows[2]);
  // ↑ from the first row leaves the key to whatever holds the list
  rows[0]!.focus();
  const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
  await act(() => void rows[0]!.dispatchEvent(up));
  assert.equal(up.defaultPrevented, false);
  await m.unmount();
});

test(name("the playing row: lit, ⏸ in place of ▶, and a progress line the player moves without a render"), async () => {
  const ui = createMockUi({ versions: 4 });
  let paused = 0;
  const m = await render(wrap(ui, h("div", null, h(ChangeRow, { change: trim, playing: true, onPlay: () => {}, onPause: () => paused++ }))));
  const row = $(m.container, ".carton-change")!;
  assert.equal(row.dataset.playing, "");
  assert.equal(row.getAttribute("aria-current"), "true");
  assert.equal($(row, ".carton-change-play")!.getAttribute("aria-label"), "Pause");
  await click($(row, ".carton-change-play"));
  assert.equal(paused, 1);
  renders.clear();
  setChangeProgress(m.container.firstElementChild, 0.4, trim.key);
  assert.equal(($(row, ".carton-change-progress-fill") as HTMLElement).style.transform, "scaleX(0.4)");
  setChangeProgress(row, 7);
  assert.equal(($(row, ".carton-change-progress-fill") as HTMLElement).style.transform, "scaleX(1)", "clamped");
  assert.equal(renders.get("ChangeRow") ?? 0, 0, "no render for progress");
  await m.unmount();
});

test(name("a Fold row: a lead control, a tag and a muted sentence"), async () => {
  const ui = createMockUi({ versions: 4 });
  const m = await render(wrap(ui, h(ChangeRow, { change: removed, lead: h("input", { type: "checkbox", "aria-label": "Fold it in" }), tag: "Left out on Oct 30", muted: true })));
  const row = $(m.container, ".carton-change")!;
  assert.ok($(row, ".carton-change-lead input[type=checkbox]"));
  assert.equal($(row, ".carton-change-tag")!.textContent, "Left out on Oct 30");
  assert.equal(row.dataset.muted, "");
  assert.equal($(row, ".carton-change-badge")!.textContent, "−");
  await m.unmount();
});

test(name("the change map: a tick where each change is, coloured by what happened, the lit ones marked; a playhead moved outside React"), async () => {
  const ui = createMockUi({ versions: 4 });
  const changes = [trim, added, removed, rate];
  const m = await render(wrap(ui, h(ChangeMap, { changes, length: 40, lit: added.key })));
  const map = $(m.container, ".carton-map")!;
  assert.equal(map.getAttribute("aria-hidden"), "true", "the rows carry the same information");
  const ticks = $$(map, ".carton-map-tick");
  assert.equal(ticks.length, 3, "no tick for a change with no place");
  assert.deepEqual(ticks.map((t) => [t.dataset.kind, t.style.left]), [["change", "5%"], ["add", "30%"], ["remove", "55%"]]);
  assert.deepEqual(ticks.map((t) => t.dataset.lit !== undefined), [false, true, false]);
  const ph = $(map, ".carton-map-playhead")!;
  assert.equal(ph.hidden, true);
  moveMapPlayhead(map, 10);
  assert.equal(ph.hidden, false);
  assert.equal(ph.style.transform, "translateX(25%)");
  moveMapPlayhead(map, null);
  assert.equal(ph.hidden, true);
  await m.unmount();
});

test("the map's length: the furthest change's end, rounded up to 10 s (a 0:38 edit reads 0:40)", () => {
  assert.equal(mapLength([trim, added, { ...removed, end: 38 }]), 40);
  assert.equal(mapLength([rate]), 10);
  assert.equal(mapLength([]), 10);
});

test(name("thousands of changes draw at most one tick per kind per 1/240 of the bar"), async () => {
  const ui = createMockUi({ versions: 4 });
  const many: Change[] = Array.from({ length: 5000 }, (_, i) => ({ key: `k${i}`, text: `Change ${i}`, kind: i % 2 ? "add" : "change", clip: "video", at: (i / 5000) * 600 }));
  const m = await render(wrap(ui, h(ChangeMap, { changes: many, length: 600 })));
  const n = $$(m.container, ".carton-map-tick").length;
  assert.ok(n <= 2 * 241, `${n} ticks`);
  await m.unmount();
});
