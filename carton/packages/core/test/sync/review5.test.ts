// Regression tests for review round 5's findings on the client side: a change refused here stays rejected when only a
// confirmed-id list (behind a keyframe) told of its withdraw, and a confirmed-id list paged inside a base is followed.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { hashDoc, timeAlgebra } from "../../src/engine/index.ts";
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

test("round 5 finding 1: a change refused here, its withdraw known only from a list behind a keyframe, stays rejected after its outcome leaves the cache", async () => {
  const { cut, conns } = await refusedAfterSending();
  conns[1]!.drop(); // the withdraw's answer is lost
  await new Promise((r) => setTimeout(r, 5));
  // the next connection jumps a keyframe at 5 past the withdraw row (seq 1), which the list names
  conns[2]!.feed({ type: "hello", branchId: B, head: 5, rows: [], keyframe: { seq: 5, stateHash: hashDoc(d0, schema), doc: d0 }, confirmed: [{ id: "r.1", seq: 1, withdrawn: true }], maxMessageBytes: 2048 });
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "rejected", id: "r.1", reason: "too large" });
  for (let i = 0; i < 4200; i++) cut.commit({ id: `e.${i}`, author: me, ops: [], at: 0 });
  assert.deepEqual(await cut.waitFor("r.1", 0), { status: "rejected", id: "r.1", reason: "too large" }, "never pending again");
  cut.close();
});

test("round 5 finding 2: a confirmed-id list cut inside a base is asked for again after the seq it was checked through, and acted on only once whole", async () => {
  const { cut, conns } = await rig();
  await join(cut, conns);
  cut.commit({ id: "r.1", author: me, ops: [set("c0", "name", "a")], at: 0 });
  cut.commit({ id: "r.2", author: me, ops: [set("c1", "name", "b")], at: 0 });
  await tick();
  conns[0]!.drop(); // both pushes' answers are lost: both were confirmed (seqs 1, 2)
  await new Promise((r) => setTimeout(r, 5));
  const c = conns[1]!;
  const first = c.of("hello")[0]!;
  assert.deepEqual(first.pending.map((p) => p.id), ["r.1", "r.2"]);
  c.feed({ type: "hello", branchId: B, head: 2, rows: [], confirmed: [{ id: "r.1", seq: 1, rebase: 0 }], uncheckedFrom: 0, checkedThrough: 1 });
  await tick();
  const again = c.of("hello")[1]!;
  assert.equal(again.claimsAfter, 1, "asks for the rest after seq 1");
  assert.equal(cut.queue.pending(B).length, 2, "acted on nothing yet");
  c.feed({ type: "hello", branchId: B, head: 2, rows: [rowOf("r.1", 1, [set("c0", "name", "a")]), rowOf("r.2", 2, [set("c1", "name", "b")])], confirmed: [{ id: "r.2", seq: 2, rebase: 0 }] });
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual([await cut.waitFor("r.1", 0), await cut.waitFor("r.2", 0)], [
    { status: "confirmed", id: "r.1", seq: 1 },
    { status: "confirmed", id: "r.2", seq: 2 },
  ]);
  assert.equal(c.of("push").length, 0, "neither was pushed again");
  cut.close();
});
