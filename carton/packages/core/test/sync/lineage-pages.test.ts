// SF1-8's client half: a history request pages through the whole lineage the server sends in pages (`lineageFrom` /
// `lineageNext`, hosts-plugins' dd8e0ee), rows and lineage independently, and still takes one whole reply from a
// server from before paging. Against a scripted connection.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra } from "../../src/engine/index.ts";
import type { ClosureEntry } from "../../src/sync/messages.ts";
import { SharedCut, type ClientMessage, type ServerMessage } from "../../src/sync/index.ts";
import type { BlobStore, TransportConnection } from "../../src/plugins.ts";
import type { ConfirmedChange, CutRecord, DagNode, Doc, Op } from "../../src/types.ts";

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
const B = "b1";
const me = { kind: "human" as const, id: "me" };
const branch = { id: B, name: "main", kind: "main", sequencer: { kind: "server" as const, since: 0 } };
const tick = () => new Promise((r) => setTimeout(r, 0));
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

const rec = (id: string): CutRecord => ({ id, name: id, forkOf: null, owner: "o", kind: "main", sequencer: { kind: "server", since: 0 } });
const node = (b: string, s: number): DagNode => ({ id: `${b}@${s}`, branchId: b, seq: s, hash: String(s).repeat(64), kinds: ["fork"], parents: [] });
const st = (s: number) => ({ seq: s, hash: String(s).repeat(64), doc: d0 });
const settle = async () => {
  for (let i = 0; i < 3; i++) await tick();
};

test("SF1-8: history pages through the lineage and the rows independently, and joins split entries by branch", async () => {
  const { cut, conns } = await rig();
  await join(cut, conns);
  const c = conns[0]!;
  const got = cut.history(0, 3, { lineage: true });
  await settle();
  const h = () => c.of("history");
  assert.deepEqual([h()[0]!.after, h()[0]!.upTo, h()[0]!.lineage, h()[0]!.lineageFrom], [0, 3, true, { entry: 0, state: 0 }], "the first page asked for");
  const req = h()[0]!.req;
  const A: ClosureEntry = { branchId: "A", rec: rec("A"), nodes: [node("A", 1), node("A", 2)], states: [st(1)], authors: [["A@1", {}]] };
  c.feed({ type: "history", branchId: B, req, rows: [rowOf("x.1", 1, []), rowOf("x.2", 2, [])], more: true, lineage: [A], lineageNext: { entry: 0, state: 1 } });
  await settle();
  assert.deepEqual([h()[1]!.after, h()[1]!.lineage, h()[1]!.lineageFrom], [2, true, { entry: 0, state: 1 }], "rows after the last, lineage at the cursor");
  c.feed({ type: "history", branchId: B, req, rows: [rowOf("x.3", 3, [])], lineage: [{ branchId: "A", rec: rec("A"), nodes: [], states: [st(2)] }, { branchId: "C", rec: rec("C"), nodes: [node("C", 1)], states: [st(3)] }], lineageNext: { entry: 1, state: 1 } });
  await settle();
  assert.deepEqual([h()[2]!.after, h()[2]!.lineage, h()[2]!.lineageFrom], [3, true, { entry: 1, state: 1 }], "the rows are done: a lineage-only page");
  c.feed({ type: "history", branchId: B, req, rows: [], lineage: [{ branchId: "C", rec: rec("C"), nodes: [], states: [st(4)] }] });
  const r = await got;
  assert.deepEqual(r.rows.map((x) => x.seq), [1, 2, 3]);
  assert.deepEqual(r.lineage!.map((e) => [e.branchId, e.nodes.map((n) => n.id), e.states!.map((s) => s.seq), (e.authors ?? []).length]), [
    ["A", ["A@1", "A@2"], [1, 2], 1],
    ["C", ["C@1"], [3, 4], 0],
  ]);
  assert.equal(h().length, 3, "no further request");
  cut.close();
});

test("SF1-8: a server from before paging sends the lineage whole in one reply: one request", async () => {
  const { cut, conns } = await rig();
  await join(cut, conns);
  const c = conns[0]!;
  const got = cut.history(0, 0, { lineage: true });
  await settle();
  const req = c.of("history")[0]!.req;
  c.feed({ type: "history", branchId: B, req, rows: [], lineage: [{ branchId: "A", rec: rec("A"), nodes: [node("A", 1)], states: [st(1), st(2)] }] });
  const r = await got;
  assert.equal(r.lineage!.length, 1);
  assert.equal(r.lineage![0]!.states!.length, 2);
  assert.equal(c.of("history").length, 1);
  cut.close();
});

test("SF1-8: a cursor that doesn't move ends the request with what came, never a loop", async () => {
  const { cut, conns } = await rig();
  await join(cut, conns);
  const c = conns[0]!;
  const got = cut.history(0, 0, { lineage: true });
  await settle();
  const req = c.of("history")[0]!.req;
  c.feed({ type: "history", branchId: B, req, rows: [], lineage: [{ branchId: "A", rec: rec("A"), nodes: [node("A", 1)], states: [st(1)] }], lineageNext: { entry: 0, state: 1 } });
  await settle();
  c.feed({ type: "history", branchId: B, req, rows: [], lineage: [{ branchId: "A", rec: rec("A"), nodes: [], states: [st(2)] }], lineageNext: { entry: 0, state: 1 } });
  const r = await got;
  assert.deepEqual(r.lineage![0]!.states!.map((s) => s.seq), [1, 2]);
  assert.equal(c.of("history").length, 2);
  cut.close();
});
