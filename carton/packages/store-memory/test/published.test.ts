// A Published cut is read-only (PLAN §0.1, §14): what a watch link shows changes only by publishing again. On a local
// cut History refuses every write; a shared one's writes go through SharedCut, where only `commit` checked it (web-demo
// REQ-1, its review R1-6: `restore(…, {cut: published})` on a shared Published cut was queued and confirmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };

/** Every write a Published cut must refuse, aimed at `pub`; `main` has a newer edit to fold. */
async function refusesAll(c: Carton, pub: string, main: string): Promise<void> {
  const changeId = (await c.log({ cut: main, limit: 1 }))[0]!.change!;
  const writes: [string, () => Promise<unknown>][] = [
    ["commit", () => c.commit({ cut: pub, ops: [set("a", "name", "x")] })],
    ["restore", () => c.restore(`${main}@0`, { cut: pub })],
    ["undo", () => c.undo(undefined, { cut: pub, author: alice })],
    ["revert", () => c.revert(changeId, { cut: pub })],
    ["fold", () => c.fold(main, { into: pub })],
    ["fold-some", () => c.foldSome(main, { into: pub, reject: [] })],
  ];
  for (const [what, write] of writes) await assert.rejects(write(), /read-only/, what);
}

test("REQ-1: a shared Published cut refuses restore, undo, revert, fold and fold-some, not only commit; nothing is queued", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  try {
    const main = a.cut;
    await a.share();
    await until(async () => (await a.cuts()).find((c) => c.id === main)!.sequencer.kind === "server", 5000, "main shared");
    assert.equal((await a.commit({ ops: [set("a", "name", "one")], author: alice, wait: 5000 })).status, "confirmed");
    const pub = await a.publish({ name: "Published" });
    await a.share(pub.id);
    await until(async () => (await a.cuts()).find((c) => c.id === pub.id)!.sequencer.kind === "server", 5000, "published shared");
    const before = await a.log({ cut: pub.id });
    assert.equal((await a.commit({ ops: [set("b", "name", "two")], author: alice, wait: 5000 })).status, "confirmed");
    await refusesAll(a, pub.id, main);
    assert.deepEqual(await a.log({ cut: pub.id }), before, "the Published cut is as it was");
    assert.deepEqual(await a.store.range("pending", { prefix: [pub.id] }), [], "nothing waits to sync on it");
    // publishing again is how it changes
    const again = await a.publish({ name: "Published 2" });
    assert.equal((await a.publications()).find((p) => p.cut.id === again.id)!.newer, false);
  } finally {
    await a.close();
    w.host.close();
  }
});

test("REQ-1: a local Published cut refuses the same writes, even one that would change nothing (an undo with nothing to undo)", async () => {
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const main = a.cut;
  await a.commit({ ops: [set("a", "name", "one")], author: alice });
  const pub = await a.publish({ name: "Published" });
  await a.commit({ cut: main, ops: [set("b", "name", "two")], author: alice });
  await refusesAll(a, pub.id, main);
  await a.close();
});
