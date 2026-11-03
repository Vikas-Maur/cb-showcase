// ui-words: Cardboard's records named for people, and its conflict cards in an editor's words. A Cardboard video item
// has no name (the user saw "video iXim_D" and "Added media 'undefined 5ec720'"); it is named after its media's file
// name, media by its file name, else its text, else its kind. Cards say what each side did differently, never ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, type ConflictCard, type Doc, type Rec } from "@carton/core";
import { cardboardSchema, describeCardboardCard, fromHost, ITEMS, MEDIA, TRACKS } from "../src/index.ts";

const TRACK = "7ba56a6c-9992-42a1-88be-b30091622288", M = "5ec72031-8f1e-4c55-a4e2-3c1f0b1d9a77";
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: TRACK, mediaItemId: M, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, volume: 1, opacity: 1, ...more });
const doc = (): Doc =>
  fromHost({ id: "p1", name: "Dragon short", aspectRatio: "16:9", tracks: [{ id: TRACK, name: "Mine", type: "video", order: 0 }], timelineItems: [clip("IyUFHiQ2m7Kd0aXbT9pLw", 1.5, 4.5)], media: [{ id: M, data: { type: "video", fileName: "Dragon-take2.mp4" } }] });
const label = (coll: string, r: Rec | undefined, d?: Doc) => cardboardSchema.label!(coll, r, d);

test("labels: a clip without a name is its media's file name; media by file name, else text, else kind; never 'undefined'", () => {
  const d = doc();
  assert.equal(label(ITEMS, clip("IyUFHiQ2m7Kd0aXbT9pLw", 0, 1), d), "Dragon-take2.mp4");
  assert.equal(label(ITEMS, clip("x", 0, 1, { name: "Intro" }), d), "Intro", "its own name first");
  assert.equal(label(ITEMS, { id: "t", type: "text", textContent: "Hello there" }, d), "Hello there");
  assert.equal(label(MEDIA, { id: M, data: { type: "video", fileName: "Dragon-take2.mp4" } }), "Dragon-take2.mp4");
  assert.equal(label(MEDIA, { id: "m2", data: { type: "text", content: "Lower third" } }), "Lower third");
  assert.equal(label(MEDIA, { id: "m3", data: { type: "audio" } }), "audio");
  assert.equal(label(TRACKS, { id: TRACK, name: "Mine" }), "Mine");
  // no doc, or media not found: the id fragment is the last resort, and never "undefined"
  assert.equal(label(ITEMS, clip("iXim_Dlywcf2Lp5OO-WkD", 0, 1)), "video iXim_D");
  assert.doesNotMatch(label(MEDIA, { id: "5ec720ab", data: {} }), /undefined/);
});

test("History: 'Added media' and a clip's move read with the file name, as the user's History should have", () => {
  const d = doc();
  const ops = [{ op: "insert" as const, path: [MEDIA, "m9"], value: { id: "m9", data: { type: "video", fileName: "Beach.mov" } } }];
  assert.deepEqual(describe(ops, d, cardboardSchema), ["Added media 'Beach.mov'"]);
  const move = [
    { op: "set" as const, path: [ITEMS, "IyUFHiQ2m7Kd0aXbT9pLw", "startTime"], value: 3 },
    { op: "set" as const, path: [ITEMS, "IyUFHiQ2m7Kd0aXbT9pLw", "endTime"], value: 6 },
  ];
  assert.deepEqual(describe(move, d, cardboardSchema), ["Moved 'Dragon-take2.mp4' 1.5 s → 3.0 s"]);
  // the import's first field, set for the first time: never "none →"
  assert.deepEqual(describe([{ op: "set", path: ["name"], value: "Dragon short" }], { [TRACKS]: [], [ITEMS]: [], [MEDIA]: [] }, cardboardSchema), ["Named the project 'Dragon short'"]);
});

test("the user's card: a clip added then moved before the first save's answer, both saves inserting it", () => {
  const card: ConflictCard = { kind: "record", path: `${ITEMS}/iXim_Dlywcf2Lp5OO-WkD`, base: undefined, ours: clip("iXim_Dlywcf2Lp5OO-WkD", 10, 12), theirs: clip("iXim_Dlywcf2Lp5OO-WkD", 11, 13) };
  const w = describeCardboardCard(card, cardboardSchema, doc());
  assert.deepEqual(w, { title: "“Dragon-take2.mp4”", mine: "Added it at 0:10 to 0:12", theirs: "Added it at 0:11 to 0:13", name: "Dragon-take2.mp4" });
  for (const s of Object.values(w)) assert.doesNotMatch(s, /iXim|27ca|7ba5|5ec7|mediaItemId|trackId|\bid\b/);
});

test("cards in Cardboard's units: opacity and volume in percent, speed as ×, the media by its file name, a removed side", () => {
  const d = doc();
  const id = "IyUFHiQ2m7Kd0aXbT9pLw";
  const op = describeCardboardCard({ kind: "field", path: `${ITEMS}/${id}/opacity`, base: 1, ours: 0.5, theirs: 0.9 }, cardboardSchema, d);
  assert.deepEqual(op, { title: "“Dragon-take2.mp4” opacity", mine: "50%", theirs: "90%", name: "Dragon-take2.mp4" });
  const b = clip(id, 1.5, 4.5);
  const rec = describeCardboardCard({ kind: "record", path: `${ITEMS}/${id}`, base: b, ours: { ...b, volume: 0.6, playbackSpeed: 2 }, theirs: undefined }, cardboardSchema, d);
  assert.deepEqual([rec.mine, rec.theirs], ["Volume 60%, speed 2×", "Removed"]);
  const time = describeCardboardCard({ kind: "group", path: `${ITEMS}/${id}/#time`, reason: "same kind or incompatible", base: { startTime: 1.5, endTime: 4.5 }, ours: { startTime: 3, endTime: 6 }, theirs: { startTime: 4, endTime: 7 } }, cardboardSchema, d);
  assert.deepEqual(time, { title: "“Dragon-take2.mp4” timing", mine: "Moved it to start at 0:03", theirs: "Moved it to start at 0:04", name: "Dragon-take2.mp4" });
});
