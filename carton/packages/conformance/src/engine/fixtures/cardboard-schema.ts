// Cardboard 1.4.0's versioned slice {name, description, aspectRatio, tracks[], timelineItems[], media[]} described for
// the engine (PLAN §4.2), exactly as the core-v5 prototype was verified with it (`proofs/core-v5/cardboard-schema.mjs`).
// A pinned fixture: the real adapter is `@carton/cardboard`; this copy keeps the engine suite independent of it.
// Source: research/code.md §2 (Track `N`, Item `$` in chunk-JYYOZEPY, GUI whitelist `fm`, timeline.d.ts). Undeclared
// item fields are atomic leaves.
//
// Engine docs differ from project.json in two ways, both handled by the projection below:
// - tracks and keyed arrays carry a "#pos" key; track `order` is materialized from it (B12);
// - local-only fields (Cardboard's own list, chunk-JYYOZEPY.mjs:203: annotations, autoReframeSegmentationStatus,
//   borderDrawProgress) and non-versioned media fields are not versioned.

import { defineSchema, object, keyed, atomic, text, ephemeral, blobRef, timeAlgebra, assignKeys, stripEphemeral, deepEqual, getIn, POS } from "@carton/core";
import type { Doc, FieldSpec, OwnFn, Rec, Schema, ShotWindow, SoftWarning, TimelineConfig } from "@carton/core";

/** A project.json-shaped document or record: loose JSON the projection and the tests poke at. */
export type HostDoc = Record<string, any>;
type Item = Record<string, any>;

const AUDIO = new Set(["audio"]);
const grade = object({
  wheels: object(), // lift/gamma/gain/offset, each a small object, merged per key
  curves: object(), // per-channel point lists are leaves (arrays)
  lut: object(),
});
const TL = {
  collection: "timelineItems",
  lanes: "tracks",
  lane: "trackId",
  start: "startTime",
  end: "endTime",
  source: "trimStart",
  sourceEnd: "trimEnd",
  speed: "playbackSpeed",
} satisfies TimelineConfig;
export const TYPES = new Set(["video", "audio", "image", "text", "code", "adjustment", "caption", "shader"]);
const LOCAL_ONLY = ["annotations", "autoReframeSegmentationStatus", "borderDrawProgress"];

// Hard validators: the host's schema invariants (chunk-JYYOZEPY.mjs:183-203: times finite, starts non-negative,
// endTime > startTime, trimEnd > trimStart, a known type; and the item's track exists).
export function hard(coll: string, rec: Rec, doc: Doc): string[] {
  const out: string[] = [];
  const r = rec as Item;
  if (coll === "timelineItems") {
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    for (const f of ["startTime", "endTime", "trimStart", "trimEnd"]) if (!num(r[f])) out.push(`${f} must be a number`);
    if (num(r.startTime) && r.startTime < 0) out.push("startTime must be >= 0");
    if (num(r.trimStart) && r.trimStart < 0) out.push("trimStart must be >= 0");
    if (!(r.endTime > r.startTime)) out.push("endTime must be greater than startTime");
    if (!(r.trimEnd > r.trimStart)) out.push("trimEnd must be greater than trimStart");
    if (r.type !== undefined && !TYPES.has(r.type)) out.push(`unknown type ${r.type}`);
    if (typeof r.trackId !== "string" || !((doc.tracks as Item[] | undefined) ?? []).some((t) => t.id === r.trackId)) out.push("trackId must exist");
  }
  return out;
}

// Soft validators: warnings only. Overlaps on one track that neither side had (only items whose placement changed can
// create one: one pass over their tracks), and missing media. A pair overlaps newly only if both items' placements come
// from merge sides (both in `placed`), or one item's placement was composed or mapped by the merge (`fresh`: then its
// whole lane is scanned).
export function soft(doc: Doc, touched: ReadonlyMap<string, ReadonlySet<string>>, sides: readonly Doc[], placed: ReadonlySet<string> = new Set(), fresh: ReadonlySet<string> = new Set()): SoftWarning[] {
  const out: SoftWarning[] = [];
  const get = (d: Doc, id: string) => getIn(d, ["timelineItems", id], cardboard) as Item | undefined;
  if (placed.size) {
    const cands = [...placed].map((id) => get(doc, id)).filter((x): x is Item => !!x);
    const freshLanes = new Set(cands.filter((c) => fresh.has(c.id)).map((c) => c.trackId));
    const byLane = new Map<string, Item[]>();
    const add = (x: Item) => (byLane.get(x.trackId) ?? byLane.set(x.trackId, []).get(x.trackId)!).push(x);
    if (freshLanes.size) for (const x of (doc.timelineItems as Item[] | undefined) ?? []) if (freshLanes.has(x.trackId)) add(x);
    for (const x of cands) if (!freshLanes.has(x.trackId)) add(x);
    const ov = (a: Item | undefined, b: Item | undefined) => !!a && !!b && a.trackId === b.trackId && a.startTime < b.endTime - 1e-6 && b.startTime < a.endTime - 1e-6;
    const seen = new Set<string>();
    for (const it of cands)
      for (const x of byLane.get(it.trackId)!)
        if (x.id !== it.id && ov(it, x)) {
          const key = it.id < x.id ? it.id + "|" + x.id : x.id + "|" + it.id;
          if (seen.has(key) || sides.some((s) => ov(get(s, it.id), get(s, x.id)))) continue;
          seen.add(key);
          out.push({ kind: "overlap", items: key.split("|") });
        }
  }
  const ids = touched.get("timelineItems");
  if (ids && doc.media) {
    const media = new Set((doc.media as Item[]).map((m) => m.id));
    for (const id of ids) {
      const it = get(doc, id);
      if (it?.mediaItemId && !media.has(it.mediaItemId)) out.push({ kind: "missing media", item: id });
    }
  }
  return out;
}

const itemFields: Record<string, FieldSpec> = {
  transform: object(),
  crop: object(),
  colorGrading: object(),
  colorGrade: grade,
  transitionIn: object(),
  transitionOut: object(),
  textAnimation: object(),
  audioFadeIn: object(),
  audioFadeOut: object(),
  codeComposition: object({ assets: object() }),
  shaderComposition: object({ params: object(), controls: atomic, region: object(), defaults: object() }),
  backgroundRemoval: object(),
  subjectOcclusion: object(),
  voiceSettings: object(),
  captionComposition: object(),
  effects: keyed("id"),
  keyframeTracks: keyed("property", { keyframes: atomic }),
  captionSegments: keyed("id", { wordTimings: blobRef }),
  captionWordTimings: blobRef,
  segmentationData: blobRef, // analysis output, regenerated whole
  layoutSlots: blobRef,
  wordTimings: blobRef,
  alternatives: atomic,
};
for (const f of LOCAL_ONLY) itemFields[f] = ephemeral;

export const cardboard: Schema = defineSchema({
  root: {}, // name, description, aspectRatio: scalars (the default)
  collections: {
    tracks: {
      key: "id",
      seq: true, // ordered by "#pos"; `order` is materialized (B12)
      fields: { captionGenerationSettings: object({ excludeTrackIds: atomic, excludeMediaIds: atomic }), order: ephemeral },
    },
    timelineItems: {
      key: "id",
      parent: { field: "trackId", collection: "tracks" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }],
      fields: itemFields,
    },
    media: {
      key: "id",
      only: true, // the versioned subset: data.code.source (text), data.content, data.fileName, data.type, contentHash
      fields: { contentHash: { kind: "leaf" }, data: object({ code: object({ source: text }, { only: true }), content: { kind: "leaf" }, fileName: { kind: "leaf" }, type: { kind: "leaf" } }, { only: true }) },
    },
  },
  hard,
  soft,
  timeline: {
    ...TL,
    shots: {
      // fields that do not change what is seen or heard
      ignore: ["id", "trackId", "startTime", "endTime", "trimStart", "trimEnd", "name", "pending", "generationKey", "generationError", "alternatives"],
      visible: (it: Item, tr: Item | undefined) => !!tr && !it.hidden && (AUDIO.has(it.type) ? !tr.muted && !it.muted && !it.audioDisabled : tr.visible !== false),
      rank: (it: Item, tr: Item | undefined) => (tr?.order ?? 0) * 1e4 + (it.zIndex ?? 0),
      // Edge effects only matter inside their window, so they are not part of the item's identity.
      edgeFields: ["transitionIn", "transitionOut", "audioFadeIn", "audioFadeOut", "textAnimation"],
      windows: (it: Item, dur: number): ShotWindow[] => {
        if (it.captionSegments?.length || it.captionWordTimings?.length) return [{ a: 0, b: dur, from: "start", sig: "caption" }];
        const ins = [it.transitionIn?.duration, it.audioFadeIn?.duration, it.textAnimation ? (it.textAnimation.duration ?? 1) : 0].filter((x) => x > 0);
        const kf: number[] = ((it.keyframeTracks as Item[] | undefined) ?? []).flatMap((k) => ((k.keyframes as Item[] | undefined) ?? []).map((f) => f.time));
        const out: ShotWindow[] = [];
        if (ins.length || kf.length) out.push({ a: Math.min(0, ...kf), b: Math.max(0, ...ins, ...kf), from: "start", sig: JSON.stringify([it.transitionIn, it.audioFadeIn, it.textAnimation]) });
        const end = Math.max(0, it.transitionOut?.duration ?? 0, it.audioFadeOut?.duration ?? 0);
        if (end > 0) out.push({ a: dur - end, b: dur, from: "end", sig: JSON.stringify([it.transitionOut, it.audioFadeOut]) });
        return out;
      },
    },
  },
  label: (coll: string, rec: Rec | undefined) => {
    const r = rec as Item | undefined;
    return !r ? "?" : coll === "tracks" ? (r.name ?? r.id) : (r.name ?? r.textContent ?? r.captionText?.slice(0, 30) ?? `${r.type} ${String(r.id).slice(0, 6)}`);
  },
});

// ------------------------------------------------------------------ projection: host <-> engine

const SEQ_FIELDS = [
  ["effects", "id"],
  ["keyframeTracks", "property"],
  ["captionSegments", "id"],
] as const;
const orderOf = (tracks: Item[]) => [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((t) => t.id as string);
const byPos = (key: string) => (x: Item, y: Item) => (x[POS] < y[POS] ? -1 : x[POS] > y[POS] ? 1 : x[key] < y[key] ? -1 : 1);

/**
 * project.json-shaped doc -> engine doc. `base` (engine doc or null) supplies existing keys; host order (track `order`,
 * array order) is turned into keys by LCS move recovery. own(seqKey, id): the committing author created that element (M4).
 */
export function fromHost(host: HostDoc, base: Doc | null = null, own: OwnFn = () => false): Doc {
  const S = cardboard;
  const out: Item = { ...host };
  delete out.order;
  const baseTracks = (base?.tracks as Item[] | undefined) ?? [];
  const hostTracks = (host.tracks as Item[] | undefined) ?? [];
  const bt = new Map(baseTracks.map((t) => [t.id, t]));
  const tk = assignKeys(
    baseTracks.filter((t) => hostTracks.some((h) => h.id === t.id)),
    orderOf(hostTracks),
    "id",
    (id) => own("tracks", id),
  ).keys;
  out.tracks = hostTracks.map((t) => {
    const { order, ...rest } = t;
    const r = { ...stripEphemeral(rest, S.collections.tracks!.record), [POS]: tk.get(t.id) };
    const b = bt.get(t.id);
    return b && deepEqual(b, r) ? b : r;
  });
  const bi = new Map(((base?.timelineItems as Item[] | undefined) ?? []).map((i) => [i.id, i]));
  out.timelineItems = ((host.timelineItems as Item[] | undefined) ?? []).map((it) => {
    let r: Item = stripEphemeral(it, S.collections.timelineItems!.record);
    const b = bi.get(it.id);
    for (const [f, key] of SEQ_FIELDS) {
      if (!Array.isArray(r[f])) continue;
      const list = r[f] as Item[];
      const old = ((b?.[f] as Item[] | undefined) ?? []).filter((e) => list.some((x) => x[key] === e[key]));
      const ks = assignKeys(
        old,
        list.map((e) => e[key]),
        key,
        (id) => own(`${it.id}/${f}`, id),
      ).keys;
      const oldBy = new Map(((b?.[f] as Item[] | undefined) ?? []).map((e) => [e[key], e]));
      r = {
        ...r,
        [f]: list
          .map((e) => {
            const x = { ...e, [POS]: ks.get(e[key]) };
            const o = oldBy.get(e[key]);
            return o && deepEqual(o, x) ? o : x;
          })
          .sort(byPos(key)),
      };
    }
    return b && deepEqual(b, r) ? b : r;
  });
  if (host.media) {
    const bm = new Map(((base?.media as Item[] | undefined) ?? []).map((m) => [m.id, m]));
    out.media = (host.media as Item[]).map((m) => {
      const r = stripEphemeral(m, S.collections.media!.record);
      const b = bm.get(m.id);
      return b && deepEqual(b, r) ? b : r;
    });
  }
  return out;
}

/** Engine doc -> project.json shape: track order materialized 0..n-1, "#pos" stripped. */
export function toHost(doc: Doc): HostDoc {
  const strip = (e: Item) => {
    const { [POS]: _, ...r } = e;
    return r;
  };
  const tracks = [...((doc.tracks as Item[] | undefined) ?? [])].sort(byPos("id"));
  return {
    ...doc,
    tracks: tracks.map((t, i) => ({ ...strip(t), order: i })),
    timelineItems: ((doc.timelineItems as Item[] | undefined) ?? []).map((it) => {
      let r = it;
      for (const [f] of SEQ_FIELDS) if (Array.isArray(it[f])) r = { ...r, [f]: (it[f] as Item[]).map(strip) };
      return r;
    }),
  };
}

/**
 * A GUI save through the renderer's lossy projection P (B10, §4.3): only fields P writes are compared, and a value equal
 * to P(base value) is not a change. P(item) -> the item as the GUI would save it.
 */
export function projectGuiSave(base: Doc, saveHost: HostDoc, P: (item: Item) => Item): Doc {
  const baseHost = toHost(base);
  const baseItems = baseHost.timelineItems as Item[];
  const pBase = new Map(baseItems.map((i) => [i.id, P(i)]));
  const bItems = new Map(baseItems.map((i) => [i.id, i]));
  const items = (saveHost.timelineItems as Item[]).map((it) => {
    const b = bItems.get(it.id),
      pb = pBase.get(it.id);
    if (!b || !pb) return it;
    const out: Item = { ...b };
    for (const k of new Set([...Object.keys(pb), ...Object.keys(it)])) {
      if (deepEqual(it[k], pb[k])) continue; // equal to P(base): not a change
      if (it[k] === undefined) delete out[k];
      else out[k] = it[k];
    }
    return out;
  });
  return fromHost({ ...saveHost, timelineItems: items }, base);
}

/** Give a plain doc (tracks with or without `order`, arrays in order) engine keys, as a first import would. */
export const withKeys = (host: HostDoc): Doc => fromHost(host, null);
export const itemOf = (doc: Doc, id: string): Item | undefined => getIn(doc, ["timelineItems", id], cardboard) as Item | undefined;
