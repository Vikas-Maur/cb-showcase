// A split in an editor's words (laptop re-check of merge/prod-2, P3 #2): the editor's Split at playhead removes a clip
// and adds two in its place, so History and the Fold dialog read "Added video 'clip.mp4' and video 'clip.mp4', deleted
// video 'clip.mp4'". It reads as a split, with what was done to a part after it in the same version.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import type { Doc, Op, Rec } from "../src/index.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = core.defineSchema({
  collections: {
    tracks: { seq: true, noun: "track", labels: { name: "name" } },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      noun: "clip",
      labels: { trackId: "track", mediaItemId: "media", startTime: "start", endTime: "end", trimStart: "source in", opacity: "opacity" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: core.timeAlgebra(TL) }],
    },
    media: { noun: "media", fields: { data: core.object() } },
  },
  timeline: TL,
  // as Cardboard's: a clip without a name is named after its media's file name
  label: (coll, r, doc) => {
    if (!r) return "?";
    if (coll === "tracks") return String(r.name);
    if (coll === "media") return String((r.data as Rec).fileName);
    const m = doc && (core.getIn(doc, ["media", r.mediaItemId as string], schema) as Rec | undefined);
    return String(r.name ?? (m?.data as Rec | undefined)?.fileName ?? r.id);
  },
});

const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 1, trimEnd: 1 + (e - s), opacity: 1, ...more });
const base = (): Doc => ({
  tracks: [{ id: "t1", name: "V1", [core.POS]: "a" }, { id: "t2", name: "V2", [core.POS]: "b" }],
  items: [clip("c1", 0, 10, { transitionIn: { kind: "fade", duration: 0.5 }, transitionOut: { kind: "fade", duration: 0.5 }, keyframeTracks: [{ property: "opacity", keyframes: [{ t: 0, v: 1 }, { t: 9, v: 0 }] }] }), clip("c2", 10, 14, { mediaItemId: "m2" })],
  media: [{ id: "m1", data: { fileName: "clip.mp4" } }, { id: "m2", data: { fileName: "other.mp4" } }],
});

/** Cardboard 1.4.0's split (`cl` in the renderer): two new clips; the cut's own side loses its transition and fade. */
function split(item: Rec, t: number, ids: [string, string]): [Rec, Rec] {
  const speed = (item.playbackSpeed as number | undefined) ?? 1,
    rev = item.playbackDirection === "reverse";
  const at = rev ? (item.trimEnd as number) - (t - (item.startTime as number)) * speed : (item.trimStart as number) + (t - (item.startTime as number)) * speed;
  const kf = item.keyframeTracks ? [{ property: "opacity", keyframes: [{ t: 0, v: 0.5 }] }] : undefined;
  const a: Rec = { ...item, id: ids[0], endTime: t, trimStart: rev ? at : item.trimStart, trimEnd: rev ? item.trimEnd : at, ...(kf ? { keyframeTracks: kf } : {}) };
  const b: Rec = { ...item, id: ids[1], startTime: t, trimStart: rev ? item.trimStart : at, trimEnd: rev ? at : item.trimEnd, ...(kf ? { keyframeTracks: kf } : {}) };
  delete a.transitionOut, delete b.transitionIn, delete a.audioFadeOut, delete b.audioFadeIn;
  return [a, b];
}
/** The version's ops, as Carton records an editor save: the diff of the timeline before and after. */
const save = (d: Doc, edit: (items: Rec[]) => Rec[]): Op[] => core.diff(d, { ...d, items: edit(d.items as Rec[]) }, schema);
const splitAt = (t: number, more: (parts: [Rec, Rec]) => [Rec, Rec] = (p) => p) => (items: Rec[]) => items.flatMap((it) => (it.id === "c1" ? more(split(it, t, ["p1", "p2"])) : [it]));
const noIds = (lines: readonly string[]) => {
  for (const l of lines) assert.doesNotMatch(l, /\b(?:c1|c2|p1|p2|m1|t1)\b|[0-9a-f]{12,}/i, `no record id: ${l}`);
};

test("a split reads as one: Split 'clip.mp4' at 4.0 s", () => {
  const d = base();
  const ops = save(d, splitAt(4));
  assert.deepEqual(ops.map((op) => op.op).sort(), ["insert", "insert", "remove"], "Carton records a split as one removed clip and two added");
  const v = core.describeVersion(ops, d, schema);
  assert.deepEqual(v.lines, ["Split 'clip.mp4' at 4.0 s"]);
  assert.equal(v.summary, "Split 'clip.mp4' at 4.0 s");
  // the order of the ops doesn't matter, nor does the order the editor lists the parts in
  assert.deepEqual(core.describe([...ops].reverse(), d, schema), ["Split 'clip.mp4' at 4.0 s"]);
});

test("a clip played faster, or backwards, splits the same way", () => {
  const fast = base();
  (fast.items as Rec[])[0] = { ...(fast.items as Rec[])[0]!, playbackSpeed: 2, trimEnd: 21 };
  assert.deepEqual(core.describe(save(fast, splitAt(4)), fast, schema), ["Split 'clip.mp4' at 4.0 s"]);
  const back = base();
  (back.items as Rec[])[0] = { ...(back.items as Rec[])[0]!, playbackDirection: "reverse" };
  assert.deepEqual(core.describe(save(back, splitAt(6.5)), back, schema), ["Split 'clip.mp4' at 6.5 s"]);
});

test("a clip split twice in one version names both points", () => {
  const d = base();
  const ops = save(d, (items) => items.flatMap((it) => {
    if (it.id !== "c1") return [it];
    const [a, rest] = split(it, 3, ["p1", "p2"]);
    return [a, ...split(rest, 7, ["p3", "p4"])];
  }));
  assert.deepEqual(core.describe(ops, d, schema), ["Split 'clip.mp4' at 3.0 s and 7.0 s"]);
});

test("a split followed by edits in the same version: Split 'clip.mp4' at 4.0 s, moved its right part", () => {
  const d = base();
  const moveRight = save(d, splitAt(4, ([a, b]) => [a, { ...b, startTime: 20, endTime: 26 }]));
  const moved = core.describe(moveRight, d, schema);
  assert.deepEqual(moved, ["Split 'clip.mp4' at 4.0 s, moved its right part 4.0 s → 20.0 s"]);
  assert.equal(core.describeVersion(moveRight, d, schema).summary, moved[0]);
  // the left part, to another track
  assert.deepEqual(core.describe(save(d, splitAt(4, ([a, b]) => [{ ...a, trackId: "t2" }, b])), d, schema), ["Split 'clip.mp4' at 4.0 s, moved its left part to track 'V2'"]);
  // the right part trimmed at its end, and the left part made see-through
  assert.deepEqual(core.describe(save(d, splitAt(4, ([a, b]) => [{ ...a, opacity: 0.5 }, { ...b, endTime: 8, trimEnd: 9 }])), d, schema), ["Split 'clip.mp4' at 4.0 s, changed its left part opacity 1 → 0.5, trimmed its right part end 10.0 s → 8.0 s"]);
});

test("with other changes, the split is one change of the version", () => {
  const d = base();
  const ops = [...save(d, splitAt(4)), { op: "set", path: ["items", "c2", "opacity"], value: 0.5 } as Op];
  const v = core.describeVersion(ops, d, schema);
  assert.deepEqual(v.lines, ["Split 'clip.mp4' at 4.0 s", "Changed 'other.mp4' opacity 1 → 0.5"]);
  assert.equal(v.summary, "Split 'clip.mp4', changed 'other.mp4'");
  noIds(v.lines);
});

test("what isn't a split still reads as what it is", () => {
  const d = base();
  // two clips of the same footage in place of one, but not over its range (a gap between them)
  const gap = save(d, (items) => items.flatMap((it) => (it.id === "c1" ? [clip("p1", 0, 3), clip("p2", 5, 10, { trimStart: 6, trimEnd: 11 })] : [it])));
  assert.match(core.describeVersion(gap, d, schema).summary, /^Added .*deleted/);
  // other footage in its place
  const other = save(d, (items) => items.flatMap((it) => (it.id === "c1" ? split(it, 4, ["p1", "p2"]).map((p) => ({ ...p, mediaItemId: "m2" })) : [it])));
  assert.doesNotMatch(core.describe(other, d, schema).join(" | "), /^Split/);
  // one part only: the other was deleted in the same version (reads as what is left: a deleted clip, an added one)
  const one = save(d, (items) => items.flatMap((it) => (it.id === "c1" ? [split(it, 4, ["p1", "p2"])[0]] : [it])));
  assert.doesNotMatch(core.describe(one, d, schema).join(" | "), /^Split/);
});

test("the Fold dialog keeps a split's records together (splits())", () => {
  const d = base();
  const ops = [...save(d, splitAt(4)), { op: "set", path: ["items", "c2", "opacity"], value: 0.5 } as Op];
  assert.deepEqual(core.splits(ops, d, schema), [{ collection: "items", removed: "c1", parts: ["p1", "p2"] }]);
  assert.deepEqual(core.splits([{ op: "set", path: ["items", "c2", "opacity"], value: 0.5 }], d, schema), []);
});

test("review: the same split reads the same whatever order its ops come in (forward before backward)", () => {
  const d = base();
  // right part moved over the left part's old place: a backward reading (split at 6.0 s) fits the same records too
  const ops = save(d, splitAt(4, ([a, b]) => [a, { ...b, startTime: 0, endTime: 6 }]));
  const want = ["Split 'clip.mp4' at 4.0 s, moved its right part 4.0 s → 0.0 s"];
  assert.deepEqual(core.describe(ops, d, schema), want);
  assert.deepEqual(core.describe([...ops].reverse(), d, schema), want);
});

test("review: a value set on a part, or cleared, in the same version is told; what the split drops is not", () => {
  const d = base();
  (d.items as Rec[])[0] = { ...(d.items as Rec[])[0]!, volume: 0.8 };
  const ops = save(d, splitAt(4, ([a, b]) => {
    const { volume: _v, ...right } = b;
    return [{ ...a, blur: 3 }, right];
  }));
  assert.deepEqual(core.describe(ops, d, schema), ["Split 'clip.mp4' at 4.0 s, set its left part blur to 3, cleared volume on its right part"]);
});

test("review: a bulk replacement of many clips of one footage is no split, and costs no pairing", () => {
  const n = 400;
  const items = Array.from({ length: n }, (_, i) => clip(`o${i}`, i * 10, i * 10 + 10));
  const d: Doc = { ...base(), items };
  // fresh clips of the same footage, every one shifted by 3 s: nothing starts or ends where a removed one did
  const after = items.map((it, i) => ({ ...it, id: `n${i}`, startTime: (it.startTime as number) + 3, endTime: (it.endTime as number) + 3 }));
  const ops = core.diff(d, { ...d, items: after }, schema);
  const t0 = performance.now();
  const lines = core.describe(ops, d, schema);
  const ms = performance.now() - t0;
  assert.ok(!lines.some((l) => l.startsWith("Split")), "no split");
  assert.ok(ms < 2000, `bounded work: ${ms.toFixed(0)} ms`);
});

// Laptop re-check P3 (fold counts): Cardboard's editor drops autoReframe from both parts of a split (its save has no
// such field for a new clip), which read "…, cleared auto reframe on its left part, cleared auto reframe on its right
// part". What the host's split leaves off its parts (`splitDrops`) is the split's own, as a transition or a fade is.
const dropping = core.defineSchema({ ...schema, collections: schema.collections, timeline: { ...TL, splitDrops: ["autoReframe"] } } as never);

test("P3: a field the host's split drops from both parts is the split's; a real change to it is still told", () => {
  const d = base();
  (d.items as Rec[])[0] = { ...(d.items as Rec[])[0]!, autoReframe: true };
  const drop = ([a, b]: [Rec, Rec]): [Rec, Rec] => {
    const { autoReframe: _x, ...l } = a, { autoReframe: _y, ...r } = b;
    return [l, r];
  };
  assert.deepEqual(core.describe(save(d, splitAt(4, drop)), d, dropping), ["Split 'clip.mp4' at 4.0 s"]);
  // a schema that doesn't say its split drops it still tells it (nothing else changes for other hosts)
  assert.match(core.describe(save(d, splitAt(4, drop)), d, schema)[0]!, /cleared autoReframe on its left part/);
  // cleared on one part only (the other kept it): told
  assert.deepEqual(core.describe(save(d, splitAt(4, ([a, b]) => [a, drop([a, b])[1]])), d, dropping), ["Split 'clip.mp4' at 4.0 s, cleared autoReframe on its right part"]);
  // turned off on a part (a value, not dropped): told
  assert.deepEqual(core.describe(save(d, splitAt(4, ([a, b]) => [{ ...a, autoReframe: false }, b])), d, dropping), ["Split 'clip.mp4' at 4.0 s, changed its left part autoReframe true → false"]);
  // set on a part where the clip had none: told
  const plain = base();
  assert.deepEqual(core.describe(save(plain, splitAt(4, ([a, b]) => [a, { ...b, autoReframe: true }])), plain, dropping), ["Split 'clip.mp4' at 4.0 s, set its right part autoReframe to true"]);
});

test("P3: countChanges counts a change per record and a split as one, as the Fold dialog lists them", () => {
  const d = base();
  const ops = [...save(d, splitAt(4)), { op: "set", path: ["items", "c2", "opacity"], value: 0.5 } as Op];
  assert.equal(core.countChanges(ops, d, schema), 2, "the split and the opacity");
  assert.equal(core.countChanges(save(d, splitAt(4)), d, schema), 1);
  // among a partial fold's left-out paths: the split's three records are one change; a field path names its record
  assert.equal(core.countChanges(ops, d, schema, ["items/c1", "items/p1", "items/p2"]), 1);
  assert.equal(core.countChanges(ops, d, schema, ["items/c1", "items/p1", "items/p2", "items/c2/opacity"]), 2);
  assert.equal(core.countChanges(ops, d, schema, ["items/p1"]), 1, "a part alone is a record");
  // a root field is one; what isn't a split counts each record
  const gap = save(d, (items) => items.flatMap((it) => (it.id === "c1" ? [clip("p1", 0, 3), clip("p2", 5, 10, { trimStart: 6, trimEnd: 11 })] : [it])));
  assert.equal(core.countChanges(gap, d, schema), 3);
  assert.equal(core.countChanges([{ op: "set", path: ["name"], value: "x" }], d, schema), 1);
});
