// An undo, redo or revert (a change that `reverts` others) records all it moves by remap, so a merge infers none for it
// (laptop report #2, bug 6; the review of its fix). The undo of a plain drag pulls the clip back over the gap it left,
// which on its own reads as a ripple delete; inferred in a rebase, it pulled a clip placed later on that track left by
// the gap. Through the replica queue: the undo rebased (integrate, restore onto a newer head) and the undo as the
// concurrent row another change is rebased over. A change that reverts nothing infers exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra } from "../../src/engine/index.ts";
import { ReplicaQueue, type RestoreInput } from "../../src/sync/index.ts";
import type { ConfirmedChange, Doc, Op, Rec } from "../../src/types.ts";

const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
const clip = (id: string, s: number, e: number, ts = 0) => ({ id, trackId: "V1", startTime: s, endTime: e, trimStart: ts, trimEnd: ts + e - s });
// a clip split in two at 1.5 s, its right piece dragged 3 s later
const dragged: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("a", 0, 1.5), clip("b", 4.5, 6, 1.5)] };
// the drag's undo: the piece back over the gap it left
const undoOps: Op[] = [
  { op: "set", path: ["timelineItems", "b", "startTime"], value: 1.5 },
  { op: "set", path: ["timelineItems", "b", "endTime"], value: 3 },
];
const UNDO = { kind: "undo" as const, reverts: "alice.2" };
// a clip another replica placed later on that track
const insertY: Op[] = [{ op: "insert", path: ["timelineItems", "y"], value: clip("y", 7, 8) }];
const me = { kind: "human" as const, id: "me" };
const B = "b";
const row = (id: string, seq: number, ops: Op[], extra: Partial<ConfirmedChange> = {}): ConfirmedChange => ({ id, hash: "h", author: { kind: "human", id: "bob" }, branchId: B, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq, ...extra });
function queue() {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, dragged);
  return q;
}
const y = (q: ReplicaQueue) => {
  const r = (q.optimistic(B).doc.timelineItems as Rec[]).find((i) => i.id === "y")!;
  return [r.startTime, r.endTime];
};
const b = (q: ReplicaQueue) => {
  const r = (q.optimistic(B).doc.timelineItems as Rec[]).find((i) => i.id === "b")!;
  return [r.startTime, r.endTime];
};
const stored = (o: Partial<RestoreInput> = {}): RestoreInput => ({ id: "alice.3", author: me, ops: undoOps, at: 0, intent: null, k: 0, supersedes: [], cards: [], sentBases: [], ...o });

test("the undo, pending, is rebased over a clip placed later: that clip stays put (and a plain change still infers)", () => {
  const q = queue();
  // as core queues a planned undo: no remap inferred at commit (#planShared), what it reverts in its history
  q.commit(B, { id: "alice.3", author: me, ops: undoOps, at: 0, inferIntent: false, history: UNDO });
  q.integrate(B, [row("bob.1", 1, insertY)]);
  assert.deepEqual(b(q), [1.5, 3], "the drag undone");
  assert.deepEqual(y(q), [7, 8], "bob's clip where he put it");
  assert.equal(q.pending(B)[0]!.versions.at(-1)!.intent, null, "the rebased undo still records no remap");
  // a change that reverts nothing and records no remap: merge3 infers one in its rebase, as before
  const plain = queue();
  plain.restoreAll(B, [stored()]);
  plain.integrate(B, [row("bob.1", 1, insertY)]);
  assert.deepEqual(y(plain), [4, 5], "inferred as a ripple delete of [1.5, 4.5), as before");
});

test("the undo restored onto a newer head (rebased as it is restored): that clip stays put (and a plain change still infers)", () => {
  for (const [what, history, want] of [["the undo", UNDO, [7, 8]], ["a change that reverts nothing", undefined, [4, 5]]] as const) {
    const q = queue();
    q.integrate(B, [row("bob.1", 1, insertY)]);
    // stored on the head before bob's clip: rebased onto it inside restoreAll
    const r = q.restoreAll(B, [stored({ head: 0, ...(history ? { history } : {}) })]);
    assert.deepEqual(r.restored, ["alice.3"]);
    assert.equal(q.pending(B)[0]!.versions.at(-1)!.k, 1, `${what}: rebased as it was restored`);
    assert.deepEqual(b(q), [1.5, 3], `${what}: the drag undone`);
    assert.deepEqual(y(q), want, what);
  }
});

test("a clip placed later, pending, is rebased over the confirmed undo: it stays put (and over a plain change, still inferred)", () => {
  for (const [what, extra, want] of [["the undo", UNDO, [7, 8]], ["a change that reverts nothing", {}, [4, 5]]] as const) {
    const q = queue();
    q.commit(B, { id: "bob.1", author: me, ops: insertY, at: 0 });
    q.integrate(B, [{ ...row("alice.3", 1, undoOps), ...extra }]);
    assert.deepEqual(b(q), [1.5, 3], `${what}: the drag undone`);
    assert.deepEqual(y(q), want, what);
  }
});
