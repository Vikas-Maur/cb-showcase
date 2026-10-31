// Regression tests for review round 4's findings on the client side: a refused withdraw decides nothing, a withdraw's
// base is claimed on reconnect, and a change refused here stays rejected after its outcome leaves the cache.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra } from "../../src/engine/index.ts";
import { SharedCut, type ClientMessage, type ServerMessage } from "../../src/sync/index.ts";
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

/** r.1 sent once on base 0, then (the next server reads less) refused here and withdrawn on connection 2. */
async function refusedAfterSending(welcome: Partial<Extract<ServerMessage, { type: "hello" }>> = {}) {
  const { cut, conns } = await rig();
  await join(cut, conns);
  cut.commit({ id: "r.1", author: me, ops: [set("c0", "name", "y".repeat(3000))], at: 0 });
  await tick();
  const first = conns[0]!.of("push")[0]!;
  conns[0]!.drop();
  await new Promise((r) => setTimeout(r, 5));
  conns[1]!.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], maxMessageBytes: 2048, ...welcome });
  for (let i = 0; i < 3; i++) await tick();
  return { cut, conns, first, withdraw: conns[1]!.of("withdraw")[0]! };
}

test("round 4 finding 1: a withdraw refused for its connection (forbidden) decides nothing; a connection that may withdraw does, and an earlier copy's confirmation wins", async () => {
  const { cut, conns, first, withdraw } = await refusedAfterSending();
  assert.equal(withdraw.id, "r.1");
  conns[1]!.feed({ type: "reject", branchId: B, id: "r.1", reason: "forbidden", head: 0, concurrent: [], epoch: withdraw.epoch });
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "pending", id: "r.1" }, "not rejected: a copy may still be confirmed");
  assert.equal(conns[1]!.of("withdraw").length, 1, "not withdrawn again on the connection that may not");
  assert.equal(cut.queue.pending(B).length, 1);
  conns[1]!.drop();
  await new Promise((r) => setTimeout(r, 5));
  const c = conns[2]!;
  c.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], maxMessageBytes: 2048 });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(c.of("withdraw")[0]?.id, "r.1", "withdrawn on the next connection");
  c.feed({ type: "changes", branchId: B, rows: [rowOf("r.1", 1, first.changes[0]!.ops)] });
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "confirmed", id: "r.1", seq: 1 });
  cut.close();
});

test("round 4 finding 1: a withdraw answering a push refused for its content is sent again in the new epoch, not dropped", async () => {
  const { cut, conns, withdraw } = await refusedAfterSending();
  conns[1]!.feed({ type: "reject", branchId: B, id: "r.1", reason: "invalid", head: 0, concurrent: [], epoch: withdraw.epoch });
  for (let i = 0; i < 3; i++) await tick();
  const again = conns[1]!.of("withdraw");
  assert.equal(again.length, 2);
  assert.ok(again[1]!.epoch > withdraw.epoch);
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "pending", id: "r.1" });
  cut.close();
});

test("round 4 finding 2: a withdraw's base is claimed on reconnect, so a lost answer is looked for rather than spent twice", async () => {
  // rows 1..3 arrive with the second welcome, so the withdraw goes out on base 3, not the push's base 0
  const rows = [1, 2, 3].map((s) => rowOf(`o.${s}`, s, [set("c1", "name", `o${s}`)]));
  const { cut, conns, withdraw } = await refusedAfterSending({ head: 3, rows });
  assert.equal(withdraw.base, 3);
  conns[1]!.drop(); // its answer is lost
  await new Promise((r) => setTimeout(r, 5));
  const hello = conns[2]!.of("hello")[0]!;
  const claim = hello.pending.find((p) => p.id === "r.1");
  assert.ok(claim?.bases.includes(3), `claims ${JSON.stringify(claim)}`);
  cut.close();
});

test("round 4 finding 4: a change refused here stays rejected after its outcome has left the cache", async () => {
  const { cut, conns, withdraw } = await refusedAfterSending();
  conns[1]!.feed({ type: "changes", branchId: B, rows: [rowOf("r.1", 1, [], { withdrawn: true })] });
  conns[1]!.feed({ type: "ack", branchId: B, id: "r.1", seq: 1, epoch: withdraw.epoch, withdrawn: true });
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "rejected", id: "r.1", reason: "too large" });
  for (let i = 0; i < 4200; i++) cut.commit({ id: `e.${i}`, author: me, ops: [], at: 0 }); // fills the outcome cache
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "rejected", id: "r.1", reason: "too large" }, "never \"absorbed\"");
  cut.close();
});
