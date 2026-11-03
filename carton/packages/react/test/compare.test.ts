// Compare in the editor (docs/carton-ux v2 DESIGN-V2 §1, N1): the pure parts. Play both's clock in step by shot, the
// timeline's marks from a diff (added, removed as a ghost or a seam, moved, trimmed, changed), the left side's strip,
// and the stage's modes by width.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMarks, followTime, leadTime, playLength, playSchedule, sidesAt, stepAt, storyAt, stripOf, HOLD_BACK } from "../src/compare.ts";
import { compareModeShown, compareModesFor } from "../src/components/CompareView.ts";
import { alignRows } from "../src/shots.ts";
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

test("stripOf: the left side's shots on its own time, red where the right differs", () => {
  const strip = stripOf(D);
  assert.deepEqual(strip.map((b) => [b.start, b.end, b.kind]), [[0, 6, "change"], [6, 12, "same"], [12, 15, "change"], [15, 24, "same"]]);
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
  assert.deepEqual([at.b.t, at.b.slate, at.b.missing], [4, true, "B-roll pier"], "the right side's slate: “B-roll pier” isn't in …");
  // and the mirror: a shot only the right side has
  const added: ShotDiff = { a: B2, b: A2, matches: [[0, 0], [1, 2]], aLabel: "a", bLabel: "b" };
  s = playSchedule(added);
  at = sidesAt(s, 5);
  assert.deepEqual([at.b.t, at.b.slate], [5, false]);
  assert.deepEqual([at.a.t, at.a.slate, at.a.missing], [4, true, "B-roll pier"], "the left side's slate");
});
