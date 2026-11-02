// Cardboard's words for what a version counts (laptop re-check of merge/prod-2, 2026-11-02):
// - P3-8: a setup version read "Added 2 tracks, 7 clips and 6 media files" for 1 clip and 6 titles: the titles were
//   counted as clips, and each title's own media entry (1.4.0 adds "Text: W1" per title) as a media file.
// - P3 (fold counts): a split of a clip with auto reframe read "Split 'clip.mp4' at 1.5 s, cleared auto reframe on its
//   left part, cleared auto reframe on its right part": the editor's save writes the new parts without it.
import test from "node:test";
import assert from "node:assert/strict";
import { countChanges, describe, describeVersion, diff } from "@carton/core";
import type { Rec } from "@carton/core";
import { cardboardSchema as S, fromHost } from "../src/index.ts";

const textMedia = (id: string, text: string) => ({ id, createdAt: "2026-11-02T00:00:00.000Z", addedAt: "2026-11-02T00:00:00.000Z", data: { type: "text", presetId: "custom", content: text, fileName: `Text: ${text}`, format: "text", size: 0 } });
const video = { id: "m1", createdAt: "2026-11-02T00:00:00.000Z", addedAt: "2026-11-02T00:00:00.000Z", contentHash: "h1", data: { type: "video", fileName: "clip.mp4", duration: 30 } };
const clip = (more: Rec = {}): Rec => ({ id: "c1", type: "video", trackId: "V1", mediaItemId: "m1", startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, ...more });
const titleItem = (k: number): Rec => ({ id: `t${k}`, type: "text", trackId: "T1", mediaItemId: `tm${k}`, name: `W${k}`, textContent: `W${k}`, startTime: k, endTime: k + 1, trimStart: 0, trimEnd: 1 });
const project = (items: Rec[], media: Rec[]) => ({ name: "Demo", aspectRatio: "16:9", tracks: [{ id: "V1", name: "Video 1", order: 0 }, { id: "T1", name: "Titles", order: 1 }], timelineItems: items, media });

test("P3-8: a setup version counts titles as titles, and a title's own media entry not as a media file", () => {
  const empty = fromHost({ ...project([], []), tracks: [] });
  const titles = [1, 2, 3, 4, 5, 6].map(titleItem);
  const full = fromHost(project([clip(), ...titles], [video, ...titles.map((t, i) => textMedia(`tm${i + 1}`, String(t.textContent)))]));
  const v = describeVersion(diff(empty, full, S), empty, S);
  assert.equal(v.summary, "Added 2 tracks, video 'clip.mp4', 6 titles and media 'clip.mp4'");
  assert.doesNotMatch(v.summary, /clips|media files/);
  // every record is still listed
  assert.equal(v.lines.length, 2 + 1 + 6 + 7);
  // two clips and a title: clips counted as clips
  const two = fromHost(project([clip(), clip({ id: "c2", startTime: 3, endTime: 6 }), titleItem(1)], [video, textMedia("tm1", "W1")]));
  assert.equal(describeVersion(diff(empty, two, S), empty, S).summary, "Added 2 tracks, 2 clips, title 'W1' and media 'clip.mp4'");
});

test("P3: Cardboard's split, saved by the editor without autoReframe on its parts, reads as the split alone", () => {
  const before = fromHost(project([clip({ autoReframe: true })], [video]));
  const parts = [clip({ id: "p1", endTime: 1.5, trimEnd: 1.5 }), clip({ id: "p2", startTime: 1.5, trimStart: 1.5 })];
  const after = fromHost(project(parts, [video]));
  const ops = diff(before, after, S);
  assert.deepEqual(describe(ops, before, S), ["Split 'clip.mp4' at 1.5 s"]);
  assert.equal(countChanges(ops, before, S), 1);
  // auto reframe turned off on a part in the same version: still told
  const off = fromHost(project([{ ...parts[0]!, autoReframe: false }, { ...parts[1]!, autoReframe: true }], [video]));
  assert.deepEqual(describe(diff(before, off, S), before, S), ["Split 'clip.mp4' at 1.5 s, changed its left part auto reframe true → false"]);
});
