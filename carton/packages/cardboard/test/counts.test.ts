// Cardboard's words for what a version counts (laptop re-check of merge/prod-2, 2026-11-02):
// - P3-8: a setup version read "Added 2 tracks, 7 clips and 6 media files" for 1 clip and 6 titles: the titles were
//   counted as clips, and each title's own media entry (1.4.0 adds "Text: W1" per title) as a media file.
// - P3 (fold counts): a split of a clip with auto reframe read "Split 'clip.mp4' at 1.5 s, cleared auto reframe on its
//   left part, cleared auto reframe on its right part": the editor's save writes the new parts without it.
import test from "node:test";
import assert from "node:assert/strict";
import { countChanges, describe, describeVersion, diff, heldBy, namingDoc } from "@carton/core";
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
  // every record is listed but a title's own media entry, added with it, which is the title's (N-1 below; regress prod3
  // P3-C: "15 changes", "Added media 'Text: W1'"…): 2 tracks, the clip, 6 titles and the clip's media
  assert.equal(v.lines.length, 2 + 1 + 6 + 1);
  assert.doesNotMatch(v.lines.join("\n"), /Text: /);
  assert.equal(countChanges(diff(empty, full, S), empty, S), 10);
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

// Regress prod3 P3-C: the row's count and its list still counted each title's own media entry ("15 changes", with
// "Added media 'Text: W1'" … 'Text: W6'; a Restore's "16 changes", "Deleted media 'Text: …'"). The headline already
// left them out; the count and the list do too, for adds, deletes and edits. An entry whose title isn't touched (its
// text alone changed) is still told: it is all the change there is.
test("prod3 P3-C: a title's own media entry is the title's change, in the count and the list alike", () => {
  const empty = fromHost({ ...project([], []), tracks: [] });
  const titles = [1, 2, 3, 4, 5, 6].map(titleItem);
  const media = [video, ...titles.map((t, i) => textMedia(`tm${i + 1}`, String(t.textContent)))];
  const full = fromHost(project([clip(), ...titles], media));
  // a restore back to nothing deletes them all: the titles, not their media entries
  const del = describeVersion(diff(full, empty, S), full, S);
  assert.equal(del.lines.length, 10);
  assert.doesNotMatch(del.lines.join("\n"), /media 'Text: /);
  assert.equal(countChanges(diff(full, empty, S), full, S), 10);
  // one title deleted with its entry: one change
  const less = fromHost(project([clip(), ...titles.slice(1)], media.filter((m) => m.id !== "tm1")));
  assert.deepEqual(describe(diff(full, less, S), full, S), ["Deleted title 'W1'"]);
  assert.equal(countChanges(diff(full, less, S), full, S), 1);
  // a title's text changed with its entry's: one line, one change
  const t1 = { ...titles[0]!, textContent: "Hello", name: "Hello" };
  const edited = fromHost(project([clip(), t1, ...titles.slice(1)], media.map((m) => (m.id === "tm1" ? textMedia("tm1", "Hello") : m))));
  assert.equal(countChanges(diff(full, edited, S), full, S), 1);
  assert.equal(describe(diff(full, edited, S), full, S).length, 1);
  // the entry alone changed: still told, and counted
  const only = fromHost(project([clip(), ...titles], media.map((m) => (m.id === "tm2" ? textMedia("tm2", "Hey") : m))));
  assert.equal(describe(diff(full, only, S), full, S).length, 1);
  assert.equal(countChanges(diff(full, only, S), full, S), 1);
  // only the title that names it by mediaItemId owns it (review: any string field matched): a track that happens to be
  // called "tm2", changed with that entry, doesn't take the entry's change
  const named = fromHost({ ...project([clip(), ...titles], media.map((m) => (m.id === "tm2" ? textMedia("tm2", "Hey") : m))), tracks: [{ id: "V1", name: "Video 1", order: 0 }, { id: "T1", name: "tm2", order: 1, muted: true }] });
  const lone = fromHost({ ...project([clip(), ...titles], media), tracks: [{ id: "V1", name: "Video 1", order: 0 }, { id: "T1", name: "tm2", order: 1 }] });
  assert.equal(describe(diff(lone, named, S), lone, S).length, 2);
  assert.equal(countChanges(diff(lone, named, S), lone, S), 2);
  // an entry two titles share (Duplicate keeps mediaItemId) is neither's alone: its own change
  const dup = fromHost(project([clip(), ...titles, { ...titleItem(7), id: "t1b", mediaItemId: "tm1" }], media));
  const base1 = fromHost(project([clip(), ...titles.slice(1)], media.filter((m) => m.id !== "tm1")));
  assert.equal(countChanges(diff(base1, dup, S), base1, S), 3, "two titles and the entry they share");
  assert.match(describe(diff(base1, dup, S), base1, S).join("\n"), /Text: W1/);
  // a real media file is still its own change
  const more = fromHost(project([clip(), ...titles], [...media, { ...video, id: "m2", contentHash: "h2", data: { type: "video", fileName: "b-roll.mp4", duration: 9 } }]));
  assert.deepEqual(describe(diff(full, more, S), full, S), ["Added media 'b-roll.mp4'"]);
});

// Regress prod3 P3-B: the Fold dialog read "Moved 'W1' to track another track, font size 100 → 150": the version
// also adds track 'Text 1' and moves W1 onto it, and each row is described alone against Main, which hasn't that track.
// A row is named from all of the fold (describe's names), as History's own row names it; a track nothing names is
// "another track", never "track another track".
test("prod3 P3-B: a clip moved onto a track the same fold adds names it; an unnamed one isn't 'track another track'", () => {
  const w1 = { ...titleItem(1), fontSize: 100 };
  const before = fromHost(project([clip(), w1], [video, textMedia("tm1", "W1")]));
  const after = fromHost({ ...project([clip(), { ...w1, trackId: "T2", fontSize: 150 }], [video, textMedia("tm1", "W1")]), tracks: [...project([], []).tracks, { id: "T2", name: "Text 1", order: 2 }] });
  const ops = diff(before, after, S);
  // History's row: the whole version
  assert.deepEqual(describe(ops, before, S), ["Added track 'Text 1'", "Moved 'W1' to track 'Text 1', font size 100 → 150"]);
  // the dialog's row: W1's ops alone, named from all of the fold
  const row = ops.filter((op) => op.op !== "remap" && op.path[0] === "timelineItems");
  assert.deepEqual(describe(row, before, S, null, namingDoc(before, ops, S)), ["Moved 'W1' to track 'Text 1', font size 100 → 150"]);
  // review of the merge: rows described with one names doc share who holds what, over all of the set: a title's row
  // with its entry, while another row adds a duplicate naming the same entry, tells the entry (it is the duplicate's too)
  const t7 = { ...titleItem(7), startTime: 7, endTime: 8 }, copy = { ...t7, id: "t7copy" };
  const more = fromHost(project([clip(), w1, t7, copy], [video, textMedia("tm1", "W1"), textMedia("tm7", "W7")]));
  const all = diff(before, more, S);
  const t7row = all.filter((op) => op.op !== "remap" && (op.path[1] === "t7" || op.path[1] === "tm7"));
  assert.deepEqual(describe(t7row, before, S), ["Added title 'W7' on 'Titles' at 7.0 s"], "alone, the row's title holds it");
  const names = namingDoc(before, all, S);
  assert.deepEqual(describe(t7row, before, S, null, names).sort(), ["Added media 'Text: W7'", "Added title 'W7' on 'Titles' at 7.0 s"]);
  assert.equal(describe(t7row, before, S, null, names).length, 2, "the same doc again: the same answer");
  // with nothing to name the track: not "to track another track"
  assert.deepEqual(describe(row, before, S), ["Moved 'W1' to another track, font size 100 → 150"]);
});

// N-1 (laptop, merge/prod-2): the editor's delete of a title drops the title's own "Text: W6" entry with it, which read
// as a second change ("Deleted title 'W6'", "Deleted media 'Text: W6'"): its own media entry is the title's, as a
// split's auto reframe drop is the split's. One line, one change, one row of the Fold dialog (heldBy).
test("N-1: a title deleted (or added) with its own media entry is one change: the title's", () => {
  const titles = [1, 2, 3, 4, 5, 6].map(titleItem), media = titles.map((t, i) => textMedia(`tm${i + 1}`, String(t.textContent)));
  const before = fromHost(project([clip(), ...titles], [video, ...media]));
  const gone = fromHost(project([clip(), ...titles.slice(0, 5)], [video, ...media.slice(0, 5)]));
  const ops = diff(before, gone, S);
  assert.deepEqual(describe(ops, before, S), ["Deleted title 'W6'"]);
  assert.equal(describeVersion(ops, before, S).summary, "Deleted title 'W6'");
  assert.equal(countChanges(ops, before, S), 1);
  assert.deepEqual(heldBy(ops, before, S), [{ part: ["media", "tm6"], holder: ["timelineItems", "t6"] }]);
  // undone: both back, one change
  const back = diff(gone, before, S);
  assert.deepEqual(describe(back, gone, S), ["Added title 'W6' on 'Titles' at 6.0 s"]);
  assert.equal(countChanges(back, gone, S), 1);
  // a title and its entry added
  const w7 = { ...titleItem(7), startTime: 7, endTime: 8 };
  const added = fromHost(project([clip(), ...titles, w7], [video, ...media, textMedia("tm7", "W7")]));
  assert.deepEqual(describe(diff(before, added, S), before, S), ["Added title 'W7' on 'Titles' at 7.0 s"]);
  // the entry alone (its title stays): still told, as before
  const orphan = fromHost(project([clip(), ...titles], [video, ...media.slice(0, 5)]));
  assert.deepEqual(describe(diff(before, orphan, S), before, S), ["Deleted media 'Text: W6'"]);
  assert.equal(countChanges(diff(before, orphan, S), before, S), 1);
  // a title deleted while another title's entry is dropped alone: each told
  const two = fromHost(project([clip(), ...titles.slice(0, 5)], [video, ...media.slice(1, 6)]));
  assert.deepEqual(describe(diff(before, two, S), before, S).sort(), ["Deleted media 'Text: W1'", "Deleted title 'W6'"]);
  // review #2: an entry two titles name (Cardboard's duplicate keeps mediaItemId) belongs to neither alone: told
  const copy = { ...titleItem(6), id: "t6copy", startTime: 7, endTime: 8 };
  const shared = fromHost(project([clip(), ...titles, copy], [video, ...media]));
  const allGone = fromHost(project([clip(), ...titles.slice(0, 5)], [video, ...media.slice(0, 5)]));
  assert.deepEqual(describe(diff(shared, allGone, S), shared, S).sort(), ["Deleted media 'Text: W6'", "Deleted title 'W6'", "Deleted title 'W6'"]);
  assert.equal(countChanges(diff(shared, allGone, S), shared, S), 3);
  assert.deepEqual(heldBy(diff(shared, allGone, S), shared, S), []);
  // review #4: only the item's media field names its entry; a title whose name happens to be the entry's id isn't its holder
  const named = { ...titleItem(2), name: "tm1" };
  const before4 = fromHost(project([clip(), titleItem(1), named], [video, media[0]!, media[1]!]));
  const after4 = fromHost(project([clip(), titleItem(1)], [video, media[1]!]));
  assert.deepEqual(describe(diff(before4, after4, S), before4, S).sort(), ["Deleted media 'Text: W1'", "Deleted title 'tm1'"]);
  assert.equal(countChanges(diff(before4, after4, S), before4, S), 2);
  // a library file's media (a clip's) is never a part: deleting a clip and its media is two changes, as before
  const noClip = fromHost(project(titles, media));
  assert.equal(countChanges(diff(before, noClip, S), before, S), 2);
});
