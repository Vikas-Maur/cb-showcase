// Regressions found by review round 20 (GPT 6.1 Sol), on the real engine, history and materializer. Round 19 let a
// save's recorded result finish any file with its bytes, so a slot left behind (its cleanup failed, or the save never
// finished) answered for a later, deliberate save of the same bytes: a GUI saving an earlier state again after a later
// one, or a stale buffer after a remote change was written in, was taken as that old save and never committed. Now the
// result finishes the same file, or its bytes written again only while nothing has happened at the path since (Carton
// installed no file there, and the save didn't finish). And a print stored its new generation only after installing,
// so a failed row write left a save on the installed print as old as the saves its install displaced; the generation is
// now stored first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { statusPath, PROJECT_FILE, type ViewRow } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
type Status = { status: string; error?: string; change: string | null };
type Envelope = { project: { timelineItems: Item[] } };
const status = (w: World, name: string) => JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as Status;
const nonceOf = (text: string) => (findRev(text)!.rev as { nonce: string }).nonce;

async function setup(t: test.TestContext, codec: TimelineCodec = jsonTimelineCodec) {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)], codec });
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

test("review 20 #1: a GUI save's bytes saved again after a later save, its slot left by a failed cleanup, are committed, not taken as the old save [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const env = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope;
  find(env.project.timelineItems, "a").name = "saved";
  const bytes = JSON.stringify(env);
  let fail = true;
  w.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "attempt" && k[1] === PROJECT_FILE && v === undefined) {
      fail = false;
      throw new Error("cleanup locked once");
    }
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes);
  await w.mz.idle();
  assert.equal(fail, false);
  const earlier = await w.engine.getMeta<{ id?: string; result?: unknown }>(["attempt", PROJECT_FILE]);
  assert.ok(earlier?.result, "the finished save's slot is left behind");
  await w.gui((its) => void (find(its, "a").name = "later"));
  const later = structuredClone(env);
  find(later.project.timelineItems, "a").name = "later";
  w.writeAtomic(PROJECT_FILE, JSON.stringify(later)); // head-equal: unchanged
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "later");
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // deliberately back to "saved"
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "saved", "the deliberate save is committed");
  assert.equal(ids.length, before + 1);
  assert.notEqual(ids.at(-1), earlier.id, "under a change id of its own");
  assert.notEqual(w.mz.log.applied.filter((x) => x.path === PROJECT_FILE).at(-1)?.id, (earlier.result as { id?: string }).id);
});

test("review 20 #1: an unfinished save's bytes written again after Carton wrote a remote change into the file are a save of their own [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const env = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope;
  find(env.project.timelineItems, "a").name = "saved";
  const bytes = JSON.stringify(env);
  let blocked = true;
  w.engine.putMeta = async (k, v) => {
    if (blocked && k[0] === "file" && k[1] === PROJECT_FILE && k[2] === "overlay") throw new Error("store busy after the commit");
    return put(k, structuredClone(v));
  };
  w.writeAtomic(PROJECT_FILE, bytes); // committed; never finished while the store is busy
  await w.tick(500);
  const earlier = await w.engine.getMeta<{ id?: string; result?: { id?: string } }>(["attempt", PROJECT_FILE]);
  assert.ok(earlier?.result, "committed, not finished");
  assert.equal(find(await w.head(), "a").name, "saved");
  w.writeAtomic(PROJECT_FILE, "{"); // the GUI's next write replaces it (a half-written file: refused)
  await w.tick(500);
  await w.remote((its) => void (find(its, "c").name = "remote")); // Carton writes it into project.json
  await w.tick(1000);
  const shown = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as Envelope;
  assert.deepEqual([find(shown.project.timelineItems, "a").name, find(shown.project.timelineItems, "c").name], ["saved", "remote"], "Carton's file is at the path");
  blocked = false;
  const before = ids.length;
  w.writeAtomic(PROJECT_FILE, bytes); // the GUI's earlier state again, after Carton's file
  await w.tick(1000);
  assert.equal(ids.length, before + 1, "committed");
  assert.notEqual(ids.at(-1), earlier.id, "under a change id of its own");
  // as with no slot left: project.json's base is Carton's last file, so this save sets c back
  assert.equal(find(await w.head(), "c").name, "c");
});

test("review 20 #1: a finished view save's bytes written again, its slot left by a failed cleanup, don't replay its result over a late update [real engine]", async (t) => {
  const { w, put, ids } = await setup(t);
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  let fail = true;
  w.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "attempt" && k[1] === vb && v === undefined) {
      fail = false;
      throw new Error("cleanup locked once");
    }
    return put(k, structuredClone(v));
  };
  const its = structuredClone(v0.items);
  find(its, "a").name = "saved";
  const bytes = render(v0, its);
  w.writeAtomic(vb, bytes);
  await w.mz.idle();
  assert.equal(fail, false);
  const s0 = status(w, name);
  assert.equal(s0.status, "confirmed");
  assert.ok(await w.engine.getMeta(["attempt", vb]), "the finished save's slot is left behind");
  // core's late answer for that change (a conflict found when its shared cut synced)
  const card = { kind: "value", path: "timelineItems/a/name", base: "a", ours: "saved", theirs: "theirs" } as never;
  await w.mz.onChangeUpdate(name, s0.change!, { status: "conflicts", conflicts: [card] });
  assert.equal(status(w, name).status, "conflicts");
  const before = ids.length;
  w.writeAtomic(vb, bytes); // the agent writes the same file again
  await w.tick(1000);
  assert.equal(status(w, name).status, "conflicts", "the late update stands");
  assert.equal(ids.length, before, "nothing committed");
  await B.stop();
});

/** A print whose render lets an old-buffer save land (displaced by its install), and whose row write after the install fails once. */
function racing(w: World, put: (k: readonly string[], v: unknown) => Promise<void>, name: string, oldNonce: string) {
  let injected = false;
  w.engine.putMeta = async (k, v) => {
    const r = v as ViewRow | undefined;
    if (!injected && k[0] === "view" && k[1] === name && r?.nonce && r.nonce !== oldNonce) {
      injected = true;
      throw new Error("store busy storing the installed print");
    }
    return put(k, structuredClone(v));
  };
  return () => injected;
}

test("review 20 #2: a reprint whose row isn't stored after its install: a save on it stays newer than the old-buffer save the install displaced [real engine]", async (t) => {
  let during: (() => void) | null = null;
  const codec: TimelineCodec = {
    ...jsonTimelineCodec,
    print: async (p, r) => {
      const f = during;
      during = null;
      f?.();
      return jsonTimelineCodec.print(p, r);
    },
  };
  const { w, put } = await setup(t, codec);
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5; // repeats the hidden rename: printed again at its commit
  const late = structuredClone(first);
  find(late, "a").name = "old buffer";
  const pin = w.engine.pin.bind(w.engine);
  let armed = true;
  w.engine.pin = async (o) => {
    const p = await pin(o);
    if (armed && o.seq !== undefined && o.owner.startsWith("turn:")) {
      armed = false;
      during = () => w.writeAtomic(vb, render(v0, late)); // lands while the reprint renders: displaced by its install
    }
    return p;
  };
  const injected = racing(w, put, name, nonceOf(v0.text));
  w.writeAtomic(vb, render(v0, first));
  await w.mz.idle();
  w.engine.pin = pin;
  assert.ok(injected());
  const shown = await B.read(vb);
  assert.notEqual(nonceOf(shown.text), nonceOf(v0.text), "the reprint is installed");
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "fresh save"));
  await w.mz.idle();
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  await w.tick(1000); // the displaced old-buffer save is reviewed: refused
  assert.deepEqual(status(w, name), before, "the fresh save's sidecar is unchanged");
  assert.equal((await w.engine.getMeta<ViewRow>(["view", name]))!.lastChange, before.change, "its late updates still reach it");
  assert.equal(find(await w.head(), "a").name, "fresh save");
  assert.ok(w.mz.log.kept.some((k) => k.path === vb), "the refused file is kept");
  await B.stop();
});

test("review 20 #2: an explicit print whose row isn't stored after its install: a save on it stays newer than the old-buffer save the install displaced [real engine]", async (t) => {
  let during: (() => void) | null = null;
  const codec: TimelineCodec = {
    ...jsonTimelineCodec,
    print: async (p, r) => {
      const f = during;
      during = null;
      f?.();
      return jsonTimelineCodec.print(p, r);
    },
  };
  const { w, put } = await setup(t, codec);
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  const old = structuredClone(v0.items);
  find(old, "a").opacity = 0.3;
  during = () => w.writeAtomic(vb, render(v0, old)); // lands while the print renders: displaced by its install
  const injected = racing(w, put, name, nonceOf(v0.text));
  await assert.rejects(w.mz.printView("vb", B.actor, { hooked: true }), /store busy storing the installed print/);
  assert.ok(injected());
  const shown = await B.read(vb);
  assert.notEqual(nonceOf(shown.text), nonceOf(v0.text), "the print is installed");
  await B.editUntilDone(vb, (its) => void (find(its, "c").name = "fresh save"));
  await w.mz.idle();
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  await w.tick(1000); // the displaced old-buffer save is reviewed: applied, an older generation's
  const head = await w.head();
  assert.deepEqual([find(head, "a").opacity, find(head, "c").name], [0.3, "fresh save"], "both saves landed");
  assert.deepEqual(status(w, name), before, "the fresh save's sidecar is unchanged");
  assert.equal((await w.engine.getMeta<ViewRow>(["view", name]))!.lastChange, before.change, "its late updates still reach it");
  await B.stop();
});
