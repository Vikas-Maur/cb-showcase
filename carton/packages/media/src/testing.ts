// Test doubles for the media package and its conformance suite: an in-memory BlobStore that counts what crosses the
// "network", and a wrapper that injects the failures slow and flaky links produce (a cut connection mid-part, a
// corrupted range, a response that stops short). @carton/blob-memory is the real memory plug-in; this one exists for
// the counters and the faults.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "./contracts.ts";
import { concatBytes } from "./bytes.ts";

export interface StoreCounters {
  bytesUp: number;
  bytesDown: number;
  puts: number;
  parts: number;
  gets: number;
  heads: number;
}

function clip(o: Uint8Array, range?: ByteRange): Uint8Array {
  if (!range) return o.slice();
  const start = Math.min(o.length, range.offset);
  const end = range.length === undefined ? o.length : Math.min(o.length, range.offset + range.length);
  return o.slice(start, Math.max(start, end));
}

export class CountingMemoryStore implements BlobStore {
  readonly kind = "counting-memory";
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  readonly counters: StoreCounters = { bytesUp: 0, bytesDown: 0, puts: 0, parts: 0, gets: 0, heads: 0 };
  /** Every ranged read, in order. */
  readonly reads: { key: string; offset: number; length: number }[] = [];
  #nextUpload = 1;

  async head(key: string): Promise<BlobInfo | null> {
    this.counters.heads++;
    const o = this.objects.get(key);
    return o ? { key, size: o.length } : null;
  }
  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    this.counters.gets++;
    const o = this.objects.get(key);
    if (!o) return null;
    const out = clip(o, range);
    this.counters.bytesDown += out.length;
    this.reads.push({ key, offset: range?.offset ?? 0, length: out.length });
    return out;
  }
  async put(key: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<BlobInfo> {
    const old = this.objects.get(key);
    if (old && opts?.ifAbsent) return { key, size: old.length };
    this.counters.puts++;
    this.counters.bytesUp += data.length;
    this.objects.set(key, data.slice());
    return { key, size: data.length };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix: string): Promise<{ blobs: BlobInfo[] }> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    return { blobs: keys.map((key) => ({ key, size: this.objects.get(key)!.length })) };
  }
  async createMultipart(key: string): Promise<MultipartUpload> {
    const uploadId = `u${this.#nextUpload++}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.#handle(key, uploadId);
  }
  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    // Like R2 and S3, resuming only makes a handle; an unknown id fails on first use.
    return this.#handle(key, uploadId);
  }
  #upload(key: string, uploadId: string) {
    const u = this.uploads.get(uploadId);
    if (!u || u.key !== key) throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
    return u;
  }
  #handle(key: string, uploadId: string): MultipartUpload {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, data) => {
        const u = this.#upload(key, uploadId);
        this.counters.parts++;
        this.counters.bytesUp += data.length;
        u.parts.set(partNumber, data.slice());
        return { partNumber, etag: `e${partNumber}-${data.length}` };
      },
      listParts: async () =>
        [...this.#upload(key, uploadId).parts].map(([partNumber, b]) => ({ partNumber, etag: `e${partNumber}-${b.length}`, size: b.length })),
      complete: async (parts) => {
        const u = this.#upload(key, uploadId);
        const bodies: Uint8Array[] = [];
        let partSize = -1;
        parts.forEach((p, i) => {
          const b = u.parts.get(p.partNumber);
          if (!b || p.partNumber !== i + 1 || p.etag !== `e${p.partNumber}-${b.length}`) throw new Error(`InvalidPart ${p.partNumber}`);
          // R2: every part but the last has the same size.
          if (i < parts.length - 1) {
            if (partSize === -1) partSize = b.length;
            else if (b.length !== partSize) throw new Error("InvalidPart: unequal part sizes");
          } else if (partSize !== -1 && b.length > partSize) throw new Error("InvalidPart: last part larger");
          bodies.push(b);
        });
        const all = concatBytes(bodies);
        this.objects.set(key, all);
        this.uploads.delete(uploadId);
        return { key, size: all.length };
      },
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    };
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
  /** Multipart handles fail `listParts`, like R2's Workers binding. */
  noListParts?: boolean;
}

/** Wraps a store and injects faults. Counters live on the inner store. */
export class FaultyStore implements BlobStore {
  readonly kind = "faulty";
  readonly inner: BlobStore;
  readonly faults: Faults;
  #upBytes = 0;
  #dropsLeft: number;
  readonly getStream?: (key: string, range?: ByteRange) => Promise<ReadableStream<Uint8Array> | null>;

  constructor(inner: BlobStore, faults: Faults) {
    this.inner = inner;
    this.faults = faults;
    this.#dropsLeft = faults.drops ?? 1;
    if (faults.streamChunk) this.getStream = (key, range) => this.#stream(key, range);
  }
  async #rtt(): Promise<void> {
    if (this.faults.rttMs) await new Promise((r) => setTimeout(r, this.faults.rttMs));
  }
  async head(key: string) {
    await this.#rtt();
    return this.inner.head(key);
  }
  async get(key: string, range?: ByteRange) {
    await this.#rtt();
    const out = await this.inner.get(key, range);
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
  async #stream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.get(key, range);
    if (!bytes) return null;
    const chunk = this.faults.streamChunk!;
    let drop = this.faults.dropReadAfterBytes;
    this.faults.dropReadAfterBytes = undefined;
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctl) {
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
  async put(key: string, data: Uint8Array, opts?: { contentType?: string; ifAbsent?: boolean }) {
    await this.#rtt();
    this.#countUp(data.length);
    return this.inner.put(key, data, opts);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    return this.inner.list(prefix, opts);
  }
  async createMultipart(key: string, opts?: { contentType?: string }) {
    await this.#rtt();
    return this.#wrap(await this.inner.createMultipart(key, opts));
  }
  async resumeMultipart(key: string, uploadId: string) {
    return this.#wrap(await this.inner.resumeMultipart(key, uploadId));
  }
  #wrap(u: MultipartUpload): MultipartUpload {
    return {
      key: u.key,
      uploadId: u.uploadId,
      uploadPart: async (n, data) => {
        await this.#rtt();
        this.#countUp(data.length);
        return u.uploadPart(n, data);
      },
      listParts: async () => {
        if (this.faults.noListParts) throw new Error("listParts is not supported by this store");
        return u.listParts();
      },
      complete: (parts) => u.complete(parts),
      abort: () => u.abort(),
    };
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
