// Deterministic generators (port of core-v5 `gen.mjs`): realistic Cardboard-like timelines for the card-rate mix, and
// small random docs + random edits for property tests. Docs and edits here are project.json-shaped plain JS (never the
// engine's apply or merge); tests turn them into engine docs with the fixture's fromHost, as the app would on every save.
// The sequences of random draws are the prototype's, so seeds give the same documents.

import type { HostDoc } from "./fixtures/cardboard-schema.ts";

type Item = Record<string, any>;
export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;
export const int = (r: Rng, a: number, b: number): number => a + Math.floor(r() * (b - a + 1));
const t3 = (x: number) => Math.round(x * 1000) / 1000;
export function uuid(r: Rng): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(r() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const WORDS = "we cut editing time by ten times with agents that know your footage and keep every take safe while you work".split(" ");
const sentence = (r: Rng, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");
const rgb = (r: Rng) => ({ r: t3(r() * 0.1 - 0.05), g: t3(r() * 0.1 - 0.05), b: t3(r() * 0.1 - 0.05) });

// ------------------------------------------------------------------ realistic timelines

type Kind = "title" | "caption" | "video" | "adjust" | "audio" | "music";
interface Lane {
  name: string;
  type: string;
  share: number;
  kind: Kind;
  gap: [number, number];
  dur: [number, number];
}
const LANES: Lane[] = [
  { name: "Titles", type: "video", share: 0.1, kind: "title", gap: [2, 12], dur: [2, 5] },
  { name: "Captions", type: "caption", share: 0.26, kind: "caption", gap: [0, 0.3], dur: [1.5, 4] },
  { name: "B-roll", type: "video", share: 0.12, kind: "video", gap: [3, 15], dur: [2, 6] },
  { name: "Main", type: "video", share: 0.32, kind: "video", gap: [0, 0], dur: [2, 9] },
  { name: "Grade", type: "adjustment", share: 0.03, kind: "adjust", gap: [5, 30], dur: [8, 30] },
  { name: "Voiceover", type: "audio", share: 0.09, kind: "audio", gap: [0.5, 4], dur: [3, 12] },
  { name: "Music", type: "audio", share: 0.02, kind: "music", gap: [0, 2], dur: [60, 180] },
  { name: "SFX", type: "audio", share: 0.06, kind: "audio", gap: [3, 20], dur: [0.5, 2] },
];

interface Ctx {
  media: string[];
  n: number;
  main: string;
}

function makeItem(r: Rng, kind: Kind, ctx: Ctx, trackId: string, start: number, dur: number): Item {
  const id = uuid(r);
  const base = { id, trackId, startTime: t3(start), endTime: t3(start + dur) };
  const src = t3(r() * 20);
  if (kind === "video") {
    const it: Item = {
      ...base,
      type: "video",
      trimStart: src,
      trimEnd: t3(src + dur),
      mediaItemId: pick(r, ctx.media),
      name: `Clip ${ctx.n++}`,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false },
      opacity: 1,
      volume: trackId === ctx.main ? 1 : 0,
    };
    if (r() < 0.6)
      it.colorGrade = {
        wheels: { lift: rgb(r), gamma: rgb(r), gain: rgb(r), offset: rgb(r) },
        saturation: t3(0.9 + r() * 0.3),
        ...(r() < 0.3 ? { curves: { master: [[0, 0], [0.5, t3(0.45 + r() * 0.1)], [1, 1]] } } : {}),
      };
    if (r() < 0.25) it.effects = Array.from({ length: int(r, 1, 2) }, () => ({ id: uuid(r), type: pick(r, ["blur", "sharpen", "vignette", "glow"]), amount: t3(r()) }));
    if (r() < 0.15)
      it.keyframeTracks = [{ property: "scale", keyframes: [{ time: 0, value: 1 }, { time: t3(dur), value: t3(1 + r() * 0.2) }], easing: "easeInOut" }];
    if (r() < 0.1) it.transitionIn = { type: "crossfade", duration: 0.5 };
    if (r() < 0.1) it.crop = { top: 0, right: t3(r() * 0.1), bottom: 0, left: t3(r() * 0.1) };
    return it;
  }
  if (kind === "title") {
    if (r() < 0.15) return { ...base, type: "code", trimStart: 0, trimEnd: t3(dur), name: `Lower third ${ctx.n++}`, mediaItemId: pick(r, ctx.media), codeComposition: { width: 1920, height: 1080 } };
    const it: Item = {
      ...base,
      type: "text",
      trimStart: 0,
      trimEnd: t3(dur),
      mediaItemId: pick(r, ctx.media),
      textContent: sentence(r, int(r, 2, 6)),
      fontFamily: "Inter",
      fontSize: int(r, 48, 160),
      fontWeight: 700,
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.1,
      transform: { x: 0, y: t3(r() * 400 - 200), scale: 1, rotation: 0 },
    };
    if (r() < 0.5) it.textAnimation = { preset: pick(r, ["typewriter", "fade", "pop"]), duration: 0.6 };
    if (r() < 0.3) it.keyframeTracks = [{ property: "opacity", keyframes: [{ time: 0, value: 0 }, { time: 0.4, value: 1 }], easing: "linear" }];
    return it;
  }
  if (kind === "caption") {
    const segs: Item[] = [];
    let t = 0;
    for (let s = 0, ns = int(r, 1, 2); s < ns; s++) {
      const len = dur / ns,
        nw = int(r, 4, 9),
        words: Item[] = [];
      for (let w = 0; w < nw; w++) words.push({ word: pick(r, WORDS), start: t3(t + (w * len) / nw), end: t3(t + ((w + 1) * len) / nw) });
      segs.push({ id: uuid(r), text: words.map((w) => w.word).join(" "), startTime: t3(t), endTime: t3(t + len), wordTimings: words });
      t += len;
    }
    return {
      ...base,
      type: "caption",
      trimStart: 0,
      trimEnd: t3(dur),
      mediaItemId: pick(r, ctx.media),
      captionText: segs.map((s) => s.text).join(" "),
      captionSegments: segs,
      captionFontSize: 64,
      captionFontFamily: "Inter",
      captionColor: "#ffffff",
      captionHighlightColor: "#ffd400",
      captionPosition: "bottom",
      captionStyle: "pop",
    };
  }
  if (kind === "adjust")
    return {
      ...base,
      type: "adjustment",
      trimStart: 0,
      trimEnd: t3(dur),
      adjustmentKind: "grade",
      colorGrading: { exposure: t3(r() * 0.4 - 0.2), contrast: t3(1 + r() * 0.2), highlights: t3(-r() * 0.2), shadows: t3(r() * 0.2), temperature: t3(r() * 10 - 5), tint: 0, saturation: t3(0.9 + r() * 0.3) },
      ...(r() < 0.4 ? { lutPresetId: pick(r, ["kodak-2383", "teal-orange", "bleach"]), lutIntensity: t3(r()) } : {}),
    };
  // audio / music
  const it: Item = { ...base, type: "audio", trimStart: src, trimEnd: t3(src + dur), mediaItemId: pick(r, ctx.media), name: kind === "music" ? `Track ${ctx.n++}` : `VO ${ctx.n++}`, volume: t3(kind === "music" ? 0.3 : 0.9 + r() * 0.1) };
  if (kind === "music" || r() < 0.3) {
    it.audioFadeIn = { duration: 1, easing: "linear" };
    it.audioFadeOut = { duration: 2, easing: "linear" };
  }
  return it;
}

/**
 * n items over 7 lanes (8 from 1,000 items), each lane laid out back to back with lane-typical gaps. With {seconds},
 * every lane is filled up to that length instead (n ignored).
 */
export function genDoc(n: number, seed = 1, { seconds = null }: { seconds?: number | null } = {}): HostDoc {
  const r = rng(seed);
  const lanes = n >= 1000 || seconds ? LANES : LANES.filter((l) => l.name !== "SFX");
  const tracks = lanes.map((l, i) => ({ id: uuid(r), name: l.name, order: i, locked: false, visible: true, muted: false, type: l.type }));
  const ctx: Ctx = { media: Array.from({ length: Math.max(4, Math.ceil((seconds ? 1000 : n) / 4)) }, () => uuid(r)), n: 1, main: tracks[lanes.findIndex((l) => l.name === "Main")]!.id };
  const total = lanes.reduce((s, l) => s + l.share, 0);
  const items: Item[] = [];
  lanes.forEach((l, li) => {
    const count = seconds ? Infinity : li === lanes.length - 1 ? n - items.length : Math.round((n * l.share) / total);
    let t = l.gap[0] > 0 ? t3(r() * l.gap[1]) : 0;
    for (let k = 0; k < count; k++) {
      const dur = t3(l.dur[0] + r() * (l.dur[1] - l.dur[0]));
      if (seconds && t + dur > seconds) break;
      items.push(makeItem(r, l.kind, ctx, tracks[li]!.id, t, dur));
      t = t3(t + dur + l.gap[0] + r() * (l.gap[1] - l.gap[0]));
    }
  });
  return { name: "Launch video", description: "Q4 product launch cut", aspectRatio: "16:9", tracks, timelineItems: items };
}

// ------------------------------------------------------------------ fuzz docs and edits

const POOL = {
  name: ["Intro", "Problem", "CTA", "B-roll", null],
  opacity: [0.5, 0.8, 1],
  volume: [0, 0.5, 1],
  textContent: ["Hello", "10x faster", "Try it"],
  num: [0.9, 1, 1.1, 1.2, 1.3],
  fx: ["blur", "sharpen", "glow"],
};

function fuzzItem(r: Rng, trackId: string, start: number): Item {
  const dur = pick(r, [1, 2, 3]);
  const it: Item = { id: uuid(r), trackId, type: pick(r, ["video", "text", "audio"]), startTime: start, endTime: start + dur, trimStart: 0, trimEnd: dur };
  if (r() < 0.6) it.name = pick(r, POOL.name.slice(0, 4));
  if (r() < 0.4) it.opacity = pick(r, POOL.opacity);
  if (r() < 0.3) it.textContent = pick(r, POOL.textContent);
  if (r() < 0.4) it.transform = { x: 0, y: 0, scale: pick(r, POOL.num) };
  if (r() < 0.4) it.colorGrade = { saturation: pick(r, POOL.num), contrast: pick(r, POOL.num), ...(r() < 0.5 ? { wheels: { lift: { r: 0, g: 0, b: 0 } } } : {}) };
  if (r() < 0.4) it.effects = Array.from({ length: int(r, 1, 3) }, () => ({ id: uuid(r), type: pick(r, POOL.fx), amount: pick(r, POOL.num) }));
  if (r() < 0.3) it.keyframeTracks = [{ property: "opacity", keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }];
  if (r() < 0.2)
    it.captionSegments = [0, 1].map((k) => ({ id: uuid(r), text: pick(r, POOL.textContent), startTime: k, endTime: k + 1, wordTimings: [{ word: "a", start: k, end: k + 1 }] }));
  return it;
}

export function fuzzDoc(r: Rng): HostDoc {
  const tracks = Array.from({ length: int(r, 1, 4) }, (_, i) => ({ id: uuid(r), name: `T${i}`, order: i, visible: true }));
  const items: Item[] = [];
  const cursor = new Map<string, number>();
  for (let i = int(r, 0, 12); i > 0; i--) {
    const t = pick(r, tracks);
    const s = cursor.get(t.id) ?? 0;
    const it = fuzzItem(r, t.id, s);
    cursor.set(t.id, it.endTime);
    items.push(it);
  }
  const doc: HostDoc = { name: "P", aspectRatio: "16:9", tracks, timelineItems: items };
  if (r() < 0.5) doc.description = "d";
  if (r() < 0.5) doc.media = [{ id: "code1", data: { type: "code", fileName: "g.tsx", code: { source: CODE.join("\n") } } }];
  return doc;
}

const clone = <T>(x: T): T => structuredClone(x);
const CODE = ["export default () => (", "  <div>", "    <h1>Title</h1>", "    <p>Body</p>", "  </div>", ");"];

// Re-link records that did not change to the originals, so diffs see shared structure like the app's store.
function share(orig: HostDoc, next: HostDoc): HostDoc {
  for (const coll of ["tracks", "timelineItems", "media"]) {
    if (!orig[coll] || !next[coll]) continue;
    const byId = new Map((orig[coll] as Item[]).map((x) => [x.id, x]));
    next[coll] = (next[coll] as Item[]).map((x) => {
      const o = byId.get(x.id);
      return o && JSON.stringify(o) === JSON.stringify(x) ? o : x;
    });
  }
  return next;
}

export const EDIT_KINDS = ["field", "nested", "unset", "trim", "move", "lane", "add", "remove", "fxAdd", "fxRemove", "fxReorder", "fxEdit", "kf", "cap", "trackAdd", "trackRemove", "trackRename", "trackToggle", "root", "ripple", "trimIn", "slip", "speed", "code", "trackMove"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** Returns a new doc with k random edits applied (plain JS). */
export function fuzzEdit(r: Rng, doc: HostDoc, k = int(r, 1, 3), kinds: readonly EditKind[] = EDIT_KINDS): HostDoc {
  const d = clone(doc);
  for (let n = 0; n < k; n++) editOnce(r, d, pick(r, kinds));
  return r() < 0.5 ? share(doc, d) : d;
}

function editOnce(r: Rng, d: HostDoc, kind: EditKind): void {
  const items = d.timelineItems as Item[],
    it = items.length ? pick(r, items) : null;
  switch (kind) {
    case "field":
      if (!it) return;
      {
        const f = pick(r, ["name", "opacity", "volume", "textContent"] as const);
        const v = pick<unknown>(r, POOL[f]);
        if (v === null) delete it[f];
        else it[f] = v;
      }
      return;
    case "nested":
      if (!it) return;
      if (r() < 0.6) {
        it.colorGrade ??= {};
        if (r() < 0.3) it.colorGrade.wheels = { ...(it.colorGrade.wheels ?? {}), lift: { ...(it.colorGrade.wheels?.lift ?? {}), r: pick(r, [0, 0.05, 0.1]) } };
        else it.colorGrade[pick(r, ["saturation", "contrast"])] = pick(r, POOL.num);
      } else {
        it.transform ??= {};
        it.transform[pick(r, ["x", "y", "scale"])] = pick(r, POOL.num);
      }
      return;
    case "unset":
      if (!it) return;
      {
        const f = pick(r, ["opacity", "colorGrade", "transform", "name"]);
        if (f === "transform" && it.transform && r() < 0.5) delete it.transform.scale;
        else delete it[f];
      }
      return;
    case "trim":
      if (it && it.endTime - it.startTime > 0.5) {
        it.endTime -= 0.5;
        it.trimEnd -= 0.5;
      }
      return;
    case "move":
      if (it) {
        const dt = pick(r, [-1, 1, 2]);
        if (it.startTime + dt >= 0) (it.startTime += dt), (it.endTime += dt);
      }
      return;
    case "lane":
      if (it && d.tracks.length > 1) it.trackId = pick(r, (d.tracks as Item[]).filter((t) => t.id !== it.trackId)).id;
      return;
    case "add":
      if (d.tracks.length) items.push(fuzzItem(r, pick(r, d.tracks as Item[]).id, pick(r, [0, 3, 10, 30])));
      return;
    case "remove":
      if (it) items.splice(items.indexOf(it), 1);
      return;
    case "fxAdd":
      if (it) {
        it.effects ??= [];
        it.effects.splice(int(r, 0, it.effects.length), 0, { id: uuid(r), type: pick(r, POOL.fx), amount: pick(r, POOL.num) });
      }
      return;
    case "fxRemove":
      if (it?.effects?.length) it.effects.splice(int(r, 0, it.effects.length - 1), 1);
      return;
    case "fxReorder":
      if (it?.effects?.length > 1) it!.effects.reverse();
      return;
    case "fxEdit":
      if (it?.effects?.length) pick(r, it.effects as Item[]).amount = pick(r, POOL.num);
      return;
    case "kf":
      if (!it) return;
      if (it.keyframeTracks?.length && r() < 0.7) pick(r, it.keyframeTracks as Item[]).keyframes = [{ time: 0, value: pick(r, [0, 0.5]) }, { time: pick(r, [1, 2]), value: 1 }];
      else (it.keyframeTracks ??= []).find((k: Item) => k.property === "scale") || it.keyframeTracks.push({ property: "scale", keyframes: [{ time: 0, value: 1 }] });
      return;
    case "cap":
      if (it?.captionSegments?.length) {
        if (r() < 0.6) pick(r, it.captionSegments as Item[]).text = pick(r, POOL.textContent);
        else it.captionSegments.splice(int(r, 0, it.captionSegments.length - 1), 1);
      }
      return;
    case "trackAdd":
      d.tracks.push({ id: uuid(r), name: `T${d.tracks.length}`, order: Math.max(-1, ...(d.tracks as Item[]).map((t) => t.order)) + 1, visible: true });
      return;
    case "trackRemove":
      if (d.tracks.length > 1) {
        const t = pick(r, d.tracks as Item[]);
        d.tracks.splice(d.tracks.indexOf(t), 1);
        d.timelineItems = items.filter((x) => x.trackId !== t.id);
      }
      return;
    case "trackRename":
      if (d.tracks.length) pick(r, d.tracks as Item[]).name = pick(r, ["Main", "Titles", "VO"]);
      return;
    case "trackToggle":
      if (d.tracks.length) {
        const t = pick(r, d.tracks as Item[]);
        t.visible = !t.visible;
      }
      return;
    case "root":
      if (r() < 0.4) d.name = pick(r, ["P", "Q", "Launch"]);
      else if (r() < 0.5) d.aspectRatio = pick(r, ["16:9", "9:16", "1:1"]);
      else if (d.description !== undefined && r() < 0.5) delete d.description;
      else d.description = pick(r, ["d", "e"]);
      return;
    case "trimIn":
      if (it && it.endTime - it.startTime > 0.5) {
        it.startTime += 0.5;
        it.trimStart += 0.5 * (it.playbackSpeed ?? 1);
      }
      return;
    case "slip":
      if (it) {
        const s = pick(r, [0.5, 1]);
        it.trimStart += s;
        it.trimEnd += s;
      }
      return;
    case "speed":
      if (it) {
        it.playbackSpeed = pick(r, [0.5, 2]);
        it.endTime = it.startTime + (it.trimEnd - it.trimStart) / it.playbackSpeed;
      }
      return;
    case "code": {
      const m = d.media?.[0];
      if (!m) return;
      const lines: string[] = m.data.code.source.split("\n");
      const i = int(r, 0, lines.length - 1);
      const k = r();
      if (k < 0.5) lines[i] = lines[i] + " // " + pick(r, ["a", "b", "c"]);
      else if (k < 0.8) lines.splice(i, 0, "  " + pick(r, ["<hr/>", "<br/>", "<em>x</em>"]));
      else if (lines.length > 2) lines.splice(i, 1);
      m.data = { ...m.data, code: { source: lines.join("\n") } };
      return;
    }
    case "trackMove":
      if (d.tracks.length > 1) {
        const order = [...(d.tracks as Item[])].sort((a, b) => a.order - b.order);
        const t = order.splice(int(r, 0, order.length - 1), 1)[0]!;
        order.splice(int(r, 0, order.length), 0, t);
        order.forEach((x, i) => (x.order = i));
      }
      return;
    case "ripple": {
      // ripple delete: remove an item and pull everything after it on the lane left by its length
      if (!it) return;
      const dur = it.endTime - it.startTime;
      items.splice(items.indexOf(it), 1);
      for (const x of items) if (x.trackId === it.trackId && x.startTime >= it.endTime - 1e-9) (x.startTime -= dur), (x.endTime -= dur);
      return;
    }
  }
}

/**
 * Global ripple cut of [s, e): later items move left, items straddling an edge are split so the footage outside the cut
 * keeps its exact source mapping (fades at the new edges are dropped).
 */
export function rippleCut(doc: HostDoc, s: number, e: number): HostDoc {
  const d = e - s,
    out: Item[] = [];
  for (const i of doc.timelineItems as Item[]) {
    if (i.endTime <= s) out.push(i);
    else if (i.startTime >= e) out.push({ ...i, startTime: i.startTime - d, endTime: i.endTime - d });
    else {
      if (i.startTime < s) {
        const { transitionOut, audioFadeOut, ...p } = i;
        out.push({ ...p, endTime: s, trimEnd: i.trimStart + (s - i.startTime) });
      }
      if (i.endTime > e) {
        const { transitionIn, audioFadeIn, textAnimation, ...p } = i;
        out.push({ ...p, id: i.id + "-b", startTime: s, endTime: i.endTime - d, trimStart: i.trimStart + (e - i.startTime) });
      }
    }
  }
  return { ...doc, timelineItems: out };
}
