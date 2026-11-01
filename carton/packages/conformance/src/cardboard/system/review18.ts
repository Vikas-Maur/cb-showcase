// Regressions found by review round 18 (GPT 6.1 Sol), on the real engine, history and materializer. Round 17 refused a
// save written on a view print that a reprint replaced, from a list on the view row of the last 64 such prints, filled
// once the reprint was installed. It refused the save that caused the reprint itself (finished from its attempt, or
// its bytes written again), an older displaced file's refusal cleared a newer print's sidecar, a reprint that failed left
// the print unmarked, and a print pushed off the list was taken against its header again. Now each replaced print has
// a row of its own (`["reprinted", view, nonce]`, never dropped), written before the reprint; the save that caused it
// gets through; and a displaced file from an earlier print generation never touches the newer print's sidecar or row.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { statusPath, type ViewRow } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
type Status = { status: string; error?: string; change: string | null };
const status = (w: World, name: string) => JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as Status;
const nonceOf = (text: string) => (findRev(text)!.rev as { nonce: string }).nonce;

/** B's view, a hidden remote rename of c, and B's first save repeating it (a reprint at its commit) with an edit of a. */
async function setup(t: test.TestContext, codec: TimelineCodec = jsonTimelineCodec) {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)], codec });
  // SQLite gives back independent rows: no shared references hide a mutation made before a write
  const get = w.engine.getMeta.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.getMeta = async <T,>(key: readonly string[]) => structuredClone(await get<T>(key));
  w.engine.putMeta = async (key, value) => put(key, structuredClone(value));
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
  return { w, B, vb, name, v0, first, put };
}

test("review 18 #1: the save that caused a reprint, its attempt left unsettled, is finished from its result when its displaced copy is reviewed, not refused [real engine]", async (t) => {
  const { w, B, vb, name, v0, first, put } = await setup(t);
  let injected = false;
  w.engine.putMeta = async (key, value) => {
    if (!injected && key[0] === "attempt" && key[1] === vb && value === undefined) {
      injected = true;
      throw new Error("database busy during the attempt's cleanup"); // never fatal: the slot stays
    }
    return put(key, structuredClone(value));
  };
  w.writeAtomic(vb, render(v0, first));
  await w.mz.idle();
  assert.ok(injected);
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  await w.tick(1000); // the reprint's displaced copy of the save is reviewed: unfinished, so finished from its result
  const after = status(w, name);
  assert.deepEqual([after.status, after.change], ["confirmed", before.change]);
  assert.equal(await w.engine.getMeta(["attempt", vb]), undefined, "settled");
  assert.deepEqual(w.mz.log.errors.filter((e) => !String(e.error).includes("database busy")), []);
  assert.equal(find(await w.head(), "a").opacity, 0.5);
  await B.stop();
});

test("review 18 #1: the save that caused a reprint, its bytes written again, is unchanged, not refused [real engine]", async (t) => {
  const { w, B, vb, name, v0, first } = await setup(t);
  const bytes = render(v0, first);
  w.writeAtomic(vb, bytes);
  await w.tick(1000);
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  const commits = (await w.carton.head()).ref.seq;
  w.writeAtomic(vb, bytes);
  await w.tick(1000);
  assert.deepEqual(status(w, name), before, "the sidecar keeps the save's result");
  assert.equal((await w.carton.head()).ref.seq, commits, "no commit");
  assert.deepEqual(w.mz.log.cards, []);
  // an edit on it is still refused: the print is replaced
  const second = structuredClone(first);
  find(second, "a").name = "on the replaced print";
  w.writeAtomic(vb, render(v0, second));
  await w.tick(1000);
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  assert.equal(find(await w.head(), "a").name, "a");
  await B.stop();
});

test("review 18 #2: an older print's displaced save, refused after a new print and a save on it, leaves the new print's sidecar and late updates alone [real engine]", async (t) => {
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
  const { w, B, vb, name, v0, first } = await setup(t, codec);
  const second = structuredClone(first);
  find(second, "a").name = "old buffer";
  const pin = w.engine.pin.bind(w.engine);
  let armed = true;
  w.engine.pin = async (o) => {
    const p = await pin(o);
    if (armed && o.seq !== undefined && o.owner.startsWith("turn:")) {
      armed = false;
      during = () => w.writeAtomic(vb, render(v0, second)); // lands while the reprint renders: displaced by its install
    }
    return p;
  };
  w.writeAtomic(vb, render(v0, first));
  await w.mz.idle();
  assert.equal(armed, false);
  w.engine.pin = pin;
  // before the displaced file's hold ends: B prints again and saves on the new print
  await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "fresh save"));
  await w.mz.idle();
  const before = status(w, name);
  assert.equal(before.status, "confirmed");
  await w.tick(1000); // the displaced old-buffer save is reviewed: refused
  assert.deepEqual(status(w, name), before, "the new print's sidecar is unchanged");
  assert.equal((await w.engine.getMeta<ViewRow>(["view", name]))!.lastChange, before.change, "late updates for the fresh save still reach it");
  assert.equal(find(await w.head(), "a").name, "fresh save");
  assert.ok(w.mz.log.kept.some((k) => k.path === vb), "the refused file is kept in .carton/displaced");
  assert.deepEqual(w.mz.log.cards, []);
  await B.stop();
});

test("review 18 #3: a reprint that fails leaves its print marked: the next save on it is refused, no spurious card [real engine]", async (t) => {
  let blocked = false;
  const codec: TimelineCodec = {
    ...jsonTimelineCodec,
    print: async (p, r) => {
      if (blocked) throw new Error("printer temporarily unavailable");
      return jsonTimelineCodec.print(p, r);
    },
  };
  const { w, B, vb, name, v0, first } = await setup(t, codec);
  const pin = w.engine.pin.bind(w.engine);
  let armed = true;
  w.engine.pin = async (o) => {
    const p = await pin(o);
    if (armed && o.seq !== undefined && o.owner.startsWith("turn:")) [armed, blocked] = [false, true]; // the reprint's pin
    return p;
  };
  w.writeAtomic(vb, render(v0, first));
  await w.mz.idle();
  assert.equal(armed, false);
  assert.ok(await w.engine.getMeta(["reprinted", name, nonceOf(v0.text)]), "marked before the reprint");
  blocked = false;
  w.engine.pin = pin;
  await w.remote((its) => void (find(its, "a").opacity = 0.8));
  const second = structuredClone(first);
  find(second, "a").name = "new edit";
  w.writeAtomic(vb, render(v0, second));
  await w.tick(2000);
  assert.deepEqual(w.mz.log.cards, [], "no card for B's own earlier 0.5");
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "a").opacity], ["a", 0.8]);
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  await B.stop();
});

test("review 18 #4: a print replaced 65 reprints ago is still refused [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  let v = v0;
  let first: Item[] = [];
  for (let n = 0; n < 65; n++) {
    await w.remote((its) => void (find(its, "c").name = `remote-${n}`));
    await w.tick(1);
    const its = structuredClone(v.items);
    find(its, "c").name = `remote-${n}`; // repeats the hidden rename: printed again
    if (n === 0) find(its, "a").opacity = 0.5;
    else find(its, "a").name = `own-${n}`;
    if (n === 0) first = structuredClone(its);
    w.writeAtomic(vb, render(v, its));
    await w.tick(200);
    const next = await B.read(vb);
    assert.notEqual(nonceOf(next.text), nonceOf(v.text), `printed again (${n})`);
    v = next;
  }
  await w.remote((its) => void (find(its, "a").opacity = 0.8));
  await w.tick(1);
  const late = structuredClone(first);
  find(late, "a").name = "late old buffer";
  w.writeAtomic(vb, render(v0, late));
  await w.tick(1000);
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  assert.deepEqual(w.mz.log.cards, []);
  assert.deepEqual([find(await w.head(), "a").name, find(await w.head(), "a").opacity], ["own-64", 0.8]);
  await B.stop();
});
