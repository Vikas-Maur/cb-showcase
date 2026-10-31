// Regressions found by review round 13 (GPT 6.1 Sol), on the real engine, history and materializer: a save during a
// freeze that made an edit the freeze hides (the same edit as a hidden remote change) restarts the freeze from head
// with head's causal past; merged into the old view it would sit there without its change's id, and core would map
// later saves through it again (review 9 #1, for any such save, not only one equal to head).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { cardboardAdapter } from "@carton/cardboard";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, render, parseFile, BOB, type Item } from "./world.ts";

const ITEMS = () => [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)];
/** The remote ripple the freeze hides: the 5 s gap before c closes. */
const ripple = (its: Item[]) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 }));
const rippled = (i: Item): Item => (i.id === "c" ? { ...i, startTime: 10, endTime: 20 } : i.id === "d" ? { ...i, startTime: 20, endTime: 30 } : i);

/** After A's save, B's view save regenerates the shared file and A adds h right after d: h must stay at 30. */
async function insertAfter(w: Awaited<ReturnType<typeof openWorld>>, A: ReturnType<Awaited<ReturnType<typeof openWorld>>["agent"]>, B: ReturnType<Awaited<ReturnType<typeof openWorld>>["agent"]>, vb: string) {
  await B.editUntilDone(vb, (its) => void (find(its, "a").opacity = 0.5));
  await w.tick(500);
  await A.read();
  await A.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where A put it: not mapped through the ripple again");
}

test("review 13 #1: a head-equal save committed after the cut switched away and back during its pins doesn't make a later save map through a ripple twice [real engine]", async (t) => {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const main = w.carton.cut;
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  const r0 = await A.read(); // freeze
  await w.remote(ripple); // hidden by the freeze
  await w.tick(500);
  // after each pin of the shared file's head, another process switches: to B, C, D, then back to main; the last pin
  // is D's, so the save isn't taken as unchanged and is committed (empty) on main
  const realPin = w.engine.pin.bind(w.engine);
  let armed = false;
  let n = 0;
  w.engine.pin = async (o) => {
    const p = await realPin(o);
    if (armed && o.owner === "shared-file" && n < 4) {
      n++;
      if (n < 4) {
        await other.switchTo((await other.fork(`Cut ${n}`)).id);
        await w.carton.head(); // this handle's store refresh finds the new cut
      } else {
        await other.switchTo(main);
        await w.carton.switchTo(main); // local's follower switches the handle back
      }
    }
    return p;
  };
  armed = true;
  await A.write(TIMELINE_FILE, render(r0, r0.items.map(rippled))); // A saves that same ripple
  await w.tick(500);
  w.engine.pin = realPin;
  assert.equal(n, 4);
  assert.equal(w.carton.cut, main);
  await insertAfter(w, A, B, vb);
  assert.deepEqual(w.mz.log.errors, []);
  await A.stop();
  await B.stop();
});

test("review 13 #1: an agent saving a hidden ripple together with an edit of its own doesn't make a later save map through the ripple twice [real engine]", async (t) => {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  const r0 = await A.read(); // freeze
  await w.remote(ripple); // hidden by the freeze
  await w.tick(500);
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "a" ? { ...i, name: "A's" } : rippled(i)))));
  await w.tick(500);
  assert.equal(find(await w.head(), "a").name, "A's");
  await insertAfter(w, A, B, vb);
  assert.deepEqual(w.mz.log.errors, []);
  await A.stop();
  await B.stop();
});

test("review 13 #1: an agent's save with no edit the freeze hides keeps the hidden change hidden (R8-01) [real engine]", async (t) => {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const r0 = await A.read(); // freeze
  await w.remote(ripple); // hidden by the freeze
  await w.tick(500);
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "a" ? { ...i, name: "A's" } : i))));
  await w.tick(500);
  const shared = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
  assert.equal(find(shared, "a").name, "A's", "A's save is shown");
  assert.equal(find(shared, "c").startTime, 15, "the ripple stays hidden until the freeze ends");
  assert.deepEqual(w.mz.log.errors, []);
  await A.stop();
});
