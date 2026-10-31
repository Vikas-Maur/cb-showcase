// Carton's surface for shared cuts, against a real sequencer (the in-process host of @carton/server): the hand-off
// from a local cut, commits that go pending then confirmed, two replicas, absorbed edits, a fold into a shared cut,
// pending edits that survive a restart, sync status words and a draining disconnect. (The protocol itself is
// sync-sequencer's end-to-end suite.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CartonEvent } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };

test("share hands a local cut to the server; commits then go pending and come back confirmed", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await c.commit({ ops: [set("a", "name", "local edit")] });
  const shared = await c.share();
  assert.equal(shared.sequencer.kind, "handingOff");
  assert.ok(await c.sync!.connect({ nonce: "lease-1" }));
  await until(async () => (await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind === "server", 5000, "the hand-off");
  assert.deepEqual((await store.get<{ sequencer: unknown }>("cuts", [c.cut]))!.sequencer, { kind: "server", since: 1 }, "the store records it");
  const r = await c.commit({ ops: [set("b", "name", "shared edit")] });
  assert.equal(r.status, "pending");
  assert.equal(item((await c.head()).doc, "b")!.name, "shared edit", "the head shows the pending edit at once");
  const o = await c.sync!.waitFor(r.status === "pending" ? r.id : "", 5000);
  assert.equal(o.status, "confirmed");
  await until(async () => (await c.log()).length === 3, 5000, "the confirmed row in History");
  assert.equal((await c.log())[0]!.author?.id, "alice");
  assert.equal(c.sync!.state().label, "Up to date");
  // a wait on the commit itself
  const r2 = await c.commit({ ops: [set("c", "name", "waited")], wait: 5000 });
  assert.equal(r2.status, "confirmed");
  await c.close();
  w.host.close();
});

test("two replicas edit one shared cut; each sees the other's edits, an identical edit is absorbed", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  const events: CartonEvent[] = [];
  b.on((e) => events.push(e));
  const [ra, rb] = await Promise.all([a.commit({ ops: [set("a", "name", "from alice")], wait: 5000 }), b.commit({ ops: [set("b", "name", "from bob")], wait: 5000 })]);
  assert.equal(ra.status, "confirmed");
  assert.equal(rb.status, "confirmed");
  await until(async () => item((await a.head()).doc, "b")!.name === "from bob" && item((await b.head()).doc, "a")!.name === "from alice", 5000, "both edits on both");
  assert.ok(events.some((e) => e.type === "change" && !e.local), "remote changes arrive as change events");
  // bob, offline, makes the very edit alice makes: when he reconnects his change has nothing left to push
  await b.sync!.disconnect();
  const mine = await b.commit({ ops: [set("c", "name", "same")] });
  assert.equal(mine.status, "pending");
  await a.commit({ ops: [set("c", "name", "same")], wait: 5000 });
  await b.sync!.connect({ nonce: "bob-lease" });
  await until(() => events.some((e) => e.type === "absorbed" && mine.status === "pending" && e.id === mine.id), 5000, "the absorbed event");
  assert.equal(item((await b.head()).doc, "c")!.name, "same");
  assert.equal(b.sync!.state().pending, 0);
  await a.close();
  await b.close();
  w.host.close();
});

test("fold a local variant into a shared cut: one fold change, with its merge edge", async () => {
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = c.cut;
  await c.share();
  await until(async () => (await c.cuts()).find((x) => x.id === main)!.sequencer.kind === "server", 5000, "the hand-off");
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("d", "name", "variant edit")] });
  const dry = await c.fold(v.id, { into: main, check: true });
  assert.deepEqual(dry.preview?.ops, [{ op: "set", path: ["items", "d", "name"], value: "variant edit" }]);
  const f = await c.fold(v.id, { into: main });
  assert.equal(f.status, "pending");
  await until(async () => (await c.log({ cut: main })).length === 2, 5000, "the fold confirmed");
  const head = (await c.log({ cut: main }))[0]!;
  assert.equal(head.kind, "merge");
  assert.equal(item((await c.head(main)).doc, "d")!.name, "variant edit");
  assert.equal((await c.fold(v.id, { into: main })).status, "up-to-date", "the merge edge is recorded");
  await c.close();
  w.host.close();
});

test("an edit made offline is kept in the store and pushed after a restart; disconnect drains", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await c.share();
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await c.sync!.disconnect({ drain: true });
  assert.equal(c.sync!.status, "offline");
  const r = await c.commit({ ops: [set("e", "name", "offline")] });
  assert.equal(r.status, "pending");
  assert.equal(c.sync!.state().label, "Offline: 1 edit waiting");
  assert.equal((await store.range("pending")).length, 1, "the edit is in the store");
  await c.close();
  const again = await Carton.open({ adapter, store, actor: alice, sync: w.sync("alice") });
  await until(async () => (await again.log()).length === 2, 5000, "the offline edit confirmed after the restart");
  assert.equal(item((await again.head()).doc, "e")!.name, "offline");
  assert.equal((await store.range("pending")).length, 0, "and left the pending table");
  await again.close();
  w.host.close();
});

test("a commit on a shared cut reaches the host with no pump and no wait, also after a reconnect", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  // Carton has no pump(): the commit alone must get the change to the server and on to bob
  assert.equal((await a.commit({ ops: [set("a", "name", "no pump")] })).status, "pending");
  await until(async () => item((await b.head()).doc, "a")!.name === "no pump", 5000, "the change at bob");
  // offline, then reconnected: the queued change goes out on its own
  await a.sync!.disconnect();
  assert.equal((await a.commit({ ops: [set("b", "name", "after reconnect")] })).status, "pending");
  await a.sync!.connect({ nonce: "lease-2" });
  await until(async () => item((await b.head()).doc, "b")!.name === "after reconnect", 5000, "the queued change at bob");
  assert.equal(a.sync!.state().pending, 0);
  await a.close();
  await b.close();
  w.host.close();
});
