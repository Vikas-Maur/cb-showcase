// Anchors (PLAN §9: "comment anchors use state hashes plus shot alignment, and are marked 'may be outdated' where the
// shot changed"). An anchor keeps the version a comment was made on, the timeline range, the items under it with the
// source-media time each showed there, and the range's shot signature. Placing it on a later version needs only that
// version's document:
// - its items are followed (through splits by the lineage between the two versions, else by id, else by media) to the
//   piece that still shows the anchored source time, which gives the new place;
// - the range's shot signature at the new place is compared with the anchored one. The signature is the shot diff's
//   own (core `shots()`): visible layers by the host's stacking rank, each by its attributes minus the host's ignored
//   and edge fields, its speed, the source time it shows, and the edge windows (fades, transitions) inside the range;
//   never the output position. Equal: the comment is exact (same place) or moved. Different: "may be outdated".
// Nothing here rebuilds the old version, so a comment made on a version this replica doesn't hold (a teammate's
// unshared cut, a state below a joiner's keyframe) is placed all the same.

import { byPos, canonical, sha256Hex, type Doc, type Lineage, type Rec, type Schema, type ShotWindow } from "@carton/core";
import { LIMITS, type Anchor, type AnchorItem } from "./types.ts";

const EPS = 1e-6;
/** Times in signatures are quantized like the shot diff's (0.1 ms). */
const q = (x: number) => Math.round(x * 1e4);

/** Host details the shot rules don't carry. */
export interface AnchorOptions {
  /** The item field naming its media (Cardboard: `mediaItemId`), kept with each anchored item. */
  media?: string;
}

/** One item of a timeline as an anchor sees it. */
interface Layer {
  id: string;
  it: Rec;
  s: number;
  e: number;
  rank: number;
  speed: number;
  src: number;
  visible: boolean;
  attr: string;
}

const ATTR = new WeakMap<Rec, { key: string; str: string }>();
const WIN = new WeakMap<Rec, ShotWindow[]>();

/**
 * One version's timeline, indexed for anchors: items by id, visible items by start with each block's latest end (so
 * "what is under [s, e]" skips blocks that end before s). Built once per version; cheap on the next version because an
 * item's attribute string is cached on its record object, and History shares unchanged records between versions.
 */
export class TimelineIndex {
  readonly byId = new Map<string, Layer>();
  readonly byMedia = new Map<string, Layer[]>();
  readonly #sorted: Layer[] = [];
  readonly #blockEnd: number[] = [];
  readonly #schema: Schema;
  /** The output's end (the latest item end), seconds. */
  readonly duration: number;
  static readonly BLOCK = 32;

  constructor(doc: Doc, schema: Schema, opts: AnchorOptions = {}) {
    this.#schema = schema;
    const tl = schema.timeline;
    let dur = 0;
    if (tl) {
      const sh = tl.shots ?? {};
      const key = schema.collections[tl.collection]?.key ?? "id";
      const laneKey = schema.collections[tl.lanes]?.key ?? "id";
      // lanes as the shot diff sees them: in sequence order, each with its place as `order` (core's shots())
      const lanes = new Map<unknown, Rec>();
      const laneList = [...((doc[tl.lanes] as Rec[] | undefined) ?? [])].sort(byPos(laneKey));
      laneList.forEach((l, i) => lanes.set(l[laneKey], { ...l, order: i }));
      // Placement fields and the item's own id never count as content: a moved or split clip shows the same picture.
      const ignore = new Set([...(sh.ignore ?? []), ...(sh.edgeFields ?? []), key, tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed, tl.lane]);
      const ignoreKey = [...ignore].sort().join(",");
      for (const it of (doc[tl.collection] as Rec[] | undefined) ?? []) {
        const s = it[tl.start] as number,
          e = it[tl.end] as number;
        if (typeof s !== "number" || typeof e !== "number" || !(e - s > EPS)) continue;
        const lane = lanes.get(it[tl.lane]);
        let a = ATTR.get(it);
        if (!a || a.key !== ignoreKey) {
          let str = "";
          for (const k of Object.keys(it).sort()) if (!ignore.has(k) && it[k] !== undefined) str += JSON.stringify(k) + ":" + canonical(it[k]) + ",";
          ATTR.set(it, (a = { key: ignoreKey, str }));
        }
        const l: Layer = {
          id: String(it[key]),
          it,
          s,
          e,
          rank: sh.rank ? sh.rank(it, lane) : 0,
          speed: typeof it[tl.speed] === "number" && (it[tl.speed] as number) > 0 ? (it[tl.speed] as number) : 1,
          src: typeof it[tl.source] === "number" ? (it[tl.source] as number) : 0,
          visible: sh.visible ? sh.visible(it, lane) : true,
          attr: a.str,
        };
        this.byId.set(l.id, l);
        if (opts.media) {
          const m = it[opts.media];
          if (typeof m === "string") {
            const list = this.byMedia.get(m);
            if (list) list.push(l);
            else this.byMedia.set(m, [l]);
          }
        }
        if (l.visible) this.#sorted.push(l);
        if (e > dur) dur = e;
      }
    }
    this.duration = dur;
    this.#sorted.sort((x, y) => x.s - y.s);
    const B = TimelineIndex.BLOCK;
    for (let i = 0; i < this.#sorted.length; i += B) {
      let m = -Infinity;
      for (let j = i; j < Math.min(i + B, this.#sorted.length); j++) m = Math.max(m, this.#sorted[j]!.e);
      this.#blockEnd.push(m);
    }
  }

  /** Visible items under `[s, e]` (a moment when `s === e`: the items showing at `s`). */
  under(s: number, e: number): Layer[] {
    const L = this.#sorted;
    // first item starting at or after the range's end (or after the moment): nothing from there on overlaps
    const lim = e > s ? e - EPS : s + EPS;
    let lo = 0,
      hi = L.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (L[m]!.s < lim) lo = m + 1;
      else hi = m;
    }
    const out: Layer[] = [];
    const B = TimelineIndex.BLOCK;
    for (let b = 0; b * B < lo; b++) {
      if (this.#blockEnd[b]! <= s + EPS) continue;
      for (let j = b * B; j < Math.min(lo, (b + 1) * B); j++) if (L[j]!.e > s + EPS) out.push(L[j]!);
    }
    return out;
  }

  /** Edge windows of an item (fades, transitions) in item-local time, cached per record. */
  windows(l: Layer): ShotWindow[] {
    const f = this.#schema.timeline?.shots?.windows;
    if (!f) return [];
    let w = WIN.get(l.it);
    if (!w) WIN.set(l.it, (w = f(l.it, l.e - l.s).filter((x) => x.b > x.a)));
    return w;
  }

  /**
   * The shot signature of `[s, e]`: what the range looks and sounds like, not where it sits (16 hex). Pieces of a split
   * clip that continue each other read as one layer, as in the shot diff.
   */
  sig(s: number, e: number): string {
    const layers = this.under(s, e).sort((x, y) => x.rank - y.rank || (x.attr < y.attr ? -1 : x.attr > y.attr ? 1 : 0) || x.s - y.s);
    const parts: { attr: string; rank: number; speed: number; src: number; lo: number; hi: number; win: string }[] = [];
    for (const l of layers) {
      const lo = Math.max(s, l.s),
        hi = e > s ? Math.min(e, l.e) : s;
      const src = l.src + (lo - l.s) * l.speed;
      let win = "";
      const a = lo - l.s,
        b = hi - l.s;
      for (const w of this.windows(l)) if (b > a ? w.a < b - EPS && w.b > a + EPS : w.a <= a + EPS && w.b > a + EPS) win += `w${w.sig ?? ""}:${q(w.a - a)}:${q(w.b - a)};`;
      const prev = parts[parts.length - 1];
      // a split's next piece: same layer content, the time and the source both continue
      if (prev && !win && !prev.win && prev.rank === l.rank && prev.attr === l.attr && prev.speed === l.speed && Math.abs(prev.hi - lo) < 1e-4 && Math.abs(prev.src + (prev.hi - prev.lo) * prev.speed - src) < 1e-4) {
        prev.hi = hi;
        continue;
      }
      parts.push({ attr: l.attr, rank: l.rank, speed: l.speed, src, lo, hi, win });
    }
    let str = `${q(e - s)}#`;
    for (const p of parts) str += `${p.rank}|${p.attr}|${q(p.speed)}|${q(p.src)}|${q(p.lo - s)}|${q(p.hi - s)}|${p.win}\n`;
    return sha256Hex(str).slice(0, 16);
  }

  /** The piece of item `l` showing source time `at`, as a timeline time, or null when `at` isn't on it. */
  timeOf(l: Layer, at: number): number | null {
    const t = l.s + (at - l.src) / l.speed;
    return t >= l.s - 1e-4 && t <= l.e + 1e-4 ? Math.min(Math.max(t, l.s), l.e) : null;
  }
}

/** The version an anchor is made on. */
export interface AnchorAt {
  cut: string;
  seq: number;
  /** Its full state hash. */
  hash: string;
}

/**
 * An anchor for a comment made on version `at` (its document `doc`), on `range` (seconds; a moment when start equals
 * end; absent: the whole version). `index` is `at`'s TimelineIndex when the caller already has one.
 */
export function makeAnchor(doc: Doc, schema: Schema, at: AnchorAt, range?: readonly [number, number], opts: AnchorOptions & { index?: TimelineIndex } = {}): Anchor {
  const anchor: Anchor = { cut: at.cut, seq: at.seq, state: at.hash };
  if (!range) return anchor;
  let [s, e] = range;
  if (!(Number.isFinite(s) && Number.isFinite(e))) throw new RangeError("an anchor's range is two finite times");
  if (e < s) [s, e] = [e, s];
  s = Math.max(0, s);
  e = Math.max(s, e);
  const ix = opts.index ?? new TimelineIndex(doc, schema, opts);
  anchor.range = [s, e];
  // top first: the layer people see is what they comment on; lower layers are fallbacks for following
  const under = ix.under(s, e).sort((x, y) => y.rank - x.rank || x.s - y.s);
  const items: AnchorItem[] = [];
  for (const l of under.slice(0, LIMITS.anchorItems)) {
    const p = Math.max(s, l.s);
    const item: AnchorItem = { id: l.id, at: l.src + (p - l.s) * l.speed };
    if (p > s) item.dt = p - s;
    const m = opts.media ? l.it[opts.media] : undefined;
    if (typeof m === "string" && m.length <= LIMITS.name) item.media = m;
    items.push(item);
  }
  if (items.length) anchor.items = items;
  anchor.sig = ix.sig(s, e);
  return anchor;
}

/** How a comment sits on a later version. */
export type PlacementStatus = "exact" | "moved" | "outdated" | "removed" | "general";

export interface Placement {
  /**
   * - `exact`: same place, and it shows what the comment was made on;
   * - `moved`: it shows the same thing somewhere else (a ripple, a moved or split clip);
   * - `outdated`: "may be outdated": the picture or sound there changed since, or the moment was trimmed away;
   * - `removed`: every clip it was on is gone;
   * - `general`: a comment on the whole version, not on a place.
   */
  status: PlacementStatus;
  /** Where it is now (seconds); for `removed`, where it was; null for `general`. */
  range: [number, number] | null;
  /** The items it sits on now, top first (split pieces included). */
  items: string[];
  /** For `outdated`: what changed. */
  why?: "changed" | "trimmed";
}

/** A target version for `place`: its document's index, and its state hash (equal to the anchor's: exact at once). */
export interface PlaceTarget {
  index: TimelineIndex;
  hash?: string;
}

/**
 * Place an anchor on a later version. `lineage` is the split lineage from the anchor's version to the target (each id
 * to the ids it became, `@carton/core` `composeLineage` of the changes between them); null when unknown, which only
 * loses splits whose first piece doesn't keep the id.
 */
export function place(anchor: Anchor, target: PlaceTarget, lineage?: Lineage | null): Placement {
  if (!anchor.range) return { status: "general", range: null, items: [] };
  const [s, e] = anchor.range;
  const len = e - s;
  if (target.hash !== undefined && target.hash === anchor.state) return { status: "exact", range: [s, e], items: (anchor.items ?? []).map((i) => i.id) };
  const ix = target.index;
  let start: number | null = null;
  let trimmed: number | null = null;
  const followed: string[] = [];
  for (const ai of anchor.items ?? []) {
    const ids = lineage?.[ai.id] ?? [ai.id];
    for (const id of ids) {
      const l = ix.byId.get(id);
      if (!l) continue;
      followed.push(id);
      const t = ix.timeOf(l, ai.at);
      if (t !== null && start === null) start = t - (ai.dt ?? 0);
      else if (t === null && trimmed === null) trimmed = ai.at < l.src ? l.s : l.e;
    }
    if (start === null && ai.media) {
      // not on it by id or lineage (a split without lineage, a fold or an import that carried none, a re-import):
      // the same media showing the same source time, nearest the old place. The signature below still decides
      // whether it shows the same thing.
      let best: number | null = null;
      for (const l of ix.byMedia.get(ai.media) ?? []) {
        const t = ix.timeOf(l, ai.at);
        if (t !== null && (best === null || Math.abs(t - (ai.dt ?? 0) - s) < Math.abs(best - s))) best = t - (ai.dt ?? 0);
      }
      if (best !== null) start = best;
    }
    if (start !== null) break;
  }
  const items = [...new Set(followed)];
  if (start === null) {
    if (trimmed !== null) {
      const at = Math.max(0, trimmed);
      return { status: "outdated", range: [at, at + len], items, why: "trimmed" };
    }
    if (anchor.items?.length) return { status: "removed", range: [s, e], items: [] };
    start = s; // an empty spot: it stays where it was
  }
  start = Math.max(0, start);
  const range: [number, number] = [start, start + len];
  const now = ix.under(range[0], range[1]);
  const on = now.sort((x, y) => y.rank - x.rank || x.s - y.s).map((l) => l.id);
  if (anchor.sig !== undefined && ix.sig(range[0], range[1]) === anchor.sig) return { status: Math.abs(start - s) < 1e-4 ? "exact" : "moved", range, items: on };
  return { status: "outdated", range, items: on, why: "changed" };
}
