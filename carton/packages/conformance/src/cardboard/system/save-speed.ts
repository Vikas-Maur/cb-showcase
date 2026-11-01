// The save-speed stage (windows-sync's helper-perf R2 and their H8 review round 2), on the real engine, history and
// materializer: the shared file's superseded prints are released past `keepPrints` (R7-01's bound); a rewrite reads
// timeline.tsx once, stores the print's pin record with the path's token (or its state), and takes project.json's
// envelope from the host that just wrote it; a host write told with its head change is waited for; on a shared cut a
// windowless local agent's change and this replica's pending agent changes show in the frozen file; a save's cards
// carry their cut. Review rounds 1 to 5 of the stage at the end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { branchToken, cardboardAdapter, cardboardFilesHost, findRev, fromHost, jsonTimelineCodec, toHost } from "@carton/cardboard";
import { Materializer, cartonMaterializerEngine, TIMELINE_FILE, PROJECT_FILE, statStamp, type HostWrite, type MetaRow } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, render, BOB, HUMAN, type Item, type World } from "./world.ts";

const shown = (w: World) => parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items;
/** A commit at head by `who`, the materializer not told (the caller tells it as its host would). */
async function commit(w: World, who: Actor, fn: (items: Item[]) => void) {
  const h = await w.carton.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  fn(items);
  return w.carton.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: who });
}
const MINUTE = 60_000;
const hash8 = (ref: string) => /~([0-9a-f]{8})$/.exec(ref)![1]!;
const projectName = (w: World, id: string) => find((JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as { project: { timelineItems: Item[] } }).project.timelineItems, id).name;

test("save speed #1: the shared file's superseded prints are released past keepPrints; a writer on a released print of a confirmed state still applies exactly (R7-01) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], materializer: { keepPrints: { count: 4, ms: 10 * MINUTE } } });
  const old = w.agent("old-writer", { checks: false });
  const first = await old.read(); // a print of a confirmed state, read now and saved much later
  for (let i = 0; i < 70; i++) {
    await w.gui((its) => void (find(its, "a").name = `a${i}`));
    await w.tick(MINUTE);
  }
  const rows = await w.carton.store.range<unknown>("views", { prefix: ["pinned", "shared-file"] });
  const pins = (await w.carton.store.range<{ owners: { owner: string }[] }>("pins")).filter((r) => r.value.owners.some((o) => o.owner === "shared-file"));
  // the newest 4 or the last 10 minutes' (about 10), at the 64th pin, plus the 6 pinned since: not 70
  assert.ok(rows.length <= 20, `shared-file records: ${rows.length}`);
  assert.ok(pins.length <= 20, `shared-file pins: ${pins.length}`);
  assert.equal(rows.length, pins.length, "a record per pin");
  // its print released long ago, the state is confirmed: the save applies on it exactly
  const items = structuredClone(first.items);
  find(items, "b").name = "late save";
  await old.write(TIMELINE_FILE, render(first, items));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "b").name], ["a69", "late save"], "the later edit kept, the late one applied");
  assert.deepEqual(w.mz.log.cards, [], "on its own base: nothing to card");
});

test("save speed #1: a freeze view's print released past keepPrints: a writer's save on it is refused re-print, never applied on another base; the latest print applies [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], materializer: { keepPrints: { count: 4, ms: 5 * MINUTE } } });
  const director = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await director.read(); // the freeze starts
  await w.gui((its) => void (find(its, "a").name = "person")); // hidden: the view is a state of its own
  await w.tick(100);
  await director.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = "b0"));
  await w.tick(1000);
  const old = w.agent("old-writer", { checks: false });
  const first = await old.read(); // a freeze view's print
  assert.equal(find(first.items, "a").name, "a");
  for (let i = 1; i <= 70; i++) {
    await director.read();
    await director.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = `b${i}`));
    await w.tick(30_000);
  }
  const latest = findRev(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"))!.rev!;
  const items = structuredClone(first.items);
  find(items, "c").name = "late";
  await old.write(TIMELINE_FILE, render(first, items));
  await w.tick(1000);
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "b").name, find(head, "c").name], ["person", "b70", "c"], "refused: nothing applied");
  assert.ok(w.mz.log.applied.some((x) => /state unknown/i.test(String(x.error ?? ""))), "state unknown: re-print");
  const view = await w.engine.resolve(latest); // the print shown last is still pinned
  assert.deepEqual([find(toHost(view.baseDoc).timelineItems as Item[], "a").name, find(toHost(view.baseDoc).timelineItems as Item[], "b").name], ["a", "b70"]);
});

test("save speed #1: a held state's print (a freeze view) released past its owner's keep is state unknown, a newer one resolves; the keep holds for the owner's pins that don't repeat it [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const base = await w.carton.head();
  const refs: { branchId: string; seq: number; hash8: string }[] = [];
  for (let i = 0; i < 64; i++) {
    const host = toHost(base.doc);
    const items = structuredClone(host.timelineItems as Item[]);
    find(items, "a").name = `view ${i}`;
    // the first pin gives the rule; the 64th (where the engine prunes) doesn't repeat it
    const p = await w.engine.pin({ owner: "shared-view", doc: fromHost({ ...host, timelineItems: items }, base.doc), seq: base.ref.seq, ttlMs: 7 * 86_400_000, ...(i === 0 ? { keep: { count: 2, ms: MINUTE } } : {}) });
    refs.push({ branchId: p.branchId, seq: p.seq, hash8: hash8(p.ref) });
    w.clock.t += MINUTE;
  }
  await assert.rejects(w.carton.resolve(refs[0]!), /state unknown|pin released/i, "the oldest view's pin was released");
  await assert.rejects(w.carton.resolve(refs[60]!), /state unknown|pin released/i);
  assert.equal(toHost((await w.carton.resolve(refs[62]!)).doc).timelineItems!.find((x) => x.id === "a")!.name, "view 62", "within the newest two");
  assert.equal(toHost((await w.carton.resolve(refs[63]!)).doc).timelineItems!.find((x) => x.id === "a")!.name, "view 63");
});

test("save speed #1: a state pinned again as its owner's 64th pin, its own record past the keep, stays pinned: the old records are pruned before the pin [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const base = await w.carton.head();
  const held = (name: string) => {
    const host = toHost(base.doc);
    const items = structuredClone(host.timelineItems as Item[]);
    find(items, "a").name = name;
    return fromHost({ ...host, timelineItems: items }, base.doc);
  };
  const again = held("pinned twice");
  const pin = (doc: typeof again, defer = false) => w.engine.pin({ owner: "shared-view", doc, seq: base.ref.seq, ttlMs: 7 * 86_400_000, keep: { count: 1, ms: MINUTE }, deferRecord: defer });
  await pin(again);
  for (let i = 0; i < 62; i++) {
    w.clock.t += MINUTE;
    await pin(held(`view ${i}`));
  }
  w.clock.t += MINUTE;
  const p = await pin(again, true); // the 64th: the prune releases its old record's pin first, then it is pinned anew
  await w.engine.putMetas([p.record!]);
  assert.equal(toHost((await w.carton.resolve({ branchId: p.branchId, seq: p.seq, hash8: hash8(p.ref) })).doc).timelineItems!.find((x) => x.id === "a")!.name, "pinned twice");
});

test("save speed #2: a rewrite whose print fails still stores its pin's record; a rewrite with nothing to change refreshes it [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const records = async () => (await w.carton.store.range<{ expires: number }>("views", { prefix: ["pinned", "shared-file"] })).map((r) => ({ key: r.key.join("/"), at: r.value.expires }));
  const codec = (w.mz as unknown as { codec: { print: (...a: unknown[]) => unknown } }).codec;
  const print = codec.print.bind(codec);
  let fail = true;
  codec.print = (...a: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error("printer down");
    }
    return print(...a);
  };
  const was = (await records()).length;
  await w.gui((its) => void (find(its, "a").name = "renamed"));
  await w.tick(100); // the print fails (its retry comes later)
  assert.ok(w.mz.log.errors.some((e) => String(e.error).includes("printer down")), "the print failed");
  assert.notEqual(find(shown(w), "a").name, "renamed");
  assert.equal((await records()).length, was + 1, "the new state's pin has its record");
  await w.tick(1000);
  assert.equal(find(shown(w), "a").name, "renamed");
  const now = await records();
  w.clock.t += 10 * MINUTE;
  w.mz.onHeadChange("local"); // nothing moved: the file stays, the pin is taken again
  await w.tick(100);
  const after = await records();
  assert.equal(after.length, now.length);
  const latest = (xs: typeof now) => Math.max(...xs.map((x) => x.at ?? 0));
  assert.ok(latest(after) > latest(now), "the shown print's record refreshed");
});

test("save speed #2: a GUI change's rewrite reads timeline.tsx once; the path's token and the print's pin record are one write before the install, its state one after [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const tl = w.abs(TIMELINE_FILE);
  const rfs = fs.readFileSync;
  t.after(() => void (fs.readFileSync = rfs));
  let reads = 0;
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, o?: unknown) => ((p === tl && reads++), (rfs as (p: unknown, o?: unknown) => unknown)(p, o))) as typeof rfs;
  const writes: { keys: string[]; file: string }[] = [];
  const put = w.engine.putMeta.bind(w.engine);
  const puts = w.engine.putMetas.bind(w.engine);
  const note = (rows: readonly MetaRow[]) => writes.push({ keys: rows.map((r) => r.key.join("/")), file: rfs(tl, "utf8") });
  w.engine.putMeta = async (k, v) => (note([{ key: k, value: v }]), put(k, v));
  w.engine.putMetas = async (rows) => (note(rows), puts(rows));
  await w.gui((its) => void (find(its, "a").name = "renamed"));
  reads = 0;
  await w.tick(100);
  assert.equal(reads, 1, "timeline.tsx read once");
  assert.equal(find(shown(w), "a").name, "renamed");
  const mine = writes.filter((x) => x.keys.some((k) => k.startsWith(`file/${TIMELINE_FILE}/`) || k.startsWith("pinned/shared-file/")));
  assert.equal(mine.length, 2, JSON.stringify(mine.map((x) => x.keys)));
  assert.deepEqual(mine[0]!.keys.map((k) => k.split("/").slice(0, 2).join("/")), [`file/${TIMELINE_FILE}`, "pinned/shared-file"]);
  assert.equal(mine[0]!.keys[0], `file/${TIMELINE_FILE}/seen`);
  assert.ok(mine[0]!.file.includes('"a"') && !mine[0]!.file.includes("renamed"), "before the install");
  assert.deepEqual(mine[1]!.keys, [`file/${TIMELINE_FILE}/state`]);
  assert.ok(mine[1]!.file.includes("renamed"), "after it");
});

test("save speed #2: after an applied save, the regeneration's pin record is stored with the path's state [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const writes: string[][] = [];
  const puts = w.engine.putMetas.bind(w.engine);
  const put = w.engine.putMeta.bind(w.engine);
  w.engine.putMetas = async (rows) => ((writes.push(rows.map((r) => r.key.join("/"))), puts(rows)));
  w.engine.putMeta = async (k, v) => ((writes.push([k.join("/")]), put(k, v)));
  const agent = w.agent("editor");
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "saved"));
  await w.tick(1000);
  assert.equal(find(await w.head(), "a").name, "saved");
  // the agent's save started a freeze: the regenerated file is the freeze view's print
  const pinned = writes.filter((k) => k.some((x) => x.startsWith("pinned/shared-")));
  assert.equal(pinned.length, 1, JSON.stringify(writes));
  assert.deepEqual(pinned[0]!.map((x) => x.split("/").slice(0, 2).join("/")), [`file/${TIMELINE_FILE}`, "pinned/shared-view"]);
  assert.equal(pinned[0]![0], `file/${TIMELINE_FILE}/state`);
});

test("save speed #2: project.json the host has just written: its envelope is taken while the file has that stamp, unread; after another write the file is read [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], materializer: { writeProject: false } });
  const pj = w.abs(PROJECT_FILE);
  const rfs = fs.readFileSync;
  t.after(() => void (fs.readFileSync = rfs));
  let reads = 0;
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, o?: unknown) => ((p === pj && reads++), (rfs as (p: unknown, o?: unknown) => unknown)(p, o))) as typeof rfs;
  // the host's write: project.json with an item's local-only field (kept from the file, never versioned)
  const hostWrite = (tag: string) => {
    const env = JSON.parse(rfs(pj, "utf8")) as { project: { timelineItems: Item[] } };
    find(env.project.timelineItems, "a").annotations = [tag];
    fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
    fs.renameSync(`${pj}.tmp`, pj);
    return env;
  };
  hostWrite("on disk");
  const told = structuredClone(hostWrite("on disk")) as { project: { timelineItems: Item[] } };
  find(told.project.timelineItems, "a").annotations = ["as told"]; // what the host says it wrote (to see which is used)
  const stamp = (await statStamp(pj))!;
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "one"));
  w.mz.onHeadChange("gui", { after: Promise.resolve({ project: { envelope: told, stamp } }) });
  reads = 0;
  await w.tick(100);
  assert.equal(find(shown(w), "a").name, "one");
  assert.equal(reads, 0, "project.json not read");
  assert.deepEqual(find(shown(w), "a").annotations, ["as told"]);
  // another write since: the stamp told is no longer the file's, so the file is read
  hostWrite("written later");
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "two"));
  w.mz.onHeadChange("gui", { after: Promise.resolve({ project: { envelope: told, stamp } }) });
  await w.tick(100);
  assert.equal(find(shown(w), "a").name, "two");
  assert.deepEqual(find(shown(w), "a").annotations, ["written later"]);
});

test("save speed #3: a head change told with the host's write still landing: the rewrite waits for it, one due for another change too, and at most 5 s [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)] });
  const prints = () => w.mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE).length;
  const before = prints();
  let land!: () => void;
  const after = new Promise<void>((r) => (land = r));
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after });
  await w.tick(1000);
  assert.equal(prints(), before, "not while the host writes");
  // another change meanwhile (an agent's cb commit), told as usual: its rewrite would run inside the host's write
  await commit(w, { kind: "agent", id: "codex/1", group: "local:me@m1" }, (its) => void (find(its, "b").name = "cb"));
  w.mz.onHeadChange("local");
  await w.tick(1000);
  assert.equal(prints(), before, "that one waits too");
  assert.equal(find(shown(w), "a").name, "a");
  assert.notEqual(projectName(w, "a"), "gui", "project.json waits too");
  land();
  await w.tick(100);
  assert.equal(prints(), before + 1, "one rewrite once it landed");
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name], ["gui", "cb"]);
  assert.equal(projectName(w, "a"), "gui");
  // a host write that never says it landed holds the rewrite 5 s at most
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "never told"));
  w.mz.onHeadChange("gui", { after: new Promise(() => {}) });
  await w.tick(4000);
  assert.equal(find(shown(w), "a").name, "gui");
  await w.tick(1100);
  assert.equal(find(shown(w), "a").name, "never told");
});

test("save speed #3: on a shared cut, a remote change's rewrite waits for the host's write landing too [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)] });
  w.setShared(true);
  let land!: () => void;
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after: new Promise<void>((r) => (land = r)) });
  await w.remote((its) => void (find(its, "b").name = "remote")); // its rewrite is due at once (none for 30 s)
  await w.tick(1000);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name], ["a", "b"]);
  land();
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name], ["gui", "remote"]);
});

test("save speed #5: on a shared cut, a windowless agent of this machine's group shows in the frozen file; a teammate's agent and the person stay out [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], materializer: { group: "local:me@m1" } });
  w.setShared(true);
  await w.mz.onCb(); // a windowless agent's cb call: the freeze starts
  await w.gui((its) => void (find(its, "a").name = "person"));
  await w.tick(100);
  await commit(w, { kind: "agent", id: "codex/42", group: "local:me@m1" }, (its) => void (find(its, "b").name = "windowless agent"));
  w.mz.onHeadChange("local");
  await w.tick(100);
  await commit(w, { kind: "agent", id: "director/t9", group: "local:bob@m2" }, (its) => void (find(its, "c").name = "teammate's agent"));
  w.mz.onHeadChange("remote");
  await w.tick(100);
  const items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "c").name], ["a", "windowless agent", "c"]);
});

test("save speed #5: on a shared cut offline, this replica's pending agent changes show in the frozen file; the person's pending edit stays out, and an agent's change over it waits for its confirmation [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true });
  assert.equal(w.engine.shared(), true, "read from the cut");
  const director = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await director.read(); // the freeze starts
  assert.equal((await w.gui((its) => void (find(its, "a").name = "person"))).status, "pending");
  await w.tick(100);
  assert.equal((await commit(w, director.actor, (its) => void (find(its, "b").name = "director offline"))).status, "pending");
  w.mz.onHeadChange("local");
  await w.tick(100);
  let items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name], ["a", "director offline"]);
  // the person's next pending edit: nothing to print, nothing pinned
  const pin = w.engine.pin.bind(w.engine);
  let pins = 0;
  w.engine.pin = async (o) => ((o.owner.startsWith("shared-") && pins++), pin(o));
  await w.gui((its) => void (find(its, "b").startTime = 6));
  await w.tick(100);
  assert.equal(pins, 0, "the queue's agent changes as printed: no rewrite");
  w.engine.pin = pin;
  // over the person's pending (hidden) edit, and an edit of its own: not shown in part, all of it once confirmed
  await commit(w, director.actor, (its) => {
    find(its, "a").name = "director over person";
    find(its, "b").opacity = 0.25;
  });
  w.mz.onHeadChange("local");
  await w.tick(100);
  items = shown(w);
  assert.deepEqual([find(items, "a").name, find(items, "b").name, find(items, "b").opacity], ["a", "director offline", 1]);
  // built on the person's pending item (an edit of a clip the person added): the merge would bring the item in
  await commit(w, HUMAN, (its) => void its.push(clip("p", 20, 25, { name: "person's new clip" })));
  w.mz.onHeadChange("local");
  await commit(w, director.actor, (its) => void (find(its, "p").opacity = 0.5));
  w.mz.onHeadChange("local");
  await w.tick(100);
  assert.equal(shown(w).find((x) => x.id === "p"), undefined, "the person's pending clip stays out");
  const p = await w.carton.pendingChanges();
  assert.deepEqual(p.changes.map((c) => [c.author.id, find(toHost(c.after).timelineItems as Item[], "a").name]), [[HUMAN.id, "person"], [director.actor.id, "person"], [HUMAN.id, "person"], [director.actor.id, "director over person"], [HUMAN.id, "director over person"], [director.actor.id, "director over person"]], "core's pending changes, in order, with their states");
});

test("save speed #5: a save's cards carry the cut it was committed on, also when the save is finished from its stored result [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)] });
  const old = w.agent("old-writer", { checks: false });
  const r = await old.read();
  await w.gui((its) => void (find(its, "a").name = "person"));
  await w.tick(100);
  // the save's cards can't be stored the first time: the file is read again and finished from the stored result
  const put = w.engine.putMeta.bind(w.engine);
  let fail = true;
  w.engine.putMeta = async (k, v) => {
    if (fail && k[0] === "cards") {
      fail = false;
      throw new Error("store busy");
    }
    return put(k, v);
  };
  const commits = w.engine.commit.bind(w.engine);
  let n = 0;
  w.engine.commit = async (i) => ((n++), commits(i));
  const items = structuredClone(r.items);
  find(items, "a").name = "stale";
  await old.write(TIMELINE_FILE, render(r, items));
  await w.tick(2000);
  assert.equal(n, 1, "committed once");
  assert.equal(w.mz.log.cards.length, 1);
  assert.equal(w.mz.log.cards[0]!.cut, w.carton.cut);
  assert.equal((await w.engine.getMeta<{ cut?: string }>(["cards", w.mz.log.cards[0]!.batch]))?.cut, w.carton.cut, "stored with it");
});

// Review round 1 of this stage (GPT 6.1 Sol): the print the file shows is held through the prune; a pending agent change
// rebased under the same id is printed again; a host write still landing holds a freeze's end, and a print made from an
// older project.json while it landed is made again.

test("save speed review 1 #1: the print the shared file shows is never released, however many pins come after it (prints that failed) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], materializer: { writeProject: false, keepPrints: { count: 1, ms: 0 } } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await w.gui((its) => void (find(its, "a").name = "person"));
  await w.tick(100);
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = "shown"));
  await w.tick(100);
  const text = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  const rev = findRev(text)!.rev!;
  const codec = (w.mz as unknown as { codec: { print: (...a: unknown[]) => unknown } }).codec;
  const print = codec.print;
  codec.print = () => {
    throw new Error("printer unavailable");
  };
  t.after(() => void (codec.print = print));
  for (let i = 0; i < 70; i++) {
    await commit(w, agent.actor, (its) => void (find(its, "b").name = `unprinted ${i}`));
    w.mz.onHeadChange("local");
    await w.tick(100);
  }
  assert.equal(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"), text, "nothing printed since");
  assert.equal(find(toHost((await w.engine.resolve(rev)).baseDoc).timelineItems as Item[], "b").name, "shown", "its pin kept");
});

test("save speed review 1 #2: a pending agent change rebased under the same id (a remote edit took one of its edits) is printed as it is now [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await commit(w, agent.actor, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  w.mz.onHeadChange("local");
  await w.tick(100);
  assert.equal(find(shown(w), "a").name, "agent");
  const before = await w.carton.pendingChanges();
  // a teammate's rename of the same clip confirmed by the server (its row stored, as this replica's sync would)
  const copy = createMemoryStore();
  for (const table of ["meta", "cuts", "changes", "ids", "keyframes", "states", "lineage", "pins"]) {
    const rows = await w.carton.store.range(table);
    if (rows.length) await copy.write(rows.map((r) => ({ table, key: r.key, value: r.value })));
  }
  const cut = await copy.get<Record<string, unknown>>("cuts", [w.carton.cut]);
  await copy.write([{ table: "cuts", key: [w.carton.cut], value: { ...cut, sequencer: { kind: "local" } } }]);
  const server = await Carton.open({ adapter: cardboardAdapter, store: copy, actor: { kind: "human", id: "bob" } });
  t.after(() => server.close());
  const h = await server.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  find(items, "a").name = "teammate";
  assert.equal((await server.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc) })).status, "confirmed");
  const rows = await copy.range("changes", { prefix: [w.carton.cut], gt: [w.carton.cut, before.seq] });
  await w.carton.store.write(rows.map((r) => ({ table: "changes", key: r.key, value: r.value })));
  const after = await w.carton.pendingChanges();
  assert.deepEqual(after.changes.map((c) => c.id), before.changes.map((c) => c.id), "the same id");
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "its rename gone, its opacity kept; the teammate's rename hidden");
});

test("save speed review 1 #3: a freeze that ends while the host's write lands leaves the rewrite to it (5 s at most) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1" } });
  await agent.read();
  const prints = () => w.mz.log.rewrites.filter((r) => r.path === TIMELINE_FILE).length;
  const before = prints();
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after: new Promise(() => {}) });
  await agent.stop();
  assert.equal(prints(), before, "not in the middle of the host's write");
  await w.tick(5100);
  assert.equal(find(shown(w), "a").name, "gui");
});

test("save speed review 1 #3: a print made from project.json before the host's write landed is made again from what it wrote [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], materializer: { writeProject: false } });
  let land!: (x: HostWrite) => void;
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (land = r)) });
  await w.mz.printShared(); // `cb source print` meanwhile: from project.json as it was
  assert.deepEqual(find(shown(w), "a").annotations, ["old"]);
  const pj = w.abs(PROJECT_FILE);
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: { timelineItems: Item[] } };
  find(env.project.timelineItems, "a").annotations = ["new"];
  fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
  fs.renameSync(`${pj}.tmp`, pj);
  land({ project: { envelope: env, stamp: (await statStamp(pj))! } });
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "a").annotations], ["gui", ["new"]]);
});

// Review round 2 of this stage (GPT 6.1 Sol): the print the file shows on disk is held, whoever printed it; a pending
// file save rebased before its confirmation shows as it is now; a print made while a host write landed is checked once
// it has, frozen or not, and after the wait for it ended too; a project.json change the print doesn't show makes no new
// print.

/**
 * A server for this replica's shared cut: a copy of its store, sequenced there (the server's log). `commit` makes a
 * change there (`id`: this replica's pending change, which the server confirms so); `deliver` stores what the server
 * confirmed since in this replica's store, as its sync would.
 */
async function serverOf(t: { after: (fn: () => unknown) => void }, w: World) {
  const copy = createMemoryStore();
  for (const table of ["meta", "cuts", "changes", "ids", "keyframes", "states", "lineage", "pins"]) {
    const rows = await w.carton.store.range(table);
    if (rows.length) await copy.write(rows.map((r) => ({ table, key: r.key, value: r.value })));
  }
  const cut = w.carton.cut;
  const row = await copy.get<Record<string, unknown>>("cuts", [cut]);
  await copy.write([{ table: "cuts", key: [cut], value: { ...row, sequencer: { kind: "local" } } }]);
  const server = await Carton.open({ adapter: cardboardAdapter, store: copy, actor: { kind: "human", id: "bob" } });
  t.after(() => server.close());
  let delivered = (await w.carton.pendingChanges()).seq;
  return {
    async commit(who: Actor, fn: (items: Item[]) => void, id?: string) {
      const h = await server.head();
      const host = toHost(h.doc);
      const items = structuredClone(host.timelineItems as Item[]);
      fn(items);
      const r = await server.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: who, ...(id ? { id } : {}) } as never);
      assert.equal(r.status, "confirmed");
    },
    async deliver() {
      const rows = await copy.range("changes", { prefix: [cut], gt: [cut, delivered] });
      await w.carton.store.write(rows.map((r) => ({ table: "changes", key: r.key, value: r.value })));
      for (const r of rows) delivered = Math.max(delivered, Number((r.key as unknown[])[1]));
    },
  };
}
const failingPrinter = { ...jsonTimelineCodec, print: () => { throw new Error("printer unavailable"); } };

test("save speed review 2 #1: after a restart, the print timeline.tsx shows on disk keeps its pin, however many pins come after it [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], offlineShared: true, materializer: { writeProject: false, keepPrints: { count: 1, ms: 0 } } });
  await w.gui((its) => void (find(its, "a").name = "shown pending"));
  await w.tick(100);
  const text = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  const rev = findRev(text)!.rev!;
  assert.equal(find(shown(w), "a").name, "shown pending", "a held state (pending)");
  await w.mz.close();
  const engine = cartonMaterializerEngine(w.carton, { clock: () => w.clock.now() });
  const mz = new Materializer({ bundle: w.bundle, engine, host: cardboardFilesHost, codec: failingPrinter, clock: w.clock, writeProject: false, keepPrints: { count: 1, ms: 0 } });
  t.after(() => mz.close());
  await assert.rejects(mz.start(), /printer unavailable/);
  for (let i = 0; i < 70; i++) {
    await commit(w, HUMAN, (its) => void (find(its, "a").name = `unprinted ${i}`));
    w.clock.t++;
    await assert.rejects(mz.printShared(), /printer unavailable/);
  }
  assert.equal(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"), text, "nothing printed since");
  assert.equal(find(toHost((await engine.resolve(rev)).baseDoc).timelineItems as Item[], "a").name, "shown pending", "its pin kept");
});

test("save speed review 2 #1: another materializer's prune keeps the print this one installed [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], offlineShared: true, materializer: { writeProject: false, keepPrints: { count: 1, ms: 0 } } });
  await w.gui((its) => void (find(its, "a").name = "shown pending"));
  await w.tick(100);
  const text = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  const rev = findRev(text)!.rev!;
  const engine = cartonMaterializerEngine(w.carton, { clock: () => w.clock.now() });
  const other = new Materializer({ bundle: w.bundle, engine, host: cardboardFilesHost, codec: failingPrinter, clock: w.clock, writeProject: false, keepPrints: { count: 1, ms: 0 }, displacedDir: ".carton/other-displaced" });
  t.after(() => other.close());
  for (let i = 0; i < 70; i++) {
    await commit(w, HUMAN, (its) => void (find(its, "a").name = `unprinted ${i}`));
    w.clock.t++;
    await assert.rejects(other.printShared(), /printer unavailable/);
  }
  assert.equal(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"), text);
  assert.equal(find(toHost((await w.engine.resolve(rev)).baseDoc).timelineItems as Item[], "a").name, "shown pending", "its pin kept");
});

test("save speed review 2 #1: a hold that can't be told (the file unreadable) releases nothing, and the pin is made [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], offlineShared: true, materializer: { writeProject: false } });
  const keep = { count: 1, ms: 0 };
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "pending")); // a held state: resolves only while pinned
  const first = await w.engine.pin({ owner: "shared-file", ttlMs: 7 * 86_400_000, keep });
  const hold = async (): Promise<never> => {
    throw new Error("EACCES");
  };
  for (let i = 0; i < 70; i++) {
    await commit(w, HUMAN, (its) => void (find(its, "a").name = `n${i}`));
    w.clock.t++;
    await w.engine.pin({ owner: "shared-file", ttlMs: 7 * 86_400_000, keep: { ...keep, hold } });
  }
  assert.equal(find(toHost((await w.engine.resolve(findRev(`// cardboard:rev ${first.ref} b:${branchToken(first.branchId)}`)!.rev!)).baseDoc).timelineItems as Item[], "a").name, "pending", "not released");
});

test("save speed review 2 #2: a pending save of the frozen file rebased before its confirmation (a remote edit took one of its edits) shows as it is now [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  assert.equal(find(shown(w), "a").name, "agent");
  const pending = await w.carton.pendingChanges();
  assert.deepEqual(pending.changes.map((c) => c.rebases), [0], "as committed");
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
  await server.deliver();
  const after = await w.carton.pendingChanges();
  assert.deepEqual(after.changes.map((c) => c.id), pending.changes.map((c) => c.id), "the same id");
  assert.deepEqual(after.changes.map((c) => c.rebases), [1], "rebased once");
  assert.equal(find(toHost(after.changes[0]!.after).timelineItems as Item[], "a").name, "teammate", "its rename taken away");
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "its rename gone, its opacity kept; the teammate's rename hidden");
});

test("save speed review 2 #2: a pending save of the frozen file confirmed as applied shows as saved before and after; one confirmed but not folded yet still shows under the next saves, which aren't taken for repeats of it [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  const late = w.agent("director/c1/t1/sub", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  const old = await late.read(); // a print the later writer still holds
  const person = await w.gui((its) => void (find(its, "a").name = "person"));
  await w.tick(100);
  // over the person's pending (hidden) rename: a card keeps the person's; the save shows as the agent saved it
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  const view = () => {
    const its = shown(w);
    return [find(its, "a").name, find(its, "b").opacity, find(its, "c").name];
  };
  assert.deepEqual(view(), ["agent", 0.5, "c"]);
  const save1 = (await w.carton.pendingChanges()).changes.find((c) => c.author.id === agent.actor.id)!;
  // the server confirms both, as they were applied; this replica hasn't folded them yet when the next save comes
  const server = await serverOf(t, w);
  await server.commit(HUMAN, (its) => void (find(its, "a").name = "person"), (person as { id: string }).id);
  await server.commit(agent.actor, (its) => void (find(its, "b").opacity = 0.5), save1.id);
  await server.deliver();
  assert.deepEqual((await w.carton.pendingChanges()).changes, [], "confirmed");
  // a save written on the print before the first save, repeating its edit: not a repeat of a hidden change
  const items = structuredClone(old.items);
  find(items, "b").opacity = 0.5;
  find(items, "b").name = "late";
  await late.write(TIMELINE_FILE, render(old, items));
  await w.mz.idle(); // the save's own regeneration (its next save's base), before any timer
  assert.deepEqual([...view(), find(shown(w), "b").name], ["agent", 0.5, "c", "late"], "the first save under it; the person's rename still hidden");
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "b").opacity = 0.75;
    find(its, "c").name = "agent c";
  });
  await w.mz.idle();
  assert.deepEqual([...view(), find(shown(w), "b").name], ["agent", 0.75, "agent c", "late"], "the person's rename still hidden");
  w.mz.onHeadChange("remote"); // the confirmation's event
  await w.tick(100);
  assert.deepEqual([...view(), find(shown(w), "b").name], ["agent", 0.75, "agent c", "late"]);
});

test("save speed review 2 #2: an unannounced writer's pending save of the frozen file, rebased, shows as it is now, pending and once confirmed [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const director = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await director.read();
  const tool = w.agent("some-tool"); // not hooked: its save is `external:` (no agent)
  await tool.read();
  await tool.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "tool";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["tool", 0.5]);
  const save = (await w.carton.pendingChanges()).changes[0]!;
  assert.ok(!/^agent$|^subagent$/.test(save.author.kind), "not an agent's");
  // the queue as printed: the person's next (hidden) change prints nothing, pins nothing
  const pin = w.engine.pin.bind(w.engine);
  let pins = 0;
  w.engine.pin = async (o) => ((o.owner.startsWith("shared-") && pins++), pin(o));
  await w.gui((its) => void (find(its, "b").startTime = 6));
  await w.tick(100);
  assert.equal(pins, 0);
  w.engine.pin = pin;
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
  await server.deliver(); // rebased, still pending
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "pending: its rename gone; the teammate's hidden");
  await server.commit(save.author, (its) => void (find(its, "b").opacity = 0.5), save.id); // confirmed so
  await server.deliver();
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "confirmed: the same");
});

test("save speed review 2 #2: a cut switch in a freeze leaves the old cut's pending saves behind [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], offlineShared: true, materializer: { writeProject: false } });
  const main = w.carton.cut;
  const b = await w.carton.fork("Cut B"); // shared too (offline): its frozen file takes pending changes
  await w.carton.switchTo(b.id);
  await w.carton.share();
  await w.carton.switchTo(main);
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "agent on main"));
  await w.tick(100);
  assert.equal(find(shown(w), "a").name, "agent on main");
  await w.carton.switchTo(b.id);
  await w.mz.onCutSwitch(b.id);
  assert.equal(w.engine.shared(), true);
  assert.equal(find(shown(w), "a").name, "a", "Cut B as it is");
});

test("save speed review 2 #2: a freeze starts without the pending saves an earlier freeze held [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "agent"));
  await w.tick(100);
  const save = (await w.carton.pendingChanges()).changes[0]!;
  await agent.stop();
  await w.tick(61_000); // the freeze ends (its windowless minute after the save too)
  assert.equal(w.mz.freeze.active, false);
  // the server confirms the change with other content (its rename gone)
  const server = await serverOf(t, w);
  await server.commit(save.author, (its) => void (find(its, "b").opacity = 0.3), save.id);
  await server.deliver();
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.3]);
  const next = w.agent("director/c1/t2", { hooked: true, actor: { turn: "t2", group: "local:me@m1" } });
  await next.read(); // another freeze
  await next.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = "next"));
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name], ["a", "next"], "the earlier freeze's save not shown again");
});

test("save speed review 2 #3: in a freeze, a print made while a host write landed is checked once it has [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1" } });
  await agent.read();
  let land!: (x: HostWrite) => void;
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (land = r)) });
  await w.mz.printShared(); // `cb source print` meanwhile: from project.json as it was
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "a").annotations], ["gui", ["old"]]);
  const pj = w.abs(PROJECT_FILE);
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: { timelineItems: Item[] } };
  find(env.project.timelineItems, "a").annotations = ["new"];
  fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
  fs.renameSync(`${pj}.tmp`, pj);
  land({ project: { envelope: env, stamp: (await statStamp(pj))! } });
  await w.tick(100);
  assert.deepEqual(find(shown(w), "a").annotations, ["new"]);
  // checked once: the person's next change (hidden by the freeze) prints nothing, pins nothing
  const pin = w.engine.pin.bind(w.engine);
  let pins = 0;
  w.engine.pin = async (o) => ((o.owner.startsWith("shared-") && pins++), pin(o));
  await w.gui((its) => void (find(its, "a").startTime = 1));
  await w.tick(100);
  assert.equal(pins, 0);
});

test("save speed review 2 #4: a host write that lands after the wait for it ended still reaches the file, frozen or not [real engine]", async (t) => {
  for (const frozen of [false, true]) {
    const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], materializer: { writeProject: false } });
    if (frozen) await w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1" } }).read();
    let land!: (x: HostWrite) => void;
    await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
    w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (land = r)) });
    if (frozen) await w.mz.printShared();
    await w.tick(5100);
    assert.deepEqual([find(shown(w), "a").name, find(shown(w), "a").annotations], ["gui", ["old"]], `frozen ${frozen}: printed once the wait ended`);
    const pj = w.abs(PROJECT_FILE);
    const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: { timelineItems: Item[] } };
    find(env.project.timelineItems, "a").annotations = ["new"];
    fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
    fs.renameSync(`${pj}.tmp`, pj);
    land({ project: { envelope: env, stamp: (await statStamp(pj))! } });
    await w.tick(100);
    assert.deepEqual(find(shown(w), "a").annotations, ["new"], `frozen ${frozen}`);
  }
});

test("save speed review 2 #5: project.json written again with nothing the print shows makes no new print (an agent's next Edit isn't refused) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], materializer: { writeProject: false } });
  const agent = w.agent("unhooked");
  const read = await agent.read();
  const pj = w.abs(PROJECT_FILE);
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: Record<string, unknown> };
  env.project.lastOpenedAt = "tomorrow";
  fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
  fs.renameSync(`${pj}.tmp`, pj);
  w.mz.onHeadChange("gui", { after: Promise.resolve({ project: { envelope: env, stamp: (await statStamp(pj))! } }) });
  await w.tick(100);
  assert.equal(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"), read.text, "the same file");
  assert.equal(await agent.edit(TIMELINE_FILE, (its) => void (find(its, "a").name = "agent")), true);
});

// Review round 3 of this stage (GPT 6.1 Sol): a save confirmed rebased and not folded yet shows by what was confirmed;
// a save rebased before it was recorded shows by its edits as they are; a file on disk that names no print releases
// nothing; a host write that lands while a print is made gets that print checked.

test("save speed review 3 #1: a pending save of the frozen file confirmed rebased, the next save before its fold, shows by what was confirmed [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  const save = (await w.carton.pendingChanges()).changes[0]!;
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
  await server.commit(agent.actor, (its) => void (find(its, "b").opacity = 0.5), save.id); // its rename lost
  await server.deliver();
  assert.deepEqual((await w.carton.pendingChanges()).changes, []);
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "c").name = "next"));
  await w.mz.idle(); // its regeneration, before the confirmation's own rewrite
  const its = shown(w);
  assert.deepEqual([find(its, "a").name, find(its, "b").opacity, find(its, "c").name], ["a", 0.5, "next"], "the lost rename not shown again; the teammate's hidden");
});

test("save speed review 3 #1: a save the view already holds once no longer pending (a restart at head) is let go, not looked for at every print [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "agent"));
  await w.tick(100);
  const save = (await w.carton.pendingChanges()).changes[0]!;
  const server = await serverOf(t, w);
  await server.commit(agent.actor, (its) => void (find(its, "a").name = "agent"), save.id);
  await server.deliver();
  await w.mz.printShared(); // `cb source print`: the freeze restarts at head, which holds the save
  const mz = w.mz as unknown as { foldAgentChanges: () => Promise<boolean> };
  const fold = mz.foldAgentChanges.bind(w.mz);
  let folds = 0;
  mz.foldAgentChanges = () => ((folds++), fold());
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = "next"));
  await w.mz.idle();
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name], ["agent", "next"]);
  assert.equal(folds, 0, "no fold for a save already let go");
});

test("save speed review 3 #2: a pending save of the frozen file rebased before it was recorded shows by its edits as they are [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
  const commitSave = w.engine.commit.bind(w.engine);
  let once = false;
  w.engine.commit = async (input) => {
    const res = await commitSave(input);
    if (!once) {
      once = true;
      await server.deliver(); // the teammate's rename arrives just after the save's commit: rebased at once
    }
    return res;
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  assert.deepEqual((await w.carton.pendingChanges()).changes.map((c) => c.rebases), [1]);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "its rename gone; the teammate's hidden");
});

test("save speed review 3 #3: a timeline.tsx on disk that names no print (cut short by a writer still writing it) releases nothing [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5)], offlineShared: true, materializer: { writeProject: false, keepPrints: { count: 1, ms: 0 } } });
  await w.gui((its) => void (find(its, "a").name = "shown pending"));
  await w.tick(100);
  const text = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  const rev = findRev(text)!.rev!;
  const engine = cartonMaterializerEngine(w.carton, { clock: () => w.clock.now() });
  const other = new Materializer({ bundle: w.bundle, engine, host: cardboardFilesHost, codec: failingPrinter, clock: w.clock, writeProject: false, keepPrints: { count: 1, ms: 0 }, displacedDir: ".carton/other-displaced" });
  t.after(() => other.close());
  await assert.rejects(other.printShared(), /printer unavailable/);
  fs.writeFileSync(w.abs(TIMELINE_FILE), "// card"); // an in-place writer, paused after truncating
  for (let i = 0; i < 70; i++) {
    await commit(w, HUMAN, (its) => void (find(its, "a").name = `unprinted ${i}`));
    w.clock.t++;
    await assert.rejects(other.printShared(), /printer unavailable/);
  }
  fs.writeFileSync(w.abs(TIMELINE_FILE), text); // it finishes, on the print it read
  assert.equal(find(toHost((await engine.resolve(rev)).baseDoc).timelineItems as Item[], "a").name, "shown pending", "its pin kept");
});

test("save speed review 3 #4: in a freeze, a host write that lands while a print is made gets that print checked [real engine]", async (t) => {
  const codec = { ...jsonTimelineCodec };
  const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], codec, materializer: { writeProject: false } });
  await w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } }).read();
  let land!: (x: HostWrite) => void;
  await commit(w, HUMAN, (its) => void (find(its, "a").name = "gui"));
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (land = r)) });
  const print = codec.print.bind(codec);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  codec.print = (async (...args: Parameters<typeof print>) => {
    const text = await print(...args);
    started();
    await gate;
    return text;
  }) as typeof codec.print;
  const printing = w.mz.printShared(); // from project.json as it is now
  await entered;
  const pj = w.abs(PROJECT_FILE);
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: { timelineItems: Item[] } };
  find(env.project.timelineItems, "a").annotations = ["new"];
  fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
  fs.renameSync(`${pj}.tmp`, pj);
  land({ project: { envelope: env, stamp: (await statStamp(pj))! } });
  await Promise.resolve();
  release();
  await printing;
  codec.print = print;
  await w.tick(100);
  assert.deepEqual(find(shown(w), "a").annotations, ["new"]);
});

// Review round 4 of this stage (GPT 6.1 Sol): a save confirmed rebased before it was recorded shows by what was
// confirmed; a rebase that leaves a save's edits as they were keeps it as applied; a host write landing while the file
// is checked unchanged gets it checked again.

test("save speed review 4 #1: a pending save of the frozen file confirmed rebased before it was recorded shows by what was confirmed [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
  const commitSave = w.engine.commit.bind(w.engine);
  let once = false;
  w.engine.commit = async (input) => {
    const res = await commitSave(input);
    if (!once) {
      once = true;
      // just after the save's commit: the server confirms it after the teammate's rename, its own rename lost
      await server.commit(agent.actor, (its) => void (find(its, "b").opacity = 0.5), res.id);
      await server.deliver();
    }
    return res;
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.tick(100);
  assert.deepEqual((await w.carton.pendingChanges()).changes, []);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "its lost rename not shown; the teammate's hidden");
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "nor after the confirmation's rewrite");
});

test("save speed review 4 #2: a pending save of the frozen file rebased with its edits as they were (a teammate's edit elsewhere) stays as applied [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await w.gui((its) => void (find(its, "a").name = "person")); // hidden; the agent's rename over it is carded
  await w.tick(100);
  const server = await serverOf(t, w);
  await server.commit(BOB, (its) => void (find(its, "c").name = "teammate"));
  const commitSave = w.engine.commit.bind(w.engine);
  let once = false;
  w.engine.commit = async (input) => {
    const res = await commitSave(input);
    if (!once) {
      once = true;
      await server.deliver(); // just after the save's commit: rebased over an edit of another clip
    }
    return res;
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.mz.idle();
  const save = (await w.carton.pendingChanges()).changes.find((c) => c.author.id === agent.actor.id)!;
  assert.deepEqual([save.rebases, save.edited], [1, false], "rebased, its edits as they were");
  const its = shown(w);
  assert.deepEqual([find(its, "a").name, find(its, "b").opacity, find(its, "c").name], ["agent", 0.5, "c"], "as the agent saved it; the teammate's edit hidden");
});

test("save speed review 4 #3: in a freeze, a host write that lands while the file is checked unchanged gets it checked again [real engine]", async (t) => {
  const codec = { ...jsonTimelineCodec };
  const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], codec, materializer: { writeProject: false } });
  await w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } }).read();
  const pj = w.abs(PROJECT_FILE);
  const write = (env: Record<string, unknown>) => {
    fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
    fs.renameSync(`${pj}.tmp`, pj);
  };
  let first!: (x: HostWrite) => void;
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (first = r)) });
  await w.mz.printShared(); // while the first write lands
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: Record<string, unknown> & { timelineItems: Item[] } };
  env.project.lastOpenedAt = "later"; // nothing the print shows
  write(env);
  first({ project: { envelope: env, stamp: (await statStamp(pj))! } });
  const print = codec.print.bind(codec);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  codec.print = (async (...args: Parameters<typeof print>) => {
    const text = await print(...args);
    started();
    await gate;
    return text;
  }) as typeof codec.print;
  const checking = w.tick(100); // the first write's check: the same bytes
  await entered;
  let second!: (x: HostWrite) => void;
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (second = r)) });
  const newer = structuredClone(env);
  find(newer.project.timelineItems, "a").annotations = ["new"];
  write(newer);
  second({ project: { envelope: newer, stamp: (await statStamp(pj))! } }); // lands while the check prints
  await Promise.resolve();
  release();
  await checking;
  codec.print = print;
  await w.tick(100);
  assert.deepEqual(find(shown(w), "a").annotations, ["new"]);
});

test("save speed review 4 #1: a save of the frozen file confirmed at its commit (absorbed: the same edit already pending) still shows as saved [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  await w.gui((its) => {
    find(its, "a").name = "same";
    find(its, "b").startTime = 6;
  }); // hidden by the freeze
  await w.tick(100);
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "a").name = "same")); // the same edit
  await w.tick(100);
  const res = w.mz.log.applied.at(-1)!;
  assert.equal(res.status, "confirmed", "absorbed: confirmed at its commit, nothing of its own");
  assert.equal(find(shown(w), "a").name, "same", "the agent's own edit shows");
  await agent.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "b").name = "next")); // a later print
  w.mz.onHeadChange("local");
  await w.tick(100);
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").name, find(shown(w), "b").startTime], ["same", "next", 5], "still; the person's move hidden");
});

// Review round 5 of this stage (GPT 6.1 Sol): a rebase that changed a pending change's edits still says so after the
// queue is loaded again from the store; a retried save keeps what its first attempt recorded; a host write still
// landing when the file is found unchanged gets it checked once it has.

test("save speed review 5 #1: a pending save of the frozen file rebased (an edit taken away), the queue loaded again before it was recorded, shows by its edits as they are [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  const server = await serverOf(t, w);
  const commitSave = w.engine.commit.bind(w.engine);
  let once = false;
  w.engine.commit = async (input) => {
    const res = await commitSave(input);
    if (!once) {
      once = true;
      // just after the save's commit: a teammate's rename takes the save's away, and the rebased version is stored
      await server.commit(BOB, (its) => void (find(its, "a").name = "teammate"));
      await server.deliver();
      assert.equal((await w.carton.pendingChanges()).changes.find((c) => c.id === res.id)!.edited, true);
      await w.carton.head();
      // then a settle loses the store's fence (another holder took the lease): the queue is loaded again from the store
      await w.carton.store.write([{ table: "meta", key: ["test-fence"], value: true }]);
      await w.carton.sync!.connect({ nonce: "old-holder", conditions: [{ table: "meta", key: ["test-fence"], expect: "absent" }], timeoutMs: 1 });
      await server.commit(BOB, (its) => void (find(its, "c").name = "unrelated"));
      await server.deliver();
      await w.carton.pendingChanges();
      const loaded = (await w.carton.pendingChanges()).changes.find((c) => c.id === res.id)!;
      assert.equal(find(toHost(loaded.after).timelineItems as Item[], "a").name, "teammate", "loaded as stored, rebased");
      assert.equal(loaded.edited, true, "still said to be changed by its rebase");
    }
    return res;
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.mz.idle();
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["a", 0.5], "its lost rename not shown; the teammate's hidden");
});

test("save speed review 5 #1: a pending save of the frozen file rebased with its edits as they were, the queue loaded again before it was recorded, stays as applied [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  const person = await w.gui((its) => void (find(its, "a").name = "person")); // hidden; the agent's rename over it is carded
  await w.tick(100);
  const server = await serverOf(t, w);
  const commitSave = w.engine.commit.bind(w.engine);
  let once = false;
  w.engine.commit = async (input) => {
    const res = await commitSave(input);
    if (!once) {
      once = true;
      // just after the save's commit: a teammate's edit of another clip, then the person's rename confirmed: the save,
      // rebased, is stored as it is now
      await server.commit(BOB, (its) => void (find(its, "c").name = "teammate"));
      await server.commit(HUMAN, (its) => void (find(its, "a").name = "person"), (person as { id: string }).id);
      await server.deliver();
      await w.carton.pendingChanges();
      await w.carton.head(); // the settle stores it
      // then a settle loses the store's fence (another holder took the lease): the queue is loaded again from the store
      await w.carton.store.write([{ table: "meta", key: ["test-fence"], value: true }]);
      await w.carton.sync!.connect({ nonce: "old-holder", conditions: [{ table: "meta", key: ["test-fence"], expect: "absent" }], timeoutMs: 1 });
      await server.commit(BOB, (its) => void (find(its, "c").opacity = 0.8));
      await server.deliver();
      await w.carton.pendingChanges(); // its settle loses the fence: the queue is loaded again, the save as stored
    }
    return res;
  };
  await agent.editUntilDone(TIMELINE_FILE, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.mz.idle();
  const save = (await w.carton.pendingChanges()).changes.find((c) => c.author.id === agent.actor.id)!;
  assert.deepEqual([save.rebases > 0, save.edited], [true, false], "rebased, its edits as they were");
  const its = shown(w);
  assert.deepEqual([find(its, "a").name, find(its, "b").opacity, find(its, "c").name], ["agent", 0.5, "c"], "as the agent saved it; the teammate's edits hidden");
});

test("save speed review 5 #2: a save of the frozen file retried from its stored result after its confirmation keeps what its first attempt recorded (shown as applied) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)], offlineShared: true, materializer: { writeProject: false } });
  const agent = w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } });
  await agent.read();
  // a decoded row for each read, as a persistent store gives (store-memory hands out its own)
  const get = w.engine.getMeta.bind(w.engine);
  w.engine.getMeta = async (key) => structuredClone(await get(key));
  const view = await w.mz.printView("agent", agent.actor, { hooked: true });
  await agent.read(view.path);
  const person = await w.gui((its) => void (find(its, "a").name = "person")); // hidden; the agent's rename over it is carded
  await w.tick(100);
  const put = w.engine.putMeta.bind(w.engine);
  let failed = false;
  w.engine.putMeta = async (key, value) => {
    if (!failed && key[0] === "view" && key[1] === view.name) {
      failed = true; // the save is committed and recorded, its view's state not stored: it is retried
      throw new Error("view metadata unavailable");
    }
    return put(key, value);
  };
  await agent.editUntilDone(view.path, (its) => {
    find(its, "a").name = "agent";
    find(its, "b").opacity = 0.5;
  });
  await w.mz.idle();
  assert.equal(failed, true);
  assert.equal(find(shown(w), "a").name, "agent", "shown as applied");
  const save = (await w.carton.pendingChanges()).changes.find((c) => c.author.id === agent.actor.id)!;
  const server = await serverOf(t, w);
  await server.commit(HUMAN, (its) => void (find(its, "a").name = "person"), (person as { id: string }).id);
  await server.commit(agent.actor, (its) => void (find(its, "b").opacity = 0.5), save.id); // with the edits it was committed with
  await server.deliver();
  assert.deepEqual((await w.carton.pendingChanges()).changes, []);
  w.mz.onFsEvent(view.path); // the retry, answered from its stored result
  await w.mz.idle();
  assert.deepEqual([find(shown(w), "a").name, find(shown(w), "b").opacity], ["agent", 0.5], "still as applied");
});

test("save speed review 5 #3: in a freeze, a host write still landing when the file is found unchanged gets it checked once it has [real engine]", async (t) => {
  const codec = { ...jsonTimelineCodec };
  const w = await openWorld(t, { items: [clip("a", 0, 5, { annotations: ["old"] })], codec, materializer: { writeProject: false } });
  await w.agent("director/c1/t1", { hooked: true, actor: { turn: "t1", group: "local:me@m1" } }).read();
  const pj = w.abs(PROJECT_FILE);
  const write = (env: Record<string, unknown>) => {
    fs.writeFileSync(`${pj}.tmp`, JSON.stringify(env));
    fs.renameSync(`${pj}.tmp`, pj);
  };
  let first!: (x: HostWrite) => void;
  w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (first = r)) });
  await w.mz.printShared(); // while the first write lands
  const env = JSON.parse(fs.readFileSync(pj, "utf8")) as { project: Record<string, unknown> & { timelineItems: Item[] } };
  env.project.lastOpenedAt = "later"; // nothing the print shows
  write(env);
  first({ project: { envelope: env, stamp: (await statStamp(pj))! } });
  const print = codec.print.bind(codec);
  let second!: (x: HostWrite) => void;
  codec.print = (async (...args: Parameters<typeof print>) => {
    const text = await print(...args);
    codec.print = print;
    w.mz.onHeadChange("gui", { after: new Promise<HostWrite>((r) => (second = r)) }); // starts while the check prints
    return text;
  }) as typeof codec.print;
  await w.tick(100); // the first write's check: the same bytes, the second write still landing
  assert.equal(codec.print, print, "checked");
  const newer = structuredClone(env);
  find(newer.project.timelineItems, "a").annotations = ["new"];
  write(newer);
  second({ project: { envelope: newer, stamp: (await statStamp(pj))! } });
  await w.tick(100);
  assert.deepEqual(find(shown(w), "a").annotations, ["new"]);
});
