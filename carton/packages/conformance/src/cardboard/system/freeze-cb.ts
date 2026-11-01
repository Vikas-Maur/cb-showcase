// windows-sync H8, on the real engine: during a freeze, a local agent's own `cb` commit shows in the frozen shared
// timeline.tsx at once, merged into the freeze view as its file saves are (R8-01), while the person's changes and
// remote ones stay out until the freeze ends. Before, the frozen file hid the agent's own `cb` edit for up to a minute
// (1.4.0 never did): the agent read a file without its own change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rippleDelete, remapSpan } from "@carton/core";
import type { Actor, Op } from "@carton/core";
import { fromHost, toHost } from "@carton/cardboard";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, HUMAN, type Item, type World } from "./world.ts";

const DIRECTOR: Actor = { kind: "agent", id: "director/c1/t1", name: "Director", turn: "t1", group: "local:me@m1" };
const shown = (w: World) => parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
/** A `cb` commit by `who` at head, as `@carton/local`'s runWrite makes it: committed, then the materializer told. */
async function cb(w: World, who: Actor, fn: (items: Item[]) => void) {
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  fn(items);
  const r = await w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: who });
  assert.equal(r.status, "confirmed");
  w.mz.onHeadChange("local");
  await w.tick(100);
}
const start = (t: test.TestContext) => openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] });

test("windows-sync H8: during a freeze, a hooked agent's own cb edit shows in timeline.tsx at once; the person's concurrent edit, and the person's own cb, don't; the file's next save keeps both [real engine]", async (t) => {
  const w = await start(t);
  const reads: number[] = [];
  const since = w.engine.changesSince!.bind(w.engine);
  w.engine.changesSince = (seq, o) => {
    if (o?.until === undefined) reads.push(seq);
    return since(seq, o);
  };
  await w.mz.hookRead(DIRECTOR); // its `cb` call (`tellBusy`): the shared file freezes
  await w.gui((its) => void (find(its, "b").name = "person"));
  await cb(w, DIRECTOR, (its) => void (find(its, "a").name = "agent"));
  let items = shown(w);
  assert.equal(find(items, "a").name, "agent", "the agent's own cb edit shows at once");
  assert.equal(find(items, "b").name, "b", "the person's edit stays out");
  await cb(w, HUMAN, (its) => void (find(its, "c").opacity = 0.5)); // the person's own `cb`: not an agent's
  await cb(w, DIRECTOR, (its) => void (find(its, "c").name = "agent too"));
  items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "c").name, find(items, "c").opacity], ["agent", "b", "agent too", 1]);
  assert.equal(w.mz.freeze.active, true);
  assert.equal(reads.length, 3, "each local change read the log once");
  assert.ok(reads[2]! > reads[1]! && reads[1]! > reads[0]!, "each read only the changes since the last one");
  // the agent edits the file it read, its own cb edit too: the view's base holds its cb changes, so the save is no
  // concurrent edit of them (no card), and the person's edits are kept
  const agent = w.agent(DIRECTOR.id, { hooked: true, actor: DIRECTOR });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void Object.assign(find(its, "a"), { name: "agent again", startTime: 1 }));
  await w.tick(1000);
  assert.deepEqual(w.mz.log.cards, [], "no cards");
  const h = await w.head();
  assert.deepEqual([find(h, "a").name, find(h, "a").startTime, find(h, "b").name, find(h, "c").name, find(h, "c").opacity], ["agent again", 1, "person", "agent too", 0.5]);
  await agent.stop();
  await w.tick(61_000); // its save of the file counts as a windowless agent's for a minute (§6.4)
  items = shown(w);
  assert.deepEqual([find(items, "b").name, find(items, "c").opacity], ["person", 0.5], "at the Stop the file is head");
});

test("windows-sync H8: an agent's cb edit of what the person's hidden edit changed shows at once, with what was confirmed up to it (the exact path) [real engine]", async (t) => {
  const w = await start(t);
  await w.mz.hookRead(DIRECTOR);
  await w.gui((its) => void (find(its, "a").name = "person"));
  await w.gui((its) => void (find(its, "b").name = "person b"));
  await cb(w, DIRECTOR, (its) => void (find(its, "a").name = "agent"));
  let items = shown(w);
  assert.equal(find(items, "a").name, "agent", "the agent's own edit, not the person's");
  assert.equal(find(items, "b").name, "person b", "the freeze restarted at the agent's change: what was confirmed up to it shows");
  await w.gui((its) => void (find(its, "c").name = "person later"));
  await cb(w, DIRECTOR, (its) => void (find(its, "c").opacity = 0.5));
  items = shown(w);
  assert.deepEqual([find(items, "c").name, find(items, "c").opacity], ["c", 0.5], "and later person's edits stay out again");
});

test("windows-sync H8: on a shared cut only a hooked agent's cb edit joins the freeze view, also when its confirmation is what tells of it; a remote teammate's agent (even one with the same id) stays out; on a cut only this replica writes, a windowless agent's does too [real engine]", async (t) => {
  const w = await start(t);
  w.setShared(true);
  await w.mz.hookRead(DIRECTOR);
  const theirs: Actor = { ...DIRECTOR, group: "local:bob@desk" };
  await w.remote((its) => void (find(its, "b").name = "remote agent"), theirs);
  await w.remote((its) => void (find(its, "b").opacity = 0.5), { kind: "agent", id: "codex", group: "local:bob@desk" });
  const windowless: Actor = { kind: "agent", id: "codex", name: "Codex", group: "local:me@m1" };
  await cb(w, windowless, (its) => void (find(its, "c").name = "windowless"));
  await cb(w, DIRECTOR, (its) => void (find(its, "a").name = "agent"));
  let items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "b").opacity, find(items, "c").name], ["agent", "b", 1, "c"]);
  // its next change, pending on the shared cut, is confirmed: the sync client tells of it as a remote change
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const its = structuredClone(host.timelineItems as Item[]);
  find(its, "a").opacity = 0.75;
  assert.equal((await w.carton.commit({ doc: fromHost({ ...host, timelineItems: its }, h.doc), author: DIRECTOR })).status, "confirmed");
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.equal(find(shown(w), "a").opacity, 0.75, "the agent's confirmed change shows at once, not 30 s later");
  await w.mz.hookStop(DIRECTOR);
  await w.tick(61_000);
  w.setShared(false);
  await w.mz.onCb(); // a windowless agent's `cb` call: frozen a minute
  await w.gui((its) => void (find(its, "a").name = "person"));
  await cb(w, windowless, (its) => void (find(its, "c").opacity = 0.25));
  items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "c").opacity], ["agent", 0.25], "unshared: the windowless agent's edit shows, the person's doesn't");
});

test("windows-sync H8: after a switch, during a freeze, to a cut with fewer changes, an agent's cb edit there shows at once [real engine]", async (t) => {
  const w = await start(t);
  const cut = await w.carton.fork("Cut B"); // made now: its seqs stay below main's
  for (const n of ["one", "two", "three"]) await w.gui((its) => void (find(its, "c").name = n)); // main moves on
  await w.tick(1000);
  await w.mz.hookRead(DIRECTOR);
  await cb(w, DIRECTOR, (its) => void (find(its, "a").name = "on main"));
  await w.carton.switchTo(cut.id);
  await w.mz.onCutSwitch(cut.id);
  await cb(w, DIRECTOR, (its) => void (find(its, "b").name = "on B"));
  const items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "c").name], ["a", "on B", "c"]);
  assert.ok((await w.carton.head()).ref.seq < 4, "the cut's seqs are below what was read on main");
});

test("windows-sync H8: an agent's cb ripple joins the freeze view as a change the view holds: the agent's next save from the file isn't mapped through it again [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)], tracks: ["V1"] });
  await w.mz.hookRead(DIRECTOR);
  await w.gui((its) => void (find(its, "a").name = "person")); // hidden
  // `cb` ripple: the 5 s gap before c closes, with its recorded remap
  const h = await w.carton.head();
  const maps = { V1: rippleDelete(10, 5) };
  const ops: Op[] = [];
  for (const rec of toHost(h.doc).timelineItems as Item[]) {
    const m = remapSpan(maps.V1, rec.startTime as number, rec.endTime as number);
    if (m && (m[0] !== rec.startTime || m[1] !== rec.endTime)) ops.push({ op: "set", path: ["timelineItems", rec.id, "startTime"], value: m[0] }, { op: "set", path: ["timelineItems", rec.id, "endTime"], value: m[1] });
  }
  assert.equal((await w.carton.commit({ ops, intent: { kind: "ripple-delete", maps }, base: h.ref, author: DIRECTOR })).status, "confirmed");
  w.mz.onHeadChange("local");
  await w.tick(100);
  const agent = w.agent(DIRECTOR.id, { hooked: true, actor: DIRECTOR });
  const r = await agent.read();
  assert.deepEqual([find(r.items, "a").name, find(r.items, "c").startTime, find(r.items, "d").startTime], ["a", 10, 20], "the ripple shows, the person's edit doesn't");
  await agent.editUntilDone(TIMELINE_FILE, (its) => void its.push(clip("h", 30, 35))); // right after d, where it shows
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [10, 20, 30], "h stays where the agent put it");
  assert.equal(find(head, "a").name, "person");
});
