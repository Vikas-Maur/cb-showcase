// The save-speed stage (windows-sync's helper-perf R2 and their H8 review round 2), on the real engine, history and
// materializer: the shared file's superseded prints are released past `keepPrints` (R7-01's bound); a rewrite reads
// timeline.tsx once, stores the print's pin record with the path's token (or its state), and takes project.json's
// envelope from the host that just wrote it; a host write told with its head change is waited for; on a shared cut a
// windowless local agent's change and this replica's pending agent changes show in the frozen file; a save's cards
// carry their cut.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Actor } from "@carton/core";
import { findRev, fromHost, toHost } from "@carton/cardboard";
import { TIMELINE_FILE, PROJECT_FILE, statStamp, type MetaRow } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, render, HUMAN, type Item, type World } from "./world.ts";

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
