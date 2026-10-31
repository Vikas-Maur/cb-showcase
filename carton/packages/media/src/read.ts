// Range reads of shared media: play first, verify after (PLAN §11, R2-11).
//
// - Bytes are handed to the player as they arrive. Each 1 MiB leaf is checked against the manifest when its last byte
//   lands; verified leaves go into the range cache.
// - A leaf that fails after some of its bytes were handed out ends the read with LeafMismatchError (playback stops),
//   and the repair path has already fetched it again by then, so the player's retry is served from the cache. A leaf
//   that fails before any of its bytes were handed out is repaired silently.
// - Requests start small and grow (1, 2, 4 … leaves), so the first frame waits for one leaf, not a big window, and a
//   long read needs few round trips. The next request starts once the current one is flowing.
// - Whatever the cache holds is served from it, including when the link is down.

import { equalBytes } from "./bytes.ts";
import type { LeafCache } from "./cache.ts";
import type { BlobStore, Hasher } from "./contracts.ts";
import { manifestKey, mediaKey } from "./keys.ts";
import { decodeManifest, LEAF_SIZE, leafDigest, leafSpan, type Manifest } from "./manifest.ts";
import { LeafMismatchError, type MediaStat, type RangeSource } from "./range-source.ts";

/** The store has no such media (or not yet: a manifest goes up before its bytes are complete). */
export class MediaMissingError extends Error {
  override name = "MediaMissingError";
}

export type ReaderEvent = { type: "mismatch" | "repaired" | "repair-failed"; hash: string; leaf: number };

export interface MediaReaderOptions {
  store: BlobStore;
  hasher: Hasher;
  cache?: LeafCache;
  /** Largest request, in leaves. */
  maxWindowLeaves?: number;
  /** Fetches of one leaf that may fail verification before the read gives up. */
  repairAttempts?: number;
  /** Retries of a request that failed on the network. */
  retries?: number;
  retryDelayMs?: number;
  contentType?: (hash: string) => string | undefined;
  onEvent?: (e: ReaderEvent) => void;
}

interface Run {
  first: number;
  end: number;
  ctl: AbortController;
  body: Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
}

const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError";
const MAX_MANIFESTS = 1024;

export class MediaReader implements RangeSource {
  readonly #o: MediaReaderOptions;
  readonly #manifests = new Map<string, Promise<Manifest>>();
  readonly #present = new Set<string>();
  readonly #inflight = new Map<string, Promise<Uint8Array>>();

  constructor(opts: MediaReaderOptions) {
    this.#o = opts;
  }

  /** The verified manifest: from the cache, else from the store. Concurrent callers share one fetch. */
  manifest(hash: string, signal?: AbortSignal): Promise<Manifest> {
    let p = this.#manifests.get(hash);
    if (!p) {
      p = this.#loadManifest(hash, signal);
      p.catch(() => this.#manifests.delete(hash));
      if (this.#manifests.size >= MAX_MANIFESTS) this.#manifests.delete(this.#manifests.keys().next().value!);
      this.#manifests.set(hash, p);
    }
    return p;
  }

  async #loadManifest(hash: string, signal?: AbortSignal): Promise<Manifest> {
    const { cache, hasher, store } = this.#o;
    const cached = await cache?.getManifest(hash);
    if (cached) {
      try {
        return await decodeManifest(cached, hasher, hash);
      } catch {
        // A damaged cache entry: fetch it again below.
      }
    }
    const bytes = await this.#retry(() => store.get(manifestKey(hash), undefined, { signal }), signal);
    if (!bytes) throw new MediaMissingError(`no manifest for ${hash}`);
    const m = await decodeManifest(bytes, hasher, hash);
    await cache?.putManifest(hash, m.bytes);
    return m;
  }

  async stat(hash: string, signal?: AbortSignal): Promise<MediaStat | null> {
    let m: Manifest;
    try {
      m = await this.manifest(hash, signal);
    } catch (e) {
      if (e instanceof MediaMissingError) return null;
      throw e;
    }
    if (!this.#present.has(hash)) {
      try {
        const h = await this.#o.store.head(mediaKey(hash));
        if (!h) return null; // only the manifest is up so far
        if (h.size !== m.size) throw new Error(`store object for ${hash} is ${h.size} bytes, manifest says ${m.size}`);
        this.#present.add(hash);
      } catch (e) {
        // Offline: the manifest and whatever leaves are cached can still be served.
        if (!(await this.#o.cache?.getManifest(hash))) throw e;
      }
    }
    return { size: m.size, contentType: this.#o.contentType?.(hash) };
  }

  async *read(hash: string, offset: number, length: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const m = await this.manifest(hash, signal);
    const end = Math.min(m.size, offset + length);
    let pos = Math.max(0, offset);
    if (pos >= end) return;
    const lastLeaf = Math.floor((end - 1) / LEAF_SIZE);
    const maxWindow = this.#o.maxWindowLeaves ?? 8;
    let window = 1;
    let ahead: Run | null = null;
    try {
      while (pos < end) {
        signal?.throwIfAborted();
        const i = Math.floor(pos / LEAF_SIZE);
        const cached = await this.#o.cache?.getLeaf(hash, i);
        if (cached) {
          const start = i * LEAF_SIZE;
          const to = Math.min(end, start + cached.length);
          yield cached.subarray(pos - start, to - start);
          pos = to;
          continue;
        }
        let run: Run;
        const pending = ahead as Run | null; // set by startAhead() below, which TS can't see
        if (pending && pending.first === i) {
          run = pending;
        } else {
          pending?.ctl.abort();
          let j = i + 1;
          while (j <= lastLeaf && j < i + window && !(await this.#o.cache?.hasLeaf(hash, j))) j++;
          run = this.#open(m, i, j, signal);
        }
        ahead = null;
        window = Math.min(maxWindow, window * 2);
        const startAhead = () => {
          if (ahead || run.end > lastLeaf) return;
          ahead = this.#open(m, run.end, Math.min(lastLeaf + 1, run.end + window), signal);
        };
        for await (const piece of this.#consume(m, run, pos, end, startAhead, signal)) {
          pos += piece.length;
          yield piece;
        }
      }
    } finally {
      (ahead as Run | null)?.ctl.abort();
    }
  }

  /** Verified bytes only: waits for each leaf's check and repairs bad leaves without failing. */
  async readVerified(hash: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const m = await this.manifest(hash, signal);
    const end = Math.min(m.size, offset + length);
    const start = Math.max(0, offset);
    const out = new Uint8Array(Math.max(0, end - start));
    for (let i = Math.floor(start / LEAF_SIZE); i * LEAF_SIZE < end; i++) {
      const bytes = await this.leaf(hash, i, signal);
      const ls = i * LEAF_SIZE;
      const a = Math.max(start, ls);
      const b = Math.min(end, ls + bytes.length);
      out.set(bytes.subarray(a - ls, b - ls), a - start);
    }
    return out;
  }

  /** One verified leaf: from the cache, else fetched and checked (and fetched again if it fails, up to repairAttempts). */
  async leaf(hash: string, i: number, signal?: AbortSignal): Promise<Uint8Array> {
    const cached = await this.#o.cache?.getLeaf(hash, i);
    if (cached) return cached;
    const k = `${hash}:${i}`;
    let p = this.#inflight.get(k);
    if (!p) {
      p = this.#fetchLeaf(hash, i).finally(() => this.#inflight.delete(k));
      this.#inflight.set(k, p);
    }
    if (!signal) return p;
    signal.throwIfAborted();
    // Another reader may share this fetch, so an abort stops waiting rather than the fetch.
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async #fetchLeaf(hash: string, i: number, afterMismatch = false): Promise<Uint8Array> {
    const m = await this.manifest(hash);
    if (i < 0 || i >= m.leafCount) throw new RangeError(`leaf ${i} of ${m.leafCount}`);
    const span = leafSpan(m.size, i);
    const attempts = this.#o.repairAttempts ?? 3;
    let mismatched = afterMismatch;
    for (let a = 0; a < attempts; a++) {
      const bytes = await this.#retry(() => this.#o.store.get(mediaKey(hash), span));
      if (!bytes) throw new MediaMissingError(`media ${hash} is not in the store`);
      if (bytes.length === span.length && (await this.#verify(m, i, bytes))) {
        await this.#o.cache?.putLeaf(hash, i, bytes);
        if (mismatched) this.#o.onEvent?.({ type: "repaired", hash, leaf: i });
        return bytes;
      }
      mismatched = true;
      this.#o.onEvent?.({ type: "mismatch", hash, leaf: i });
    }
    this.#o.onEvent?.({ type: "repair-failed", hash, leaf: i });
    throw new LeafMismatchError(hash, i);
  }

  /** Fetches a leaf that just failed verification, sharing the fetch with anyone else asking for it. */
  #repair(hash: string, i: number): Promise<Uint8Array> {
    const k = `${hash}:${i}`;
    let p = this.#inflight.get(k);
    if (!p) {
      p = this.#fetchLeaf(hash, i, true).finally(() => this.#inflight.delete(k));
      this.#inflight.set(k, p);
    }
    return p;
  }

  async #verify(m: Manifest, i: number, bytes: Uint8Array): Promise<boolean> {
    return equalBytes(await this.#o.hasher.sha256(bytes), leafDigest(m, i));
  }

  #open(m: Manifest, first: number, end: number, signal?: AbortSignal): Run {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const offset = first * LEAF_SIZE;
    const last = leafSpan(m.size, end - 1);
    const range = { offset, length: last.offset + last.length - offset };
    const key = mediaKey(m.hash);
    const { store } = this.#o;
    const body = store.getStream
      ? store.getStream(key, range, { signal: ctl.signal })
      : store.get(key, range, { signal: ctl.signal });
    body.catch(() => {}); // a prefetch that is never consumed must not become an unhandled rejection
    ctl.signal.addEventListener("abort", () => signal?.removeEventListener("abort", onAbort), { once: true });
    return { first, end, ctl, body };
  }

  /** Yields the bytes of `run` inside [pos, end), verifying each leaf as it completes. */
  async *#consume(m: Manifest, run: Run, pos: number, end: number, startAhead: () => void, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let body: ReadableStream<Uint8Array> | Uint8Array | null | undefined;
    try {
      body = await run.body;
    } catch (e) {
      if (isAbort(e) && signal?.aborted) throw e;
      body = undefined; // network error: fall back to leaf-by-leaf fetches with retries
    }
    if (body === null) throw new MediaMissingError(`media ${m.hash} is not in the store`);
    let leaf = run.first;
    try {
      if (body instanceof Uint8Array) {
        // The whole range is already here, so check each leaf before handing it out: it costs about a millisecond.
        startAhead();
        for (; leaf < run.end; leaf++) {
          const span = leafSpan(m.size, leaf);
          const at = span.offset - run.first * LEAF_SIZE;
          let bytes = body.subarray(at, at + span.length);
          if (bytes.length !== span.length || !(await this.#verify(m, leaf, bytes))) {
            if (bytes.length === span.length) this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf });
            bytes = await this.#repair(m.hash, leaf);
          } else {
            await this.#o.cache?.putLeaf(m.hash, leaf, bytes);
          }
          const piece = slice(bytes, span.offset, pos, end);
          if (piece) {
            pos += piece.length;
            yield piece;
          }
        }
        return;
      }
      if (body) {
        // Returns early when the response ends short (a dropped link); the fallback below fetches the rest.
        yield* this.#stream(m, run, body, pos, end, startAhead, signal, (l, p) => {
          leaf = l;
          pos = p;
        });
      }
    } finally {
      run.ctl.abort();
    }
    // Fallback for whatever the response did not deliver.
    for (; leaf < run.end && pos < end; leaf++) {
      const bytes = await this.leaf(m.hash, leaf, signal);
      const piece = slice(bytes, leaf * LEAF_SIZE, pos, end);
      if (piece) {
        pos += piece.length;
        yield piece;
      }
    }
  }

  async *#stream(
    m: Manifest,
    run: Run,
    body: ReadableStream<Uint8Array>,
    pos: number,
    end: number,
    startAhead: () => void,
    signal: AbortSignal | undefined,
    progress: (leaf: number, pos: number) => void,
  ): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    let leaf = run.first;
    let span = leafSpan(m.size, leaf);
    let buf = new Uint8Array(span.length);
    let filled = 0;
    let handedOut = false; // some of this leaf's bytes went to the player unverified
    try {
      while (leaf < run.end) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (run.ctl.signal.aborted && isAbort(e)) throw e;
          break; // the link dropped mid-response: the caller refetches from here
        }
        if (chunk.done) break;
        const value = chunk.value;
        for (let at = 0; at < value.length && leaf < run.end; ) {
          const n = Math.min(value.length - at, span.length - filled);
          buf.set(value.subarray(at, at + n), filled);
          const piece = slice(value.subarray(at, at + n), span.offset + filled, pos, end);
          filled += n;
          at += n;
          if (piece) {
            handedOut = true;
            pos += piece.length;
            progress(leaf, pos);
            yield piece;
          }
          if (filled < span.length) continue;
          if (await this.#verify(m, leaf, buf)) {
            await this.#o.cache?.putLeaf(m.hash, leaf, buf);
          } else {
            this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf });
            const good = await this.#repair(m.hash, leaf);
            if (handedOut) throw new LeafMismatchError(m.hash, leaf);
            const p = slice(good, span.offset, pos, end);
            if (p) {
              pos += p.length;
              yield p;
            }
          }
          if (leaf === run.first) startAhead();
          leaf++;
          progress(leaf, pos);
          if (leaf < run.end) {
            span = leafSpan(m.size, leaf);
            buf = new Uint8Array(span.length);
            filled = 0;
            handedOut = false;
          }
        }
      }
      if (leaf < run.end && filled > 0) {
        // The response ended inside a leaf. Fetch the whole leaf (verified); what already went out of it must match.
        const good = await this.leaf(m.hash, leaf, signal);
        if (handedOut && !equalBytes(good.subarray(0, filled), buf.subarray(0, filled))) {
          this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf });
          throw new LeafMismatchError(m.hash, leaf);
        }
        const p = slice(good, span.offset, pos, end);
        if (p) {
          pos += p.length;
          yield p;
        }
        leaf++;
        progress(leaf, pos);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async #retry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const retries = this.#o.retries ?? 3;
    for (let a = 0; ; a++) {
      signal?.throwIfAborted();
      try {
        return await fn();
      } catch (e) {
        if (isAbort(e) || a >= retries) throw e;
        await new Promise((r) => setTimeout(r, (this.#o.retryDelayMs ?? 200) * 2 ** a));
      }
    }
  }
}

/** The part of `bytes` (which starts at file offset `at`) inside [pos, end), or null. */
function slice(bytes: Uint8Array, at: number, pos: number, end: number): Uint8Array | null {
  const a = Math.max(at, pos);
  const b = Math.min(at + bytes.length, end);
  return a < b ? bytes.subarray(a - at, b - at) : null;
}
