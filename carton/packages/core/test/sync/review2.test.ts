// Regression tests for review round 2's findings on the client side: SyncClient, ReplicaQueue and SharedCut, against a
// scripted connection (each server message fed by hand).
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra } from "../../src/engine/index.ts";
import { KeyframeMismatch, ReplicaQueue, SharedCut, type ClientMessage, type ServerMessage, type Timers } from "../../src/sync/index.ts";
import type { TransportConnection } from "../../src/plugins.ts";
import type { ConfirmedChange, Doc, Op } from "../../src/types.ts";

const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
const clip = (id: string, s: number, e: number) => ({ id, trackId: "V1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
const d0: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15)] };
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
const B = "b1";
const me = { kind: "human" as const, id: "me" };
const branch = { id: B, name: "main", kind: "main", sequencer: { kind: "server" as const, since: 0 } };
const tick = () => new Promise((r) => setTimeout(r, 0));

class Scripted implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(structuredClone(m));
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose() {}
  close() {
    this.open = false;
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(structuredClone(m));
  }
  pushes() {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "push" }> => m.type === "push");
  }
}
const rowOf = (id: string, seq: number, ops: Op[], over: Partial<ConfirmedChange & { withdrawn: boolean }> = {}): ConfirmedChange => ({ id, hash: "h", author: me, branchId: B, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq, ...over });

/** A SharedCut on a scripted connection, caught up at seq 0; `welcome` adds fields to the server's first answer. */
async function rig(welcome: Partial<Extract<ServerMessage, { type: "hello" }>> = {}, client: Record<string, unknown> = {}) {
  const conns: Scripted[] = [];
  const transport = { connect: async () => { const c = new Scripted(); conns.push(c); return c; } };
  const cut = new SharedCut({ schema, branch, doc0: d0, transport, url: "x", token: "t", schemaVersion: 1, client: { defer: (fn) => queueMicrotask(fn), ...client } });
  const joined = cut.connect({ nonce: "n" });
  await tick();
  conns[0]!.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], ...welcome });
  assert.equal(await joined, true);
  return { cut, c: conns[0]! };
}

test("round 2 finding 2: a change over the server's limit is rejected here as too large, never sent; the edits after it go on without it", async () => {
  const { cut, c } = await rig({ maxMessageBytes: 4096 });
  cut.commit({ id: "r1.1", author: me, ops: [set("c0", "name", "x".repeat(8000))], at: 0 });
  cut.commit({ id: "r1.2", author: me, ops: [set("c1", "name", "small")], at: 0 });
  await tick();
  assert.deepEqual(await cut.waitFor("r1.1", 0), { status: "rejected", id: "r1.1", reason: "too large" });
  const sent = c.pushes().flatMap((p) => p.changes);
  assert.ok(!sent.some((ch) => ch.id === "r1.1"), "the big one never went out");
  const small = sent.find((ch) => ch.id === "r1.2")!;
  assert.deepEqual(small.base.pending, [], "the small one doesn't depend on it");
  cut.close();
});

test("round 2 finding 2: pushes over the limit together go in several messages, in order, in one epoch", async () => {
  const { cut, c } = await rig({ maxMessageBytes: 8192 });
  for (let i = 1; i <= 6; i++) cut.commit({ id: `r1.${i}`, author: me, ops: [set(`c${i % 3}`, "name", `${i}`.padEnd(400, "y"))], at: 0 });
  await tick();
  const pushes = c.pushes();
  assert.ok(pushes.length >= 2, `${pushes.length} messages`);
  assert.deepEqual(pushes.flatMap((p) => p.changes.map((ch) => ch.id)), ["r1.1", "r1.2", "r1.3", "r1.4", "r1.5", "r1.6"]);
  assert.equal(new Set(pushes.map((p) => p.epoch)).size, 1);
  for (const p of pushes) assert.ok(new TextEncoder().encode(JSON.stringify(p)).byteLength <= 8192 + 512, "each within the limit (plus its envelope fields)");
  cut.close();
});

test("round 2 finding 7: a SharedCut made later over the same queue reports an absorbed clash as conflicts, never confirmed", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch(branch, d0);
  const transport = { connect: async (): Promise<TransportConnection> => { throw new Error("offline"); } };
  const options = { queue: q, branch, transport, url: "x", token: "t", schemaVersion: 1 };
  const first = new SharedCut(options);
  first.commit({ id: "r1.1", author: me, ops: [set("c0", "endTime", 4), set("c0", "trimEnd", 4)], at: 0 });
  q.pending(B)[0]!.sentBases.push(0); // as if sent: absorbing it needs a withdraw row
  q.integrate(B, [rowOf("o.1", 1, [set("c0", "endTime", 3), set("c0", "trimEnd", 3)], { paths: ["timelineItems/c0/endTime", "timelineItems/c0/trimEnd", "timelineItems/c0/#time"], reads: ["timelineItems/c0"] })]);
  q.integrate(B, [rowOf("r1.1", 2, [], { withdrawn: true })]);
  const before = await first.waitFor("r1.1", 0);
  assert.equal(before.status, "conflicts");
  first.close();
  const later = new SharedCut(options);
  assert.deepEqual(await later.waitFor("r1.1", 0), before, "the same outcome through another wrapper");
  later.close();
  // an outcome older than any SharedCut on its queue: the withdraw row says it changed nothing of its own
  const q2 = new ReplicaQueue(schema);
  q2.addBranch(branch, d0, [rowOf("o.1", 1, [set("c0", "name", "o")]), rowOf("r2.1", 2, [], { withdrawn: true })]);
  const fresh = new SharedCut({ ...options, queue: q2 });
  assert.deepEqual(await fresh.waitFor("r2.1", 0), { status: "absorbed", id: "r2.1", seq: 2 });
  assert.deepEqual(await fresh.waitFor("o.1", 0), { status: "confirmed", id: "o.1", seq: 1 });
  fresh.close();
});

test("round 2 finding 8: the queue refuses a keyframe with an empty or malformed digest", () => {
  const q = new ReplicaQueue(schema);
  q.addBranch(branch, d0);
  const wrong = { ...d0, name: "another document" };
  for (const stateHash of ["", "h", "A".repeat(64)]) assert.throws(() => q.jumpTo(B, { seq: 1, stateHash, doc: wrong }), KeyframeMismatch, JSON.stringify(stateHash));
});

test("round 2 finding 9: a validation reject that empties the queue turns the status back to up to date", async () => {
  const { cut, c } = await rig();
  cut.commit({ id: "r1.1", author: me, ops: [set("c0", "name", "bad")], at: 0 });
  await tick();
  assert.equal(cut.state().status, "syncing");
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "invalid", head: 0, concurrent: [], epoch: c.pushes()[0]!.epoch });
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(cut.state(), { status: "up-to-date", pending: 0, label: "Up to date" });
  cut.close();
});

test("round 2 finding 10: close() answers every wait (pending) and cancels its timer", async () => {
  const live = new Set<unknown>();
  const timers: Timers = {
    setTimeout(f, ms) {
      const h = setTimeout(() => (live.delete(h), f()), ms);
      if (ms >= 1000) live.add(h);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };
  const transport = { connect: async (): Promise<TransportConnection> => { throw new Error("offline"); } };
  const cut = new SharedCut({ schema, branch, doc0: d0, transport, url: "x", token: "t", schemaVersion: 1, client: { timers } });
  cut.commit({ id: "r1.1", author: me, ops: [set("c0", "name", "x")], at: 0 });
  const waiting = cut.waitFor("r1.1", 60_000);
  cut.close();
  const answer = await Promise.race([waiting, new Promise((r) => setTimeout(() => r("still waiting"), 200))]);
  assert.deepEqual(answer, { status: "pending", id: "r1.1" }, "answered at close, not after its 60 s");
  assert.equal(live.size, 0, "no 60 s timer left");
});

test("round 2 finding 11: an empty commit is confirmed, and its wait says so", async () => {
  const transport = { connect: async (): Promise<TransportConnection> => { throw new Error("offline"); } };
  const cut = new SharedCut({ schema, branch, doc0: d0, transport, url: "x", token: "t", schemaVersion: 1 });
  assert.equal(cut.commit({ id: "r1.1", author: me, ops: [], at: 0 }).status, "confirmed");
  assert.deepEqual(await cut.waitFor("r1.1", 0), { status: "confirmed", id: "r1.1", seq: 0 });
  cut.close();
});
