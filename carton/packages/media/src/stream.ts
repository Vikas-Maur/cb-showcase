// Segmented collab proxies (orchestrator decision on e2e S5-1, PLAN §11 T2, §22 phase 4): a teammate plays a proxy
// while it is still being encoded and uploaded. A multipart object is invisible until it completes (S3, R2), so a
// proxy is a stream of fragmented-MP4 (CMAF) segments of about 2 s, each its own content-addressed object, plus a
// list that only grows:
//
//   m/<hash> of the init segment and of each media segment (uploaded like any media: manifest, then bytes)
//   ps/<stream>/init, ps/<stream>/s/<000000>, … , ps/<stream>/end    small JSON entries, each written once (ifAbsent)
//                                                                     after its bytes are up
//
// The writer appends; a reader takes the init segment, then segment 0, 1, … and, when the next entry isn't there yet,
// waits for it until the end entry says there are no more. Entries are immutable, so a reader caches them and only asks
// the store for what is new. Concatenated in order (init + segments) the parts are one playable fragmented MP4, which is
// what `streamRangeSource` serves to tools once the stream is complete; while it grows, tools read the live HLS
// playlist (`playlist`) and players append segments (Media Source Extensions in the app's renderer).
//
// Which stream is a source's proxy: the pointer px/<sourceHash>/<profile> (keys.ts), claimed with ifAbsent at the start
// of an upload, so a teammate finds the stream from its first segment on and two owners don't encode it twice.

import { isMediaHash, toHex } from "./bytes.ts";
import type { BlobStore, Hasher } from "./contracts.ts";
import { bytesSource, hashSource } from "./hash.ts";
import { damagedKey, mediaKey, proxyPointerKey, streamEndKey, streamInitKey, streamSegmentKey, type ProxyPointer } from "./keys.ts";
import type { MediaStat, RangeSource } from "./range-source.ts";
import type { MediaReader } from "./read.ts";
import { uploadMedia, type UploadOptions } from "./upload.ts";

export interface StreamPart {
  hash: string;
  size: number;
}
export interface StreamSegment extends StreamPart {
  index: number;
  durationSec: number;
  /** When the writer recorded it (ms epoch): how a reader tells a live stream from an abandoned one. */
  at: number;
}
export interface StreamEnd {
  segments: number;
  durationSec: number;
  /** Bytes of init + all segments: the size of the stream as one file. */
  size: number;
  at: number;
  /**
   * The hashes of its parts, init first, then the segments in order: lets a check for damage reports on its parts
   * read one entry instead of every segment's. Absent in ends written before it was added.
   */
  parts?: string[];
}

/** A new stream id: 32 random bytes as hex (the same shape as a media hash, so URLs and keys check it the same way). */
export function newStreamId(): string {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

async function putOnce(store: BlobStore, key: string, value: unknown): Promise<void> {
  await store.put(key, utf8.encode(JSON.stringify(value)), { contentType: "application/json", ifAbsent: true });
}

async function getJson(store: BlobStore, key: string): Promise<Record<string, unknown> | null> {
  const b = await store.get(key);
  if (!b) return null;
  try {
    const v = JSON.parse(fromUtf8.decode(b)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // a damaged entry reads as absent; the reader waits, the writer's next run replaces the stream
  }
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isSeconds = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function asPart(v: Record<string, unknown> | null): StreamPart | null {
  return v && isMediaHash(v.hash) && isCount(v.size) ? { hash: v.hash, size: v.size } : null;
}
function asSegment(v: Record<string, unknown> | null, index: number): StreamSegment | null {
  const p = asPart(v);
  return p && v && v.index === index && isSeconds(v.durationSec) && isCount(v.at) ? { ...p, index, durationSec: v.durationSec, at: v.at } : null;
}
function asEnd(v: Record<string, unknown> | null): StreamEnd | null {
  return v && isCount(v.segments) && isSeconds(v.durationSec) && isCount(v.size) && isCount(v.at)
    ? {
        segments: v.segments,
        durationSec: v.durationSec,
        size: v.size,
        at: v.at,
        ...(Array.isArray(v.parts) && v.parts.length === v.segments + 1 && v.parts.every(isMediaHash) ? { parts: v.parts as string[] } : {}),
      }
    : null;
}

/** A finished stream lists a segment whose entry can't be read: it will never play past it. */
export class StreamDamagedError extends Error {
  override name = "StreamDamagedError";
  readonly stream: string;
  readonly index: number;
  constructor(stream: string, index: number) {
    super(`stream ${stream.slice(0, 12)}: entry ${index} can't be read although the stream has ended`);
    this.stream = stream;
    this.index = index;
  }
}

export interface ProxyStreamWriterOptions {
  store: BlobStore;
  hasher: Hasher;
  /** A new stream unless given (resuming a stream this process started). */
  id?: string;
  /** Passed to each segment's upload (state store, link rate, retries, signal). */
  upload?: Partial<Pick<UploadOptions, "state" | "bytesPerSecond" | "retries" | "retryDelayMs" | "signal">>;
}

/** Appends a stream: the init segment, then media segments in order, then the end. One writer per stream. */
export class ProxyStreamWriter {
  readonly id: string;
  readonly #o: ProxyStreamWriterOptions;
  #next = 0;
  #durationSec = 0;
  #size = 0;
  #hasInit = false;
  #ended = false;
  readonly #parts: string[] = [];

  constructor(o: ProxyStreamWriterOptions) {
    this.#o = o;
    this.id = o.id ?? newStreamId();
  }

  get segments(): number {
    return this.#next;
  }

  async #upload(bytes: Uint8Array): Promise<StreamPart> {
    const { store, hasher } = this.#o;
    const manifest = await hashSource(bytesSource(bytes), hasher);
    await uploadMedia({ store, hasher, source: bytesSource(bytes), manifest, contentType: "video/mp4", ...this.#o.upload });
    return { hash: manifest.hash, size: manifest.size };
  }

  async init(bytes: Uint8Array): Promise<StreamPart> {
    if (this.#hasInit) throw new Error("the stream already has its init segment");
    const part = await this.#upload(bytes);
    await putOnce(this.#o.store, streamInitKey(this.id), part);
    this.#hasInit = true;
    this.#size += part.size;
    this.#parts.push(part.hash);
    return part;
  }

  /** The next media segment. Its entry is written only after its bytes are in the store. */
  async segment(bytes: Uint8Array, durationSec: number): Promise<StreamSegment> {
    if (!this.#hasInit) throw new Error("the init segment comes first");
    if (this.#ended) throw new Error("the stream has ended");
    if (!isSeconds(durationSec)) throw new RangeError(`bad segment duration ${durationSec}`);
    const index = this.#next;
    const part = await this.#upload(bytes);
    const seg: StreamSegment = { ...part, index, durationSec, at: Date.now() };
    await putOnce(this.#o.store, streamSegmentKey(this.id, index), seg);
    this.#next++;
    this.#durationSec += durationSec;
    this.#size += part.size;
    this.#parts.push(part.hash);
    return seg;
  }

  async end(): Promise<StreamEnd> {
    if (!this.#hasInit) throw new Error("a stream needs its init segment");
    const end: StreamEnd = { segments: this.#next, durationSec: this.#durationSec, size: this.#size, at: Date.now(), parts: this.#parts.slice() };
    await putOnce(this.#o.store, streamEndKey(this.id), end);
    this.#ended = true;
    return end;
  }
}

export interface ProxyStreamReaderOptions {
  store: BlobStore;
  /** Reads (and verifies, and caches) the segments' bytes. */
  media: MediaReader;
  id: string;
  /** First wait for a segment that isn't up yet; doubles up to maxPollMs. */
  pollMs?: number;
  maxPollMs?: number;
  /** Report a segment that never verifies as damaged (bad/<stream>), so the owner's next share makes a new stream. */
  reportDamage?: boolean;
}

export type PlayedPart = { part: "init"; bytes: Uint8Array } | { part: "segment"; segment: StreamSegment; bytes: Uint8Array };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reads a stream, from its first segment on, waiting for the segments that aren't up yet. */
export class ProxyStreamReader {
  readonly id: string;
  readonly #o: ProxyStreamReaderOptions;
  #init: StreamPart | null = null;
  readonly #segments: StreamSegment[] = []; // entries are immutable: 0..n-1 known so far
  #end: StreamEnd | null = null;
  // Entries are fetched one caller at a time: two overlapping fetches would both append the same entry.
  #filling: Promise<unknown> = Promise.resolve();

  constructor(o: ProxyStreamReaderOptions) {
    if (!isMediaHash(o.id)) throw new TypeError(`not a stream id: ${o.id}`);
    this.#o = o;
    this.id = o.id;
  }

  async initPart(): Promise<StreamPart | null> {
    this.#init ??= asPart(await getJson(this.#o.store, streamInitKey(this.id)));
    return this.#init;
  }

  async end(): Promise<StreamEnd | null> {
    this.#end ??= asEnd(await getJson(this.#o.store, streamEndKey(this.id)));
    return this.#end;
  }

  /** Entry `index` if it is up, else null. */
  async segment(index: number): Promise<StreamSegment | null> {
    if (index < this.#segments.length) return this.#segments[index];
    const fill = this.#filling.then(() => this.#fill(index));
    this.#filling = fill.catch(() => {});
    return fill;
  }

  async #fill(index: number): Promise<StreamSegment | null> {
    // Entries land in order, so fetch the ones before it first: the cache stays a prefix.
    while (this.#segments.length <= index) {
      const i = this.#segments.length;
      const seg = asSegment(await getJson(this.#o.store, streamSegmentKey(this.id, i)), i);
      if (!seg) return null;
      this.#segments.push(seg);
    }
    return this.#segments[index];
  }

  /** Every segment that is up now, in order. */
  async known(): Promise<StreamSegment[]> {
    while (await this.segment(this.#segments.length));
    return this.#segments.slice();
  }

  /** Waits until entry `index` is up; null once the stream has ended with fewer segments. */
  async waitFor(index: number, signal?: AbortSignal): Promise<StreamSegment | null> {
    let wait = this.#o.pollMs ?? 500;
    for (;;) {
      signal?.throwIfAborted();
      const seg = await this.segment(index);
      if (seg) return seg;
      const end = await this.end();
      if (end && end.segments <= index) return null;
      // The writer puts the end after every entry, so an entry missed just before the end was read may be up now.
      if (end && (await this.segment(index))) return this.#segments[index];
      if (end) {
        // The stream ended with this segment in it, yet an entry up to it can't be read: it will never appear.
        await this.#reportDamage({ entry: this.#segments.length });
        throw new StreamDamagedError(this.id, this.#segments.length);
      }
      await sleep(wait, signal);
      wait = Math.min(this.#o.maxPollMs ?? 4000, wait * 2);
    }
  }

  async #reportDamage(what: Record<string, unknown>): Promise<void> {
    if (this.#o.reportDamage === false) return;
    await this.#o.store.put(damagedKey(this.id), utf8.encode(JSON.stringify({ ...what, at: Date.now() })), { contentType: "application/json" }).catch(() => {});
  }

  async #bytes(part: StreamPart, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      return await this.#o.media.readVerified(part.hash, 0, part.size, signal);
    } catch (e) {
      if ((e as Error)?.name === "LeafMismatchError") await this.#reportDamage({ hash: part.hash });
      throw e;
    }
  }

  /**
   * The init segment, then each media segment from `from`, verified, in order, waiting for the ones still being
   * uploaded, until the stream ends. What a player appends to its source buffer.
   */
  async *play(opts: { from?: number; signal?: AbortSignal } = {}): AsyncGenerator<PlayedPart> {
    const { signal } = opts;
    let init = await this.initPart();
    let wait = this.#o.pollMs ?? 500;
    while (!init) {
      // The writer puts the init segment first; until then the stream is only claimed.
      await sleep(wait, signal);
      wait = Math.min(this.#o.maxPollMs ?? 4000, wait * 2);
      init = await this.initPart();
    }
    yield { part: "init", bytes: await this.#bytes(init, signal) };
    for (let i = opts.from ?? 0; ; i++) {
      const seg = await this.waitFor(i, signal);
      if (!seg) return;
      yield { part: "segment", segment: seg, bytes: await this.#bytes(seg, signal) };
    }
  }

  /**
   * The stream so far as an HLS playlist (fMP4 segments), for ffmpeg-based tools: an EVENT playlist that ffmpeg keeps
   * re-reading until it carries #EXT-X-ENDLIST. `urlFor` turns a media hash into the URL the tool fetches it from (the
   * loopback range server's /m/<hash>). Null until the init segment is up.
   */
  async playlist(urlFor: (hash: string) => string): Promise<string | null> {
    const init = await this.initPart();
    if (!init) return null;
    const segs = await this.known();
    const end = await this.end();
    if (end && segs.length < end.segments) {
      // Finished, yet an entry can't be read: a live-looking playlist would keep the tool waiting for good.
      if (!(await this.segment(segs.length))) {
        await this.#reportDamage({ entry: segs.length });
        throw new StreamDamagedError(this.id, segs.length);
      }
      return this.playlist(urlFor);
    }
    const target = Math.max(1, Math.ceil(Math.max(0, ...segs.map((s) => s.durationSec))));
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${target}`,
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-MAP:URI="${urlFor(init.hash)}"`,
    ];
    for (const s of segs) lines.push(`#EXTINF:${s.durationSec.toFixed(3)},`, urlFor(s.hash));
    if (end && end.segments <= segs.length) lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }
}

/**
 * Complete streams as one file each (init + segments, in order), keyed by stream id, for tools and players that want a
 * plain fragmented MP4 by range once the upload is done; anything else goes to `media`. A stream that hasn't ended yet
 * has no size, so it reads as unknown here (use `play` or `playlist` meanwhile).
 */
export function streamRangeSource(opts: { streams: (id: string) => ProxyStreamReader | null; media: RangeSource }): RangeSource {
  const layout = async (r: ProxyStreamReader): Promise<{ parts: StreamPart[]; size: number } | null> => {
    const end = await r.end();
    const init = await r.initPart();
    if (!end || !init) return null;
    const segs = await r.known();
    if (segs.length < end.segments) return null; // the end entry is up but an earlier entry isn't readable
    return { parts: [init, ...segs.slice(0, end.segments)], size: end.size };
  };
  return {
    async stat(id, signal): Promise<MediaStat | null> {
      const r = opts.streams(id);
      if (!r) return opts.media.stat(id, signal);
      const l = await layout(r);
      return l ? { size: l.size, contentType: "video/mp4" } : null;
    },
    async *read(id, offset, length, signal) {
      const r = opts.streams(id);
      if (!r) {
        yield* opts.media.read(id, offset, length, signal);
        return;
      }
      const l = await layout(r);
      if (!l) throw new Error(`stream ${id.slice(0, 12)} is not complete`);
      const end = Math.min(l.size, offset + length);
      let at = 0;
      for (const p of l.parts) {
        const from = Math.max(offset, at);
        const to = Math.min(end, at + p.size);
        if (from < to) yield* opts.media.read(p.hash, from - at, to - from, signal);
        at += p.size;
        if (at >= end) break;
      }
    },
  };
}

/** The proxy someone made of this source with this profile, if any: a whole object or a stream. */
export async function findProxy(store: BlobStore, sourceHash: string, profileId: string): Promise<ProxyPointer | null> {
  const v = await getJson(store, proxyPointerKey(sourceHash, profileId));
  if (!v || typeof v.encoder !== "string") return null;
  if (isMediaHash(v.stream) && isCount(v.at)) return { stream: v.stream, encoder: v.encoder, at: v.at };
  if (isMediaHash(v.hash) && isCount(v.size)) return { hash: v.hash, size: v.size, encoder: v.encoder };
  return null;
}

/**
 * The proxy of (source, profile) to reuse, or null when there is none or it should be made again: a whole object
 * that is gone, has the wrong size or was reported damaged; a stream reported damaged (itself, or one of its parts) or
 * abandoned (no end, nothing new for `staleMs`). Needs no encoder, so a machine that can't encode still reuses one.
 */
export async function usableProxy(
  store: BlobStore,
  sourceHash: string,
  profileId: string,
  opts: { staleMs?: number; now?: () => number } = {},
): Promise<ProxyPointer | null> {
  const { there, usable } = await check(store, sourceHash, profileId, opts.staleMs ?? STALE_MS, opts.now ?? Date.now);
  return usable ? there : null;
}

/**
 * The pointer and whether it is usable. A takeover writes the new pointer, then deletes the old stream's report: a
 * check that read the old pointer just before may find the report gone. So a pointer found usable is read again, and
 * a changed one checked anew (a few times; a pointer that keeps changing is judged as last read).
 */
async function check(
  store: BlobStore,
  sourceHash: string,
  profileId: string,
  staleMs: number,
  now: () => number,
): Promise<{ there: ProxyPointer | null; usable: boolean }> {
  let there = await findProxy(store, sourceHash, profileId);
  for (let round = 0; ; round++) {
    if (!there) return { there, usable: false };
    if (await replaceable(store, there, staleMs, now())) return { there, usable: false };
    const again = await findProxy(store, sourceHash, profileId);
    if (round >= 3 || samePointer(again, there)) return { there, usable: true };
    there = again;
  }
}

const samePointer = (a: ProxyPointer | null, b: ProxyPointer | null): boolean =>
  a === null || b === null ? a === b : "stream" in a ? "stream" in b && a.stream === b.stream : "hash" in b && a.hash === b.hash;

const STALE_MS = 10 * 60_000;

export interface ClaimResult {
  /** True: this caller makes the proxy, as `stream`. False: reuse `pointer`. */
  claimed: boolean;
  pointer: ProxyPointer;
}

/**
 * Claims the proxy of (source, profile) for a new stream, unless someone has one: a whole object, a finished stream,
 * or a live one (a segment or the claim itself newer than `staleMs`). A stream that stopped growing without ending (its
 * uploader died) or one a reader reported damaged is taken over.
 */
export async function claimProxyStream(
  store: BlobStore,
  sourceHash: string,
  profileId: string,
  encoder: string,
  opts: { staleMs?: number; now?: () => number; id?: string } = {},
): Promise<ClaimResult> {
  const now = opts.now ?? Date.now;
  const key = proxyPointerKey(sourceHash, profileId);
  const mine: ProxyPointer = { stream: opts.id ?? newStreamId(), encoder, at: now() };
  const body = utf8.encode(JSON.stringify(mine));
  await store.put(key, body, { contentType: "application/json", ifAbsent: true });
  const { there, usable } = await check(store, sourceHash, profileId, opts.staleMs ?? STALE_MS, now);
  if (there && "stream" in there && there.stream === (mine as { stream: string }).stream) return { claimed: true, pointer: mine };
  if (there && usable) return { claimed: false, pointer: there };
  // Unreadable, abandoned or damaged: take it over. Two takers at once both write; the last one's pointer wins and the
  // other one's stream is simply never pointed at.
  await store.put(key, body, { contentType: "application/json" });
  // The replaced stream's report did its job: nothing points at it now. (An object's report stays until an upload
  // replaces the object: other media may share its bytes.)
  if (there && "stream" in there) await store.delete(damagedKey(there.stream)).catch(() => {});
  return { claimed: true, pointer: mine };
}

async function replaceable(store: BlobStore, p: ProxyPointer, staleMs: number, now: number): Promise<boolean> {
  if ("hash" in p) {
    if ((await store.head(damagedKey(p.hash))) !== null) return true;
    return (await store.head(mediaKey(p.hash)))?.size !== p.size;
  }
  if ((await store.head(damagedKey(p.stream))) !== null) return true;
  // Finished: kept unless a part was reported (its end lists them).
  const end = await getJson(store, streamEndKey(p.stream));
  if (end !== null) return partDamaged(store, p.stream, asEnd(end));
  // Live: a tool reading its segments through the playlist reports bad/<hash> too (its entries are read only then).
  if (await partDamaged(store, p.stream, null)) return true;
  // Live if anything happened lately: the newest entry, or the claim itself.
  let latest = p.at;
  // Entry keys sort in segment order; stores list a page at a time.
  let newest: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await store.list(`ps/${p.stream}/s/`, { cursor });
    for (const b of page.blobs) if (newest === undefined || b.key > newest) newest = b.key;
    cursor = page.cursor;
  } while (cursor);
  if (newest) {
    const v = await getJson(store, newest);
    if (v && isCount(v.at)) latest = Math.max(latest, v.at);
  }
  return now - latest > staleMs;
}

/**
 * Whether a reader reported one of the stream's parts damaged: a tool reading a segment through the range server's
 * /m/<hash> writes bad/<hash>, not bad/<stream>. Reports are rare (an object's goes once an upload replaces it, a
 * stream's once its pointer is taken over), so list them first; then the end entry says which are this stream's.
 */
async function partDamaged(store: BlobStore, stream: string, end: StreamEnd | null): Promise<boolean> {
  const bad = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.list("bad/", { cursor });
    for (const b of page.blobs) bad.add(b.key.slice(4));
    cursor = page.cursor;
  } while (cursor);
  if (bad.size === 0) return false;
  if (end?.parts) return end.parts.some((h) => bad.has(h));
  // A live stream, or an end written before it listed its parts: read the entries.
  const init = await getJson(store, streamInitKey(stream));
  if (init && bad.has(init.hash as string)) return true;
  cursor = undefined;
  do {
    const page = await store.list(`ps/${stream}/s/`, { cursor });
    for (const b of page.blobs) {
      const v = await getJson(store, b.key);
      if (v && bad.has(v.hash as string)) return true;
    }
    cursor = page.cursor;
  } while (cursor);
  return false;
}
