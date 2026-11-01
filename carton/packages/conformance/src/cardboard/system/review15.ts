// Regressions found by review round 15 (GPT 6.1 Sol), on the real engine, history and materializer. Round 14 named in a
// state's causal past the hidden changes a save "made" (every edit of the change is one the save made), read from the
// newest 64 versions. Composed changes (a ripple in two steps; one undone and redone) and a save that made part of one
// broke it, older changes fell out of the window, a cut switch during the read labelled the old cut's state with the
// new cut, and a store failure in the same-token lookup took the other cut. Now a save that repeated any edit of a change
// its base didn't hold (the whole log read back to the base) builds on the commit's own state, on the cut it went to: the
// freeze restarts there, a view is printed again there. Store failures in the lookup are thrown (the save is retried).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { branchToken, cardboardAdapter, findRev, toHost } from "@carton/cardboard";
import { TIMELINE_FILE, statusPath } from "@carton/cardboard/node";
import { openWorld, clip, find, render, parseFile, BOB, type Item } from "./world.ts";

type World = Awaited<ReturnType<typeof openWorld>>;
type Agent = ReturnType<World["agent"]>;
// y is on another track: closing the gap before c moves everything after it on V1 (a ripple, with its remap)
const ITEMS = () => [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35), clip("y", 50, 55, { trackId: "T2", type: "text", textContent: "y" })];
const at = (its: Item[], c: number, d: number) => void (Object.assign(find(its, "c"), { startTime: c, endTime: c + 10 }), Object.assign(find(its, "d"), { startTime: d, endTime: d + 10 }));
/** The remote ripple the freeze hides: the 5 s gap before c closes. */
const ripple = (its: Item[]) => at(its, 10, 20);
/** A's save: the same ripple, and a rename of its own. */
const mine = (its: Item[]) => void (ripple(its), (find(its, "a").name = "mine"));
const shown = (w: World) => parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;

async function setup(t: test.TestContext) {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name: vname } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  return { w, A, B, vb, vname, v0 };
}
/** A saves the ripple and a rename into the frozen shared file; B's view save regenerates it; A adds h right after d. */
async function saveThenInsert(w: World, A: Agent, B: Agent, vb: string, r0: Awaited<ReturnType<Agent["read"]>>) {
  const items = structuredClone(r0.items);
  mine(items);
  await A.write(TIMELINE_FILE, render(r0, items));
  await w.tick(500);
  await B.editUntilDone(vb, (its) => void (find(its, "a").opacity = 0.5));
  await w.tick(500);
  await A.read();
  await A.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35)));
  await w.tick(1000);
  const head = await w.head();
  assert.equal(find(head, "a").name, "mine");
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where A put it: no remap applied twice or skipped");
  assert.deepEqual(w.mz.log.errors, []);
}

test("review 15 #1: a hidden ripple older than the newest 64 versions is still seen in the save that repeated it [real engine]", async (t) => {
  const { w, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote(ripple);
  for (let i = 0; i < 66; i++) await w.remote((its) => void (find(its, "y").name = `remote ${i}`));
  await w.tick(500);
  await saveThenInsert(w, A, B, vb, r0);
  await A.stop();
  await B.stop();
});

test("review 15 #2: a hidden ripple undone and redone (the save repeats only the net) [real engine]", async (t) => {
  const { w, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote(ripple);
  await w.remote((its) => at(its, 15, 25));
  await w.remote(ripple);
  await w.tick(500);
  await saveThenInsert(w, A, B, vb, r0);
  await A.stop();
  await B.stop();
});

test("review 15 #2: a hidden ripple made in two steps (the save repeats their composition) [real engine]", async (t) => {
  const { w, A, B, vb } = await setup(t);
  const r0 = await A.read(); // freeze
  await w.remote((its) => at(its, 13, 23));
  await w.remote(ripple);
  await w.tick(500);
  await saveThenInsert(w, A, B, vb, r0);
  await A.stop();
  await B.stop();
});

test("review 15 #3: a view save that repeated part of a remote ripple is printed again at its commit; the next save has no spurious card [real engine]", async (t) => {
  const { w, B, vb, vname, v0 } = await setup(t);
  await w.remote(ripple); // after B's print
  await w.tick(500);
  // B moves c as the ripple did, but not d, and renames a
  const items = structuredClone(v0.items);
  Object.assign(find(items, "c"), { startTime: 10, endTime: 20 });
  find(items, "a").name = "mine";
  const nonce = () => {
    const r = findRev(fs.readFileSync(w.abs(vb), "utf8"))?.rev;
    return r?.kind === "carton" ? r.nonce : undefined;
  };
  const printed = nonce();
  w.writeAtomic(vb, render(v0, items));
  await w.tick(500);
  const again = parseFile(fs.readFileSync(w.abs(vb), "utf8"));
  assert.ok(printed && nonce() && nonce() !== printed, "printed again, with a new nonce");
  assert.deepEqual([find(again.items, "a").name, find(again.items, "d").startTime], ["mine", 20], "the view shows its commit: B's edits and the ripple confirmed before it");
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void Object.assign(find(its, "c"), { endTime: 19, trimEnd: 9 }));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual([find(head, "c").startTime, find(head, "c").endTime, find(head, "d").startTime], [10, 19, 20]);
  const status = JSON.parse(fs.readFileSync(w.abs(statusPath(vname)), "utf8"));
  assert.equal(status.status, "confirmed", JSON.stringify(status));
  assert.deepEqual(w.mz.log.errors, []);
  await B.stop();
});

test("review 15 #4: a cut another process switches to while the save's changes are read: the freeze moves to it, not the old state under its name [real engine]", async (t) => {
  const { w, A, B } = await setup(t);
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const r0 = await A.read(); // freeze
  await w.remote(ripple);
  await w.tick(500);
  // while the materializer reads the changes after A's commit, another process forks a cut from before both and
  // switches to it; local's follower adopts it on this handle
  const scan = w.engine.changesSince!.bind(w.engine);
  let armed = false;
  w.engine.changesSince = (seq, o) => ((armed = true), scan(seq, o));
  const realCheckout = w.carton.checkout.bind(w.carton);
  let alt: string | undefined;
  w.carton.checkout = async (ref) => {
    if (armed && !alt) {
      alt = (await other.fork("Alt", { from: { branchId: w.carton.cut, seq: 1 }, id: "alt-cut" })).id;
      await other.switchTo(alt);
      await w.follow();
    }
    return realCheckout(ref);
  };
  const items = structuredClone(r0.items);
  Object.assign(find(items, "c"), { startTime: 10, endTime: 20 });
  find(items, "a").name = "mine";
  await A.write(TIMELINE_FILE, render(r0, items));
  await w.tick(1000);
  w.carton.checkout = realCheckout;
  w.engine.changesSince = scan;
  assert.ok(alt);
  assert.equal(w.carton.cut, alt);
  const file = shown(w);
  const head = await w.head(); // Alt's: forked after the ripple, before A's save
  assert.equal(find(file, "a").name, "a", "the shared file shows Alt, not main's commit under Alt's name");
  assert.deepEqual(file.map((i) => [i.id, i.name, i.startTime]), head.map((i) => [i.id, i.name, i.startTime]));
  assert.deepEqual(w.mz.log.errors, [], "no rewrite fails pinning a state Alt doesn't hold");
  await A.stop();
  await B.stop();
});

test("review 15 #5: a store failure while two same-token cuts are told apart is thrown (the save is retried), not taken as the other cut [real engine]", async (t) => {
  const w = await openWorld(t, { items: ITEMS(), tracks: ["V1", "T2"] });
  const twin = await w.carton.fork("Twin", { id: `${branchToken("b6b.alt")}-other` }); // shares b6b.alt's token
  const cut = await w.carton.fork("Alt", { id: "b6b.alt" });
  await w.carton.switchTo(cut.id);
  await w.mz.onCutSwitch(cut.id);
  await w.gui((its) => void (find(its, "a").name = "on the printed cut")); // its seq is past the twin's head
  await w.tick(500);
  const B = w.agent("director/c2/t2", { hooked: true, actor: { turn: "t2", chat: "c2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  const rev = findRev(fs.readFileSync(w.abs(vb), "utf8"))!.rev!;
  await w.carton.switchTo(twin.id); // the twin is current, and lacks that seq
  const realResolve = w.carton.resolve.bind(w.carton);
  let failed = false;
  w.carton.resolve = async (ref) => {
    if (!failed && typeof ref === "object" && ref.branchId === cut.id) {
      failed = true;
      throw new Error("database is locked");
    }
    return realResolve(ref);
  };
  await assert.rejects(w.engine.resolve(rev), /database is locked/);
  w.carton.resolve = realResolve;
  const held = await w.engine.resolve(rev); // the retry
  assert.equal(find(toHost(held.baseDoc).timelineItems as Item[], "a").name, "on the printed cut");
});
