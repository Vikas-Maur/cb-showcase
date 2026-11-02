// A version in an editor's words (UI audit 2026-11-02): never an id or a hash (P1-2), a field a host words as a
// phrase ("Linked 'clip.mp4' for sharing"), a track made in the same change by its name, and a version of several
// changes summed up in one line with every change listed (P1-5).
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
      labels: { trackId: "track", mediaItemId: "media", startTime: "start", endTime: "end", fontSize: "font size", textContent: "text" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: core.timeAlgebra(TL) }],
    },
    media: {
      noun: "media",
      labels: { contentHash: "content", shared: "shared media", "data.fileName": "file name" },
      phrases: {
        contentHash: { set: "Linked %s for sharing", changed: "Linked %s for sharing", cleared: "Unlinked %s from sharing" },
        shared: { set: "Linked %s for sharing", changed: "Updated %s for sharing", cleared: "Unlinked %s from sharing" },
      },
      fields: { data: core.object(), shared: core.object() },
    },
  },
  timeline: TL,
  label: (coll, r) => {
    if (!r) return "?";
    if (coll === "media") return String((r.data as Rec | undefined)?.fileName ?? "media");
    return String(r.name ?? r.textContent ?? r.id);
  },
});
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...more });
const base = (): Doc => ({
  tracks: [{ id: "t1", name: "Mine", [core.POS]: "a" }],
  items: [clip("c1", 0, 2, { name: "clip.mp4" }), clip("w1", 2, 3, { type: "text", name: "W1", textContent: "W1", fontSize: 100 }), clip("w2", 3, 4, { type: "text", name: "W2", textContent: "W2", fontSize: 100 })],
  media: [{ id: "m1", data: { fileName: "clip.mp4" } }, { id: "m2", data: { fileName: "other.mp4" } }],
});
const HASH = "8291f1d9926b57ac70e5c1f0a3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
const set = (path: string[], value: unknown): Op => ({ op: "set", path, value });
const noIds = (lines: readonly string[]) => {
  for (const l of lines) {
    assert.doesNotMatch(l, /[0-9a-f]{12,}/i, `no hash: ${l}`);
    assert.doesNotMatch(l, /\bm[12]\b|\bt9\b/, `no record id: ${l}`);
  }
};

test("P1-2: sharing footage reads as a phrase, never its content hash", () => {
  const d = base();
  const share = [set(["media", "m1", "contentHash"], HASH), set(["media", "m1", "shared"], { kind: "video", size: 1234, original: "local-only", t1: { poster: { hash: HASH, size: 9 } } })];
  const lines = core.describe(share, d, schema);
  assert.deepEqual(lines, ["Linked 'clip.mp4' for sharing"]);
  const after = core.apply(core.fork(d, schema), share, schema);
  // the other way round (cb compare from after to before), and a later update of the shared facts
  assert.deepEqual(core.describe(core.diff(after, d, schema), after, schema), ["Unlinked 'clip.mp4' from sharing"]);
  assert.deepEqual(core.describe([set(["media", "m1", "shared", "proxy"], { profile: "p", hash: HASH })], after, schema), ["Updated 'clip.mp4' for sharing"]);
});

test("P1-2: an id field or a hash-like value is named, never printed (no phrase for it)", () => {
  const d = base();
  const lines = [
    ...core.describe([set(["items", "c1", "mediaItemId"], "m2")], d, schema),
    ...core.describe([set(["items", "w1", "checksum"], HASH)], d, schema),
    ...core.describe([set(["items", "w1", "style"], { font: "Inter", key: HASH })], d, schema),
    ...core.describe([set(["projectHash"], HASH)], d, schema),
  ];
  noIds(lines);
  assert.equal(lines[0], "Changed 'clip.mp4' media");
});

test("P1-2: a clip moved to a track made in the same change names that track, not its id", () => {
  const d = base();
  const ops: Op[] = [
    { op: "insert", path: ["tracks", "t9"], value: { id: "t9", name: "Text 1", [core.POS]: "b" } },
    set(["items", "w2", "trackId"], "t9"),
    set(["items", "w2", "startTime"], 5),
    set(["items", "w2", "endTime"], 6),
  ];
  const lines = core.describe(ops, d, schema);
  noIds(lines);
  assert.ok(lines.some((l) => l === "Moved 'W2' 3.0 s → 5.0 s, to track 'Text 1'"), lines.join(" | "));
});

test("P1-5: a version of several changes is summed up in one line; every change is still listed", () => {
  const d = base();
  const ops: Op[] = [set(["items", "c1", "startTime"], 2), set(["items", "c1", "endTime"], 4), set(["items", "w1", "textContent"], "Hello"), set(["items", "w2", "textContent"], "Opening")];
  const v = core.describeVersion(ops, d, schema);
  assert.deepEqual(v.lines, core.describe(ops, d, schema));
  assert.equal(v.lines.length, 3);
  assert.equal(v.summary, "Moved 'clip.mp4', changed 'W1' and 'W2'");
  // one change: its own line
  assert.equal(core.describeVersion([set(["items", "w1", "fontSize"], 60)], d, schema).summary, "Changed 'W1' font size 100 → 60");
  // many of a kind are counted by the collection's noun
  const setup: Op[] = [
    { op: "insert", path: ["tracks", "t2"], value: { id: "t2", name: "Agents", [core.POS]: "b" } },
    { op: "insert", path: ["tracks", "t3"], value: { id: "t3", name: "Titles", [core.POS]: "c" } },
    ...["x1", "x2", "x3", "x4"].map((id, i): Op => ({ op: "insert", path: ["items", id], value: clip(id, 10 + i, 11 + i, { type: "text", name: id.toUpperCase() }) })),
    { op: "insert", path: ["media", "m3"], value: { id: "m3", data: { fileName: "intro.mp4" } } },
  ];
  assert.equal(core.describeVersion(setup, d, schema).summary, "Added 2 tracks, 4 clips and media 'intro.mp4'");
  // more than three kinds of change: the first two, then a count
  const mixed: Op[] = [...ops, { op: "remove", path: ["media", "m2"] }, { op: "insert", path: ["tracks", "t2"], value: { id: "t2", name: "Agents", [core.POS]: "b" } }];
  assert.equal(core.describeVersion(mixed, d, schema).summary, "Moved 'clip.mp4', changed 'W1' and 'W2', and 2 more changes");
});

test("P1-2 (review #3): an element of a keyed list is named by its own name or type, never its id", () => {
  const ks = core.defineSchema({
    collections: {
      items: { noun: "clip", labels: { effects: "effect", keyframeTracks: "keyframes" }, fields: { effects: core.keyed("id"), keyframeTracks: core.keyed("property") } },
    },
    label: (_c, r) => String(r?.name ?? "?"),
  });
  const UUID = "7ba56a6c-9992-42a1-88be-b30091622288";
  const d: Doc = { items: [{ id: "c1", name: "clip.mp4", effects: [{ id: "e0", type: "glow" }], keyframeTracks: [] }] };
  const lines = [
    ...core.describe([{ op: "insert", path: ["items", "c1", "effects", UUID], value: { id: UUID, type: "blur" } }], d, ks),
    ...core.describe([{ op: "insert", path: ["items", "c1", "effects", "e9"], value: { id: "e9", amount: 2 } }], d, ks),
    ...core.describe([{ op: "remove", path: ["items", "c1", "effects", "e0"] }], d, ks),
    ...core.describe([{ op: "insert", path: ["items", "c1", "keyframeTracks", "opacity"], value: { property: "opacity", keyframes: [] } }], d, ks),
  ];
  assert.deepEqual(lines, ["Added effect \"blur\" on 'clip.mp4'", "Added effect on 'clip.mp4'", "Removed effect \"glow\" on 'clip.mp4'", "Added keyframes \"opacity\" on 'clip.mp4'"]);
});
