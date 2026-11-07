// feat/history-arrival: someone else's row arriving while History is open wears their colour (HistoryPanel's
// ArrivalRing): a ring with a soft glow, settling after ARRIVAL_GLOW_MS into a faint edge that stays. On the mock's
// project (Alice is you; the Director, Claude Code and Codex are your agents; Bob, Priya and Bob's Director are
// teammates): rows there when History opens, yours and your agents' never wear it; a teammate's group or turn row wears
// it by its newest version; without motion it shows with no animation; a screen reader hears who. `npm test` runs it on
// React 19 and on preact/compat.
import { $, $$, React, act, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel, remoteUi, serveUi } from "../src/index.ts";
import { ARRIVAL_GLOW_MS } from "../src/components/HistoryPanel.ts";
import { createMockUi, people, type MockUi } from "../src/mock.ts";
import { actorColor } from "../src/actors.ts";
import { injectCardboardSkin } from "../src/skin/cardboard.ts";
import type { Actor, CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
injectCardboardSkin(document);

async function panel(ui: CartonUi) {
  const m = await render(h("div", { "data-carton-skin": "cardboard" }, h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 800 }))));
  await flush();
  return m;
}
const rows = (root: HTMLElement) => $$(root, ".carton-version");
const ringOf = (row: Element | undefined) => (row ? (row.querySelector(":scope > .carton-arrival") as HTMLElement | null) : null);
const rings = (root: HTMLElement) => $$(root, ".carton-arrival");
const said = (root: HTMLElement) => $(root, ".carton-arrival-news")?.textContent ?? "";
const colorOf = (ui: CartonUi, a: Actor) => actorColor(a, ui.actor.bind(ui));
async function arrive(ui: MockUi, author: Actor, summary: string) {
  let id = "";
  await act(() => void (id = ui.addVersion({ author, kind: "edit", summary }).id));
  await flush();
  return id;
}
/** A version, its History told inside act (no timers: for the tests on node:test's mock timers). */
const land = (ui: MockUi, v: Parameters<MockUi["addVersion"]>[0]) =>
  act(() => {
    ui.addVersion(v);
    ui.hub.notifyNow("history");
  });

test(name("rows there when History opens never wear a ring; a teammate's that arrives does, in their colour, glowing"), async () => {
  const ui = createMockUi({ versions: 40, seed: 5 });
  const m = await panel(ui);
  const there = ui.history().all!();
  assert.ok(there.some((x) => !x.author.isYou && x.author.kind !== "system"), "the project has teammates' versions");
  assert.equal(rings(m.container).length, 0, "none at open");
  await arrive(ui, people.bob, "Added title “Summer launch”");
  const top = rows(m.container)[0]!;
  assert.match(top.textContent ?? "", /Added title “Summer launch”/);
  assert.ok(top.hasAttribute("data-arrived"));
  const ring = ringOf(top)!;
  assert.ok(ring, "the teammate's row wears a ring");
  assert.ok(ring.hasAttribute("data-glow") && ring.hasAttribute("data-pop"), "fresh: glowing, fading in");
  assert.equal(ring.getAttribute("aria-hidden"), "true", "decoration: the row's words and the status line say it");
  assert.equal(ring.style.getPropertyValue("--carton-actor"), colorOf(ui, people.bob), "Bob's colour, as his avatar's");
  assert.equal(rings(m.container).length, 1);
  await m.unmount();
});

test(name("yours and your agents' (the Director, a subagent, Claude Code, Codex) never wear one; nor anything, working alone"), async () => {
  const ui = createMockUi({ versions: 20, seed: 9 });
  const m = await panel(ui);
  const before = said(m.container);
  for (const a of [people.alice, people.director, people.captions, people.terminal, people.codex]) await arrive(ui, a, `Trimmed “Intro” (${a.name})`);
  await act(() => void ui.addVersion({ author: people.alice, kind: "edit", summary: "Not sent", provisional: true }));
  await act(() => ui.confirmAll());
  await flush();
  assert.match(rows(m.container)[0]!.textContent ?? "", /Not sent|Trimmed/);
  assert.equal(rings(m.container).length, 0);
  assert.equal($$(m.container, ".carton-version[data-arrived]").length, 0);
  assert.equal(said(m.container), before, "nothing said");
  assert.equal($(m.container, ".carton-arrival-news"), null, "no live region of its own: working alone, the DOM is as it was");
  await m.unmount();
});

test(name("a teammate's agent wears its person's colour; the status line says who, once per person and quiet minute"), async () => {
  const ui = createMockUi({ versions: 20, seed: 11 });
  const m = await panel(ui);
  await arrive(ui, people.bobsDirector, "Added title “Meet the team”");
  const ring = ringOf(rows(m.container)[0]);
  assert.ok(ring);
  assert.equal(ring!.style.getPropertyValue("--carton-actor"), colorOf(ui, people.bob), "Bob's Director: Bob's colour");
  assert.equal(said(m.container), "Bob's Director made a change");
  // Priya next (a new person), then Priya again at once (no second word for her), then Bob's Director and Priya at once
  await arrive(ui, people.priya, "Moved “Outro” to 0:31");
  assert.equal(said(m.container), "Priya made a change");
  await arrive(ui, people.mia, "Trimmed “Outro”, now ends at 0:37");
  assert.equal(said(m.container), "Mia made a change");
  await arrive(ui, people.mia, "Trimmed “Outro”, now ends at 0:36");
  assert.equal(said(m.container), "Mia made a change", "Mia again within the minute: nothing new said");
  await act(() => {
    ui.addVersion({ author: people.leosDirector, kind: "edit", summary: "Added title “Leo”" });
    ui.addVersion({ author: people.leo, kind: "edit", summary: "Moved “Leo”" });
  });
  await flush();
  assert.equal(said(m.container), "Leo and Leo's Director made changes", "two at once, newest first");
  // rows: Leo's, Leo's Director's, Mia's two (one group row), Priya's, Bob's Director's: each outlined once
  assert.equal(rings(m.container).length, 5);
  await m.unmount();
});

test(name("the glow settles into a faint edge after ARRIVAL_GLOW_MS, and the edge stays; a row drawn again takes up where it is"), async () => {
  const ui = createMockUi({ versions: 20, seed: 13 });
  const m = await panel(ui);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    await land(ui, { author: people.priya, kind: "edit", summary: "Added title “Summer launch”" });
    const ring = () => ringOf(rows(m.container)[0]);
    assert.ok(ring()?.hasAttribute("data-glow") && ring()?.hasAttribute("data-pop"), "glowing, fading in as it arrives");
    // 2 s on, its row goes and comes back (Today folded and opened: the row is drawn anew), mid-glow: no second fade-in
    await act(() => mock.timers.tick(2000));
    const today = () => $$(m.container, ".carton-day")[0]!;
    await act(() => today().click());
    assert.equal(rings(m.container).length, 0, "folded away");
    await act(() => today().click());
    assert.ok(ring() && ring()!.hasAttribute("data-glow") && !ring()!.hasAttribute("data-pop"), "back: still glowing, no fade-in again");
    await act(() => mock.timers.tick(ARRIVAL_GLOW_MS - 2050));
    assert.ok(ring()?.hasAttribute("data-glow"), "still glowing just before");
    await act(() => mock.timers.tick(60));
    assert.ok(ring(), "the ring stays");
    assert.ok(!ring()!.hasAttribute("data-glow"), "settled: the faint edge, when it would have anyway");
    // a newer version above it (your own): its row isn't drawn anew, and its edge stays
    const was = ring();
    await land(ui, { author: people.alice, kind: "edit", summary: "Trimmed “Intro”" });
    assert.equal(ringOf(rows(m.container)[1]), was, "the same ring, the second row now");
    assert.ok(!was!.hasAttribute("data-glow"), "still settled");
    // drawn again from scratch (History closed and opened is another case: a new panel starts with nothing marked)
    await m.rerender(h("div", { "data-carton-skin": "cardboard" }, h(CartonProvider, { ui }, h(HistoryPanel, { key: "again", initialHeight: 800 }))));
    assert.equal(rings(m.container).length, 0, "History opened again: what is there was there");
  } finally {
    mock.timers.reset();
  }
  await m.unmount();
});

test(name("a teammate's edit joining their group row: the group's row wears it, glowing anew; their earlier edit's ring is that row's"), async () => {
  const ui = createMockUi({ versions: 20, seed: 17 });
  const m = await panel(ui);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    await land(ui, { author: people.bob, kind: "edit", summary: "Trimmed “Intro”, now ends at 0:05" });
    const first = ringOf(rows(m.container)[0])!;
    await act(() => mock.timers.tick(ARRIVAL_GLOW_MS + 10));
    assert.ok(!first.hasAttribute("data-glow"), "settled");
    // his next plain edit, a minute later: one group row ("Bob · 2 changes"), keyed by its oldest, shows his newest
    await act(() => mock.timers.tick(60_000));
    await land(ui, { author: people.bob, kind: "edit", summary: "Moved “B-roll 3” to 0:27" });
    const top = rows(m.container)[0]!;
    assert.ok(top.hasAttribute("data-group"), "a group row");
    assert.match(top.textContent ?? "", /Moved “B-roll 3”/);
    const ring = ringOf(top)!;
    assert.ok(ring.hasAttribute("data-glow"), "the group row glows for the edit that joined it");
    assert.notEqual(ring, first, "a new ring (keyed by when)");
    assert.equal(rings(m.container).length, 1, "one row, one ring");
  } finally {
    mock.timers.reset();
  }
  await m.unmount();
});

test(name("without motion (prefers-reduced-motion): the ring shows, with no fade-in and no settling animation"), async () => {
  // (happy-dom computes the skin's rules, its media queries by its device settings; `animation` and `transition` as
  // their shorthands)
  const settings = (window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }).happyDOM.settings;
  const ui = createMockUi({ versions: 10, seed: 19 });
  const m = await panel(ui);
  await arrive(ui, people.bob, "Added title “Summer launch”");
  const moving = getComputedStyle(ringOf(rows(m.container)[0])!);
  assert.match(moving.animation, /^carton-arrive /, "with motion: it fades in");
  assert.match(moving.transition, /^box-shadow 1\.4s/, "with motion: it settles slowly");
  await m.unmount();
  settings.device.prefersReducedMotion = "reduce";
  try {
    const ui2 = createMockUi({ versions: 10, seed: 19 });
    const m2 = await panel(ui2);
    await arrive(ui2, people.bob, "Added title “Summer launch”");
    const ring = ringOf(rows(m2.container)[0])!;
    assert.ok(ring && ring.hasAttribute("data-glow"), "the outline still shows");
    const cs = getComputedStyle(ring);
    assert.equal(cs.animation, "none");
    assert.equal(cs.transition, "none");
    assert.match(cs.boxShadow, /^inset 0 0 0 1\.5px #[0-9a-f]{6},inset 0 0 14px/, "drawn as its ring and glow, still");
    assert.equal(cs.position, "absolute");
    await m2.unmount();
  } finally {
    settings.device.prefersReducedMotion = "no-preference";
  }
});

test(name("through the bridge (serveUi → remoteUi, as Cardboard's renderer reads History): the first History is no arrival, a teammate's next is"), async () => {
  // the panel mounts first (History still loading, as when Cardboard opens it), then the worker's whole History arrives
  const served = createMockUi({ versions: 30, seed: 23 });
  const out: unknown[] = [], inbox: unknown[] = [];
  const client = remoteUi((msg) => out.push(msg));
  const server = serveUi(served, (msg) => inbox.push(msg));
  const deliver = () => act(() => {
    for (const msg of out.splice(0)) server.receive(msg as never);
    for (const msg of inbox.splice(0)) client.receive(msg as never);
  });
  const m = await panel(client.ui);
  assert.ok($(m.container, ".carton-history-skeleton"), "loading");
  await deliver();
  await flush();
  assert.ok(rows(m.container).length > 3, "History, at once");
  assert.equal(rings(m.container).length, 0, "the init's versions were there");
  await act(() => void served.addVersion({ author: people.bob, kind: "edit", summary: "Added title “Summer launch”" }));
  await deliver();
  await flush();
  assert.ok(ringOf(rows(m.container)[0]), "Bob's, through the bridge");
  await act(() => void served.addVersion({ author: people.director, kind: "edit", summary: "Moved “Intro”" }));
  await deliver();
  await flush();
  assert.match(rows(m.container)[0]!.textContent ?? "", /Moved “Intro”/);
  assert.equal(ringOf(rows(m.container)[0]), null, "your Director's, through the bridge: none");
  assert.equal(rings(m.container).length, 1);
  await m.unmount();
  server.close();
});
