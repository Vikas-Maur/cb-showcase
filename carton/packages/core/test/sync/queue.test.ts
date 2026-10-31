// ReplicaQueue on its own: commit, integrate with rebase of the queue, the client's policy rule (H2), empty versions
// left out of later bases, late cards tied to the confirmed version (M3), provisional version ids (L5).
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra, hashDoc } from "../../src/engine/index.ts";
import { ReplicaQueue, policyFor, type QueueEvent } from "../../src/sync/index.ts";
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
const me = { kind: "human" as const, id: "me" };
const B = "b";
const row = (id: string, seq: number, ops: Op[]): ConfirmedChange => ({ id, hash: "h", author: { kind: "human", id: "bob" }, branchId: B, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq });
function queue() {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  return q;
}

test("commit queues on a shared branch and confirms at once on a local one", () => {
  const q = queue();
  assert.equal(q.commit(B, { id: "r.1", author: me, ops: [set("c0", "name", "x")], at: 0 }).status, "pending");
  const local = new ReplicaQueue(schema);
  local.addBranch({ id: "L", name: "main", kind: "main", sequencer: { kind: "local" } }, d0);
  assert.deepEqual(local.commit("L", { id: "r.2", author: me, ops: [set("c0", "name", "x")], at: 0 }), { id: "r.2", status: "confirmed", seq: 1 });
  assert.deepEqual([...q.rids], ["r"]);
});

test("H2's client rule: lww only for leaf edits", () => {
  const leaf = { paths: ["timelineItems/c0/opacity"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] };
  assert.equal(policyFor("lww", leaf), "lww");
  assert.equal(policyFor("lww", { ...leaf, paths: [...leaf.paths, "timelineItems/c0/#time"] }), "merge");
  assert.equal(policyFor("lww", { ...leaf, spans: [{ track: "V1", lo: 0, hi: 5 }] }), "merge");
  assert.equal(policyFor("lww", { ...leaf, trackOrder: ["V1"] }), "merge");
  assert.equal(policyFor("merge", leaf), "merge");
});

test("integrate: our row leaves the queue; someone else's rebases the rest in order; an emptied change drops out of later bases", () => {
  const q = queue();
  q.commit(B, { id: "r.1", author: me, ops: [set("c0", "opacity", 0.5)], policy: "lww", at: 0 });
  q.commit(B, { id: "r.2", author: me, ops: [set("c1", "name", "y")], at: 0 });
  assert.deepEqual(q.pending(B)[1]!.versions[0]!.base, { seq: 0, pending: ["r.1"] });
  // Bob set the same opacity: r.1's rebase leaves nothing to push
  q.integrate(B, [row("bob.1", 1, [set("c0", "opacity", 0.5)])]);
  const [p1, p2] = q.pending(B);
  assert.equal(p1!.versions.at(-1)!.ops.length, 0, "r.1 is empty now");
  assert.deepEqual(p2!.versions.at(-1)!.base, { seq: 1, pending: [] }, "r.2 no longer builds on the empty r.1");
  const confirmed: string[] = [];
  q.on((e: QueueEvent) => e.type === "confirmed" && confirmed.push(e.row.id));
  q.integrate(B, [{ ...row("r.2", 2, p2!.versions.at(-1)!.ops), author: me }]);
  assert.deepEqual(confirmed, ["r.2"]);
  assert.deepEqual(q.pending(B).map((p) => p.id), ["r.1"]);
});

test("M3: late cards come only from the rebases up to the confirmed version", () => {
  const q = queue();
  q.commit(B, { id: "r.1", author: me, ops: [set("c0", "opacity", 0.3)], at: 0 });
  q.integrate(B, [row("bob.1", 1, [set("c0", "opacity", 0.9)])]); // a card (head's value kept): version 1
  const p = q.pending(B)[0]!;
  assert.equal(p.versions[1]!.cards.length, 1);
  const late: number[] = [];
  q.on((e) => e.type === "confirmed" && late.push(e.lateCards.length));
  q.integrate(B, [{ ...row("r.1", 2, [set("c0", "opacity", 0.3)]), author: me, rebase: 0 }]); // version 0 was confirmed
  assert.deepEqual(late, [0], "the card described a merge that didn't happen");
});

test("L5: a pending change's version id is provisional (head + its place in the queue) until its row arrives", () => {
  const q = queue();
  q.commit(B, { id: "r.1", author: me, ops: [set("c0", "name", "x")], at: 0 });
  q.commit(B, { id: "r.2", author: me, ops: [set("c1", "name", "y")], at: 0 });
  assert.deepEqual(q.versionId(B, "r.2"), { id: `${B}@0+2`, provisional: true });
  q.integrate(B, [row("bob.1", 1, [set("c0", "opacity", 0.2)])]);
  assert.deepEqual(q.versionId(B, "r.2"), { id: `${B}@1+2`, provisional: true }, "moves as rows arrive");
  q.integrate(B, [{ ...row("r.1", 2, [set("c0", "name", "x")]), author: me }]);
  assert.deepEqual(q.versionId(B, "r.1"), { id: `${B}@2`, provisional: false });
  assert.deepEqual(q.versionId(B, "r.2"), { id: `${B}@2+1`, provisional: true });
  assert.equal(q.versionId(B, "nope.1"), null);
});

test("a keyframe jump checks the keyframe's hash, makes placeholders; a state inside the jumped stretch is unknown, never guessed", () => {
  const q = queue();
  assert.throws(() => q.jumpTo(B, { seq: 10, stateHash: "not-its-hash", doc: d0 }), /doesn't match its state hash/, "a keyframe must hash to what it claims (review finding 14)");
  assert.equal(q.headSeq(B), 0, "and nothing was installed");
  assert.ok(q.jumpTo(B, { seq: 10, stateHash: hashDoc(d0, schema), doc: d0 }));
  assert.equal(q.headSeq(B), 10);
  assert.ok(q.rows(B)[4]!.placeholder);
  assert.throws(() => q.confirmedState(B, 5), /state unknown/);
  assert.equal(q.confirmedState(B, 10), d0);
});

test("a ripple stored as one remap op stays one op through a rebase, re-expressed in head's coordinates", async () => {
  const { rippleDelete, apply, fork } = await import("../../src/engine/index.ts");
  const q = new ReplicaQueue(schema);
  const d: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15), clip("c3", 15, 20)] };
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d);
  // delete c1 and close its gap: one remap op moves everything from 10 on back by 5
  q.commit(B, { id: "r.1", author: me, ops: [{ op: "remove", path: ["timelineItems", "c1"] }, { op: "remap", path: ["#remap"], maps: { V1: rippleDelete(5, 5) } }], at: 0 });
  // concurrently Bob deleted the first 2 s of c0's slot as a ripple of his own (everything from 2 on moves back by 2)
  const bobOps: Op[] = [{ op: "remap", path: ["#remap"], maps: { V1: rippleDelete(0, 2) } }];
  q.integrate(B, [{ ...row("bob.1", 1, bobOps), intent: null }]);
  const v = q.pending(B)[0]!.versions.at(-1)!;
  assert.equal(v.ops.filter((o) => o.op === "remap").length, 1, "still one remap op");
  assert.ok(v.ops.length <= 3, `not expanded into per-clip sets (${v.ops.length} ops)`);
  const after = apply(fork(q.confirmedState(B, 1), schema), v.ops, schema) as { timelineItems: { id: string; startTime: number; endTime: number }[] };
  const at = (id: string) => after.timelineItems.find((i) => i.id === id);
  assert.equal(at("c1"), undefined);
  assert.deepEqual([at("c2")!.startTime, at("c3")!.startTime], [3, 8], "both ripples applied once each");
});
