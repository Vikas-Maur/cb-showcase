// The shared timeline.tsx has several writers, on the real engine, history and materializer (port of system-v11
// `r7-r8-shared-file.test.mjs`; the controls that exercised superseded rules, v7/v8/v9, are not ported: those rules are
// not in the build).
// R7-01: it is regenerated with a new header after every applied save, so a save's base is always its own header ref.
// R8-01: during a freeze the file is the freeze view: the freeze-start state plus every local agent's applied saves,
// each merged with that save's own base; non-agent changes wait for the freeze to end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Materializer, cartonMaterializerEngine, TIMELINE_FILE, viewPath } from "@carton/cardboard/node";
import { cardboardFilesHost, jsonTimelineCodec } from "@carton/cardboard";
import { openWorld, clips, clip, text, find, render, parseFile } from "./world.ts";

const base = () => [...clips(3), text("titleX", "a"), text("titleY", "b")];

async function staleWriter(t: test.TestContext, gapMs: number) {
  const w = await openWorld(t, { items: base() });
  const B = w.agent("writer-B (checks)", { checks: true });
  const A = w.agent("writer-A (no check)", { checks: false });
  const r0 = await A.read(); // A's read: R0
  await B.read();
  await B.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "titleY").textContent = "B"));
  await w.tick(gapMs);
  await A.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "A" } : i)))); // whole file from R0
  await w.tick(3000);
  return { w, head: await w.head() };
}

test(`R7-01 stale writer on the shared file: "B" kept, the stale writer's "A" lands [real engine]`, async (t) => {
  const { w, head } = await staleWriter(t, 5000);
  assert.equal(find(head, "titleY").textContent, "B", "B kept, not silently reverted");
  assert.equal(find(head, "titleX").textContent, "A", "the stale writer's own edit landed");
  const applied = w.mz.log.applied.filter((a) => a.path === TIMELINE_FILE);
  assert.equal(applied.length, 2, "both saves applied");
  assert.equal(applied.reduce((n, a) => n + Number(a.cards ?? 0), 0), 0, "no card");
});

test(`reads on every watch event: a stale whole-file write 60 ms after B's save doesn't replace it; both land [real engine]`, async (t) => {
  const { head } = await staleWriter(t, 60);
  assert.equal(find(head, "titleY").textContent, "B");
  assert.equal(find(head, "titleX").textContent, "A");
});

test(`displacement: a cb print lands on a foreign save before its watch event; the save is applied first, and the same writer's next save lands too, each once, in order [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const r0 = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  const edit = (fn: (i: { id: string; [k: string]: unknown }) => object) => render(r0, r0.items.map((i) => ({ ...i, ...fn(i) })));
  fs.writeFileSync(w.abs(TIMELINE_FILE), edit((i) => (i.id === "titleX" ? { textContent: "v1" } : {}))); // no event yet
  await w.mz.printShared(); // another agent's `cb source print`
  w.writeAtomic(TIMELINE_FILE, edit((i) => (i.id === "titleX" ? { textContent: "v1" } : i.id === "c0" ? { name: "v2" } : {})));
  await w.tick(3000);
  const head = await w.head();
  assert.deepEqual([find(head, "titleX").textContent, find(head, "c0").name], ["v1", "v2"]);
  const ext = w.mz.log.applied.filter((a) => a.actor === "external:timeline.tsx");
  assert.equal(ext.length, 2, "each save applied once");
  assert.ok(Number(ext[0]!.t) <= Number(ext[1]!.t), "in write order");
});

test(`in-place writer: a partial file is not applied; the complete file is applied once; a file that never parses is kept and reported [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const r0 = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  const full = render(r0, r0.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "A" } : i)));
  w.writeInPlace(TIMELINE_FILE, full.slice(0, full.length >> 1));
  await w.tick(80);
  w.writeInPlace(TIMELINE_FILE, full);
  await w.tick(3000);
  assert.equal(find(await w.head(), "titleX").textContent, "A");
  assert.equal(w.mz.log.applied.filter((a) => a.path === TIMELINE_FILE && !a.error).length, 1, "applied once");
  w.writeInPlace(TIMELINE_FILE, "// cardboard:rev x by y\n{not json");
  await w.tick(3000);
  assert.equal(w.mz.log.unparsed.length, 1, "kept and reported, never applied");
});

test(`displaced partial: a half-written file displaced by a print is reported to its writer, not dropped silently; the completed save lands [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const r0 = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  const full = render(r0, r0.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "A" } : i)));
  fs.writeFileSync(w.abs(TIMELINE_FILE), full.slice(0, full.length >> 1));
  await w.mz.printShared();
  await w.tick(400);
  w.writeInPlace(TIMELINE_FILE, full);
  await w.tick(3000);
  assert.equal(w.mz.log.unparsed.filter((u) => u.displaced).length, 1, "the displaced partial is recorded");
  const notices = await w.carton.notices({ kind: "external", id: "external:timeline.tsx" });
  assert.ok(notices.some((n) => /doesn't parse/.test(n.text)), "its writer is told");
  assert.equal(find(await w.head(), "titleX").textContent, "A", "the completed save landed");
});

test(`app closed: a foreign save nobody watched is imported before a print, and before the next app start's regeneration [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const r0 = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  await w.mz.close(); // the app quits
  fs.writeFileSync(w.abs(TIMELINE_FILE), render(r0, r0.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "offline edit" } : i))));
  // the app starts again: a new materializer (a new process) on the same carton.db
  const mz2 = new Materializer({ bundle: w.bundle, engine: cartonMaterializerEngine(w.carton, { clock: () => w.clock.now() }), host: cardboardFilesHost, codec: jsonTimelineCodec, clock: w.clock });
  t.after(() => mz2.close());
  await mz2.start();
  assert.equal(find(await w.head(), "titleX").textContent, "offline edit");
  assert.equal(mz2.log.imported.length, 1);
  assert.ok(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8").includes("offline edit"), "the regenerated file shows it");
});

test(`headless view re-print (app closed): the agent's unseen view save is applied before the re-print [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const agent = w.agent("agent-ab12", { checks: true });
  const { path: rel } = await w.mz.printView("agent-ab12", agent.actor);
  const r = await agent.read(rel);
  fs.writeFileSync(w.abs(rel), render(r, r.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "view edit" } : i)))); // nobody watching
  await w.mz.printView("agent-ab12", agent.actor);
  await w.tick(3000);
  assert.equal(find(await w.head(), "titleX").textContent, "view edit");
  assert.ok(fs.readFileSync(w.abs(viewPath("agent-ab12")), "utf8").includes("view edit"), "the re-print shows it");
});

test(`R7-01 with B1: a hooked turn that printed the shared file's state ends; a legacy writer's save from that header still applies [real engine]`, async (t) => {
  const w = await openWorld(t, { items: base() });
  const legacy = w.agent("legacy (no check)", { checks: false });
  const r0 = await legacy.read();
  const hooked = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const pr = await w.mz.printView("director_c_t1", hooked.actor, { hooked: true });
  assert.equal(pr.ref, r0.ref, "the turn pinned the same state the shared file's header names");
  await hooked.stop();
  await legacy.write(TIMELINE_FILE, render(r0, r0.items.map((i) => (i.id === "titleX" ? { ...i, textContent: "A" } : i))));
  await w.tick(2000);
  assert.equal(find(await w.head(), "titleX").textContent, "A", "applied: the shared file's own pin outlives the turn's");
});

test(`R8-01 freeze view: two agents (one stale) see each other's applied edits; the remote change waits for the freeze to end; no duplicates [real engine]`, async (t) => {
  const w = await openWorld(t, { items: clips(10, "clip"), tracks: ["V1", "T2"] });
  const Bag = w.agent("director/c/t1", { hooked: true, checks: true, actor: { turn: "t1" } });
  const Aag = w.agent("terminal (no check)", { checks: false });
  await Bag.read(); // B's hooked read starts the freeze
  const a0 = await Aag.read(); // A reads the same R0
  assert.ok(w.mz.freeze.active);
  await w.remote((its) => void (find(its, "clip9").name = "remote edit"));
  await w.tick(2000);
  assert.equal(find(await w.head(), "clip9").name, "remote edit", "the remote change reached head");
  await Bag.editUntilDone(TIMELINE_FILE, (its) => void its.push(text("title_b7", "Title by B")));
  await w.tick(1000);
  await Aag.write(TIMELINE_FILE, render(a0, a0.items.map((i) => (i.id === "clip1" ? { ...i, endTime: 9, trimEnd: 4 } : i))));
  await w.tick(1000);
  const bSees = (await Bag.read()).items;
  const aSees = (await Aag.read()).items;
  assert.equal(find(bSees, "clip1").endTime, 9, "B sees A's applied edit");
  assert.ok(find(aSees, "title_b7"), "A sees B's applied edit");
  for (const d of [bSees, aSees]) assert.equal(find(d, "clip9").name, "clip9", "the remote change stays hidden during the freeze");
  await Bag.stop();
  await w.tick(70_000); // A's 60 s windowless freeze runs out
  const after = (await Aag.read()).items;
  assert.equal(find(after, "clip9").name, "remote edit", "after the freeze the file is head");
  const head = await w.head();
  assert.equal(head.filter((i) => i.textContent === "Title by B").length, 1, "no duplicate title in head");
  assert.equal(find(head, "clip1").endTime, 9);
});

void clip;
