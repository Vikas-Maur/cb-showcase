// Shared cuts end to end, in real time: two replicas, each holding the cut as a SharedCut (what Carton holds per
// shared cut: the ReplicaQueue and its SyncClient), through the in-process host and its Transport, on the real
// sequencer and the pinned Cardboard schema. A commit goes pending then confirmed; concurrent edits rebase; a clash
// becomes a card on the side that pushed second; an offline queue drains on reconnect; presence arrives with its cut.
import test from "node:test";
import assert from "node:assert/strict";
import { sync, type Doc, type Op } from "@carton/core";
import type { AuthContext, AuthProvider, Transport } from "@carton/core/plugins";
import { createInProcessHost, type InProcessHost } from "@carton/server";
import { cardboard, withKeys } from "../../engine/fixtures/cardboard-schema.ts";
import { sqliteStorage } from "../sqlite.ts";

const clip = (id: string, s: number, e: number) => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
const item = (d: Doc, id: string) => (d.timelineItems as Record<string, unknown>[]).find((i) => i.id === id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The host's Transport with `ms` of latency on what the server sends (in order), as a real network has. */
function withLatency(t: Transport, ms: number): Transport {
  return {
    async connect(url, opts) {
      const c = await t.connect(url, opts);
      return {
        get open() { return c.open; },
        send: (m) => c.send(m),
        onMessage: (l) => c.onMessage((m) => void setTimeout(() => l(m), ms)),
        onClose: (l) => c.onClose((why) => void setTimeout(() => l(why), ms)),
        close: () => c.close(),
      };
    },
  };
}

async function setup({ latencyMs = 0 } = {}) {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host: InProcessHost = createInProcessHost({ storage: sqliteStorage(), auth });
  const d0 = withKeys({ name: "e2e", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15)] });
  const branch = { id: "cut-main", name: "Main cut", kind: "main", sequencer: { kind: "server" as const, since: 0 } };
  await host.sequencer.createBranch({ id: branch.id, name: branch.name, forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 0 } }, { doc0: d0 });
  const replica = (name: string) => {
    const token = `tok-${name}`;
    tokens.set(token, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    const cut = new sync.SharedCut({ schema: cardboard, branch, doc0: d0, transport: latencyMs ? withLatency(host.transport, latencyMs) : host.transport, url: host.url, token, schemaVersion: 1 });
    const events: sync.SharedCutEvent[] = [];
    cut.on((e) => events.push(e));
    let n = 0;
    const rid = `${name}${Date.now().toString(16)}`;
    const commit = (ops: Op[], policy: "merge" | "lww" = "merge") => {
      const id = `${rid}.${++n}`;
      cut.commit({ id, author: { kind: "human", id: name }, ops, policy, at: Date.now() });
      return id;
    };
    return { cut, events, commit, head: () => cut.queue.confirmedState(branch.id, cut.queue.headSeq(branch.id)) };
  };
  const a = replica("alice"), b = replica("bob");
  assert.ok(await a.cut.connect({ nonce: "na" }), "alice caught up");
  assert.ok(await b.cut.connect({ nonce: "nb" }), "bob caught up");
  return { host, a, b, d0, branch, close: async () => { a.cut.close(); b.cut.close(); await host.close(); } };
}

export function register(): void {
  test("shared cuts end to end: a commit goes pending, then confirmed; both replicas end on one log", async () => {
    const { a, b, close } = await setup();
    try {
      const id = a.commit([set("c0", "name", "intro")]);
      assert.equal(a.cut.queue.pending("cut-main").length, 1, "pending at once");
      assert.notEqual(a.cut.state().status, "up-to-date", "not up to date with an edit waiting");
      const out = await a.cut.waitFor(id, 5000);
      assert.deepEqual(out, { status: "confirmed", id, seq: 1 });
      await until(() => b.cut.queue.headSeq("cut-main") === 1, 5000, "bob receives the row");
      assert.equal(item(b.head(), "c0").name, "intro");
      await until(() => a.cut.state().status === "up-to-date", 5000, "alice up to date");
      assert.equal(a.cut.state().label, "Up to date");
      assert.ok(a.events.some((e) => e.type === "confirmed" && e.id === id));
    } finally {
      await close();
    }
  });

  test("shared cuts end to end: concurrent edits of one clip rebase and compose (trim-in ∘ trim-out)", async () => {
    const { a, b, close } = await setup();
    try {
      const ia = a.commit([set("c1", "endTime", 9.5), set("c1", "trimEnd", 4.5)]);
      const ib = b.commit([set("c1", "startTime", 5.5), set("c1", "trimStart", 0.5)]);
      const [oa, ob] = await Promise.all([a.cut.waitFor(ia, 5000), b.cut.waitFor(ib, 5000)]);
      assert.deepEqual([oa.status, ob.status].sort(), ["confirmed", "confirmed"]);
      await until(() => a.cut.queue.headSeq("cut-main") === 2 && b.cut.queue.headSeq("cut-main") === 2, 5000, "both rows everywhere");
      for (const r of [a, b]) {
        const c1 = item(r.head(), "c1");
        assert.deepEqual([c1.startTime, c1.endTime, c1.trimStart, c1.trimEnd], [5.5, 9.5, 0.5, 4.5]);
      }
    } finally {
      await close();
    }
  });

  test("shared cuts end to end: a clash becomes a card on the side the sequencer ordered second; the first edit stands", async () => {
    const { a, b, close } = await setup({ latencyMs: 30 });
    try {
      // Both move c2's end, differently, in the same tick; with 30 ms from server to replica, both are pushed on base 0
      // before either sees the other's row. The same time-group fields, so the second push to arrive is rejected
      // (overlap), rebased onto the first in merge3, and can't compose: its replica gets the card.
      const ia = a.commit([set("c2", "endTime", 14), set("c2", "trimEnd", 4)]);
      const ib = b.commit([set("c2", "endTime", 13), set("c2", "trimEnd", 3)]);
      const [oa, ob] = await Promise.all([a.cut.waitFor(ia, 5000), b.cut.waitFor(ib, 5000)]);
      await until(() => a.cut.queue.pending("cut-main").length + b.cut.queue.pending("cut-main").length === 0, 5000, "both queues settle");
      const aFirst = oa.status === "confirmed" && oa.seq === 1;
      const [first, second, oSecond, firstEnd] = aFirst ? [a, b, ob, 14] : [b, a, oa, 13];
      assert.equal((aFirst ? oa : ob).status, "confirmed", "the first edit is confirmed clean");
      assert.equal(oSecond.status, "conflicts", "the second comes back as a card");
      assert.ok(oSecond.status === "conflicts" && oSecond.cards.some((c) => c.path.startsWith("timelineItems/c2")), "on c2");
      assert.ok(second.events.some((e) => e.type === "rejected" || (e.type === "absorbed" && e.cards.length) || (e.type === "confirmed" && e.lateCards.length)), "the card's events reach its side");
      assert.ok(!first.events.some((e) => (e.type === "absorbed" && e.cards.length) || (e.type === "confirmed" && e.lateCards.length)), "no card on the first side");
      assert.equal(first.cut.sync?.stats.rejects ?? 0, 0, "the first side was never rejected");
      assert.ok((second.cut.sync?.stats.rejects ?? 0) >= 1, "the second went through reject → rebase");
      for (const r of [a, b]) assert.equal(item(r.head(), "c2").endTime, firstEnd, "the first value stands everywhere; the other is on the card");
    } finally {
      await close();
    }
  });

  test("shared cuts end to end: an offline queue drains on reconnect", async () => {
    const { a, b, close } = await setup();
    try {
      await b.cut.disconnect({ drain: true });
      const ids = [b.commit([set("c0", "opacity", 0.5)], "lww"), b.commit([set("c1", "name", "b1")]), b.commit([set("c2", "name", "b2")])];
      assert.deepEqual([b.cut.state().status, b.cut.state().pending, b.cut.state().label], ["offline", 3, "Offline: 3 edits waiting"]);
      a.commit([set("c0", "name", "a-while-b-offline")]);
      await until(() => a.cut.queue.pending("cut-main").length === 0, 5000, "alice's edit confirmed");
      assert.ok(await b.cut.connect({ nonce: "nb2" }));
      const outs = await Promise.all(ids.map((id) => b.cut.waitFor(id, 5000)));
      assert.deepEqual(outs.map((o) => o.status), ["confirmed", "confirmed", "confirmed"]);
      await until(() => b.cut.state().status === "up-to-date" && a.cut.queue.headSeq("cut-main") === 4, 5000, "drained everywhere");
      assert.equal(JSON.stringify(a.head()), JSON.stringify(b.head()), "one state");
    } finally {
      await close();
    }
  });

  test("shared cuts end to end: presence reaches the other replica with its cut, and is never stored", async () => {
    const { host, a, b, close } = await setup();
    try {
      a.cut.sendPresence({ kind: "human", id: "alice" }, { at: 3.5, dragging: true });
      await until(() => b.events.some((e) => e.type === "presence"), 2000, "presence at bob");
      const p = b.events.find((e) => e.type === "presence") as Extract<sync.SharedCutEvent, { type: "presence" }>;
      assert.equal(p.branchId, "cut-main");
      assert.deepEqual(p.state, { at: 3.5, dragging: true });
      assert.ok(!a.events.some((e) => e.type === "presence"), "not echoed");
      assert.equal(host.sequencer.tables.head("cut-main"), 0, "nothing written");
    } finally {
      await close();
    }
  });
}
