// UI audit P1-1 (2026-11-02): the Share tab crashed the whole editor tab as soon as a teammate was present. The Share
// panel handed the sync layer's peer entries (core's actor: `{kind, id, name}`, no `key`) to actorColor, which hashed
// `key`. These readers now take what the sync layer really sends, and one odd entry is never a crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor as CoreActor, type CartonEvent, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { actorColor, initials } from "../src/actors.ts";
import { groupPeers } from "../src/components/Presence.ts";
import { fromCarton } from "../src/from-carton.ts";
import type { Actor, Peer } from "../src/model.ts";

// What live.js `view()` puts in a peer entry's `actor` (scripts/carton/sync/live.js, "presence"): the person behind
// the sender's handle (`{kind: "human", ...who}`) or the handle's own actor. Never a `key`.
const fromWho = { kind: "human", id: "Leo", name: "Leo" };
const handleActor = { kind: "human", id: "person", group: "leo@desk", app: true };

test("actorColor colours an entry the way the sync layer sends it (no key) instead of throwing, and stably", () => {
  for (const a of [fromWho, handleActor, { kind: "agent", id: "claude-code", agentId: "a1" }, {}]) {
    const c = actorColor(a as unknown as Actor);
    assert.match(c, /^#[0-9a-f]{6}$/, JSON.stringify(a));
    assert.equal(actorColor(a as unknown as Actor), c, "the same colour every time");
  }
  // A UI actor keeps its colour (keyed as before).
  assert.equal(actorColor({ key: "human/Leo", kind: "human", name: "Leo" }), actorColor({ key: "human/Leo", kind: "human", name: "Someone else" }));
});

test("initials of a missing name is '?', never a crash", () => {
  assert.equal(initials(undefined as unknown as string), "?");
  assert.equal(initials("Leo Okafor"), "LO");
});

test("groupPeers sorts peers that have no name", () => {
  const p = (key: string, name?: string): Peer => ({ actor: { key, kind: "human", name } as unknown as Actor, cutId: "c", idle: false });
  assert.deepEqual(groupPeers([p("human/b", "Bo"), p("human/a"), p("human/c")]).map((g) => g.root.actor.key), ["human/a", "human/c", "human/b"]);
});

// fromCarton over the real engine, with presence played the way the sync client emits it.
const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [] });
const vikas: CoreActor = { kind: "human", id: "Vikas", name: "Vikas", group: "vikas@laptop" };

test("fromCarton names a present teammate by the person the sync layer sends (who), as the Share panel does", async () => {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: vikas });
  const taps: ((e: CartonEvent) => void)[] = [];
  const realOn = carton.on.bind(carton);
  (carton as { on: typeof carton.on }).on = (l) => {
    taps.push(l);
    return realOn(l);
  };
  const ui = fromCarton(carton, { me: vikas });
  await ui.ready;
  const emit = (e: CartonEvent) => taps.forEach((l) => l(e));
  const branchId = carton.cut;
  // The teammate's handle was opened before they shared or joined: its actor is "the person"; who says it's Leo.
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { activity: "Editing", who: { id: "Leo", name: "Leo" } } } as CartonEvent);
  assert.equal(ui.peers().length, 1);
  assert.equal(ui.peers()[0]!.actor.name, "Leo");
  assert.equal(ui.peers()[0]!.activity, "Editing");
  assert.equal(typeof ui.peers()[0]!.actor.key, "string");
  // Here but idle (the page says so after 30 s without input, instead of leaving: UI audit P2-11): still listed, idle.
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { activity: null, idle: true, who: { id: "Leo", name: "Leo" } } } as unknown as CartonEvent);
  assert.deepEqual([ui.peers().length, ui.peers()[0]!.idle, ui.peers()[0]!.actor.name], [1, true, "Leo"]);
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { activity: "Editing", who: { id: "Leo", name: "Leo" } } } as CartonEvent);
  assert.equal(ui.peers()[0]!.idle, false, "back to work");
  // A malformed who is no one: the handle's actor stays, and nothing throws.
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { activity: "Editing", who: { id: 42 } } } as unknown as CartonEvent);
  assert.equal(ui.peers().length, 1);
  assert.notEqual(ui.peers()[0]!.actor.name, undefined);
  // Ghosts are the teammate's own data: a malformed one is never drawn, and never a crash.
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { who: { id: "Leo", name: "Leo" }, ghosts: [null, { item: 1 }, { item: "a", track: "t1", start: 1, end: 2, label: { x: 1 } }, "drag"] } } as unknown as CartonEvent);
  assert.deepEqual(ui.ghosts().map((g) => [g.itemId, g.start, g.end, g.label]), [["a", 1, 2, undefined]]);
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: { who: { id: "Leo" }, ghosts: "not a list" } } as unknown as CartonEvent);
  assert.deepEqual(ui.ghosts(), []);
  emit({ type: "presence", branchId, actor: handleActor as CoreActor, state: null } as CartonEvent);
  assert.equal(ui.peers().length, 0);
  ui.dispose();
  await carton.close();
});
