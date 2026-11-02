// The §6.1 / §6.3 rules on their own, with no storage or network: the overlap test, every reject reason, and the
// holes the system verifier found (H2's server side, H4).
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePush,
  indexChange,
  overlapKind,
  isStructural,
  storedPaths,
  LEAF,
  NONE,
  STRUCTURE,
  type Pushed,
  type RulesConfig,
  type SequencerView,
} from "../../src/sequencer/index.ts";
import { TL, clip, doc, set, change, MemView, type Doc } from "./fixtures.ts";

const cfg: RulesConfig = { timeline: TL };
const d0: Doc = doc([clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15), clip("c3", 15, 20)]);
const kind = (a: Pushed, b: Pushed) =>
  overlapKind(indexChange(a, isStructural(a.ops, a.intent, TL)), {
    paths: storedPaths(b),
    reads: b.reads,
    spans: b.spans,
    structural: isStructural(b.ops, b.intent, TL),
  });
const verdict = (v: SequencerView, ch: Pushed, c: RulesConfig = cfg) => {
  const r = evaluatePush(v, ch, c);
  return r.kind === "reject" ? r.reason : r.kind === "accept" ? (r.lww ? "lww" : "accept") : r.withdrawn ? "withdrawn" : "duplicate";
};

test("overlap: segment-prefix in both directions, identical leaves are LEAF, group paths are structure", () => {
  const opacityA = change(d0, [set("c1", "opacity", 0.5)], { policy: "lww" });
  const opacityB = change(d0, [set("c1", "opacity", 0.7)], { policy: "lww" });
  assert.equal(kind(opacityA, opacityB), LEAF, "two style edits of one field: lww may decide");
  const remove = change(d0, [{ op: "remove", path: ["timelineItems", "c1"] }]);
  assert.equal(kind(opacityA, remove), STRUCTURE, "a remove is above the field");
  assert.equal(kind(remove, opacityA), STRUCTURE, "and the other way round");
  const trimIn = change(d0, [set("c1", "startTime", 5.5), set("c1", "trimStart", 0.5)]);
  const speed = change(d0, [set("c1", "playbackSpeed", 2)]);
  assert.equal(kind(trimIn, speed), STRUCTURE, "a trim-in and a speed change meet through items/c1/#time");
  const name = change(d0, [set("c1", "name", "x")]);
  assert.equal(kind(name, opacityA), NONE, "different fields of one clip: no overlap (reads don't meet field writes)");
});

test("overlap: half-open spans conflict only when one side is structural", () => {
  const trimC0 = change(d0, [set("c0", "endTime", 5.5), set("c0", "trimEnd", 5.5)]);
  const trimC1 = change(d0, [set("c1", "startTime", 4.5), set("c1", "trimStart", 0)]);
  assert.equal(kind(trimC0, trimC1), NONE, "two plain trims of neighbours: accepted without a merge (§6.1)");
  const insert = change(d0, [{ op: "insert", path: ["timelineItems", "n"], value: clip("n", 4, 6) }]);
  assert.equal(kind(trimC1, insert), STRUCTURE, "an insert is structural: intersecting spans conflict");
  const touching = change(d0, [{ op: "insert", path: ["timelineItems", "m"], value: clip("m", 20, 25) }]);
  const moveC3 = change(d0, [set("c3", "startTime", 14), set("c3", "endTime", 19)]);
  assert.equal(kind(moveC3, touching), NONE, "[14, 20) and [20, 25) only touch");
  const ripple = change(d0, [set("c3", "startTime", 13), set("c3", "endTime", 18)], { intent: { maps: { V1: { at: 13 } } } });
  assert.equal(kind(ripple, touching), STRUCTURE, "a remap's [t0, ∞) span meets everything after t0 on its track");
  const otherTrack = change(d0, [{ op: "insert", path: ["timelineItems", "o"], value: clip("o", 0, 100, "T2") }]);
  assert.equal(kind(trimC1, otherTrack), NONE, "different tracks never meet");
});

test("overlap: reads meet writes at or above the read record, and reorders of one track meet", () => {
  const place = change(d0, [{ op: "insert", path: ["timelineItems", "t"], value: clip("t", 30, 33, "T2") }]);
  const dropTrack = change(d0, [{ op: "remove", path: ["tracks", "T2"] }]);
  assert.equal(kind(place, dropTrack), STRUCTURE, "placing on a track meets the track's removal (B5)");
  const renameTrack = change(d0, [{ op: "set", path: ["tracks", "T2", "name"], value: "x" }]);
  assert.equal(kind(place, renameTrack), NONE, "a write below the read record leaves its existence alone");
  const posA = change(d0, [{ op: "set", path: ["tracks", "T2", "#pos"], value: "a" }]);
  const posB = change(d0, [{ op: "set", path: ["tracks", "T2", "#pos"], value: "b" }]);
  assert.equal(kind(posA, posB), STRUCTURE, "two moves of one track");
  const posV1 = change(d0, [{ op: "set", path: ["tracks", "V1", "#pos"], value: "c" }]);
  assert.equal(kind(posA, posV1), NONE, "moves of different tracks");
});

test("evaluatePush: base unknown, the K cap boundary (100 evaluated, 101 rejected without a scan)", () => {
  const v = new MemView(d0);
  assert.equal(verdict(v, change(d0, [set("c0", "name", "x")], { base: { seq: 1, pending: [] } })), "base unknown");
  for (let i = 0; i < 101; i++) v.confirm(change(d0, [set("c2", "name", `n${i}`)]));
  let scanned = 0;
  const counting = { head: () => v.head(), record: v.record.bind(v), *tail(after: number) { for (const r of v.tail(after)) { scanned++; yield r; } } };
  assert.equal(verdict(counting, change(d0, [set("c0", "name", "late")], { base: { seq: 1, pending: [] } })), "accept", "100 behind is evaluated");
  assert.equal(scanned, 100);
  scanned = 0;
  assert.equal(verdict(counting, change(d0, [set("c0", "name", "later")], { base: { seq: 0, pending: [] } })), "behind", "101 behind");
  assert.equal(scanned, 0, "rejected before any scan");
});

test("evaluatePush: dedup in the tail since base, withdrawn ids, and the causal past", () => {
  const v = new MemView(d0);
  const a = change(d0, [set("c0", "name", "a")], { id: "rA.1" });
  v.confirm(a);
  assert.equal(verdict(v, { ...a, ops: [set("c0", "name", "other")] }), "duplicate", "a confirmed id is a duplicate whatever its content");
  v.withdraw("rB.1");
  assert.equal(verdict(v, change(d0, [set("c1", "name", "late")], { id: "rB.1" })), "withdrawn", "a late copy of a withdrawn id (H1)");
  assert.equal(verdict(v, change(d0, [set("c1", "name", "b")], { id: "rA.2", base: { seq: 0, pending: ["rA.1", "rZ.9"] } })), "base unknown");
  assert.equal(verdict(v, change(d0, [set("c0", "name", "b")], { id: "rA.2", base: { seq: 0, pending: ["rA.1"] } })), "accept", "its own earlier change is causal past");
  assert.equal(verdict(v, change(d0, [set("c1", "name", "c")], { id: "rB.2", base: { seq: 0, pending: ["rB.1"] } })), "accept", "a withdrawn id counts as part of the base (it changed nothing)");
});

test("evaluatePush: lww only for leaf edits (R11-01); concurrent style edits are overwritten, not rejected", () => {
  const v = new MemView(d0);
  v.confirm(change(d0, [set("c1", "opacity", 0.9)], { policy: "lww" }));
  const r = evaluatePush(v, change(d0, [set("c1", "opacity", 0.3)], { policy: "lww" }), cfg);
  assert.equal(r.kind, "accept");
  assert.ok(r.kind === "accept" && r.lww && r.overwrote.length === 1, "accepted as lww, the overwritten row reported for its toast");
  assert.equal(verdict(v, change(d0, [set("c1", "opacity", 0.3)])), "overlap", "the same edit as merge is rejected and rebased");
  const trim = change(d0, [set("c1", "endTime", 9), set("c1", "trimEnd", 4)], { policy: "lww" });
  assert.equal(verdict(new MemView(d0), trim), "lww on structure", "a span and a group path are structure, even with no concurrent change");
  const reorder = change(d0, [{ op: "set", path: ["tracks", "T2", "#pos"], value: "a" }], { policy: "lww" });
  assert.equal(verdict(new MemView(d0), reorder), "lww on structure", "a track reorder too");
});

test("evaluatePush: every op must be declared, grouped fields with their group path", () => {
  const v = new MemView(d0);
  const hidden = { ...change(d0, [set("c1", "name", "x")]), ops: [set("c1", "name", "x"), set("c2", "name", "y")] };
  assert.equal(verdict(v, hidden), "undeclared path");
  const noGroup = change(d0, [set("c1", "endTime", 9), set("c1", "trimEnd", 4)]);
  assert.equal(verdict(v, { ...noGroup, paths: noGroup.paths.filter((p) => !p.endsWith("#time")) }), "undeclared path");
  assert.equal(verdict(v, noGroup), "accept");
});

test("evaluatePush: the span check (per track, containing the new edges)", () => {
  const v = new MemView(d0);
  const move = [set("c1", "startTime", 6), set("c1", "endTime", 11)];
  assert.equal(verdict(v, change(d0, move, { spans: [] })), "span missing");
  assert.equal(verdict(v, change(d0, move, { spans: [{ track: "V1", lo: 5, hi: 10 }] })), "span missing", "doesn't reach the new end");
  assert.equal(verdict(v, change(d0, move, { spans: [{ track: "T2", lo: 5, hi: 11 }] })), "span missing", "on the wrong track");
  assert.equal(verdict(v, change(d0, [set("c1", "trackId", "T2")], { spans: [{ track: "V1", lo: 5, hi: 10 }] })), "span missing", "a track change needs both tracks");
  assert.equal(verdict(v, change(d0, [{ op: "remove", path: ["timelineItems", "c2"] }], { spans: [] })), "span missing");
  assert.equal(verdict(v, change(d0, move)), "accept");
  assert.equal(verdict(v, change(d0, [set("c2", "opacity", 0.5)], { spans: [] })), "accept", "a style edit needs no span");
});

test("H4: a concurrent track move or remove makes a span check an overlap (rebased), never 'span missing' (dropped)", () => {
  for (const concurrent of ["move", "remove"] as const) {
    const v = new MemView(d0);
    const alice = concurrent === "move" ? change(d0, [set("c1", "trackId", "T2")]) : change(d0, [{ op: "remove", path: ["timelineItems", "c1"] }]);
    const a = evaluatePush(v, alice, cfg);
    assert.equal(a.kind, "accept");
    v.confirm(alice, a.kind === "accept" ? a.records : []);
    // Bob's trim (or remove) of c1 was declared on V1, where c1 was in his base
    const bobTrim = change(d0, [set("c1", "endTime", 9.5), set("c1", "trimEnd", 4.5)]);
    const bobRemove = change(d0, [{ op: "remove", path: ["timelineItems", "c1"] }]);
    assert.equal(verdict(v, bobTrim), "overlap", `trim after a concurrent ${concurrent}`);
    assert.equal(verdict(v, bobRemove), "overlap", `remove after a concurrent ${concurrent}`);
  }
});

test("evaluatePush: existence (no live duplicate insert, the item's track must exist) and the record writes", () => {
  const v = new MemView(d0);
  assert.equal(verdict(v, change(d0, [{ op: "insert", path: ["timelineItems", "c1"], value: clip("c1", 30, 35) }])), "exists");
  assert.equal(verdict(v, change(d0, [{ op: "insert", path: ["timelineItems", "z"], value: clip("z", 30, 35, "NOPE") }])), "read of a missing record");
  const withTrack = change(d0, [
    { op: "insert", path: ["tracks", "T9"], value: { id: "T9" } },
    { op: "insert", path: ["timelineItems", "z"], value: clip("z", 30, 35, "T9") },
  ]);
  const r = evaluatePush(v, withTrack, cfg);
  assert.equal(r.kind, "accept", "a track inserted by the same change exists");
  assert.deepEqual(r.kind === "accept" && r.records, [
    { coll: "tracks", id: "T9", alive: true },
    { coll: "timelineItems", id: "z", alive: true, lane: "T9" },
  ]);
  const moveRemove = evaluatePush(v, change(d0, [set("c1", "trackId", "T2"), { op: "remove", path: ["timelineItems", "c2"] }]), cfg);
  assert.deepEqual(moveRemove.kind === "accept" && moveRemove.records, [
    { coll: "timelineItems", id: "c2", alive: false },
    { coll: "timelineItems", id: "c1", alive: true, lane: "T2" },
  ]);
  assert.ok(moveRemove.kind === "accept" && moveRemove.structural);
});
