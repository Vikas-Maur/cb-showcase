// Regressions found by review round 4 (GPT 6.1 Sol), on the real engine, history and materializer.
import test from "node:test";
import assert from "node:assert/strict";
import { openWorld, clip, find } from "./world.ts";

test("review 4 #1: a save retried after its cards failed to store isn't committed twice; its change stays in the view's causal past [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)], tracks: ["V1", "T2"] });
  const agent = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: rel } = await w.mz.printView("v", agent.actor, { hooked: true });
  await agent.read(rel);
  await w.remote((its) => void (find(its, "a").name = "remote")); // the agent's rename of a will card
  await w.tick(100);
  const realPut = w.engine.putMeta.bind(w.engine);
  let fail = true;
  w.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "cards") {
      fail = false;
      throw new Error("database is locked");
    }
    return realPut(k, v);
  };
  // save 1: a ripple (close the 5 s gap) plus a rename that conflicts
  await agent.editUntilDone(rel, (its) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 }), (find(its, "a").name = "agent")));
  await w.tick(5000); // the first try fails storing the cards; the retry finishes the save
  assert.equal(fail, false);
  // save 2 (same print): a clip right after d, in post-ripple time
  await agent.editUntilDone(rel, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h isn't mapped through save 1's ripple again");
  assert.equal(find(head, "a").name, "remote", "the card kept head's value");
  assert.ok((await w.carton.store.range("views", { prefix: ["cards"] })).length >= 1);
});
