// Media tiers (PLAN §11). Each moves only when needed:
//   T0  the media record: what a teammate needs to see the clip in the library and on the timeline. Rides in the
//       document; never a local path (`--no-copy` paths stay in the local-only path map).
//   T1  small derived files: poster, filmstrip sprite, waveform peaks, transcript, analysis, LUTs, `.context` (25 MB
//       cap), recipes. Uploaded when the project is shared, fetched when the project is opened.
//   T2  the collab proxy: uploaded when shared, range-streamed when someone plays it.
//   T3  originals: never uploaded unless the owner opts in or a teammate asks.
// This file is the policy as pure functions; `@carton/media/node` shareMedia carries it out.

export type Tier = "T0" | "T1" | "T2" | "T3";

export type T1Kind = "poster" | "filmstrip" | "peaks" | "transcript" | "analysis" | "lut" | "context" | "recipe";
export const T1_KINDS: readonly T1Kind[] = ["poster", "filmstrip", "peaks", "transcript", "analysis", "lut", "context", "recipe"];
/** `.context` folders over this stay local (PLAN §11). */
export const CONTEXT_CAP_BYTES = 25 * 1000 * 1000;

export interface SharedObject {
  hash: string;
  size: number;
}

/** T0. Everything here is safe to show a teammate. */
export interface MediaRecord {
  /** The host's media id (Cardboard's `media[].id`). */
  id: string;
  kind: "video" | "audio" | "image" | "other";
  fileName: string;
  /** The original's size and content id; the id is set when the project is shared. */
  size: number;
  hash?: string;
  mime?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  /** bit/s, whole file. */
  bitrate?: number;
  hasAudio?: boolean;
  t1?: Partial<Record<T1Kind, SharedObject>>;
  proxy?: SharedObject & { profile: string; encoder: string };
  /** Whether the original is in the shared store (T3). */
  original?: "local-only" | "shared";
}

const T0_FIELDS = ["id", "kind", "fileName", "size", "hash", "mime", "durationSec", "width", "height", "fps", "codec", "bitrate", "hasAudio", "t1", "proxy", "original"] as const;

/**
 * Builds the T0 record from whatever the host knows about a clip, keeping only the fields above. Paths, thumbnails as
 * blob URLs, user names in paths and any field added later stay out unless they are added here on purpose.
 */
export function toMediaRecord(meta: Record<string, unknown>): MediaRecord {
  const out: Record<string, unknown> = {};
  for (const f of T0_FIELDS) if (meta[f] !== undefined) out[f] = meta[f];
  if (typeof out.fileName === "string") out.fileName = out.fileName.split(/[\\/]/).pop();
  if (typeof out.id !== "string" || typeof out.fileName !== "string" || typeof out.size !== "number") {
    throw new TypeError("a media record needs id, fileName and size");
  }
  out.kind ??= "other";
  return out as unknown as MediaRecord;
}

export interface LocalMedia {
  /** The original is on this machine. */
  original: boolean;
  /** T1 files on this machine, with their sizes. */
  t1: Partial<Record<T1Kind, number>>;
  /** The host's own proxy might be reusable (checked when T2 runs). */
  hostProxy?: boolean;
}

export interface SharePolicy {
  /** The owner opted in to sharing originals, or a teammate asked for this one. */
  originals: boolean;
  /** Skip T2 (an audio-only project, or the owner turned proxies off). */
  proxies?: boolean;
}

export type ShareStep =
  | { tier: "T1"; kind: T1Kind }
  | { tier: "T2"; reuseHostProxy: boolean }
  | { tier: "T3" };

/** What sharing one clip must upload, cheapest first, and what it leaves out and why. */
export function planShare(record: MediaRecord, local: LocalMedia, policy: SharePolicy): { steps: ShareStep[]; skipped: { what: string; why: string }[] } {
  const steps: ShareStep[] = [];
  const skipped: { what: string; why: string }[] = [];
  for (const kind of T1_KINDS) {
    const size = local.t1[kind];
    if (size === undefined) continue;
    if (record.t1?.[kind]) continue; // already shared
    if (kind === "context" && size > CONTEXT_CAP_BYTES) {
      skipped.push({ what: ".context", why: `over the ${CONTEXT_CAP_BYTES / 1e6} MB cap` });
      continue;
    }
    steps.push({ tier: "T1", kind });
  }
  const playable = record.kind === "video" || record.kind === "audio";
  if (playable && policy.proxies !== false && !record.proxy) {
    if (local.original || local.hostProxy) steps.push({ tier: "T2", reuseHostProxy: !!local.hostProxy });
    else skipped.push({ what: "proxy", why: "neither the original nor a proxy is on this machine" });
  }
  if (policy.originals && record.original !== "shared") {
    if (local.original) steps.push({ tier: "T3" });
    else skipped.push({ what: "original", why: "not on this machine" });
  }
  return { steps, skipped };
}

/** What a tool or the player does with a clip (the §11 "Without originals" table). */
export type MediaUse =
  | "preview"
  | "export"
  | "grab_frame"
  | "filmstrip"
  | "detect_scenes"
  | "transcribe_media"
  | "measure_loudness"
  | "probe_media"
  | "lut"
  | "context"
  | "recipe"
  | "font";

export interface Availability {
  /** "local": on this machine; "remote": in the shared store (T3); "none". */
  original: "local" | "remote" | "none";
  /** A collab proxy in the shared store, or cached here. */
  proxy: boolean;
  t1: Partial<Record<T1Kind, boolean>>;
}

export interface UseSource {
  tier: Tier | null;
  source: "original" | "proxy" | "record" | T1Kind | "none";
  /** Proxy read through the loopback range server: only the bytes touched are fetched. */
  ranged: boolean;
  /** Lower fidelity than the original (state it to the user or the agent). */
  approximate: boolean;
  note?: string;
}

const none = (note: string): UseSource => ({ tier: null, source: "none", ranged: false, approximate: false, note });
const fromOriginal = (a: Availability): UseSource => ({ tier: "T3", source: "original", ranged: a.original === "remote", approximate: false });
const fromProxy = (approximate: boolean, note?: string): UseSource => ({ tier: "T2", source: "proxy", ranged: true, approximate, note });

/** Where a use reads from, given what this machine can reach. Originals win when they are here. */
export function sourceFor(use: MediaUse, a: Availability): UseSource {
  const local = a.original === "local";
  switch (use) {
    case "probe_media":
      return { tier: "T0", source: "record", ranged: false, approximate: false };
    case "preview":
    case "grab_frame":
    case "filmstrip":
    case "detect_scenes":
      if (local) return fromOriginal(a);
      if (a.proxy) return fromProxy(false);
      return a.original === "remote" ? fromOriginal(a) : none("no proxy or original reachable yet");
    case "export":
      if (local) return fromOriginal(a);
      if (a.original === "remote") return fromOriginal(a);
      if (a.proxy) return fromProxy(true, "proxy quality: request the originals, or ask the owner to export (L3)");
      return none("no proxy or original reachable yet");
    case "transcribe_media":
      if (a.t1.transcript) return { tier: "T1", source: "transcript", ranged: false, approximate: false };
      if (local) return fromOriginal(a);
      if (a.proxy) return fromProxy(false, "transcribed from the proxy's audio");
      return none("no transcript, proxy or original reachable yet");
    case "measure_loudness":
      if (local) return fromOriginal(a);
      if (a.proxy) return fromProxy(true, "measured on the proxy's AAC audio: approximate");
      return a.original === "remote" ? fromOriginal(a) : none("no proxy or original reachable yet");
    case "lut":
    case "context":
    case "recipe":
      return a.t1[use] ? { tier: "T1", source: use, ranged: false, approximate: false } : none(`no ${use} shared for this clip`);
    case "font":
      return none("fonts are not synced: renders can differ (L4)");
  }
}
