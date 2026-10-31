// Stage F review round 2 (GPT 6.1 Sol): each finding's reproduction, asserting the fixed behaviour. The reviewer's
// versions (asserting the faulty outcome at 11a841c) are in /home/ubuntu/gfv-scratch/carton/foundation-core-review/round2.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type ConfirmedChange, type ConflictCard } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { ReplicaQueue } from "../../core/src/sync/queue.ts";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, schema, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice = { kind: "human" as const, id: "alice" };

test("SF2-1: a restored change keeps one version per rebase: its cards are reported once each, in order", () => {
  const q = new ReplicaQueue(schema),
    remote = new ReplicaQueue(schema);
  q.addBranch({ id: "cut", name: "cut", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0());
  remote.addBranch({ id: "cut", name: "cut", kind: "main", sequencer: { kind: "local" } }, doc0());
  q.restoreAll("cut", [{ id: "alice.1", author: alice, at: 0, k: 0, ops: [set("a", "name", "mine a"), set("b", "name", "mine b"), set("f", "name", "mine f")], supersedes: [], cards: [], sentBases: [] }]);
  for (const id of ["a", "b"]) {
    remote.commit("cut", { id: `bob.${id}`, author: { kind: "human", id: "bob" }, at: 0, ops: [set(id, "name", `remote ${id}`)] });
    q.integrate("cut", [remote.rows("cut").at(-1) as ConfirmedChange]);
  }
  let cards: ConflictCard[] = [];
  q.on((e) => void (e.type === "confirmed" && (cards = e.lateCards)));
  const latest = q.pending("cut")[0]!.versions.at(-1)!;
  assert.equal(q.pending("cut")[0]!.versions.length, 3);
  assert.equal(q.versions.get("alice.1")!.length, 3, "the version map has its own array");
  q.integrate("cut", [{ ...(remote.rows("cut")[0] as ConfirmedChange), id: "alice.1", seq: 3, rebase: latest.k, base: latest.base, ops: latest.ops, hash: latest.hash, intent: latest.intent }]);
  assert.deepEqual(cards.map((c) => c.path), ["items/a/name", "items/b/name"]);
});

/** Alice's trim, stored on the state of a keyframe catch-up whose skipped rows weren't fetched (the gap), then closed. */
async function gapFixture() {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  let block = false;
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
  const trim = await a.commit({ ops: [set("a", "endTime", 4), set("a", "trimEnd", 4)] });
  const id = trim.status === "pending" ? trim.id : assert.fail(trim.status);
  await b.commit({ ops: [set("a", "startTime", 100), set("a", "endTime", 105)], wait: 5000 });
  for (let i = 0; i < 5; i++) await b.commit({ ops: [set("b", "name", `remote${i}`)], wait: 5000 });
  await until(() => w.host.sequencer.tables.latestKeyframe(a.cut, 6)?.seq === 6, 5000, "the server's keyframe");
  block = true;
  await a.sync!.connect({ nonce: "a2" });
  const later = await a.commit({ ops: [set("f", "name", "earlier pending")] });
  const laterId = later.status === "pending" ? later.id : assert.fail(later.status);
  await until(async () => {
    const p = await sa.get<{ head?: number; ops: { path: string[]; value: unknown }[] }>("pending", [a.cut, id]);
    return p?.head === 6 && p.ops.some((o) => o.path[2] === "endTime" && o.value === 104);
  }, 5000, "the rebased trim stored on the keyframe's state");
  const cut = a.cut;
  await a.close();
  return { w, sa, b, id, laterId, cut };
}

test("SF2-2: a stored edit rebases across what was confirmed after its head (bob moved the clip again)", async () => {
  const { w, sa, b, id } = await gapFixture();
  await b.commit({ ops: [set("a", "startTime", 200), set("a", "endTime", 205)], wait: 5000 });
  await b.commit({ ops: [set("b", "name", "last")], wait: 5000 });
  const again = await Carton.open({ adapter, store: sa, sync: w.sync("alice") });
  assert.equal((await again.sync!.waitFor(id, 5000)).status, "confirmed");
  const a = item((await again.head()).doc, "a")!;
  assert.deepEqual([a.startTime, a.endTime], [200, 204], "the trim kept, on bob's latest move");
  for (const c of [again, b]) await c.close();
  w.host.close();
});

test("SF2-2: another process's pending row, kept for the next holder, is rebased over the holder's newer change", async () => {
  const w = world();
  const store = createMemoryStore();
  const h = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice", false) });
  await h.share();
  await h.sync!.connect({ nonce: "h" });
  await until(async () => (await h.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const n = await Carton.open({ adapter, store, sync: w.sync("alice", false) });
  const r = await n.commit({ ops: [set("a", "name", "foreign pending")] });
  const id = r.status === "pending" ? r.id : assert.fail(r.status);
  assert.equal((await h.commit({ ops: [set("a", "name", "holder newer")], wait: 5000 })).status, "confirmed");
  await n.close();
  await h.close();
  const next = await Carton.open({ adapter, store, sync: w.sync("alice") });
  const o = await next.sync!.waitFor(id, 5000);
  assert.equal(o.status, "conflicts", "a clash with what was confirmed meanwhile, not a silent overwrite");
  assert.equal(item((await next.head()).doc, "a")!.name, "holder newer");
  await next.close();
  w.host.close();
});

test("SF2-3: after a restart offline, an edit stored during a catch-up shows and counts at once, and stays before newer ones", async () => {
  const { w, sa, b, laterId } = await gapFixture();
  const again = await Carton.open({ adapter, store: sa, sync: w.sync("alice", false) });
  const before = (await again.head()).doc;
  assert.equal(item(before, "f")!.name, "earlier pending", "the earlier edit is in the offline view");
  assert.equal(item(before, "a")!.endTime, 104, "and the trim, on bob's move");
  assert.equal(again.sync!.state().pending, 2, "both count as waiting");
  const newer = await again.commit({ ops: [set("f", "name", "newer offline edit")] });
  const newerId = newer.status === "pending" ? newer.id : assert.fail(newer.status);
  await again.sync!.connect({ nonce: "restarted" });
  assert.equal((await again.sync!.waitFor(laterId, 5000)).status, "confirmed");
  assert.equal((await again.sync!.waitFor(newerId, 5000)).status, "confirmed");
  assert.equal(item((await again.head()).doc, "f")!.name, "newer offline edit", "the newer edit wins");
  for (const c of [again, b]) await c.close();
  w.host.close();
});

test("SF2-3: stored edits another copy already confirmed leave the store once this one catches up", async () => {
  const { w, sa, b, id, laterId, cut } = await gapFixture();
  const sender = await Carton.open({ adapter, store: await copyStore(sa), sync: w.sync("alice") });
  assert.equal((await sender.sync!.waitFor(id, 5000)).status, "confirmed");
  assert.equal((await sender.sync!.waitFor(laterId, 5000)).status, "confirmed");
  await sender.close();
  const again = await Carton.open({ adapter, store: sa, sync: w.sync("alice") });
  assert.equal((await again.sync!.waitFor(id, 5000)).status, "confirmed");
  await until(async () => (await sa.range("pending")).length === 0, 5000, "every stored pending row gone");
  await until(async () => (await sa.get("meta", ["queue-head", cut])) === undefined, 5000, "and the stored queue state, once the backfill caught up");
  for (const c of [again, b]) await c.close();
  w.host.close();
});

test("SF2-4: importHistory keeps the fork state a fork stored (all that is left of a compacted version)", async () => {
  let now = 1;
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, clock: () => now, keyframeEvery: 2 });
  for (let i = 1; i <= 4; i++) await a.commit({ ops: [set("a", "name", String(i))] });
  now = 100 * 864e5;
  for (let i = 0; i < 2; i++) await a.commit({ ops: [set("f", "name", String(i))] });
  const stale = await Carton.open({ adapter, store: sa, keyframeEvery: 2 });
  await a.compact();
  const f = await stale.fork("kept", { from: `${a.cut}@1` });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { import: await a.exportShallow() } });
  await b.importHistory(sa);
  assert.equal(item((await b.head(f.id)).doc, "a")!.name, "1");
  for (const c of [a, b, stale]) await c.close();
});

test("SF2-5: a read that fails while settling an outcome keeps it: its author's notice is written by the next settle", async () => {
  const w = world();
  const mem = createMemoryStore();
  let fail = false,
    failed = false;
  const store = Object.assign(Object.create(mem) as typeof mem, {
    range: async (...a: Parameters<typeof mem.range>) => {
      if (fail && a[0] === "pending") {
        fail = false;
        failed = true;
        throw new Error("temporary read error");
      }
      return mem.range(...a);
    },
  });
  const transport: Transport = {
    async connect(url, o) {
      const c = await w.host.transport.connect(url, o);
      return {
        get open() {
          return c.open;
        },
        send: (m) => c.send(m),
        onMessage: (l) => c.onMessage((m) => (m.type === "reject" && (fail = true), l(m))),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: { ...w.sync("alice", false), transport } });
  await a.share();
  await a.sync!.connect({ nonce: "a" });
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const agent = { kind: "agent" as const, id: "agent-X" };
  // inserting a record that exists: the sequencer refuses it for good
  await a.commit({ ops: [{ op: "insert", path: ["items", "a"], value: item(doc0(), "a")! }], author: agent, wait: 5000 });
  assert.ok(failed);
  await a.commit({ ops: [set("b", "name", "next")], wait: 5000 });
  const notices = await a.notices(agent);
  assert.equal(notices.filter((n) => n.kind === "rejected").length, 1, "told once");
  await a.close();
  w.host.close();
});

test("SF2-6: a keyframe write that fails after an outcome's batch was saved never writes its notice again", async () => {
  const w = world();
  const mem = createMemoryStore();
  let allowNotice = false,
    failKeyframe = false,
    failedKeyframe = false;
  const store = Object.assign(Object.create(mem) as typeof mem, {
    write: async (...a: Parameters<typeof mem.write>) => {
      if (!allowNotice && a[0].some((x) => x.table === "notices" && (x.value as { change?: string } | undefined)?.change)) throw new Error("notice write temporarily unavailable");
      if (failKeyframe && a[0].some((x) => x.table === "keyframes")) {
        failKeyframe = false;
        failedKeyframe = true;
        throw new Error("keyframe write temporarily unavailable");
      }
      return mem.write(...a);
    },
  });
  const transport: Transport = {
    async connect(url, o) {
      const c = await w.host.transport.connect(url, o);
      return {
        get open() {
          return c.open;
        },
        send: (m) => c.send(m),
        onMessage: (l) => c.onMessage((m) => (m.type === "changes" && (m as { rows?: unknown[] }).rows?.length && ((allowNotice = true), (failKeyframe = true)), l(m))),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, keyframeEvery: 1, sync: { ...w.sync("alice", false), transport, maxMessageBytes: 2000 } });
  await a.share();
  await a.sync!.connect({ nonce: "a" });
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const agent = { kind: "agent" as const, id: "agent-X" };
  assert.equal((await a.commit({ ops: [set("a", "name", "x".repeat(10000))], author: agent, wait: 2000 })).status, "pending");
  await a.commit({ ops: [set("b", "name", "next")], wait: 5000 });
  assert.ok(failedKeyframe);
  await a.commit({ ops: [set("c", "name", "after")], wait: 5000 });
  assert.equal((await a.notices(agent)).length, 1, "the notice once");
  await a.close();
  w.host.close();
});
