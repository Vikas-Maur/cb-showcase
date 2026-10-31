// The materializer (§6.4) on real files, with a fake clock and a fake engine: the shared timeline.tsx (R7-01
// regeneration, R8-01 freeze view, R5-05 spacing), displace-then-install over unread saves, quiescence for in-place
// writers, per-agent views (R4-02 base, Finding 3 nonce, R5-03), the status sidecar (R5-04), app-closed imports.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Materializer, TIMELINE_FILE, PROJECT_FILE, viewPath, statusPath, type ViewRow } from "../src/node/materializer.ts";
import { jsonTimelineCodec } from "../src/codec.ts";
import { findRev } from "../src/header.ts";
import { FakeClock, FakeEngine, plainHost } from "./helpers/fake-engine.ts";

type Item = { id: string; [k: string]: unknown };

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const clip = (id: string, s: number, e: number, extra: Record<string, unknown> = {}): Item => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...extra });

async function setup(t: test.TestContext, items: Item[], opts: { start?: boolean } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "mz-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  const project = { id: "p1", name: "Demo", stateUpdatedAt: 1, timelineItems: items };
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }));
  const engine = new FakeEngine({ name: "Demo", timelineItems: items });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock });
  t.after(() => mz.close());
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
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "Demo", timelineItems: [clip("titleX", 0, 3, { textContent: "a" })] }, media: [] }));
  const engine = new FakeEngine({ name: "Demo", timelineItems: [clip("titleX", 0, 3, { textContent: "a" })] });
  const clock = new FakeClock();
  let race: (() => void) | null = null;
  // a codec whose print lets a foreign writer land its save mid-render (between the unread-save check and the install)
  const codec = { ...jsonTimelineCodec, print: (p: Record<string, unknown>, rev: string) => (race?.(), (race = null), jsonTimelineCodec.print(p, rev)) };
  const mz = new Materializer({ bundle, engine, host: plainHost, codec, clock, writeProject: false });
  t.after(() => mz.close());
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
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "D", timelineItems: [clip("a", 0, 5)] }, media: [] }));
  const engine = new FakeEngine({ name: "D", timelineItems: [clip("a", 0, 5)] });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock, writeProject: false, onCards: (c) => cards.push(c) });
  t.after(() => mz.close());
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
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { name: "D", timelineItems: [clip("a", 0, 5)] }, media: [] }));
  const engine = new FakeEngine({ name: "D", timelineItems: [clip("a", 0, 5)] });
  const clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock, writeProject: false, foldCase: true });
  t.after(() => mz.close());
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
