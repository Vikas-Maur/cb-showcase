// Regressions found by review round 14 (GPT 6.1 Sol), on the real engine, history and materializer. A save that made
// the same edit as a change it never saw (an agent saving the ripple a remote made) holds that change: a state built on
// the save (the freeze view, a view's next base) names it in its causal past, or core maps later saves through it
// again. Which changes a save made is read from the log after its commit (a retry and a change landing just before it
// alike), and nothing else the freeze hides is revealed; a save that made only part of a hidden change restarts the
// freeze at its own commit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, render, parseFile, BOB, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
type Agent = ReturnType<World["agent"]>;
// y is on another track: closing the gap before c moves everything after it on V1 (a ripple, with its remap)
const ITEMS = () => [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35), clip("y", 50, 55, { trackId: "T2", type: "text", textContent: "y" })];
/** The remote ripple the freeze hides: the 5 s gap before c closes. */
const ripple = (its: Item[]) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 }));
const rippled = (i: Item): Item => (i.id === "c" ? { ...i, startTime: 10, endTime: 20 } : i.id === "d" ? { ...i, startTime: 20, endTime: 30 } : i);
const renamed = (i: Item): Item => (i.id === "a" ? { ...i, name: "A's" } : i);

async function commitOn(c: Carton, edit: (its: Item[]) => void): Promise<void> {
  const h = await c.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  edit(items);
  assert.equal((await c.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: BOB })).status, "confirmed");
}
async function setup(t: test.TestContext) {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  return { w, other, A, B, vb };
}
/** B's view save regenerates the shared file, then A adds h right after d: h must stay at 30. */
async function insertAfter(w: World, A: Agent, B: Agent, vb: string) {
  await B.editUntilDone(vb, (its) => void (find(its, "a").opacity = 0.5));
  await w.tick(500);
  await A.read();
  await A.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where A put it: not mapped through the ripple again");
}
const shown = (w: World) => parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;

test("review 14 #1: a save retried after its receipt failed still names the hidden ripple it made [real engine]", async (t) => {
  const { w, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote(ripple); // hidden by the freeze
  await w.tick(500);
  // the save's receipt fails once, after its commit and its attempt slot's result: it is retried from the slot
  const realPut = w.engine.putMeta.bind(w.engine);
  let failed = false;
  w.engine.putMeta = async (key, value) => {
    if (!failed && key[0] === "file" && key[1] === TIMELINE_FILE && key[2] === "state" && (await w.engine.getMeta<{ result?: unknown }>(["attempt", TIMELINE_FILE]))?.result) {
      failed = true;
      throw new Error("database is locked");
    }
    return realPut(key, value);
  };
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => renamed(rippled(i)))));
  await w.tick(3000);
  w.engine.putMeta = realPut;
  assert.ok(failed);
  assert.equal(find(await w.head(), "a").name, "A's");
  await insertAfter(w, A, B, vb);
  await A.stop();
  await B.stop();
});

test("review 14 #2: a ripple another process commits just before the save lands, and the save also made, is named [real engine]", async (t) => {
  const { w, other, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  const realCommit = w.engine.commit.bind(w.engine);
  let injected = false;
  w.engine.commit = async (input) => {
    if (!injected) {
      injected = true;
      await commitOn(other, ripple); // lands first, hidden by the freeze
    }
    return realCommit(input);
  };
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => renamed(rippled(i)))));
  await w.tick(500);
  w.engine.commit = realCommit;
  assert.ok(injected);
  await insertAfter(w, A, B, vb);
  await A.stop();
  await B.stop();
});

test("review 14 #3: a save that made a hidden change doesn't reveal a later, unrelated remote edit while the freeze lasts (R8-01) [real engine]", async (t) => {
  const { w, other, A, B } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote((its) => void (find(its, "c").name = "remote rename")); // hidden by the freeze
  await w.tick(500);
  // right after A's save commits, another process renames y
  const realCommit = w.engine.commit.bind(w.engine);
  let injected = false;
  w.engine.commit = async (input) => {
    const r = await realCommit(input);
    if (!injected) {
      injected = true;
      await commitOn(other, (its) => void (find(its, "y").name = "later remote edit"));
    }
    return r;
  };
  // A makes the same rename as the hidden one, and one of its own
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => renamed(i.id === "c" ? { ...i, name: "remote rename" } : i))));
  await w.tick(500);
  w.engine.commit = realCommit;
  assert.ok(injected);
  const items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "c").name], ["A's", "remote rename"], "what A saved is shown");
  assert.equal(find(items, "y").name, "y", "the later remote edit stays hidden until the freeze ends");
  assert.equal(find(await w.head(), "y").name, "later remote edit");
  await A.stop();
  await B.stop();
});

test("review 14 #4: a view's next save, based on a save that made a hidden ripple, isn't mapped through that ripple again [real engine]", async (t) => {
  const { w, B, vb } = await setup(t);
  const v0 = await B.read(vb);
  await w.remote(ripple); // after B's print: B's view doesn't have it
  await w.tick(500);
  // B makes the same ripple and a rename of its own, then (same print, its own file) adds h right after d
  w.writeAtomic(vb, render(v0, v0.items.map((i) => renamed(rippled(i)))));
  await w.tick(500);
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.equal(find(head, "a").name, "A's");
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where B put it");
  await B.stop();
});

test("review 14 (partial): a save that made only part of a hidden ripple restarts the freeze at its own commit: later remote edits stay hidden, no double ripple [real engine]", async (t) => {
  const { w, other, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote(ripple); // hidden by the freeze
  await w.tick(500);
  const realCommit = w.engine.commit.bind(w.engine);
  let injected = false;
  w.engine.commit = async (input) => {
    const r = await realCommit(input);
    if (!injected) {
      injected = true;
      await commitOn(other, (its) => void (find(its, "y").name = "later remote edit"));
    }
    return r;
  };
  // A moves c as the ripple did, but not d, and renames a
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => renamed(i.id === "c" ? { ...i, startTime: 10, endTime: 20 } : i))));
  await w.tick(500);
  w.engine.commit = realCommit;
  assert.ok(injected);
  const items = shown(w);
  assert.deepEqual(["c", "d"].map((x) => find(items, x).startTime), [10, 20], "the ripple, confirmed before A's commit, is shown whole");
  assert.equal(find(items, "y").name, "y", "the edit after A's commit stays hidden");
  await insertAfter(w, A, B, vb);
  await A.stop();
  await B.stop();
});
