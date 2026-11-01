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

/** One item of a timeline as an anchor sees it. Immutable, and the same object in every version that shares the record. */
interface Layer {
  readonly id: string;
  readonly it: Rec;
  readonly s: number;
  readonly e: number;
  readonly rank: number;
  readonly speed: number;
  readonly src: number;
  readonly visible: boolean;
  readonly media: string | undefined;
  /** The lane record and its place it was made with (a lane hidden, muted or reordered makes new layers). */
  readonly lane: Rec | undefined;
  readonly order: number;
}

/**
 * Layers by record object, per schema and media field: History hands out the same record object for every version that
 * didn't change it, so the next version's index reuses all but the changed records' layers, and "what changed"
 * between two versions' indexes is an identity check per item (`changedSince`).
 */
const LAYERS = new WeakMap<Schema, Map<string, WeakMap<Rec, Layer>>>();
/** An item's attributes as content (16 hex), by record object, per ignore set. */
const ATTR = new WeakMap<Rec, { key: string; hash: string }>();
const WIN = new WeakMap<Rec, ShotWindow[]>();

/** What changed between two versions' indexes: items added, removed or changed, where they were and are, their media. */
export interface IndexChanges {
  ids: Set<string>;
  spans: [number, number][];
  media: Set<string>;
  /** More than half the items changed: compare everything again. */
  most: boolean;
}

/**
 * One version's timeline, indexed for anchors: items by id and by media, visible items by start with each block's latest
 * end (so "what is under [s, e]" skips blocks that end before s). Built once per version, and cheap on the next one:
 * unchanged records keep their layers, and nothing reads a record's content until a signature needs it.
 */
export class TimelineIndex {
  readonly byId = new Map<string, Layer>();
  #byMedia: Map<string, Layer[]> | null = null;
  readonly #sorted: Layer[] = [];
  readonly #blockEnd: number[] = [];
  readonly #schema: Schema;
  readonly #ignore: Set<string>;
  readonly #ignoreKey: string;
  /** The output's end (the latest item end), seconds. */
  readonly duration: number;
  static readonly BLOCK = 32;

  constructor(doc: Doc, schema: Schema, opts: AnchorOptions = {}) {
    this.#schema = schema;
    const tl = schema.timeline;
    let dur = 0;
    this.#ignore = new Set();
    this.#ignoreKey = "";
    if (tl) {
      const sh = tl.shots ?? {};
      const key = schema.collections[tl.collection]?.key ?? "id";
      const laneKey = schema.collections[tl.lanes]?.key ?? "id";
      // Placement fields and the item's own id never count as content: a moved or split clip shows the same picture.
      this.#ignore = new Set([...(sh.ignore ?? []), ...(sh.edgeFields ?? []), key, tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed, tl.lane]);
      this.#ignoreKey = [...this.#ignore].sort().join(",");
      // lanes as the shot diff sees them: in sequence order, each with its place as `order` (core's shots())
      const lanes = new Map<unknown, { rec: Rec; view: Rec; order: number }>();
      const laneList = [...((doc[tl.lanes] as Rec[] | undefined) ?? [])].sort(byPos(laneKey));
      laneList.forEach((l, i) => lanes.set(l[laneKey], { rec: l, view: { ...l, order: i }, order: i }));
      let bySchema = LAYERS.get(schema);
      if (!bySchema) LAYERS.set(schema, (bySchema = new Map()));
      const mediaField = opts.media ?? "";
      let cache = bySchema.get(mediaField);
      if (!cache) bySchema.set(mediaField, (cache = new WeakMap()));
      for (const it of (doc[tl.collection] as Rec[] | undefined) ?? []) {
        const lane = lanes.get(it[tl.lane]);
        let l = cache.get(it);
        if (!l || l.lane !== lane?.rec || l.order !== (lane?.order ?? -1)) {
          const s = it[tl.start] as number,
            e = it[tl.end] as number;
          if (typeof s !== "number" || typeof e !== "number" || !(e - s > EPS)) continue;
          const m = opts.media ? it[opts.media] : undefined;
          l = {
            id: String(it[key]),
            it,
            s,
            e,
            rank: sh.rank ? sh.rank(it, lane?.view) : 0,
            speed: typeof it[tl.speed] === "number" && (it[tl.speed] as number) > 0 ? (it[tl.speed] as number) : 1,
            src: typeof it[tl.source] === "number" ? (it[tl.source] as number) : 0,
            visible: sh.visible ? sh.visible(it, lane?.view) : true,
            media: typeof m === "string" ? m : undefined,
            lane: lane?.rec,
            order: lane?.order ?? -1,
          };
          cache.set(it, l);
        }
        this.byId.set(l.id, l);
        if (l.visible) this.#sorted.push(l);
        if (l.e > dur) dur = l.e;
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

  /** Items by media, made on first use (only a clip that nothing else finds is looked for by its media). */
  get byMedia(): ReadonlyMap<string, readonly Layer[]> {
    if (this.#byMedia) return this.#byMedia;
    const m = new Map<string, Layer[]>();
    for (const l of this.byId.values()) {
      if (l.media === undefined) continue;
      const list = m.get(l.media);
      if (list) list.push(l);
      else m.set(l.media, [l]);
    }
    return (this.#byMedia = m);
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

  /** What changed from `prev` to this version (an identity check per item: unchanged records share their layers). */
  changedSince(prev: TimelineIndex): IndexChanges {
    const out: IndexChanges = { ids: new Set(), spans: [], media: new Set(), most: false };
    const note = (l: Layer) => {
      out.ids.add(l.id);
      out.spans.push([l.s, l.e]);
      if (l.media !== undefined) out.media.add(l.media);
    };
    for (const [id, l] of this.byId) {
      const p = prev.byId.get(id);
      if (p === l) continue;
      note(l);
      if (p) note(p);
    }
    for (const [id, p] of prev.byId) if (!this.byId.has(id)) note(p);
    out.most = out.ids.size * 2 > Math.max(this.byId.size, prev.byId.size);
    return out;
  }

  /** An item's attributes as content, hashed (16 hex), cached on its record. */
  #attr(l: Layer): string {
    let a = ATTR.get(l.it);
    if (!a || a.key !== this.#ignoreKey) {
      let str = "";
      for (const k of Object.keys(l.it).sort()) if (!this.#ignore.has(k) && l.it[k] !== undefined) str += JSON.stringify(k) + ":" + canonical(l.it[k]) + ",";
      ATTR.set(l.it, (a = { key: this.#ignoreKey, hash: sha256Hex(str).slice(0, 16) }));
    }
    return a.hash;
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
   * clip that continue each other read as one layer, as in the shot diff. `layers`: `under(s, e)` when already known.
   */
  sig(s: number, e: number, layers: Layer[] = this.under(s, e)): string {
    const sorted = layers.map((l) => ({ l, attr: this.#attr(l) })).sort((x, y) => x.l.rank - y.l.rank || (x.attr < y.attr ? -1 : x.attr > y.attr ? 1 : 0) || x.l.s - y.l.s);
    const parts: { attr: string; rank: number; speed: number; src: number; lo: number; hi: number; win: string }[] = [];
    for (const { l, attr } of sorted) {
      const lo = Math.max(s, l.s),
        hi = e > s ? Math.min(e, l.e) : s;
      const src = l.src + (lo - l.s) * l.speed;
      let win = "";
      const a = lo - l.s,
        b = hi - l.s;
      for (const w of this.windows(l)) if (b > a ? w.a < b - EPS && w.b > a + EPS : w.a <= a + EPS && w.b > a + EPS) win += `w${w.sig ?? ""}:${q(w.a - a)}:${q(w.b - a)};`;
      const prev = parts[parts.length - 1];
      // a split's next piece: same layer content, the time and the source both continue
      if (prev && !win && !prev.win && prev.rank === l.rank && prev.attr === attr && prev.speed === l.speed && Math.abs(prev.hi - lo) < 1e-4 && Math.abs(prev.src + (prev.hi - prev.lo) * prev.speed - src) < 1e-4) {
        prev.hi = hi;
        continue;
      }
      parts.push({ attr, rank: l.rank, speed: l.speed, src, lo, hi, win });
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
    if (l.media !== undefined && l.media.length <= LIMITS.name) item.media = l.media;
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
      const at = Math.max(0, Math.round(trimmed * 1e6) / 1e6);
      return { status: "outdated", range: [at, Math.round((at + len) * 1e6) / 1e6], items, why: "trimmed" };
    }
    if (anchor.items?.length) return { status: "removed", range: [s, e], items: [] };
    start = s; // an empty spot: it stays where it was
  }
  // the same place within 0.1 ms is the same place (float error from following a clip): keep the anchored times
  start = Math.abs(start - s) < 1e-4 ? s : Math.max(0, Math.round(start * 1e6) / 1e6);
  const range: [number, number] = start === s ? [s, e] : [start, Math.round((start + len) * 1e6) / 1e6];
  const now = ix.under(range[0], range[1]);
  const on = [...now].sort((x, y) => y.rank - x.rank || x.s - y.s).map((l) => l.id);
  if (anchor.sig !== undefined && ix.sig(range[0], range[1], now) === anchor.sig) return { status: start === s ? "exact" : "moved", range, items: on };
  return { status: "outdated", range, items: on, why: "changed" };
}
