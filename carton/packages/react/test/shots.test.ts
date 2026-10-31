import { test } from "node:test";
import assert from "node:assert/strict";
import { alignRows, columns, diffSummary, mapTime, playlist, rowRange, segmentAt } from "../src/shots.ts";
import { makeShotDiff } from "../src/mock.ts";
import type { Shot, ShotDiff } from "../src/model.ts";

const shots = (...lens: [number, number][]): Shot[] => {
  let t = 0;
  return lens.map(([sig, d]) => {
    const s = { start: t, end: t + d, sig };
    t += d;
    return s;
  });
};

// A: 1 2 3 4 5   B: 1 2' 3 4 6 7 (2 changed, 5 replaced by 6+7)
const A = shots([1, 2], [2, 3], [3, 1], [4, 2], [5, 2]);
const B = shots([1, 2], [22, 2], [3, 1], [4, 2], [6, 1], [7, 1.5]);
const D: ShotDiff = { a: A, b: B, matches: [[0, 0], [2, 2], [3, 3]], aLabel: "Before", bLabel: "After" };

test("alignRows interleaves matched runs and hunks like a text diff", () => {
  assert.deepEqual(alignRows(D), [
    { kind: "same", a0: 0, a1: 1, b0: 0, b1: 1 },
    { kind: "change", a0: 1, a1: 2, b0: 1, b1: 2 },
    { kind: "same", a0: 2, a1: 4, b0: 2, b1: 4 },
    { kind: "change", a0: 4, a1: 5, b0: 4, b1: 6 },
  ]);
});

test("alignRows handles removals, additions and identical edits", () => {
  const same: ShotDiff = { a: A, b: A, matches: A.map((_, i) => [i, i] as const), aLabel: "", bLabel: "" };
  assert.deepEqual(alignRows(same), [{ kind: "same", a0: 0, a1: 5, b0: 0, b1: 5 }]);
  const removed: ShotDiff = { a: A, b: [], matches: [], aLabel: "", bLabel: "" };
  assert.deepEqual(alignRows(removed), [{ kind: "change", a0: 0, a1: 5, b0: 0, b1: 0 }]);
  assert.throws(() => alignRows({ ...D, matches: [[2, 2], [0, 0]] }), /ascending/);
});

test("diffSummary counts each hunk once, by its larger side, and never exceeds the total", () => {
  const s = diffSummary(D);
  // hunk 1: 1 shot vs 1 shot, 3 s vs 2 s -> 1 shot, 3 s; hunk 2: 1 shot (2 s) vs 2 shots (2.5 s) -> 2 shots, 2.5 s
  assert.equal(s.shots, 3);
  assert.equal(s.seconds, 5.5);
  assert.equal(s.total, 10);
  assert.deepEqual(diffSummary({ a: A, b: A, matches: A.map((_, i) => [i, i] as const), aLabel: "", bLabel: "" }), { shots: 0, seconds: 0, total: 10 });
});

test("mapTime keeps the frame inside matched shots and scales across a hunk", () => {
  const rows = alignRows(D);
  // In shot 3 (A 5..6, B 4..5): offset kept.
  assert.equal(mapTime(D, rows, "a", 5.5), 4.5);
  assert.equal(mapTime(D, rows, "b", 4.5), 5.5);
  // Hunk 1: A [2,5) vs B [2,4): halfway maps to halfway.
  assert.equal(mapTime(D, rows, "a", 3.5), 3);
  // Last hunk: A [8,10) vs B [7,9.5)
  assert.equal(mapTime(D, rows, "b", 9.5), 10);
});

test("mapTime sends a removed range to the join point on the other side", () => {
  const a = shots([1, 2], [2, 3], [3, 2]);
  const b = shots([1, 2], [3, 2]);
  const d: ShotDiff = { a, b, matches: [[0, 0], [2, 1]], aLabel: "", bLabel: "" };
  const rows = alignRows(d);
  assert.equal(mapTime(d, rows, "a", 3.5), 2);
  assert.deepEqual(rowRange(d, rows[1]!, "b"), [2, 2]);
});

test("playlist plays each change with context, merges overlaps and plays removals at the join", () => {
  const rows = alignRows(D);
  assert.deepEqual(playlist(D, rows, "b", 1), [
    { start: 1, end: 5, row: 1 },
    { start: 6, end: 9.5, row: 3 },
  ]);
  const a = shots([1, 2], [2, 3], [3, 2]);
  const b = shots([1, 2], [3, 2]);
  const d: ShotDiff = { a, b, matches: [[0, 0], [2, 1]], aLabel: "", bLabel: "" };
  assert.deepEqual(playlist(d, alignRows(d), "b", 1), [{ start: 1, end: 3, row: 1 }]);
  assert.deepEqual(playlist(d, alignRows(d), "a", 1), [{ start: 1, end: 6, row: 1 }]);
  assert.equal(segmentAt([{ start: 1, end: 3, row: 1 }, { start: 5, end: 6, row: 3 }], 4), 1);
  assert.equal(segmentAt([{ start: 1, end: 3, row: 1 }], 9), -1);
});

test("columns folds long unchanged runs and keeps one shot of context next to each change", () => {
  const d = makeShotDiff(26);
  const rows = alignRows(d);
  const cols = columns(rows, 1);
  assert.ok(cols.some((c) => c.kind === "fold"));
  for (let i = 0; i < cols.length; i++) {
    if (cols[i]!.kind !== "change") continue;
    if (i > 0) assert.notEqual(cols[i - 1]!.kind, "fold", "context before a change");
    if (i < cols.length - 1) assert.notEqual(cols[i + 1]!.kind, "fold", "context after a change");
  }
  const fold = cols.find((c) => c.kind === "fold")!;
  assert.equal(fold.kind, "fold");
  const open = columns(rows, 1, new Set([fold.kind === "fold" ? fold.row : -1]));
  assert.equal(open.filter((c) => c.kind === "fold").length, cols.filter((c) => c.kind === "fold").length - 1);
});

test("the mock shot diff has a trim, a removal, an insertion and a replacement", () => {
  const d = makeShotDiff(26);
  const rows = alignRows(d);
  const changes = rows.filter((r) => r.kind === "change");
  assert.equal(changes.length, 4);
  assert.ok(changes.some((r) => r.a1 - r.a0 === 1 && r.b1 === r.b0), "a removal");
  assert.ok(changes.some((r) => r.a1 === r.a0 && r.b1 - r.b0 === 2), "an insertion of two shots");
});
