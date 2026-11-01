// Regressions found by review round 21 (GPT 6.1 Sol), on the real engine, history and materializer. Round 20 let a
// save's recorded result finish another file with its bytes only while a per-path epoch was unchanged, but the epoch
// lived in each process's cached path state and counted only installs and a failed cleanup: a head-equal save in
// between left it unchanged, a write that failed during an outage was forgotten after a restart, and a takeover helper's
// install never reached the former holder's cache. Now what has happened at a path is a random token in a row of its
// own, read fresh by every process and written before the event's own writes: by Carton's installs, by the review of any
// file there but the save's own (whatever the outcome, content that doesn't parse too), by a late update of a view's
// sidecar, and by a finished save whose slot couldn't be cleared.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cardboardFilesHost, fromHost, jsonTimelineCodec, toHost } from "@carton/cardboard";
import { Materializer, PROJECT_FILE, TIMELINE_FILE, statusPath, type MaterializerOptions } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, render, HUMAN, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
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
/** Another materializer on the same bundle and store: a restart, or a takeover helper. */
function another(t: test.TestContext, w: World, o: Partial<MaterializerOptions> = {}): Materializer {
  const mz = new Materializer({ bundle: w.bundle, engine: w.engine, host: cardboardFilesHost, codec: jsonTimelineCodec, clock: w.clock, ...o });
  t.after(() => mz.close());
  return mz;
}
const project = (w: World) => JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope;
const named = (env: Envelope, name: string) => {
  const e = structuredClone(env);
  find(e.project.timelineItems, "a").name = name;
  return JSON.stringify(e);
};
/** A project.json save committed but not finished (a failure before its overlay), named "saved". */
async function unfinishedSave(w: World, put: (k: readonly string[], v: unknown) => Promise<void>) {
  const bytes = named(project(w), "saved");
  let blocked = true;
  w.engine.putMeta = async (k, v) => {
    if (blocked && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("failure after the commit, before the overlay");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(slot?.result, "committed, not finished");
  blocked = false;
  return { bytes, slot };
}
/** A head change no materializer is told about (another process's commit). */
async function commitElsewhere(w: World, name: string) {
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  find(items, "a").name = name;
  assert.equal((await w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: HUMAN })).status, "confirmed");
}

test("review 21 #1: a head-equal GUI save between an unfinished save and a deliberate restore of its bytes: the restore is committed [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const bytes = named(project(w), "saved");
  let blocked = true;
  w.engine.putMeta = async (k, v) => {
    if (blocked && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("failure after the commit, before the overlay");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(slot?.result, "committed, not finished");
  blocked = false;
  await w.gui((its) => void (find(its, "a").name = "later"));
  w.writeAtomic(PROJECT_FILE, named(project(w), "later")); // the GUI's head-equal save: unchanged
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "later");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // deliberately back to "saved"
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "saved", "the restore is committed");
  assert.equal(ids.length, before + 1);
  assert.notEqual(ids.at(-1), slot.id, "under an id of its own");
});

test("review 21 #1: on a frozen shared file (writeProject false), a head-equal save between an unfinished save and its bytes again: they are merged and carded [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  await w.mz.close();
  const mz = another(t, w, { writeProject: false });
  await mz.start();
  await mz.hookRead({ kind: "agent", id: "director/c/t1", name: "Director" }); // the shared file is frozen
  const v0 = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  const items = structuredClone(v0.items);
  find(items, "a").name = "saved";
  const bytes = render(v0, items);
  let blocked = true;
  w.engine.putMeta = async (k, v) => {
    if (blocked && k[0] === "file" && k[1] === TIMELINE_FILE && k[2] === "state" && (await w.engine.getMeta<{ result?: unknown }>(["attempt", TIMELINE_FILE]))?.result) throw new Error("failure after the commit, before the receipt");
    return put(k, structuredClone(v));
  };
  let n = 0;
  const write = async (text: string) => {
    const tmp = w.abs(`write-${n++}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, w.abs(TIMELINE_FILE));
    mz.onFsEvent(TIMELINE_FILE);
    await mz.idle();
  };
  await write(bytes);
  blocked = false;
  assert.ok((await w.engine.getMeta<{ result?: unknown }>(["attempt", TIMELINE_FILE]))?.result, "committed, not finished");
  await w.gui((its) => void (find(its, "a").name = "later"));
  const later = structuredClone(items);
  find(later, "a").name = "later";
  await write(render(v0, later)); // head-equal: unchanged (no rewrite during the freeze)
  const before = ids.length;
  await write(bytes); // "saved" again, on the print that showed "a"
  assert.equal(ids.length, before + 1, "merged as a save of its own");
  assert.ok(mz.log.cards.some((c) => c.cards.some((x) => x.path === "timelineItems/a/name")), "its conflict with the later head is carded");
  assert.equal(find(await w.head(), "a").name, "later", "the card keeps head's value");
});

test("review 21 #2: a database outage fails the cleanup and the token; after a restart, a head-equal GUI save left while closed, then a restore: committed [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const env = project(w);
  const bytes = named(env, "saved");
  let outage = false;
  w.engine.putMeta = async (k, v) => {
    if (k[0] === "attempt" && k[1] === PROJECT_FILE && v === undefined) outage = true;
    if (outage) throw new Error("database unavailable");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  const slot = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(slot?.result);
  await w.mz.close(); // the process exits
  outage = false;
  w.engine.putMeta = async (k, v) => put(k, structuredClone(v));
  await commitElsewhere(w, "later");
  fs.writeFileSync(w.abs(PROJECT_FILE), named(env, "later")); // the GUI's head-equal save while Carton was closed
  const next = another(t, w);
  await next.start();
  assert.equal(find(await w.head(), "a").name, "later");
  const before = ids.length;
  const tmp = w.abs("restore.tmp");
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, w.abs(PROJECT_FILE));
  next.onFsEvent(PROJECT_FILE);
  await next.idle();
  assert.equal(find(await w.head(), "a").name, "saved", "the restore is committed");
  assert.equal(ids.length, before + 1);
  assert.notEqual(ids.at(-1), slot.id);
});

test("review 21 #2: a late conflict on a view survives a restart and an identical resave, even when the cleanup and its token failed in an outage [real engine]", async (t) => {
  const { w, put } = await setup(t);
  const B = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  const items = structuredClone(v0.items);
  find(items, "a").name = "saved";
  const bytes = render(v0, items);
  let outage = false;
  w.engine.putMeta = async (k, v) => {
    if (k[0] === "attempt" && k[1] === vb && v === undefined) outage = true;
    if (outage) throw new Error("database unavailable");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(vb, bytes);
  await w.mz.idle();
  const slot = await w.engine.getMeta<{ result?: { id?: string } }>(["attempt", vb]);
  assert.ok(slot?.result?.id);
  outage = false;
  w.engine.putMeta = async (k, v) => put(k, structuredClone(v));
  const card = { kind: "value", path: "timelineItems/a/name", base: "a", ours: "saved", theirs: "remote" } as never;
  await w.mz.onChangeUpdate(name, slot.result.id, { status: "conflicts", conflicts: [card] });
  const status = () => JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as { status: string };
  assert.equal(status().status, "conflicts");
  await w.mz.close();
  const tmp = w.abs("resave.tmp");
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, w.abs(vb)); // the agent writes the same file again while Carton is closed
  const next = another(t, w);
  await next.start();
  assert.equal(status().status, "conflicts", "the late conflict stands");
  await B.stop();
});

test("review 21 #3: a takeover helper's review at the path reaches the former holder, told of nothing in between: an unfinished save's bytes written after it are committed [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const { bytes, slot } = await unfinishedSave(w, put);
  // the holder stalls: the GUI leaves a broken file, another process commits, and a takeover helper deals with both;
  // the holder hears of none of it (a token cached in the holder would still say nothing happened)
  fs.writeFileSync(w.abs(PROJECT_FILE), "{");
  await commitElsewhere(w, "later");
  const helper = another(t, w);
  await helper.start();
  await helper.close();
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // the holder resumes: the GUI restores "saved"
  await w.mz.idle();
  assert.equal(find(await w.head(), "a").name, "saved", "committed");
  assert.equal(ids.length, before + 1);
  assert.notEqual(ids.at(-1), slot.id);
});

test("review 21: content that doesn't parse between an unfinished save and its bytes again: they are a save of their own [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const { bytes, slot } = await unfinishedSave(w, put);
  await commitElsewhere(w, "later");
  w.writeInPlace(PROJECT_FILE, "{"); // an in-place writer's broken save, left as it is
  await w.tick(10_000);
  assert.ok(w.mz.log.unparsed.some((u) => u.path === PROJECT_FILE), "refused: it doesn't parse");
  assert.equal(fs.readFileSync(w.abs(PROJECT_FILE), "utf8"), "{", "kept where its writer put it (nothing installed over it)");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // on Carton's last project.json, which showed "a"
  await w.tick(1000);
  assert.equal(ids.length, before + 1, "committed as a save of its own");
  assert.notEqual(ids.at(-1), slot.id);
  assert.ok(w.mz.log.cards.some((c) => c.cards.some((x) => x.path === "timelineItems/a/name")), "its conflict with the later head is carded");
});

test("review 21: Carton writing the path between an unfinished save and its bytes again (no file reviewed in between): they are a save of their own [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const { bytes, slot } = await unfinishedSave(w, put);
  fs.unlinkSync(w.abs(PROJECT_FILE)); // the file goes: nothing to review
  w.mz.onFsEvent(PROJECT_FILE);
  await commitElsewhere(w, "later");
  w.mz.onHeadChange("remote");
  await w.tick(1000);
  assert.equal(find(project(w).project.timelineItems, "a").name, "later", "Carton wrote head");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "saved", "committed");
  assert.equal(ids.length, before + 1);
  assert.notEqual(ids.at(-1), slot.id);
});

test("review 21: a finished view save whose slot couldn't be cleared is never replayed into an identical resave [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const B = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  const items = structuredClone(v0.items);
  find(items, "a").name = "saved";
  const bytes = render(v0, items);
  let fail = true;
  w.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "attempt" && k[1] === vb && v === undefined) {
      fail = false;
      throw new Error("cleanup locked once");
    }
    return put(k, structuredClone(v));
  };
  w.writeAtomic(vb, bytes);
  await w.mz.idle();
  assert.equal(fail, false);
  assert.ok(await w.engine.getMeta(["attempt", vb]), "the slot is left");
  const sidecar = fs.readFileSync(w.abs(statusPath(name)), "utf8");
  const applied = w.mz.log.applied.length;
  const before = ids.length;
  w.writeAtomic(vb, bytes); // the same file written again, nothing else in between
  await w.tick(1000);
  assert.equal(w.mz.log.applied.length, applied, "not replayed");
  assert.equal(ids.length, before);
  assert.equal(fs.readFileSync(w.abs(statusPath(name)), "utf8"), sidecar, "the sidecar is the save's, untouched");
  await B.stop();
});
