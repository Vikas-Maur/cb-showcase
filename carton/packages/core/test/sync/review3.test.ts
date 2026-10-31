// Regression tests for review round 3's findings on the client side: the whole push is within the limit, a change that
// was sent and then grew too large is withdrawn before it is called rejected, and a hand-off knows the limit before it
// uploads.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { hashDoc, timeAlgebra } from "../../src/engine/index.ts";
import { ReplicaQueue, SharedCut, SyncClient, type ClientMessage, type ServerMessage, type SyncEvent } from "../../src/sync/index.ts";
import type { BlobStore, TransportConnection } from "../../src/plugins.ts";
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
const d0: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10)] };
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
const B = "b1";
const me = { kind: "human" as const, id: "me" };
const branch = { id: B, name: "main", kind: "main", sequencer: { kind: "server" as const, since: 0 } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const utf8 = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const unusedBlobs = new Proxy({ kind: "unused" }, { get: (t, k) => (k in t ? t[k as "kind"] : () => Promise.reject(new Error("unused"))) }) as unknown as BlobStore;

class Scripted implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  private onCls: ((why: string) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(structuredClone(m));
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose(l: (why: string) => void) {
    this.onCls.push(l);
  }
  close() {
    this.open = false;
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(structuredClone(m));
  }
  drop() {
    this.open = false;
    for (const l of this.onCls) l("dropped");
  }
  of<T extends ClientMessage["type"]>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ClientMessage, { type: T }>[];
  }
}
const rowOf = (id: string, seq: number, ops: Op[], over: Partial<ConfirmedChange & { withdrawn: boolean }> = {}): ConfirmedChange => ({ id, hash: "h", author: me, branchId: B, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq, ...over });

async function rig() {
  const conns: Scripted[] = [];
  const transport = { connect: async () => { const c = new Scripted(); conns.push(c); return c; } };
  const cut = new SharedCut({ schema, branch, doc0: d0, transport, url: "x", token: "t", schemaVersion: 1, client: { defer: (fn) => queueMicrotask(fn), blobs: unusedBlobs, backoffMs: 1 } });
  return { cut, conns };
}
async function join(cut: SharedCut, conns: Scripted[], welcome: Partial<Extract<ServerMessage, { type: "hello" }>> = {}) {
  const joined = cut.connect({ nonce: "n" });
  await tick();
  conns.at(-1)!.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], ...welcome });
  assert.equal(await joined, true);
}

test("round 3 finding 1: a change that fits alone but not inside its push is never sent; every push sent is within the limit", async () => {
  // measure the push this change makes, then set the limit between the change's size and its push's
  const probe = await rig();
  await join(probe.cut, probe.conns);
  const name = "x".repeat(3500);
  probe.cut.commit({ id: "r1.1", author: me, ops: [set("c0", "name", name)], at: 0 });
  await tick();
  const pushed = probe.conns[0]!.of("push")[0]!;
  const limit = utf8(pushed.changes[0]) + 1;
  assert.ok(utf8(pushed) > limit);
  probe.cut.close();

  const { cut, conns } = await rig();
  await join(cut, conns, { maxMessageBytes: limit });
  cut.commit({ id: "r1.1", author: me, ops: [set("c0", "name", name)], at: 0 });
  cut.commit({ id: "r1.2", author: me, ops: [set("c1", "name", "after")], at: 0 });
  await tick();
  assert.deepEqual(await cut.waitFor("r1.1", 0), { status: "rejected", id: "r1.1", reason: "too large" });
  const pushes = conns[0]!.of("push");
  assert.ok(!pushes.some((p) => p.changes.some((c) => c.id === "r1.1")), "never sent");
  for (const p of pushes) assert.ok(utf8(p) <= limit, "each whole push within the limit");
  assert.deepEqual(pushes.flatMap((p) => p.changes).find((c) => c.id === "r1.2")!.base.pending, []);
  cut.close();
});

for (const answer of ["withdrawn", "an earlier copy confirmed"] as const) {
  test(`round 3 finding 2: a sent change that has grown too large is withdrawn before it is reported (${answer})`, async () => {
    const { cut, conns } = await rig();
    await join(cut, conns);
    cut.commit({ id: "r2.1", author: me, ops: [set("c0", "name", "y".repeat(3000))], at: 0 });
    await tick();
    const first = conns[0]!.of("push")[0]!;
    assert.ok(first.changes.some((c) => c.id === "r2.1"), "sent once");
    // the connection drops before any answer; the next server reads less than this change now takes
    conns[0]!.drop();
    await new Promise((r) => setTimeout(r, 5));
    const c = conns[1]!;
    c.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], maxMessageBytes: 2048 });
    for (let i = 0; i < 3; i++) await tick();
    assert.equal(c.of("push").length, 0, "not sent again");
    const withdraw = c.of("withdraw")[0];
    assert.equal(withdraw?.id, "r2.1", "its id is withdrawn (H1): a copy may still be confirmed");
    assert.deepEqual(await cut.waitFor("r2.1", 0), { status: "pending", id: "r2.1" }, "no outcome until the server answers");
    assert.equal((cut.queue.confirmedState(B, 0).timelineItems as { name?: string }[])[0]!.name, undefined);
    if (answer === "withdrawn") {
      c.feed({ type: "changes", branchId: B, rows: [rowOf("r2.1", 1, [], { withdrawn: true })] });
      c.feed({ type: "ack", branchId: B, id: "r2.1", seq: 1, epoch: withdraw.epoch, withdrawn: true });
      assert.deepEqual(await cut.waitFor("r2.1", 0), { status: "rejected", id: "r2.1", reason: "too large" });
    } else {
      // the first push had been confirmed after all: its row comes back, and the edit stands
      c.feed({ type: "changes", branchId: B, rows: [rowOf("r2.1", 1, first.changes[0]!.ops)] });
      c.feed({ type: "ack", branchId: B, id: "r2.1", seq: 1, epoch: withdraw.epoch, duplicate: true });
      assert.deepEqual(await cut.waitFor("r2.1", 0), { status: "confirmed", id: "r2.1", seq: 1 });
      const c0 = (cut.queue.confirmedState(B, 1).timelineItems as { id: string; name?: string }[]).find((x) => x.id === "c0")!;
      assert.equal(c0.name, "y".repeat(3000));
    }
    cut.close();
  });
}

test("round 3 finding 6: a hand-off takes the limit from the branchStatus answer and never uploads over it", async () => {
  const q = new ReplicaQueue(schema);
  const big: Doc = { ...d0, notes: "z".repeat(10_000) };
  q.addBranch({ ...branch, sequencer: { kind: "handingOff", n: 0, stateHash: hashDoc(big, schema) } }, big);
  const conn = new Scripted();
  const events: SyncEvent[] = [];
  const client = new SyncClient({
    queue: q,
    branchId: B,
    schemaVersion: 1,
    blobs: unusedBlobs,
    connect: async () => conn,
    defer: (fn) => queueMicrotask(fn),
    onEvent: (e) => events.push(e),
    adoptPayload: () => ({ rows: [], rec: { id: B, name: "main", forkOf: null, owner: "me", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: big, closure: [] }),
  }).start();
  await tick();
  assert.equal(conn.sent[0]!.type, "branchStatus");
  conn.feed({ type: "status", branchId: B, adopted: false, adoptKey: null, since: null, head: 0, maxMessageBytes: 4096 });
  await tick();
  assert.equal(conn.of("adopt").length, 0, "the upload, over the server's limit, is never sent");
  assert.ok(events.some((e) => e.type === "error" && /over the server's limit of 4096 bytes/.test(e.error)), "the owner is told why");
  client.stop();
});
