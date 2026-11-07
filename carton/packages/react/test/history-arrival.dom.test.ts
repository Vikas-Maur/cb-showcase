// feat/history-arrival: someone else's row arriving while History is open wears their colour (HistoryPanel's
// ArrivalRing): a ring with a soft glow, settling after ARRIVAL_GLOW_MS into a faint edge that stays. On the mock's
// project (Alice is you; the Director, Claude Code and Codex are your agents; Bob, Priya and Bob's Director are
// teammates): rows there when History opens, yours and your agents' never wear it; a teammate's group or turn row wears
// it by its newest version; without motion it shows with no animation; a screen reader hears who. `npm test` runs it on
// React 19 and on preact/compat. Over the real engine (two replicas synced through the in-process host): Leo's rows
// are drawn as "Leo" and "Leo's Claude Code", in Leo's colour, from their first frame.
import { $, $$, React, act, cleanup, closeDom, flush, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel, remoteUi, serveUi } from "../src/index.ts";
import { ARRIVAL_GLOW_MS } from "../src/components/HistoryPanel.ts";
import { ARRIVAL_CALM_MS } from "../src/arrivals.ts";
import { createMockUi, people, type MockUi } from "../src/mock.ts";
import { actorColor } from "../src/actors.ts";
import { injectCardboardSkin } from "../src/skin/cardboard.ts";
import type { Actor, CartonUi } from "../src/model.ts";
import { clip, leoClaude, setOp, twoPeople } from "./two-people.fixture.ts";

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

test(name("with motion, a calm arrival fades in and settles softly; one in a burst (ARRIVAL_CALM_MS) shows and settles without motion"), async () => {
  const ui = createMockUi({ versions: 10, seed: 19 });
  const m = await panel(ui);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    await land(ui, { author: people.bob, kind: "edit", summary: "Added title “Summer launch”" });
    const calm = ringOf(rows(m.container)[0])!;
    assert.ok(calm.hasAttribute("data-calm"), "the first after a quiet moment");
    const cs = getComputedStyle(calm);
    assert.match(cs.animation, /^carton-arrive /, "it fades in");
    assert.match(cs.transition, /^box-shadow 1\.2s/, "and settles softly");
    // 0.5 s on, Bob's Director's: a burst
    await act(() => mock.timers.tick(500));
    await land(ui, { author: people.bobsDirector, kind: "edit", summary: "Moved “Summer launch” to 0:03" });
    const busy = ringOf(rows(m.container)[0])!;
    assert.ok(busy.hasAttribute("data-glow") && !busy.hasAttribute("data-calm"), "in a burst: glowing, still");
    const bs = getComputedStyle(busy);
    assert.ok(!/carton-arrive/.test(bs.animation), `no fade-in (${bs.animation})`);
    assert.ok(!/box-shadow/.test(bs.transition), `no settling animation (${bs.transition})`);
    assert.ok(calm.hasAttribute("data-calm"), "the first stays as it was");
    // a quiet moment later, Priya's: calm again
    await act(() => mock.timers.tick(ARRIVAL_CALM_MS + 100));
    await land(ui, { author: people.priya, kind: "edit", summary: "Trimmed “Outro”" });
    assert.ok(ringOf(rows(m.container)[0])!.hasAttribute("data-calm"));
  } finally {
    mock.timers.reset();
  }
  await m.unmount();
});

test(name("without motion (prefers-reduced-motion): the ring shows, with no fade-in and no settling animation"), async () => {
  // (happy-dom computes the skin's rules, its media queries by its device settings; `animation` and `transition` as
  // their shorthands)
  const settings = (window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }).happyDOM.settings;
  settings.device.prefersReducedMotion = "reduce";
  try {
    const ui = createMockUi({ versions: 10, seed: 19 });
    const m = await panel(ui);
    await arrive(ui, people.bob, "Added title “Summer launch”");
    const ring = ringOf(rows(m.container)[0])!;
    assert.ok(ring && ring.hasAttribute("data-glow") && ring.hasAttribute("data-calm"), "the outline still shows (a calm one)");
    const cs = getComputedStyle(ring);
    assert.equal(cs.animation, "none", "no fade-in");
    assert.equal(cs.transition, "none", "no settling animation");
    assert.equal(cs.position, "absolute");
    assert.match(cs.boxShadow, /^inset 0 0 0 1\.5px #[0-9a-f]{6},inset 0 0 14px/, "its ring and glow, drawn");
    await m.unmount();
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

test(name("over the engine: a teammate's arriving row is drawn as Leo's, in Leo's colour, from its first frame; never \"Teammate\" or a bare \"Claude Code\""), { timeout: 30_000 }, async () => {
  const { leo, ui, close } = await twoPeople();
  try {
    const m = await panel(ui);
    const leoColor = actorColor({ key: "human/leo", kind: "human", name: "Leo Park" });
    // every DOM state committed while Leo's versions arrive: each row wearing a ring, as it reads then
    const drawn: string[] = [];
    const look = () => {
      for (const r of rows(m.container)) {
        const ring = ringOf(r);
        if (!ring) continue;
        // (the name as shown: a teammate's whole name is its hover text)
        const who = (r.querySelector(".carton-version-meta .carton-actor-name .carton-more-short") ?? r.querySelector(".carton-version-meta .carton-actor-name"))?.textContent ?? "";
        drawn.push(`${who} ${ring.style.getPropertyValue("--carton-actor")}`);
      }
    };
    const mo = new MutationObserver(look);
    mo.observe(m.container, { subtree: true, childList: true, attributes: true, characterData: true });
    await act(async () => void (await leo.commit({ ops: [setOp("b", "endTime", 4.5), setOp("b", "trimEnd", 2)], wait: 5000 })));
    await act(async () => void (await leo.commit({ ops: [{ op: "insert", path: ["items", "t"], value: clip("t", 1, { type: "text", name: "Summer launch" }) }], author: leoClaude, wait: 5000 })));
    await waitFor(() => rings(m.container).length === 2, "both of Leo's rows outlined");
    await flush();
    look();
    mo.disconnect();
    const seen = [...new Set(drawn)];
    assert.deepEqual(seen.filter((x) => x !== `Leo ${leoColor}` && x !== `Leo's Claude Code ${leoColor}`), [], `only Leo's names and colour, ever (${seen.join(" | ")})`);
    assert.ok(seen.includes(`Leo ${leoColor}`) && seen.includes(`Leo's Claude Code ${leoColor}`));
    await m.unmount();
  } finally {
    await close();
  }
});
