// Regressions found by review round 23 (GPT 6.1 Sol), on the real engine, history and materializer. (1) An agent's `cb`
// change that took the freeze's exact path restarted the view at its own state and dropped what the view held past it:
// a file save applied in the same freeze, before the fold ran, vanished from the file, and the agent's next save was
// carded against its own. (2) A broken write displaced by a save's own regeneration (an install that writes no token)
// was refused without writing the path's token, so an unfinished result of that save could still be replayed. (3) A fold
// that failed was retried as a reprint only: the agent's confirmed change stayed hidden until the freeze ended.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Actor, Doc } from "@carton/core";
import { fromHost, toHost, type TimelineCodec } from "@carton/cardboard";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, type Item, type World } from "./world.ts";

const WHO: Actor = { kind: "agent", id: "director/c1/t1", name: "Director", turn: "t1", group: "local:me@m1" };
const shown = (w: World) => parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
/** A `cb` commit by the agent at head, then the materializer told (as `@carton/local`'s runWrite does). */
async function cb(w: World, fn: (items: Item[]) => void) {
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  fn(items);
  assert.equal((await w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: WHO })).status, "confirmed");
  w.mz.onHeadChange("local");
}

test("review 23 #1: an agent's cb change that restarts the freeze keeps what the view held past it (a save applied before the fold ran); the agent's next save isn't carded against its own [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] });
  const agent = w.agent(WHO.id, { hooked: true, actor: WHO });
  await agent.read(); // the freeze starts
  await w.gui((its) => void (find(its, "a").name = "person")); // hidden
  await w.gui((its) => void (find(its, "b").name = "person b")); // hidden
  await cb(w, (its) => void (find(its, "a").name = "cb agent")); // over the person's hidden edit: the exact path
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "c").name = "file first")); // applied before the fold
  await w.mz.idle();
  await w.tick(100); // the fold
  let items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "c").name], ["cb agent", "person b", "file first"], "the cb change, what was confirmed up to it, and the later save");
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "c").name = "file second"));
  await w.tick(1000);
  assert.deepEqual(w.mz.log.cards, [], "no card against its own save");
  assert.equal(find(await w.head(), "c").name, "file second");
  await w.gui((its) => void (find(its, "b").startTime = 6)); // after the restart: hidden again
  await cb(w, (its) => void (find(its, "c").opacity = 0.5));
  await w.tick(100);
  items = shown(w);
  assert.deepEqual([find(items, "b").startTime, find(items, "c").opacity, find(items, "c").name], [5, 0.5, "file second"]);
});

test("review 23 #1: what a restart folds in again goes in the log's order with the changes still to fold: an agent's later cb edit of what its save changed is kept [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("c", 10, 15)] });
  const agent = w.agent(WHO.id, { hooked: true, actor: WHO });
  await agent.read();
  await w.gui((its) => void (find(its, "a").name = "person")); // hidden
  await cb(w, (its) => void (find(its, "a").name = "cb agent")); // the exact path
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "c").name = "file")); // applied before the fold
  await w.mz.idle();
  await cb(w, (its) => void (find(its, "c").name = "cb after the file")); // builds on the save
  await w.tick(100); // one fold: the restart, the save again, then the later cb change
  const items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "c").name], ["cb agent", "cb after the file"]);
});

test("review 23 #2: a broken write displaced by a save's own regeneration still counts at the path: that save's bytes restored after a later head are committed again [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const get = w.engine.getMeta.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.getMeta = async <T,>(k: readonly string[]) => structuredClone(await get<T>(k));
  const agent = w.agent(WHO.id, { hooked: true, actor: WHO });
  await agent.read();
  // a competing in-place writer's broken file lands while the save's regeneration prints
  const codec = (w.mz as unknown as { codec: TimelineCodec }).codec;
  const print = codec.print.bind(codec);
  let inject = true;
  codec.print = async (...args: Parameters<TimelineCodec["print"]>) => {
    if (inject) {
      inject = false;
      fs.writeFileSync(w.abs(TIMELINE_FILE), "{");
    }
    return print(...args);
  };
  // the store is down at the save's cleanup and at its cleanup token: the slot stays, its result reusable
  let cleanupFails = true;
  let tokenFails = false;
  w.engine.putMeta = async (k, v) => {
    if (cleanupFails && k[0] === "attempt" && k[1] === TIMELINE_FILE && v === undefined) {
      cleanupFails = false;
      tokenFails = true;
      throw new Error("store down at cleanup");
    }
    if (tokenFails && k[0] === "file" && k[1] === TIMELINE_FILE && k[2] === "seen") {
      tokenFails = false;
      throw new Error("store still down");
    }
    return put(k, structuredClone(v));
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "saved"));
  const bytes = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  await w.mz.idle();
  assert.ok((await get<{ result?: unknown }>(["attempt", TIMELINE_FILE]))?.result, "the slot is left with its result");
  await w.tick(1000);
  assert.ok(w.mz.log.unparsed.some((x) => x.displaced), "the broken write was displaced and refused");
  w.engine.putMeta = async (k, v) => put(k, structuredClone(v));
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  find(items, "a").name = "later person";
  assert.equal((await w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: { kind: "human", id: "person" } })).status, "confirmed");
  const commit = w.engine.commit.bind(w.engine);
  let committed = false;
  w.engine.commit = async (i) => ((committed = true), commit(i));
  w.writeAtomic(TIMELINE_FILE, bytes);
  await w.mz.idle();
  assert.equal(committed, true, "a save of its own, not the old result replayed");
});

test("review 23 #3: a fold that fails is retried with its rewrite: the agent's confirmed cb edit shows without another head change [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  await w.mz.hookRead(WHO);
  const since = w.engine.changesSince!.bind(w.engine);
  let fail = true;
  w.engine.changesSince = (seq, o) => {
    if (fail && o?.until === undefined) {
      fail = false;
      return (async function* (): AsyncGenerator<{ id: string; seq: number; before: Doc; after: Doc }> {
        throw new Error("store busy for a moment");
      })();
    }
    return since(seq, o);
  };
  await cb(w, (its) => void (find(its, "a").name = "cb agent"));
  await w.tick(2000);
  assert.ok(w.mz.log.errors.some((e) => String(e.error).includes("store busy")), "the fold failed once");
  assert.equal(find(shown(w), "a").name, "cb agent", "and was retried");
});
