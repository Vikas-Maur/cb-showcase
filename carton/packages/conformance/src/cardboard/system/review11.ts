// Regressions found by review round 11 (GPT 6.1 Sol), on the real engine, history and materializer: a freeze view
// belongs to the cut it was pinned on (B6), and a pin can find a cut another process switched to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, render, parseFile, BOB, type Item } from "./world.ts";

async function commitOn(c: Carton, edit: (its: Item[]) => void): Promise<void> {
  const h = await c.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  edit(items);
  assert.equal((await c.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: BOB })).status, "confirmed");
}

test("review 11 #1: a cut another process switches to while a head-equal save is checked shows its own state, not the old cut's head [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("y", 40, 45)], tracks: ["V1", "T2"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const r0 = await A.read(); // freeze
  await w.remote((its) => void (find(its, "c").name = "main rename")); // hidden by the freeze
  await w.tick(500);
  // while the materializer pins head to check A's save, another process makes Cut B, switches to it and edits y there;
  // this handle's next store refresh finds the switch
  const realPin = w.engine.pin.bind(w.engine);
  let cutB: string | undefined;
  w.engine.pin = async (o) => {
    const p = await realPin(o);
    if (o.owner === "shared-file" && !cutB) {
      cutB = (await other.fork("Cut B")).id;
      await other.switchTo(cutB);
      await commitOn(other, (its) => void (find(its, "y").name = "Cut B edit"));
      await w.carton.head();
    }
    return p;
  };
  // agent A saves main's head (the rename it couldn't see) into the frozen shared file
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "c" ? { ...i, name: "main rename" } : i))));
  await w.tick(500);
  w.engine.pin = realPin;
  assert.ok(cutB);
  assert.equal(w.carton.cut, cutB);
  // agent B's view save regenerates the shared file from the freeze view (R7-01)
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "b's"));
  await w.tick(500);
  assert.equal(find(await w.head(), "y").name, "Cut B edit");
  const shared = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
  assert.equal(find(shared, "a").name, "b's");
  assert.equal(find(shared, "y").name, "Cut B edit", "the shared file shows Cut B, not main's head under Cut B's name");
  assert.deepEqual(w.mz.log.errors, []);
  await A.stop();
  await B.stop();
});

test("review 11 #1: a head-equal save is checked against the head of the cut it lands on, when a cut switch is found while pinning [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)], tracks: ["V1", "T2"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const r0 = await A.read(); // freeze
  const before = (await w.carton.head()).ref;
  await w.remote((its) => void (find(its, "c").name = "main rename")); // hidden by the freeze
  await w.tick(500);
  // Cut B forks from before main's rename; another process switches to it while the materializer pins head
  const realPin = w.engine.pin.bind(w.engine);
  let cutB: string | undefined;
  w.engine.pin = async (o) => {
    const p = await realPin(o);
    if (o.owner === "shared-file" && !cutB) {
      cutB = (await other.fork("Cut B", { from: before })).id;
      await other.switchTo(cutB);
      await w.carton.head();
    }
    return p;
  };
  // agent A makes the same rename as main's head: on Cut B it is a change, as if the switch had been seen a moment earlier
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "c" ? { ...i, name: "main rename" } : i))));
  await w.tick(500);
  w.engine.pin = realPin;
  assert.equal(w.carton.cut, cutB);
  assert.equal(find(await w.head(), "c").name, "main rename", "A's save lands on Cut B, not taken as unchanged against main's head");
  assert.deepEqual(w.mz.log.errors, []);
  await A.stop();
});

test("review 11 #1: a freeze starting after the handle switched cuts (before the materializer is told) starts from the new cut, not from the shared file's old cut [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("y", 40, 45)], tracks: ["V1", "T2"] });
  // local's follower switches the handle to a cut another process switched to and made an edit on; the
  // materializer hears of it at its next onExternalHeadChange
  const cut = await w.carton.fork("Cut B");
  await w.carton.switchTo(cut.id);
  await commitOn(w.carton, (its) => void (find(its, "y").name = "Cut B edit"));
  await w.mz.onCb(); // a `cb` call freezes the shared file
  // an agent's view save regenerates the shared file from the freeze view (R7-01)
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.read(vb);
  await B.editUntilDone(vb, (its) => void (find(its, "a").name = "b's"));
  await w.tick(500);
  const shared = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
  assert.equal(find(shared, "a").name, "b's");
  assert.equal(find(shared, "y").name, "Cut B edit", "the freeze view is Cut B's, not main's state under Cut B's name");
  assert.deepEqual(w.mz.log.errors, []);
  await B.stop();
});
