// Regressions found by review round 9 (GPT 6.1 Sol), on the real engine, history and materializer.
import test from "node:test";
import assert from "node:assert/strict";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, render } from "./world.ts";

test("review 9 #1: an agent saving head's content into the frozen shared file doesn't make a later save map through a ripple twice [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)], tracks: ["V1", "T2"] });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  const r0 = await A.read(); // freeze
  // a remote ripple closes the 5 s gap; the freeze hides it from the shared file
  await w.remote((its) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 })));
  await w.tick(500);
  // agent A saves that same ripple into the frozen shared file: its content is head's
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "c" ? { ...i, startTime: 10, endTime: 20 } : i.id === "d" ? { ...i, startTime: 20, endTime: 30 } : i))));
  await w.tick(500);
  // agent B's view save regenerates the shared file (R7-01)
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "b's"));
  await w.tick(500);
  // agent A adds a clip right after d, from the regenerated shared file
  await A.read();
  await A.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where A put it: not mapped through the ripple again");
  await A.stop();
  await B.stop();
});
