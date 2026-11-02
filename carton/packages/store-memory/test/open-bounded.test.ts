// Opening from keyframes (PLAN §5.4; verify-ci F1): open + head() read a local cut's newest keyframe and the rows
// after it, not the whole log; the older rows load in the background right after open. Every call that can reach them
// (log, export, a commit, an older version) waits for them, so none sees part of a history; a failed load is an error
// for the call that waits, and the next call loads again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Store } from "@carton/core";
import type { StoreRange } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice = { kind: "human" as const, id: "alice" },
  bob = { kind: "human" as const, id: "bob" };
const tick = () => new Promise((r) => setTimeout(r, 20));

/** The background read of the older rows: `changes` up to a seq, with no lower bound. */
const olderRows = (table: string, r?: StoreRange) => table === "changes" && !!r?.lte && !r.gt && !r.gte;

/**
 * `store`, with the background read of older rows held until `release()` (or failed by `fail`), and a count of the
 * change rows every other read returned.
 */
function gated(store: Store, fail?: () => Error | null) {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const seen = { rows: 0, older: 0 };
  const s = new Proxy(store, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r)) {
          seen.older++;
          await open;
          const e = fail?.();
          if (e) throw e;
          return (v as Store["range"]).call(t, table as never, r);
        }
        const out = await (v as Store["range"]).call(t, table as never, r);
        if (table === "changes") seen.rows += out.length;
        return out;
      };
    },
  }) as Store;
  return { store: s, release, seen };
}

/** Settled within a few ticks? */
async function settles(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 5; i++) await tick();
  return done;
}

async function project(n: number, from?: { store: Store; done: number }) {
  const store = from?.store ?? createMemoryStore();
  const c = await Carton.open({ adapter, store, ...(from ? {} : { init: { doc: doc0() } }), actor: alice });
  for (let i = (from?.done ?? 0) + 1; i <= n; i++) {
    // record a's name once early on (its credit is in the older rows), then edit b
    const r = await c.commit({ ops: [i === 1 ? set("a", "name", "first a") : set("b", "name", `b ${i}`)], ...(i === 1 ? { author: bob } : {}) });
    assert.equal(r.status, "confirmed");
  }
  await c.close();
  return { store, done: n };
}

test("open at 30,000 and 100,000 changes returns before the older rows load; log() and an export wait for them", { timeout: 600_000 }, async () => {
  let built = await project(30_000);
  for (const n of [30_000, 100_000]) {
    if (n > built.done) built = await project(n, built);
    const g = gated(await copyStore(built.store));
    const c = await Carton.open({ adapter, store: g.store, actor: alice });
    // open and head() are done while the older rows are still held back
    const { ref, doc } = await c.head();
    assert.equal(ref.seq, n);
    assert.equal(item(doc, "b")!.name, `b ${n}`);
    await tick(); // it starts once open has returned
    assert.equal(g.seen.older, 1, "the older rows' read started");
    assert.ok(g.seen.rows <= 66, `open read ${g.seen.rows} change rows, not ${n}`);
    assert.equal((await c.cuts()).length, 1);
    // what needs the older rows waits, and gets all of them
    const log = c.log();
    const sent = c.exportShallow({ to: "carol" });
    const credit = c.credits(["items", "a"]);
    assert.equal(await settles(Promise.race([log, sent, credit])), false, "log, export and credits wait for the load");
    g.release();
    assert.equal((await log).length, n + 1);
    assert.equal(g.seen.older, 2, "a page in the background, then the rest at once for the calls waiting");
    assert.equal((await sent).head, `${c.cut}@${n}`);
    assert.equal((await credit)?.id, "bob", "a credit from the older rows");
    await c.close();
  }
});

test("a commit right after open waits for the older rows and lands after them", async () => {
  const built = await project(500);
  const g = gated(await copyStore(built.store));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  const r = c.commit({ ops: [set("c", "name", "after open")] });
  assert.equal(await settles(r), false, "the commit waits for the load");
  g.release();
  const done = await r;
  assert.equal(done.status, "confirmed");
  assert.equal(done.status === "confirmed" && done.seq, 501);
  // undo knows the whole log: the newest change is this one, and undoing it leaves the rest
  assert.equal((await c.undo()).status, "confirmed");
  const d = (await c.head()).doc;
  assert.deepEqual([item(d, "a")!.name, item(d, "b")!.name, item(d, "c")!.name], ["first a", "b 500", "c"]);
  // another handle reads the same history
  const other = await Carton.open({ adapter, store: g.store, actor: bob });
  assert.equal((await other.log()).length, 503);
  for (const x of [c, other]) await x.close();
});

test("rows another process appends while the older rows load are taken in; nothing is lost or doubled", async () => {
  const built = await project(300);
  const raw = await copyStore(built.store);
  const g = gated(raw);
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  // another process on the same store (not held back) appends three changes while this handle's older rows wait
  const other = await Carton.open({ adapter, store: raw, actor: bob });
  for (let i = 0; i < 3; i++) assert.equal((await other.commit({ ops: [set("d", "name", `d ${i}`)] })).status, "confirmed");
  const { ref, doc } = await c.head();
  assert.equal(ref.seq, 303);
  assert.equal(item(doc, "d")!.name, "d 2");
  await tick();
  assert.equal(g.seen.older, 1);
  g.release();
  const log = await c.log();
  assert.equal(log.length, 304);
  assert.equal(new Set(log.map((v) => v.ref.seq)).size, 304);
  assert.equal((await c.commit({ ops: [set("e", "name", "e")] })).status, "confirmed");
  for (const x of [c, other]) await x.close();
});

test("a failed load is an error for the call that waits; the next call loads again", async () => {
  const built = await project(300);
  let fails = 1;
  const g = gated(await copyStore(built.store), () => (fails-- > 0 ? new Error("disk read failed") : null));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  assert.equal((await c.head()).ref.seq, 300, "head() doesn't need the older rows");
  g.release();
  await assert.rejects(c.log(), /disk read failed/);
  assert.equal((await c.log()).length, 301, "loaded on the next call");
  assert.equal((await c.commit({ ops: [set("c", "name", "x")] })).status, "confirmed");
  await c.close();
});

test("own() before the older rows load throws rather than answer from part of the history", async () => {
  const built = await project(200);
  const g = gated(await copyStore(built.store));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  const own = c.own(alice);
  assert.throws(() => own("tracks", "t1"), /still loading/);
  g.release();
  await c.log();
  assert.equal(c.own(alice)("tracks", "t1"), false);
  await c.close();
});

test("a project with too few changes for a keyframe opens whole, as before", async () => {
  const built = await project(20);
  const g = gated(await copyStore(built.store));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  assert.equal(g.seen.older, 0);
  assert.equal(await settles(c.log()), true);
  await c.close();
});

// Stage F review round 5: what the first version of this got wrong

test("open and head() finish before the older rows' read starts, even on a store that reads eagerly", async () => {
  const built = await project(300);
  let older = 0;
  const store = new Proxy(built.store, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return (table: string, r?: StoreRange) => {
        if (olderRows(table, r)) older++;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, actor: alice });
  assert.equal((await c.head()).ref.seq, 300);
  assert.equal(older, 0, "the memory store builds a range's rows when it's called: not before open and head() are done");
  assert.equal((await c.log()).length, 301);
  assert.ok(older >= 1);
  await c.close();
});

test("a load that failed with no call waiting is the next call's error; the call after loads again", async () => {
  const built = await project(300);
  let fails = 1;
  const g = gated(await copyStore(built.store), () => (fails-- > 0 ? new Error("disk read failed") : null));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  g.release();
  for (let i = 0; i < 5; i++) await tick(); // the background load fails before anything waits on it
  await assert.rejects(c.log(), /disk read failed/);
  assert.equal((await c.log()).length, 301);
  await c.close();
});

test("a commit made before a cut switch lands on the cut that was current when it was made", async () => {
  const built = await project(300);
  const pre = await Carton.open({ adapter, store: built.store, actor: alice });
  const main = pre.cut,
    other = (await pre.fork("other")).id;
  await pre.close();
  const g = gated(await copyStore(built.store));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  assert.equal(c.cut, main);
  const r = c.commit({ ops: [set("c", "name", "on main")] });
  await c.switchTo(other);
  g.release();
  const done = await r;
  assert.equal(done.status === "confirmed" && done.ref.branchId, main);
  assert.equal(item((await c.head(main)).doc, "c")!.name, "on main");
  assert.equal(item((await c.head(other)).doc, "c")!.name, "c");
  await c.close();
});

test("a version renamed after it was made keeps its new name when the older rows load", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  assert.equal((await c.commit({ ops: [set("b", "name", "b 1")], name: "old label" })).status, "confirmed");
  await c.name(`${c.cut}@1`, "new label");
  for (let i = 2; i <= 200; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] });
  await c.close();
  const d = await Carton.open({ adapter, store, actor: alice });
  assert.equal((await d.log()).find((v) => v.ref.seq === 1)!.name, "new label");
  await d.close();
});

const T_CHANGES = "changes";
const track = { op: "insert" as const, path: ["tracks", "t3"], value: { id: "t3" }, nb: ["t2", null] as [string, null] };

test("who created an element comes out as a whole load gives it, across cuts", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  assert.equal((await c.commit({ ops: [track] })).status, "confirmed");
  for (let i = 2; i <= 200; i++) await c.commit({ ops: [set("b", "name", `main ${i}`)] });
  const f = await c.fork("fork", { id: "zzzz" }); // loads after main
  await c.commit({ cut: f.id, ops: [{ op: "remove", path: ["tracks", "t3"] }] });
  await c.commit({ cut: f.id, author: bob, ops: [track] });
  for (let i = 3; i <= 200; i++) await c.commit({ cut: f.id, ops: [set("b", "name", `fork ${i}`)] });
  const live = [c.own(bob)("tracks", "t3"), c.own(alice)("tracks", "t3")];
  await c.close();
  const d = await Carton.open({ adapter, store, actor: alice });
  await d.log();
  assert.deepEqual([d.own(bob)("tracks", "t3"), d.own(alice)("tracks", "t3")], live);
  assert.deepEqual(live, [true, false]);
  await d.close();
});

test("an own() taken during the load asks the handle's current history after a rebuild", async () => {
  const built = await project(200);
  const pre = await Carton.open({ adapter, store: built.store, actor: alice });
  await pre.commit({ ops: [track] });
  for (let i = 0; i < 200; i++) await pre.commit({ ops: [set("b", "name", `more ${i}`)] });
  await pre.close();
  const raw = await copyStore(built.store);
  const g = gated(raw);
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  const own = c.own(alice);
  assert.throws(() => own("tracks", "t3"), /still loading/);
  const other = await Carton.open({ adapter, store: raw, actor: bob });
  await other.fork("new cut");
  await c.head(); // a cut another process made: the handle rebuilds, whole
  assert.equal(own("tracks", "t3"), true);
  g.release();
  for (const x of [c, other]) await x.close();
});

test("a hand-off resumed after open uploads from the whole history: connect waits for the older rows", async () => {
  const w = world();
  const built = await project(200);
  const pre = await Carton.open({ adapter, store: built.store, actor: alice });
  const child = await pre.fork("shared child", { id: "zzzz" });
  await pre.close();
  const owner = await Carton.open({ adapter, store: built.store, actor: alice, sync: w.sync("alice", false) });
  await owner.share(child.id); // not connected: the hand-off waits
  await owner.close();
  const g = gated(await copyStore(built.store));
  const thrown: unknown[] = [];
  const transport = {
    async connect(url: string, opts: unknown) {
      const conn = await w.host.transport.connect(url, opts as never);
      return new Proxy(conn, {
        get(t, p) {
          if (p === "onMessage") return (l: (m: unknown) => void) => t.onMessage((m) => { try { l(m); } catch (e) { thrown.push(e); } });
          const v = (t as never)[p] as unknown;
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  };
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: { ...w.sync("alice", false), transport } });
  const ok = c.sync!.connect({ timeoutMs: 5000 });
  assert.equal(await settles(ok), false, "connect waits for the older rows");
  g.release();
  assert.equal(await ok, true);
  assert.deepEqual(thrown, []);
  assert.equal((await c.cuts()).find((x) => x.id === child.id)!.sequencer.kind, "server");
  await c.close();
  w.host.close();
});

test("a local cut another process shares during the load is set up from its whole rows", async () => {
  const w = world();
  const built = await project(200);
  const raw = await copyStore(built.store);
  const g = gated(raw);
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: w.sync("alice", false) });
  const other = await Carton.open({ adapter, store: raw, actor: alice, sync: w.sync("alice", false) });
  await other.share();
  const head = c.head();
  assert.equal(await settles(head), false, "its SharedCut waits for the rows");
  g.release();
  assert.equal((await head).ref.seq, 200);
  assert.equal((await c.log()).length, 201);
  for (const x of [c, other]) await x.close();
  w.host.close();
});

test("a compaction by another process before the older rows load: this handle sees them as squashed, like one opened after it", async () => {
  let now = 1;
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, clock: () => now, keyframeEvery: 2 });
  for (let i = 1; i <= 4; i++) await a.commit({ ops: [set("a", "name", String(i))] });
  now = 100 * 864e5;
  for (let i = 0; i < 2; i++) await a.commit({ ops: [set("f", "name", String(i))] });
  const g = gated(store);
  const late = await Carton.open({ adapter, store: g.store, keyframeEvery: 2 });
  assert.ok((await a.compact()).squashed > 0);
  await tick();
  assert.equal(g.seen.older, 1, "opened from a keyframe");
  g.release();
  await assert.rejects(late.fork("from a squashed version", { from: `${a.cut}@1` }), /state not held|state unknown/i);
  const fresh = await Carton.open({ adapter, store });
  assert.deepEqual((await late.log()).map((v) => v.ref.seq), (await fresh.log()).map((v) => v.ref.seq));
  assert.deepEqual((await late.head()).doc, (await fresh.head()).doc);
  for (const x of [a, late, fresh]) await x.close();
});

// Stage F round 5's re-check

test("a compaction between two pages of the older rows: the handle reads its history again, whole", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut;
  assert.equal((await c.commit({ ops: [set("a", "name", "only in the oldest page")] })).status, "confirmed");
  for (let i = 2; i <= 4300; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] }); // older rows: two pages
  await c.close();
  let pages = 0,
    release!: () => void,
    started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const held = new Proxy(store, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r) && ++pages === 2) (started(), await hold);
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const d = await Carton.open({ adapter, store: held, actor: alice });
  await began; // the background load: the newer page is in, the older one waits (a call waiting would read the rest at once)
  const other = await Carton.open({ adapter, store, actor: alice });
  assert.ok((await other.compact({ olderThanDays: 0 })).squashed > 0);
  const kept = (await other.log()).find((v) => v.ref.seq > 4000 && v.ref.seq < 4288)!;
  const want = await other.checkout(`${main}@${kept.ref.seq}`);
  assert.equal(item(want, "a")!.name, "only in the oldest page");
  release();
  assert.deepEqual(await d.checkout(`${main}@${kept.ref.seq}`), want);
  assert.deepEqual((await d.log()).map((v) => v.ref.seq), (await other.log()).map((v) => v.ref.seq));
  assert.equal((await d.restore(`${main}@${kept.ref.seq}`)).status, "confirmed");
  assert.equal(item((await d.head()).doc, "a")!.name, "only in the oldest page");
  for (const x of [d, other]) await x.close();
});

test("publish() made before a cut switch publishes the cut that was current when it was made", async () => {
  const built = await project(300);
  const pre = await Carton.open({ adapter, store: built.store, actor: alice });
  const main = pre.cut,
    other = (await pre.fork("other", { id: "zzzz" })).id;
  await pre.commit({ cut: other, ops: [set("c", "name", "only on the variant")] });
  await pre.close();
  const g = gated(await copyStore(built.store));
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  const p = c.publish({ id: "publication" });
  await c.switchTo(other);
  g.release();
  const rec = await p;
  assert.equal(rec.source, main);
  assert.equal(rec.forkOf, `${main}@300`);
  assert.equal(item((await c.head(rec.id)).doc, "c")!.name, "c");
  await c.close();
});

/** A project whose cut "zzzz" (a fork of main, 200 changes in) is handing off: shared while not connected. */
async function handingOff(w: ReturnType<typeof world>) {
  const built = await project(200);
  const pre = await Carton.open({ adapter, store: built.store, actor: alice });
  await pre.fork("shared child", { id: "zzzz" });
  await pre.close();
  const owner = await Carton.open({ adapter, store: built.store, actor: alice, sync: w.sync("alice", false) });
  await owner.share("zzzz");
  await owner.close();
  return built.store;
}

test("close() during a hand-off's connect, which waits for the older rows: no connection is left open", async () => {
  const w = world();
  const g = gated(await copyStore(await handingOff(w)));
  const sync = w.sync("alice", false);
  const conns: { open: boolean; close(): void }[] = [];
  const transport = {
    async connect(url: string, opts: unknown) {
      const conn = await sync.transport.connect(url, opts as never);
      conns.push(conn as never);
      return conn;
    },
  };
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: { ...sync, transport } });
  const connecting = c.sync!.connect();
  for (let i = 0; i < 3; i++) await tick();
  const closing = c.close();
  await tick();
  g.release();
  await closing;
  assert.equal(await connecting, false);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(conns.filter((x) => x.open), []);
  w.host.close();
});

test("open with sync returns before the older rows' read starts, auto-connecting a hand-off or not", async () => {
  const w = world();
  const store = await handingOff(w);
  for (const autoConnect of [false, true]) {
    let opened = false,
      early = false;
    const watched = new Proxy(store, {
      get(t, p, rcv) {
        const v = Reflect.get(t, p, rcv);
        if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
        return async (table: string, r?: StoreRange) => {
          if (table === "pending") await tick(); // a store whose reads take a turn of the event loop
          if (olderRows(table, r) && !opened) early = true;
          return (v as Store["range"]).call(t, table as never, r);
        };
      },
    }) as Store;
    const c = await Carton.open({ adapter, store: watched, actor: alice, sync: w.sync("alice", autoConnect) });
    opened = true;
    assert.equal(early, false, `autoConnect ${autoConnect}`);
    if (autoConnect) await until(async () => (await c.cuts()).find((x) => x.id === "zzzz")!.sequencer.kind === "server", 5000, "the hand-off went up");
    await c.close();
  }
  w.host.close();
});

test("creators: a change confirmed live during the load wins, as on a replica that had the whole history", async () => {
  const w = world();
  const raw = createMemoryStore();
  const pre = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = pre.cut;
  await pre.commit({ ops: [track] });
  const f = await pre.fork("local fork", { id: "zzzz" }); // loads after main
  await pre.commit({ cut: f.id, author: bob, ops: [{ op: "remove", path: ["tracks", "t3"] }] });
  await pre.commit({ cut: f.id, author: bob, ops: [track] });
  for (let i = 0; i < 130; i++) await pre.commit({ cut: f.id, ops: [set("b", "name", `fork ${i}`)] });
  await pre.share(main);
  await until(async () => (await pre.cuts()).find((x) => x.id === main)!.sequencer.kind === "server");
  const remote = await Carton.open({ adapter, store: await copyStore(raw), actor: alice, sync: w.sync("alice") });
  await remote.log();
  await remote.sync!.connect();
  await pre.close();
  const g = gated(raw);
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: w.sync("alice") });
  await c.sync!.connect();
  await remote.commit({ cut: main, ops: [{ op: "remove", path: ["tracks", "t3"] }], wait: 5000 });
  await remote.commit({ cut: main, ops: [track], wait: 5000 });
  await until(async () => (await c.head(main)).ref.seq === 3);
  g.release();
  await c.log();
  const whole = [remote.own(alice)("tracks", "t3"), remote.own(bob)("tracks", "t3")];
  assert.deepEqual(whole, [true, false]);
  assert.deepEqual([c.own(alice)("tracks", "t3"), c.own(bob)("tracks", "t3")], whole);
  for (const x of [c, remote]) await x.close();
  w.host.close();
});

// Stage F round 5's second re-check

/** n changes on main: a's temporary name first, then b's. */
async function temporary(n: number) {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  await c.commit({ ops: [set("a", "name", "temporary")] });
  for (let i = 2; i <= n; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] });
  await c.close();
  return store;
}
/** `store` with one range call held: the `nth` read of the older rows, or the first read of `table` once `armed()`. */
function holdOne(store: Store, pick: { nth?: number; table?: string }) {
  let release!: () => void, started!: () => void, n = 0, armed = false;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const s = new Proxy(store, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if ((pick.nth && olderRows(table, r) && ++n === pick.nth) || (armed && table === pick.table)) (armed = false), started(), await hold;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  return { store: s, release, began, arm: () => (armed = true) };
}

test("a compaction into rows appended after open: the handle reads its history again, not the squash on top of what it holds", async () => {
  const raw = await temporary(130);
  const g = holdOne(raw, { nth: 1 });
  const c = await Carton.open({ adapter, store: g.store, actor: alice });
  const reading = c.log();
  await g.began;
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  await other.commit({ ops: [set("a", "name", "a")] }); // the temporary name reverted, inside the run compaction squashes
  for (let i = 132; i <= 300; i++) await other.commit({ ops: [set("b", "name", `b ${i}`)] });
  assert.ok((await other.compact({ olderThanDays: 0 })).squashed > 0);
  g.release();
  await reading;
  assert.deepEqual((await c.head()).doc, (await other.head()).doc);
  assert.equal(item((await c.head()).doc, "a")!.name, "a");
  for (const x of [c, other]) await x.close();
});

test("a handle that holds rows another process then squashes into newer ones reads its history again (no keyframe open needed)", async () => {
  const raw = await temporary(30); // too few for a keyframe: opened whole
  const c = await Carton.open({ adapter, store: raw, actor: alice });
  assert.equal((await c.head()).ref.seq, 30);
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  await other.commit({ ops: [set("a", "name", "a")] });
  for (let i = 32; i <= 300; i++) await other.commit({ ops: [set("b", "name", `b ${i}`)] });
  assert.ok((await other.compact({ olderThanDays: 0 })).squashed > 0);
  assert.deepEqual((await c.head()).doc, (await other.head()).doc);
  assert.equal(item((await c.head()).doc, "a")!.name, "a");
  for (const x of [c, other]) await x.close();
});

test("a rebuild asked for while another runs starts after it: a cut switch and a commit made after it stay", async () => {
  const raw = await temporary(4300);
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  let pages = 0,
    armed = false;
  const latch = () => {
    let release!: () => void;
    return { p: new Promise<void>((r) => (release = r)), release: () => release() };
  };
  const page = latch(),
    pageBegan = latch(),
    rebuild = latch(),
    rebuildBegan = latch();
  const held = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r) && ++pages === 2) (pageBegan.release(), await page.p, (armed = true));
        const out = await (v as Store["range"]).call(t, table as never, r);
        // the rebuild that follows (the compaction between pages) waits after its last read of rows
        if (armed && table === "meta" && r?.prefix?.[0] === "join") (armed = false), rebuildBegan.release(), await rebuild.p;
        return out;
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store: held, actor: alice });
  await pageBegan.p;
  assert.ok((await other.compact({ olderThanDays: 0 })).squashed > 0);
  page.release();
  await rebuildBegan.p; // it has read the store (main is current), not yet replaced the History
  const variant = (await other.fork("variant", { id: "zzzz" })).id;
  const switching = c.switchTo(variant); // a cut this handle doesn't know: a rebuild of its own, after the held one
  assert.equal(await settles(switching), false, "it waits for the rebuild running");
  rebuild.release();
  await switching;
  assert.equal(c.cut, variant);
  const r = await c.commit({ ops: [track] });
  assert.equal(r.status === "confirmed" && r.ref.branchId, variant);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(c.cut, variant);
  assert.equal(c.own(alice)("tracks", "t3"), true);
  const next = await c.commit({ ops: [set("c", "name", "on the variant")] });
  assert.equal(next.status === "confirmed" && next.ref.branchId, variant);
  for (const x of [c, other]) await x.close();
});

test("close() while a cut shared by another process is being set up: no connection starts after it", async () => {
  const w = world();
  const raw = await temporary(130);
  const g = holdOne(raw, { table: "pending" });
  const sync = w.sync("alice", false);
  const conns: { open: boolean }[] = [];
  const transport = {
    async connect(url: string, opts: unknown) {
      const conn = await sync.transport.connect(url, opts as never);
      conns.push(conn as never);
      return conn;
    },
  };
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: { ...sync, transport } });
  await c.log();
  assert.equal(await c.sync!.connect(), true);
  const other = await Carton.open({ adapter, store: raw, actor: alice, sync: w.sync("alice", false) });
  await other.share(c.cut);
  g.arm();
  const reading = c.head().then(() => null, (e: unknown) => e);
  await g.began;
  await c.close();
  g.release();
  await reading;
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(conns.filter((x) => x.open), []);
  await other.close();
  w.host.close();
});

test("close() right after a hand-off's connect starts: no older-row read after close returns", async () => {
  const w = world();
  const raw = await handingOff(w);
  let closed = false,
    late = false;
  const watched = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r) && closed) late = true;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store: watched, actor: alice, sync: w.sync("alice", false) });
  const connecting = c.sync!.connect();
  await c.close();
  closed = true;
  assert.equal(await connecting, false);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(late, false);
  w.host.close();
});

test("creators confirmed live during the load keep their precedence when a compaction makes the handle read again", async () => {
  const w = world();
  const raw = createMemoryStore();
  const pre = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = pre.cut;
  await pre.commit({ ops: [track] });
  const f = await pre.fork("local fork", { id: "zzzz" });
  await pre.commit({ cut: f.id, author: bob, ops: [{ op: "remove", path: ["tracks", "t3"] }] });
  await pre.commit({ cut: f.id, author: bob, ops: [track], name: "bob's" });
  for (let i = 3; i <= 4300; i++) await pre.commit({ cut: f.id, ops: [set("b", "name", `fork ${i}`)] });
  await pre.share(main);
  await until(async () => (await pre.cuts()).find((x) => x.id === main)!.sequencer.kind === "server");
  const remote = await Carton.open({ adapter, store: await copyStore(raw), actor: alice, sync: w.sync("alice") });
  await remote.log();
  await remote.sync!.connect();
  await pre.close();
  const g = holdOne(raw, { nth: 2 });
  const c = await Carton.open({ adapter, store: g.store, actor: alice, sync: w.sync("alice") });
  await c.sync!.connect();
  await g.began; // the background load's second page waits
  const other = await Carton.open({ adapter, store: raw, actor: alice, sync: w.sync("alice", false) });
  await remote.commit({ cut: main, ops: [{ op: "remove", path: ["tracks", "t3"] }], wait: 5000 });
  await remote.commit({ cut: main, ops: [track], wait: 5000 });
  await until(async () => (await c.head(main)).ref.seq === 3);
  assert.ok((await other.compact({ cut: f.id, olderThanDays: 0 })).squashed > 0);
  g.release();
  await c.log();
  const whole = [remote.own(alice)("tracks", "t3"), remote.own(bob)("tracks", "t3")];
  assert.deepEqual(whole, [true, false]);
  assert.deepEqual([c.own(alice)("tracks", "t3"), c.own(bob)("tracks", "t3")], whole);
  for (const x of [c, remote, other]) await x.close();
  w.host.close();
});

// Stage F round 5's third re-check: one rebuild at a time

test("rebuilds asked for at once run one after the other: an export another process makes meanwhile is kept by compaction", async () => {
  const raw = createMemoryStore();
  const pre = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice });
  for (let i = 1; i <= 6; i++) await pre.commit({ ops: [set("b", "name", `b ${i}`)] });
  const main = pre.cut;
  await pre.close();
  let armed = false;
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        const out = await (v as Store["range"]).call(t, table as never, r);
        if (armed && table === "lineage") (armed = false), started(), await hold;
        return out;
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, actor: alice });
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  await other.fork("trigger", { id: "zzzz", from: `${main}@0` }); // a cut c doesn't know: its next read rebuilds
  armed = true;
  const first = c.cuts();
  await began;
  const second = c.cuts(); // a second rebuild, asked for while the first is held
  assert.equal((await other.exportShallow({ cut: main, to: "recipient" })).head, `${main}@6`);
  release();
  await Promise.all([first, second]);
  for (let i = 7; i <= 100; i++) await c.commit({ cut: main, ops: [set("b", "name", `b ${i}`)] });
  await c.compact({ cut: main, olderThanDays: 0 });
  assert.equal(((await raw.get(T_CHANGES, [main, 6])) as { squashedInto?: number }).squashedInto, undefined, "the exported version stays");
  assert.equal(item(await c.checkout(`${main}@6`), "b")!.name, "b 6");
  for (const x of [c, other]) await x.close();
});

test("a write that fails is dropped from memory even when another rebuild, asked for meanwhile, fails", async () => {
  const raw = createMemoryStore();
  let failWrite = false,
    rollback = false,
    failNext = false;
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p === "write")
        return async (w: { table: string }[], cond?: unknown) => {
          if (failWrite && w.some((x) => x.table === "changes")) {
            failWrite = false;
            rollback = true;
            throw new Error("write failed");
          }
          return (v as Store["write"]).call(t, w as never, cond as never);
        };
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (table === "lineage" && failNext) (failNext = false), (() => { throw new Error("the later rebuild failed"); })();
        if (table === "lineage" && rollback) (rollback = false), started(), await hold;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  failWrite = true;
  const writing = c.commit({ ops: [track] }).then(() => null, (e: unknown) => e);
  await began; // its rollback rebuild is held
  await other.fork("trigger", { id: "zzzz", from: `${c.cut}@0` });
  failNext = true;
  const reading = c.cuts().then(() => null, (e: unknown) => e); // a rebuild after the rollback, which fails
  release();
  assert.match(String(await writing), /write failed/);
  assert.match(String(await reading), /the later rebuild failed/);
  assert.equal(c.own(alice)("tracks", "t3"), false, "the insertion that never reached the store is gone");
  for (const x of [c, other]) await x.close();
});

test("a head() that finds its cut shared after close() returned starts no older-row read", async () => {
  const w = world();
  const raw = createMemoryStore();
  const pre = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice });
  for (let i = 1; i <= 130; i++) await pre.commit({ ops: [set("b", "name", `b ${i}`)] });
  const main = pre.cut;
  await pre.close();
  const other = await Carton.open({ adapter, store: raw, actor: alice, sync: w.sync("alice", false) });
  let armed = false,
    closed = false,
    late = false;
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (armed && table === "cuts") (armed = false), started(), await hold;
        if (closed && olderRows(table, r)) late = true;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, actor: alice, sync: w.sync("alice", false) });
  armed = true;
  const reading = c.head().then(() => null, (e: unknown) => e);
  await began;
  await c.close();
  closed = true;
  await other.share(main);
  release();
  assert.match(String(await reading), /closed/);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(late, false);
  await other.close();
  w.host.close();
});

// Stage F round 5's fourth re-check

test("a rebuild that fails leaves the export index cursor where it was: compaction still keeps a version exported meanwhile", async () => {
  const raw = createMemoryStore();
  let armed = false,
    fail = false;
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (armed && table === "lineage") (armed = false), started(), await hold;
        if (fail && table === "meta" && r?.prefix?.[0] === "join") (fail = false), (() => { throw new Error("rebuild read failed"); })();
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut;
  for (let i = 1; i <= 100; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] });
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  armed = true;
  const compacting = c.compact({ olderThanDays: 0 }).then(() => null, (e: unknown) => e);
  await began; // compaction's rebuild, before it reads the export index
  assert.equal((await other.exportShallow({ cut: main, to: "recipient" })).head, `${main}@100`);
  fail = true;
  release();
  assert.match(String(await compacting), /rebuild read failed/);
  for (let i = 101; i <= 200; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] });
  await c.compact({ olderThanDays: 0 });
  assert.equal(((await raw.get(T_CHANGES, [main, 100])) as { squashedInto?: number }).squashedInto, undefined, "the exported version stays");
  assert.equal(item(await c.checkout(`${main}@100`), "b")!.name, "b 100");
  for (const x of [c, other]) await x.close();
});

test("a switch to a known cut while the compaction fallback rebuilds stays switched", async () => {
  const raw = createMemoryStore();
  const pre = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice });
  const main = pre.cut,
    variant = (await pre.fork("known variant", { id: "zzzz", from: `${main}@0` })).id;
  for (let i = 1; i <= 4300; i++) await pre.commit({ cut: main, ops: [set("b", "name", `b ${i}`)] });
  await pre.close();
  let pages = 0,
    armed = false;
  const latch = () => {
    let release!: () => void;
    return { p: new Promise<void>((r) => (release = r)), release: () => release() };
  };
  const page = latch(),
    pageBegan = latch(),
    build = latch(),
    buildBegan = latch();
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r) && ++pages === 2) (pageBegan.release(), await page.p, (armed = true));
        const out = await (v as Store["range"]).call(t, table as never, r);
        if (armed && table === "meta" && r?.prefix?.[0] === "join") (armed = false), buildBegan.release(), await build.p;
        return out;
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, actor: alice });
  await pageBegan.p;
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  assert.ok((await other.compact({ cut: main, olderThanDays: 0 })).squashed > 0);
  page.release();
  await buildBegan.p; // the fallback has read main as the current cut
  await c.switchTo(variant);
  build.release();
  await c.log({ cut: main });
  assert.equal(c.cut, variant);
  const r = await c.commit({ ops: [set("c", "name", "on the variant")] });
  assert.equal(r.status === "confirmed" && r.ref.branchId, variant);
  for (const x of [c, other]) await x.close();
});

test("no two rebuilds run at once, also when one is asked for the moment the running one ends", async () => {
  const raw = createMemoryStore();
  let armed = false,
    held = false,
    active = 0,
    most = 0,
    builds = 0;
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (armed && table === "lineage") (most = Math.max(most, ++active)), ++builds;
        const out = await (v as Store["range"]).call(t, table as never, r);
        // a rebuild's last read: the first one is held there, a few steps before it ends
        if (armed && table === "meta" && r?.prefix?.[0] === "rid") {
          if (builds === 1 && !held) (held = true), started(), await hold;
          active--;
        }
        return out;
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut;
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  await other.fork("one", { id: "zzzz", from: `${main}@0` });
  armed = true;
  const first = c.cuts();
  await began;
  const second = c.cuts(); // queued behind the first
  await tick();
  await other.fork("two", { id: "zzzzz", from: `${main}@0` });
  release();
  // asked for in the microtasks right after the first ends
  let third!: Promise<unknown>;
  await new Promise<void>((done) => queueMicrotask(() => queueMicrotask(() => ((third = c.cuts()), done()))));
  await Promise.all([first, second, third]);
  armed = false;
  assert.equal(most, 1, "one rebuild at a time");
  assert.deepEqual((await c.cuts()).map((x) => x.id).sort(), [main, "zzzz", "zzzzz"].sort());
  for (const x of [c, other]) await x.close();
});
