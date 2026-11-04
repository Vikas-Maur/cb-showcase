// Compare in the editor (docs/carton-ux v2 DESIGN-V2 §1, N1): the pure parts. Play both's clock in step by shot, the
// timeline's marks from a diff (added, removed as a ghost or a seam, moved, trimmed, changed), the left side's strip,
// and the stage's modes by width.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipDiff, clipShots, compareMarks, followTime, leadTime, playLength, playSchedule, removedAt, sidesAt, stepAt, stillAt, storyAt, stripOf, HOLD_BACK, type CompareDoc } from "../src/compare.ts";
import { compareModeShown, compareModesFor } from "../src/components/CompareView.ts";
import { alignRows } from "../src/shots.ts";
import { words } from "../src/words.ts";
import type { Change, Shot, ShotDiff } from "../src/model.ts";

const shots = (...lens: [number, number][]): Shot[] => {
  let t = 0;
  return lens.map(([sig, d]) => {
    const s = { start: t, end: t + d, sig };
    t += d;
    return s;
  });
};
// left (a): Intro 6, Interview A 6, B-roll pier 3, Interview B 9      right (b): Intro' 5, Interview A 6, Drone 4, Interview B 9
const A = shots([1, 6], [2, 6], [3, 3], [4, 9]);
const B = shots([11, 5], [2, 6], [5, 4], [4, 9]);
const D: ShotDiff = { a: A, b: B, matches: [[1, 1], [3, 3]], aLabel: "Sent to client", bLabel: "Your edit" };
const R = alignRows(D);

test("followTime: in step by shot, never faster or slower than real time", () => {
  // the intro: 6 s on the left, 5 s on the right, a changed stretch: the left plays on at 1× from its start
  assert.equal(followTime(D, R, 0), 0);
  assert.equal(followTime(D, R, 4), 4);
  // Interview A starts together on both sides (right 5, left 6): the left side jumps to its start
  assert.equal(followTime(D, R, 5), 6);
  assert.equal(followTime(D, R, 8), 9);
  // the drone shot (right 11–15) against the pier (left 12–15): the pier plays, then holds its last frame ("waiting")
  assert.equal(followTime(D, R, 11), 12);
  assert.equal(followTime(D, R, 13.5), 14.5);
  assert.equal(followTime(D, R, 14.9), 15);
  // Interview B together again
  assert.equal(followTime(D, R, 15), 15);
  assert.equal(followTime(D, R, 20), 20);
  // and back: the right side's time for a left time, the same way
  assert.equal(leadTime(D, R, 6), 5);
  assert.equal(leadTime(D, R, 13), 12);
  assert.equal(stepAt(D, R, 7), "same");
  assert.equal(stepAt(D, R, 12), "change");
});

const chg = (itemId: string, kind: Change["kind"], at: number, end: number, text = itemId): Change => ({ key: `timelineItems/${itemId}`, itemId, kind, clip: "video", text, at, end });
const item = (id: string, trackId: string, startTime: number, endTime: number, o: Record<string, unknown> = {}) => ({ id, trackId, startTime, endTime, trimStart: 0, trimEnd: 0, ...o });
const LEFT = { tracks: [{ id: "v" }, { id: "t" }, { id: "gone" }], timelineItems: [item("intro", "v", 0, 6), item("ia", "v", 6, 12), item("pier", "v", 12, 15), item("ib", "v", 15, 24), item("title", "t", 1, 4), item("cap", "gone", 7, 9), item("logo", "t", 8, 10)] };
const RIGHT = { tracks: [{ id: "v" }, { id: "t" }], timelineItems: [item("intro", "v", 0, 5), item("ia", "v", 5, 11), item("drone", "v", 11, 15), item("ib", "v", 15, 24), item("title", "t", 2, 5), item("logo", "t", 8, 10)] };

test("compareMarks: one mark per clip a change row names, its kind from the row and the two timelines", () => {
  const changes: Change[] = [
    chg("intro", "change", 0, 5, "Trimmed “Intro”"),
    chg("ia", "change", 5, 11, "Moved “Interview A”"),
    chg("ia", "change", 5, 11, "Changed “Interview A”'s volume"),
    chg("drone", "add", 11, 15, "Added “Drone shot”"),
    chg("pier", "remove", 12, 15, "Removed “B-roll pier”"),
    chg("title", "change", 2, 5, "Moved the title 1 s later"),
    chg("logo", "change", 8, 10, "Changed “Logo”'s colour"),
    chg("cap", "remove", 7, 9, "Removed caption"),
    { key: "aspectRatio", kind: "change" as const, clip: "project" as const, text: "Changed the aspect ratio to 9:16" },
  ];
  const marks = compareMarks(changes, LEFT, RIGHT, D);
  const by = new Map(marks.map((m) => [m.itemId, m]));
  assert.equal(by.get("intro")?.kind, "trimmed");
  // a move that is only its place: ←1 s; two rows on one clip give one mark (the first row's key)
  assert.equal(by.get("ia")?.kind, "moved");
  assert.equal(by.get("ia")?.delta, -1);
  assert.equal(by.get("ia")?.key, "timelineItems/ia");
  assert.equal(marks.filter((m) => m.itemId === "ia").length, 1);
  assert.equal(by.get("title")?.kind, "moved");
  assert.equal(by.get("title")?.delta, 1);
  assert.equal(by.get("logo")?.kind, "changed");
  assert.deepEqual({ kind: by.get("drone")?.kind, start: by.get("drone")?.start, end: by.get("drone")?.end, track: by.get("drone")?.trackId }, { kind: "added", start: 11, end: 15, track: "v" });
  // the pier sat in a stretch that changed (the drone took its place): a seam at that stretch's start on the right
  assert.deepEqual({ kind: by.get("pier")?.kind, start: by.get("pier")?.start, end: by.get("pier")?.end, track: by.get("pier")?.trackId }, { kind: "removed", start: 11, end: 11, track: "v" });
  // a removed caption over a shot that stayed: a ghost of its size where it was, mapped (left 7–9 → right 6–8); its
  // track is gone on the right, so it has none (the host leaves it to the strip)
  assert.deepEqual({ start: by.get("cap")?.start, end: by.get("cap")?.end, track: by.get("cap")?.trackId }, { start: 6, end: 8, track: undefined });
  // no clip, no mark; in timeline order
  assert.ok(!marks.some((m) => m.key === "aspectRatio"));
  assert.deepEqual(marks.map((m) => m.start), [...marks.map((m) => m.start)].sort((x, y) => x - y));
});

test("compareMarks without the timelines or the alignment: the rows' own places and kinds", () => {
  const marks = compareMarks([chg("x", "add", 3, 5), chg("y", "change", 6, 8), chg("z", "remove", 1, 2)], null, null, null);
  assert.deepEqual(marks.map((m) => [m.itemId, m.kind, m.start, m.end]), [["z", "removed", 1, 2], ["x", "added", 3, 5], ["y", "changed", 6, 8]]);
});

test("stripOf on a content shot diff (no clips known): a stretch that differs reads as changed, never all removed", () => {
  const strip = stripOf(D);
  assert.deepEqual(strip.map((b) => [b.start, b.end, b.kind]), [[0, 6, "changed"], [6, 12, "same"], [12, 15, "changed"], [15, 24, "same"]]);
});

test("the stage's modes by width (DESIGN-V2 §1.9) and without a second player (§1.10)", () => {
  assert.deepEqual(compareModesFor(705, true), { modes: ["side", "wipe", "flip"], sideOff: false, compact: false });
  assert.deepEqual(compareModesFor(640, true), { modes: ["side", "wipe", "flip"], sideOff: true, compact: false });
  assert.deepEqual(compareModesFor(500, true), { modes: ["side", "wipe", "flip"], sideOff: true, compact: true });
  assert.deepEqual(compareModesFor(340, true).modes, ["flip"]);
  assert.deepEqual(compareModesFor(900, false).modes, ["flip"]);
  assert.equal(compareModeShown("side", compareModesFor(705, true)), "side");
  assert.equal(compareModeShown("side", compareModesFor(640, true)), "flip", "the width rule wins");
  assert.equal(compareModeShown("wipe", compareModesFor(640, true)), "wipe");
  assert.equal(compareModeShown("wipe", compareModesFor(900, false)), "flip", "no second player: Flip only");
});

test("Side by side's reason names what to close, in §1.9's words (one, two, three parts, or none: widen the window)", () => {
  const p = words.roomParts;
  assert.equal(words.sideNeedsRoomClose([p.chat]), words.sideBySideNeedsRoom, "the chat alone: §1.9's own sentence");
  assert.equal(words.sideNeedsRoomClose([p.history, p.chat]), "Side by side needs a wider stage. Close History and the chat, or widen the window.");
  assert.equal(words.sideNeedsRoomClose([p.history, p.chat, p.library]), "Side by side needs a wider stage. Close History, the chat and the Library, or widen the window.");
  assert.equal(words.sideNeedsRoomClose([]), "Side by side needs a wider stage. Widen the window.");
});

test("Play both (DESIGN-V2 §1.4): each shot starts on both sides together; the shorter side waits; a shot only one side has gets a slate on the other", () => {
  // the alignment (shots.ts): intro 6 | 5 (changed), Interview A 6 | 6 (same), pier 3 | drone 4 (changed), Interview B 9 | 9
  const named = (s: Shot[], names: string[]) => s.map((x, i) => ({ ...x, label: names[i] }));
  const d: ShotDiff = { ...D, a: named(A, ["Intro", "Interview A", "B-roll pier", "Interview B"]), b: named(B, ["Intro", "Interview A", "Drone shot", "Interview B"]) };
  const s = playSchedule(d);
  assert.deepEqual(s.map((x) => [x.start, x.dur, x.kind, x.a0, x.aLen, x.b0, x.bLen]), [
    [0, 6, "change", 0, 6, 0, 5],
    [6, 6, "same", 6, 6, 5, 6],
    [12, 4, "change", 12, 3, 11, 4],
    [16, 9, "same", 15, 9, 15, 9],
  ]);
  assert.equal(playLength(s), 25);
  // the intro: the right side's is a second shorter, so it waits on its last frame while the left plays on
  let at = sidesAt(s, 5.5);
  assert.deepEqual([at.a.t, at.a.hold], [5.5, false]);
  assert.equal(at.b.hold, true, "waiting");
  assert.ok(Math.abs(at.b.t - (5 - HOLD_BACK)) < 1e-9, "its last frame, never the next shot's first");
  // Interview A starts together on both sides (left 6, right 5)
  at = sidesAt(s, 6);
  assert.deepEqual([at.a.t, at.b.t, at.a.hold, at.b.hold], [6, 5, false, false]);
  // the pier (3 s) against the drone shot (4 s): the left waits for the right this time
  at = sidesAt(s, 15.5);
  assert.deepEqual([at.b.t, at.b.hold, at.a.hold], [14.5, false, true]);
  // where Play both starts from the right side's playhead, and from the left's
  assert.equal(storyAt(s, "b", 5), 6, "right 0:05 is Interview A's start");
  assert.equal(storyAt(s, "b", 13), 14);
  assert.equal(storyAt(s, "a", 13), 13);
  assert.equal(storyAt(s, "b", 99), 25, "past the end: the end");
});

test("Play both: a shot only one side has plays there, and the other side shows the slate naming it (either side)", () => {
  // left: Intro, B-roll pier, Outro; right: Intro, Drone shot, Outro (the pier removed, the drone added: no match)
  const A2: Shot[] = [{ start: 0, end: 4, sig: 1, label: "Intro" }, { start: 4, end: 7, sig: 2, label: "B-roll pier" }, { start: 7, end: 12, sig: 3, label: "Outro" }];
  const B2: Shot[] = [{ start: 0, end: 4, sig: 1, label: "Intro" }, { start: 4, end: 9, sig: 3, label: "Outro" }];
  const removed: ShotDiff = { a: A2, b: B2, matches: [[0, 0], [2, 1]], aLabel: "a", bLabel: "b" };
  let s = playSchedule(removed);
  assert.deepEqual(s.map((x) => [x.start, x.dur, x.aLen, x.bLen]), [[0, 4, 4, 4], [4, 3, 3, 0], [7, 5, 5, 5]]);
  let at = sidesAt(s, 5);
  assert.deepEqual([at.a.t, at.a.slate], [5, false], "the pier plays on the left");
  assert.equal(storyAt(s, "b", 4), 4, "the right side's playhead at the join (the removed pier picked): the pier's stretch, not the Outro after it");
  assert.deepEqual([at.b.t, at.b.slate, at.b.missing], [4, true, "B-roll pier"], "the right side's slate: “B-roll pier” isn't in …");
  // and the mirror: a shot only the right side has
  const added: ShotDiff = { a: B2, b: A2, matches: [[0, 0], [1, 2]], aLabel: "a", bLabel: "b" };
  s = playSchedule(added);
  at = sidesAt(s, 5);
  assert.deepEqual([at.b.t, at.b.slate], [5, false]);
  assert.deepEqual([at.a.t, at.a.slate, at.a.missing], [4, true, "B-roll pier"], "the left side's slate");
});


// ---------------------------------------------------------------- laptop (fix/ux2-laptop): clips matched by identity
// A real edit: a music bed under the whole cut and a title over the intro. The intro was trimmed by a second (the rest
// moved up), and B-roll pier was removed, leaving its gap. By content every shot after the trim differs (the music's
// in-point moved under each), so core's shot diff is one changed stretch from 0:00: that stretch is what Compare lined
// up on (Play both never in step for the trimmed intro; the removed pier marked as a seam at 0:00).
const T2 = [{ id: "titles" }, { id: "v" }, { id: "music" }];
const clip2 = (id: string, trackId: string, startTime: number, endTime: number, o: Record<string, unknown> = {}) => ({ id, trackId, type: "video", name: id, startTime, endTime, trimStart: 0, ...o });
const LAP_L: CompareDoc = { tracks: T2, timelineItems: [clip2("Intro", "v", 0, 5), clip2("Interview A", "v", 5, 11), clip2("B-roll pier", "v", 11, 17), clip2("Interview B", "v", 17, 26), clip2("Summer", "titles", 1, 4, { type: "text" }), clip2("Tone", "music", 0, 26, { type: "audio" })] };
const LAP_R: CompareDoc = { tracks: T2, timelineItems: [clip2("Intro", "v", 0, 4), clip2("Interview A", "v", 4, 10), clip2("Interview B", "v", 16, 25), clip2("Summer", "titles", 1, 4, { type: "text" }), clip2("Tone", "music", 0, 26, { type: "audio" })] };
// core's content shot diff of that edit: nothing matched
const BY_CONTENT: ShotDiff = { a: [{ start: 0, end: 26, sig: 1 }], b: [{ start: 0, end: 25, sig: 2 }], matches: [], aLabel: "a", bLabel: "b" };

test("clipShots: a side's story is the footage on its lowest picture track; titles, captions and sound don't cut it; a gap is a shot with no clip", () => {
  const s = clipShots(LAP_R);
  assert.deepEqual(s.map((x) => [x.start, x.end, x.item ?? null, x.label ?? null]), [[0, 4, "Intro", "Intro"], [4, 10, "Interview A", "Interview A"], [10, 16, null, null], [16, 25, "Interview B", "Interview B"]]);
  // B-roll over an interview on a track above: the interview is the story
  const over = clipShots({ tracks: [{ id: "top" }, { id: "v" }], timelineItems: [clip2("ia", "v", 0, 10), clip2("broll", "top", 3, 6)] });
  assert.deepEqual(over.map((x) => [x.start, x.end, x.item]), [[0, 10, "ia"]]);
  // Cardboard's own `order` says which track is lower, whatever the list's order (0 is the top)
  const ordered = clipShots({ tracks: [{ id: "v", order: 1 }, { id: "top", order: 0 }], timelineItems: [clip2("ia", "v", 0, 10), clip2("broll", "top", 3, 6)] });
  assert.deepEqual(ordered.map((x) => [x.start, x.end, x.item]), [[0, 10, "ia"]]);
  // a title alone (no footage under it) is a shot of its own
  const alone = clipShots({ tracks: [{ id: "t" }, { id: "v" }], timelineItems: [clip2("a", "v", 0, 4), clip2("card", "t", 4, 6, { type: "text" }), clip2("b", "v", 6, 9)] });
  assert.deepEqual(alone.map((x) => x.item), ["a", "card", "b"]);
});

test("Play both, in step by shot by clip identity (laptop P2-1): the trimmed intro is the same shot on both sides, the shorter waits", () => {
  const d = clipDiff(LAP_L, LAP_R);
  const s = playSchedule(d);
  assert.deepEqual(s.map((x) => [x.kind, x.a0, x.aLen, x.b0, x.bLen, x.aShot ?? null, x.bShot ?? null]), [
    ["same", 0, 5, 0, 4, "Intro", "Intro"],
    ["same", 5, 6, 4, 6, "Interview A", "Interview A"],
    // the pier, removed: its gap on the right is no shot there, so the right side shows a slate naming the pier
    ["change", 11, 6, 10, 0, "B-roll pier", null],
    ["same", 17, 9, 16, 9, "Interview B", "Interview B"],
  ]);
  let at = sidesAt(s, 4.5);
  assert.deepEqual([at.stretch?.kind, at.a.hold, at.b.hold], ["same", false, true], "the intro: in step, the right side waits its second");
  at = sidesAt(s, 12);
  assert.deepEqual([at.b.slate, at.b.missing, at.b.elsewhere ?? null], [true, "B-roll pier", null]);
  // by content (the old way), the intro was never in step
  assert.equal(playSchedule(BY_CONTENT)[0]!.kind, "change");
  // the right side's playhead inside the pier's gap starts the story in the pier's stretch
  assert.equal(storyAt(s, "b", 12), s[2]!.start + 2);
});

test("Play both: a clip moved past another and trimmed (laptop P2-1) is never “isn't in”: its slate says where it is", () => {
  const L: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("Shot A", "v", 0, 4), clip2("Shot B", "v", 4, 8), clip2("Shot C", "v", 8, 12)] };
  const R: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("Shot B", "v", 0, 4), clip2("Shot A", "v", 4, 7), clip2("Shot C", "v", 7, 11)] };
  const s = playSchedule(clipDiff(L, R));
  const slates = s.flatMap((x) => {
    const at = sidesAt(s, x.start + 0.1);
    return [at.a, at.b].filter((y) => y.slate).map((y) => [y.missing, y.elsewhere]);
  });
  assert.ok(slates.length >= 2, JSON.stringify(s));
  for (const [missing, where] of slates) assert.ok(where === "earlier" || where === "later", `the moved shot “${missing}” is on both sides: ${where}`);
  // only moved in time (its order kept) and trimmed: the same shot, no slate at all
  const R2: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("Shot A", "v", 1, 4), clip2("Shot B", "v", 6, 10), clip2("Shot C", "v", 10, 14)] };
  const s2 = playSchedule(clipDiff(L, R2));
  for (const x of s2) {
    const at = sidesAt(s2, x.start + 0.1);
    assert.ok(!at.a.slate && !at.b.slate, `no slate in step: ${JSON.stringify(x)}`);
  }
  assert.deepEqual(s2.map((x) => [x.kind, x.aShot, x.aLen, x.bLen]), [["same", "Shot A", 4, 3], ["same", "Shot B", 8, 8]]);
});

test("clipDiff: a split on one side plays as the whole clip; a clip deleted and added again (same footage) is matched by content", () => {
  const L: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("a", "v", 0, 6, { mediaItemId: "m1", trimStart: 2 }), clip2("b", "v", 6, 9, { mediaItemId: "m2" })] };
  // a split at 0:03 (a new clip carrying on a's footage), and b deleted and added again as b2
  const R: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("a", "v", 0, 3, { mediaItemId: "m1", trimStart: 2 }), clip2("a2", "v", 3, 6, { mediaItemId: "m1", trimStart: 5 }), clip2("b2", "v", 6, 9, { mediaItemId: "m2" })] };
  const d = clipDiff(L, R);
  assert.deepEqual(d.b.map((x) => [x.start, x.end, x.item]), [[0, 6, "a"], [6, 9, "b2"]]);
  assert.deepEqual(d.matches, [[0, 0], [1, 1]]);
});

test("compareMarks by clip identity (laptop P2-2): a removed clip that left a gap is a ghost where it was, never a seam at the stretch's start", () => {
  const changes: Change[] = [chg("B-roll pier", "remove", 11, 17, "Removed “B-roll pier”"), chg("Intro", "change", 0, 4, "Trimmed “Intro”")];
  // by the clips (what Compare goes by now): the ghost where the pier was, after the intro's second
  let pier = compareMarks(changes, LAP_L, LAP_R).find((m) => m.itemId === "B-roll pier")!;
  assert.deepEqual([pier.start, pier.end, pier.trackId], [10, 16, "v"]);
  // the jump goes to the same place (the list said 0:11 and seeked there; the mark was elsewhere)
  const d = clipDiff(LAP_L, LAP_R);
  assert.equal(removedAt(d, alignRows(d), 11), pier.start);
  // given core's content diff (one changed stretch from 0:00) it is still where it was, not a seam at 0:00
  pier = compareMarks(changes, LAP_L, LAP_R, BY_CONTENT).find((m) => m.itemId === "B-roll pier")!;
  assert.ok(pier.end - pier.start > 5, `a ghost, not a seam: ${pier.start}–${pier.end}`);
  assert.ok(pier.start > 9, `where it was, not the stretch's start: ${pier.start}`);
  // removed and the rest moved up: a seam at the join
  const ripple: CompareDoc = { tracks: T2, timelineItems: [clip2("Intro", "v", 0, 5), clip2("Interview A", "v", 5, 11), clip2("Interview B", "v", 11, 20)] };
  const seam = compareMarks([chg("B-roll pier", "remove", 11, 17, "Removed “B-roll pier”")], LAP_L, ripple).find((m) => m.itemId === "B-roll pier")!;
  assert.deepEqual([seam.start, seam.end], [11, 11]);
});

test("stripOf by clip identity (laptop P3-8): the left side's clips in the marks' colours, a gap neutral", () => {
  const L: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("Intro", "v", 0, 5), clip2("Pier", "v", 5, 8), clip2("Moved", "v", 10, 14), clip2("Same", "v", 14, 18)] };
  const R: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("Intro", "v", 0, 4), clip2("Moved", "v", 9, 13), clip2("Same", "v", 13, 17)] };
  const d = clipDiff(L, R);
  const bars = stripOf(d, alignRows(d), { changed: new Set(["Intro", "Moved"]), inRight: new Set(R.timelineItems.map((x) => x.id)) });
  assert.deepEqual(bars.map((b) => [b.label ?? null, b.kind]), [["Intro", "changed"], ["Pier", "removed"], [null, "gap"], ["Moved", "changed"], ["Same", "same"]]);
});

test("stillAt (paused): the left side's slate where it has no shot, and where a moved clip is", () => {
  const d = clipDiff(LAP_R, LAP_L);
  const rows = alignRows(d);
  // the left (now LAP_R) has a gap where the right shows the pier
  const at = stillAt(d, rows, 12);
  assert.deepEqual([at.kind, at.slate?.shot, at.slate?.elsewhere ?? null], ["change", "B-roll pier", null]);
  assert.equal(stillAt(d, rows, 7).kind, "same");
});


test("clipDiff (review of fix/ux2-laptop): a clip split twice on one side is one shot; a clip that survives elsewhere is never another's match by content", () => {
  const L: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("a", "v", 0, 9, { mediaItemId: "m1" })] };
  // a new shot before it, then the clip in three parts
  const R: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("n", "v", 0, 2, { mediaItemId: "m9" }), clip2("a", "v", 2, 5, { mediaItemId: "m1" }), clip2("a2", "v", 5, 8, { mediaItemId: "m1", trimStart: 3 }), clip2("a3", "v", 8, 11, { mediaItemId: "m1", trimStart: 6 })] };
  const d = clipDiff(L, R);
  assert.deepEqual(d.b.map((x) => [x.start, x.end, x.item]), [[0, 2, "n"], [2, 11, "a"]]);
  const s = playSchedule(d);
  assert.deepEqual(s.map((x) => [x.kind, x.aLen, x.bLen]), [["change", 0, 2], ["same", 9, 9]], "the new shot a slate on the left, then the whole clip in step");
  // X (left first) survives on the right, moved to the end; V on the right is the same footage, in-point and length
  const X: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("X", "v", 0, 3, { mediaItemId: "m1" }), clip2("U", "v", 3, 6, { mediaItemId: "m2" }), clip2("Y", "v", 6, 9, { mediaItemId: "m3" }), clip2("Z", "v", 9, 12, { mediaItemId: "m4" })] };
  const V: CompareDoc = { tracks: [{ id: "v" }], timelineItems: [clip2("V", "v", 0, 3, { mediaItemId: "m1" }), clip2("Y", "v", 3, 6, { mediaItemId: "m3" }), clip2("Z", "v", 6, 9, { mediaItemId: "m4" }), clip2("X", "v", 9, 12, { mediaItemId: "m1" })] };
  const e = clipDiff(X, V);
  const pairs = e.matches.map(([x, y]) => [e.a[x]!.item, e.b[y]!.item]);
  assert.ok(!pairs.some(([a, b]) => a === "X" && b === "V"), "X isn't V: " + JSON.stringify(pairs));
  assert.ok(pairs.every(([a, b]) => a === b), JSON.stringify(pairs));
});
