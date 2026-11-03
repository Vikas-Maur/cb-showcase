// Compare in the editor (docs/carton-ux v2, N1): the pure parts, tested without a DOM.
// - followTime: Play both's clock for the other side, in step by shot (shots.ts alignment).
// - compareMarks: the timeline's marks (added, removed where it was, moved, trimmed, changed) from the change rows
//   (WS0's changeList, so the list and the timeline never disagree) and the two timelines.
// - stripOf: the thin strip of the other version over the timeline, its shots placed at their aligned times.
// The two ends are always "from" (side a of the shot diff, the other version) and "to" (side b, what the editor's stage
// and timeline show).

import type { Change, CompareMode, ShotDiff } from "./model.ts";
import { alignRows, rowRange, type Row } from "./shots.ts";

export const COMPARE_MODES: readonly CompareMode[] = ["side", "wipe", "flip"];

/**
 * The other side's time while Play both runs, for `t` on the side shown (b). Inside a run of matched shots the offset
 * is kept (same frame). Inside a changed stretch the other side plays on at 1× from the stretch's start and holds its
 * last frame there, so its video never runs faster or slower than real time (the engine would seek every frame); it
 * locks again at the next matched shot. Nothing on the other side there: its join point.
 */
export function followTime(d: ShotDiff, rows: readonly Row[], t: number): number {
  if (!rows.length) return t;
  let row = rows[rows.length - 1]!;
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "b");
    if (t < e || (t <= e && s === e)) {
      row = r;
      break;
    }
  }
  const [bs] = rowRange(d, row, "b");
  const [as, ae] = rowRange(d, row, "a");
  return Math.min(ae, Math.max(as, as + (t - bs)));
}

/** And back: the time on the side shown (b) for `t` on the other side (a), the same way. */
export function leadTime(d: ShotDiff, rows: readonly Row[], t: number): number {
  if (!rows.length) return t;
  let row = rows[rows.length - 1]!;
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "a");
    if (t < e || (t <= e && s === e)) {
      row = r;
      break;
    }
  }
  const [as] = rowRange(d, row, "a");
  const [bs, be] = rowRange(d, row, "b");
  return Math.min(be, Math.max(bs, bs + (t - as)));
}

/** The aligned row holding time `t` on one side (the last row past the end). */
function rowAt(d: ShotDiff, rows: readonly Row[], side: "a" | "b", t: number): Row | null {
  for (const r of rows) {
    const [s, e] = rowRange(d, r, side);
    if (t < e || (t <= e && s === e)) return r;
  }
  return rows.length ? rows[rows.length - 1]! : null;
}

/** A timeline item as Cardboard's document holds it (only what the marks read). */
export interface CompareItem {
  readonly id: string;
  readonly trackId?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly trimStart?: number;
  readonly trimEnd?: number;
  readonly type?: string;
}
export interface CompareDoc {
  readonly timelineItems: readonly CompareItem[];
  readonly tracks?: readonly { readonly id: string }[];
}

export type MarkKind = "added" | "removed" | "moved" | "trimmed" | "changed";

/** One mark on the timeline: where (seconds on the side shown, its track), what, and its row in the change list. */
export interface TimelineMark {
  /** The change row's key (several rows on one clip give one mark, the first's key). */
  readonly key: string;
  readonly itemId: string;
  readonly kind: MarkKind;
  /** The track it sits on in the timeline shown; none: the other version's strip (a removed clip whose track is gone). */
  readonly trackId?: string;
  readonly start: number;
  readonly end: number;
  /** A move: how far, in seconds (positive: later). */
  readonly delta?: number;
  /** The change row's sentence, for the mark's tooltip. */
  readonly text: string;
}

const EPS = 0.01;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * The marks for a comparison: one per clip a change row names, kind from the row (add, remove) or, for a change, from
 * the two timelines (moved when only its place changed, trimmed when its length or trims did, else changed). A removed
 * clip is a ghost where it was: its old place mapped onto the timeline shown through the shot alignment, on its old
 * track when that track is still there. A row naming no clip (the aspect ratio) has no mark; nor does a clip neither
 * timeline has (a row from a newer read). A removed clip whose stretch vanished (the rest moved up) maps to zero length:
 * the host draws a seam there.
 */
export function compareMarks(changes: readonly Change[], from: CompareDoc | null, to: CompareDoc | null, diff?: ShotDiff | null): TimelineMark[] {
  const A = new Map((from?.timelineItems ?? []).map((i) => [i.id, i]));
  const B = new Map((to?.timelineItems ?? []).map((i) => [i.id, i]));
  const tracksB = new Set((to?.tracks ?? []).map((t) => t.id));
  const rows = diff ? alignRows(diff) : null;
  const toB = (t: number) => (diff && rows ? leadTime(diff, rows, t) : t);
  const seen = new Set<string>();
  const out: TimelineMark[] = [];
  for (const c of changes) {
    const id = c.itemId;
    if (!id || seen.has(id)) continue;
    const a = A.get(id), b = B.get(id);
    if (c.kind === "remove" || (!b && a)) {
      const s = a ? a.startTime : c.at, e = a ? a.endTime : c.end;
      if (!num(s) || !num(e)) continue;
      seen.add(id);
      // where it was, on the right side's time: a ghost of its size where its shots still line up (a gap was left, or
      // it sat over a shot that stayed); a seam where its stretch of shots changed (the rest moved up, or something
      // else took its place), at that stretch's start on the right
      const hunk = diff && rows ? rowAt(diff, rows, "a", s) : null;
      const s2 = hunk && hunk.kind === "change" ? rowRange(diff!, hunk, "b")[0] : toB(s);
      const e2 = hunk && hunk.kind === "change" ? s2 : Math.max(s2, toB(e));
      const end = e2 - s2 > EPS ? e2 : s2;
      const track = a?.trackId && (tracksB.size === 0 || tracksB.has(a.trackId)) ? a.trackId : undefined;
      out.push({ key: c.key, itemId: id, kind: "removed", ...(track ? { trackId: track } : {}), start: s2, end, text: c.text });
      continue;
    }
    const s = b ? b.startTime : c.at, e = b ? b.endTime : c.end;
    if (!num(s) || !num(e)) continue;
    seen.add(id);
    let kind: MarkKind = c.kind === "add" || !a ? "added" : "changed";
    let delta: number | undefined;
    if (kind === "changed" && a && b) {
      const lenA = a.endTime - a.startTime, lenB = b.endTime - b.startTime;
      const trims = Math.abs((a.trimStart ?? 0) - (b.trimStart ?? 0)) > EPS || Math.abs((a.trimEnd ?? 0) - (b.trimEnd ?? 0)) > EPS;
      if (Math.abs(lenA - lenB) > EPS || trims) kind = "trimmed";
      else if (Math.abs(a.startTime - b.startTime) > EPS || (a.trackId ?? "") !== (b.trackId ?? "")) {
        kind = "moved";
        delta = Math.round((b.startTime - a.startTime) * 10) / 10;
      }
    }
    out.push({ key: c.key, itemId: id, kind, ...(b?.trackId ? { trackId: b.trackId } : {}), start: s, end: Math.max(s, e), ...(delta !== undefined && delta !== 0 ? { delta } : {}), text: c.text });
  }
  return out.sort((x, y) => x.start - y.start || x.key.localeCompare(y.key));
}

/** A bar of the left side's strip: one of its shots, on its own time; "change" where the right side differs there. */
export interface StripBar {
  readonly start: number;
  readonly end: number;
  readonly kind: "same" | "change";
  readonly label?: string;
}

/**
 * The left side's strip over the timeline (DESIGN-V2 §1.6): its shots on its own time, at the timeline's zoom, so two
 * edits of different lengths read at once; a shot the right side doesn't match is outlined red.
 */
export function stripOf(d: ShotDiff, rows: readonly Row[] = alignRows(d)): StripBar[] {
  const out: StripBar[] = [];
  for (const r of rows)
    for (let k = r.a0; k < r.a1; k++) {
      const s = d.a[k]!;
      out.push({ start: s.start, end: s.end, kind: r.kind, ...(s.label ? { label: s.label } : {}) });
    }
  return out;
}

/** Where a time is in the comparison: "same shot" inside a matched run, else "changed here". */
export function stepAt(d: ShotDiff, rows: readonly Row[], t: number): "same" | "change" {
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "b");
    if (t < e || (t <= e && s === e)) return r.kind;
  }
  return rows.length ? rows[rows.length - 1]!.kind : "same";
}
