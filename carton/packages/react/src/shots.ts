// Watch the changes (§9): the shot diff laid out like a side-by-side text diff, and the math behind Play changes and
// the aligned A/B toggle. Pure functions over core's shots() and lcs() output, so they are tested without a DOM.

import type { DiffSummary, Shot, ShotDiff } from "./model.ts";

/** A run of matched shots (same content on both sides) or a hunk where the sides differ. Half-open index ranges. */
export type Row =
  | { readonly kind: "same"; readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number }
  | { readonly kind: "change"; readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number };

/**
 * Walk the matched pairs and emit alternating rows, exactly as a text diff interleaves context and hunks. Matched
 * pairs that are adjacent on both sides join one "same" row.
 */
export function alignRows(d: ShotDiff): Row[] {
  const rows: Row[] = [];
  let i = 0, j = 0;
  const push = (r: Row) => {
    const prev = rows[rows.length - 1];
    if (prev && prev.kind === "same" && r.kind === "same" && prev.a1 === r.a0 && prev.b1 === r.b0) {
      rows[rows.length - 1] = { kind: "same", a0: prev.a0, a1: r.a1, b0: prev.b0, b1: r.b1 };
    } else rows.push(r);
  };
  for (const [mi, mj] of d.matches) {
    if (mi < i || mj < j || mi >= d.a.length || mj >= d.b.length) throw new Error("alignRows: matches must be ascending and in range");
    if (mi > i || mj > j) push({ kind: "change", a0: i, a1: mi, b0: j, b1: mj });
    push({ kind: "same", a0: mi, a1: mi + 1, b0: mj, b1: mj + 1 });
    i = mi + 1;
    j = mj + 1;
  }
  if (i < d.a.length || j < d.b.length) push({ kind: "change", a0: i, a1: d.a.length, b0: j, b1: d.b.length });
  return rows;
}

const span = (s: readonly Shot[], x: number, y: number) => (x < y ? s[y - 1]!.end - s[x]!.start : 0);
const lengthOf = (s: readonly Shot[]) => (s.length ? s[s.length - 1]!.end - s[0]!.start : 0);

/** Where a side's range starts: its first shot, or the join point when the side has no shots in the range. */
function startAt(s: readonly Shot[], x: number): number {
  if (x < s.length) return s[x]!.start;
  return s.length ? s[s.length - 1]!.end : 0;
}

/**
 * "N shots / X s of Y s differ" (§9 Compare card). Per hunk, the side with more shots (or seconds) counts, so a
 * removal counts the removed shots, an addition the added ones, and a replacement is not counted twice. The total is
 * the longer edit; X never exceeds it.
 */
export function diffSummary(d: ShotDiff, rows = alignRows(d)): DiffSummary {
  let shots = 0, secs = 0;
  for (const r of rows) {
    if (r.kind !== "change") continue;
    shots += Math.max(r.a1 - r.a0, r.b1 - r.b0);
    secs += Math.max(span(d.a, r.a0, r.a1), span(d.b, r.b0, r.b1));
  }
  const total = Math.max(lengthOf(d.a), lengthOf(d.b));
  return { shots, seconds: Math.min(secs, total), total };
}

/** The time range a row covers on one side (a zero-length range at the join point when the side is empty). */
export function rowRange(d: ShotDiff, r: Row, side: "a" | "b"): [number, number] {
  const s = side === "a" ? d.a : d.b;
  const x = side === "a" ? r.a0 : r.b0, y = side === "a" ? r.a1 : r.b1;
  const t0 = startAt(s, x);
  return [t0, t0 + span(s, x, y)];
}

/**
 * Map a time on one side to the aligned time on the other, so the A/B toggle shows the same moment (§9). Inside a
 * matched run the offset is kept; inside a hunk the position is scaled across the hunk's two ranges, and a side with
 * nothing there maps to its join point.
 */
export function mapTime(d: ShotDiff, rows: readonly Row[], from: "a" | "b", t: number): number {
  const to = from === "a" ? "b" : "a";
  if (!rows.length) return t;
  let row = rows[rows.length - 1]!;
  for (const r of rows) {
    const [s, e] = rowRange(d, r, from);
    if (t < e || (t <= e && s === e)) {
      row = r;
      break;
    }
  }
  const [fs, fe] = rowRange(d, row, from);
  const [ts, te] = rowRange(d, row, to);
  if (row.kind === "same") {
    // Matched shots have equal durations, so a plain offset keeps the frame.
    return Math.min(te, Math.max(ts, ts + (t - fs)));
  }
  if (fe - fs <= 0) return ts;
  const k = Math.min(1, Math.max(0, (t - fs) / (fe - fs)));
  return ts + k * (te - ts);
}

/** A stretch Play changes plays, on one side, and the hunk (row index) it shows. */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly row: number;
}

/**
 * The segments Play changes plays on one side: each hunk with `context` seconds before and after, clipped to the
 * edit, and merged where they touch. A hunk with nothing on this side (a removal seen on the newer edit) still plays
 * the moment around its join, so the viewer sees the cut where something was taken out.
 */
export function playlist(d: ShotDiff, rows: readonly Row[], side: "a" | "b", context = 1): Segment[] {
  const s = side === "a" ? d.a : d.b;
  const end = s.length ? s[s.length - 1]!.end : 0;
  const begin = s.length ? s[0]!.start : 0;
  const out: Segment[] = [];
  rows.forEach((r, idx) => {
    if (r.kind !== "change") return;
    const [rs, re] = rowRange(d, r, side);
    const seg = { start: Math.max(begin, rs - context), end: Math.min(end, re + context), row: idx };
    if (seg.end <= seg.start) return;
    const prev = out[out.length - 1];
    if (prev && seg.start <= prev.end) out[out.length - 1] = { start: prev.start, end: Math.max(prev.end, seg.end), row: prev.row };
    else out.push(seg);
  });
  return out;
}

/** Index of the segment that holds `t`, else the next one after it, else -1. */
export function segmentAt(segs: readonly Segment[], t: number): number {
  for (let i = 0; i < segs.length; i++) if (t < segs[i]!.end) return i;
  return -1;
}

/** Collapse long "same" rows into a fold chip, keeping `keep` shots of context next to each hunk, like diff -U. */
export type Column =
  | { readonly kind: "same"; readonly a: number; readonly b: number }
  | { readonly kind: "change"; readonly row: number; readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number }
  /** `row` is the folded run's first shot on side a: pass it back in `expanded` to unfold the run. */
  | { readonly kind: "fold"; readonly row: number; readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number };

export function columns(rows: readonly Row[], keep = 1, expanded: ReadonlySet<number> = new Set()): Column[] {
  const out: Column[] = [];
  rows.forEach((r, idx) => {
    if (r.kind === "change") {
      out.push({ kind: "change", row: idx, a0: r.a0, a1: r.a1, b0: r.b0, b1: r.b1 });
      return;
    }
    const n = r.a1 - r.a0;
    const head = idx === 0 ? 0 : keep, tail = idx === rows.length - 1 ? 0 : keep;
    if (expanded.has(r.a0) || n <= head + tail + 1) {
      for (let k = 0; k < n; k++) out.push({ kind: "same", a: r.a0 + k, b: r.b0 + k });
      return;
    }
    for (let k = 0; k < head; k++) out.push({ kind: "same", a: r.a0 + k, b: r.b0 + k });
    out.push({ kind: "fold", row: r.a0, a0: r.a0 + head, a1: r.a1 - tail, b0: r.b0 + head, b1: r.b1 - tail });
    for (let k = n - tail; k < n; k++) out.push({ kind: "same", a: r.a0 + k, b: r.b0 + k });
  });
  return out;
}
