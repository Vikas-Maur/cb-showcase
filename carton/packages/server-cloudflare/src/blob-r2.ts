// blob-r2: the R2 bucket binding as a BlobStore (PLAN §3.1, §11). Media objects, keyframes and archived change
// segments.
//
// Where R2 differs from the contract, this adapter closes the gap:
// - A range at or past the end, or of length 0, makes R2 throw; the contract wants an empty array. On a ranged
//   read that throws, one HEAD tells "absent" (null) from "past the end" (empty) — no extra request otherwise.
// - The binding has no ListParts, which resuming an upload after a cut link needs. Each upload keeps small marker
//   objects under `.carton-uploads/<uploadId>/` (a `meta` record, and one per part with its etag and size), written
//   after R2 accepts the part, so listParts never names a part R2 doesn't have. That is one extra Class A operation
//   per part (§18 budgets R2 ops at < $0.10 per team-month), and the markers go when the upload completes or aborts.
// - `sha256` is passed to R2, which then refuses bytes that don't match, and kept in custom metadata for `head`.
// R2 itself enforces the part rules (5 MiB minimum, equal parts, the last no larger); the shared checks run first so
// the error is the same as on every other store.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkRange, checkPartNumber, checkCompleteParts, BlobError } from "@carton/blob-memory/rules";
import type { BlobUrlSigner } from "@carton/blob-memory/signed";
import type { R2Bucket, R2Object } from "./cf.ts";

const UPLOADS = ".carton-uploads/";
export const R2_MIN_PART_SIZE = 5 * 1024 * 1024;
// a part upload still holding its lock after this long is taken to have died (a 64 MiB part at 0.3 Mb/s still fits)
const LOCK_TTL_MS = 30 * 60_000;

export interface R2BlobStoreOptions {
  // Signed URLs served by the host's blob route (`serveSignedBlob`), since the binding can't presign.
  signer?: BlobUrlSigner;
}

function infoOf(o: R2Object): BlobInfo {
  const info: BlobInfo = { key: o.key, size: o.size, etag: o.httpEtag };
  if (o.httpMetadata?.contentType) info.contentType = o.httpMetadata.contentType;
  const sha = o.customMetadata?.sha256;
  if (sha) info.sha256 = sha;
  return info;
}

function checkUserKey(key: string): void {
  checkKey(key);
  if (key.startsWith(UPLOADS)) throw new BlobError("InvalidKey", `keys under ${UPLOADS} are reserved for upload records`);
}

const r2Code = (e: unknown): number => {
  const m = /\((\d{5})\)\s*$/.exec(String((e as Error)?.message ?? ""));
  return m ? Number(m[1]) : 0;
};

export class R2BlobStore implements BlobStore {
  readonly kind = "r2";
  readonly #b: R2Bucket;
  readonly signedUrl?: (key: string, opts: { method: "GET" | "PUT"; expiresIn: number }) => Promise<string>;

  constructor(bucket: R2Bucket, opts: R2BlobStoreOptions = {}) {
    this.#b = bucket;
    const signer = opts.signer;
    if (signer)
      this.signedUrl = async (key, o) => {
        checkUserKey(key);
        return signer.sign(o.method, key, o.expiresIn);
      };
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; sha256?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    checkUserKey(key);
    const o = await this.#b.put(key, data, {
      ...(opts.contentType ? { httpMetadata: { contentType: opts.contentType } } : {}),
      ...(opts.sha256 ? { sha256: opts.sha256, customMetadata: { sha256: opts.sha256 } } : {}),
      // R2's conditional put: refused (null) when any version exists
      ...(opts.ifAbsent ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
    });
    if (o) return infoOf(o);
    const existing = await this.#b.head(key);
    if (!existing) throw new BlobError("PreconditionFailed", `conditional put of ${key} refused, but the key is absent`);
    return infoOf(existing);
  }

  async #read(key: string, range?: ByteRange) {
    checkUserKey(key);
    if (!range) return this.#b.get(key);
    checkRange(range);
    if (range.length === 0) return (await this.#b.head(key)) ? "empty" : null;
    try {
      return await this.#b.get(key, { range: range.length === undefined ? { offset: range.offset } : { offset: range.offset, length: range.length } });
    } catch (e) {
      const h = await this.#b.head(key);
      if (!h) return null;
      if (range.offset >= h.size) return "empty";
      throw e;
    }
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    const o = await this.#read(key, range);
    if (o === null) return null;
    if (o === "empty") return new Uint8Array(0);
    return new Uint8Array(await o.arrayBuffer());
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const o = await this.#read(key, range);
    if (o === null) return null;
    if (o === "empty") return new ReadableStream({ start: (c) => c.close() });
    return o.body;
  }

  async head(key: string): Promise<BlobInfo | null> {
    checkUserKey(key);
    const o = await this.#b.head(key);
    return o ? infoOf(o) : null;
  }

  async delete(key: string): Promise<void> {
    checkUserKey(key);
    await this.#b.delete(key);
  }

  async list(prefix: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    const r = await this.#b.list({ prefix, limit, include: ["httpMetadata", "customMetadata"], ...(opts.cursor ? { cursor: opts.cursor } : {}) });
    const out: { blobs: BlobInfo[]; cursor?: string } = { blobs: r.objects.filter((o) => !o.key.startsWith(UPLOADS)).map(infoOf) };
    if (r.truncated && r.cursor) out.cursor = r.cursor;
    return out;
  }

  // ---------------------------------------------------------------- multipart

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    checkUserKey(key);
    const mpu = await this.#b.createMultipartUpload(key, opts.contentType ? { httpMetadata: { contentType: opts.contentType } } : {});
    await this.#b.put(`${UPLOADS}${mpu.uploadId}/meta`, null, { customMetadata: { key } });
    return this.#handle(key, mpu.uploadId);
  }

  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    checkUserKey(key);
    return this.#handle(key, uploadId);
  }

  async #checkUpload(key: string, uploadId: string): Promise<void> {
    // also stops an upload id from naming marker keys outside its own folder
    if (!uploadId || uploadId.includes("/")) throw new BlobError("NoSuchUpload", `no multipart upload ${JSON.stringify(uploadId)}`);
    const meta = await this.#b.head(`${UPLOADS}${uploadId}/meta`);
    if (!meta || meta.customMetadata?.key !== key) throw new BlobError("NoSuchUpload", `no multipart upload ${uploadId} for ${key}`);
  }

  // A per-part lock made from R2's conditional put: created only if absent. Another upload of the part is refused
  // at once (the client retries). A lock older than LOCK_TTL_MS, left by a request that died, is taken over by
  // compare-and-swap on its etag, so two takers can't both win.
  async #lockPart(uploadId: string, n: string): Promise<string> {
    const lockKey = `${UPLOADS}${uploadId}/l${n}`;
    const busy = () => new BlobError("PreconditionFailed", `part ${Number(n)} is being uploaded by another request; try again`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = String(Date.now());
      const made = await this.#b.put(lockKey, null, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { at } });
      if (made) return made.etag;
      const cur = await this.#b.head(lockKey);
      if (!cur) continue; // released meanwhile: try once more
      if (Date.now() - Number(cur.customMetadata?.at ?? 0) < LOCK_TTL_MS) throw busy();
      const taken = await this.#b.put(lockKey, null, { onlyIf: { etagMatches: cur.etag }, customMetadata: { at } });
      if (taken) return taken.etag;
      throw busy();
    }
    throw busy();
  }

  // Releases only our own lock: if it was taken over (we outlived the TTL), the taker's stays.
  async #unlockPart(uploadId: string, n: string, etag: string): Promise<void> {
    const lockKey = `${UPLOADS}${uploadId}/l${n}`;
    const cur = await this.#b.head(lockKey).catch(() => null);
    if (cur?.etag === etag) await this.#b.delete(lockKey).catch(() => {});
  }

  async #markers(uploadId: string): Promise<{ key: string; partNumber: number; etag: string; size: number }[]> {
    const out: { key: string; partNumber: number; etag: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.#b.list({ prefix: `${UPLOADS}${uploadId}/p`, include: ["customMetadata"], limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const o of r.objects) {
        const m = o.customMetadata ?? {};
        if (m.etag && m.size) out.push({ key: o.key, partNumber: Number(m.partNumber), etag: m.etag, size: Number(m.size) });
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.partNumber - b.partNumber);
  }

  // Every record of the upload goes: part records, part locks, and its meta.
  async #cleanup(uploadId: string): Promise<void> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.#b.list({ prefix: `${UPLOADS}${uploadId}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const o of r.objects) keys.push(o.key);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < keys.length; i += 1000) await this.#b.delete(keys.slice(i, i + 1000));
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const store = this, b = this.#b;
    const translate = (e: unknown): never => {
      const c = r2Code(e);
      if (c === 10024) throw new BlobError("NoSuchUpload", `no multipart upload ${uploadId} for ${key}`);
      if (c === 10025) throw new BlobError("InvalidPart", String((e as Error).message));
      throw e;
    };
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        // the upload must belong to this key before anything is touched: an id alone must not reach another
        // project's upload or its part records
        await store.#checkUpload(key, uploadId);
        // One uploader per part at a time, so a part's record always names the bytes R2 kept: two uploads of one part
        // that overlap give no way to tell which R2 kept. Inside the lock the record is removed before the part is
        // sent and written after it, so a failure in between leaves the part unlisted, and a resuming client sends it
        // again. (R2 deletes are free; R2 refuses parts of an aborted, completed or unknown upload itself, 10024.)
        const n = String(partNumber).padStart(5, "0");
        const lock = await store.#lockPart(uploadId, n);
        try {
          const marker = `${UPLOADS}${uploadId}/p${n}`;
          await b.delete(marker);
          const part = await b.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, data).catch(translate);
          await b.put(marker, null, { customMetadata: { partNumber: String(partNumber), etag: part.etag, size: String(data.byteLength) } });
          return { partNumber, etag: part.etag };
        } finally {
          await store.#unlockPart(uploadId, n, lock);
        }
      },
      async listParts() {
        await store.#checkUpload(key, uploadId);
        return (await store.#markers(uploadId)).map(({ partNumber, etag, size }) => ({ partNumber, etag, size }));
      },
      async complete(parts) {
        await store.#checkUpload(key, uploadId);
        const stored = new Map((await store.#markers(uploadId)).map((m) => [m.partNumber, m]));
        const order = checkCompleteParts(parts, (n) => stored.get(n), R2_MIN_PART_SIZE);
        const byNum = new Map(parts.map((p) => [p.partNumber, p.etag]));
        const o = await b
          .resumeMultipartUpload(key, uploadId)
          .complete(order.map((n) => ({ partNumber: n, etag: byNum.get(n)! })))
          .catch(translate);
        await store.#cleanup(uploadId);
        return infoOf(o);
      },
      // Idempotent for a gone upload, but bound to the key: an id alone must not reach another project's upload or
      // its part records.
      async abort() {
        if (!uploadId || uploadId.includes("/")) throw new BlobError("NoSuchUpload", `no multipart upload ${JSON.stringify(uploadId)}`);
        const meta = await b.head(`${UPLOADS}${uploadId}/meta`);
        if (meta && meta.customMetadata?.key !== key) throw new BlobError("NoSuchUpload", `no multipart upload ${uploadId} for ${key}`);
        if (!meta) return;
        await b.resumeMultipartUpload(key, uploadId).abort().catch((e) => (r2Code(e) === 10024 ? undefined : translate(e)));
        await store.#cleanup(uploadId);
      },
    };
  }
}

export function r2BlobStore(bucket: R2Bucket, opts: R2BlobStoreOptions = {}): R2BlobStore {
  return new R2BlobStore(bucket, opts);
}
