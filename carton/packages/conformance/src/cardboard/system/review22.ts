// Regressions found by review round 22 (GPT 6.1 Sol), on the real engine, history and materializer. (1) A file that
// doesn't parse was marked current before the path's token was written, so a token write that failed was never tried
// again and an unfinished save's bytes restored later replayed its old result. (2) A save's slot took the path's token
// when its result was recorded, after the commit, so an install by another process during the commit was absorbed:
// the slot now keeps the token its own review wrote. (3) The engine read whether the cut is shared only at head(),
// which the app's materializer (writeProject false) never calls: remote changes skipped the 30 s spacing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cardboardFilesHost, fromHost, jsonTimelineCodec, toHost } from "@carton/cardboard";
import { Materializer, PROJECT_FILE, TIMELINE_FILE, cartonMaterializerEngine } from "@carton/cardboard/node";
import { openWorld, clip, find, HUMAN, type Item, type World } from "./world.ts";

type Envelope = { project: { timelineItems: Item[] } };

async function setup(t: test.TestContext) {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  // SQLite gives back independent rows: no shared references hide a mutation made before a write
  const get = w.engine.getMeta.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.getMeta = async <T,>(key: readonly string[]) => structuredClone(await get<T>(key));
  w.engine.putMeta = async (key, value) => put(key, structuredClone(value));
  const commit = w.engine.commit.bind(w.engine);
  const ids: (string | undefined)[] = [];
  w.engine.commit = async (i) => (ids.push(i.id), commit(i));
  return { w, put, ids };
}
const savedBytes = (w: World) => {
  const e = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope;
  find(e.project.timelineItems, "a").name = "saved";
  return JSON.stringify(e);
};
/** A head change no materializer is told about (another process's commit). */
async function commitElsewhere(w: World, name: string) {
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  find(items, "a").name = name;
  assert.equal((await w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: HUMAN })).status, "confirmed");
}

test("review 22 #1: content that doesn't parse whose token write fails is refused again at its next event; an unfinished save's bytes restored after it are a save of their own [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const bytes = savedBytes(w);
  let blockOverlay = true;
  let blockToken = false;
  w.engine.putMeta = async (k, v) => {
    if (blockOverlay && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("failure after the commit, before the overlay");
    if (blockToken && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "seen") throw new Error("token unavailable");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  blockOverlay = false;
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(slot?.result, "committed, not finished");
  await commitElsewhere(w, "later");
  const token = await w.engine.getMeta(["file", PROJECT_FILE, "seen"]);
  blockToken = true;
  w.writeInPlace(PROJECT_FILE, "{"); // an in-place writer's broken save; its token can't be stored
  await w.tick(10_000);
  assert.ok(w.mz.log.errors.some((e) => String(e.error).includes("token unavailable")));
  blockToken = false;
  w.mz.onFsEvent(PROJECT_FILE); // its next event
  await w.tick(10_000);
  assert.notEqual(await w.engine.getMeta(["file", PROJECT_FILE, "seen"]), token, "refused again: its token is stored now");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.tick(1000);
  assert.equal(ids.length, before + 1, "the restore is a save of its own");
  assert.notEqual(ids.at(-1), slot.id);
  assert.ok(w.mz.log.cards.some((c) => c.cards.some((x) => x.path === "timelineItems/a/name")), "its conflict with the later head is carded");
});

test("review 22 #2: another process's install while a save commits isn't absorbed into that save's token: its bytes restored later are a save of their own [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const bytes = savedBytes(w);
  let blockOverlay = true;
  w.engine.putMeta = async (k, v) => {
    if (blockOverlay && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("failure after the commit, before the overlay");
    return put(k, structuredClone(v));
  };
  const commit = w.engine.commit.bind(w.engine);
  let helped = false;
  w.engine.commit = async (i) => {
    const r = await commit(i);
    if (i.meta.file === PROJECT_FILE && !helped) {
      // while the holder commits: another process commits, the file goes, and a takeover helper installs head
      helped = true;
      await commitElsewhere(w, "later");
      fs.unlinkSync(w.abs(PROJECT_FILE));
      const helper = new Materializer({ bundle: w.bundle, engine: w.engine, host: cardboardFilesHost, codec: jsonTimelineCodec, clock: w.clock });
      t.after(() => helper.close());
      await helper.start();
      await helper.close();
      const shown = (JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope).project.timelineItems;
      assert.equal(find(shown, "a").name, "later", "the helper's install");
    }
    return r;
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  blockOverlay = false;
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(slot?.result, "committed, not finished");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // the GUI restores "saved" over the helper's file
  await w.mz.idle();
  assert.equal(ids.length, before + 1, "a save of its own");
  assert.notEqual(ids.at(-1), slot.id);
  assert.equal(find(await w.head(), "a").name, "saved");
});

test("review 22 #3: a materializer that never reads head (writeProject false) still finds the cut shared: remote changes rewrite the shared file at most every 30 s [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10)] });
  await w.mz.close();
  const cuts = w.carton.cuts.bind(w.carton);
  w.carton.cuts = async () => (await cuts()).map((c) => ({ ...c, sequencer: { ...c.sequencer, kind: "server" } })) as Awaited<ReturnType<typeof cuts>>;
  const engine = cartonMaterializerEngine(w.carton);
  let heads = 0;
  const head = engine.head.bind(engine);
  engine.head = async () => (heads++, head());
  const mz = new Materializer({ bundle: w.bundle, engine, host: cardboardFilesHost, codec: jsonTimelineCodec, clock: w.clock, writeProject: false });
  t.after(() => mz.close());
  let pins = 0;
  const pin = engine.pin.bind(engine);
  engine.pin = async (o) => (pins++, pin(o));
  await mz.start();
  assert.equal(engine.shared(), true, "found shared at start (it pins for its first write), before any save or remote change");
  assert.ok(pins > 0);
  const remote = () => mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE && r.cause === "remote").length;
  await w.clock.advance(31_000, () => mz.idle());
  for (const name of ["one", "two", "three"]) {
    await commitElsewhere(w, name);
    mz.onHeadChange("remote");
    await w.clock.advance(1000, () => mz.idle());
  }
  assert.equal(heads, 0, "head is never read");
  assert.equal(engine.shared(), true, "the cut is found shared");
  assert.equal(remote(), 1, "the first remote change rewrites at once, the next ones wait");
  await w.clock.advance(30_000, () => mz.idle());
  assert.equal(remote(), 2, "and are written together 30 s after it");
});

test("review 22 #2: another process's event between a save's own token and its slot counts too: the slot keeps the token its review wrote [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const bytes = savedBytes(w);
  let blockOverlay = true;
  let raced = false;
  w.engine.putMeta = async (k, v) => {
    if (blockOverlay && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("failure after the commit, before the overlay");
    await put(k, structuredClone(v));
    if (!raced && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "seen") {
      // right after the review's own token: another process commits and installs
      raced = true;
      await commitElsewhere(w, "later");
      await put(["file", PROJECT_FILE, "seen"], "another process's install");
    }
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  blockOverlay = false;
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(raced && slot?.result, "committed, not finished");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  assert.equal(ids.length, before + 1, "a save of its own");
  assert.notEqual(ids.at(-1), slot.id);
});
