// History's card on the laptop's check of 44152b44 (2026-11-06), over the real engine:
// - B1: an edit of yours that joins the group whose Play all plays (or whose sound is still loading) left the card on
//   "Play all", no row lit, while the play went on with no control. The play belongs to its card: it carries on over the
//   changes it started with, with its Pause and lit row; Pause stops it, and Play all again goes on from there.
// - B2: Play all off with nothing to play (an aspect ratio alone) is drawn dimmed, and its tooltip was dimmed with it: the
//   next row's words showed through the tooltip's second line.
// `npm test` runs it on React 19, then on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { CartonProvider, HistoryPanel, fromCarton } from "../src/index.ts";
import { Button } from "../src/components/ui.ts";
import { injectCardboardSkin } from "../src/skin/cardboard.ts";
import { adapter, alice, claude, doc0 } from "./history-words.fixture.ts";
import type { Clock, Transport } from "../src/player.ts";
import type { PlayHost } from "../src/components/Play.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
const set = (id: string, field: string, value: unknown) => ({ op: "set" as const, path: ["items", id, field], value });

async function panel(setup: (carton: Carton) => Promise<void>, play?: PlayHost) {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  await setup(carton);
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  const m = await render(h("div", { "data-carton-skin": "cardboard" }, h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 800, ...(play ? { play } : {}) }))));
  await flush();
  return { carton, ui, m };
}
const card = (root: HTMLElement) => $(root, ".carton-card-version");
const newest = (root: HTMLElement) => $$(root, ".carton-version")[0]!;
async function openNewest(root: HTMLElement) {
  await click(newest(root));
  await waitFor(() => !!card(root) && $$(card(root)!, ".carton-change").length > 0, "the card's rows");
  return card(root)!;
}

/**
 * A stand-in for Cardboard's playback: play(t) loads the sound first while `slow` (loading() true, playing() false,
 * as its audio preload), and pause() calls off a start still loading. Frames on a test clock.
 */
function host(len = 9) {
  let now = 0, next: ((t: number) => void) | null = null;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), 1), cancel: () => void (next = null) };
  const s = { playing: false, loading: false, slow: false, t: 0, calls: [] as string[] };
  const transport: Transport = {
    play: (x) => {
      s.calls.push(`play ${x}`);
      s.t = x;
      if (s.slow) s.loading = true;
      else s.playing = true;
    },
    pause: () => {
      s.calls.push("pause");
      s.playing = false;
      s.loading = false;
    },
    playing: () => s.playing,
    loading: () => s.loading,
    time: () => s.t,
    length: () => len,
  };
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++)
      await act(() => {
        now += 100;
        if (s.playing) s.t = Math.min(len, s.t + 0.1);
        const fn = next;
        next = null;
        fn?.(now);
      });
  };
  /** The sound is in: a start still loading begins. */
  const loaded = () => {
    if (s.loading) (s.loading = false), (s.playing = true);
  };
  return { s, frames, loaded, play: { clock, transport, length: () => len } satisfies PlayHost };
}

// your two plain edits, one after the other: one group row, the newest ("You · 2 changes")
const twoEdits = async (c: Carton) => {
  await c.commit({ ops: [set("c1", "endTime", 3.5), set("c1", "trimEnd", 3.5)] });
  await c.commit({ ops: [set("g1", "endTime", 8.5), set("g1", "trimEnd", 4.5)] });
};
// one more, as the laptop's `cb source apply` from a terminal: it joins the group
const joins = (c: Carton) => act(async () => void (await c.commit({ ops: [set("g1", "startTime", 4.5)] })));

test(name("B1: an edit joins the group while its Play all plays: the card keeps Pause and its lit row; Pause stops it, Play all goes on"), async () => {
  const x = host();
  const { carton, m } = await panel(twoEdits, x.play);
  try {
    assert.match(newest(m.container).textContent ?? "", /2 changes/, "the newest row is the group");
    let el = await openNewest(m.container);
    await click(byText(el, "button", "Play all"));
    await waitFor(() => x.s.calls.length > 0, "the host asked to play");
    await x.frames(5);
    assert.ok(!!byText(el, "button", "Pause"));
    const calls = x.s.calls.length;
    await joins(carton);
    await waitFor(() => /3 changes/.test(newest(m.container).textContent ?? ""), "the edit joined the group");
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 3, "the card shows the new change");
    await x.frames(3);
    el = card(m.container)!;
    assert.equal(x.s.calls.length, calls, "the play goes on: nothing stopped or started it again");
    assert.ok(!!byText(el, "button", "Pause"), "the card still offers Pause for the play that goes on");
    assert.ok(!byText(el, "button", "Play all"));
    assert.equal($$(el, ".carton-change[data-playing]").length, 1, "its row still lit");
    assert.ok(!!$(el, ".carton-before"), "Before, with the play");
    // Space on the group's row pauses it, as before the edit
    const t = x.s.t;
    await key($(m.container, ".carton-history-list"), " ");
    await flush();
    assert.equal(x.s.calls.at(-1), "pause", "Space on the playing row: Pause");
    assert.equal(x.s.playing, false);
    assert.ok(!!byText(card(m.container)!, "button", "Play all"));
    // Play all again goes on from there, over the changes it started with
    await click(byText(card(m.container)!, "button", "Play all"));
    assert.equal(x.s.calls.at(-1), `play ${t}`, "goes on where it paused");
    await x.frames(2);
    await click(byText(card(m.container)!, "button", "Pause"));
    assert.equal(x.s.calls.at(-1), "pause", "the card's Pause stops it");
    assert.equal(x.s.playing, false);
  } finally { await m.unmount(); await carton.close(); }
});

test(name("B1: an edit joins the group while the sound for its start is still loading: Pause throughout, and it stops the start"), async () => {
  const x = host();
  x.s.slow = true;
  const { carton, m } = await panel(twoEdits, x.play);
  try {
    let el = await openNewest(m.container);
    await click(byText(el, "button", "Play all"));
    await waitFor(() => x.s.calls.length > 0, "the host asked to play");
    await x.frames(3);
    assert.equal(x.s.loading, true, "the sound is loading");
    await joins(carton);
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 3, "the card shows the new change");
    await x.frames(3);
    el = card(m.container)!;
    assert.ok(!!byText(el, "button", "Pause"), "Pause while its sound loads, after the edit joined");
    // the sound comes in: the play starts with its Pause and its row lit, never "orphaned"
    x.loaded();
    await x.frames(4);
    el = card(m.container)!;
    assert.equal(x.s.playing, true);
    assert.ok(!!byText(el, "button", "Pause"), "the play started with its Pause");
    assert.equal($$(el, ".carton-change[data-playing]").length, 1, "its row lit");
    await click(byText(el, "button", "Pause"));
    assert.equal(x.s.playing, false);
    // and a Pause while it still loads calls the start off: nothing starts afterwards
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(1);
    assert.equal(x.s.loading, true);
    await joins(carton);
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 4, "another change joined");
    await click(byText(card(m.container)!, "button", "Pause"));
    assert.equal(x.s.calls.at(-1), "pause");
    assert.equal(x.s.loading, false, "the start still loading is called off");
    x.loaded();
    await x.frames(4);
    assert.equal(x.s.playing, false, "nothing starts afterwards");
  } finally { await m.unmount(); await carton.close(); }
});

// The single-version check: a lone version's row can't change its version, but an edit that joins it makes it a group
// (its card follows the group). That play ends cleanly: the host stops (a start still loading too), Before goes, and
// nothing plays with no control.
for (const slow of [false, true])
  test(name(`B1 single version: an edit makes its row a group while it ${slow ? "loads its sound" : "plays"}: the play ends cleanly`), async () => {
    const x = host();
    x.s.slow = slow;
    const { carton, m } = await panel(async (c) => {
      await c.commit({ ops: [set("g1", "endTime", 8.5)], author: claude });
      await c.commit({ ops: [set("c1", "endTime", 3.5), set("c1", "trimEnd", 3.5)] });
    }, x.play);
    try {
      assert.match(newest(m.container).textContent ?? "", /1 change/, "the newest row is one version of yours");
      const el = await openNewest(m.container);
      await click(byText(el, "button", "Play all"));
      await waitFor(() => x.s.calls.length > 0, "the host asked to play");
      await x.frames(3);
      await joins(carton);
      await waitFor(() => /2 changes/.test(newest(m.container).textContent ?? ""), "the row is a group now");
      await waitFor(() => !!card(m.container) && $$(card(m.container)!, ".carton-change").length === 2, "its card follows the group");
      await x.frames(4);
      x.loaded();
      await x.frames(4);
      assert.equal(x.s.calls.at(-1), "pause", "the host stopped");
      assert.equal(x.s.playing, false, "nothing plays");
      assert.equal(x.s.loading, false, "no start left loading");
      assert.ok(!!byText(card(m.container)!, "button", "Play all"));
      assert.ok(!$(m.container, ".carton-before"), "Before went with it");
    } finally { await m.unmount(); await carton.close(); }
  });

// Review of 48fd9936 (P2): the play is its card's only while the card's row still holds every version it started with,
// from the same base, edits only joining at its newer end. A regroup that takes one out makes it another card: the play
// ends, and Play all plays what the card shows now.
// five plain edits of yours, one group: the graphic's three (4–9 s), then the clip's two (0–4 s)
const fiveEdits = async (c: Carton) => {
  await c.commit({ ops: [set("g1", "endTime", 8.5)] });
  await c.commit({ ops: [set("g1", "trimEnd", 4.5)] });
  await c.commit({ ops: [set("g1", "startTime", 4.5)] });
  await c.commit({ ops: [set("c1", "endTime", 3.5)] });
  await c.commit({ ops: [set("c1", "trimEnd", 3.5)] });
};
const mine = (ui: { history(): { all?(): readonly { id: string; start?: unknown }[] } }) => ui.history().all!().filter((v) => !v.start);

test(name("review P2: paused, then a version named in the middle splits the group: Play all plays what the card shows now"), async () => {
  const x = host();
  const { carton, ui, m } = await panel(fiveEdits, x.play);
  try {
    await openNewest(m.container);
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(5);
    await click(byText(card(m.container)!, "button", "Pause"));
    assert.ok(x.s.t < 3, "paused on the clip's changes (0–4 s)");
    const middle = mine(ui)[2]!;
    await act(async () => void (await ui.nameVersion(middle.id, "Checkpoint")));
    // the card keeps its row: the group's older part, the graphic's first two changes
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 2, "the card's group is its older part");
    await flush();
    assert.ok(!$(m.container, ".carton-before"), "the paused play went with the versions it played: no Before left");
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(2);
    assert.ok(x.s.t >= 3, `plays the card's own changes at their place (the graphic's, 4 s on), not the paused clip spot: ${x.s.t}`);
    assert.equal($$(card(m.container)!, ".carton-change[data-playing]").length, 1, "a row of the card lit");
    assert.ok(!!byText(card(m.container)!, "button", "Pause"));
  } finally { await m.unmount(); await carton.close(); }
});

test(name("review P2: the group's newest version named while it plays (taken out of the group): the play ends cleanly"), async () => {
  const x = host();
  const { carton, ui, m } = await panel(fiveEdits, x.play);
  try {
    await openNewest(m.container);
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(5);
    assert.equal(x.s.playing, true);
    const top = mine(ui).at(-1)!;
    await act(async () => void (await ui.nameVersion(top.id, "Checkpoint")));
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 4, "the card's group lost its newest");
    await x.frames(4);
    assert.equal(x.s.calls.at(-1), "pause", "Cardboard stopped");
    assert.equal(x.s.playing, false);
    assert.ok(!!byText(card(m.container)!, "button", "Play all"));
    assert.ok(!$(m.container, ".carton-before"), "Before went with it");
    const calls = x.s.calls.length;
    await x.frames(10);
    assert.equal(x.s.calls.length, calls, "nothing plays afterwards");
  } finally { await m.unmount(); await carton.close(); }
});

test(name("B1, paused: an edit joins the group, then Play all goes on where it paused (only added at its newer end)"), async () => {
  const x = host();
  const { carton, m } = await panel(twoEdits, x.play);
  try {
    await openNewest(m.container);
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(5);
    await click(byText(card(m.container)!, "button", "Pause"));
    const t = x.s.t;
    await joins(carton);
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 3, "the card shows the new change");
    await flush();
    assert.ok(!!$(m.container, ".carton-before"), "the paused play is still the card's");
    await click(byText(card(m.container)!, "button", "Play all"));
    assert.equal(x.s.calls.at(-1), `play ${t}`, "goes on where it paused");
    await x.frames(2);
    assert.ok(!!byText(card(m.container)!, "button", "Pause"));
    assert.equal($$(card(m.container)!, ".carton-change[data-playing]").length, 1);
  } finally { await m.unmount(); await carton.close(); }
});

// Carton's undo never takes a version out: it is a version of its own ("undo", never a plain edit, so never in a
// group), its own row on top. The group keeps every version, so its play carries on, with its Pause.
test(name("B1: an undo while the grown group plays is its own row; the group keeps its versions and the play its Pause"), async () => {
  const x = host();
  const { carton, m } = await panel(twoEdits, x.play);
  try {
    await openNewest(m.container);
    await click(byText(card(m.container)!, "button", "Play all"));
    await x.frames(3);
    await joins(carton);
    await waitFor(() => $$(card(m.container)!, ".carton-change").length === 3, "the card shows the new change");
    const calls = x.s.calls.length;
    await act(async () => void (await carton.undo()));
    await waitFor(() => !/3 changes/.test(newest(m.container).textContent ?? ""), "the undo's own row on top");
    await x.frames(3);
    assert.ok($$(m.container, ".carton-version").some((r) => /3 changes/.test(r.textContent ?? "")), "the group keeps its 3 versions");
    assert.equal($$(card(m.container)!, ".carton-change").length, 3);
    assert.equal(x.s.calls.length, calls, "the play goes on");
    assert.equal(x.s.playing, true);
    assert.ok(!!byText(card(m.container)!, "button", "Pause"));
    assert.equal($$(card(m.container)!, ".carton-change[data-playing]").length, 1);
    await click(byText(card(m.container)!, "button", "Pause"));
    assert.equal(x.s.playing, false, "and Pause stops it");
  } finally { await m.unmount(); await carton.close(); }
});

// B2: the tooltip is the button's own ::after, so a button dimmed as a whole (opacity) dims its tooltip too. One with a
// tooltip is dimmed by its parts; the rest look as they did.
test(name("B2: Play all off with nothing to play: its tooltip isn't dimmed with it (the row below never shows through)"), async () => {
  injectCardboardSkin(document);
  const { carton, m } = await panel(async (c) => {
    await c.commit({ ops: [set("c1", "endTime", 3.5)], author: claude });
    await c.commit({ ops: [{ op: "set", path: ["frameRate"], value: 25 }] });
  });
  try {
    const el = await openNewest(m.container);
    const play = byText(el, "button", "Play all") as HTMLButtonElement;
    assert.equal(play.disabled, true);
    assert.equal(play.getAttribute("data-carton-tip"), "Nothing to play: these changes aren't on the timeline");
    for (let e: HTMLElement | null = play; e && e !== m.container; e = e.parentElement)
      assert.equal(Number(getComputedStyle(e).opacity || 1), 1, `nothing dims the tooltip: ${e.tagName}.${e.className}`);
    for (const part of [$(play, ".carton-icon"), $(play, ".carton-btn-text")]) assert.equal(Number(getComputedStyle(part!).opacity), 0.5, "its icon and words dimmed, as before");
    // a disabled button with no tooltip is dimmed as a whole, as it was
    const plain = await render(h("div", { "data-carton-skin": "cardboard" }, h(Button, { disabled: true }, "Off"), h(Button, { disabled: true, title: "Why it's off", variant: "ghost" }, "Off too")));
    const [off, tipped] = $$(plain.container, "button");
    assert.equal(Number(getComputedStyle(off!).opacity), 0.5);
    assert.equal(Number(getComputedStyle(tipped!).opacity), 1, "any disabled button with a tooltip: drawn solid, its parts dimmed");
    assert.equal(Number(getComputedStyle($(tipped!, ".carton-btn-text")!).opacity), 0.5);
  } finally { await m.unmount(); await carton.close(); }
});
