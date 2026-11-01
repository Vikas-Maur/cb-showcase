// Cardboard 1.4.0's versioned slice {name, description, aspectRatio, tracks[], timelineItems[], media[]} described for
// the engine (PLAN §4.2). Port of the verified core-v5 `cardboard-schema.mjs`. Sources in 1.4.0: Track `N` and Item `$`
// in chunk-JYYOZEPY (the zod schemas behind `cb verify` and the cloud document), the GUI whitelist `fm`, and
// `timeline.d.ts`. Undeclared item fields are atomic leaves, so fields a newer Cardboard adds pass through.
//
// Engine docs differ from project.json in two ways, both handled by `./host.ts`:
// - tracks and keyed arrays carry a `#pos` key; track `order` is materialized from it (B12);
// - local-only fields (Cardboard's own list in `$`: annotations, autoReframeSegmentationStatus, borderDrawProgress)
//   and the media fields outside the versioned subset are not versioned.
import { defineSchema, object, keyed, atomic, scalar, text, ephemeral, blobRef, timeAlgebra, getIn } from "@carton/core";
import type { Doc, Rec, Schema, SoftWarning, FieldSpec, TimelineConfig } from "@carton/core";

export const ITEMS = "timelineItems";
export const TRACKS = "tracks";
export const MEDIA = "media";

/** The clip time group (R3-05): merged as one unit by the §4.1 edit algebra. */
export const TIME_FIELDS = ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"] as const;

const TL: TimelineConfig = {
  collection: ITEMS,
  lanes: TRACKS,
  lane: "trackId",
  start: "startTime",
  end: "endTime",
  source: "trimStart",
  sourceEnd: "trimEnd",
  speed: "playbackSpeed",
};

/** `$.type` in 1.4.0. */
export const ITEM_TYPES: ReadonlySet<string> = new Set(["video", "audio", "image", "text", "code", "adjustment", "caption", "shader"]);
/** `N.type` in 1.4.0 (absent means video). */
export const TRACK_TYPES: ReadonlySet<string> = new Set(["video", "audio", "caption", "layout", "adjustment"]);
/** `D` in 1.4.0: the aspect ratios the project accepts. */
export const ASPECT_RATIOS: ReadonlySet<string> = new Set(["16:9", "4:3", "3:4", "9:16", "1:1", "4:5"]);
/** Item fields 1.4.0 rejects as "local-only state" (`$` superRefine): never versioned. */
export const LOCAL_ONLY = ["annotations", "autoReframeSegmentationStatus", "borderDrawProgress"] as const;

const AUDIO = new Set(["audio"]);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Hard validators: the host's schema invariants (chunk-JYYOZEPY `$` and the document refine `V`): times finite, starts
 * non-negative, endTime > startTime, trimEnd > trimStart, a known type, and the item's track exists. A failure blocks
 * with a card in a merge and is rejected by the sequencer.
 */
export function hard(coll: string, r: Rec, doc: Doc): string[] {
  const out: string[] = [];
  if (coll === ITEMS) {
    for (const f of ["startTime", "endTime", "trimStart", "trimEnd"]) if (!num(r[f])) out.push(`${f} must be a number`);
    if (num(r.startTime) && r.startTime < 0) out.push("startTime must be >= 0");
    if (num(r.trimStart) && r.trimStart < 0) out.push("trimStart must be >= 0");
    if (!((r.endTime as number) > (r.startTime as number))) out.push("endTime must be greater than startTime");
    if (!((r.trimEnd as number) > (r.trimStart as number))) out.push("trimEnd must be greater than trimStart");
    if (r.type !== undefined && !ITEM_TYPES.has(r.type as string)) out.push(`unknown type ${String(r.type)}`);
    const tracks = (doc[TRACKS] ?? []) as Rec[];
    if (typeof r.trackId !== "string" || !tracks.some((t) => t.id === r.trackId)) out.push("trackId must exist");
  }
  return out;
}

/**
 * Soft validators: warnings only (§4.1). Overlaps on one track that neither side had (only items whose placement
 * changed can create one), and missing media. A pair overlaps newly only if both items' placements come from merge
 * sides (both in `placed`), or one item's placement was composed or mapped by the merge (`fresh`: then its whole lane
 * is scanned).
 */
export function soft(doc: Doc, touched: ReadonlyMap<string, ReadonlySet<string>>, sides: readonly Doc[], placed: ReadonlySet<string> = new Set(), fresh: ReadonlySet<string> = new Set()): SoftWarning[] {
  const out: SoftWarning[] = [];
  const get = (d: Doc, id: string) => getIn(d, [ITEMS, id], cardboardSchema) as Rec | undefined;
  if (placed.size) {
    const cands = [...placed].map((id) => get(doc, id)).filter((x): x is Rec => !!x);
    const freshLanes = new Set(cands.filter((c) => fresh.has(c.id as string)).map((c) => c.trackId));
    const byLane = new Map<unknown, Rec[]>();
    const add = (x: Rec) => {
      let l = byLane.get(x.trackId);
      if (!l) byLane.set(x.trackId, (l = []));
      l.push(x);
    };
    if (freshLanes.size) for (const x of (doc[ITEMS] ?? []) as Rec[]) if (freshLanes.has(x.trackId)) add(x);
    for (const x of cands) if (!freshLanes.has(x.trackId)) add(x);
    const ov = (a: Rec | undefined, b: Rec | undefined) =>
      !!a && !!b && a.trackId === b.trackId && (a.startTime as number) < (b.endTime as number) - 1e-6 && (b.startTime as number) < (a.endTime as number) - 1e-6;
    const seen = new Set<string>();
    for (const it of cands)
      for (const x of byLane.get(it.trackId) ?? [])
        if (x.id !== it.id && ov(it, x)) {
          const [a, b] = (it.id as string) < (x.id as string) ? [it.id as string, x.id as string] : [x.id as string, it.id as string];
          const key = a + "|" + b;
          if (seen.has(key) || sides.some((s) => ov(get(s, it.id as string), get(s, x.id as string)))) continue;
          seen.add(key);
          out.push({ kind: "overlap", items: [a, b] });
        }
  }
  const ids = touched.get(ITEMS);
  if (ids && doc[MEDIA]) {
    const media = new Set(((doc[MEDIA] ?? []) as Rec[]).map((m) => m.id));
    for (const id of ids) {
      const it = get(doc, id);
      if (it?.mediaItemId && !media.has(it.mediaItemId)) out.push({ kind: "missing media", item: id });
    }
  }
  return out;
}

const grade = object({
  wheels: object(), // lift/gamma/gain/offset, each a small object, merged per key
  curves: object(), // per-channel point lists are leaves (arrays)
  lut: object(),
});

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

/** Shot rules (§9): fields that don't change what is seen or heard, visibility, stacking, and edge windows. */
const shots: TimelineConfig["shots"] = {
  ignore: ["id", "trackId", "startTime", "endTime", "trimStart", "trimEnd", "name", "pending", "generationKey", "generationError", "alternatives"],
  visible: (it, tr) => !!tr && !it.hidden && (AUDIO.has(it.type as string) ? !tr.muted && !it.muted && !it.audioDisabled : tr.visible !== false),
  rank: (it, tr) => ((tr?.order as number | undefined) ?? 0) * 1e4 + ((it.zIndex as number | undefined) ?? 0),
  // Edge effects only matter inside their window, so they are not part of the item's identity.
  edgeFields: ["transitionIn", "transitionOut", "audioFadeIn", "audioFadeOut", "textAnimation"],
  windows: (it, dur) => {
    const segs = it.captionSegments as unknown[] | undefined;
    const words = it.captionWordTimings as unknown[] | undefined;
    if (segs?.length || words?.length) return [{ a: 0, b: dur, from: "start", sig: "caption" }];
    const dOf = (x: unknown) => (x as { duration?: number } | undefined)?.duration;
    const ta = it.textAnimation as { duration?: number } | undefined;
    const ins = [dOf(it.transitionIn), dOf(it.audioFadeIn), ta ? (ta.duration ?? 1) : 0].filter((x): x is number => (x ?? 0) > 0);
    const kf = ((it.keyframeTracks ?? []) as { keyframes?: { time: number }[] }[]).flatMap((k) => (k.keyframes ?? []).map((f) => f.time));
    const out: { a: number; b: number; from: "start" | "end"; sig?: string }[] = [];
    if (ins.length || kf.length) out.push({ a: Math.min(0, ...kf), b: Math.max(0, ...ins, ...kf), from: "start", sig: JSON.stringify([it.transitionIn, it.audioFadeIn, it.textAnimation]) });
    const end = Math.max(0, dOf(it.transitionOut) ?? 0, dOf(it.audioFadeOut) ?? 0);
    if (end > 0) out.push({ a: dur - end, b: dur, from: "end", sig: JSON.stringify([it.transitionOut, it.audioFadeOut]) });
    return out;
  },
};

// Editors' words for fields in History and Compare (describe()), in Cardboard's own UI vocabulary where it has one (the
// renderer's properties panel: "Exposure", "Grade saturation", "Corner Radius", "Fade In", "Speed", "Line H"…), lower
// case. Keys are a field's dotted path in the record, keyed-array element keys left out.
const ROOT_LABELS: Record<string, string> = { name: "project name", description: "description", aspectRatio: "aspect ratio" };
const TRACK_LABELS: Record<string, string> = { name: "name", locked: "lock", visible: "visibility", muted: "mute", type: "kind", captionGenerationSettings: "caption settings" };
const ITEM_LABELS: Record<string, string> = {
  name: "name",
  trackId: "track",
  mediaItemId: "media",
  startTime: "start",
  endTime: "end",
  trimStart: "in point",
  trimEnd: "out point",
  playbackSpeed: "speed",
  playbackDirection: "direction",
  volume: "volume",
  muted: "mute",
  audioDisabled: "audio",
  audioFadeIn: "fade in",
  "audioFadeIn.duration": "fade in",
  audioFadeOut: "fade out",
  "audioFadeOut.duration": "fade out",
  opacity: "opacity",
  hidden: "visibility",
  zIndex: "layer order",
  blendMode: "blend",
  borderRadius: "corner radius",
  gaussianBlur: "blur",
  borderColor: "border color",
  borderWidth: "border width",
  transform: "transform",
  "transform.x": "position x",
  "transform.y": "position y",
  "transform.scale": "scale",
  "transform.rotation": "rotation",
  "transform.flipX": "flip horizontal",
  crop: "crop",
  "crop.top": "crop top",
  "crop.right": "crop right",
  "crop.bottom": "crop bottom",
  "crop.left": "crop left",
  transitionIn: "transition in",
  "transitionIn.duration": "transition in",
  transitionOut: "transition out",
  "transitionOut.duration": "transition out",
  textAnimation: "text animation",
  textContent: "text",
  fontFamily: "font",
  fontSize: "font size",
  fontWeight: "font weight",
  fontStyle: "font style",
  color: "color",
  textAlign: "alignment",
  lineHeight: "line height",
  letterSpacing: "letter spacing",
  captionText: "caption text",
  captionPosition: "caption position",
  captionSegments: "caption",
  "captionSegments.text": "caption text",
  captionWordTimings: "caption word timings",
  colorGrading: "color",
  "colorGrading.brightness": "brightness",
  "colorGrading.contrast": "contrast",
  "colorGrading.saturation": "saturation",
  "colorGrading.exposure": "exposure",
  "colorGrading.highlights": "highlights",
  "colorGrading.shadows": "shadows",
  "colorGrading.temperature": "temperature",
  "colorGrading.tint": "tint",
  "colorGrading.vibrance": "vibrance",
  "colorGrading.gamma": "gamma",
  colorGrade: "grade",
  "colorGrade.saturation": "grade saturation",
  "colorGrade.wheels": "color wheels",
  "colorGrade.wheels.lift": "lift",
  "colorGrade.wheels.gamma": "gamma wheel",
  "colorGrade.wheels.gain": "gain",
  "colorGrade.wheels.offset": "offset",
  "colorGrade.curves": "curves",
  "colorGrade.lut": "LUT",
  lutIntensity: "LUT intensity",
  effects: "effect",
  keyframeTracks: "keyframes",
  "keyframeTracks.keyframes": "keyframes",
  codeComposition: "code graphic",
  shaderComposition: "shader",
  "shaderComposition.params": "shader settings",
  voiceoverText: "voiceover text",
  autoReframe: "auto reframe",
  zoomScale: "zoom",
};
const MEDIA_LABELS: Record<string, string> = {
  "data.fileName": "file name",
  "data.content": "text",
  "data.code.source": "code",
  "data.type": "kind",
  contentHash: "content",
  shared: "shared media",
  "shared.size": "size",
  "shared.durationSec": "duration",
  "shared.proxy": "proxy",
  "shared.original": "original",
  "shared.t1": "small files",
};

/** The T1 kinds of PLAN §11 (`@carton/media`'s `T1_KINDS`): poster, filmstrip, peaks, transcript, analysis, LUT, .context, recipe. */
export const SHARED_T1_KINDS = ["poster", "filmstrip", "peaks", "transcript", "analysis", "lut", "context", "recipe"] as const;
/**
 * A media entry's fields that are Carton's, not Cardboard's: `contentHash` and `shared`. 1.4.0's project store strips
 * them (windows-sync checked it through the real worker), so a host entry without them keeps the base's (a GUI save
 * doesn't remove what it can't store); Carton's own writes set them. `data.content` is kept the same way (`fromHost`).
 */
export const CARTON_MEDIA_FIELDS = ["contentHash", "shared"] as const;
/**
 * The rest of the shared media record (PLAN §11 T0, `@carton/media`'s `MediaRecord` beyond the id, file name and content
 * id that Cardboard's entry and `contentHash` already carry), so a teammate finds the proxy, the T1 files and the facts
 * `probe_media` answers from the project itself (S5-G3). Each fact is its own leaf, so two machines adding different
 * facts merge; a proxy ref and each T1 file are one unit (replaced whole, never half of one and half of another).
 */
const sharedMedia = object(
  {
    kind: scalar,
    size: scalar,
    mime: scalar,
    durationSec: scalar,
    width: scalar,
    height: scalar,
    fps: scalar,
    codec: scalar,
    bitrate: scalar,
    hasAudio: scalar,
    /** T3: "local-only" | "shared". */
    original: scalar,
    /** T2: {profile, encoder, stream, size?} or {profile, encoder, hash, size}. */
    proxy: atomic,
    /** T1: {hash, size} per kind. */
    t1: object(Object.fromEntries(SHARED_T1_KINDS.map((k) => [k, atomic])), { only: true }),
  },
  { only: true },
);

export const cardboardSchema: Schema = defineSchema({
  root: {}, // name, description, aspectRatio: scalars (undeclared root fields are leaves)
  labels: ROOT_LABELS,
  collections: {
    [TRACKS]: {
      key: "id",
      seq: true, // ordered by "#pos"; `order` is materialized (B12)
      noun: "track",
      labels: TRACK_LABELS,
      fields: { captionGenerationSettings: object({ excludeTrackIds: atomic, excludeMediaIds: atomic }), order: ephemeral },
    },
    [ITEMS]: {
      key: "id",
      parent: { field: "trackId", collection: TRACKS },
      noun: "clip",
      labels: ITEM_LABELS,
      groups: [{ name: "time", fields: [...TIME_FIELDS], algebra: timeAlgebra(TL) }],
      fields: itemFields,
    },
    [MEDIA]: {
      key: "id",
      only: true, // the versioned subset: data.code.source (text), data.content, data.fileName, data.type, contentHash, shared
      noun: "media",
      labels: MEDIA_LABELS,
      fields: {
        contentHash: { kind: "leaf" },
        shared: sharedMedia,
        data: object({ code: object({ source: text }, { only: true }), content: { kind: "leaf" }, fileName: { kind: "leaf" }, type: { kind: "leaf" } }, { only: true }),
      },
    },
  },
  hard,
  soft,
  timeline: { ...TL, shots },
  // A record's name for people (History, cards): its own name or text; a clip without one is named after its media's
  // file name (looked up in `doc`, when given); media by its file name, else its text, else its kind. Never
  // "undefined"; an id fragment only when nothing else names it.
  label: (coll, r, doc) => {
    if (!r) return "?";
    if (coll === TRACKS) return words(r.name, 60) ?? (typeof r.type === "string" ? `${r.type} track` : "track");
    if (coll === MEDIA) return mediaName(r) ?? `media ${String(r.id).slice(0, 6)}`;
    const own = words(r.name, 60) ?? words(r.textContent) ?? words(r.captionText);
    if (own) return own;
    const m = doc && typeof r.mediaItemId === "string" ? (getIn(doc, [MEDIA, r.mediaItemId], cardboardSchema) as Rec | undefined) : undefined;
    const file = m && (words((m.data as Rec | undefined)?.fileName, 60) ?? words((m.data as Rec | undefined)?.content));
    return file ?? `${typeof r.type === "string" ? r.type : "clip"} ${String(r.id).slice(0, 6)}`;
  },
});

/** Text that names something: trimmed to `max` characters; undefined for anything else or blank. */
function words(v: unknown, max = 40): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max - 1) + "…" : t) : undefined;
}
/** A media entry's name: its file name, else its text, else its kind ("video"). */
export function mediaName(m: Rec): string | undefined {
  const d = m.data as Rec | undefined;
  return words(d?.fileName, 60) ?? words(d?.content) ?? words(d?.type);
}

/** An item of an engine doc by id. */
export const itemOf = (doc: Doc, id: string): Rec | undefined => getIn(doc, [ITEMS, id], cardboardSchema) as Rec | undefined;

/**
 * Diagnostics for the status sidecar (R5-04), as 1.4.0 lists them in its `// diagnostics:` header: hard problems in
 * the content an agent saved (core turns those into "invalid" cards instead of committing them) and soft ones (overlaps
 * on a track) at head.
 */
export function diagnose(saved: Doc, head: Doc): string[] {
  const hardOf = (d: Doc) => {
    const out: string[] = [];
    for (const it of (d[ITEMS] ?? []) as Rec[]) for (const p of hard(ITEMS, it, d)) out.push(`error: ${String(it.id)}: ${p}`);
    return out;
  };
  const softOf = (d: Doc) => {
    const out: string[] = [];
    const byTrack = new Map<unknown, Rec[]>();
    for (const it of (d[ITEMS] ?? []) as Rec[]) {
      let l = byTrack.get(it.trackId);
      if (!l) byTrack.set(it.trackId, (l = []));
      l.push(it);
    }
    for (const [t, l] of byTrack) {
      l.sort((a, b) => (a.startTime as number) - (b.startTime as number));
      for (let i = 1; i < l.length; i++) if ((l[i]!.startTime as number) < (l[i - 1]!.endTime as number) - 1e-9) out.push(`warning: ${String(l[i - 1]!.id)} and ${String(l[i]!.id)} overlap on ${String(t)}`);
    }
    return out;
  };
  return [...new Set([...hardOf(saved), ...hardOf(head)]), ...softOf(head)];
}
