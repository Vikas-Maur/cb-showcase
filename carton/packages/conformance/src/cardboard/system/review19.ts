// Regressions found by review round 19 (GPT 6.1 Sol), on the real engine, history and materializer. Round 18 marked a
// view print replaced at a save's commit and refused later saves on it, let the save that caused it through, and kept
// an older displaced file's outcome out of a newer save's sidecar by print generation. A reprint kept its generation, so
// a save displaced by it looked as new as a save on the reprint; the view row's base was cleared before the reprint, so a
// retry of the save found another base and committed again; the same bytes written again while that save was unfinished
// took the "unchanged" shortcut and never finished it; and restoring those bytes after a later save was taken as
// unchanged. Now a reprint starts a print generation, the row keeps its base until the reprint replaces the print, a
// recorded result finishes any file with that content, and the shortcut holds only while that save is the view's latest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { statusPath, type ViewRow } from "@carton/cardboard/node";
import { openWorld, clip, find, render } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
type Status = { status: string; error?: string; change: string | null };
const status = (w: World, name: string) => JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as Status;
const nonceOf = (text: string) => (findRev(text)!.rev as { nonce: string }).nonce;

async function setup(t: test.TestContext, codec: TimelineCodec = jsonTimelineCodec) {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)], codec });
  // SQLite gives back independent rows: no shared references hide a mutation made before a write
  const get = w.engine.getMeta.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.getMeta = async <T,>(key: readonly string[]) => structuredClone(await get<T>(key));
  w.engine.putMeta = async (key, value) => put(key, structuredClone(value));
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  return { w, B, vb, name, v0: await B.read(vb) };
}

test("review 19 #1: a save displaced by a reprint, refused after a save on the reprint, leaves that save's sidecar and late updates alone [real engine]", async (t) => {
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
  const { w, B, vb, name, v0 } = await setup(t, codec);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
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
  w.writeAtomic(vb, render(v0, first));
  await w.mz.idle();
  w.engine.pin = pin;
  assert.equal(armed, false);
  // B reads the reprint and saves on it before the displaced file's hold ends (no explicit print)
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "fresh save"));
  await w.mz.idle();
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  await w.tick(1000); // the displaced old-buffer save is reviewed: refused
  assert.deepEqual(status(w, name), before, "the fresh save's sidecar is unchanged");
  assert.equal((await w.engine.getMeta<ViewRow>(["view", name]))!.lastChange, before.change, "its late updates still reach it");
  assert.equal(find(await w.head(), "a").name, "fresh save");
  assert.ok(w.mz.log.kept.some((k) => k.path === vb), "the refused file is kept");
  assert.deepEqual(w.mz.log.cards, []);
  await B.stop();
});

test("review 19 #2: a save on a held base that causes a reprint, retried after a failure once its row is written, keeps its change id and base [real engine]", async (t) => {
  const { w, B, vb, name, v0 } = await setup(t);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "first own save")); // the view row holds this save as the base
  await w.tick(1000);
  const v1 = await B.read(vb);
  assert.equal(nonceOf(v1.text), nonceOf(v0.text), "not printed again: the same print");
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const ids: string[] = [];
  const commit = w.engine.commit.bind(w.engine);
  w.engine.commit = async (i) => (ids.push(i.id ?? "(none)"), commit(i));
  const head = w.engine.head.bind(w.engine);
  let injected = false;
  w.engine.head = async () => {
    const row = await w.engine.getMeta<ViewRow>(["view", name]);
    if (!injected && ids.length && row?.lastChange && (await w.engine.getMeta(["reprinted", name, row.nonce]))) {
      injected = true; // after the row is written, before the reprint
      await w.remote((its) => void (find(its, "a").opacity = 0.8));
      throw new Error("store busy after the view row was written");
    }
    return head();
  };
  const next = structuredClone(v1.items);
  find(next, "c").name = "remote";
  find(next, "a").opacity = 0.5;
  w.writeAtomic(vb, render(v1, next));
  await w.tick(5000);
  w.engine.head = head;
  assert.ok(injected);
  assert.equal(new Set(ids).size, 1, `one change id: ${ids.join(", ")}`);
  assert.deepEqual(w.mz.log.cards, [], "no card: the retry is not a second commit against another base");
  assert.equal(await w.engine.getMeta(["attempt", vb]), undefined, "finished");
  const s = status(w, name);
  assert.deepEqual([s.status, s.change], ["confirmed", ids[0]]);
  assert.notEqual(nonceOf(fs.readFileSync(w.abs(vb), "utf8")), nonceOf(v0.text), "printed again");
  const end = await w.head();
  assert.deepEqual([find(end, "a").name, find(end, "a").opacity, find(end, "c").name], ["first own save", 0.8, "remote"]);
  await B.stop();
});

test("review 19 #3: the same bytes written again while the save that caused a reprint is unfinished finish it from its result [real engine]", async (t) => {
  const { w, B, vb, name, v0 } = await setup(t);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
  const bytes = render(v0, first);
  const ids: string[] = [];
  const commit = w.engine.commit.bind(w.engine);
  w.engine.commit = async (i) => (ids.push(i.id ?? "(none)"), commit(i));
  const head = w.engine.head.bind(w.engine);
  let injected = false;
  w.engine.head = async () => {
    const row = await w.engine.getMeta<ViewRow>(["view", name]);
    if (!injected && row && (await w.engine.getMeta(["reprinted", name, row.nonce]))) {
      injected = true;
      throw new Error("store busy before the sidecar");
    }
    return head();
  };
  w.writeAtomic(vb, bytes);
  await w.mz.idle();
  assert.ok(injected);
  assert.ok(await w.engine.getMeta(["attempt", vb]), "committed, not finished");
  w.writeAtomic(vb, bytes); // the same bytes, another file
  await w.tick(5000);
  w.engine.head = head;
  assert.equal(await w.engine.getMeta(["attempt", vb]), undefined, "finished");
  assert.equal(new Set(ids).size, 1, "committed once");
  const s = status(w, name);
  assert.deepEqual([s.status, s.change], ["confirmed", ids[0]]);
  assert.notEqual(nonceOf(fs.readFileSync(w.abs(vb), "utf8")), nonceOf(v0.text), "printed again");
  assert.deepEqual(w.mz.log.cards, []);
  await B.stop();
});

test("review 19 #4: the bytes of the save that caused a reprint, restored after a later save, are refused 're-print', not taken as unchanged [real engine]", async (t) => {
  const { w, B, vb, name, v0 } = await setup(t);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
  const bytes = render(v0, first);
  w.writeAtomic(vb, bytes);
  await w.tick(1000);
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").opacity = 0.7));
  await w.tick(1000);
  assert.equal(status(w, name).status, "confirmed");
  w.writeAtomic(vb, bytes); // deliberately back to 0.5, on the replaced print
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").opacity, 0.7);
  assert.match(status(w, name).error ?? "", /state unknown: re-print/, "told it was refused");
  assert.deepEqual(w.mz.log.cards, []);
  await B.stop();
});
