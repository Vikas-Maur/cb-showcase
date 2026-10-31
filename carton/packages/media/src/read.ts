// Range reads of shared media: play first, verify after (PLAN §11, R2-11).
//
// - Bytes are handed to the player as they arrive. Each 1 MiB leaf is checked against the manifest when its last byte
//   lands; verified leaves go into the range cache.
// - A leaf that fails after some of its bytes were handed out ends the read with LeafMismatchError, and the repair path
//   has already fetched it again by then, so a retry is served from the cache. A leaf that fails before any of its
//   bytes were handed out is repaired silently.
// - Breaking a response does NOT make a client drop bytes it already has: Chromium re-requests from the break offset
//   and keeps playing the bad bytes, and ffmpeg with -reconnect does the same (range-server helper's experiments,
//   2026-10-31). So the player must be told: hosts forward the "served-bad" event to the renderer, which reloads the
//   element at its current time. Tools gain little from play first, so `toolSource()` verifies every
//   leaf before handing it out; the loopback range server for ffmpeg-based tools serves that.
// - A read never ends on unverified bytes: its last piece is held until that leaf's check passes. A client that stops
//   reading once it has the bytes it asked for (an HTTP server whose Content-Length is met) would otherwise never let
//   the last leaf be checked.
// - Requests start small and grow (1, 2, 4 … leaves), so the first frame waits for one leaf, not a big window, and a
//   long read needs few round trips. The next request starts once the current one is flowing.
// - Whatever the cache holds is served from it, including when the link is down.

import { equalBytes } from "./bytes.ts";
import type { LeafCache } from "./cache.ts";
import type { BlobStore, Hasher } from "./contracts.ts";
import { reportDamage, reportToHost } from "./damage.ts";
import { manifestKey, mediaKey } from "./keys.ts";
import { decodeManifest, LEAF_SIZE, leafDigest, leafSpan, type Manifest } from "./manifest.ts";
import { LeafMismatchError, type MediaStat, type RangeSource } from "./range-source.ts";

/** The store has no such media (or not yet: a manifest goes up before its bytes are complete). */
export class MediaMissingError extends Error {
  override name = "MediaMissingError";
}

export type ReaderEvent = {
  /**
   * mismatch: a leaf failed its check (it is fetched again). repaired / repair-failed: how that went. served-bad: bytes
   * that differ from the verified leaf (or that can't be checked, when the repair failed too) already went to a
   * play-first reader, and its read fails; a player must reload from them (breaking a response doesn't make it drop
   * what it has).
   */
  type: "mismatch" | "repaired" | "repair-failed" | "served-bad";
  hash: string;
  leaf: number;
  /** For "mismatch": some of the leaf's bytes had already gone out, unverified, when it failed. */
  handedOut?: boolean;
};

export interface ReadOptions {
  /** Hand out each leaf only once it is verified (tools). Default: play first. */
  verifyFirst?: boolean;
}

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
  /**
   * When a leaf still fails after its repair attempts, the store's copy is damaged (disk rot, a bad copy): write
   * bad/<hash> so the next upload of this media replaces the object instead of deduping on it (e2e S5-5). Default on;
   * a reader without write access just fails to report. A store with a host check (`reportDamaged`, team mode) is
   * also asked to verify and remove the object.
   */
  reportDamage?: boolean;
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

  /** The range cache it reads through, if any (a stream reader keeps its entries there too). */
  get cache(): LeafCache | undefined {
    return this.#o.cache;
  }

  constructor(opts: MediaReaderOptions) {
    this.#o = opts;
  }

  /**
   * The verified manifest: from the cache, else from the store. Concurrent callers share one fetch, so an abort stops
   * this caller's wait, not the fetch.
   */
  manifest(hash: string, signal?: AbortSignal): Promise<Manifest> {
    let p = this.#manifests.get(hash);
    if (!p) {
      p = this.#loadManifest(hash);
      p.catch(() => this.#manifests.delete(hash));
      if (this.#manifests.size >= MAX_MANIFESTS) this.#manifests.delete(this.#manifests.keys().next().value!);
      this.#manifests.set(hash, p);
    }
    return signal ? untilAborted(p, signal) : p;
  }

  async #loadManifest(hash: string): Promise<Manifest> {
    const { cache, hasher, store } = this.#o;
    const cached = await cache?.getManifest(hash);
    if (cached) {
      try {
        return await decodeManifest(cached, hasher, hash);
      } catch {
        // A damaged cache entry: fetch it again below.
      }
    }
    const bytes = await this.#retry(() => store.get(manifestKey(hash)));
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
        // The store may never answer (a stalled link): the caller's abort ends the wait.
        signal?.throwIfAborted();
        const h = await (signal ? untilAborted(this.#o.store.head(mediaKey(hash)), signal) : this.#o.store.head(mediaKey(hash)));
        if (!h) return null; // only the manifest is up so far
        if (h.size !== m.size) throw new Error(`store object for ${hash} is ${h.size} bytes, manifest says ${m.size}`);
        this.#present.add(hash);
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        // Offline: the manifest and whatever leaves are cached can still be served.
        if (!(await this.#o.cache?.getManifest(hash))) throw e;
      }
    }
    return { size: m.size, contentType: this.#o.contentType?.(hash) };
  }

  /** A RangeSource that hands out verified bytes only: for tools, and the loopback range server they read through. */
  toolSource(): RangeSource {
    return {
      stat: (hash, signal) => this.stat(hash, signal),
      read: (hash, offset, length, signal) => this.read(hash, offset, length, signal, { verifyFirst: true }),
    };
  }

  async *read(hash: string, offset: number, length: number, signal?: AbortSignal, opts: ReadOptions = {}): AsyncGenerator<Uint8Array> {
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
        for await (const piece of this.#consume(m, run, pos, end, startAhead, signal, opts.verifyFirst === true)) {
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
      this.#o.onEvent?.({ type: "mismatch", hash, leaf: i, handedOut: false });
    }
    this.#o.onEvent?.({ type: "repair-failed", hash, leaf: i });
    if (this.#o.reportDamage !== false) {
      // Our record (bad/<hash>), and the host's own check where the store has one (it removes a damaged object).
      await reportDamage(this.#o.store, hash, { leaf: i });
      await reportToHost(this.#o.store, hash, i);
    }
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

  /** #repair, and when it fails after unverified bytes of the leaf went out, tells the host they may be bad. */
  async #repairOrReport(hash: string, leaf: number, handedOut: boolean): Promise<Uint8Array> {
    try {
      return await this.#repair(hash, leaf);
    } catch (e) {
      if (handedOut) this.#o.onEvent?.({ type: "served-bad", hash, leaf });
      throw e;
    }
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
    const body = store.getStream ? store.getStream(key, range) : store.get(key, range);
    body.catch(() => {}); // a prefetch that is never consumed must not become an unhandled rejection
    ctl.signal.addEventListener(
      "abort",
      () => {
        signal?.removeEventListener("abort", onAbort);
        // The contract's reads take no signal: cancelling the body is how a request is abandoned. A stream being read
        // is locked and cancelled by its reader instead.
        body.then((b) => (b instanceof ReadableStream && !b.locked ? b.cancel() : undefined)).catch(() => {});
      },
      { once: true },
    );
    return { first, end, ctl, body };
  }

  /** Yields the bytes of `run` inside [pos, end), verifying each leaf as it completes. */
  async *#consume(m: Manifest, run: Run, pos: number, end: number, startAhead: () => void, signal: AbortSignal | undefined, verifyFirst: boolean): AsyncGenerator<Uint8Array> {
    let body: ReadableStream<Uint8Array> | Uint8Array | null | undefined;
    try {
      // A store that never answers must not outlive an abort.
      body = await untilAborted(run.body, run.ctl.signal);
    } catch (e) {
      if (run.ctl.signal.aborted) throw run.ctl.signal.reason;
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
            if (bytes.length === span.length) this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf, handedOut: false });
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
        yield* this.#stream(m, run, body, pos, end, startAhead, signal, verifyFirst, (l, p) => {
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
    verifyFirst: boolean,
    progress: (leaf: number, pos: number) => void,
  ): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    // The stream is locked to this reader, so an abort has to cancel through it: that ends a read() that is waiting on
    // a stalled store.
    const onAbort = () => reader.cancel(run.ctl.signal.reason).catch(() => {});
    run.ctl.signal.addEventListener("abort", onAbort, { once: true });
    // Aborted between the body arriving and this reader taking it: the listener above will never fire.
    if (run.ctl.signal.aborted) {
      reader.cancel(run.ctl.signal.reason).catch(() => {});
      throw run.ctl.signal.reason;
    }
    let leaf = run.first;
    let span = leafSpan(m.size, leaf);
    let buf = new Uint8Array(span.length);
    let filled = 0;
    // The part of this leaf handed to the reader unverified: [outFrom, outTo), offsets in the leaf.
    let outFrom = -1;
    let outTo = 0;
    // After a failed check: did any byte that went out differ from the verified leaf?
    const servedBad = (good: Uint8Array) => outFrom >= 0 && !equalBytes(good.subarray(outFrom, outTo), buf.subarray(outFrom, outTo));
    let held: Uint8Array | null = null; // the read's last piece, waiting for its leaf's check
    try {
      while (leaf < run.end) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (run.ctl.signal.aborted) throw run.ctl.signal.reason;
          break; // the link dropped mid-response: the caller refetches from here
        }
        if (run.ctl.signal.aborted) throw run.ctl.signal.reason;
        if (chunk.done) break;
        const value = chunk.value;
        for (let at = 0; at < value.length && leaf < run.end; ) {
          const n = Math.min(value.length - at, span.length - filled);
          buf.set(value.subarray(at, at + n), filled);
          const piece = verifyFirst ? null : slice(value.subarray(at, at + n), span.offset + filled, pos, end);
          filled += n;
          at += n;
          if (piece) {
            if (pos + piece.length === end) {
              held = piece; // the read's last bytes: they go out once their leaf is checked
            } else {
              if (outFrom < 0) outFrom = filled - piece.length;
              outTo = filled;
              pos += piece.length;
              progress(leaf, pos);
              yield piece;
            }
          }
          if (filled < span.length) continue;
          let ready: Uint8Array | null = null; // a verified leaf whose wanted bytes haven't gone out yet
          if (await this.#verify(m, leaf, buf)) {
            await this.#o.cache?.putLeaf(m.hash, leaf, buf);
            // Tools get the whole verified leaf; a held piece goes out now (`pos` is where it starts).
            if (verifyFirst || held) ready = buf;
          } else {
            this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf, handedOut: outFrom >= 0 });
            const good = await this.#repairOrReport(m.hash, leaf, outFrom >= 0);
            if (servedBad(good)) {
              this.#o.onEvent?.({ type: "served-bad", hash: m.hash, leaf });
              throw new LeafMismatchError(m.hash, leaf);
            }
            // What went out was right after all (the damage was elsewhere in the leaf): carry on from the good copy.
            ready = good;
          }
          held = null;
          const p = ready && slice(ready, span.offset, pos, end);
          if (p) {
            pos += p.length;
            yield p;
          }
          if (leaf === run.first) startAhead();
          leaf++;
          progress(leaf, pos);
          if (leaf < run.end) {
            span = leafSpan(m.size, leaf);
            buf = new Uint8Array(span.length);
            filled = 0;
            outFrom = -1;
            outTo = 0;
          }
        }
      }
      if (run.ctl.signal.aborted) throw run.ctl.signal.reason;
      if (leaf < run.end && filled > 0) {
        // The response ended inside a leaf. Fetch the whole leaf (verified); what already went out of it must match.
        // A held piece never went out: it is served from the verified leaf instead.
        let good: Uint8Array;
        try {
          good = await this.leaf(m.hash, leaf, signal);
        } catch (e) {
          // No good copy to compare with: what went out can't be vouched for, so the player must drop it.
          if (outFrom >= 0 && !isAbort(e)) this.#o.onEvent?.({ type: "served-bad", hash: m.hash, leaf });
          throw e;
        }
        if (servedBad(good)) {
          this.#o.onEvent?.({ type: "mismatch", hash: m.hash, leaf, handedOut: true });
          this.#o.onEvent?.({ type: "served-bad", hash: m.hash, leaf });
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
      run.ctl.signal.removeEventListener("abort", onAbort);
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

/** `p`, or the signal's reason as soon as it aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  // Whoever stops waiting leaves `p` running: observe it, so its later rejection isn't an unhandled one.
  p.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The part of `bytes` (which starts at file offset `at`) inside [pos, end), or null. */
function slice(bytes: Uint8Array, at: number, pos: number, end: number): Uint8Array | null {
  const a = Math.max(at, pos);
  const b = Math.min(at + bytes.length, end);
  return a < b ? bytes.subarray(a - at, b - at) : null;
}
