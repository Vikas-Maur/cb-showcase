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

  async #cleanup(uploadId: string): Promise<void> {
    const keys = (await this.#markers(uploadId)).map((m) => m.key);
    keys.push(`${UPLOADS}${uploadId}/meta`);
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
        // A part's record is removed before the part is sent and created after it, create-only. A failure in between
        // leaves the part unlisted (a resuming client sends it again). If the create finds a record already there,
        // another upload of the same part overlapped this one, and nothing tells which bytes R2 kept: the record
        // goes, the part is unlisted, and this call fails, so the client sends it once more. A record never names
        // bytes R2 doesn't hold. (R2 deletes are free; R2 refuses parts of an aborted, completed or unknown upload
        // itself, 10024.)
        const marker = `${UPLOADS}${uploadId}/p${String(partNumber).padStart(5, "0")}`;
        await b.delete(marker);
        const part = await b.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, data).catch(translate);
        const made = await b.put(marker, null, {
          onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: { partNumber: String(partNumber), etag: part.etag, size: String(data.byteLength) },
        });
        if (!made) {
          await b.delete(marker);
          throw new BlobError("InvalidPart", `part ${partNumber} was uploaded twice at once; upload it again`);
        }
        return { partNumber, etag: part.etag };
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
