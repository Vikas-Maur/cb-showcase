// Regressions found by review round 2 (GPT 6.1 Sol), on the real engine, history and materializer.
import test from "node:test";
import assert from "node:assert/strict";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, clips, find } from "./world.ts";

test("review 2 #1: during a freeze, a save after the agent's own ripple isn't mapped through that ripple again [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)], tracks: ["V1", "T2"] });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  await A.read(); // freeze
  // save 1: the agent closes the 5 s gap (a ripple, inferred at commit)
  await A.editUntilDone(TIMELINE_FILE, (its) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 })));
  await w.tick(500);
  // save 2, from the regenerated freeze file: a new clip right after d, in post-ripple time
  await A.read();
  await A.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(500);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where the agent put it");
  await A.stop();
});

test("review 2 #4: a save whose every edit carded (no change made) still has its cards stored [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(10, "clip") });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const r0 = await A.read(); // freeze; A's read shows clip9 as it was
  await w.remote((its) => void (find(its, "clip9").name = "remote edit"));
  await w.tick(200);
  await A.write(TIMELINE_FILE, `// a\n${r0.header}\n${JSON.stringify({ ...r0.doc, timelineItems: r0.items.map((i) => (i.id === "clip9" ? { ...i, name: "agent edit" } : i)) })}\n`);
  await w.tick(1000);
  assert.equal(find(await w.head(), "clip9").name, "remote edit");
  const stored = await w.carton.store.range("views", { prefix: ["cards"] });
  assert.ok(stored.length >= 1, "the cards are stored, under an id of their own");
  await A.stop();
});

test("review 2 #7: pin records are pruned per owner, even when owners take turns [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(2) });
  for (let k = 0; k < 64; k++) {
    await w.gui((its) => void (find(its, "c0").name = `v${k}`));
    await w.engine.pin({ owner: "shared-view-test", ttlMs: 5 });
    await w.engine.pin({ owner: "view:other", ttlMs: 5 });
    w.clock.t += 10; // every earlier record has expired
  }
  for (const owner of ["shared-view-test", "view:other"]) {
    const n = (await w.carton.store.range("views", { prefix: ["pinned", owner] })).length;
    assert.ok(n <= 1, `${owner}: ${n} records left`);
  }
});
