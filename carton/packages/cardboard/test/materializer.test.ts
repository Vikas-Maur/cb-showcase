// The materializer (§6.4) on real files, with a fake clock and a fake engine: the shared timeline.tsx (R7-01
// regeneration, R8-01 freeze view, R5-05 spacing), displace-then-install over unread saves, quiescence for in-place
// writers, per-agent views (R4-02 base, Finding 3 nonce, R5-03), the status sidecar (R5-04), app-closed imports.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Materializer, TIMELINE_FILE, PROJECT_FILE, viewPath, statusPath, turnOwner, type ViewRow } from "../src/node/materializer.ts";
import { jsonTimelineCodec } from "../src/codec.ts";
import { findRev } from "../src/header.ts";
import { FakeClock, FakeEngine, plainHost } from "./helpers/fake-engine.ts";
import { cardboardFilesHost } from "../src/index.ts";

type Item = { id: string; [k: string]: unknown };

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const clip = (id: string, s: number, e: number, extra: Record<string, unknown> = {}): Item => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...extra });

async function setup(t: test.TestContext, items: Item[], opts: { start?: boolean } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  const project = { id: "p1", name: "Demo", stateUpdatedAt: 1, timelineItems: items };
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }));
  const engine = new FakeEngine({ name: "Demo", timelineItems: items });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock });
  t.after(() => mz.close());
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  await engine.putMeta(["file", PROJECT_FILE, "pin"], (await engine.pin({ owner: "project-file", ttlMs: 1 })).ref);
  await mz.adoptCurrentFiles();
  if (opts.start !== false) await mz.start();
  const abs = (rel: string) => path.join(bundle, ...rel.split("/"));
  const read = (rel = TIMELINE_FILE) => {
    const text = fs.readFileSync(abs(rel), "utf8");
    const f = findRev(text)!;
    return { text, rev: f.rev!, line: f.line, items: (JSON.parse(text.slice(f.end)).timelineItems ?? []) as Item[] };
  };
  // Builds a save from an earlier read: same header line, edited items.
  const edited = (r: { text: string; items: Item[]; line: string }, fn: (items: Item[]) => void) => {
    const its = JSON.parse(JSON.stringify(r.items)) as Item[];
    fn(its);
    return `// edited\n${r.line}\n${JSON.stringify({ timelineItems: its })}\n`;
  };
  let k = 0;
  const writeAtomic = (rel: string, content: string) => {
    const tmp = abs(`.${path.basename(rel)}.${k++}.tmp`);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs(rel));
  };
  const writeInPlace = (rel: string, content: string) => fs.writeFileSync(abs(rel), content);
  const tick = (ms: number) => clock.advance(ms, () => mz.idle());
  const event = async (rel = TIMELINE_FILE) => {
    mz.onFsEvent(rel);
    await tick(2);
  };
  const head = async () => (await engine.head()).timelineItems as Item[];
  const find = (its: Item[], id: string) => its.find((i) => i.id === id)!;
  return { bundle, engine, clock, mz, abs, read, edited, writeAtomic, writeInPlace, tick, event, head, find };
}

test("start writes timeline.tsx under a Carton header whose ref resolves", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r = s.read();
  assert.equal(r.rev.kind, "carton");
  assert.match(r.line, /^\/\/ cardboard:rev main@0~[0-9a-f]{8} b:b7e1c2d3 p:[0-9a-f]{8} by carton$/);
  assert.deepEqual(r.items, [clip("a", 0, 5)]);
  assert.ok(await s.engine.resolve(r.rev));
});

test("R7-01: a foreign save applies with its header ref as base, then the file is regenerated with a new header", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r0 = s.read();
  s.writeAtomic(TIMELINE_FILE, s.edited(r0, (its) => (its[0]!.name = "renamed")));
  await s.event();
  assert.equal(s.find(await s.head(), "a").name, "renamed");
  const r1 = s.read();
  assert.notEqual(r1.line, r0.line, "a new header after the applied save");
  assert.equal(s.find(r1.items, "a").name, "renamed");
  assert.equal(s.engine.commits[0]!.author.id, "external:timeline.tsx");
  assert.equal(s.engine.commits[0]!.base, (r0.rev as { ref: string }).ref);
});

test("R7-01 stale writer: B's checked save is kept and the stale writer's own edit lands", async (t) => {
  const s = await setup(t, [clip("titleX", 0, 3, { textContent: "a" }), clip("titleY", 0, 3, { textContent: "b" })]);
  const r0 = s.read(); // writer A reads R0 and keeps it
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => (its[1]!.textContent = "B"))); // B saves
  await s.event();
  await s.tick(5000);
  s.writeAtomic(TIMELINE_FILE, s.edited(r0, (its) => (its[0]!.textContent = "A"))); // A writes the whole file from R0
  await s.event();
  const h = await s.head();
  assert.equal(s.find(h, "titleY").textContent, "B", "B kept, not silently reverted");
  assert.equal(s.find(h, "titleX").textContent, "A", "the stale writer's edit landed");
  assert.equal(s.mz.log.applied.length, 2);
});

test("an unread save is applied before a print renders; the writer's next save lands too; each once, in order", async (t) => {
  const s = await setup(t, [clip("titleX", 0, 3, { textContent: "a" }), clip("c0", 3, 6)]);
  const r0 = s.read();
  s.writeAtomic(TIMELINE_FILE, s.edited(r0, (its) => (its[0]!.textContent = "v1")));
  await s.mz.printShared(); // another agent's `cb source print`, before the save's watch event
  assert.equal(s.find(s.read().items, "titleX").textContent, "v1", "the print shows the save");
  s.writeAtomic(TIMELINE_FILE, s.edited(r0, (its) => ((its[0]!.textContent = "v1"), (its[1]!.name = "v2"))));
  await s.event(); // the first save's stale event reads the second save
  await s.tick(500);
  const h = await s.head();
  assert.deepEqual([s.find(h, "titleX").textContent, s.find(h, "c0").name], ["v1", "v2"]);
  const ext = s.mz.log.applied.filter((a) => a.actor === "external:timeline.tsx");
  assert.equal(ext.length, 2, "each save applied once");
  assert.equal(new Set(ext.map((a) => a.hash)).size, 2);
  assert.equal(s.engine.commits.length, 2);
});

test("displacement: a foreign save landing while Carton renders is moved aside, not overwritten, and applied", async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "Demo", timelineItems: [clip("titleX", 0, 3, { textContent: "a" })] }, media: [] }));
  const engine = new FakeEngine({ name: "Demo", timelineItems: [clip("titleX", 0, 3, { textContent: "a" })] });
  const clock = new FakeClock();
  let race: (() => void) | null = null;
  // a codec whose print lets a foreign writer land its save mid-render (between the unread-save check and the install)
  const codec = { ...jsonTimelineCodec, print: (p: Record<string, unknown>, rev: string) => (race?.(), (race = null), jsonTimelineCodec.print(p, rev)) };
  const mz = new Materializer({ bundle, engine, host: plainHost, codec, clock, writeProject: false });
  t.after(() => mz.close());
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  await mz.start();
  const text = fs.readFileSync(path.join(bundle, TIMELINE_FILE), "utf8");
  race = () => fs.writeFileSync(path.join(bundle, TIMELINE_FILE), text.replace('"a"', '"raced"'));
  await mz.printShared();
  assert.ok(fs.readFileSync(path.join(bundle, TIMELINE_FILE), "utf8").includes('"a"'), "Carton's print is installed");
  await clock.advance(500, () => mz.idle()); // held for the ownership check, then found foreign
  assert.equal(mz.log.displaced.length, 1, "moved aside");
  assert.equal(((await engine.head()).timelineItems as Item[])[0]!.textContent, "raced", "applied");
  assert.ok(fs.readFileSync(path.join(bundle, TIMELINE_FILE), "utf8").includes('"raced"'), "the regenerated file shows it");
  assert.equal(fs.readdirSync(path.join(bundle, ".carton", "displaced")).length, 0, "nothing left behind once applied and checked");
});

test("an in-place writer: a partial file waits for quiet and the complete file is applied once; a file that never parses is reported once and kept", async (t) => {
  const s = await setup(t, [clip("titleX", 0, 3, { textContent: "a" })]);
  const full = s.edited(s.read(), (its) => (its[0]!.textContent = "A"));
  s.writeInPlace(TIMELINE_FILE, full.slice(0, full.length >> 1));
  await s.event();
  assert.equal(s.mz.log.applied.length, 0, "a partial file is not applied");
  await s.tick(80);
  s.writeInPlace(TIMELINE_FILE, full);
  await s.event();
  await s.tick(300);
  assert.equal(s.find(await s.head(), "titleX").textContent, "A");
  assert.equal(s.mz.log.applied.length, 1);
  s.writeInPlace(TIMELINE_FILE, "// cardboard:rev main@0~00000000 by y\n{not json");
  await s.event();
  await s.tick(400);
  assert.equal(s.mz.log.unparsed.length, 1, "reported once");
  assert.ok(s.engine.notices.some((n) => n.to === "external:timeline.tsx" && /doesn't parse/.test(n.text)));
  assert.equal(fs.readFileSync(s.abs(TIMELINE_FILE), "utf8"), "// cardboard:rev main@0~00000000 by y\n{not json", "kept where its writer put it");
  await s.tick(2000);
  assert.equal(s.mz.log.unparsed.length, 1, "not reported again");
});

test("a half-written file displaced by a print is reported to its writer and kept; the completed save lands", async (t) => {
  const s = await setup(t, [clip("titleX", 0, 3, { textContent: "a" })]);
  const full = s.edited(s.read(), (its) => (its[0]!.textContent = "A"));
  s.writeInPlace(TIMELINE_FILE, full.slice(0, full.length >> 1));
  await s.mz.printShared();
  await s.tick(400);
  assert.equal(s.mz.log.unparsed.filter((u) => u.displaced).length, 1, "the displaced partial is recorded");
  assert.ok(s.engine.notices.some((n) => /moved aside\) doesn't parse/.test(n.text)), "its writer is told");
  assert.ok(fs.readdirSync(path.join(s.bundle, ".carton", "displaced")).length >= 1, "kept on disk");
  s.writeInPlace(TIMELINE_FILE, full);
  await s.event();
  assert.equal(s.find(await s.head(), "titleX").textContent, "A", "the completed save landed");
});

test("app closed: a foreign save nobody watched is imported before a print or the start-up regeneration overwrites it", async (t) => {
  const s = await setup(t, [clip("titleX", 0, 3, { textContent: "a" })]);
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => (its[0]!.textContent = "offline edit"))); // no event
  await s.mz.printShared();
  assert.equal(s.find(await s.head(), "titleX").textContent, "offline edit");
  assert.equal(s.mz.log.imported.length, 1);
  assert.ok(fs.readFileSync(s.abs(TIMELINE_FILE), "utf8").includes("offline edit"), "the print shows it");
  assert.equal(s.engine.commits.length, 1, "applied once");
});

test("R4-02 per-agent view: the base of a save is the last applied save of the same print, so a human trim between saves survives", async (t) => {
  for (const viewBase of ["lastSave", "header"] as const) {
    const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
    const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
    const { path: rel } = await s.mz.printView("director_c_t1", agent, { hooked: true });
    const v0 = s.read(rel);
    s.writeAtomic(rel, s.edited(v0, (its) => Object.assign(its[0]!, { endTime: 19, trimEnd: 9 })));
    await s.event(rel);
    s.engine.external((d) => Object.assign((d.timelineItems as Item[])[0]!, { endTime: 18.5, trimEnd: 8.5 })); // the human trims
    if (viewBase === "header") {
      // control (v4): forget the last applied save, so the header ref is the base
      const row = (await s.engine.getMeta<ViewRow>(["view", "director_c_t1"]))!;
      await s.engine.putMeta(["view", "director_c_t1"], { ...row, last: null });
    }
    // save 2: the agent's file still shows its own save 1; it renames Y
    s.writeAtomic(rel, s.edited({ ...v0, items: [{ ...v0.items[0]!, endTime: 19, trimEnd: 9 }, v0.items[1]!] }, (its) => (its[1]!.name = "renamed")));
    await s.event(rel);
    const h = await s.head();
    assert.equal(s.find(h, "Y").name, "renamed");
    if (viewBase === "lastSave") {
      assert.deepEqual([s.find(h, "X").endTime, s.find(h, "X").trimEnd], [18.5, 8.5], "the human's trim survives");
      assert.equal(s.engine.commits.at(-1)!.base, "held");
      const status = JSON.parse(fs.readFileSync(s.abs(statusPath("director_c_t1")), "utf8"));
      assert.equal(status.status, "confirmed");
      assert.equal(status.change, s.engine.commits.at(-1)!.id);
      assert.match(status.ref, /^main@\d+~[0-9a-f]{8} b:[0-9a-f]{8}$/, "a ref core can resolve");
    } else {
      assert.ok(s.engine.commits.at(-1)!.cards >= 1, "control: the header base re-merges save 1 and clashes with the human");
    }
  }
});

test("Finding 3: a view saved, re-printed before the save was read, and saved again from the re-print keeps the first save", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("v", agent, { hooked: true });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "first")));
  await s.mz.printView("v", agent, { hooked: true }); // same state, new nonce; displaces the unread save
  await s.tick(400);
  assert.equal(s.find(s.read(rel).items, "X").name, "first", "the displaced save was applied before the re-print rendered... or right after");
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "second")));
  await s.event(rel);
  const h = await s.head();
  assert.deepEqual([s.find(h, "X").name, s.find(h, "Y").name], ["first", "second"]);
});

test("R5-03: a view file that was never printed is never applied", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  const r0 = s.read();
  fs.writeFileSync(s.abs(viewPath("stranger")), s.edited(r0, (its) => (its[0]!.name = "nope")));
  await s.event(viewPath("stranger"));
  assert.equal(s.find(await s.head(), "X").name, "X");
  assert.equal(s.mz.log.ignored.length, 1);
});

test("§4.4 expired ref: a view save whose pin was released fails loudly in its status sidecar, never a 2-way merge", async (t) => {
  const s = await setup(t, [clip("c0", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t9", turn: "t9" };
  const { path: rel } = await s.mz.printView("t9", agent, { hooked: true });
  const v = s.read(rel);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "moved on"));
  await s.mz.hookStop(agent); // the turn ends: its pins go
  for (const p of s.engine.pins.values()) p.owners.clear();
  s.engine.pins.clear();
  s.writeAtomic(rel, s.edited(v, (its) => (its[0]!.name = "late")));
  await s.event(rel);
  const status = JSON.parse(fs.readFileSync(s.abs(statusPath("t9")), "utf8"));
  assert.equal(status.status, "error");
  assert.match(status.error, /state unknown: re-print/);
  assert.equal(s.find(await s.head(), "c0").name, "moved on", "nothing applied");
});

test("R8-01 freeze view: during a hooked turn non-agent changes stay out of the shared file, agents' saves accumulate, and the file becomes head when the turn ends", async (t) => {
  const s = await setup(t, [clip("clip1", 0, 10), clip("clip9", 10, 20)]);
  const agentB = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  await s.mz.hookRead(agentB);
  const a0 = s.read(); // agent A (no hooks) reads the same R0
  s.engine.external((d) => ((d.timelineItems as Item[])[1]!.name = "remote edit"));
  s.mz.onHeadChange("remote");
  await s.tick(100);
  assert.equal(s.find(s.read().items, "clip9").name, "clip9", "the remote change is hidden during the freeze");
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => its.push(clip("title_b7", 0, 3, { textContent: "Title by B" }))));
  await s.event();
  s.writeAtomic(TIMELINE_FILE, s.edited(a0, (its) => Object.assign(its[0]!, { endTime: 9, trimEnd: 9 }))); // stale A
  await s.event();
  const during = s.read().items;
  assert.ok(s.find(during, "title_b7"), "A's re-read shows B's applied edit");
  assert.equal(s.find(during, "clip1").endTime, 9, "B's re-read shows A's applied edit");
  assert.equal(s.find(during, "clip9").name, "clip9", "the remote change still hidden");
  await s.mz.hookStop(agentB);
  await s.tick(61_000); // A's windowless 60 s runs out
  const after = s.read().items;
  assert.equal(s.find(after, "clip9").name, "remote edit", "after the freeze the file is head");
  const h = await s.head();
  assert.equal(h.filter((i) => i.textContent === "Title by B").length, 1, "no duplicate in head");
});

/** Pin owners the fake engine still holds for hooked turns. */
const turnPins = (s: { engine: FakeEngine }): string[] => [...new Set([...s.engine.pins.values()].flatMap((p) => [...p.owners]))].filter((o) => o.startsWith("turn:")).sort();

test("local-cli H8: a Director subagent's Stop releases only its own pins; the Director keeps its view and the freeze; the turn's own Stop releases everything, a subagent's whose Stop was lost too", async (t) => {
  const s = await setup(t, [clip("X", 0, 10)]);
  const director = { kind: "agent" as const, id: "director/c/t4", turn: "t4" };
  const sub = { kind: "subagent" as const, id: "director/c/t4/sub-explore-ab12", turn: "t4", agentType: "explore", agentId: "ab12" };
  const lost = { kind: "subagent" as const, id: "director/c/t4/sub-explore-cd34", turn: "t4", agentType: "explore", agentId: "cd34" };
  await s.mz.hookRead(director);
  await s.mz.printView("d", director, { hooked: true });
  for (const a of [sub, lost]) {
    await s.mz.hookRead(a);
    await s.mz.printView(a.agentId, a, { hooked: true });
  }
  await s.mz.hookStop(sub);
  assert.deepEqual(turnPins(s), [turnOwner(director), turnOwner(lost)].sort(), "only the subagent's own pin went");
  assert.equal(s.mz.freeze.active, true, "the shared file stays frozen for the Director");
  await s.mz.hookStop(director); // the subagent `lost` never sent its SubagentStop
  await s.tick(100);
  assert.deepEqual(turnPins(s), [], "the turn's own Stop releases every pin the turn took");
  assert.equal(s.mz.freeze.active, false, "and the freeze ends: no actor of the turn is left hooked");
  assert.equal(await s.engine.getMeta(["turn-pins", "t4"]), undefined, "the turn's list of subagent pins goes with it");
});

test("local-cli H8: a terminal session's subagent (no turn id) pins on its own, and the session's Stop releases it", async (t) => {
  const s = await setup(t, [clip("X", 0, 10)]);
  const session = { kind: "agent" as const, id: "claude-code/ab12cd34" };
  const sub = { kind: "subagent" as const, id: "claude-code/ab12cd34/sub-explore-ef56", agentType: "explore", agentId: "ef56" };
  await s.mz.printView("session", session, { hooked: true });
  await s.mz.printView("sub", sub, { hooked: true });
  assert.equal(turnPins(s).length, 2, "two owners");
  await s.mz.hookStop(session);
  assert.deepEqual(turnPins(s), []);
});

test("local-cli e0bb577: a hooked agent whose Stop never comes (an interrupted turn) holds the freeze only until it has been quiet for 60 s; each of its events resets that; a Stop still ends it at once", async (t) => {
  const s = await setup(t, [clip("a", 0, 5), clip("b", 5, 10)]);
  const agent = { kind: "agent" as const, id: "director/c/t7", turn: "t7" };
  const hidden = () => s.find(s.read().items, "b").name === "b";
  await s.mz.hookRead(agent);
  s.engine.external((d) => ((d.timelineItems as Item[])[1]!.name = "remote edit"));
  s.mz.onHeadChange("remote");
  const steps: [string, () => Promise<unknown>][] = [
    ["a write of the shared file", () => s.mz.hookWrite(agent, TIMELINE_FILE)],
    ["a write of a file it doesn't watch", () => s.mz.hookWrite(agent, "notes/todo.md")],
    ["a write of a view", () => s.mz.hookWrite(agent, viewPath("v7"))],
    ["a view print", () => s.mz.printView("v7", agent, { hooked: true })],
  ];
  for (const [what, step] of steps) {
    await s.tick(40_000);
    assert.ok(s.mz.freeze.active && hidden(), `frozen 40 s after its last event (before ${what})`);
    await step();
  }
  await s.tick(40_000);
  assert.ok(s.mz.freeze.active && hidden(), "still frozen 40 s after the print, 200 s after the read");
  await s.tick(21_000); // its Stop never came: 61 s of quiet
  assert.equal(s.mz.freeze.active, false, "the freeze ends after the idle cap");
  assert.equal(s.find(s.read().items, "b").name, "remote edit", "and the file catches up");
  assert.deepEqual([...s.mz.freeze.hooked.keys(), ...s.mz.freeze.heard.keys()], [], "it holds nothing any more");
  // its next event holds the freeze again; its Stop ends it at once
  await s.mz.hookRead(agent);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "later"));
  s.mz.onHeadChange("remote");
  await s.tick(1000);
  assert.ok(s.mz.freeze.active && s.find(s.read().items, "a").name === "a", "held again");
  await s.mz.hookStop(agent);
  await s.tick(100);
  assert.equal(s.mz.freeze.active, false);
  assert.equal(s.find(s.read().items, "a").name, "later", "caught up at its Stop");
});

test("local-cli H8: hookWrite of a file the materializer doesn't watch is ignored (nothing would ever clear its entry)", async (t) => {
  const s = await setup(t, [clip("X", 0, 10)]);
  const agent = { kind: "agent" as const, id: "director/c/t5", turn: "t5" };
  const announced = (s.mz as unknown as { announced: Map<string, unknown[]> }).announced;
  for (const rel of ["notes/todo.md", ".scratch/views/deep/x.tsx", ".scratch/views/x.status"]) await s.mz.hookWrite(agent, rel);
  assert.deepEqual([...announced.keys()], []);
  await s.mz.hookWrite(agent, viewPath("v"));
  await s.mz.printView("v", agent, { hooked: true });
  assert.equal(s.mz.freeze.active, false, "an agent that hasn't read or written the shared file doesn't freeze it");
  await s.mz.hookWrite(agent, TIMELINE_FILE);
  assert.deepEqual([...announced.keys()].sort(), [TIMELINE_FILE, viewPath("v")].sort(), "watched files are still announced");
});

test("R5-05: while shared, remote changes rewrite the shared file at most every 30 s; local changes stay prompt", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  s.engine.isShared = true;
  await s.tick(31_000);
  const before = s.mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE).length;
  for (let i = 0; i < 5; i++) {
    s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = `r${i}`));
    s.mz.onHeadChange("remote");
    await s.tick(1000);
  }
  const remote = s.mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE && r.cause === "remote");
  assert.equal(remote.length, 1, "one rewrite for five remote changes inside 30 s");
  await s.tick(30_000);
  assert.equal(s.mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE && r.cause === "remote").length, 2, "the next one 30 s later");
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "local"));
  s.mz.onHeadChange("gui");
  await s.tick(50);
  assert.equal(s.find(s.read().items, "a").name, "local", "a GUI change shows within tens of ms");
  assert.ok(s.mz.log.rewrites.length > before);
});

test("project.json follows head with every unversioned field kept, stateUpdatedAt monotonic", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui");
  await s.tick(50);
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.equal(env.format, "cardboard-project");
  assert.equal(env.project.id, "p1", "host fields kept");
  assert.equal(env.project.timelineItems[0].name, "gui");
  assert.ok(env.project.stateUpdatedAt > 1);
});

test("a head Cardboard couldn't read (no name, nothing in it) is never written to project.json: the old file stays, the refusal is logged", async (t) => {
  // laptop, build 915eb36: Restore of "Started the cut" made head the empty root, and project.json followed it. With
  // Cardboard's own conversion (cardboardFilesHost: materializeProject), a head without a name drops it from the file.
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  const project = { id: "p1", name: "Demo", updatedAt: "2026-11-02T00:00:00.000Z", stateUpdatedAt: 1, aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }], timelineItems: [clip("a", 0, 5)], media: [] };
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }));
  const engine = new FakeEngine(cardboardFilesHost.fromProject(project, null));
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: cardboardFilesHost, codec: jsonTimelineCodec, clock });
  t.after(() => mz.close());
  await engine.putMeta(["file", PROJECT_FILE, "pin"], (await engine.pin({ owner: "project-file", ttlMs: 1 })).ref);
  await mz.adoptCurrentFiles();
  await mz.start();
  const file = path.join(bundle, PROJECT_FILE);
  const before = fs.readFileSync(file, "utf8");
  const pin = await engine.getMeta(["file", PROJECT_FILE, "pin"]);
  // head becomes the empty root: no root field, every collection empty
  engine.external((d) => {
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, { tracks: [], timelineItems: [], media: [] });
  });
  mz.onHeadChange("local");
  await clock.advance(50, () => mz.idle());
  assert.equal(fs.readFileSync(file, "utf8"), before, "the old file, byte for byte");
  assert.deepEqual(mz.log.refused.map((r) => [r.path, r.problems]), [[PROJECT_FILE, ["no name"]]]);
  assert.deepEqual(mz.log.errors, [], "a refusal, not a failure to retry");
  assert.deepEqual(await engine.getMeta(["file", PROJECT_FILE, "pin"]), pin, "the file's pin is the state it shows");
  // a head with a name again is written as usual
  engine.external((d) => Object.assign(d, cardboardFilesHost.fromProject({ ...project, timelineItems: [clip("a", 0, 5, { name: "back" })] }, null)));
  mz.onHeadChange("local");
  await clock.advance(50, () => mz.idle());
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([env.project.name, env.project.timelineItems[0].name, env.project.tracks.length], ["Demo", "back", 1]);
});

test("a foreign project.json write is imported as external:project.json against Carton's last materialization", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui");
  await s.tick(50);
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  env.project.timelineItems[0].opacity = 0.5;
  s.writeAtomic(PROJECT_FILE, JSON.stringify(env));
  await s.event(PROJECT_FILE);
  const h = await s.head();
  assert.equal(s.find(h, "a").opacity, 0.5);
  assert.equal(s.find(h, "a").name, "gui");
  assert.equal(s.engine.commits.at(-1)!.author.id, "external:project.json");
});

test("a displaced save that can't be applied (its base is unknown) is kept in .carton/displaced, never deleted", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  // a save from a header whose pin is gone: written, then a print displaces it before its event
  s.writeAtomic(TIMELINE_FILE, "// cardboard:rev main@0~deadbeef p:00000000 by someone\n" + JSON.stringify({ timelineItems: [clip("a", 0, 5, { name: "lost?" })] }));
  await s.mz.printShared();
  await s.tick(500);
  assert.equal(s.find(await s.head(), "a").name, "a", "not applied: no exact base");
  assert.ok(s.engine.notices.some((n) => /state unknown: re-print/.test(n.text)), "its writer is told");
  const kept = fs.readdirSync(path.join(s.bundle, ".carton", "displaced")).map((f) => fs.readFileSync(path.join(s.bundle, ".carton", "displaced", f), "utf8"));
  assert.ok(kept.some((c) => c.includes("lost?")), "its bytes are still on disk");
});

test("an engine failure during a watch event is logged, not an unhandled rejection", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r0 = s.read();
  s.engine.commit = async () => {
    throw new Error("database is locked");
  };
  s.writeAtomic(TIMELINE_FILE, s.edited(r0, (its) => (its[0]!.name = "x")));
  await s.event();
  assert.equal(s.mz.log.errors.length, 1);
  assert.match(String(s.mz.log.errors[0]!.error), /database is locked/);
});

// ------------------------------------------------------------------ review round 1 regressions

test("a view edited and then undone back to its printed text is a save: head goes back too (no content-history dedup)", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("v", agent, { hooked: true });
  const printed = fs.readFileSync(s.abs(rel), "utf8");
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "edited")));
  await s.event(rel);
  assert.equal(s.find(await s.head(), "X").name, "edited");
  s.writeAtomic(rel, printed); // the agent's undo: byte for byte the print
  await s.event(rel);
  assert.equal(s.find(await s.head(), "X").name, "X", "the undo landed");
});

test("a displaced save whose import throws (a locked database) is held again and retried, not forgotten", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const real = s.engine.commit.bind(s.engine);
  let fail = true;
  s.engine.commit = async (i) => {
    if (fail) {
      fail = false;
      throw new Error("database is locked");
    }
    return real(i);
  };
  fs.writeFileSync(s.abs(TIMELINE_FILE), s.edited(s.read(), (its) => (its[0]!.name = "kept safe"))); // no event
  // importUnseen fails on the first try (logged); the print displaces the file, and the review retries it
  await s.mz.printShared().catch(() => undefined);
  await s.mz.printShared();
  await s.tick(1000);
  assert.equal(s.find(await s.head(), "a").name, "kept safe");
  assert.deepEqual(s.mz.stats(), { held: 0, origins: 0, partials: 0, kept: 0 }, "nothing left behind");
});

test("a displaced save left by a process that closed during the hold (or crashed) is finished by the next start", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r0 = s.read();
  // a save lands while Carton renders (displaced by the install), and the app quits before the review
  let race = false;
  const racing = { ...jsonTimelineCodec, print: (p: Record<string, unknown>, rev: string) => (race && fs.writeFileSync(s.abs(TIMELINE_FILE), s.edited(r0, (its) => (its[0]!.name = "saved at quit"))), jsonTimelineCodec.print(p, rev)) };
  const mz1 = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: racing, clock: s.clock, writeProject: false });
  await mz1.printShared(); // mz1's own install
  race = true;
  await mz1.printShared(); // the racing save is moved aside with mz1's install as its "own" candidate: held
  await mz1.close();
  assert.equal(s.find(await s.head(), "a").name, "a", "not applied yet: it was in its hold");
  // a crash leaves one more, moved aside by hand with a tagged name
  fs.writeFileSync(path.join(s.bundle, ".carton", "displaced", `crash-1@@${encodeURIComponent("timeline.tsx")}`), s.edited(r0, (its) => (its[0]!.opacity = 0.25)));
  const mz2 = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock, writeProject: false });
  t.after(() => mz2.close());
  await mz2.start();
  await s.clock.advance(1000, () => mz2.idle());
  const a = s.find(await s.head(), "a");
  assert.deepEqual([a.name, a.opacity], ["saved at quit", 0.25]);
  assert.ok(mz2.log.recovered.length >= 1);
});

test("a foreign project.json moved aside by an install keeps its unversioned fields in the next project.json", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  env.project.cast = [{ id: "voice-1" }]; // unversioned: Cardboard's own data
  env.project.timelineItems[0].opacity = 0.5; // versioned
  fs.writeFileSync(s.abs(PROJECT_FILE), JSON.stringify(env)); // no event: the next install displaces it
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui");
  await s.tick(1000);
  const out = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.deepEqual(out.project.cast, [{ id: "voice-1" }], "unversioned field kept");
  assert.equal(out.project.timelineItems[0].opacity, 0.5, "versioned field applied");
  assert.equal(out.project.timelineItems[0].name, "gui");
});

test("a shared-file save that raised cards: head's values kept, the cards stored and given to the human, its writer told", async (t) => {
  const cards: unknown[] = [];
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "D", timelineItems: [clip("a", 0, 5)] }, media: [] }));
  const engine = new FakeEngine({ name: "D", timelineItems: [clip("a", 0, 5)] });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock, writeProject: false, onCards: (c) => cards.push(c) });
  t.after(() => mz.close());
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  await mz.start();
  const text = fs.readFileSync(path.join(bundle, TIMELINE_FILE), "utf8");
  engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "theirs"));
  const f = findRev(text)!;
  fs.writeFileSync(path.join(bundle, TIMELINE_FILE), `${f.line}\n${JSON.stringify({ timelineItems: [{ ...clip("a", 0, 5), name: "mine" }] })}\n`);
  mz.onFsEvent(TIMELINE_FILE);
  await clock.advance(100, () => mz.idle());
  assert.equal(((await engine.head()).timelineItems as Item[])[0]!.name, "theirs", "head's value kept");
  assert.equal(cards.length, 1);
  assert.ok(engine.notices.some((n) => n.kind === "conflicts" && n.to === "external:timeline.tsx"), "the writer is told");
  assert.ok([...engine.meta.keys()].some((k) => k.startsWith('["cards"')), "the cards are stored");
});

test("on a case-insensitive file system a view printed as `Alice` and saved through `alice.tsx` is one view", async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "D", timelineItems: [clip("a", 0, 5)] }, media: [] }));
  const engine = new FakeEngine({ name: "D", timelineItems: [clip("a", 0, 5)] });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock, writeProject: false, foldCase: true });
  t.after(() => mz.close());
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  await mz.start();
  const { path: rel, name } = await mz.printView("Alice", { kind: "agent", id: "alice" });
  assert.equal(name, "alice");
  const text = fs.readFileSync(path.join(bundle, ...rel.split("/")), "utf8");
  fs.writeFileSync(path.join(bundle, ...rel.split("/")), text.replace('"name": "a"', '"name": "via alice.tsx"'));
  mz.onFsEvent(".scratch/views/ALICE.tsx"); // the event names it in another case
  await clock.advance(100, () => mz.idle());
  assert.equal(((await engine.head()).timelineItems as Item[])[0]!.name, "via alice.tsx");
});

test("R8-01: a per-agent view save during a freeze shows in the shared file's freeze view (every local agent's saves)", async (t) => {
  const s = await setup(t, [clip("a", 0, 5), clip("b", 5, 10)]);
  await s.mz.hookRead({ kind: "agent", id: "director/c/t1", turn: "t1" }); // agent A holds the shared file
  s.engine.external((d) => ((d.timelineItems as Item[])[1]!.name = "remote"));
  s.mz.onHeadChange("remote");
  const B = { kind: "agent" as const, id: "agent-b" };
  const { path: rel } = await s.mz.printView("agent-b", B);
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "by B")));
  await s.event(rel);
  const shared = s.read().items;
  assert.equal(s.find(shared, "a").name, "by B", "A's re-read shows B's view save");
  assert.equal(s.find(shared, "b").name, "b", "the remote change stays hidden");
});

test("R5-04: a late update for an earlier save never overwrites the sidecar of a later refused save", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  const v = s.read(rel);
  s.writeAtomic(rel, s.edited(v, (its) => (its[0]!.name = "A")));
  await s.event(rel);
  const first = s.engine.commits.at(-1)!.id;
  // save B names a state that is gone: refused
  s.writeAtomic(rel, s.edited({ ...v, line: v.line.replace(/~[0-9a-f]{8}/, "~deadbeef").replace(/ p:[0-9a-f]{8}/, " p:00000000") }, (its) => (its[0]!.name = "B")));
  await s.event(rel);
  const status = () => JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
  assert.equal(status().status, "error");
  await s.mz.onChangeUpdate(name, first, { status: "confirmed", seq: 9 });
  assert.equal(status().status, "error", "the late confirmation of save A is stale");
});

test("Carton's own displaced installs leave no origin behind once deleted", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  for (let i = 0; i < 5; i++) await s.mz.printShared();
  await s.tick(1000);
  assert.deepEqual(s.mz.stats(), { held: 0, origins: 0, partials: 0, kept: 0 });
});

// ------------------------------------------------------------------ review round 2 regressions

test("review 2 #2: if storing a foreign project.json's unversioned fields fails, its displaced file is retried, never deleted first", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const realPut = s.engine.putMeta.bind(s.engine);
  let fail = true;
  s.engine.putMeta = async (k, v) => {
    if (fail && k[2] === "overlay" && v !== undefined) {
      fail = false;
      throw new Error("disk full");
    }
    return realPut(k, v);
  };
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  env.project.cast = [{ id: "voice-1" }];
  fs.writeFileSync(s.abs(PROJECT_FILE), JSON.stringify(env)); // no event: displaced by the next install
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui");
  await s.tick(2000);
  s.mz.onHeadChange("gui");
  await s.tick(2000);
  const out = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.deepEqual(out.project.cast, [{ id: "voice-1" }], "the unversioned field survived the failure");
});

test("review 2 #3: a project.json write clears only the overlay it consumed; one applied during its install is kept for the next write", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  // overlay A: a foreign envelope applied whose project.json write hasn't happened yet (no install in this process)
  const envA = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  envA.project.cast = [{ id: "A" }];
  await s.engine.putMeta(["file", PROJECT_FILE, "overlay"], { id: "overlay-A", envelope: envA, mtimeNs: "1" });
  // B lands between the write's unread-save check and its install, so the install moves it aside and its review
  // applies it (a new overlay) before the write finishes
  const envB = { ...envA, project: { ...envA.project, cast: [{ id: "B" }], lastOpenedAt: "B was here" } };
  const realRelease = s.engine.release.bind(s.engine);
  let raced = false;
  s.engine.release = async (owner) => {
    if (owner === "project-file" && !raced) {
      raced = true;
      fs.writeFileSync(s.abs(PROJECT_FILE), JSON.stringify(envB));
    }
    return realRelease(owner);
  };
  // a fresh process that hasn't installed project.json yet: the file B is moved aside is reviewed inside that install
  await s.mz.close();
  const mz2 = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => mz2.close());
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  mz2.onHeadChange("gui");
  await s.clock.advance(3000, () => mz2.idle());
  assert.deepEqual(mz2.log.errors, []);
  assert.ok(raced);
  const out = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.deepEqual([out.project.cast, out.project.lastOpenedAt], [[{ id: "B" }], "B was here"], "B's unversioned fields reach the file");
  assert.equal(out.project.timelineItems[0].name, "gui");
});

test("review 2 #3: an older envelope reviewed late never replaces a newer one's unversioned fields", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  await s.engine.putMeta(["file", PROJECT_FILE, "overlay"], { id: "newer", envelope: { ...env, project: { ...env.project, cast: [{ id: "newer" }] } }, mtimeNs: String(BigInt(Date.now() + 3_600_000) * 1_000_000n) });
  fs.writeFileSync(s.abs(PROJECT_FILE), JSON.stringify({ ...env, project: { ...env.project, cast: [{ id: "older" }] } }));
  s.mz.onFsEvent(PROJECT_FILE);
  await s.tick(3000);
  const out = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.deepEqual(out.project.cast, [{ id: "newer" }]);
});

test("review 2 #5: a transient failure resolving a displaced save's base is retried, not a permanent refusal", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const realResolve = s.engine.resolve.bind(s.engine);
  let fail = true;
  s.engine.resolve = async (rev) => {
    if (fail) {
      fail = false;
      throw new Error("database is locked");
    }
    return realResolve(rev);
  };
  fs.writeFileSync(s.abs(TIMELINE_FILE), s.edited(s.read(), (its) => (its[0]!.name = "retried"))); // no event
  await s.mz.printShared().catch(() => undefined);
  await s.mz.printShared().catch(() => undefined);
  await s.tick(1000);
  assert.equal(s.find(await s.head(), "a").name, "retried");
  assert.equal(s.mz.stats().kept, 0, "not refused");
});

test("review 2 #6: a view save that never parses refuses the view, so a late update for the previous save is stale", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "A")));
  await s.event(rel);
  const first = s.engine.commits.at(-1)!.id;
  s.writeInPlace(rel, "// cardboard:rev main@0~00000000 by y\n{broken");
  await s.event(rel);
  await s.tick(400);
  const status = () => JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
  assert.equal(status().status, "error");
  await s.mz.onChangeUpdate(name, first, { status: "confirmed", seq: 9 });
  assert.equal(status().status, "error", "the older save's confirmation is stale");
});

// ------------------------------------------------------------------ review round 3 regressions

test("review 3 #1: an older project.json applied after a newer one was consumed can't bring back its older fields", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const env = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  s.writeAtomic(PROJECT_FILE, JSON.stringify({ ...env, project: { ...env.project, cast: [{ id: "newer" }] } }));
  await s.event(PROJECT_FILE);
  await s.tick(1000); // B applied and consumed by Carton's next project.json write
  // an older save (mtime an hour back) reaches Carton late, with no event: the next write imports it first
  fs.writeFileSync(s.abs(PROJECT_FILE), JSON.stringify({ ...env, project: { ...env.project, cast: [{ id: "older" }], timelineItems: [{ ...env.project.timelineItems[0], opacity: 0.4 }] } }));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(s.abs(PROJECT_FILE), old, old);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui");
  await s.tick(1000);
  const out = JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8"));
  assert.deepEqual(out.project.cast, [{ id: "newer" }], "the newer unversioned fields stay");
  assert.equal(out.project.timelineItems[0].opacity, 0.4, "the older save's versioned edit still merged in");
});

test("review 3 #2: if storing a save's cards fails, the save is retried, never marked stored without its cards", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r0 = s.read();
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "theirs"));
  const realPut = s.engine.putMeta.bind(s.engine);
  let fail = true;
  s.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "cards") {
      fail = false;
      throw new Error("disk full");
    }
    return realPut(k, v);
  };
  fs.writeFileSync(s.abs(TIMELINE_FILE), s.edited(r0, (its) => (its[0]!.name = "mine"))); // conflicts with "theirs"
  await s.mz.printShared().catch(() => undefined); // the unread save's import fails storing its cards
  await s.mz.printShared();
  await s.tick(500);
  assert.ok([...s.engine.meta.keys()].some((k) => k.startsWith('["cards"')), "the cards are stored on the retry");
});

test("review 3 #3: a watched save whose engine call fails is retried by itself, with no other event or print", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("v", agent, { hooked: true });
  const realResolve = s.engine.resolve.bind(s.engine);
  let fail = true;
  s.engine.resolve = async (rev) => {
    if (fail) {
      fail = false;
      throw new Error("database is locked");
    }
    return realResolve(rev);
  };
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "eventually")));
  await s.event(rel);
  assert.equal(s.find(await s.head(), "a").name, "a", "the first try failed");
  await s.tick(2000);
  assert.equal(s.find(await s.head(), "a").name, "eventually", "retried on its own");
});

test("review 3 #4: a displaced view file that doesn't parse, of the current print, refuses the view (late updates stale)", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "A")));
  await s.event(rel);
  const first = s.engine.commits.at(-1)!.id;
  // a corrupted save of this print, found in .carton/displaced (left by a print whose install failed half-way)
  fs.writeFileSync(path.join(s.bundle, ".carton", "displaced", `x-1@@${encodeURIComponent(rel)}`), "// cardboard:rev main@0~00000000 by y\n{broken");
  const mz2 = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock, writeProject: false });
  t.after(() => mz2.close());
  await mz2.start();
  await s.clock.advance(500, () => mz2.idle());
  const status = () => JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
  assert.equal(status().status, "error");
  await mz2.onChangeUpdate(name, first, { status: "confirmed", seq: 9 });
  assert.equal(status().status, "error", "the older save's confirmation is stale");
});

// ------------------------------------------------------------------ review round 4 regressions

test("review 4 #2: a retry pending when a later event succeeds is cancelled, and nothing runs after close", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("v", agent, { hooked: true });
  const realResolve = s.engine.resolve.bind(s.engine);
  let fail = true;
  let calls = 0;
  s.engine.resolve = async (rev) => {
    calls++;
    if (fail) {
      fail = false;
      throw new Error("database is locked");
    }
    return realResolve(rev);
  };
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "x")));
  await s.event(rel); // fails: a retry is scheduled
  s.mz.onFsEvent(rel); // a later event succeeds first
  await s.mz.idle();
  assert.equal(s.find(await s.head(), "a").name, "x");
  await s.mz.close();
  const before = calls;
  await s.clock.advance(60_000, () => s.mz.idle());
  assert.equal(calls, before, "the cancelled retry never ran after close");
});

test("review 4 #3: if reporting a displaced view file that doesn't parse fails, the next review reports it and refuses the view", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "A")));
  await s.event(rel);
  const first = s.engine.commits.at(-1)!.id;
  const realNotice = s.engine.notice.bind(s.engine);
  let fail = true;
  s.engine.notice = async (to, n) => {
    if (fail && /moved aside/.test(n.text)) {
      fail = false;
      throw new Error("database is locked");
    }
    return realNotice(to, n);
  };
  fs.writeFileSync(path.join(s.bundle, ".carton", "displaced", `x-1@@${encodeURIComponent(rel)}`), "// cardboard:rev main@0~00000000 by y\n{broken");
  const mz2 = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock, writeProject: false });
  t.after(() => mz2.close());
  await mz2.start();
  await s.clock.advance(6000, () => mz2.idle());
  const status = () => JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
  assert.equal(status().status, "error", "refused on the retry");
  await mz2.onChangeUpdate(name, first, { status: "confirmed", seq: 9 });
  assert.equal(status().status, "error");
});

// ------------------------------------------------------------------ review round 5 regressions

test("review 5 #2: a leftover attempt for the same file generation on another base is never reused: the save commits", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("v", agent, { hooked: true });
  const content = s.edited(s.read(rel), (its) => (its[0]!.name = "A again"));
  fs.writeFileSync(s.abs(rel), content);
  const st = fs.statSync(s.abs(rel), { bigint: true });
  const { createHash } = await import("node:crypto");
  const h = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
  const gen = h(`${st.ino}:${st.size}:${st.mtimeNs}\n${h(content)}`).slice(0, 24);
  // an abandoned attempt of an earlier save that had these very bytes and stamp, on another base
  await s.engine.putMeta(["attempt", rel], { gen, base: "held:0::older", result: { status: "confirmed", id: "stale", seq: 0 } });
  await s.event(rel);
  assert.equal(s.find(await s.head(), "a").name, "A again", "committed, not answered by the stale attempt");
});

test("review 5 #3: if removing a finished save's attempt fails, the save is still finished (view base, status) and applied once", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  const realPut = s.engine.putMeta.bind(s.engine);
  s.engine.putMeta = async (k, v) => {
    if (k[0] === "attempt" && v === undefined) throw new Error("database is locked");
    return realPut(k, v);
  };
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[0]!.name = "done")));
  await s.event(rel);
  await s.tick(2000);
  assert.equal(s.find(await s.head(), "a").name, "done");
  assert.equal(JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8")).status, "confirmed", "the sidecar was written");
  assert.ok((await s.engine.getMeta<ViewRow>(["view", name]))?.last, "the view's base was recorded");
  assert.equal(s.engine.commits.length, 1, "applied once");
});

test("every install of project.json and timeline.tsx holds the bundle's install lock across its whole missing window, and releases it after", async (t) => {
  // stock 1.4.0 takes a missing project.json for a removed project: its readers (the app's store bridge) wait while
  // `.carton/install.lock/` exists, so the lock must cover the gap from the displacing rename to the link
  const s = await setup(t, [clip("a", 0, 5)], { start: false });
  const lock = path.join(s.bundle, ".carton", "install.lock");
  const watched = new Set([s.abs(TIMELINE_FILE), s.abs(PROJECT_FILE)]);
  const seen: { step: string; file: string; locked: boolean }[] = [];
  const realLink = fs.linkSync;
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (watched.has(String(from))) seen.push({ step: "displace", file: path.basename(String(from)), locked: fs.existsSync(lock) });
    return realRename(from, to);
  });
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (watched.has(String(to))) seen.push({ step: "link", file: path.basename(String(to)), locked: fs.existsSync(lock) });
    return realLink(from, to);
  });
  await s.mz.start();
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "gui"));
  s.mz.onHeadChange("gui"); // both files follow head
  await s.tick(50);
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => (its[0]!.name = "agent")));
  await s.event(); // a foreign save: applied, then the files rewritten
  await s.tick(50);
  t.mock.restoreAll();
  for (const file of ["project.json", "timeline.tsx"]) for (const step of ["displace", "link"]) assert.ok(seen.some((x) => x.file === file && x.step === step), `${file}: ${step} seen`);
  assert.deepEqual(seen.filter((x) => !x.locked), [], "every displace and link ran under the lock");
  assert.equal(fs.existsSync(lock), false, "released");
});

test("B8: a view save written while the app was down is applied at the next start, credited to its owner, sidecar written", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  await s.mz.close(); // the app crashes before it sees the save
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
  const mz = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => mz.close());
  await mz.start();
  assert.equal(s.find(await s.head(), "Y").name, "renamed");
  const c = s.engine.commits.at(-1)!;
  assert.equal(c.author.id, agent.id, "credited to the view's owner");
  const status = JSON.parse(fs.readFileSync(s.abs(statusPath("director_c_t1")), "utf8"));
  assert.equal(status.status, "confirmed");
  assert.equal(status.change, c.id);
  const commits = s.engine.commits.length;
  await mz.close();
  const again = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => again.close());
  await again.start();
  assert.equal(s.engine.commits.length, commits, "applied once: the next start finds it current");
});

test("B6: a save is stored and its sidecar written even if regenerating the shared file after it fails", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  await s.mz.onCb(); // frozen: a view save regenerates the shared file (R7-01)
  t.mock.method(jsonTimelineCodec, "print", () => {
    throw new Error("printer failed");
  });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
  await s.event(rel);
  t.mock.restoreAll();
  assert.equal(s.find(await s.head(), "Y").name, "renamed");
  const status = JSON.parse(fs.readFileSync(s.abs(statusPath("director_c_t1")), "utf8"));
  assert.equal(status.status, "confirmed");
  assert.ok(s.mz.log.errors.some((e) => /regenerate after a save: printer failed/.test(String(e.error))), JSON.stringify(s.mz.log.errors));
});

for (const step of ["view row", "sidecar"] as const) {
  test(`review 6: a view save that failed after its receipt (at its ${step}) is finished by the retry and by the next start, applied once`, async (t) => {
    const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
    const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
    const { path: rel, name } = await s.mz.printView("director_c_t1", agent, { hooked: true });
    // fails after the commit and the receipt: storing the view row, or pinning its sidecar's ref (the row is stored)
    let failing = true;
    const realPut = s.engine.putMeta.bind(s.engine);
    const realPin = s.engine.pin.bind(s.engine);
    s.engine.putMeta = async (k, v) => {
      if (failing && step === "view row" && k[0] === "view" && s.engine.commits.length) throw new Error("database is locked");
      return realPut(k, v);
    };
    s.engine.pin = async (o) => {
      if (failing && step === "sidecar" && s.engine.commits.length && o.owner !== "shared-file") throw new Error("database is locked");
      return realPin(o);
    };
    s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
    await s.event(rel);
    assert.equal(s.engine.commits.length, 1, "stored");
    assert.equal(fs.existsSync(s.abs(statusPath(name))), false, "its sidecar not yet");
    // the app dies before its retry; the next start finishes the save
    await s.mz.close();
    failing = false;
    const mz = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
    t.after(() => mz.close());
    await mz.start();
    const status = JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
    assert.equal(status.status, "confirmed", JSON.stringify(status));
    assert.equal(status.change, s.engine.commits[0]!.id, "its own change");
    assert.equal((await s.engine.getMeta<ViewRow>(["view", name]))?.last?.held.causal.filter((c) => c === s.engine.commits[0]!.id).length, 1, "the view's causal past has its change once");
    assert.equal(s.engine.commits.length, 1, "applied once");
    assert.equal(await s.engine.getMeta(["attempt", rel]), undefined, "settled");
  });
}

test("review 6: a failed view save's tail is finished by its own retry while the app runs", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  let fail = 1;
  const realPin = s.engine.pin.bind(s.engine);
  s.engine.pin = async (o) => {
    if (fail && s.engine.commits.length && o.owner !== "shared-file") {
      fail--;
      throw new Error("database is locked");
    }
    return realPin(o);
  };
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
  await s.event(rel);
  await s.tick(5000);
  assert.equal(JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8")).status, "confirmed");
  assert.equal(s.engine.commits.length, 1, "applied once");
});

test("review 6: a view left half-written while the app was down is refused at the next start once quiet: its sidecar says why", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  await s.mz.close();
  const full = s.edited(s.read(rel), (its) => (its[0]!.name = "renamed"));
  s.writeInPlace(rel, full.slice(0, full.length - 20)); // the agent died mid-write
  const mz = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => mz.close());
  await mz.start();
  await s.clock.advance(1000, () => mz.idle());
  const status = JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8"));
  assert.equal(status.status, "error", JSON.stringify(status));
  assert.match(status.error, /doesn't parse/);
  assert.equal(s.engine.commits.length, 0);
});

// B11: carton.db's head moved in another process (a `cb` committed in its own process, a takeover helper); the
// materializer hears of it only through `onExternalHeadChange`, which local's store follower and the worker call.
test("B11: an external head change reaches project.json and timeline.tsx, under the install lock; asked again, nothing happens", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const lock = path.join(s.bundle, ".carton", "install.lock");
  const linked: boolean[] = [];
  const real = fs.linkSync;
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === s.abs(TIMELINE_FILE) || to === s.abs(PROJECT_FILE)) linked.push(fs.existsSync(lock));
    return real(from, to);
  });
  assert.equal(await s.mz.onExternalHeadChange(), "unchanged", "nothing moved since start");
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "by cb, elsewhere")); // no onHeadChange: another process
  assert.equal(await s.mz.onExternalHeadChange(), "head");
  await s.tick(50);
  assert.equal(s.read().items[0]!.name, "by cb, elsewhere", "timeline.tsx follows");
  assert.equal(JSON.parse(fs.readFileSync(s.abs(PROJECT_FILE), "utf8")).project.timelineItems[0].name, "by cb, elsewhere", "project.json follows");
  assert.ok(linked.length >= 2 && linked.every(Boolean), "both installs under the lock");
  let pinCalls = 0;
  const realPin = s.engine.pin.bind(s.engine);
  s.engine.pin = async (o) => (pinCalls++, realPin(o));
  const rewrites = s.mz.log.rewrites.length, n = linked.length;
  for (let i = 0; i < 5; i++) assert.equal(await s.mz.onExternalHeadChange(), "unchanged");
  await s.tick(50);
  assert.deepEqual([pinCalls, s.mz.log.rewrites.length, linked.length], [0, rewrites, n], "idempotent and cheap: no pin, no rewrite, no install");
});

test("B11/B3: two materializers on one bundle (the app and a takeover helper) don't answer each other's installs: no commit, no ping-pong", async (t) => {
  const s = await setup(t, [clip("a", 0, 5), clip("b", 5, 10)]);
  const other = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => other.close());
  await other.start();
  const both = [s.mz, other];
  const watch = async () => {
    for (const m of both) for (const rel of [PROJECT_FILE, TIMELINE_FILE]) m.onFsEvent(rel);
    await s.clock.advance(300, async () => {
      for (const m of both) await m.idle();
    });
  };
  s.engine.external((d) => ((d.timelineItems as Item[])[1]!.name = "moved"));
  await other.onExternalHeadChange(); // the helper materializes first
  for (let i = 0; i < 3; i++) await watch();
  const settled = s.mz.log.rewrites.length + other.log.rewrites.length;
  for (let i = 0; i < 6; i++) await watch();
  assert.equal(s.mz.log.rewrites.length + other.log.rewrites.length, settled, "no install answers another");
  assert.equal(s.engine.commits.length, 0, "nothing committed: each saw the other's files as the states they name");
  assert.equal(s.read().items[1]!.name, "moved");
});

test("a save of timeline.tsx that changes nothing (the state its header names) commits nothing and isn't regenerated", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const r = s.read();
  const rewrites = s.mz.log.rewrites.length;
  s.writeAtomic(TIMELINE_FILE, s.edited(r, () => undefined));
  await s.event();
  await s.tick(50);
  assert.equal(s.engine.commits.length, 0);
  assert.equal(s.mz.log.rewrites.length, rewrites, "not answered with a rewrite");
  assert.ok(s.mz.log.applied.some((a) => a.status === "unchanged"));
});

test("review 7 #5: a failed rewrite of the frozen shared file after a view save is tried again, not left stale until the turn ends", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  await s.mz.hookRead(agent); // a hooked turn: the shared file is frozen until it ends
  let fail = true;
  const realPrint = jsonTimelineCodec.print.bind(jsonTimelineCodec);
  t.mock.method(jsonTimelineCodec, "print", (...a: Parameters<typeof jsonTimelineCodec.print>) => {
    if (fail) throw new Error("printer failed");
    return realPrint(...a);
  });
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
  await s.event(rel);
  assert.equal(s.find(await s.head(), "Y").name, "renamed", "the save is stored");
  assert.notEqual(s.find(s.read().items, "Y").name, "renamed", "the shared file missed it");
  fail = false;
  await s.tick(1000);
  assert.equal(s.find(s.read().items, "Y").name, "renamed", "the retried rewrite shows the save in the freeze view");
});

test("review 7 #3: a view save found at start whose import fails for a moment (a locked database) is retried, not left for the next edit", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("director_c_t1", agent, { hooked: true });
  await s.mz.close();
  s.writeAtomic(rel, s.edited(s.read(rel), (its) => (its[1]!.name = "renamed")));
  let fail = 1;
  const realCommit = s.engine.commit.bind(s.engine);
  s.engine.commit = async (i) => {
    if (fail) {
      fail--;
      throw new Error("database is locked");
    }
    return realCommit(i);
  };
  const mz = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
  t.after(() => mz.close());
  await mz.start();
  assert.equal(fail, 0, "the first try failed");
  await s.clock.advance(2000, () => mz.idle());
  assert.equal(s.find(await s.head(), "Y").name, "renamed");
  assert.equal(JSON.parse(fs.readFileSync(s.abs(statusPath(name)), "utf8")).status, "confirmed");
});

for (const crash of [false, true])
test(`review 7 #2: a displaced view save that failed after its receipt is finished by the next review${crash ? " after a restart" : ""}, not deleted as a copy`, async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const { path: rel, name } = await s.mz.printView("v", agent, { hooked: true });
  const save = s.edited(s.read(rel), (its) => (its[1]!.name = "renamed"));
  // the agent's save lands just as a re-print installs the view: the install moves it aside, and its review applies it
  const realRename = fs.renameSync;
  let landed = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!landed && from === s.abs(rel)) {
      landed = true;
      s.writeAtomic(rel, save);
    }
    return realRename(from, to);
  });
  // storing the view row fails after the commit and the receipt: once, or until the app dies
  let fail = crash ? Infinity : 1;
  const realPut = s.engine.putMeta.bind(s.engine);
  s.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "view" && s.engine.commits.length) {
      fail--;
      throw new Error("database is locked");
    }
    return realPut(k, v);
  };
  await s.mz.printView("v", agent, { hooked: true });
  t.mock.restoreAll();
  let mz = s.mz;
  if (crash) {
    await s.tick(1000); // its review applies it and fails at the view row, and its retries too
    await s.mz.close(); // the app dies before the next review; the file stays in .carton/displaced
    assert.equal(fs.readdirSync(path.join(s.bundle, ".carton", "displaced")).length, 1, "the save is still held");
    fail = 0;
    mz = new Materializer({ bundle: s.bundle, engine: s.engine, host: plainHost, codec: jsonTimelineCodec, clock: s.clock });
    t.after(() => mz.close());
    await mz.start();
  }
  await s.clock.advance(3000, () => mz.idle());
  assert.ok(landed);
  assert.equal(fail, 0, "the view row failed");
  assert.equal(s.engine.commits.length, 1, "applied once");
  assert.equal(s.find(await s.head(), "Y").name, "renamed");
  assert.equal(await s.engine.getMeta(["attempt", rel]), undefined, "finished: its attempt settled");
  assert.ok((await s.engine.getMeta<ViewRow>(["view", name]))?.lastChange, "the view row records the save's change");
});

test("review 7 #1: the materializer's installs stop when the install lock was taken over (it passes the lock's mine())", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  const owner = path.join(s.bundle, ".carton", "install.lock", "owner");
  const real = fs.readFileSync;
  let tookOver = false;
  t.mock.method(fs, "readFileSync", (p: fs.PathOrFileDescriptor, o?: unknown) => {
    if (p === owner && !tookOver) {
      tookOver = true; // read by mine() right before the install's first rename
      return JSON.stringify({ pid: 1, me: "successor" });
    }
    return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
  });
  const agent = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  await assert.rejects(s.mz.printView("v", agent, { hooked: true }), { name: "InstallLockLost" });
  t.mock.restoreAll();
  assert.ok(tookOver);
  assert.equal(fs.existsSync(s.abs(viewPath("v"))), false, "nothing installed");
});

test("review 8 #4: an external head change whose rewrite fails (a printer error) is retried, and isn't counted as shown meanwhile", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  let fail = 1;
  const realPrint = jsonTimelineCodec.print.bind(jsonTimelineCodec);
  t.mock.method(jsonTimelineCodec, "print", (...a: Parameters<typeof jsonTimelineCodec.print>) => {
    if (fail) {
      fail--;
      throw new Error("printer failed");
    }
    return realPrint(...a);
  });
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "from cb elsewhere"));
  assert.equal(await s.mz.onExternalHeadChange(), "head");
  await s.tick(30); // the scheduled rewrite runs and fails
  assert.equal(fail, 0);
  assert.notEqual(s.find(s.read().items, "X").name, "from cb elsewhere");
  assert.equal(await s.mz.onExternalHeadChange(), "head", "not counted as shown: asked again, it acts");
  await s.tick(1000);
  assert.equal(s.find(s.read().items, "X").name, "from cb elsewhere", "the retry wrote it");
  assert.equal(await s.mz.onExternalHeadChange(), "unchanged");
});

test("review 8 #2: during a freeze, a shared-file save of what head already has (hidden from the freeze view) is kept by the view's next regeneration", async (t) => {
  const s = await setup(t, [clip("X", 10, 20), clip("Y", 20, 30)]);
  const a = { kind: "agent" as const, id: "director/c/t1", turn: "t1" };
  const b = { kind: "agent" as const, id: "director/c/t2", turn: "t2" };
  await s.mz.hookRead(a); // a hooked turn: the shared file is frozen
  const { path: vb } = await s.mz.printView("vb", b, { hooked: true });
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "renamed")); // a remote rename, hidden by the freeze
  s.mz.onHeadChange("remote");
  await s.tick(50);
  assert.equal(s.find(s.read().items, "X").name, "X", "frozen: the shared file doesn't show it");
  // agent a saves the same rename into the shared file: its content is head's
  await s.mz.hookWrite(a, TIMELINE_FILE);
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => (its[0]!.name = "renamed")));
  await s.event();
  assert.equal(s.engine.commits.length, 0, "nothing to commit");
  // agent b's view save regenerates the shared file from the freeze view
  s.writeAtomic(vb, s.edited(s.read(vb), (its) => (its[1]!.name = "b's edit")));
  await s.event(vb);
  await s.tick(50);
  const shared = s.read().items;
  assert.deepEqual([s.find(shared, "X").name, s.find(shared, "Y").name], ["renamed", "b's edit"], "a's save isn't lost from the shared file");
});

test("review 8 #2: a shared-file save that failed right after its commit is finished on retry, though its content now equals head", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  const realPut = s.engine.putMeta.bind(s.engine);
  let fail = 1;
  s.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "attempt" && v && typeof v === "object" && "result" in (v as object)) {
      fail--;
      throw new Error("database is locked"); // right after the commit
    }
    return realPut(k, v);
  };
  s.writeAtomic(TIMELINE_FILE, s.edited(s.read(), (its) => (its[0]!.name = "saved")));
  await s.event();
  await s.tick(2000); // the retry
  assert.equal(fail, 0);
  assert.equal(s.engine.commits.length, 1, "committed once");
  assert.equal(await s.engine.getMeta(["attempt", TIMELINE_FILE]), undefined, "finished: its attempt settled");
  assert.ok(!s.mz.log.applied.some((x) => x.status === "unchanged"), "not taken for a no-op");
});

test("review 9 #2: a cut switched while a failed rewrite waits for its retry is still told as a cut switch", async (t) => {
  const s = await setup(t, [clip("X", 10, 20)]);
  // project.json's rewrite fails once (a locked database)
  let fail = 1;
  const realPin = s.engine.pin.bind(s.engine);
  s.engine.pin = async (o) => {
    if (fail && o.owner === "project-file") {
      fail--;
      throw new Error("database is locked");
    }
    return realPin(o);
  };
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "moved"));
  assert.equal(await s.mz.onExternalHeadChange(), "head");
  await s.tick(30); // the scheduled project.json rewrite fails; its retry waits
  assert.equal(fail, 0);
  // another process switches the current cut meanwhile
  s.engine.headRef = async () => JSON.stringify(["cut-b", "b7e1c2d3-0000-4000-8000-00000000000b", 0, []]);
  assert.equal(await s.mz.onExternalHeadChange(), "cut", "the cut it was on is remembered");
});

// apply-ryw: read-your-writes. A `cb` write asks (through the lease holder) for the shared file to show it, and is
// answered by the print that does, at once: the coalescing timer's rewrite is made then and there, with no wait on the
// clock. On the laptop the file was read before the rewrite and the agent took the old value for its turn's start.
test("apply-ryw: showChange makes the coalesced rewrite at once and answers 'shown' with the print that holds the change", async (t) => {
  const s = await setup(t, [clip("a", 0, 5), clip("b", 5, 10)]);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "the agent's write"), "agent.1");
  s.mz.onHeadChange("local"); // the holder's write (or its follower) told it: a rewrite is due in 20 ms
  const t0 = s.clock.now();
  assert.equal(await s.mz.showChange({ id: "agent.1", seq: s.engine.headSeq }, 2000), "shown");
  assert.equal(s.clock.now(), t0, "no wait on the clock: the rewrite was made at once");
  assert.equal(s.find(s.read().items, "a").name, "the agent's write", "the next read shows the write");
  // already shown: answered at once
  assert.equal(await s.mz.showChange({ id: "agent.1", seq: s.engine.headSeq }, 2000), "shown");
});

test("apply-ryw: a change nobody told the materializer of (another process's commit) is found and shown", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "committed elsewhere"), "cb.7");
  assert.equal(await s.mz.showChange({ id: "cb.7", seq: s.engine.headSeq }, 2000), "shown");
  assert.equal(s.find(s.read().items, "a").name, "committed elsewhere");
});

test("apply-ryw: during a freeze, a change the frozen file holds back (the person's, not an agent's) is 'held', at once", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  await s.mz.hookRead({ kind: "agent", id: "director/c/t1", turn: "t1" });
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "the person's"), "person.1");
  s.mz.onHeadChange("local");
  const t0 = s.clock.now();
  assert.equal(await s.mz.showChange({ id: "person.1", seq: s.engine.headSeq, author: { kind: "human", id: "person" } }, 2000), "held");
  assert.equal(s.clock.now(), t0, "said at once, not after the wait");
  assert.equal(s.find(s.read().items, "a").name, "a", "the file still holds it back");
});

test("apply-ryw: a write that can't show within the wait (a host write still landing) is 'later', then shows", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  let land!: () => void;
  s.mz.onHeadChange("gui", { after: new Promise<void>((r) => (land = r)) }); // the app's save is writing project.json
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "under a landing save"), "agent.2");
  s.mz.onHeadChange("local");
  const asked = s.mz.showChange({ id: "agent.2", seq: s.engine.headSeq }, 2000);
  await s.tick(2001);
  assert.equal(await asked, "later");
  land();
  await s.tick(100);
  assert.equal(s.find(s.read().items, "a").name, "under a landing save", "the rewrite follows once the save has landed");
  assert.equal(await s.mz.showChange({ id: "agent.2", seq: s.engine.headSeq }, 2000), "shown");
});

test("apply-ryw: a windowless cb caller named to onCb (a terminal's) is held to the freeze it starts; close settles waiting writes", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  await s.mz.onCb({ kind: "external", id: "terminal:me@box", name: "Terminal" });
  assert.equal(s.mz.freeze.active, true, "its call holds the file a while");
  assert.ok(s.mz.freeze.callers.has("terminal:me@box"));
  await s.tick(61_000);
  assert.equal(s.mz.freeze.active, false);
  assert.equal(s.mz.freeze.callers.size, 0, "forgotten once the freeze ends");
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "x"), "late.1");
  let land!: () => void;
  s.mz.onHeadChange("gui", { after: new Promise<void>((r) => (land = r)) });
  const asked = s.mz.showChange({ id: "late.1", seq: s.engine.headSeq }, 60_000);
  await s.mz.close();
  assert.equal(await asked, "later");
  land();
});

// Review #1: "shown" only while the file on disk is the print's bytes. A foreign writer that replaced the print (before
// any watch event was read) leaves the write unshown, never certified by a stamp taken after the install.
test("apply-ryw review #1: a print a foreign writer replaced doesn't count as showing the write", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const old = fs.readFileSync(s.abs(TIMELINE_FILE), "utf8");
  s.engine.external((d) => ((d.timelineItems as Item[])[0]!.name = "the agent's write"), "agent.9");
  s.mz.onHeadChange("local");
  assert.equal(await s.mz.showChange({ id: "agent.9", seq: s.engine.headSeq }, 2000), "shown");
  s.writeAtomic(TIMELINE_FILE, old); // someone else's bytes over the print, not read yet
  const asked = s.mz.showChange({ id: "agent.9", seq: s.engine.headSeq }, 2000);
  await s.tick(2001);
  assert.equal(await asked, "later", "the file doesn't hold the write: not 'shown'");
});

// Review #2: a shared cut offline, the file frozen by a terminal's cb, and its own edit still pending: the pending change
// moves the file (pendingMoved and withPending take the same changes), so it shows at once.
test("apply-ryw review #2: an offline terminal's pending edit shows in the file its call holds", async (t) => {
  const s = await setup(t, [clip("a", 0, 5)]);
  const terminal = { kind: "external" as const, id: "terminal:me@box", name: "Terminal" };
  const engine = s.engine as FakeEngine & { pendingChanges?: unknown };
  engine.isShared = true;
  const pending: { id: string; author: typeof terminal; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
  engine.pendingChanges = async () => ({ seq: engine.headSeq, changes: pending });
  // the host tells a change's edits (cardboard's does), so a pending change shows by its own edits
  (s.mz as unknown as { host: typeof plainHost }).host = { ...plainHost, changes: (from, to) => {
    const was = new Map(((from.timelineItems ?? []) as Item[]).map((i) => [i.id, JSON.stringify(i)]));
    return ((to.timelineItems ?? []) as Item[]).filter((i) => was.get(i.id) !== JSON.stringify(i)).map((i) => JSON.stringify(i));
  } };
  await s.mz.onCb(terminal);
  const before = await engine.head();
  const after = { ...before, timelineItems: (before.timelineItems as Item[]).map((i) => (i.id === "a" ? { ...i, name: "typed offline" } : i)) };
  pending.push({ id: "term.1", author: terminal, before, after });
  s.mz.onHeadChange("local");
  assert.equal(await s.mz.showChange({ id: "term.1", author: terminal }, 2000), "shown");
  assert.equal(s.find(s.read().items, "a").name, "typed offline");
});
