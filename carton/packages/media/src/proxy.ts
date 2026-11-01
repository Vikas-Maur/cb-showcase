// Collab proxies (PLAN §11 T2): reuse the host's proxy when it already suits range streaming, otherwise encode a 720p
// H.264 one through a fallback chain (R2-12). This file runs in any runtime; the ffmpeg encoders and the host-proxy
// probe are in `node/`.
//
// - The profile targets about 2 Mb/s, the rate §18's storage cost assumes. Its id is part of the proxy's dedup key
//   (source hash, profile id), so any change to what it produces needs a new id.
// - The chain is just a list of `ProxyEncoder`s: the host's proxy first, then NVENC, QSV, AMF and libx264
//   (`node/ffmpeg-encoder.ts`). Each encoder probes itself once; `encodeProxy` only decides what a skip, a decline or
//   a failure means.

import type { MediaInput, MediaOutput, ProxyEncoder, ProxyProfile } from "@carton/core/plugins";

/** The media package's fuller profile. A plain ProxyProfile gets the defaults of `collabProfile`. */
export interface CollabProfile extends ProxyProfile {
  /** Part of the dedup key (source hash, profile id). */
  id: string;
  /** Video rate ceiling, bits/s. */
  maxBitrate: number;
  /** AAC rate, bits/s. */
  audioBitrate: number;
  /** A keyframe at least this often, so range reads can seek without decoding far back. */
  keyframeSeconds: number;
}

export const COLLAB_PROXY_720P: CollabProfile = {
  id: "collab-720p-h264-v1",
  height: 720,
  bitrate: 2_000_000,
  maxBitrate: 2_500_000,
  codec: "h264",
  audio: "aac",
  audioBitrate: 128_000,
  keyframeSeconds: 2,
};

/** Fills in what a plain ProxyProfile leaves out: a 1.25× rate ceiling, 128 kbit/s audio, a keyframe every 2 s. */
export function collabProfile(p: ProxyProfile): CollabProfile {
  const c = p as Partial<CollabProfile>;
  return {
    ...p,
    id: c.id ?? `h264-${p.height}p-${Math.round(p.bitrate / 1000)}k-v1`,
    maxBitrate: c.maxBitrate ?? Math.round(p.bitrate * 1.25),
    audioBitrate: c.audioBitrate ?? 128_000,
    keyframeSeconds: c.keyframeSeconds ?? 2,
  };
}

/** A host proxy above this overall rate (kbit/s) is re-encoded: 4 Mb/s is twice §18's budget per footage hour. */
export const REUSE_MAX_KBPS = 4000;
/** Cardboard's local proxies have a 1920 long edge; anything larger is not a proxy worth streaming. */
export const REUSE_MAX_LONG_EDGE = 1920;

/** What a probe found out about an existing proxy file. Null means it could not tell. */
export interface ProxyFacts {
  /** ffprobe's codec_name for the first video stream, e.g. "h264". */
  codec: string | null;
  /** Overall rate, audio included, kbit/s. */
  bitrateKbps: number | null;
  longEdge: number | null;
  /** moov before mdat ("faststart"): a player can start from the first range instead of reading the file's end. */
  moovBeforeMdat: boolean | null;
  hasVideo: boolean;
  /** Optional: 10-bit or 4:2:2 H.264 doesn't decode in browsers, so a known pixel format other than 8-bit 4:2:0 is refused. */
  pixFmt?: string | null;
}

export interface ReuseDecision {
  ok: boolean;
  /** Why, in words for the activity log. */
  reason: string;
}

const BROWSER_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);
const NOT_FASTSTART = "not faststart (moov is not before mdat), so it can't be range-streamed";

/** Whether a host proxy can be shared as the collab proxy as it is, without re-encoding. */
export function reusableProxy(info: ProxyFacts): ReuseDecision {
  // First: a probe that saw moov after mdat stops there (node/host-proxy.ts), so the other facts are unknown.
  if (info.moovBeforeMdat === false) return { ok: false, reason: NOT_FASTSTART };
  if (!info.hasVideo) return { ok: false, reason: "no video stream" };
  if (info.codec !== "h264") return { ok: false, reason: `codec is ${info.codec ?? "unknown"}, not H.264` };
  if (info.pixFmt != null && !BROWSER_PIX_FMTS.has(info.pixFmt)) return { ok: false, reason: `pixel format ${info.pixFmt} won't decode in browsers` };
  if (info.bitrateKbps == null || !Number.isFinite(info.bitrateKbps)) return { ok: false, reason: "bitrate unknown" };
  if (info.bitrateKbps > REUSE_MAX_KBPS) return { ok: false, reason: `${Math.round(info.bitrateKbps)} kbit/s is above ${REUSE_MAX_KBPS}` };
  if (info.longEdge == null) return { ok: false, reason: "size unknown" };
  if (info.longEdge > REUSE_MAX_LONG_EDGE) return { ok: false, reason: `long edge ${info.longEdge} is above ${REUSE_MAX_LONG_EDGE}` };
  if (info.moovBeforeMdat !== true) return { ok: false, reason: NOT_FASTSTART };
  return { ok: true, reason: `H.264, ${Math.round(info.bitrateKbps)} kbit/s, long edge ${info.longEdge}, faststart` };
}

/** Random-access bytes; `hash.ts`'s ByteSource fits, so a browser File can be checked too. */
export interface AtomSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Walks the file's top-level MP4 boxes and says whether `moov` comes before `mdat`. False when mdat comes first, when
 * there is no moov (a file still being written), or when the boxes don't parse. Reads 16 bytes per box, so a large
 * mdat is skipped, not read.
 */
export async function moovBeforeMdat(src: AtomSource): Promise<boolean> {
  let at = 0;
  // A real file has a handful of top-level boxes; the cap stops a corrupt file of tiny boxes from costing a read each.
  for (let n = 0; n < 1000 && at + 8 <= src.size; n++) {
    const head = await src.read(at, 16);
    if (head.length < 8) return false;
    const v = new DataView(head.buffer, head.byteOffset, head.length);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (type === "moov") return true;
    if (type === "mdat") return false;
    let size = v.getUint32(0);
    let header = 8;
    if (size === 1) {
      // 64-bit size follows the type (large boxes, usually mdat, but any box may use it).
      if (head.length < 16) return false;
      size = v.getUint32(8) * 0x1_0000_0000 + v.getUint32(12);
      header = 16;
    } else if (size === 0) {
      return false; // the box runs to the end of the file, so nothing follows it
    }
    if (size < header || !Number.isSafeInteger(size)) return false;
    at += size;
  }
  return false;
}

/**
 * An encoder that won't take this job, e.g. the host has no reusable proxy. The chain moves on without calling it a
 * failure. Matched by name too, so an encoder from another package can decline without importing this class.
 */
export class ProxyDeclinedError extends Error {
  override name = "ProxyDeclinedError";
}

export interface ProxyAttempt {
  encoder: string;
  outcome: "unavailable" | "declined" | "failed" | "ok";
  /** The decline's reason or the failure's message. */
  error?: string;
}

export interface EncodeProxyOutcome {
  encoder: string;
  hardware: boolean;
  bytes: number;
  durationMs: number;
  attempts: ProxyAttempt[];
}

export interface EncodeProxyOptions {
  signal?: AbortSignal;
  /** 0..1 over the whole chain, never backwards: after a fallback it holds until the next encoder passes it. */
  onProgress?: (fraction: number) => void;
  /** Each attempt as it is decided, for the activity log. */
  onAttempt?: (attempt: ProxyAttempt) => void;
}

export class ProxyChainError extends Error {
  override name = "ProxyChainError";
  readonly attempts: readonly ProxyAttempt[];
  constructor(attempts: readonly ProxyAttempt[]) {
    const list = attempts.length ? attempts.map((a) => `${a.encoder} ${a.outcome}${a.error ? `: ${a.error}` : ""}`).join("; ") : "no encoders";
    super(`no proxy encoder could make this proxy (${list})`);
    this.attempts = attempts;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNamed(e: unknown, name: string): boolean {
  return (e as { name?: unknown } | null)?.name === name;
}

/** probe() must not throw (core's contract); one that does counts as "can't run here". */
async function probeSafely(enc: ProxyEncoder): Promise<boolean> {
  try {
    return await enc.probe();
  } catch {
    return false;
  }
}

/** The first encoder in the chain whose 1-frame probe succeeds, or null. Probes run in order and stop at the first yes. */
export async function pickEncoder(chain: readonly ProxyEncoder[]): Promise<ProxyEncoder | null> {
  for (const enc of chain) if (await probeSafely(enc)) return enc;
  return null;
}

/**
 * Runs the chain in order and returns the first proxy made. An encoder whose probe fails is skipped; one that throws
 * ProxyDeclinedError declines (the host has no reusable proxy); one that throws anything else has failed, and the next
 * is tried, since a GPU can run out of encode sessions mid-job. An abort is not a failure: it stops the chain.
 */
export async function encodeProxy(
  chain: readonly ProxyEncoder[],
  input: MediaInput,
  output: MediaOutput,
  profile: ProxyProfile,
  opts: EncodeProxyOptions = {},
): Promise<EncodeProxyOutcome> {
  const { signal } = opts;
  const attempts: ProxyAttempt[] = [];
  const record = (a: ProxyAttempt): void => {
    attempts.push(a);
    opts.onAttempt?.(a);
  };
  let high = 0;
  const onProgress = opts.onProgress
    ? (f: number): void => {
        const clamped = Math.min(1, Math.max(0, f));
        if (clamped > high) {
          high = clamped;
          opts.onProgress?.(clamped);
        }
      }
    : undefined;
  for (const enc of chain) {
    signal?.throwIfAborted();
    const usable = await probeSafely(enc);
    signal?.throwIfAborted();
    if (!usable) {
      // ffmpegEncoder offers the probe's reason ("Cannot load nvcuda.dll"): worth a line in the log for a user who
      // has a GPU and wonders why it wasn't used. It is cached, so asking costs nothing.
      const detail = await (enc as { probeDetail?: () => Promise<{ detail?: string }> }).probeDetail?.().catch(() => undefined);
      record({ encoder: enc.name, outcome: "unavailable", ...(detail?.detail ? { error: detail.detail } : {}) });
      continue;
    }
    try {
      const { bytes, durationMs } = await enc.encode(input, output, profile, { signal, onProgress });
      record({ encoder: enc.name, outcome: "ok" });
      return { encoder: enc.name, hardware: enc.hardware, bytes, durationMs, attempts };
    } catch (e) {
      // A killed ffmpeg reports an exit code, not an AbortError, so the signal decides first.
      if (signal?.aborted) throw signal.reason;
      if (isNamed(e, "AbortError")) throw e;
      record({ encoder: enc.name, outcome: isNamed(e, "ProxyDeclinedError") ? "declined" : "failed", error: errorText(e) });
    }
  }
  throw new ProxyChainError(attempts);
}
