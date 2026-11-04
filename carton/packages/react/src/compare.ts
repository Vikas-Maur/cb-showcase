// Compare in the editor (docs/carton-ux v2, N1): the pure parts, tested without a DOM.
// - clipDiff: the two sides' shots matched clip by clip, by identity (DESIGN-V2 §1.4, §1.15), as a shot diff: what
//   Play both, the jumps, the marks and the strip are lined up on. A content shot diff (core's shots() + lcs()) is the
//   fallback where the timelines aren't known.
// - followTime: Play both's clock for the other side, in step by shot (shots.ts alignment).
// - compareMarks: the timeline's marks (added, removed where it was, moved, trimmed, changed) from the change rows
//   (WS0's changeList, so the list and the timeline never disagree) and the two timelines.
// - stripOf: the thin strip of the other version over the timeline, its shots placed at their aligned times.
// The two ends are always "from" (side a of the shot diff, the other version) and "to" (side b, what the editor's stage
// and timeline show).

import { lcs } from "@carton/core";
import type { Change, CompareMode, Shot, ShotDiff } from "./model.ts";
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

/** A timeline item as Cardboard's document holds it (only what Compare reads). */
export interface CompareItem {
  readonly id: string;
  readonly trackId?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly trimStart?: number;
  readonly trimEnd?: number;
  readonly type?: string;
  readonly name?: string;
  readonly textContent?: string;
  readonly captionText?: string;
  readonly mediaItemId?: string;
  readonly playbackSpeed?: number;
  readonly hidden?: boolean;
  readonly zIndex?: number;
}
export interface CompareDoc {
  readonly timelineItems: readonly CompareItem[];
  /** In the editor's order: the first is the top layer. */
  readonly tracks?: readonly { readonly id: string; readonly visible?: boolean; readonly order?: number }[];
  readonly media?: readonly { readonly id: string; readonly data?: { readonly fileName?: unknown; readonly content?: unknown } }[];
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
  /** A removed clip's name, from its row's sentence ("Removed “our new”"): its ghost shows it (design QA v2 G17). */
  readonly name?: string;
}

const EPS = 0.01;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const words = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 60) : undefined);

/** A clip's name, as the editor names it: its own name or text, else its media's file name (Cardboard's label). */
export function clipName(it: CompareItem, doc?: CompareDoc | null): string | undefined {
  const own = words(it.name) ?? words(it.textContent) ?? words(it.captionText);
  if (own) return own;
  const m = it.mediaItemId ? doc?.media?.find((x) => x.id === it.mediaItemId) : undefined;
  return words(m?.data?.fileName) ?? words(m?.data?.content);
}

// What makes a side's picture, for its spine: footage first (a clip, a still), then what else draws (a title, a code
// graphic); never sound, captions or adjustment layers, which sit over the story rather than make it
const FOOTAGE = new Set(["video", "image", ""]);
const DRAWN = new Set(["text", "code", "shader"]);

/**
 * One side's shots, clip by clip (DESIGN-V2 §1.4: "the comparison knows which clip is which"): at each moment the clip
 * the picture is built on (the footage on the lowest picture track; where there is none, the lowest title or graphic),
 * each run of one clip a shot, a stretch with nothing a gap (no `item`). Titles, B-roll over an interview and captions
 * don't cut it: the story is lined up on what is underneath.
 */
export function clipShots(doc: CompareDoc): Shot[] {
  // a track's place top to bottom: Cardboard's `order` (0 the top), else its place in the list
  const order = new Map((doc.tracks ?? []).map((t, i) => [t.id, typeof t.order === "number" && Number.isFinite(t.order) ? t.order : i]));
  const off = new Set((doc.tracks ?? []).filter((t) => t.visible === false).map((t) => t.id));
  const rank = (it: CompareItem) => (FOOTAGE.has(it.type ?? "") ? 2e6 : 0) + (order.get(it.trackId ?? "") ?? -1) * 1e3 - (it.zIndex ?? 0);
  const items = doc.timelineItems.filter((it) => num(it.startTime) && num(it.endTime) && it.endTime - it.startTime > EPS && !it.hidden && !off.has(it.trackId ?? "") && (FOOTAGE.has(it.type ?? "") || DRAWN.has(it.type ?? "")));
  const bounds = [...new Set([0, ...items.flatMap((it) => [it.startTime, it.endTime])])].sort((x, y) => x - y);
  const byStart = [...items].sort((x, y) => x.startTime - y.startTime);
  const out: Shot[] = [];
  const active = new Set<CompareItem>();
  let si = 0;
  for (let b = 0; b < bounds.length - 1; b++) {
    const t = bounds[b]!, t2 = bounds[b + 1]!;
    if (t2 - t <= 1e-6) continue;
    for (const it of [...active]) if (it.endTime <= t + 1e-6) active.delete(it);
    while (si < byStart.length && byStart[si]!.startTime <= t + 1e-6) {
      const it = byStart[si++]!;
      if (it.endTime > t + 1e-6) active.add(it);
    }
    let top: CompareItem | undefined;
    for (const it of active) if (!top || rank(it) > rank(top) || (rank(it) === rank(top) && it.startTime < top.startTime)) top = it;
    const last = out[out.length - 1];
    if (last && last.item === top?.id && Math.abs(last.end - t) <= 1e-6) {
      out[out.length - 1] = { ...last, end: t2 };
      continue;
    }
    const label = top ? clipName(top, doc) : undefined;
    out.push({ start: t, end: t2, sig: 0, ...(top ? { item: top.id } : {}), ...(label ? { label } : {}) });
  }
  // nothing after the last clip: no trailing gap
  while (out.length && !out[out.length - 1]!.item) out.pop();
  return out;
}

/**
 * The two sides lined up clip by clip, by identity (DESIGN-V2 §1.15): each side's shots (clipShots), matched in order
 * by the clip they are, so a clip trimmed, moved in time or changed is still the same shot on both sides (in step),
 * and a shot only one side has is one-sided (a slate on the other). A gap is matched as the gap after the same clip.
 * A clip split on one side only plays as one shot with the whole clip on the other: its second part (a new clip that
 * carries on the same footage where the first stops) joins the first. Where identity finds no match inside a changed
 * stretch, a clip of the same footage, in-point and length is the same shot (content as the fallback: a clip deleted
 * and added again). `sig` is the matched pair's number.
 */
export function clipDiff(from: CompareDoc, to: CompareDoc, labels: { aLabel?: string; bLabel?: string } = {}): ShotDiff {
  const idsA = new Set(from.timelineItems.map((x) => x.id)), idsB = new Set(to.timelineItems.map((x) => x.id));
  const byIdA = new Map(from.timelineItems.map((x) => [x.id, x])), byIdB = new Map(to.timelineItems.map((x) => [x.id, x]));
  // a split on this side only: a clip this side alone has that carries on the footage of the clip before it joins it
  const joinSplits = (shots: Shot[], byId: Map<string, CompareItem>, other: Set<string>): Shot[] => {
    const out: Shot[] = [];
    // the last part joined to each shot so far: a clip split twice carries on from its second part, not its first
    // (review of fix/ux2-laptop #1)
    let last: CompareItem | undefined;
    for (const s of shots) {
      const prev = out[out.length - 1];
      const b = s.item ? byId.get(s.item) : undefined;
      if (prev && last && b && !other.has(b.id) && Math.abs(prev.end - s.start) <= EPS && carriesOn(last, b)) {
        out[out.length - 1] = { ...prev, end: s.end };
        last = b;
        continue;
      }
      out.push(s);
      last = b;
    }
    return out;
  };
  const A = joinSplits(clipShots(from), byIdA, idsB), B = joinSplits(clipShots(to), byIdB, idsA);
  const key = (s: readonly Shot[], i: number) => s[i]!.item ?? `gap:${i ? (s[i - 1]!.item ?? "") : ""}`;
  const pairs = lcs(A.map((_, i) => key(A, i)), B.map((_, i) => key(B, i)));
  // the fallback: inside each changed stretch, the same footage, in-point and length, only for clips the other side
  // hasn't by identity (one that survives elsewhere there is that clip moved, never another's match: review #2)
  const content = (s: Shot, byId: Map<string, CompareItem>, other: Set<string>) => {
    const it = s.item ? byId.get(s.item) : undefined;
    return it?.mediaItemId && !other.has(it.id) ? `${it.mediaItemId}|${Math.round((it.trimStart ?? 0) * 20)}|${Math.round((s.end - s.start) * 20)}` : null;
  };
  const matches: [number, number][] = [];
  let i = 0, j = 0;
  for (const [mi, mj] of [...pairs, [A.length, B.length] as [number, number]]) {
    if (mi > i && mj > j) {
      const ka = A.slice(i, mi).map((s) => content(s, byIdA, idsB)), kb = B.slice(j, mj).map((s) => content(s, byIdB, idsA));
      for (const [x, y] of lcs(ka.map((k, n) => k ?? `a${n}`), kb.map((k, n) => k ?? `b${n}`))) matches.push([i + x, j + y]);
    }
    if (mi < A.length) matches.push([mi, mj]);
    i = mi + 1;
    j = mj + 1;
  }
  const sig = (s: Shot, n: number): Shot => ({ ...s, sig: n });
  const a = A.map((s, n) => sig(s, -1 - n)), b = B.map((s, n) => sig(s, -1 - A.length - n));
  matches.forEach(([x, y], n) => { a[x] = sig(a[x]!, n); b[y] = sig(b[y]!, n); });
  return { a, b, matches, aLabel: labels.aLabel ?? "", bLabel: labels.bLabel ?? "" };
}
/** `b` carries on `a`'s footage where `a` stops (the second part of a split): the same media, speed and source. */
function carriesOn(a: CompareItem, b: CompareItem): boolean {
  if (!a.mediaItemId || a.mediaItemId !== b.mediaItemId) return false;
  const sp = a.playbackSpeed ?? 1;
  if (Math.abs(sp - (b.playbackSpeed ?? 1)) > 1e-3) return false;
  return Math.abs((a.trimStart ?? 0) + (a.endTime - a.startTime) * sp - (b.trimStart ?? 0)) <= 0.05;
}

/**
 * Where a removed clip was, on the right side's time (DESIGN-V2 §1.6): its old start mapped through the alignment
 * (the identity's, clipDiff), so the list's jump and the timeline's mark agree. On the clip's own spine shot that is
 * where its stretch starts on the right: the gap it left, the join where the rest moved up, or what took its place.
 */
export function removedAt(d: ShotDiff | null | undefined, rows: readonly Row[] | null | undefined, t: number): number {
  return d && rows ? leadTime(d, rows, t) : t;
}

/**
 * The marks for a comparison: one per clip a change row names, kind from the row (add, remove) or, for a change, from
 * the two timelines (moved when only its place changed, trimmed when its length or trims did, else changed). A row
 * naming no clip (the aspect ratio) has no mark; nor does a clip neither timeline has (a row from a newer read).
 * A removed clip is placed where it was (removedAt), on its old track when that track is still there: a ghost of its
 * size where a gap was left (nothing on its track covers most of it), else a seam at that place (the rest moved up,
 * or something else took its place). `diff`: the alignment; by default the clips' own (clipDiff), when both timelines
 * are known.
 */
export function compareMarks(changes: readonly Change[], from: CompareDoc | null, to: CompareDoc | null, diff?: ShotDiff | null): TimelineMark[] {
  const A = new Map((from?.timelineItems ?? []).map((i) => [i.id, i]));
  const B = new Map((to?.timelineItems ?? []).map((i) => [i.id, i]));
  const tracksB = new Set((to?.tracks ?? []).map((t) => t.id));
  const d = diff ?? (from && to ? clipDiff(from, to) : null);
  const rows = d ? alignRows(d) : null;
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
      const s2 = removedAt(d, rows, s), len = Math.max(0, e - s);
      const track = a?.trackId && (tracksB.size === 0 || tracksB.has(a.trackId)) ? a.trackId : undefined;
      // a gap left (a ghost), unless what is on its track now covers most of where it would be (a seam)
      let covered = 0;
      if (track && to) for (const x of to.timelineItems) if (x.trackId === track && x.id !== id) covered += Math.max(0, Math.min(x.endTime, s2 + len) - Math.max(x.startTime, s2));
      const ghost = len > EPS && covered <= len / 2;
      const name = /“([^”]+)”/.exec(c.text)?.[1];
      out.push({ key: c.key, itemId: id, kind: "removed", ...(track ? { trackId: track } : {}), start: s2, end: ghost ? s2 + len : s2, text: c.text, ...(name ? { name } : {}) });
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

/**
 * A bar of the left side's strip: one of its shots, on its own time, in the timeline legend's words: the same clip
 * (`same`), one the right side has changed, trimmed or moved (`changed`, amber), one the right side hasn't
 * (`removed`, red), or a gap (`gap`, neutral).
 */
export interface StripBar {
  readonly start: number;
  readonly end: number;
  readonly kind: "same" | "changed" | "removed" | "gap";
  readonly label?: string;
}

/**
 * The left side's strip over the timeline (DESIGN-V2 §1.6): its shots on its own time, at the timeline's zoom, so two
 * edits of different lengths read at once. Each bar in the marks' colours: what happened to its clip on the right (a
 * change row names it: changed; the right side hasn't it: removed); a gap is neutral. `changed`: the clips the change
 * rows name; `inRight`: the clips the right side has (none given: a clip in a one-sided stretch counts as removed). A
 * content shot diff's stretches (no clips known) read as changed, never as all removed.
 */
export function stripOf(d: ShotDiff, rows: readonly Row[] = alignRows(d), o: { changed?: ReadonlySet<string>; inRight?: ReadonlySet<string> } = {}): StripBar[] {
  const out: StripBar[] = [];
  const known = d.a.some((s) => s.item !== undefined);
  for (const r of rows)
    for (let k = r.a0; k < r.a1; k++) {
      const s = d.a[k]!;
      let kind: StripBar["kind"];
      if (known && !s.item) kind = "gap";
      else if (!s.item) kind = r.kind === "same" ? "same" : "changed";
      else if (r.kind === "same") kind = o.changed?.has(s.item) ? "changed" : "same";
      else kind = o.inRight ? (o.inRight.has(s.item) ? "changed" : "removed") : "removed";
      out.push({ start: s.start, end: s.end, kind, ...(s.label ? { label: s.label } : {}) });
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
  /**
   * A clip moved past others (clipDiff): one side plays it here and the other has it elsewhere, earlier or later in
   * its own time. `aElsewhere`: where side a has the shot b plays here (its slate says so instead of "isn't in").
   */
  readonly aElsewhere?: "earlier" | "later";
  readonly bElsewhere?: "earlier" | "later";
  /** A side with only a gap here (no shot: its slate): how long the gap is on its own time. */
  readonly aGap?: number;
  readonly bGap?: number;
}

/**
 * The stretches Play both plays, in order (rows with nothing on either side left out). On clips matched by identity
 * (clipDiff), a side whose part of a changed stretch is only a gap has no shot there: a slate, as for a removed clip.
 */
export function playSchedule(d: ShotDiff, rows: readonly Row[] = alignRows(d)): PlayStretch[] {
  const out: PlayStretch[] = [];
  const clips = d.a.some((s) => s.item !== undefined) || d.b.some((s) => s.item !== undefined);
  const first = (list: readonly Shot[], x: number, y: number) => {
    for (let k = x; k < y; k++) if (list[k]!.label) return list[k]!.label;
    return undefined;
  };
  const firstItem = (list: readonly Shot[], x: number, y: number) => {
    for (let k = x; k < y; k++) if (list[k]!.item) return list[k]!.item;
    return undefined;
  };
  const empty = (list: readonly Shot[], x: number, y: number) => clips && firstItem(list, x, y) === undefined;
  const where = (list: readonly Shot[], item: string | undefined, at: number): "earlier" | "later" | undefined => {
    if (!item) return undefined;
    const s = list.find((x) => x.item === item);
    return s ? (s.start < at ? "earlier" : "later") : undefined;
  };
  let at = 0;
  for (const r of rows) {
    const [as, ae] = rowRange(d, r, "a"), [bs, be] = rowRange(d, r, "b");
    const aLen = r.kind === "change" && empty(d.a, r.a0, r.a1) ? 0 : Math.max(0, ae - as);
    const bLen = r.kind === "change" && empty(d.b, r.b0, r.b1) ? 0 : Math.max(0, be - bs);
    const dur = Math.max(aLen, bLen);
    if (dur <= EPS) continue;
    const aShot = aLen > 0 ? first(d.a, r.a0, r.a1) : undefined, bShot = bLen > 0 ? first(d.b, r.b0, r.b1) : undefined;
    const aElsewhere = aLen > 0 ? undefined : where(d.a, firstItem(d.b, r.b0, r.b1), as);
    const bElsewhere = bLen > 0 ? undefined : where(d.b, firstItem(d.a, r.a0, r.a1), bs);
    const aGap = aLen === 0 && ae - as > EPS ? ae - as : 0, bGap = bLen === 0 && be - bs > EPS ? be - bs : 0;
    out.push({ start: at, dur, kind: r.kind, a0: as, aLen, b0: bs, bLen, ...(aShot ? { aShot } : {}), ...(bShot ? { bShot } : {}), ...(aElsewhere ? { aElsewhere } : {}), ...(bElsewhere ? { bElsewhere } : {}), ...(aGap ? { aGap } : {}), ...(bGap ? { bGap } : {}) });
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
    // exactly at a join where this side has no shot (a removed clip picked: the playhead at its join), or inside a gap
    // the other side's shot plays over: that stretch, so the other side's shot plays there (review of feat/ux2-n1b #1)
    const gap = side === "a" ? x.aGap : x.bGap;
    if (len <= EPS && t >= s0 - EPS && t <= s0 + (gap ?? 0) + EPS) return x.start + Math.min(x.dur, Math.max(0, t - s0));
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
  /** That shot is on this side too, moved: earlier or later here (the slate's "“Drone shot” is later in …"). */
  readonly elsewhere?: "earlier" | "later";
}

/** A frame before a shot's end: holding shows that shot's last frame, never the next one's first. */
export const HOLD_BACK = 1 / 30;

/** Both sides at story time `T`. */
export function sidesAt(s: readonly PlayStretch[], T: number): { a: SideAt; b: SideAt; stretch: PlayStretch | null } {
  const x = stretchAt(s, T);
  if (!x) return { a: { t: T, hold: false, slate: false }, b: { t: T, hold: false, slate: false }, stretch: null };
  const u = Math.max(0, Math.min(x.dur, T - x.start));
  const side = (s0: number, len: number, other?: string, elsewhere?: "earlier" | "later"): SideAt => {
    if (len <= EPS) return { t: s0, hold: false, slate: true, ...(other ? { missing: other } : {}), ...(elsewhere ? { elsewhere } : {}) };
    if (u < len) return { t: s0 + u, hold: false, slate: false };
    return { t: Math.max(s0, s0 + len - HOLD_BACK), hold: true, slate: false };
  };
  return { a: side(x.a0, x.aLen, x.bShot, x.aElsewhere), b: side(x.b0, x.bLen, x.aShot, x.bElsewhere), stretch: x };
}

/** Where a time is in the comparison: "same shot" inside a matched run, else "changed here". */
export function stepAt(d: ShotDiff, rows: readonly Row[], t: number): "same" | "change" {
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "b");
    if (t < e || (t <= e && s === e)) return r.kind;
  }
  return rows.length ? rows[rows.length - 1]!.kind : "same";
}

/**
 * Paused (Play both not running): the left side for the right side's time `t`. `kind`: "same" inside a matched run;
 * `slate`: the left side has no shot there (none at all, or only a gap, on clips matched by identity), with the shot
 * the right side shows and, when the left has that clip elsewhere (moved), where; `aEnd`: where the left side's part of
 * the stretch ends (a shorter left shot waits there).
 */
export function stillAt(d: ShotDiff, rows: readonly Row[], t: number): { kind: "same" | "change"; aEnd: number; slate?: { shot?: string; elsewhere?: "earlier" | "later" } } {
  let row: Row | undefined;
  for (const r of rows) {
    const [s, e] = rowRange(d, r, "b");
    if (t < e || (t <= e && s === e)) { row = r; break; }
  }
  row ??= rows[rows.length - 1];
  if (!row) return { kind: "same", aEnd: t };
  const [as, ae] = rowRange(d, row, "a");
  if (row.kind === "same") return { kind: "same", aEnd: ae };
  const clips = d.a.some((s) => s.item !== undefined) || d.b.some((s) => s.item !== undefined);
  let none = row.a1 === row.a0;
  if (!none && clips) {
    none = true;
    for (let k = row.a0; k < row.a1; k++) if (d.a[k]!.item) none = false;
  }
  if (!none) return { kind: "change", aEnd: ae };
  let shot: Shot | undefined;
  for (let k = row.b0; k < row.b1; k++) if (d.b[k]!.item || !clips) { shot = d.b[k]; break; }
  const there = shot?.item ? d.a.find((s) => s.item === shot!.item) : undefined;
  return { kind: "change", aEnd: ae, slate: { ...(shot?.label ? { shot: shot.label } : {}), ...(there ? { elsewhere: there.start < as ? "earlier" as const : "later" as const } : {}) } };
}
