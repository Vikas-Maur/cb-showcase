// The Cardboard schema and host conversion on the real engine (PLAN §4.1–§4.3): the time group and its edit algebra
// (R3-05, R4-06, B13), host <-> engine conversion with LCS keys (B12), the lossy GUI projection (B10), the versioned
// slice and media subset, hard validators, and writing project.json back with every unversioned field kept.
import test from "node:test";
import assert from "node:assert/strict";
import { merge3, diff, hashDoc, declare } from "@carton/core";
import type { Doc, Rec } from "@carton/core";
import { cardboardSchema as S, fromHost, toHost, projectGuiSave, materializeProject, itemOf, hard, standInProjection, createCardboardAdapter } from "../src/index.ts";

const clip = (id: string, s: number, e: number, extra: Rec = {}): Rec => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...extra });
const doc = (items: Rec[], extra: Rec = {}): Doc => fromHost({ name: "P", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }], timelineItems: items, ...extra }, null);
const setItem = (d: Doc, id: string, patch: Rec): Doc => {
  const h = toHost(d);
  return fromHost({ ...h, timelineItems: h.timelineItems!.map((i) => (i.id === id ? { ...i, ...patch } : i)) }, d);
};
const times = (d: Doc, id: string) => {
  const i = itemOf(d, id)!;
  return [i.startTime, i.endTime, i.trimStart, i.trimEnd];
};

test("time group: a move and a trim-out of one clip compose (Finding 6: moved and shortened, no card)", () => {
  const b = doc([clip("c1", 5, 10)]);
  const m = merge3(b, setItem(b, "c1", { startTime: 5.3, endTime: 10.3 }), setItem(b, "c1", { endTime: 9.6, trimEnd: 4.6 }), S);
  assert.equal(m.conflicts.length, 0);
  assert.deepEqual(times(m.doc, "c1"), [5.3, 9.9, 0, 4.6]);
});

test("time group: a trim-in and a speed change on one clip are a card on timelineItems/<id>/#time (§4.1 table)", () => {
  const b = doc([clip("c0", 10, 15, { playbackSpeed: 1 })]);
  const m = merge3(b, setItem(b, "c0", { startTime: 10.5, trimStart: 0.5 }), setItem(b, "c0", { playbackSpeed: 2, endTime: 12.5 }), S);
  assert.deepEqual(m.conflicts.map((c) => c.path), ["timelineItems/c0/#time"]);
  const d1 = declare(S, b, diff(b, setItem(b, "c0", { startTime: 10.5, trimStart: 0.5 }), S));
  assert.ok(d1.paths.includes("timelineItems/c0/#time"), "the group path is declared, so the sequencer sees the overlap");
});

test("B13 crossing trims compose to start 4.5 / end 4, which fails the hard validators: a card, never an invalid clip", () => {
  const b = doc([clip("c0", 3, 5)]);
  const m = merge3(b, setItem(b, "c0", { startTime: 4.5, trimStart: 1.5 }), setItem(b, "c0", { endTime: 4, trimEnd: 1 }), S);
  assert.ok(m.conflicts.some((c) => c.path.startsWith("timelineItems/c0")));
  const c0 = itemOf(m.doc, "c0")!;
  assert.ok((c0.endTime as number) > (c0.startTime as number), "the provisional doc stays valid");
});

test("R4-06: (+1,+1,+1,+1) is move+slip or trim-in+trim-out; unrecorded it is a card against a trim-out, recorded as move+slip it composes", () => {
  const b = doc([clip("c0", 10, 15, { trimStart: 2, trimEnd: 7 })]);
  const ours = setItem(b, "c0", { startTime: 11, endTime: 16, trimStart: 3, trimEnd: 8 });
  const theirs = setItem(b, "c0", { endTime: 14.5, trimEnd: 6.5 });
  assert.equal(merge3(b, ours, theirs, S).conflicts.length, 1, "ambiguous and unrecorded: a card");
  const m = merge3(b, ours, theirs, S, { kinds: { ours: { c0: { move: 1, slip: 1 } }, theirs: {} } });
  assert.equal(m.conflicts.length, 0, "recorded: composes");
  assert.deepEqual(times(m.doc, "c0"), [11, 15.5, 3, 7.5]);
});

test("hard validators: Cardboard's item invariants and a track that must exist", () => {
  const d = doc([clip("ok", 0, 1)]);
  assert.deepEqual(hard("timelineItems", clip("ok", 0, 1), d), []);
  assert.deepEqual(hard("timelineItems", { ...clip("x", 2, 1), trackId: "nope", type: "hologram" }, d), ["endTime must be greater than startTime", "trimEnd must be greater than trimStart", "unknown type hologram", "trackId must exist"]);
  assert.deepEqual(hard("timelineItems", { ...clip("y", -1, 1), trimStart: -0.5 }, d), ["startTime must be >= 0", "trimStart must be >= 0"]);
});

test("B12: track order is a sequence; reordering one track moves one key and order is materialized 0..n-1", () => {
  const tracks = ["A", "B", "C", "D"].map((id, i) => ({ id, name: id, order: i }));
  const b = fromHost({ name: "P", tracks, timelineItems: [] }, null);
  const moved = fromHost({ name: "P", tracks: tracks.map((t) => ({ ...t, order: t.id === "D" ? -1 : t.order })), timelineItems: [] }, b);
  const ops = diff(b, moved, S);
  assert.equal(ops.length, 1, "one track moved, one op");
  assert.deepEqual(toHost(moved).tracks!.map((t) => [t.id, t.order]), [["D", 0], ["A", 1], ["B", 2], ["C", 3]]);
});

test("keyed arrays: an effects reorder on one side and an add on the other both survive", () => {
  const fx = [{ id: "fxA", type: "blur" }, { id: "fxB", type: "glow" }];
  const b = doc([clip("X", 0, 5, { effects: fx })]);
  const reordered = setItem(b, "X", { effects: [fx[1], fx[0]] });
  const added = setItem(b, "X", { effects: [...fx, { id: "fxC", type: "grain" }] });
  const m = merge3(b, reordered, added, S);
  assert.equal(m.conflicts.length, 0);
  // fxC was inserted after fxB (its left neighbour then), so it follows fxB to its new place
  assert.deepEqual((toHost(m.doc).timelineItems![0]!.effects as Rec[]).map((e) => e.id), ["fxB", "fxC", "fxA"]);
});

test("the versioned slice: stateUpdatedAt and the other host fields never become changes", () => {
  const items = [clip("a", 0, 5)];
  const p1 = { id: "p", name: "P", stateUpdatedAt: 1, updatedAt: "x", cast: [], tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: items };
  const p2 = { ...p1, stateUpdatedAt: 2, updatedAt: "y", lastOpenedAt: "z" };
  const a = fromHost(p1, null);
  assert.deepEqual(diff(a, fromHost(p2, a), S), []);
  assert.equal(hashDoc(a, S), hashDoc(fromHost(p2, null), S));
});

test("media: only data.code.source, data.content, data.fileName, data.type and contentHash are versioned; code source merges by line", () => {
  const media = (source: string, thumbs: string[]) => [{ id: "g", createdAt: "t", data: { type: "code", fileName: "Lower third", thumbnailIds: thumbs, code: { source, width: 1920, height: 1080 } } }];
  const b = doc([], { media: media("a\nb\nc\nd", ["t1"]) });
  assert.deepEqual(diff(b, fromHost({ ...toHost(b), media: media("a\nb\nc\nd", ["t1", "t2"]) }, b), S), [], "thumbnails are not versioned");
  const ours = fromHost({ ...toHost(b), media: media("A\nb\nc\nd", ["t1"]) }, b);
  const theirs = fromHost({ ...toHost(b), media: media("a\nb\nc\nD", ["t1"]) }, b);
  const m = merge3(b, ours, theirs, S);
  assert.equal(m.conflicts.length, 0);
  assert.equal(((toHost(m.doc).media![0]!.data as Rec).code as Rec).source, "A\nb\nc\nD");
});

test("B10: a GUI save through the lossy projection touches only the clip the human edited, not 60 frame-accurate agent clips", () => {
  const items = Array.from({ length: 60 }, (_, i) => clip(`a${i}`, i * 1.0333333, i * 1.0333333 + 1.0333333, { opacity: 1, autoReframe: true }));
  const b = doc([...items, clip("h", 70, 75, { opacity: 1 })]);
  const save = { ...toHost(b), timelineItems: toHost(b).timelineItems!.map((i) => standInProjection(i.id === "h" ? { ...i, opacity: 0.5 } : i)) };
  const naive = diff(b, fromHost(save, b), S);
  assert.ok(new Set(naive.map((o) => String(o.path[1]))).size > 1, "control: diffing the GUI's save directly rewrites the agent's clips");
  const ops = diff(b, projectGuiSave(b, save, standInProjection), S);
  assert.deepEqual([...new Set(ops.map((o) => String(o.path[1])))], ["h"]);
  const adapter = createCardboardAdapter({ projection: standInProjection });
  assert.deepEqual(diff(b, adapter.projectGuiSave!(b, save), S), ops);
  const p = adapter.project!(b);
  assert.deepEqual(adapter.project!(p), p, "P is idempotent");
});

test("materializeProject writes the versioned slice back over the file's project and keeps every unversioned field", () => {
  const current = {
    id: "p1",
    name: "Old",
    stateUpdatedAt: 7,
    cast: [{ id: "x" }],
    tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }],
    timelineItems: [{ ...clip("a", 0, 5), annotations: [{ note: "local" }] }],
    media: [{ id: "g", createdAt: "t", data: { type: "code", fileName: "F", thumbnailIds: ["t1"], code: { source: "old", width: 1920, height: 1080 } } }],
  };
  const d = fromHost(current, null);
  assert.equal(itemOf(d, "a")!.annotations, undefined, "local-only fields are not versioned");
  const edited = fromHost({ ...toHost(d), name: "New", media: [{ id: "g", data: { type: "code", fileName: "F", code: { source: "new" } } }] }, d);
  const out = materializeProject(edited, current) as typeof current;
  assert.equal(out.name, "New");
  assert.equal(out.id, "p1");
  assert.equal(out.stateUpdatedAt, 7, "the materializer bumps it, not the conversion");
  assert.deepEqual(out.cast, [{ id: "x" }]);
  assert.deepEqual(out.timelineItems[0]!.annotations, [{ note: "local" }]);
  assert.deepEqual(out.media[0], { id: "g", createdAt: "t", data: { type: "code", fileName: "F", thumbnailIds: ["t1"], code: { source: "new", width: 1920, height: 1080 } } });
  assert.deepEqual(out.tracks, current.tracks);
});
