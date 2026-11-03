// The app's change rows (UX redesign PLAN 0.1, 0.2; docs/carton-ux DESIGN §8 "Change sentences"): one sentence table,
// verb first, the clip by its name in curly quotes, positions as 0:09, never an id or a hash; one row per change as
// countChanges counts them, with where each is in the edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import type { ChangeRow, ConflictCard, Doc, Op, Rec } from "../src/index.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const NOUNS = new Map([["text", "title"], ["caption", "caption"], ["code", "code graphic"]]);
// Cardboard's shape: titles and captions are named by their text, a clip by its media's file name; a title's own media
// entry is part of it
const schema = core.defineSchema({
  labels: { name: "project name", aspectRatio: "aspect ratio", frameRate: "frame rate" },
  collections: {
    tracks: { seq: true, noun: "track", labels: { name: "name" } },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      noun: "clip",
      nounOf: (r) => NOUNS.get(r.type as string),
      labels: { trackId: "track", startTime: "start", endTime: "end", opacity: "opacity", volume: "volume", fontSize: "font size", textContent: "text", captionText: "caption text", mediaItemId: "media", "colorGrading.saturation": "saturation" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: core.timeAlgebra(TL) }],
      fields: { colorGrading: core.object() },
    },
    media: {
      noun: "media",
      nounOf: (r) => ((r.data as Rec | undefined)?.type === "text" ? null : undefined),
      partOf: { collection: "items", field: "mediaItemId" },
      labels: { "data.fileName": "file name" },
      fields: { data: core.object() },
    },
  },
  timeline: TL,
  label: (coll, r, doc) => {
    if (!r) return "?";
    if (coll === "media") return String((r.data as Rec | undefined)?.fileName ?? (r.data as Rec | undefined)?.content ?? "media");
    if (typeof r.name === "string") return r.name;
    if (typeof r.textContent === "string") return r.textContent;
    if (typeof r.captionText === "string") return r.captionText;
    const m = doc && r.mediaItemId ? (core.getIn(doc, ["media", r.mediaItemId as string], schema) as Rec | undefined) : undefined;
    return m ? String((m.data as Rec).fileName) : `clip ${String(r.id).slice(0, 4)}`;
  },
});
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...more });
const base = (): Doc => ({
  name: "Weekend reel",
  aspectRatio: "16:9",
  tracks: [{ id: "t1", name: "Main", [core.POS]: "a" }, { id: "t2", name: "Titles", [core.POS]: "b" }],
  items: [
    clip("intro", 0, 6, { name: "Intro" }),
    clip("w6", 7, 12, { name: "W6" }),
    clip("broll", 27, 31, { name: "B-roll 3" }),
    { id: "w2", type: "text", trackId: "t2", mediaItemId: "mt2", startTime: 2, endTime: 7, trimStart: 0, trimEnd: 5, textContent: "Hello", fontSize: 100 },
    { id: "cap1", type: "caption", trackId: "t2", startTime: 25, endTime: 27, trimStart: 0, trimEnd: 2, captionText: "we cut editing time" },
  ],
  media: [{ id: "m1", data: { fileName: "clip.mp4" } }, { id: "mt2", data: { type: "text", content: "Hello" } }],
});
const set = (path: (string | number)[], value: unknown): Op => ({ op: "set", path, value });
const rows = (ops: Op[], doc = base()) => core.changeList(ops, doc, schema);
const texts = (ops: Op[], doc = base()) => rows(ops, doc).map((r) => r.text);
const NO_IDS = /[0-9a-f]{12,}|@\d+|main@/;

test("every sentence form of DESIGN §8, verb first, the clip in curly quotes, positions as timecodes", () => {
  // Moved 'W6' 7.0 s → 9.0 s
  assert.deepEqual(texts([set(["items", "w6", "startTime"], 9), set(["items", "w6", "endTime"], 14)]), ["Moved “W6” 2 s later (now starts at 0:09)"]);
  assert.deepEqual(texts([set(["items", "w6", "startTime"], 6.5), set(["items", "w6", "endTime"], 11.5)]), ["Moved “W6” 0.5 s earlier (now starts at 0:07)"]);
  // Trimmed 'Intro' end 6.0 s → 5.0 s; start …
  assert.deepEqual(texts([set(["items", "intro", "endTime"], 5)]), ["Trimmed “Intro”, now ends at 0:05"]);
  assert.deepEqual(texts([set(["items", "intro", "startTime"], 1)]), ["Trimmed “Intro”, now starts at 0:01"]);
  // Changed 'W2' font size 100 → 222
  assert.deepEqual(texts([set(["items", "w2", "fontSize"], 222)]), ["Made “Hello” bigger (font size 100 → 222)"]);
  // Changed 'W1' text "Hello" → "Hello world" (a title's text names it)
  assert.deepEqual(texts([set(["items", "w2", "textContent"], "Hello world")]), ["Changed “Hello” to “Hello world”"]);
  // a caption's text
  assert.deepEqual(texts([set(["items", "cap1", "captionText"], "in half")]), ["Changed caption to “in half”"]);
  // added and removed: a clip by its name alone, a title or a caption by what it is
  assert.deepEqual(texts([{ op: "remove", path: ["items", "broll"] }]), ["Removed “B-roll 3”"]);
  assert.deepEqual(texts([{ op: "insert", path: ["items", "jane"], value: { id: "jane", type: "text", trackId: "t2", startTime: 12, endTime: 17, trimStart: 0, trimEnd: 5, textContent: "Jane Smith, Founder" } }]), ["Added title “Jane Smith, Founder”"]);
  // a field's value
  assert.deepEqual(texts([set(["items", "intro", "volume"], 0.8)]), ["Set the volume of “Intro” to 0.8"]);
  assert.deepEqual(texts([set(["items", "intro", "colorGrading"], { saturation: 1.3 })]), ["Set the saturation of “Intro” to 1.3"]);
  // the project's own fields
  assert.deepEqual(texts([set(["aspectRatio"], "9:16")]), ["Changed the aspect ratio to “9:16”"]);
  assert.deepEqual(texts([set(["frameRate"], 30)]), ["Set the frame rate to 30"]);
  // a host's words for a value (Cardboard's "30 fps", "80%")
  assert.deepEqual(core.changeList([set(["items", "intro", "volume"], 0.8)], base(), schema, { value: (k, v) => (k === "volume" ? `${Math.round((v as number) * 100)}%` : undefined) }).map((r) => r.text), ["Set the volume of “Intro” to 80%"]);
});

test("Added track 'Text 1', moved 'W6' reads as one line: “W6” moved to a new track (two changes, as counted)", () => {
  const ops: Op[] = [
    { op: "insert", path: ["tracks", "t3"], value: { id: "t3", name: "Text 1", [core.POS]: "c" } },
    set(["items", "w6", "trackId"], "t3"),
  ];
  const r = rows(ops);
  assert.equal(r.length, core.countChanges(ops, base(), schema));
  assert.deepEqual(r.map((x) => x.text), ["Added track “Text 1”", "Moved “W6” to a new track"]);
  assert.equal(core.changeSummary(r, schema), "Moved “W6” to a new track");
  // onto a track that was there
  assert.deepEqual(texts([set(["items", "w6", "trackId"], "t2")]), ["Moved “W6” to track “Titles”"]);
});

test("a split is one change, at its points; a title's own media entry goes with the title", () => {
  const ops: Op[] = [
    { op: "remove", path: ["items", "intro"] },
    { op: "insert", path: ["items", "intro-a"], value: clip("intro-a", 0, 4, { name: "Intro" }) },
    { op: "insert", path: ["items", "intro-b"], value: clip("intro-b", 4, 6, { name: "Intro", trimStart: 4, trimEnd: 6 }) },
  ];
  const r = rows(ops);
  assert.equal(r.length, 1);
  assert.equal(r.length, core.countChanges(ops, base(), schema));
  assert.equal(r[0]!.text, "Split “Intro” at 0:04");
  assert.deepEqual([r[0]!.at, r[0]!.end], [0, 6]);
  const del: Op[] = [{ op: "remove", path: ["items", "w2"] }, { op: "remove", path: ["media", "mt2"] }];
  assert.deepEqual(texts(del), ["Removed title “Hello”"]);
  assert.equal(core.countChanges(del, base(), schema), 1);
});

test("each row says where it is: its start after the change, a removal's before it; a project field has no place", () => {
  const ops: Op[] = [
    set(["items", "w6", "startTime"], 9), set(["items", "w6", "endTime"], 14),
    { op: "remove", path: ["items", "broll"] },
    set(["aspectRatio"], "9:16"),
  ];
  const r = rows(ops);
  const by = (k: string) => r.find((x) => x.key === k)!;
  assert.deepEqual([by("items/w6").at, by("items/w6").end, by("items/w6").kind], [9, 14, "change"]);
  assert.deepEqual([by("items/broll").at, by("items/broll").end, by("items/broll").kind], [27, 31, "remove"]);
  assert.equal(by("aspectRatio").at, undefined);
  assert.equal(by("aspectRatio").coll, null);
  assert.equal(by("items/w6").id, "w6");
});

test("the count of rows is countChanges' for docDiffs of every fixture, and no row or summary shows an id or a hash", () => {
  const b = base();
  const edits: Doc[] = [
    { ...b, items: (b.items as Rec[]).map((x) => (x.id === "w6" ? { ...x, startTime: 9, endTime: 14 } : x)) },
    { ...b, aspectRatio: "9:16", items: (b.items as Rec[]).filter((x) => x.id !== "broll") },
    { ...b, items: [...(b.items as Rec[]), clip("deadbeefdeadbeef0011", 31, 38, { name: undefined, mediaItemId: "m1" })] },
    { ...b, items: (b.items as Rec[]).map((x) => (x.id === "intro" ? { ...x, mediaItemId: "0123456789abcdef0123456789abcdef" } : x)) },
    { ...b, name: "Dragon short", tracks: [...(b.tracks as Rec[]), { id: "t9", name: "Text 1", [core.POS]: "c" }] },
  ];
  for (const after of edits) {
    const ops = core.diff(b, after, schema);
    const r = rows(ops, b);
    assert.equal(r.length, core.countChanges(ops, b, schema));
    for (const x of r) assert.doesNotMatch(x.text, NO_IDS, x.text);
    assert.doesNotMatch(core.changeSummary(r, schema), NO_IDS);
  }
});

test("a summary of several changes groups them by what was done", () => {
  const ops: Op[] = [
    set(["items", "w6", "startTime"], 9), set(["items", "w6", "endTime"], 14),
    set(["items", "broll", "startTime"], 28), set(["items", "broll", "endTime"], 32),
    set(["items", "intro", "endTime"], 5),
  ];
  assert.equal(core.changeSummary(rows(ops), schema), "Moved “W6” and “B-roll 3”, trimmed “Intro”");
  const caps: Op[] = ["a", "b", "c"].map((id, i) => ({ op: "insert", path: ["items", id], value: { id, type: "caption", trackId: "t2", startTime: i, endTime: i + 1, trimStart: 0, trimEnd: 1, captionText: `line ${i}` } }));
  assert.equal(core.changeSummary(rows(caps), schema), "Added 3 captions");
});

test("Carton.log({summary, rows}) gives each version its rows, as many as it counts", async () => {
  const { createMemoryStore } = await import("../../store-memory/src/index.ts");
  const doc0 = base();
  const carton = await core.Carton.open({ adapter: { schema }, store: createMemoryStore(), init: { doc: doc0 }, actor: { kind: "human", id: "alice" } } as never);
  await carton.commit({ ops: [set(["items", "w6", "startTime"], 9), set(["items", "w6", "endTime"], 14)] });
  await carton.commit({ ops: [{ op: "remove", path: ["items", "broll"] }, set(["aspectRatio"], "9:16")] });
  const [v2, v1] = await carton.log({ summary: true, rows: true });
  assert.deepEqual(v1!.rows!.map((r: ChangeRow) => r.text), ["Moved “W6” 2 s later (now starts at 0:09)"]);
  assert.deepEqual(v2!.rows!.map((r: ChangeRow) => r.text).sort(), ["Changed the aspect ratio to “9:16”", "Removed “B-roll 3”"]);
  // without `rows`, nothing more than before
  assert.equal((await carton.log({ summary: true }))[0]!.rows, undefined);
  await carton.close();
});

test("a conflict card's sides in the same words: “Moved it to start at 0:07”, never seconds with arrows", () => {
  const card: ConflictCard = { kind: "group", path: "items/w6/#time", base: { startTime: 5, endTime: 10, trimStart: 0, trimEnd: 5 }, ours: { startTime: 7, endTime: 12, trimStart: 0, trimEnd: 5 }, theirs: { startTime: 5, endTime: 11, trimStart: 0, trimEnd: 6 } };
  const w = core.describeCard(card, schema, base());
  assert.deepEqual([w.title, w.ours, w.theirs, w.name], ["“W6” timing", "Moved it to start at 0:07", "Trimmed it to end at 0:11", "W6"]);
  for (const s of [w.title, w.ours, w.theirs]) assert.doesNotMatch(s, /→|\d\.\d s/);
});
