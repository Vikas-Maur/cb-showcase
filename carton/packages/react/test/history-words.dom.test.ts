// History's card on the laptop (2026-11-05), rendered over the real engine: a code graphic's code change has its time
// and ▶, and Play all plays it; a version with nothing to play has Play all off, saying why, and no ▶; a turn named from
// Cardboard's composed prompt never shows it; a titled turn's card says what the person asked, in one quiet line.
// `npm test` runs it on React 19, then on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { CartonProvider, HistoryPanel, fromCarton } from "../src/index.ts";
import { adapter, alice, claude, codeEdit, doc0 } from "./history-words.fixture.ts";
import type { Clock, Transport } from "../src/player.ts";
import type { PlayHost } from "../src/components/Play.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
const at = (carton: Carton, seq: number) => ({ branchId: carton.cut, seq, pending: [] as never[] });

async function panel(setup: (carton: Carton) => Promise<void>, play?: PlayHost) {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  await setup(carton);
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  const m = await render(h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 800, ...(play ? { play } : {}) })));
  await flush();
  return { carton, ui, m };
}
const rowWith = (root: HTMLElement, text: string) => $$(root, ".carton-version").find((r) => r.textContent?.includes(text)) ?? null;
const card = (root: HTMLElement) => $(root, ".carton-card-version");
async function openCard(root: HTMLElement, text: string) {
  const row = rowWith(root, text);
  assert.ok(!!row, `a row with “${text}”: ${$$(root, ".carton-version").map((r) => r.textContent).join(" | ")}`);
  await click(row!);
  await waitFor(() => !!card(root) && $$(card(root)!, ".carton-change").length > 0, "the card's rows");
  return card(root)!;
}

test(name("a code graphic's code change: its time, its ▶, no code; Play all is on"), async () => {
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [codeEdit("a3 = 3", "a3 = 33")], author: claude });
    await c.name(at(c, 1), "Change the lines");
  });
  try {
    const el = await openCard(m.container, "Change the lines");
    const row = $(el, ".carton-change")!;
    assert.match(row.textContent ?? "", /Changed the code of code graphic “Cardboard on Windows” \(1 line\)/);
    assert.doesNotMatch(el.textContent ?? "", /export default|function Graphic/);
    assert.match(row.textContent ?? "", /0:04/, "the graphic's place, never “—”");
    assert.ok(!!$(row, ".carton-change-play"), "its ▶");
    const play = byText(el, "button", "Play all") as HTMLButtonElement;
    assert.equal(play.disabled, false);
  } finally { await m.unmount(); await carton.close(); }
});

test(name("nothing with a place to play (the frame rate alone): Play all off, saying why; no ▶ on the row"), async () => {
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [{ op: "set", path: ["frameRate"], value: 25 }] });
    await c.name(at(c, 1), "Frame rate");
  });
  try {
    const el = await openCard(m.container, "Frame rate");
    const row = $(el, ".carton-change")!;
    assert.match(row.textContent ?? "", /frame rate/i);
    assert.match(row.textContent ?? "", /—/, "no place in the edit");
    assert.ok(!$(row, ".carton-change-play"), "no ▶ that would play nothing");
    const play = byText(el, "button", "Play all") as HTMLButtonElement;
    assert.equal(play.disabled, true, "never a button that does nothing");
    assert.equal(play.getAttribute("data-carton-tip"), "Nothing to play: these changes aren't on the timeline");
    assert.equal(play.getAttribute("aria-description"), "Nothing to play: these changes aren't on the timeline");
  } finally { await m.unmount(); await carton.close(); }
});

test(name("a composed-prompt name never shows; a titled turn's card says what was asked"), async () => {
  const asked = "Okay in this edit, I have the fourth line too small, make it bigger please";
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [codeEdit("a1 = 1", "a1 = 11")], author: claude });
    await c.name(at(c, 1), "[Earlier messages in this conversation did…");
    await c.commit({ ops: [codeEdit("a4 = 4", "a4 = 44")], author: claude });
    await c.name(at(c, 2), "Bigger fourth line", { asked });
  });
  try {
    assert.doesNotMatch(m.container.textContent ?? "", /Earlier messages/, "the hidden name nowhere in History");
    const el = await openCard(m.container, "Bigger fourth line");
    const line = $(el, ".carton-card-asked");
    assert.ok(!!line, "the person's own words in the card");
    assert.equal(line!.textContent, `You asked: “${asked}”`);
    assert.equal(line!.getAttribute("title"), asked, "whole on hover when cut");
  } finally { await m.unmount(); await carton.close(); }
});

// Item 5 (laptop: "the audio doesn't play"): the card's Play all plays through the host's own playback (Cardboard's,
// with its sound): no seek per frame; Pause and closing the card stop it.
test(name("the card's Play all plays through the host's own playback, never a seek per frame; Pause and closing stop it"), async () => {
  let now = 0, next: ((t: number) => void) | null = null;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), 1), cancel: () => void (next = null) };
  const frames = async (n: number) => { for (let i = 0; i < n; i++) await act(() => { now += 100; if (playing) t += 0.1; const fn = next; next = null; fn?.(now); }); };
  const calls: string[] = [];
  let playing = false, t = 0;
  const transport: Transport = { play: (x) => (calls.push(`play ${x}`), (t = x), (playing = true)), pause: () => (calls.push("pause"), (playing = false)), playing: () => playing, time: () => t, length: () => 9 };
  const seeks: number[] = [];
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [codeEdit("a3 = 3", "a3 = 33")], author: claude });
    await c.name(at(c, 1), "Change the lines");
  }, { clock, transport, onFrame: (x) => seeks.push(x), length: () => 9 });
  try {
    const el = await openCard(m.container, "Change the lines");
    await click(byText(el, "button", "Play all"));
    await waitFor(() => calls.length > 0, "the host asked to play");
    assert.deepEqual(calls, ["play 3"], "from a second before the graphic, on Cardboard's own playback");
    await frames(10);
    assert.equal(seeks.length, 0, "no seek per frame: the host plays it");
    assert.ok(!!$(el, ".carton-change[data-playing]"), "its row lit");
    await click(byText(el, "button", "Pause"));
    assert.deepEqual(calls, ["play 3", "pause"]);
    await click(byText(el, "button", "Play all"));
    assert.equal(calls.at(-1), `play ${t}`, "goes on where it paused");
    await frames(2);
    // closing the card (Esc) while it plays: the host stops
    await key(el, "Escape");
    await flush();
    assert.equal(calls.at(-1), "pause", "the card closed: what Play started stops");
    assert.equal(playing, false);
  } finally { await m.unmount(); await carton.close(); }
});

// Review of a2725f9c #6: Before held during Play shows the older side, which may end sooner (Cardboard stops there).
// Play waits there, and once Before lets go the newer side plays on: the rest of the stretch is never skipped.
test(name("Before held on a shorter older side: Play waits at its end, then the newer side plays on from there"), async () => {
  let now = 0, next: ((t: number) => void) | null = null;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), 1), cancel: () => void (next = null) };
  const calls: string[] = [];
  let playing = false, t = 0, len = 9;
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++)
      await act(() => {
        now += 100;
        if (playing) { t += 0.1; if (t >= len - 1e-9) { t = len; playing = false; } }
        const fn = next as ((x: number) => void) | null;
        next = null;
        fn?.(now);
      });
  };
  const transport: Transport = { play: (x) => (calls.push(`play ${x}`), (t = x), (playing = true)), pause: () => (calls.push("pause"), (playing = false)), playing: () => playing, time: () => t, length: () => len };
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [codeEdit("a3 = 3", "a3 = 33")], author: claude });
    await c.name(at(c, 1), "Change the lines");
  }, { clock, transport, length: () => 9 });
  try {
    const el = await openCard(m.container, "Change the lines");
    await click(byText(el, "button", "Play all"));
    await waitFor(() => calls.length > 0, "the host asked to play");
    await frames(12); // 3 → 4.2
    const before = $(el, ".carton-before")!;
    assert.ok(!!before, "Before while it plays");
    await act(() => void before.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true, pointerId: 1 })));
    await flush();
    len = 5; // the older side: 5 s long, Cardboard stops at its end
    await frames(15);
    assert.equal(t, 5);
    assert.ok(!!byText(el, "button", "Pause"), "Play still on: not over at the older side's end");
    const real = Date.now;
    Date.now = () => real() + 600;
    len = 9;
    await act(() => void before.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 })));
    Date.now = real;
    await flush();
    await frames(4);
    assert.deepEqual(calls.slice(-1), ["play 5"], "Before let go: the newer side plays on from where it waited");
    await frames(60);
    assert.ok(!!byText(el, "button", "Play all"), "then to the stretch's end");
  } finally { await m.unmount(); await carton.close(); }
});
