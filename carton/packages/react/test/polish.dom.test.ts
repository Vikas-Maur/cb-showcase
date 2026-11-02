// The UI audit of 2026-11-02 (docs/ui-audit/REPORT.md on audit/ui-2026-11-02), in a DOM: keyboard, Esc and focus in
// every layer, the words, and the states it found wrong. `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, WatchTheChanges } from "../src/index.ts";
import { timecode } from "../src/components/WatchTheChanges.ts";
import { createMockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

test(name("P1-7, P2-6, P3-13: Watch puts Before/After above the picture, counts changes, and never shows a made-up frame"), async () => {
  const ui = createMockUi({ versions: 10 });
  let closed = 0;
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9", inPlayer: true, onClose: () => closed++ })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  // Before / After has its own row above the picture, not at the end of the controls (where it ran out of the panel).
  const abRow = $(root, ".carton-watch-abrow")!;
  assert.ok(abRow.querySelector("[role=radiogroup]"), "the A/B toggle in its own row");
  assert.equal($(root, ".carton-watch-controls [role=radiogroup]"), null, "not in the controls row");
  assert.ok(abRow.compareDocumentPosition($(root, ".carton-watch-stage")!) & 4, "the toggle comes before the picture");
  // The summary and the counter speak of the same thing: changes.
  assert.match($(root, ".carton-watch-summary")!.textContent ?? "", /^4 changes · \d+\.\d s of \d+\.\d s$/);
  assert.match(root.textContent ?? "", /Change 1 of 4/);
  assert.doesNotMatch(root.textContent ?? "", /shots? \//);
  // No stand-in card: where the picture is, in words.
  assert.equal($(root, ".carton-stage-shot"), null);
  assert.match($(root, ".carton-stage-note")!.textContent ?? "", /Shown in the player, read-only/);
  // Cardboard's timecode: "0:00 / 0:12", in the text face.
  assert.match($(root, ".carton-watch-clock")!.textContent ?? "", /^\d+:\d\d \/ \d+:\d\d$/);
  // Focus came in, so Esc reaches it, and closes only this layer.
  assert.equal(document.activeElement, root);
  await key(root, "Escape");
  assert.equal(closed, 1);
  await m.unmount();
});

test(name("P2-6: a host with no player of its own says there is no picture, not that the player shows it"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9" })));
  await flush();
  assert.match($(m.container, ".carton-stage-note")!.textContent ?? "", /Preview not available here/);
  await m.unmount();
});

test(name("P2-1: the Before/After toggle is one tab stop and moves with the arrow keys, which don't also skip a change"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(WatchTheChanges, { a: "main@3", b: "main@9" })));
  await flush();
  const root = $(m.container, ".carton-watch")!;
  const [before, after] = $$(root, "[role=radio]");
  assert.equal(after!.getAttribute("aria-checked"), "true");
  assert.deepEqual([before!.tabIndex, after!.tabIndex], [-1, 0]);
  after!.focus();
  await key(after!, "ArrowLeft");
  assert.equal(before!.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, before);
  assert.match(root.textContent ?? "", /Change 1 of 4/, "the arrow moved the toggle, not the change");
  assert.equal(ui.preview()?.ref, "main@3");
  await m.unmount();
});

test("timecode reads as Cardboard's player does", () => {
  assert.equal(timecode(0, 6), "0:00 / 0:06");
  assert.equal(timecode(65.9, 125), "1:05 / 2:05");
  assert.equal(timecode(3725, 3725), "1:02:05 / 1:02:05");
});

void act;
void byText;
void click;
