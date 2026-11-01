// In-memory BlobStore (PLAN §3.1): for tests, the in-process host and the conformance suite's reference. It keeps
// the same rules as the real stores (key limits, multipart part rules, past-the-end ranges), so a client that passes
// against it doesn't break on R2 or S3.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkPartNumber, checkRange, checkCompleteParts, randomId, BlobError, markCreated } from "./rules.ts";

export { BlobError } from "./rules.ts";

export function createMemoryBlobStore(): MemoryBlobStore {
  return new MemoryBlobStore();
}

interface Obj {
  data: Uint8Array;
  info: BlobInfo;
}

interface Upload {
  key: string;
  contentType?: string;
  parts: Map<number, { data: Uint8Array; etag: string }>;
}

export class MemoryBlobStore implements BlobStore {
  readonly kind = "memory";
  readonly #objects = new Map<string, Obj>();
  readonly #uploads = new Map<string, Upload>();
  #version = 0;

  // Every stored version gets a new etag, so a reader can tell a replaced object from the one it read.
  #etag(): string {
    return `"m${(++this.#version).toString(36)}"`;
  }

  #store(key: string, data: Uint8Array, contentType?: string, sha256?: string): BlobInfo {
    const info: BlobInfo = { key, size: data.byteLength, etag: this.#etag() };
    if (contentType) info.contentType = contentType;
    if (sha256) info.sha256 = sha256;
    this.#objects.set(key, { data, info });
    return { ...info };
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; sha256?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    checkKey(key);
    const old = this.#objects.get(key);
    if (opts.ifAbsent && old) return markCreated({ ...old.info }, false);
    // A copy: the caller may reuse its buffer, and a blob is the bytes as they were at put time.
    const info = this.#store(key, data.slice(), opts.contentType, opts.sha256);
    return opts.ifAbsent ? markCreated(info, true) : info;
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    checkKey(key);
    const o = this.#objects.get(key);
    if (!o) return null;
    if (!range) return o.data.slice();
    checkRange(range);
    const end = range.length === undefined ? o.data.byteLength : Math.min(o.data.byteLength, range.offset + range.length);
    return o.data.slice(Math.min(range.offset, end), end);
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.get(key, range);
    if (!bytes) return null;
    return new ReadableStream({
      start(c) {
        if (bytes.byteLength) c.enqueue(bytes);
        c.close();
      },
    });
  }

  async head(key: string): Promise<BlobInfo | null> {
    checkKey(key);
    const o = this.#objects.get(key);
    return o ? { ...o.info } : null;
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    this.#objects.delete(key);
  }

  // Keys in UTF-8 byte order (S3's and R2's order); for the keys we use (ASCII) that's plain string order.
  async list(prefix: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    const cursor = opts.cursor;
    const keys = [...this.#objects.keys()].filter((k) => k.startsWith(prefix) && (cursor === undefined || byteOrder(k, cursor) > 0)).sort(byteOrder);
    const page = keys.slice(0, limit);
    const out: { blobs: BlobInfo[]; cursor?: string } = { blobs: page.map((k) => ({ ...this.#objects.get(k)!.info })) };
    if (keys.length > limit) out.cursor = page[page.length - 1]!;
    return out;
  }

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    checkKey(key);
    const id = randomId();
    const up: Upload = { key, parts: new Map() };
    if (opts.contentType) up.contentType = opts.contentType;
    this.#uploads.set(id, up);
    return this.#handle(key, id);
  }

  // Lazy, as on R2 and S3: a wrong id fails at the first call on the handle.
  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    checkKey(key);
    return this.#handle(key, uploadId);
  }

  #upload(key: string, id: string): Upload {
    const up = this.#uploads.get(id);
    if (!up || up.key !== key) throw new BlobError("NoSuchUpload", `no multipart upload ${id} for ${key}`);
    return up;
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const store = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        const etag = store.#etag();
        store.#upload(key, uploadId).parts.set(partNumber, { data: data.slice(), etag });
        return { partNumber, etag };
      },
      async listParts() {
        const up = store.#upload(key, uploadId);
        return [...up.parts].sort((a, b) => a[0] - b[0]).map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.data.byteLength }));
      },
      async complete(parts) {
        const up = store.#upload(key, uploadId);
        const chosen = checkCompleteParts(parts, (n) => {
          const p = up.parts.get(n);
          return p && { etag: p.etag, size: p.data.byteLength };
        });
        let size = 0;
        for (const n of chosen) size += up.parts.get(n)!.data.byteLength;
        const out = new Uint8Array(size);
        let at = 0;
        for (const n of chosen) {
          const d = up.parts.get(n)!.data;
          out.set(d, at);
          at += d.byteLength;
        }
        store.#uploads.delete(uploadId);
        return store.#store(key, out, up.contentType);
      },
      // Idempotent for a gone upload, but bound to the key: through a scoped store an id alone must not reach
      // another project's upload.
      async abort() {
        const up = store.#uploads.get(uploadId);
        if (!up) return;
        if (up.key !== key) throw new BlobError("NoSuchUpload", `no multipart upload ${uploadId} for ${key}`);
        store.#uploads.delete(uploadId);
      },
    };
  }
}

function byteOrder(a: string, b: string): number {
  // UTF-16 order differs from UTF-8 byte order only for astral vs. U+E000–U+FFFF characters; compare code points.
  if (a === b) return 0;
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!, cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}
