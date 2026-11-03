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
    if (c.kind === "remove" || (to != null && !b && a)) {
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
    // only on the right: the row says so, or the left timeline (when known) hasn't the clip
    let kind: MarkKind = c.kind === "add" || (from != null && !a) ? "added" : "changed";
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

/**
 * Play both (DESIGN-V2 §1.4), in step by shot: the story is the aligned rows one after another, each as long as its
 * longer side, so each shot starts on both sides together. A side whose shot is shorter holds its last frame
 * ("waiting") until the longer one ends; a side with no shot there shows a slate. `a0`/`b0`: where the row starts on
 * each side; `aLen`/`bLen`: how long it is there; `aShot`/`bShot`: its first shot's name, for the other side's slate.
 */
export interface PlayStretch {
  readonly start: number;
  readonly dur: number;
  readonly kind: "same" | "change";
  readonly a0: number;
  readonly aLen: number;
  readonly b0: number;
  readonly bLen: number;
  readonly aShot?: string;
  readonly bShot?: string;
}

/** The stretches Play both plays, in order (rows with nothing on either side left out). */
export function playSchedule(d: ShotDiff, rows: readonly Row[] = alignRows(d)): PlayStretch[] {
  const out: PlayStretch[] = [];
  let at = 0;
  for (const r of rows) {
    const [as, ae] = rowRange(d, r, "a"), [bs, be] = rowRange(d, r, "b");
    const aLen = Math.max(0, ae - as), bLen = Math.max(0, be - bs), dur = Math.max(aLen, bLen);
    if (dur <= EPS) continue;
    const aShot = r.a1 > r.a0 ? d.a[r.a0]!.label : undefined, bShot = r.b1 > r.b0 ? d.b[r.b0]!.label : undefined;
    out.push({ start: at, dur, kind: r.kind, a0: as, aLen, b0: bs, bLen, ...(aShot ? { aShot } : {}), ...(bShot ? { bShot } : {}) });
    at += dur;
  }
  return out;
}

/** How long Play both plays: the stretches end to end. */
export const playLength = (s: readonly PlayStretch[]): number => (s.length ? s[s.length - 1]!.start + s[s.length - 1]!.dur : 0);

const stretchAt = (s: readonly PlayStretch[], T: number): PlayStretch | null => {
  if (!s.length) return null;
  for (const x of s) if (T < x.start + x.dur) return x;
  return s[s.length - 1]!;
};

/** The story's time for a time on one side (where Play both starts from the playhead): its stretch, the same offset. */
export function storyAt(s: readonly PlayStretch[], side: "a" | "b", t: number): number {
  for (const x of s) {
    const s0 = side === "a" ? x.a0 : x.b0, len = side === "a" ? x.aLen : x.bLen;
    // exactly at a join where this side has no shot (a removed clip picked: the playhead at its join): that stretch,
    // so the other side's shot plays there (review of feat/ux2-n1b #1)
    if (len <= EPS && Math.abs(t - s0) <= EPS) return x.start;
    if (len > EPS && t < s0 + len) return x.start + Math.max(0, t - s0);
  }
  return playLength(s);
}

/** One side at a moment of Play both: its time, holding its last frame (waiting), or a slate (no shot there). */
export interface SideAt {
  readonly t: number;
  readonly hold: boolean;
  readonly slate: boolean;
  /** The shot the other side plays meanwhile (the slate's "“Drone shot” isn't in …"). */
  readonly missing?: string;
}

/** A frame before a shot's end: holding shows that shot's last frame, never the next one's first. */
export const HOLD_BACK = 1 / 30;

/** Both sides at story time `T`. */
export function sidesAt(s: readonly PlayStretch[], T: number): { a: SideAt; b: SideAt; stretch: PlayStretch | null } {
  const x = stretchAt(s, T);
  if (!x) return { a: { t: T, hold: false, slate: false }, b: { t: T, hold: false, slate: false }, stretch: null };
  const u = Math.max(0, Math.min(x.dur, T - x.start));
  const side = (s0: number, len: number, other?: string): SideAt => {
    if (len <= EPS) return { t: s0, hold: false, slate: true, ...(other ? { missing: other } : {}) };
    if (u < len) return { t: s0 + u, hold: false, slate: false };
    return { t: Math.max(s0, s0 + len - HOLD_BACK), hold: true, slate: false };
  };
  return { a: side(x.a0, x.aLen, x.bShot), b: side(x.b0, x.bLen, x.aShot), stretch: x };
}

/** Where a time is in the comparison: "same shot" inside a matched run, else "changed here". */
export function stepAt(d: ShotDiff, rows: readonly Row[], t: number): "same" | "change" {
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "b");
    if (t < e || (t <= e && s === e)) return r.kind;
  }
  return rows.length ? rows[rows.length - 1]!.kind : "same";
}
