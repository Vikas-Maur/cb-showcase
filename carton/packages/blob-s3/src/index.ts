// BlobStore plug-in for any S3-compatible service (AWS S3, R2's S3 API, GCS interop, MinIO, B2): fetch plus SigV4
// signing on WebCrypto, so it runs in Node, browsers and Workers (PLAN §3.1, §11). Credentials come from the caller,
// never from code. Owner: hosts-plugins.
//
// Where S3 differs from the BlobStore contract, this adapter closes the gap:
// - A range at or past the end is a 416 on S3; the contract wants an empty array. On a 416, a missing key is null,
//   an existing one gives empty bytes. A length-0 range is answered by a HEAD.
// - `ifAbsent` is a conditional write (`If-None-Match: *`, supported by AWS, R2 and MinIO); a 412 means the key
//   exists, and its info is returned.
// - `sha256` is kept as user metadata (`x-amz-meta-carton-sha256`) so `head` returns it.
// - The part rules (equal parts, the last no larger, 5 MiB minimum) are checked before CompleteMultipartUpload, from
//   ListParts, so a client that works here works on R2 too (AWS alone would accept unequal parts).

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkRange, checkPartNumber, checkCompleteParts, BlobError, markCreated, type BlobErrorCode } from "@carton/blob-memory/rules";
import { S3Client, S3Error, type FetchLike } from "./s3-client.ts";

export { S3Client, S3Error, normalizeEtag, type S3ClientOptions, type FetchLike } from "./s3-client.ts";

export const S3_MIN_PART_SIZE = 5 * 1024 * 1024;
const SHA_META = "carton-sha256";

export interface S3BlobStoreOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style URLs (MinIO, R2, most non-AWS services). Default true. */
  forcePathStyle?: boolean;
  fetch?: typeof fetch;
  /** "signed" hashes byte bodies into the signature; default "unsigned" (TLS protects them in transit). */
  payload?: "signed" | "unsigned";
  /** Smallest part but the last (default 5 MiB, S3's and R2's minimum). */
  minPartSize?: number;
}

function toBlobError(e: unknown): never {
  if (e instanceof S3Error) {
    const map: Record<string, BlobErrorCode> = { NoSuchUpload: "NoSuchUpload", InvalidPart: "InvalidPart", InvalidPartOrder: "InvalidPartOrder", EntityTooSmall: "EntityTooSmall" };
    const code = map[e.code];
    if (code) throw new BlobError(code, e.message);
  }
  throw e;
}

async function bytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class S3BlobStore implements BlobStore {
  readonly kind = "s3";
  readonly client: S3Client;
  readonly #minPart: number;

  constructor(opts: S3BlobStoreOptions) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      bucket: opts.bucket,
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}) },
      forcePathStyle: opts.forcePathStyle ?? true,
      ...(opts.payload ? { payload: opts.payload } : {}),
      ...(opts.fetch ? { fetch: opts.fetch as unknown as FetchLike } : {}),
    });
    this.#minPart = opts.minPartSize ?? S3_MIN_PART_SIZE;
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; sha256?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    checkKey(key);
    try {
      const r = await this.client.putObject(key, data, {
        ...(opts.contentType ? { contentType: opts.contentType } : {}),
        ...(opts.sha256 ? { metadata: { [SHA_META]: opts.sha256 } } : {}),
        ...(opts.ifAbsent ? { ifNoneMatch: "*" } : {}),
      });
      const info: BlobInfo = { key, size: data.byteLength, etag: r.etag };
      if (opts.contentType) info.contentType = opts.contentType;
      if (opts.sha256) info.sha256 = opts.sha256;
      return opts.ifAbsent ? markCreated(info, true) : info;
    } catch (e) {
      // the key exists: a conditional write leaves it alone
      if (opts.ifAbsent && e instanceof S3Error && (e.status === 412 || e.code === "PreconditionFailed")) {
        const existing = await this.head(key);
        if (existing) return markCreated(existing, false);
      }
      throw e;
    }
  }

  async #read(key: string, range?: ByteRange) {
    checkKey(key);
    if (range) {
      checkRange(range);
      if (range.length === 0) return (await this.client.headObject(key)) ? "empty" : null;
    }
    try {
      return await this.client.getObject(key, range ? { range: range.length === undefined ? { offset: range.offset } : { offset: range.offset, length: range.length } } : {});
    } catch (e) {
      if (e instanceof S3Error && e.status === 416) return (await this.client.headObject(key)) ? "empty" : null;
      throw e;
    }
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    const r = await this.#read(key, range);
    if (r === null) return null;
    if (r === "empty") return new Uint8Array(0);
    return bytes(r.body);
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const r = await this.#read(key, range);
    if (r === null) return null;
    if (r === "empty") return new ReadableStream({ start: (c) => c.close() });
    return r.body;
  }

  async head(key: string): Promise<BlobInfo | null> {
    checkKey(key);
    const h = await this.client.headObject(key);
    if (!h) return null;
    const info: BlobInfo = { key, size: h.size, etag: h.etag };
    if (h.contentType && h.contentType !== "binary/octet-stream") info.contentType = h.contentType;
    const sha = h.metadata?.[SHA_META];
    if (sha) info.sha256 = sha;
    return info;
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    await this.client.deleteObject(key);
  }

  async list(prefix: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    const r = await this.client.listObjects(prefix, { ...(opts.cursor ? { continuationToken: opts.cursor } : {}), maxKeys: Math.max(1, Math.min(opts.limit ?? 1000, 1000)) });
    const out: { blobs: BlobInfo[]; cursor?: string } = { blobs: r.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag })) };
    if (r.next) out.cursor = r.next;
    return out;
  }

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    checkKey(key);
    const id = await this.client.createMultipartUpload(key, opts.contentType ? { contentType: opts.contentType } : {});
    return this.#handle(key, id);
  }

  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    checkKey(key);
    return this.#handle(key, uploadId);
  }

  // Signed with SigV4 by the service's own rules: anyone holding the URL can GET (with ranges) or PUT that key.
  async signedUrl(key: string, opts: { method: "GET" | "PUT"; expiresIn: number }): Promise<string> {
    checkKey(key);
    return this.client.presign(opts.method, key, { expiresSeconds: Math.max(1, Math.min(604_800, Math.floor(opts.expiresIn))) });
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const c = this.client, store = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        const r = await c.uploadPart(key, uploadId, partNumber, data).catch(toBlobError);
        return { partNumber, etag: r.etag };
      },
      async listParts() {
        return (await c.listParts(key, uploadId).catch(toBlobError)).map((p) => ({ partNumber: p.partNumber, etag: p.etag, size: p.size }));
      },
      async complete(parts) {
        const stored = new Map((await c.listParts(key, uploadId).catch(toBlobError)).map((p) => [p.partNumber, p]));
        const order = checkCompleteParts(parts, (n) => stored.get(n), store.#minPart);
        const byNum = new Map(parts.map((p) => [p.partNumber, p.etag]));
        await c.completeMultipartUpload(key, uploadId, order.map((n) => ({ partNumber: n, etag: byNum.get(n)! }))).catch(toBlobError);
        const info = await store.head(key);
        if (!info) throw new BlobError("NoSuchUpload", `${key} is missing right after its upload completed`);
        return info;
      },
      async abort() {
        await c.abortMultipartUpload(key, uploadId);
      },
    };
  }
}

export function createS3BlobStore(opts: S3BlobStoreOptions): S3BlobStore {
  return new S3BlobStore(opts);
}
