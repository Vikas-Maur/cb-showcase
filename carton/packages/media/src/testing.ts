// Test doubles for the media package and its conformance suite: an in-memory BlobStore that counts what crosses the
// "network", and a wrapper that injects the failures slow and flaky links produce (a cut connection mid-part, a
// corrupted range). @carton/blob-memory is the real memory plug-in; this one exists for the counters and the faults.

import type { BlobGetOptions, BlobHead, BlobStore, ByteRange, CompletedPart } from "./contracts.ts";
import { concatBytes } from "./bytes.ts";

export interface StoreCounters {
  bytesUp: number;
  bytesDown: number;
  puts: number;
  parts: number;
  gets: number;
  heads: number;
}

export class CountingMemoryStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  readonly counters: StoreCounters = { bytesUp: 0, bytesDown: 0, puts: 0, parts: 0, gets: 0, heads: 0 };
  /** Every ranged read, in order. */
  readonly reads: { key: string; offset: number; length: number }[] = [];
  #nextUpload = 1;

  async head(key: string): Promise<BlobHead | null> {
    this.counters.heads++;
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async get(key: string, range?: ByteRange, opts?: BlobGetOptions): Promise<Uint8Array | null> {
    opts?.signal?.throwIfAborted();
    this.counters.gets++;
    const o = this.objects.get(key);
    if (!o) return null;
    const out = range ? o.slice(range.offset, range.offset + range.length) : o.slice();
    this.counters.bytesDown += out.length;
    this.reads.push({ key, offset: range?.offset ?? 0, length: out.length });
    return out;
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.counters.puts++;
    this.counters.bytesUp += body.length;
    this.objects.set(key, body.slice());
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async createMultipart(key: string): Promise<{ uploadId: string }> {
    const uploadId = `u${this.#nextUpload++}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { uploadId };
  }
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array, opts?: BlobGetOptions): Promise<{ etag: string }> {
    opts?.signal?.throwIfAborted();
    const u = this.uploads.get(uploadId);
    if (!u || u.key !== key) throw new Error("NoSuchUpload");
    this.counters.parts++;
    this.counters.bytesUp += body.length;
    u.parts.set(partNumber, body.slice());
    return { etag: `e${partNumber}-${body.length}` };
  }
  async listParts(key: string, uploadId: string): Promise<CompletedPart[]> {
    const u = this.uploads.get(uploadId);
    if (!u || u.key !== key) throw new Error("NoSuchUpload");
    return [...u.parts].map(([partNumber, b]) => ({ partNumber, etag: `e${partNumber}-${b.length}`, size: b.length }));
  }
  async completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    const u = this.uploads.get(uploadId);
    if (!u || u.key !== key) throw new Error("NoSuchUpload");
    const bodies: Uint8Array[] = [];
    let partSize = -1;
    parts.forEach((p, i) => {
      const b = u.parts.get(p.partNumber);
      if (!b || p.partNumber !== i + 1) throw new Error(`InvalidPart ${p.partNumber}`);
      // R2: every part but the last has the same size.
      if (i < parts.length - 1) {
        if (partSize === -1) partSize = b.length;
        else if (b.length !== partSize) throw new Error("InvalidPart: unequal part sizes");
      } else if (partSize !== -1 && b.length > partSize) throw new Error("InvalidPart: last part larger");
      bodies.push(b);
    });
    this.objects.set(key, concatBytes(bodies));
    this.uploads.delete(uploadId);
  }
  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}

/** A network error, as a cut link raises it. */
export class LinkDroppedError extends Error {
  override name = "LinkDroppedError";
}

export interface Faults {
  /** Cut the link once this many upload bytes have gone through (counting every attempt). The failing part is lost. */
  dropUploadAfterBytes?: number;
  /** How many times the link is cut (each time `dropUploadAfterBytes` more bytes pass). Default 1. */
  drops?: number;
  /** Flip one byte at this object offset in the next N ranged reads that cover it. */
  corruptAt?: { key: string; offset: number; times: number };
  /** Delay per request, ms (a slow link's round trip). */
  rttMs?: number;
  /** Offer `getStream`, delivering responses in chunks of this many bytes. */
  streamChunk?: number;
  /** Cut the next streamed response after this many bytes (once). */
  dropReadAfterBytes?: number;
}

/** Wraps a store and injects faults. Counters live on the inner store. */
export class FaultyStore implements BlobStore {
  readonly inner: BlobStore;
  readonly faults: Faults;
  #upBytes = 0;
  #dropsLeft: number;
  readonly listParts?: (key: string, uploadId: string) => Promise<CompletedPart[]>;
  constructor(inner: BlobStore, faults: Faults) {
    this.inner = inner;
    this.faults = faults;
    this.#dropsLeft = faults.drops ?? 1;
    // Only when the inner store can list parts, so resume takes the same path it would without the wrapper.
    if (inner.listParts) this.listParts = (key, uploadId) => inner.listParts!(key, uploadId);
    if (faults.streamChunk) this.getStream = (key, range, opts) => this.#stream(key, range, opts);
  }
  readonly getStream?: (key: string, range?: ByteRange, opts?: BlobGetOptions) => Promise<ReadableStream<Uint8Array> | null>;
  async #stream(key: string, range?: ByteRange, opts?: BlobGetOptions): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.get(key, range, opts);
    if (!bytes) return null;
    const chunk = this.faults.streamChunk!;
    let drop = this.faults.dropReadAfterBytes;
    this.faults.dropReadAfterBytes = undefined;
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (opts?.signal?.aborted) return ctl.error(opts.signal.reason);
        if (drop !== undefined && at >= drop) {
          drop = undefined;
          return ctl.error(new LinkDroppedError("connection reset by peer"));
        }
        if (at >= bytes.length) return ctl.close();
        const n = Math.min(chunk, bytes.length - at, drop !== undefined ? drop - at : Infinity);
        ctl.enqueue(bytes.slice(at, at + n));
        at += n;
      },
    });
  }
  async #rtt(): Promise<void> {
    if (this.faults.rttMs) await new Promise((r) => setTimeout(r, this.faults.rttMs));
  }
  async head(key: string) {
    await this.#rtt();
    return this.inner.head(key);
  }
  async get(key: string, range?: ByteRange, opts?: BlobGetOptions) {
    await this.#rtt();
    const out = await this.inner.get(key, range, opts);
    const c = this.faults.corruptAt;
    if (out && c && c.times > 0 && c.key === key) {
      const start = range?.offset ?? 0;
      if (c.offset >= start && c.offset < start + out.length) {
        c.times--;
        out[c.offset - start] ^= 0xff;
      }
    }
    return out;
  }
  async put(key: string, body: Uint8Array) {
    await this.#rtt();
    this.#countUp(body.length);
    return this.inner.put(key, body);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  async createMultipart(key: string) {
    await this.#rtt();
    return this.inner.createMultipart(key);
  }
  async uploadPart(key: string, uploadId: string, n: number, body: Uint8Array, opts?: BlobGetOptions) {
    await this.#rtt();
    this.#countUp(body.length);
    return this.inner.uploadPart(key, uploadId, n, body, opts);
  }
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]) {
    return this.inner.completeMultipart(key, uploadId, parts);
  }
  abortMultipart(key: string, uploadId: string) {
    return this.inner.abortMultipart(key, uploadId);
  }
  #countUp(n: number): void {
    const limit = this.faults.dropUploadAfterBytes;
    if (limit === undefined || this.#dropsLeft <= 0) return;
    if (this.#upBytes + n > limit) {
      this.#dropsLeft--;
      this.#upBytes = 0;
      throw new LinkDroppedError("connection reset by peer");
    }
    this.#upBytes += n;
  }
}

/** The same store without `listParts`, like R2's Workers binding. */
export function withoutListParts(store: BlobStore): BlobStore {
  return {
    head: (k) => store.head(k),
    get: (k, r, o) => store.get(k, r, o),
    put: (k, b) => store.put(k, b),
    delete: (k) => store.delete(k),
    createMultipart: (k) => store.createMultipart(k),
    uploadPart: (k, u, n, b, o) => store.uploadPart(k, u, n, b, o),
    completeMultipart: (k, u, p) => store.completeMultipart(k, u, p),
    abortMultipart: (k, u) => store.abortMultipart(k, u),
  };
}
