// Regressions found by review round 17 (GPT 6.1 Sol), on the real engine, history and materializer. Round 16 kept, for a
// save written on a print that a reprint replaced, the agent's saved content as its base at the commit's seq. That base
// took as seen the part of a hidden change the save never repeated (a remote edit overwritten without a card; a ripple's
// unseen part left unmapped), broke a retry's identity, was used on another cut, and was lost to a save on the new print.
// No base describes such a save: it is refused "state unknown: re-print", and the agent redoes its edits on a new print.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev } from "@carton/cardboard";
import { statusPath, type ViewRow } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
const status = (w: World, name: string) => JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as { status: string; error?: string; change: string | null };
const nonce = (w: World, vb: string) => {
  const r = findRev(fs.readFileSync(w.abs(vb), "utf8"))?.rev;
  return r?.kind === "carton" ? r.nonce : null;
};

async function view(w: World) {
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  return { B, vb, name, v0: await B.read(vb) };
}

test("review 17 #1: a save on the replaced print, after a save that repeated only part of a hidden change, never overwrites the rest without a card [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const { B, vb, name, v0 } = await view(w);
  await w.remote((its) => void ((find(its, "c").name = "remote"), (find(its, "a").opacity = 0.8))); // one hidden change
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote"; // repeats its rename, not its opacity
  find(first, "a").name = "mine";
  w.writeAtomic(vb, render(v0, first));
  await w.tick(1000);
  assert.notEqual(nonce(w, vb), (findRev(v0.text)!.rev as { nonce: string }).nonce, "printed again");
  const second = structuredClone(first);
  find(second, "a").opacity = 0.5; // B never saw 0.8
  w.writeAtomic(vb, render(v0, second));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "a").opacity], ["mine", 0.8], "0.8 kept: B's 0.5 is not applied over it unseen");
  assert.deepEqual(w.mz.log.cards, []);
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  // redone on a new print, where B sees 0.8: a deliberate edit
  await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").opacity = 0.5));
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").opacity, 0.5);
  assert.deepEqual(w.mz.log.cards, []);
  assert.equal(status(w, name).status, "confirmed");
  await B.stop();
});

test("review 17 #1: a save on the replaced print, after a save that repeated part of a hidden ripple, isn't applied unmapped; redone on a new print it follows d [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)] });
  const { B, vb, name, v0 } = await view(w);
  await w.remote((its) => {
    for (const id of ["c", "d"]) Object.assign(find(its, id), { startTime: Number(find(its, id).startTime) - 5, endTime: Number(find(its, id).endTime) - 5 });
  });
  await w.tick(500);
  const first = structuredClone(v0.items);
  Object.assign(find(first, "c"), { startTime: 10, endTime: 20 }); // c moved as the ripple did, not d
  find(first, "a").name = "mine";
  w.writeAtomic(vb, render(v0, first));
  await w.tick(1000);
  const cards = w.mz.log.cards.length; // core's remap card on this save's c (inside the range the remote closed)
  const second: Item[] = [...structuredClone(first), clip("h", 35, 40)]; // right after d, as B's buffer shows it
  w.writeAtomic(vb, render(v0, second));
  await w.tick(1000);
  assert.equal((await w.head()).find((i) => i.id === "h"), undefined, "not applied at 35, a gap after d (20-30)");
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  await w.mz.printView("vb", B.actor, { hooked: true });
  const r = await B.read(vb);
  const end = Number(find(r.items, "d").endTime);
  await B.editUntilDone(vb, (its) => void its.push(clip("h", end, end + 5)));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30]);
  assert.equal(w.mz.log.cards.length, cards, "no card from the later saves");
  assert.deepEqual(w.mz.log.errors, []);
  await B.stop();
});

test("review 17 #2: a save that is printed again, retried after a failure once its row is written, keeps its change id; the old print's next save is refused [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  // SQLite gives back independent rows: no shared references hide a mutation made before a write
  const get = w.engine.getMeta.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.getMeta = async <T,>(key: readonly string[]) => structuredClone(await get<T>(key));
  w.engine.putMeta = async (key, value) => put(key, structuredClone(value));
  const { B, vb, name, v0 } = await view(w);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const ids: string[] = [];
  const commit = w.engine.commit.bind(w.engine);
  w.engine.commit = async (input) => (ids.push(input.id ?? "(none)"), commit(input));
  const head = w.engine.head.bind(w.engine);
  let injected = false;
  w.engine.head = async () => {
    const row = await w.engine.getMeta<ViewRow>(["view", name]);
    if (!injected && ids.length && row?.lastChange) {
      injected = true;
      await w.remote((its) => void (find(its, "a").opacity = 0.8));
      throw new Error("store busy after the view row was written");
    }
    return head();
  };
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").name = "mine";
  w.writeAtomic(vb, render(v0, first));
  await w.tick(5000);
  w.engine.head = head;
  assert.ok(injected);
  assert.equal(new Set(ids).size, 1, `one change id for every attempt: ${ids.join(", ")}`);
  assert.equal(await w.engine.getMeta(["attempt", vb]), undefined, "finished");
  const row = (await w.engine.getMeta<ViewRow>(["view", name]))!;
  const printed = findRev(v0.text)!.rev as { nonce: string };
  assert.deepEqual([row.reprinted, nonce(w, vb) === row.nonce, row.nonce !== printed.nonce], [[printed.nonce], true, true], "printed again, once");
  assert.equal(status(w, name).change, ids[0]);
  const second = structuredClone(first);
  find(second, "a").name = "second";
  w.writeAtomic(vb, render(v0, second));
  await w.tick(1000);
  assert.equal(ids.length, 1, "the old print's save makes no commit");
  const end = await w.head();
  assert.deepEqual([find(end, "a").name, find(end, "a").opacity], ["mine", 0.8]);
  assert.deepEqual(w.mz.log.cards, []);
  await B.stop();
});

test("review 17 #3: a save on the replaced print after a cut switch is refused 're-print', not rejected for an unknown base; redone, it lands on the new cut [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const { B, vb, name, v0 } = await view(w);
  const alt = await w.carton.fork("Alt");
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
  w.writeAtomic(vb, render(v0, first));
  await w.tick(1000);
  await w.carton.switchTo(alt.id);
  await w.mz.onCutSwitch(alt.id);
  const second = structuredClone(first);
  find(second, "a").name = "on Alt";
  w.writeAtomic(vb, render(v0, second));
  await w.tick(1000);
  const s = status(w, name);
  assert.equal(s.status, "error");
  assert.match(s.error ?? "", /state unknown: re-print/);
  assert.equal(find(await w.head(), "a").name, "a");
  await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "on Alt"));
  await w.tick(1000);
  assert.equal(w.carton.cut, alt.id);
  assert.deepEqual([find(await w.head(), "a").name, find(await w.head(), "a").opacity], ["on Alt", 1]);
  assert.equal(status(w, name).status, "confirmed");
  assert.deepEqual(w.mz.log.cards, []);
  assert.deepEqual(w.mz.log.errors, []);
  await B.stop();
});

test("review 17 #4: a save on the replaced print after a save on the new one: still refused, no spurious card [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const { B, vb, name, v0 } = await view(w);
  await w.remote((its) => void (find(its, "c").name = "remote"));
  await w.tick(500);
  const first = structuredClone(v0.items);
  find(first, "c").name = "remote";
  find(first, "a").opacity = 0.5;
  w.writeAtomic(vb, render(v0, first));
  await w.tick(1000);
  const v1 = await B.read(vb); // the new print
  await B.editUntilDone(vb, (its) => void (find(its, "c").opacity = 0.6));
  await w.tick(1000);
  assert.equal(status(w, name).status, "confirmed");
  await w.remote((its) => void (find(its, "a").opacity = 0.8));
  await w.tick(500);
  const late = structuredClone(first);
  find(late, "a").name = "late old buffer";
  w.writeAtomic(vb, render(v0, late));
  await w.tick(1000);
  assert.ok(v1.items.length);
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "a").opacity, find(head, "c").opacity], ["a", 0.8, 0.6]);
  assert.deepEqual(w.mz.log.cards, [], "no card for B's own earlier 0.5");
  assert.match(status(w, name).error ?? "", /state unknown: re-print/);
  await B.stop();
});
