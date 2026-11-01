// Anchors and re-anchoring (anchor.ts) on Cardboard documents: exact, moved, through a split, may be outdated,
// trimmed away, a deleted clip, the media fallback, and what the shot signature ignores.
import test from "node:test";
import assert from "node:assert/strict";
import { hashDoc, type Doc } from "@carton/core";
import { makeAnchor, place, TimelineIndex } from "../src/anchor.ts";
import { S, clip, doc, edit } from "./helpers.ts";

const OPTS = { media: "mediaItemId" };
const base = () => doc([clip("a", 0, 10), clip("c", 10, 20), clip("d", 20, 30), clip("t", 12, 14, "V2", { type: "text", mediaItemId: undefined, text: "Title" })]);
const at = (d: Doc, seq = 1) => ({ cut: "main", seq, hash: hashDoc(d, S) });
const anchorOn = (d: Doc, range?: [number, number]) => makeAnchor(d, S, at(d), range, OPTS);
const on = (d: Doc) => ({ index: new TimelineIndex(d, S, OPTS), hash: hashDoc(d, S) });

test("an anchor keeps the version, the range, the items under it top first with their source time, and a signature", () => {
  const d = base();
  const a = anchorOn(d, [13, 15]);
  assert.equal(a.cut, "main");
  assert.equal(a.state, hashDoc(d, S));
  assert.deepEqual(a.range, [13, 15]);
  assert.deepEqual(a.items, [
    { id: "t", at: 1, media: undefined },
    { id: "c", at: 3, media: "m-c" },
  ].map((x) => (x.media === undefined ? { id: x.id, at: x.at } : x)));
  assert.match(a.sig!, /^[0-9a-f]{16}$/);
  const late = anchorOn(d, [9, 11]);
  assert.deepEqual(late.items!.map((i) => [i.id, i.at, i.dt]), [["a", 9, undefined], ["c", 0, 1]], "a clip that starts inside the range keeps how far in");
  assert.deepEqual(anchorOn(d), { cut: "main", seq: 1, state: hashDoc(d, S) }, "no range: the whole version");
});

test("exact: the same version, or a later one where nothing changed at that place", () => {
  const d = base();
  const a = anchorOn(d, [15, 16]);
  assert.equal(place(a, on(d)).status, "exact");
  const later = edit(d, { d: { opacity: 0.5 } });
  const p = place(a, on(later));
  assert.deepEqual([p.status, p.range], ["exact", [15, 16]]);
});

test("moved: a ripple delete earlier on the track brings the commented clip 4 s earlier", () => {
  const d = base();
  const a = anchorOn(d, [15, 16]);
  const rippled = edit(d, { a: { endTime: 6, trimEnd: 6 }, c: { startTime: 6, endTime: 16 }, d: { startTime: 16, endTime: 26 }, t: { startTime: 8, endTime: 10 } });
  const p = place(a, on(rippled));
  assert.equal(p.status, "moved");
  assert.deepEqual(p.range, [11, 12]);
  assert.deepEqual(p.items, ["c"]);
});

test("through a split: the second piece got a new id; lineage follows it, and the picture is the same", () => {
  const d = base();
  const a = anchorOn(d, [16, 17]); // c's source 6 s
  const split = edit(d, { c: { endTime: 15, trimEnd: 5 } }, [clip("c-b", 15, 20, "V1", { mediaItemId: "m-c", trimStart: 5, trimEnd: 10 })]);
  // without lineage, "c" is still there but no longer shows source 6 s: followed by media, still the same picture
  const byMedia = place(a, on(split));
  assert.deepEqual([byMedia.status, byMedia.range], ["exact", [16, 17]]);
  const withLineage = place(a, on(split), { c: ["c", "c-b"] });
  assert.deepEqual([withLineage.status, withLineage.range, withLineage.items], ["exact", [16, 17], ["c-b"]]);
  // then the second piece moves to the end of the timeline
  const moved = edit(split, { "c-b": { startTime: 30, endTime: 35 } });
  const p = place(a, on(moved), { c: ["c", "c-b"] });
  assert.deepEqual([p.status, p.range], ["moved", [31, 32]]);
});

test("a range across a split point stays exact: the two pieces continue each other", () => {
  const d = base();
  const a = anchorOn(d, [17, 19]);
  const split = edit(d, { c: { endTime: 18, trimEnd: 8 } }, [clip("c-b", 18, 20, "V1", { mediaItemId: "m-c", trimStart: 8, trimEnd: 10 })]);
  assert.equal(place(a, on(split), { c: ["c", "c-b"] }).status, "exact");
});

test("may be outdated: the clip's look changed, or a title now covers the spot", () => {
  const d = base();
  const a = anchorOn(d, [16, 17]);
  const graded = edit(d, { c: { opacity: 0.4 } });
  const p = place(a, on(graded));
  assert.deepEqual([p.status, p.why, p.range], ["outdated", "changed", [16, 17]]);
  const titled = edit(d, {}, [clip("t2", 15.5, 18, "V2", { type: "text", mediaItemId: undefined, text: "New" })]);
  assert.equal(place(a, on(titled)).status, "outdated");
  const titledElsewhere = edit(d, {}, [clip("t3", 25, 27, "V2", { type: "text", mediaItemId: undefined, text: "Later" })]);
  assert.equal(place(a, on(titledElsewhere)).status, "exact");
});

test("may be outdated, trimmed: the commented moment was cut out of the clip", () => {
  const d = base();
  const a = anchorOn(d, [18, 19]); // c's source 8 s
  const trimmed = edit(d, { c: { endTime: 15, trimEnd: 5 }, d: { startTime: 15, endTime: 25 } });
  const p = place(a, on(trimmed));
  assert.deepEqual([p.status, p.why, p.range], ["outdated", "trimmed", [15, 16]]);
});

test("removed: the clip it was on is gone (and nothing shows its media there)", () => {
  const d = base();
  const a = anchorOn(d, [25, 26]);
  const gone = edit(d, { d: null });
  const p = place(a, on(gone));
  assert.deepEqual([p.status, p.range, p.items], ["removed", [25, 26], []]);
});

test("found by media when the id is gone (a re-import), nearest the old place; the signature still decides", () => {
  const d = base();
  const a = anchorOn(d, [25, 26]); // d's source 5 s
  const reimported = edit(d, { d: null }, [clip("d2", 40, 50, "V1", { mediaItemId: "m-d" }), clip("d3", 100, 110, "V1", { mediaItemId: "m-d" })]);
  const p = place(a, on(reimported));
  assert.deepEqual([p.status, p.range, p.items], ["moved", [45, 46], ["d2"]]);
});

test("what doesn't change the picture doesn't count: a renamed clip, a fade far from the spot; a fade on it does", () => {
  const d = base();
  const a = anchorOn(d, [15, 16]);
  assert.equal(place(a, on(edit(d, { c: { name: "Interview" } }))).status, "exact");
  assert.equal(place(a, on(edit(d, { c: { transitionOut: { type: "fade", duration: 1 } } }))).status, "exact");
  const end = anchorOn(d, [19.5, 19.8]);
  assert.equal(place(end, on(edit(d, { c: { transitionOut: { type: "fade", duration: 1 } } }))).status, "outdated");
});

test("a moment (start = end) and a whole-version comment", () => {
  const d = base();
  const m = anchorOn(d, [16, 16]);
  assert.deepEqual(m.items!.map((i) => i.id), ["c"]);
  const rippled = edit(d, { c: { startTime: 8, endTime: 18 }, a: { endTime: 8, trimEnd: 8 } });
  assert.deepEqual(place(m, on(rippled)).range, [14, 14]);
  const g = place(anchorOn(d), on(rippled));
  assert.deepEqual(g, { status: "general", range: null, items: [] });
});

test("an empty spot stays where it was: exact while still empty, outdated once something is there", () => {
  const d = doc([clip("a", 0, 10), clip("d", 20, 30)]);
  const a = anchorOn(d, [12, 14]);
  assert.equal(a.items, undefined);
  assert.equal(place(a, on(edit(d, { d: { opacity: 0.5 } }))).status, "exact");
  assert.equal(place(a, on(edit(d, {}, [clip("x", 11, 15)]))).status, "outdated");
});

test("the index answers 'what is under' with a long clip on another lane and many short ones", () => {
  const items = Array.from({ length: 500 }, (_, i) => clip(`s${i}`, i * 2, i * 2 + 2));
  items.push(clip("music", 0, 1000, "V2", { type: "audio" }));
  const ix = new TimelineIndex(doc(items), S, OPTS);
  assert.deepEqual(ix.under(101, 103).map((l) => l.id).sort(), ["music", "s50", "s51"]);
  assert.deepEqual(ix.under(100, 100).map((l) => l.id).sort(), ["music", "s50"]);
  assert.deepEqual(ix.under(2000, 2001), []);
});
