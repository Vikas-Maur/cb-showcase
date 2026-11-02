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
//
// Through a Carton host (cf-proxy-path) the same layout goes up and comes down in batches, one request each: the
// writer queues parts and sends what is queued while the encoder goes on (`StreamAppender`, POST /streams/<id>/append:
// ten requests per segment before, one after another), and the reader asks for the init and first segment, then for
// up to READ_BATCH_BYTES at a time, the host holding the answer at the live edge (`StreamBatchReader`, GET
// /streams/<id>/read: six requests per segment before). Bytes that come in a batch are verified against the manifest
// that came with them (MediaReader.adopt) and read the usual way when they don't verify. A store without these (any
// BlobStore, a host from before them) gets the part-by-part path, which reads and writes the same stream.

import { isMediaHash, toHex } from "./bytes.ts";
import { decodeManifest, type Manifest } from "./manifest.ts";
import type { BlobStore, Hasher } from "./contracts.ts";
import { bytesSource, hashSource } from "./hash.ts";
import { mediaKey, proxyPointerKey, streamEndKey, streamInitKey, streamSegmentKey, type ProxyPointer } from "./keys.ts";
import type { MediaStat, RangeSource } from "./range-source.ts";
import type { LeafCache } from "./cache.ts";
import { isDamaged, reportDamage } from "./damage.ts";
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
   * The hashes of its parts, init first, then the segments in order: the whole stream's content in one entry. Absent in
   * ends written before it was added.
   */
  parts?: string[];
  /**
   * The parts' sizes (in `parts`' order) and the segments' durations: with `parts`, every entry a reader needs, so a
   * finished stream's layout is this one entry instead of one per segment (cf-proxy-path). Absent in older ends.
   */
  sizes?: number[];
  durations?: number[];
}

/**
 * Waits for a damage report to settle (its errors ignored: reports are best effort) unless `signal` aborts first. The
 * report itself goes on: cancelling a read stops waiting for it, not the report.
 */
async function whileNotAborted(report: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  const settled = report.then(
    () => {},
    () => {},
  );
  if (!signal) return settled;
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([settled, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  return b ? parseJson(b) : null;
}

function parseJson(b: Uint8Array): Record<string, unknown> | null {
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
  if (!(v && isCount(v.segments) && isSeconds(v.durationSec) && isCount(v.size) && isCount(v.at))) return null;
  const parts = Array.isArray(v.parts) && v.parts.length === v.segments + 1 && v.parts.every(isMediaHash) ? (v.parts as string[]) : undefined;
  const end: StreamEnd = { segments: v.segments, durationSec: v.durationSec, size: v.size, at: v.at, ...(parts ? { parts } : {}) };
  // sizes and durations only beside the parts they describe, and only when they add up
  if (parts && Array.isArray(v.sizes) && v.sizes.length === parts.length && v.sizes.every(isCount) && (v.sizes as number[]).reduce((a, b) => a + b, 0) === end.size) end.sizes = v.sizes as number[];
  if (end.sizes && Array.isArray(v.durations) && v.durations.length === v.segments && v.durations.every(isSeconds)) end.durations = v.durations as number[];
  if (!end.durations) delete end.sizes; // one without the other describes no entry
  return end;
}

/** A stream's init entry (`{hash, size}`) from its parsed JSON, or null when it isn't one. */
export const streamPartOf = (v: unknown): StreamPart | null => asPart(isObject(v) ? v : null);
/** Segment entry `index` from its parsed JSON, or null when it isn't that entry. */
export const streamSegmentOf = (v: unknown, index: number): StreamSegment | null => asSegment(isObject(v) ? v : null, index);
/** A stream's end entry from its parsed JSON, or null when it isn't one. */
export const streamEndOf = (v: unknown): StreamEnd | null => asEnd(isObject(v) ? v : null);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The encoded manifest an entry carries (`manifest`, base64; entries from before it have none), or null. */
export function entryManifest(v: unknown): Uint8Array | null {
  const m = isObject(v) ? v.manifest : undefined;
  if (typeof m !== "string" || m.length > 64 * 1024) return null;
  return fromBase64(m);
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
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
  /**
   * Publishing through a store that appends a stream in one request (`StreamAppender`: a Carton host's
   * POST /streams/<id>/append): parts are queued and sent in batches, one request each, while the next ones encode.
   * `false` publishes part by part as through any store. Limits per request, and how much may wait in memory before
   * `segment()` waits for the uploads (the encoder's back-pressure).
   */
  batch?: false | { maxParts?: number; maxBytes?: number; maxQueuedBytes?: number };
}

/**
 * A store that publishes a stream's parts in one request: bytes, manifest and entry of each, and the end (a Carton
 * host's POST /streams/<id>/append, `@carton/host-http/client`). Not part of BlobStore: looked for, as `heads` is.
 */
export interface StreamAppender {
  appendStream(stream: string, batch: StreamAppendBatch, signal?: AbortSignal): Promise<void>;
}
export interface StreamAppendBatch {
  /** In order: the init segment first (once), then consecutive segments. */
  parts: StreamAppendPart[];
  /** Written once every part of this batch is in. */
  end?: StreamEnd;
}
export interface StreamAppendPart {
  kind: "init" | "segment";
  hash: string;
  size: number;
  /** The encoded manifest (`hash` is its digest). */
  manifest: Uint8Array;
  /** The bytes; null when the store holds them already (the host checks, else StreamPartMissingError). */
  bytes: Uint8Array | null;
  index?: number;
  durationSec?: number;
  at?: number;
}
export const isStreamAppender = (s: BlobStore): s is BlobStore & StreamAppender => typeof (s as Partial<StreamAppender>).appendStream === "function";

/** The host has no stream routes (one from before them): use the part-by-part path, as through any store. */
export class StreamRouteMissingError extends Error {
  override name = "StreamRouteMissingError";
}
/** A part sent without its bytes (they were in the store) is gone, or reported damaged: send it again with them. */
export class StreamPartMissingError extends Error {
  override name = "StreamPartMissingError";
}

type Queued = { part: StreamAppendPart } | { end: StreamEnd };

/** Stores whose host answered that it has no stream routes: part by part from then on. */
const noAppend = new WeakSet<BlobStore>();

const BATCH_PARTS = 16;
const BATCH_BYTES = 4 << 20;
const QUEUED_BYTES = 12 << 20;

/** Errors a retry can't fix: a cancel, the host's refusal (4xx but a timeout or a rate limit), or a route to switch. */
function final(e: unknown): boolean {
  const name = (e as Error)?.name;
  if (name === "AbortError" || e instanceof StreamRouteMissingError || e instanceof StreamPartMissingError) return true;
  const status = (e as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Appends a stream: the init segment, then media segments in order, then the end. One writer per stream.
 *
 * Through a `StreamAppender` (a Carton host) the parts are queued and go up in batches, one request each: `init` and
 * `segment` return once the part is queued (and the queue isn't over its limit), so the encoder goes on while the
 * previous batch uploads, and whatever queued meanwhile goes in the next request. A failed batch fails the next call
 * (`segment`, `end`). `segments` counts the segments the store holds. Through any other store each part goes up as its
 * own upload and entry, and each call returns once its entry is written.
 */
export class ProxyStreamWriter {
  readonly id: string;
  readonly #o: ProxyStreamWriterOptions;
  #next = 0;
  #durationSec = 0;
  #size = 0;
  #hasInit = false;
  #ended = false;
  readonly #parts: string[] = [];
  readonly #sizes: number[] = [];
  readonly #durations: number[] = [];
  // batched publishing (a StreamAppender)
  #appender: StreamAppender | null;
  readonly #queue: Queued[] = [];
  #queuedBytes = 0;
  #flushing: Promise<void> | null = null;
  #failure: { error: unknown } | null = null;
  #published = 0;
  /** Look for parts already in the store before sending a batch: the first one with a segment, and on while it finds some. */
  #probe = true;
  #waiters: (() => void)[] = [];

  constructor(o: ProxyStreamWriterOptions) {
    this.#o = o;
    this.id = o.id ?? newStreamId();
    this.#appender = o.batch !== false && isStreamAppender(o.store) && !noAppend.has(o.store) ? o.store : null;
  }

  /** Segments the store holds entries for. */
  get segments(): number {
    return this.#published;
  }

  async #manifest(bytes: Uint8Array): Promise<Manifest> {
    return hashSource(bytesSource(bytes), this.#o.hasher);
  }

  async #uploadLegacy(bytes: Uint8Array, manifest: Manifest): Promise<void> {
    const { store, hasher } = this.#o;
    await uploadMedia({ store, hasher, source: bytesSource(bytes), manifest, contentType: "video/mp4", ...this.#o.upload });
  }

  async init(bytes: Uint8Array): Promise<StreamPart> {
    if (this.#hasInit) throw new Error("the stream already has its init segment");
    this.#throwIfFailed();
    const manifest = await this.#manifest(bytes);
    const part: StreamPart = { hash: manifest.hash, size: manifest.size };
    if (this.#appender) {
      this.#hasInit = true;
      this.#record(part);
      await this.#enqueue({ part: { kind: "init", ...part, manifest: manifest.bytes, bytes } });
      return part;
    }
    await this.#uploadLegacy(bytes, manifest);
    await putOnce(this.#o.store, streamInitKey(this.id), { ...part, manifest: toBase64(manifest.bytes) });
    this.#hasInit = true;
    this.#record(part);
    return part;
  }

  #record(part: StreamPart, durationSec?: number): void {
    this.#size += part.size;
    this.#parts.push(part.hash);
    this.#sizes.push(part.size);
    if (durationSec !== undefined) {
      this.#durationSec += durationSec;
      this.#durations.push(durationSec);
    }
  }

  /** The next media segment. Its entry is written only after its bytes are in the store. */
  async segment(bytes: Uint8Array, durationSec: number): Promise<StreamSegment> {
    if (!this.#hasInit) throw new Error("the init segment comes first");
    if (this.#ended) throw new Error("the stream has ended");
    if (!isSeconds(durationSec)) throw new RangeError(`bad segment duration ${durationSec}`);
    this.#throwIfFailed();
    const index = this.#next;
    const manifest = await this.#manifest(bytes);
    const seg: StreamSegment = { hash: manifest.hash, size: manifest.size, index, durationSec, at: Date.now() };
    if (this.#appender) {
      this.#next++;
      this.#record(seg, durationSec);
      await this.#enqueue({ part: { kind: "segment", hash: seg.hash, size: seg.size, manifest: manifest.bytes, bytes, index, durationSec, at: seg.at } });
      return seg;
    }
    await this.#uploadLegacy(bytes, manifest);
    await putOnce(this.#o.store, streamSegmentKey(this.id, index), { ...seg, manifest: toBase64(manifest.bytes) });
    this.#next++;
    this.#published++;
    this.#record(seg, durationSec);
    return seg;
  }

  async end(): Promise<StreamEnd> {
    if (!this.#hasInit) throw new Error("a stream needs its init segment");
    this.#throwIfFailed();
    const end: StreamEnd = {
      segments: this.#next,
      durationSec: this.#durationSec,
      size: this.#size,
      at: Date.now(),
      parts: this.#parts.slice(),
      sizes: this.#sizes.slice(),
      durations: this.#durations.slice(),
    };
    if (this.#appender || this.#queue.length || this.#flushing) {
      this.#ended = true;
      this.#queue.push({ end });
      this.#kick();
      await this.flush();
      return end;
    }
    await putOnce(this.#o.store, streamEndKey(this.id), end);
    this.#ended = true;
    return end;
  }

  /** Waits until everything queued is in the store (or throws the failure that stopped it). */
  async flush(): Promise<void> {
    while ((this.#queue.length || this.#flushing) && !this.#failure) await this.#changed();
    this.#throwIfFailed();
  }

  #throwIfFailed(): void {
    if (this.#failure) throw this.#failure.error;
  }

  #changed(): Promise<void> {
    return new Promise((r) => this.#waiters.push(r));
  }

  #notify(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const r of w) r();
  }

  async #enqueue(item: Queued): Promise<void> {
    this.#queue.push(item);
    if ("part" in item) this.#queuedBytes += item.part.size;
    this.#kick();
    // The encoder's back-pressure: past the limit, wait for the uploads (ffmpeg keeps its output on disk meanwhile).
    const max = (this.#o.batch && this.#o.batch.maxQueuedBytes) || QUEUED_BYTES;
    while (this.#queuedBytes > max && !this.#failure) await this.#changed();
    this.#throwIfFailed();
  }

  #kick(): void {
    if (this.#flushing || this.#failure || !this.#queue.length) return;
    this.#flushing = this.#flush().finally(() => {
      this.#flushing = null;
      this.#notify();
      this.#kick(); // queued while the last batch was settling
    });
  }

  async #flush(): Promise<void> {
    const limits = this.#o.batch || {};
    const maxParts = limits.maxParts ?? BATCH_PARTS, maxBytes = limits.maxBytes ?? BATCH_BYTES;
    while (this.#queue.length && !this.#failure) {
      // what is queued now, up to the limits (always at least one part), and the end if it is next
      const parts: StreamAppendPart[] = [];
      let bytes = 0, taken = 0, end: StreamEnd | undefined;
      for (const q of this.#queue) {
        if ("end" in q) {
          end = q.end;
          taken++;
          break;
        }
        if (parts.length && (parts.length >= maxParts || bytes + q.part.size > maxBytes)) break;
        parts.push(q.part);
        bytes += q.part.size;
        taken++;
      }
      try {
        await this.#send(parts, end);
      } catch (e) {
        this.#failure = { error: e };
        this.#notify();
        return;
      }
      this.#queue.splice(0, taken);
      this.#queuedBytes -= bytes;
      this.#published += parts.filter((p) => p.kind === "segment").length;
      this.#notify();
    }
  }

  async #send(parts: StreamAppendPart[], end?: StreamEnd): Promise<void> {
    const signal = this.#o.upload?.signal;
    if (this.#appender) {
      const batch = parts.map((p) => ({ ...p }));
      if (this.#probe && batch.some((p) => p.kind === "segment")) await this.#skipStored(batch);
      try {
        await this.#retry(() => this.#appender!.appendStream(this.id, { parts: batch, ...(end ? { end } : {}) }, signal));
        return;
      } catch (e) {
        if (e instanceof StreamPartMissingError) {
          // a part it found stored went away since (or a reader reported it): send every byte
          this.#probe = false;
          await this.#retry(() => this.#appender!.appendStream(this.id, { parts, ...(end ? { end } : {}) }, signal));
          return;
        }
        if (!(e instanceof StreamRouteMissingError)) throw e;
        // a host from before the route: part by part, as through any store
        noAppend.add(this.#o.store);
        this.#appender = null;
      }
    }
    for (const p of parts) {
      const manifest = await decodeManifest(p.manifest, this.#o.hasher, p.hash);
      await this.#uploadLegacy(p.bytes!, manifest);
      if (p.kind === "init") await putOnce(this.#o.store, streamInitKey(this.id), { hash: p.hash, size: p.size, manifest: toBase64(p.manifest) });
      else await putOnce(this.#o.store, streamSegmentKey(this.id, p.index!), { hash: p.hash, size: p.size, index: p.index, durationSec: p.durationSec, at: p.at, manifest: toBase64(p.manifest) });
    }
    if (end) await putOnce(this.#o.store, streamEndKey(this.id), end);
  }

  /**
   * Dedup, as an upload's head does: parts the store already holds (a takeover re-encoding the same source makes the
   * same segments) go without their bytes, the host checking they are there. One `heads` request for the batch, and
   * only while it keeps finding segments, so a new stream pays it once.
   */
  async #skipStored(batch: StreamAppendPart[]): Promise<void> {
    const many = this.#o.store as BlobStore & ManyHeads;
    if (typeof many.heads !== "function") {
      this.#probe = false;
      return;
    }
    let got: ({ size: number } | null)[];
    try {
      got = await many.heads(batch.map((p) => mediaKey(p.hash)));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      this.#probe = false; // the bytes go, as they would have anyway
      return;
    }
    let found = false;
    batch.forEach((p, i) => {
      if (got[i]?.size !== p.size) return;
      p.bytes = null;
      if (p.kind === "segment") found = true;
    });
    if (!found) this.#probe = false;
  }

  async #retry<T>(fn: () => Promise<T>): Promise<T> {
    const retries = this.#o.upload?.retries ?? 4, signal = this.#o.upload?.signal;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await fn();
      } catch (e) {
        if (final(e) || signal?.aborted || attempt >= retries) throw e;
        const base = (this.#o.upload?.retryDelayMs ?? 250) * 2 ** attempt;
        await sleep(base / 2 + Math.random() * base, signal);
      }
    }
  }
}

/**
 * A store that reads a stream in batches: entries, manifests and bytes of several parts in one request, and, at the
 * live edge, an answer held until the next part is up (a Carton host's GET /streams/<id>/read,
 * `@carton/host-http/client`). Not part of BlobStore: looked for.
 */
export interface StreamBatchReader {
  readStream(stream: string, o: StreamReadOptions): AsyncGenerator<StreamReadItem>;
}
export interface StreamReadOptions {
  /** The first segment wanted. */
  from: number;
  /** The init segment too, first. */
  init?: boolean;
  /** Bytes to send at most (at least one part's, when there is one); 0: entries only. */
  maxBytes?: number;
  /** Entries to list at most (the host may list fewer). */
  maxParts?: number;
  /** How long the host may hold the answer while the first part asked for isn't up yet, ms. */
  waitMs?: number;
  signal?: AbortSignal;
}
/**
 * The parts in order, each with its manifest (null: none came) and bytes (null: not sent; read them the usual way),
 * then one `status`: the end entry if the host looked (it does when it reached a part that isn't up), and whether the
 * init segment asked for is missing (the stream is only claimed).
 */
export type StreamReadItem =
  | { kind: "init"; part: StreamPart; manifest: Uint8Array | null; bytes: Uint8Array | null }
  | { kind: "segment"; segment: StreamSegment; manifest: Uint8Array | null; bytes: Uint8Array | null }
  | { kind: "status"; end?: StreamEnd | null; initMissing?: boolean };
export const isStreamBatchReader = (s: BlobStore): s is BlobStore & StreamBatchReader => typeof (s as Partial<StreamBatchReader>).readStream === "function";

/** Stores whose host has no stream routes: entry by entry from then on. */
const noBatchRead = new WeakSet<BlobStore>();

/** The first batch is one segment (the first frame waits for nothing more); later ones up to this many bytes. */
const READ_BATCH_BYTES = 4 << 20;
/** How long a live reader's request may wait at the edge for the next segment. */
const READ_WAIT_MS = 20_000;
/** A batch read's look at the end answers `end()` for this long (a wait loop asks for the entry, then the end). */
const END_FRESH_MS = 1000;

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
  /**
   * Where the stream's entries are kept once read, beside the segments' leaves, so a stream played once replays with
   * the store unreachable (e2e S5-6). Entries are written once, so a kept one is never stale. Default: `media`'s cache.
   */
  cache?: LeafCache;
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
  /** When a batch read last looked for the end (and found `#end`): `end()` takes that answer for a moment instead of asking. */
  #endSeenAt = -Infinity;
  // Entries are fetched one caller at a time: two overlapping fetches would both append the same entry.
  #filling: Promise<unknown> = Promise.resolve();

  constructor(o: ProxyStreamReaderOptions) {
    if (!isMediaHash(o.id)) throw new TypeError(`not a stream id: ${o.id}`);
    this.#o = o;
    this.id = o.id;
  }

  get #cache(): LeafCache | undefined {
    return this.#o.cache ?? this.#o.media.cache;
  }

  /**
   * An entry, as `as` reads it: from the cache, else from the store (and then kept). Only entries that read as valid
   * are kept, and a kept one that doesn't is read from the store again; absent ones aren't kept: they may yet appear.
   */
  async #entry<T>(key: string, as: (v: Record<string, unknown> | null) => T | null): Promise<T | null> {
    const kept = await this.#kept(key, as);
    if (kept) return kept;
    const b = await this.#o.store.get(key);
    const v = b && as(parseJson(b));
    if (v) await this.#cache?.putEntry?.(key, b).catch(() => {});
    return v || null;
  }

  async #kept<T>(key: string, as: (v: Record<string, unknown> | null) => T | null): Promise<T | null> {
    const b = await this.#cache?.getEntry?.(key).catch(() => null);
    return b ? as(parseJson(b)) : null;
  }

  async initPart(): Promise<StreamPart | null> {
    this.#init ??= await this.#entry(streamInitKey(this.id), asPart);
    return this.#init;
  }

  async end(): Promise<StreamEnd | null> {
    if (Date.now() - this.#endSeenAt < END_FRESH_MS) return this.#end;
    this.#end ??= await this.#entry(streamEndKey(this.id), asEnd);
    this.#fromEnd();
    return this.#end;
  }

  /** The batch reader to use, if the store is one whose host has the route. */
  #batch(): StreamBatchReader | null {
    const s = this.#o.store;
    return isStreamBatchReader(s) && !noBatchRead.has(s) ? s : null;
  }

  /**
   * An end that lists its parts with their sizes and durations holds every entry: the init and the segments not known
   * yet come from it, with no request per entry.
   */
  #fromEnd(): void {
    const e = this.#end;
    if (!e?.parts || !e.sizes || !e.durations) return;
    this.#init ??= { hash: e.parts[0]!, size: e.sizes[0]! };
    for (let i = this.#segments.length; i < e.segments; i++) this.#segments.push({ hash: e.parts[i + 1]!, size: e.sizes[i + 1]!, index: i, durationSec: e.durations[i]!, at: e.at });
  }

  /** Takes in an entry a batch read brought: kept (so it replays offline), and known if it extends the prefix. */
  async #learn(seg: StreamSegment, manifest: Uint8Array | null): Promise<void> {
    if (seg.index === this.#segments.length) this.#segments.push(seg);
    const json = { ...seg, ...(manifest ? { manifest: toBase64(manifest) } : {}) };
    await this.#cache?.putEntry?.(streamSegmentKey(this.id, seg.index), utf8.encode(JSON.stringify(json))).catch(() => {});
  }

  async #learnEnd(end: StreamEnd | null | undefined): Promise<void> {
    if (end === undefined) return;
    this.#endSeenAt = Date.now();
    if (!end || this.#end) return;
    this.#end = end;
    await this.#cache?.putEntry?.(streamEndKey(this.id), utf8.encode(JSON.stringify(end))).catch(() => {});
    this.#fromEnd();
  }

  /** Entry `index` if it is up, else null. */
  async segment(index: number): Promise<StreamSegment | null> {
    if (index < this.#segments.length) return this.#segments[index];
    const fill = this.#filling.then(() => this.#fill(index));
    this.#filling = fill.catch(() => {});
    return fill;
  }

  async #fill(index: number): Promise<StreamSegment | null> {
    // A kept end says where the stream stops, without asking the store (which may be unreachable) for one more entry.
    this.#end ??= await this.#kept(streamEndKey(this.id), asEnd);
    this.#fromEnd();
    if (index < this.#segments.length) return this.#segments[index];
    if (this.#end && index >= this.#end.segments) return null;
    const batch = this.#batch();
    if (batch) {
      // Entries only, as many as the host lists in one request, from the first one not known.
      try {
        for (;;) {
          const before = this.#segments.length;
          for await (const it of batch.readStream(this.id, { from: before, maxBytes: 0, maxParts: Math.max(1000, index + 1 - before) })) {
            if (it.kind === "segment") await this.#learn(it.segment, it.manifest);
            else if (it.kind === "status") await this.#learnEnd(it.end);
          }
          // up to it, or nothing more is up: done; else the host listed fewer than were there, so ask on
          if (index < this.#segments.length || this.#segments.length === before) return this.#segments[index] ?? null;
        }
      } catch (e) {
        if (!(e instanceof StreamRouteMissingError)) throw e;
        noBatchRead.add(this.#o.store);
      }
    }
    // Entries land in order, so fetch the ones before it first: the cache stays a prefix.
    while (this.#segments.length <= index) {
      const i = this.#segments.length;
      if (this.#end && i >= this.#end.segments) return null;
      const seg = await this.#entry(streamSegmentKey(this.id, i), (v) => asSegment(v, i));
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

  /**
   * A part of this stream failed verification (`"mismatch"`) or is gone (`"missing"`) where it was read as a plain
   * object (a tool following the playlist's segment URLs): report the stream, so the next share makes a new one. A
   * finished stream's parts never go away by design, so a missing one is damage too: a host that found the part damaged
   * removes it (team mode, S5-3), and the read after that sees no object rather than bad bytes. "missing" is checked
   * with a HEAD first, so a part that is back (or never left) isn't reported. Ignored, returning false, for a hash that
   * isn't one of its parts.
   */
  async reportPartDamage(hash: string, why: "mismatch" | "missing" = "mismatch"): Promise<boolean> {
    // Parts already read first: a tool reports a segment it got from this reader's playlist, so it is almost always
    // known, and the report mustn't hang on fetching entries (one more request that may fail).
    const isPart = (p: StreamPart | null) => p?.hash === hash;
    let mine = isPart(this.#init) || this.#segments.some(isPart);
    if (!mine) mine = isPart(await this.initPart().catch(() => null)) || (await this.known().catch(() => this.#segments.slice())).some(isPart);
    if (!mine) return false;
    if (why === "missing") {
      if ((await this.#o.store.head(mediaKey(hash))) !== null) return false;
      await this.#reportDamage({ hash, missing: true });
    } else await this.#reportDamage({ hash });
    return true;
  }

  async #reportDamage(what: Record<string, unknown>): Promise<void> {
    if (this.#o.reportDamage === false) return;
    await reportDamage(this.#o.store, this.id, what);
  }

  async #bytes(part: StreamPart, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      return await this.#o.media.readVerified(part.hash, 0, part.size, signal);
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "LeafMismatchError") await whileNotAborted(this.#reportDamage({ hash: part.hash }), signal);
      else if (name === "MediaMissingError") await whileNotAborted(this.reportPartDamage(part.hash, "missing"), signal);
      signal?.throwIfAborted();
      throw e;
    }
  }

  /**
   * The init segment, then each media segment from `from`, verified, in order, waiting for the ones still being
   * uploaded, until the stream ends. What a player appends to its source buffer.
   */
  async *play(opts: { from?: number; signal?: AbortSignal } = {}): AsyncGenerator<PlayedPart> {
    const batch = this.#batch();
    if (batch) yield* this.#playBatched(batch, opts.from ?? 0, opts.signal);
    else yield* this.#playEach(opts.from ?? 0, false, opts.signal);
  }

  /** Part by part: each entry, then its manifest and bytes through the media reader. */
  async *#playEach(from: number, initDone: boolean, signal?: AbortSignal): AsyncGenerator<PlayedPart> {
    if (!initDone) {
      let init = await this.initPart();
      let wait = this.#o.pollMs ?? 500;
      while (!init) {
        // The writer puts the init segment first; until then the stream is only claimed.
        await sleep(wait, signal);
        wait = Math.min(this.#o.maxPollMs ?? 4000, wait * 2);
        init = await this.initPart();
      }
      yield { part: "init", bytes: await this.#bytes(init, signal) };
    }
    for (let i = from; ; i++) {
      const seg = await this.waitFor(i, signal);
      if (!seg) return;
      yield { part: "segment", segment: seg, bytes: await this.#bytes(seg, signal) };
    }
  }

  /** A part's bytes from the cache alone (every leaf kept, as a played stream's are), else null. */
  async #cachedBytes(part: StreamPart): Promise<Uint8Array | null> {
    const b = await this.#o.media.cached(part.hash).catch(() => null);
    return b && b.length === part.size ? b : null;
  }

  /** A part a batch brought: its bytes if they verify against its manifest (and kept), else read the usual way. */
  async #accept(part: StreamPart, manifest: Uint8Array | null, bytes: Uint8Array | null, signal?: AbortSignal): Promise<Uint8Array> {
    if (manifest && bytes && (await this.#o.media.adopt(part.hash, manifest, bytes))) return bytes;
    return this.#bytes(part, signal); // repairs, and reports what never verifies
  }

  /**
   * Batch by batch (a StreamBatchReader): what this process has kept first, then one request for the init segment and
   * the first segment (the first frame waits for nothing more), then requests of up to READ_BATCH_BYTES, each held by
   * the host at the live edge until the next segment is up. A host without the route: part by part from there on.
   */
  async *#playBatched(batch: StreamBatchReader, from: number, signal?: AbortSignal): AsyncGenerator<PlayedPart> {
    let i = from;
    let initDone = false;
    const keptInit = this.#init ?? (await this.#kept(streamInitKey(this.id), asPart));
    const initBytes = keptInit && (await this.#cachedBytes(keptInit));
    if (initBytes) {
      this.#init ??= keptInit;
      yield { part: "init", bytes: initBytes };
      initDone = true;
    }
    let first = true;
    let failures = 0;
    let missingAt = -1;
    let wait = this.#o.pollMs ?? 500;
    for (;;) {
      signal?.throwIfAborted();
      if (initDone) {
        // kept segments play without a request (offline too)
        for (;;) {
          const seg = this.#segments[i] ?? (await this.#kept(streamSegmentKey(this.id, i), (v) => asSegment(v, i)));
          const bytes = seg && (await this.#cachedBytes(seg));
          if (!bytes) break;
          if (seg.index === this.#segments.length) this.#segments.push(seg);
          yield { part: "segment", segment: seg, bytes };
          i++;
        }
        this.#end ??= await this.#kept(streamEndKey(this.id), asEnd);
        this.#fromEnd();
        if (this.#end && i >= this.#end.segments) return;
      }
      let got = 0, initMissing = false, sawEnd: StreamEnd | null | undefined;
      const t0 = Date.now();
      try {
        for await (const it of batch.readStream(this.id, { from: i, init: !initDone, maxBytes: first ? 1 : READ_BATCH_BYTES, waitMs: READ_WAIT_MS, signal })) {
          if (it.kind === "init") {
            if (initDone) continue;
            this.#init ??= it.part;
            await this.#cache?.putEntry?.(streamInitKey(this.id), utf8.encode(JSON.stringify(it.part))).catch(() => {});
            yield { part: "init", bytes: await this.#accept(it.part, it.manifest, it.bytes, signal) };
            initDone = true;
          } else if (it.kind === "segment") {
            if (it.segment.index !== i) throw new Error(`stream ${this.id.slice(0, 12)}: the host answered segment ${it.segment.index} for ${i}`);
            await this.#learn(it.segment, it.manifest);
            yield { part: "segment", segment: it.segment, bytes: await this.#accept(it.segment, it.manifest, it.bytes, signal) };
            i++;
            got++;
          } else {
            initMissing = !!it.initMissing;
            sawEnd = it.end;
            await this.#learnEnd(it.end);
          }
        }
        failures = 0;
      } catch (e) {
        if (e instanceof StreamRouteMissingError) {
          noBatchRead.add(this.#o.store);
          yield* this.#playEach(i, initDone, signal);
          return;
        }
        if (signal?.aborted || (e as Error)?.name === "AbortError" || (e as Error)?.name === "LeafMismatchError" || (e as Error)?.name === "MediaMissingError") throw e;
        // a dropped request: again, with the media reader's backoff
        const { retries, delayMs } = this.#o.media.retryPolicy;
        if (++failures > retries) throw e;
        await sleep(delayMs * 2 ** (failures - 1), signal);
        continue;
      }
      first = false;
      if (this.#end && i >= this.#end.segments) return;
      if (sawEnd && got === 0 && !initMissing) {
        // The stream ended with this segment in it, yet its entry wasn't there. The host read the entry before the end,
        // and the writer puts the end after every entry, so it may have landed in between: ask once more first.
        if (missingAt === i) {
          await this.#reportDamage({ entry: i });
          throw new StreamDamagedError(this.id, i);
        }
        missingAt = i;
        continue;
      }
      if (got > 0) wait = this.#o.pollMs ?? 500;
      else if (Date.now() - t0 < READ_WAIT_MS / 2) {
        // nothing new, and the host didn't hold the answer: don't spin
        await sleep(wait, signal);
        wait = Math.min(this.#o.maxPollMs ?? 4000, wait * 2);
      }
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
        if (from < to) {
          try {
            yield* opts.media.read(p.hash, from - at, to - from, signal);
          } catch (e) {
            const name = (e as Error)?.name;
            if (name === "LeafMismatchError") await whileNotAborted(r.reportPartDamage(p.hash), signal);
            else if (name === "MediaMissingError") await whileNotAborted(r.reportPartDamage(p.hash, "missing"), signal);
            signal?.throwIfAborted();
            throw e;
          }
        }
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
 * a changed one checked anew (a few times; a pointer that keeps changing is judged not usable).
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
    if (samePointer(again, there)) return { there, usable: true };
    // Still changing after a few rounds: don't vouch for any of them (the caller makes or claims one anew).
    if (round >= 3) return { there: again, usable: false };
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
  const isMine = (p: ProxyPointer | null) => p !== null && "stream" in p && p.stream === (mine as { stream: string }).stream;
  await store.put(key, body, { contentType: "application/json", ifAbsent: true });
  let first: ProxyPointer | null;
  try {
    first = await findProxy(store, sourceHash, profileId);
  } catch (e) {
    // The claim may be ours, yet the caller won't know it and nothing will write the stream: report it, so the next
    // claim takes it over instead of waiting for it to go stale. (A stream id nobody points at costs nothing.)
    await reportDamage(store, (mine as { stream: string }).stream, { unclaimed: true });
    throw e;
  }
  if (isMine(first)) return { claimed: true, pointer: mine };
  const { there, usable } = await check(store, sourceHash, profileId, opts.staleMs ?? STALE_MS, now);
  if (isMine(there)) return { claimed: true, pointer: mine };
  if (there && usable) return { claimed: false, pointer: there };
  // Unreadable, abandoned or damaged: take it over. Two takers at once both write; the last one's pointer wins and the
  // other one's stream is simply never pointed at.
  await store.put(key, body, { contentType: "application/json" });
  // The replaced stream's report stays (nothing is deleted, damage.ts): nothing points at that stream any more, and a
  // stream id is never reused.
  return { claimed: true, pointer: mine };
}

async function replaceable(store: BlobStore, p: ProxyPointer, staleMs: number, now: number): Promise<boolean> {
  if ("hash" in p) {
    if (await isDamaged(store, p.hash)) return true;
    return (await store.head(mediaKey(p.hash)))?.size !== p.size;
  }
  // A damaged part is reported against its stream wherever it is read as part of one (play, the playlist's segment
  // URLs, a whole-stream read): one HEAD, no listing, so the check works through any store (e2e S5-7).
  if (await isDamaged(store, p.stream)) return true;
  const endBytes = await store.get(streamEndKey(p.stream));
  if (endBytes !== null) {
    // Finished. A report covers damage someone read; a part that is gone is caught here, whoever removed it (a host
    // that found it damaged removes it, and a reader that then saw it missing may not have reported it): one HEAD per
    // part, so the check still needs no listing. What's wrong is reported, so later checks stop at the report.
    const wrong = await finishedWrong(store, p.stream, endBytes, now);
    if (wrong === null) return false;
    await reportDamage(store, p.stream, wrong);
    return true;
  }
  // Live if anything happened lately: the newest entry, or the claim itself.
  const newest = await newestEntry(store, p.stream);
  let latest = p.at;
  if (newest !== null) {
    const v = await getJson(store, streamSegmentKey(p.stream, newest));
    if (v && isCount(v.at)) latest = Math.max(latest, v.at);
  }
  return now - latest > staleMs;
}

/**
 * Finished streams found whole in this process, so the next check of the same stream skips the part checks: per store
 * object (what one store holds says nothing about another), by stream id and a digest of its end entry's bytes (an end
 * that changed, rot included, is checked anew), with when it was checked. A share asks up to 3 times (the clip's
 * record, the proxy, the claim), and a long stream has thousands of parts. A damage report still counts at once (it is
 * read before this); a part removed without one is found again after VERIFIED_MS. Bounded: the oldest entries go first.
 */
const verified = new WeakMap<BlobStore, Map<string, number>>();
const VERIFIED_MS = 10 * 60_000;
const VERIFIED_MAX = 1000;

/**
 * Stores whose `list` pages on the server (S3, R2): a page is one request, so a few pages beat thousands of HEADs. Not
 * blob-fs or blob-memory: they gather and sort the whole prefix for every page, while their HEADs are cheap and local.
 */
const LISTS_BY_PAGE = new Set(["s3", "r2"]);

/**
 * A store that answers many HEADs in one request: `hostMediaBlobs`'s `heads` (REQ-11, POST /blobs/heads), `{size}` or
 * null for each key, in order. Not part of BlobStore, so looked for (as `@carton/host-http/client`'s `hasHeads` does;
 * media can't import it: host-http depends on media).
 */
interface ManyHeads {
  heads?(keys: readonly string[]): Promise<({ size: number } | null)[]>;
}

/** Stores whose `list` failed on its first page: HEADs only from then on. */
const cannotList = new WeakSet<BlobStore>();

/** Why a finished stream can't be reused (its end unreadable, an entry or a part gone, sizes that don't add up), or null. */
async function finishedWrong(store: BlobStore, stream: string, endBytes: Uint8Array, now: number): Promise<Record<string, unknown> | null> {
  const end = asEnd(parseJson(endBytes));
  if (end === null) return { end: "unreadable" };
  const memo = `${stream} ${toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", endBytes as Uint8Array<ArrayBuffer>)))}`;
  let mine = verified.get(store);
  const seen = mine?.get(memo);
  if (seen !== undefined && now - seen >= 0 && now - seen < VERIFIED_MS) return null;
  const wrong = await partsWrong(store, stream, end);
  if (wrong === null) {
    if (!mine) verified.set(store, (mine = new Map()));
    mine.delete(memo);
    mine.set(memo, now);
    if (mine.size > VERIFIED_MAX) mine.delete(mine.keys().next().value!);
  }
  return wrong;
}

async function partsWrong(store: BlobStore, stream: string, end: StreamEnd): Promise<Record<string, unknown> | null> {
  let parts = end.parts;
  if (parts === undefined) {
    // An end written before it listed its parts: the entries say what they are.
    const init = asPart(await getJson(store, streamInitKey(stream)));
    if (init === null) return { entry: "init" };
    const segs = await inBatches(Array.from({ length: end.segments }, (_, i) => i), async (i) => asSegment(await getJson(store, streamSegmentKey(stream, i)), i));
    const gap = segs.findIndex((s) => s === null);
    if (gap >= 0) return { entry: gap };
    parts = [init.hash, ...segs.map((s) => s!.hash)];
  }
  const unique = [...new Set(parts)];
  const sizes = await partSizes(store, unique);
  for (const h of unique) if (!sizes.has(h)) return { hash: h, missing: true };
  const total = parts.reduce((n, h) => n + sizes.get(h)!, 0);
  return total === end.size ? null : { size: total, expected: end.size };
}

/**
 * The sizes of the parts that are in the store (a part that isn't has no entry). Parts are content-addressed objects
 * (m/<hash>) shared by every stream and clip, not kept under the stream's prefix, so a listing covers all of the
 * project's media. A Carton host answers many HEADs in one request (`heads`). Where the store pages its listing on the
 * server (LISTS_BY_PAGE), a few pages (at most one per 250 parts asked about, 1000 keys a page) settle the parts they
 * show, and HEADs ask about the rest. Any other store (blob-fs's list is a local walk) gets HEADs only.
 */
async function partSizes(store: BlobStore, hashes: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const many = store as BlobStore & ManyHeads;
  if (typeof many.heads === "function") {
    // A Carton host: up to 1,000 keys a request (the client asks again for the rest, and falls back to one HEAD per key
    // on a host from before the route).
    const got = await many.heads(hashes.map(mediaKey));
    if (got.length !== hashes.length) throw new Error(`heads answered ${got.length} of ${hashes.length} keys`);
    hashes.forEach((h, i) => {
      const b = got[i];
      if (b) sizes.set(h, b.size);
    });
    return sizes;
  }
  let rest: readonly string[] = hashes;
  if (LISTS_BY_PAGE.has(store.kind) && typeof store.list === "function" && !cannotList.has(store)) {
    const wanted = new Set(hashes);
    let cursor: string | undefined;
    let pages = 0;
    const budget = Math.max(1, Math.ceil(hashes.length / 250));
    try {
      while (pages < budget) {
        const page = await store.list("m/", { limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
        pages++;
        for (const b of page.blobs) {
          const h = b.key.startsWith("m/") ? b.key.slice(2) : "";
          if (wanted.has(h)) sizes.set(h, b.size);
        }
        cursor = page.cursor;
        if (cursor === undefined || sizes.size === wanted.size) break;
      }
    } catch {
      if (pages === 0) cannotList.add(store); // no list here: don't ask again
    }
    // Parts the pages didn't show get a HEAD each, even after a complete listing: a listing is not a snapshot (a part
    // put back while it ran may not be in it), and a false "missing" would end a sound stream. A whole stream leaves none.
    rest = hashes.filter((h) => !sizes.has(h));
  }
  const heads = await inBatches(rest, (h) => store.head(mediaKey(h)));
  rest.forEach((h, i) => {
    const head = heads[i];
    if (head) sizes.set(h, head.size);
  });
  return sizes;
}

/** `f` over `items`, at most 16 at a time, results in order. */
async function inBatches<T, R>(items: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, worker));
  return out;
}

/**
 * The index of a stream's newest segment entry, or null before the first. Entries are written in order without gaps,
 * so HEADs find it: doubling until one is missing, then halving (about 2·log2(n) of them), with no listing.
 */
async function newestEntry(store: BlobStore, stream: string): Promise<number | null> {
  const has = async (i: number) => (await store.head(streamSegmentKey(stream, i))) !== null;
  if (!(await has(0))) return null;
  let lo = 0; // present
  let hi = 1; // probed next
  const MAX = 999_999;
  while (hi <= MAX && (await has(hi))) {
    lo = hi;
    hi = Math.min(MAX + 1, hi * 2);
  }
  // lo is present, hi is missing (or past the last possible index).
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await has(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
