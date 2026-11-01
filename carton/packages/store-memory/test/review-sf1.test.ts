// Stage F review round 1 (GPT 6.1 Sol): each core finding's reproduction, asserting the fixed behaviour. The reviewer's
// versions (asserting the faulty outcome at f0fd418) are in /home/ubuntu/gfv-scratch/carton/foundation-core-review/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";
import type { Transport } from "@carton/core/plugins";

test("SF1-2: a running holder's settle keeps another process's pending edit for the next holder (F5)", async () => {
  const w = world();
  const store = createMemoryStore();
  const h = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice", false) });
  await h.share();
  await h.sync!.connect({ nonce: "h" });
  await until(async () => (await h.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  // a process without the lease commits to the shared cut: pending, kept in the store
  const n = await Carton.open({ adapter, store, sync: w.sync("alice", false) });
  const r = await n.commit({ ops: [set("a", "name", "foreign pending")] });
  assert.equal(r.status, "pending");
  const id = r.status === "pending" ? r.id : "";
  assert.ok(await store.get("pending", [h.cut, id]));
  // the holder settles its own edit: the other process's row stays
  assert.equal((await h.commit({ ops: [set("b", "name", "holder")], wait: 5000 })).status, "confirmed");
  assert.ok(await store.get("pending", [h.cut, id]), "the other process's pending row is still there");
  assert.deepEqual(await store.get("pending", [h.cut, (await h.log({ limit: 1 }))[0]!.change!]), undefined, "the holder's own settled row is gone");
  await n.close();
  await h.close();
  // the next holder to start pushes it, and it is confirmed
  const next = await Carton.open({ adapter, store, sync: w.sync("alice", false) });
  await next.sync!.connect({ nonce: "next" });
  assert.equal((await next.sync!.waitFor(id, 5000)).status, "confirmed");
  assert.equal(item((await next.head()).doc, "a")!.name, "foreign pending");
  assert.deepEqual(await store.range("pending"), [], "settled, its row gone");
  await next.close();
  w.host.close();
});

/** A store whose settling batches carrying an author's notice throw (a transient IO failure): `times` times, or until `heal()`. */
function failingNotices(times = Infinity) {
  const mem = createMemoryStore();
  let left = times,
    failed = 0;
  const store = Object.assign(Object.create(mem) as typeof mem, {
    write: async (...a: Parameters<typeof mem.write>) => {
      if (left > 0 && a[0].some((w) => w.table === "notices" && String((w.value as { text?: string } | undefined)?.text).startsWith("Your change"))) {
        left--;
        failed++;
        throw new Error("temporary store failure");
      }
      return mem.write(...a);
    },
  });
  return { mem, store, failed: () => failed, heal: () => void (left = 0) };
}

test("SF1-6: a settle whose batch threw keeps its outcome: the author's notice is written by the next settle", async () => {
  const w = world();
  const { mem, store, failed } = failingNotices(1);
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: { ...w.sync("alice", false), maxMessageBytes: 2000 } });
  await a.share();
  await a.sync!.connect({ nonce: "a" });
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const agent = { kind: "agent" as const, id: "agent-X" };
  // too large for the client's limit: rejected; the batch with its notice throws once, and is retried
  const r = await a.commit({ ops: [set("a", "name", "x".repeat(10000))], author: agent, wait: 5000 });
  assert.equal(r.status, "rejected");
  assert.equal(failed(), 1);
  const notices = await a.notices(agent);
  assert.equal(notices.length, 1, "the agent is told once");
  assert.equal(notices[0]!.kind, "rejected");
  assert.deepEqual(await mem.range("pending"), []);
  await a.close();
  w.host.close();
});

test("SF1-6: while its outcome can't be stored, a wait answers pending; a later settle stores it", async () => {
  const w = world();
  const { mem, store, failed, heal } = failingNotices();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: { ...w.sync("alice", false), maxMessageBytes: 2000 } });
  await a.share();
  await a.sync!.connect({ nonce: "a" });
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const agent = { kind: "agent" as const, id: "agent-X" };
  const r = await a.commit({ ops: [set("a", "name", "x".repeat(10000))], author: agent, wait: 5000 });
  assert.equal(r.status, "pending", "its notice isn't stored yet: not a settled answer");
  assert.ok(failed() >= 2, "the event's settle and the wait's both failed");
  assert.deepEqual(await a.notices(agent), []);
  assert.equal((await a.sync!.waitFor(r.status === "pending" ? r.id : "", 100)).status, "pending", "a later wait too");
  heal();
  // the next edit's settle carries the kept outcome
  assert.equal((await a.commit({ ops: [set("b", "name", "next")], wait: 5000 })).status, "confirmed");
  const notices = await a.notices(agent);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.kind, "rejected");
  assert.deepEqual(await mem.range("pending"), []);
  await a.close();
  w.host.close();
});

const DAY = 864e5;
/** main with 4 old renames of a and 2 recent edits: compaction squashes main@1..3 into main@4. */
async function oldAndNew(store: ReturnType<typeof createMemoryStore>, clock: () => number, step: (t: number) => void) {
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, clock, keyframeEvery: 2 });
  for (let i = 1; i <= 4; i++) await c.commit({ ops: [set("a", "name", String(i))] });
  step(100 * DAY);
  for (let i = 1; i <= 2; i++) await c.commit({ ops: [set("f", "name", String(i))] });
  return c;
}

test("SF1-1: a fork made while another process compacts its fork version keeps its state; the project reopens", async () => {
  let now = 1;
  const mem = createMemoryStore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  let armed = false;
  // the compacting process pauses right before its squash is written
  const paused = Object.assign(Object.create(mem) as typeof mem, {
    write: async (...a: Parameters<typeof mem.write>) => {
      if (armed && a[0].some((w) => w.table === "changes" && (w.value as { squashedInto?: number } | undefined)?.squashedInto)) {
        armed = false;
        entered();
        await gate;
      }
      return mem.write(...a);
    },
  });
  const c = await oldAndNew(paused, () => now, (t) => (now += t));
  const other = await Carton.open({ adapter, store: mem, clock: () => now, keyframeEvery: 2 });
  armed = true;
  const compact = c.compact();
  await ready;
  const fork = await other.fork("kept", { from: `${c.cut}@1` });
  release();
  await compact;
  const reopened = await Carton.open({ adapter, store: mem });
  assert.equal(item((await reopened.head(fork.id)).doc, "a")!.name, "1", "the fork's state is the version it was made from");
  for (const x of [c, other, reopened]) await x.close();
});

test("SF1-1: a handle opened before a compaction can still fork a version it squashed; the fork reopens", async () => {
  let now = 1;
  const store = createMemoryStore();
  const a = await oldAndNew(store, () => now, (t) => (now += t));
  const stale = await Carton.open({ adapter, store, keyframeEvery: 2 });
  await stale.log(); // it holds the older versions (opened from a keyframe, it reads them after open)
  assert.deepEqual(await a.compact(), { squashed: 3 });
  await assert.rejects(a.checkout(`${a.cut}@1`), /state not held|state unknown/i);
  const f = await stale.fork("from a squashed version", { from: `${a.cut}@1` });
  const reopened = await Carton.open({ adapter, store });
  assert.equal(item((await reopened.head(f.id)).doc, "a")!.name, "1");
  for (const x of [a, stale, reopened]) await x.close();
});

test("SF1-5: compaction never moves a record's credit to another actor of the same group and turn", async () => {
  let now = 1;
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, clock: () => now, keyframeEvery: 2 });
  await c.commit({ ops: [set("a", "name", "A")], author: { kind: "agent", id: "agent-A", group: "team", turn: "turn" } });
  await c.commit({ ops: [set("b", "name", "B")], author: { kind: "agent", id: "agent-B", group: "team", turn: "turn" } });
  await c.commit({ ops: [set("b", "name", "B2")], author: { kind: "agent", id: "agent-B", group: "team", turn: "turn" } });
  now = 100 * DAY;
  for (let i = 0; i < 2; i++) await c.commit({ ops: [set("f", "name", String(i))] });
  assert.deepEqual(await c.compact(), { squashed: 1 }, "agent-B's two changes are one run; agent-A's stays its own");
  assert.equal((await c.credits(["items", "a"]))?.id, "agent-A");
  assert.equal((await c.credits(["items", "b"]))?.id, "agent-B");
  await c.close();
});

test("SF1-7: a handle already open sees a shallow cut that importHistory filled in, with every version", async () => {
  const sa = createMemoryStore(),
    sb = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() } });
  for (let i = 0; i < 3; i++) await a.commit({ ops: [set("a", "name", `from sender ${i}`)] });
  const b = await Carton.open({ adapter, store: sb, init: { import: await a.exportShallow() } });
  const other = await Carton.open({ adapter, store: sb });
  assert.equal((await other.cuts()).find((c) => c.id === a.cut)?.shallow, true);
  await b.importHistory(sa);
  assert.equal((await other.cuts()).find((c) => c.id === a.cut)?.shallow, undefined, "the other handle sees the full cut");
  assert.equal(item(await other.checkout(`${a.cut}@2`), "a")!.name, "from sender 1");
  assert.deepEqual((await other.log({ cut: a.cut })).map((v) => v.ref.seq), [3, 2, 1, 0]);
  for (const c of [a, b, other]) await c.close();
});

test("SF1-4: a restart while a keyframe catch-up's skipped rows aren't saved yet keeps every pending edit as it was", async () => {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  let block = false;
  // alice's history requests (the backfill) and pushes go nowhere while blocked: the gap stays open
  const transport: Transport = {
    async connect(url, o) {
      const c = await w.host.transport.connect(url, o);
      return {
        get open() {
          return c.open;
        },
        send: (m) => (block && (m.type === "history" || m.type === "push") ? undefined : c.send(m)),
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: { ...w.sync("alice", false), transport } });
  await a.share();
  await a.sync!.connect({ nonce: "a" });
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await a.sync!.disconnect();
  const b = await Carton.open({ adapter, store: await copyStore(sa), sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  // alice trims a offline; bob moves a, then makes 5 more edits: alice will catch up through a keyframe
  const trim = await a.commit({ ops: [set("a", "endTime", 4), set("a", "trimEnd", 4)] });
  const id = trim.status === "pending" ? trim.id : assert.fail(trim.status);
  await b.commit({ ops: [set("a", "startTime", 100), set("a", "endTime", 105)], wait: 5000 });
  for (let i = 0; i < 5; i++) await b.commit({ ops: [set("b", "name", `remote${i}`)], wait: 5000 });
  await until(() => w.host.sequencer.tables.latestKeyframe(a.cut, 6)?.seq === 6, 5000, "the server's keyframe");
  block = true;
  await a.sync!.connect({ nonce: "a2" });
  const later = await a.commit({ ops: [set("f", "name", "made while the backfill waits")] });
  const laterId = later.status === "pending" ? later.id : assert.fail(later.status);
  // the trim, rebased onto bob's move, is stored relative to the keyframe's state, which the store doesn't hold
  await until(async () => ((await sa.get<{ ops: { path: string[]; value: unknown }[] }>("pending", [a.cut, id]))?.ops ?? []).some((o) => o.path[2] === "endTime" && o.value === 104), 5000, "the rebased trim stored");
  assert.equal(item((await a.head()).doc, "a")!.endTime, 104);
  await a.close();
  // restarted with a working connection: both edits are confirmed as they were, the trim on bob's move
  const again = await Carton.open({ adapter, store: sa, sync: w.sync("alice") });
  assert.equal((await again.sync!.waitFor(id, 5000)).status, "confirmed");
  assert.equal((await again.sync!.waitFor(laterId, 5000)).status, "confirmed");
  const d = (await again.head()).doc;
  assert.deepEqual([item(d, "a")!.startTime, item(d, "a")!.endTime], [100, 104], "the trim kept, on bob's move");
  assert.equal(item(d, "f")!.name, "made while the backfill waits");
  assert.deepEqual(await again.notices(), [], "no conflict");
  for (const c of [again, b]) await c.close();
  w.host.close();
});
