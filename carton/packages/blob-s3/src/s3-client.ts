// A small S3 client over fetch + WebCrypto: the object and multipart calls the S3 blob backend needs, for
// AWS S3, Cloudflare R2, MinIO-style servers and VersityGW. No runtime dependencies, so it runs unchanged in
// Node, browsers and Workers.
//
// ETags: every ETag this client returns is in S3's quoted header form, `"9b2cf535f27731c974343645a3985328"`
// (weak `W/"…"` ETags are passed through). Servers that send them unquoted (some do in XML listings) are
// normalised to that form, and `completeMultipartUpload` accepts parts' ETags quoted or not.

import { EMPTY_SHA256, UNSIGNED_PAYLOAD, encodeRfc3986, presignUrl, sha256Hex, signRequest } from "./sigv4.ts";
import type { Credentials } from "./sigv4.ts";
import {
  buildCompleteMultipartUpload,
  parseCompleteMultipartUpload,
  parseErrorXml,
  parseInitiateMultipartUpload,
  parseListObjectsV2,
  parseListParts,
} from "./xml.ts";

export type { Credentials } from "./sigv4.ts";

/** RequestInit plus `duplex`, which streaming uploads need and older DOM typings lack. */
export type S3FetchInit = RequestInit & { duplex?: "half" };
export type FetchLike = (url: string, init: S3FetchInit) => Promise<Response>;

export interface S3ClientOptions {
  /** Service origin, e.g. `https://<account>.r2.cloudflarestorage.com` or `http://127.0.0.1:7070`. */
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  /** Signing region. `"auto"` (default) is what R2 expects; AWS, MinIO and VersityGW want a real region such as `us-east-1`. */
  region?: string;
  /** `true` (default): `endpoint/bucket/key`. `false`: virtual-hosted `bucket.endpoint/key`. */
  forcePathStyle?: boolean;
  /**
   * `"unsigned"` (default) sends `UNSIGNED-PAYLOAD`, so bodies are not hashed before sending (TLS already
   * protects them in transit). `"signed"` hashes byte bodies with SHA-256 and signs the hash. Stream bodies are
   * always unsigned: hashing them would need the whole body before the first byte is sent.
   */
  payload?: "signed" | "unsigned";
  /** fetch implementation; defaults to the global one. */
  fetch?: FetchLike;
  /** Extra attempts for idempotent requests after a 429/5xx or a network error. Default 2. */
  retries?: number;
  /** First retry delay; later ones double, with full jitter, up to 20x this. Default 100 ms. */
  retryBaseDelayMs?: number;
}

export interface S3ErrorInit {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  cause?: unknown;
}

/**
 * Any failed S3 call. `status` is the HTTP status (0 for a network failure, and 200 when S3 reported a
 * failure inside a 200 response, as CompleteMultipartUpload can). `code` is S3's error code, e.g. `NoSuchKey`,
 * `SignatureDoesNotMatch`, `InvalidRange`, or a status-derived one when the response had no XML body (HEAD).
 */
export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(init: S3ErrorInit) {
    super(`${init.code}: ${init.message}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "S3Error";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
  }
}

export type ByteRange = { offset: number; length?: number } | { suffix: number };

export interface GetObjectResult {
  body: ReadableStream<Uint8Array>;
  /** Total size of the object (not of the returned range). */
  size: number;
  etag: string;
  contentType: string | undefined;
  /** The bytes returned, present when a range was asked for. */
  range?: { offset: number; length: number };
}

export interface HeadObjectResult {
  size: number;
  etag: string;
  contentType: string | undefined;
  lastModified: Date | undefined;
  /** User metadata (`x-amz-meta-*`), names without the prefix. */
  metadata: Record<string, string>;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

type Body = Uint8Array | ReadableStream<Uint8Array>;

interface CallOptions {
  signal?: AbortSignal;
}

interface RequestSpec {
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  /** Object key; undefined addresses the bucket itself. */
  key?: string;
  query?: Array<[string, string]>;
  /** Headers that are sent and signed. */
  headers?: Record<string, string>;
  body?: Body;
  /** Sent but not signed: browsers and some runtimes set or drop it themselves. */
  contentLength?: number;
  /** Safe to send again after an unknown outcome. Only these requests are retried. */
  idempotent: boolean;
  signal?: AbortSignal;
}

// 429 is throttling (R2 and AWS SlowDown can also be 503): retrying it is what SDKs do and is safe for the
// idempotent requests that are the only ones retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_PART_NUMBER = 10000;
const encoder = new TextEncoder();

/** Puts an ETag in quoted form; empty if the server sent none. */
export function normalizeEtag(raw: string | null | undefined): string {
  const etag = raw?.trim() ?? "";
  if (etag === "" || etag.startsWith('"') || etag.startsWith("W/")) return etag;
  return `"${etag}"`;
}

function encodeKey(key: string): string {
  if (typeof key !== "string" || key === "") throw new TypeError("S3 object key must be a non-empty string");
  const segments = key.split("/");
  for (const segment of segments) {
    // URL parsers (and so fetch) collapse `.`/`..` segments, even percent-encoded, so the request would hit a
    // different key from the one signed. S3 allows such keys but no fetch-based client can address them.
    if (segment === "." || segment === "..") throw new TypeError(`S3 key has a "${segment}" path segment, which URLs cannot carry: ${key}`);
  }
  try {
    return segments.map(encodeRfc3986).join("/");
  } catch {
    throw new TypeError("S3 key is not valid Unicode (unpaired surrogate)");
  }
}

function rangeHeader(range: ByteRange): string {
  if ("suffix" in range) {
    if (!Number.isSafeInteger(range.suffix) || range.suffix < 1) throw new RangeError(`suffix must be a positive integer, got ${range.suffix}`);
    return `bytes=-${range.suffix}`;
  }
  const { offset, length } = range;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
  if (length === undefined) return `bytes=${offset}-`;
  // A zero-length range cannot be written as an HTTP byte range.
  if (!Number.isSafeInteger(length) || length < 1) throw new RangeError(`length must be a positive integer, got ${length}`);
  return `bytes=${offset}-${offset + length - 1}`;
}

function describeRange(range: ByteRange): string {
  if ("suffix" in range) return `the last ${range.suffix} bytes`;
  return range.length === undefined ? `bytes from ${range.offset}` : `${range.length} bytes at ${range.offset}`;
}

// Parses `bytes 0-9/100`, and the `bytes */100` form a 416 carries.
function parseContentRange(header: string | null): { start?: number; end?: number; total?: number } | null {
  if (header === null) return null;
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(header.trim());
  if (m === null) return null;
  return {
    start: m[1] === undefined ? undefined : Number(m[1]),
    end: m[2] === undefined ? undefined : Number(m[2]),
    total: m[3] === "*" ? undefined : Number(m[3]),
  };
}

function headerSize(res: Response): number {
  const value = res.headers.get("content-length");
  return value === null ? -1 : Number(value);
}

function bodyLength(body: Body, contentLength: number | undefined): number {
  if (body instanceof Uint8Array) {
    if (contentLength !== undefined && contentLength !== body.byteLength) {
      throw new RangeError(`contentLength ${contentLength} does not match the body's ${body.byteLength} bytes`);
    }
    return body.byteLength;
  }
  // S3 needs Content-Length up front (it rejects chunked uploads without aws-chunked signing).
  if (contentLength === undefined || !Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new TypeError("a ReadableStream body needs contentLength");
  }
  return contentLength;
}

function checkPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
    throw new RangeError(`partNumber must be an integer from 1 to ${MAX_PART_NUMBER}, got ${partNumber}`);
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}

/** Reads and drops a small response body so the connection can be reused. */
async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // The connection is gone either way; nothing to recover.
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fallbackCode(status: number): string {
  switch (status) {
    case 400: return "BadRequest";
    case 403: return "Forbidden";
    case 404: return "NotFound";
    case 412: return "PreconditionFailed";
    case 416: return "InvalidRange";
    default: return `Http${status}`;
  }
}

export class S3Client {
  readonly bucket: string;
  readonly region: string;
  private readonly credentials: Credentials;
  private readonly protocol: string;
  private readonly host: string;
  private readonly basePath: string;
  private readonly forcePathStyle: boolean;
  private readonly signPayload: boolean;
  private readonly fetchFn: FetchLike;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: S3ClientOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.search !== "" || endpoint.hash !== "") throw new TypeError("endpoint must not have a query or fragment");
    if (!options.bucket) throw new TypeError("bucket is required");
    if (!options.credentials?.accessKeyId || !options.credentials.secretAccessKey) throw new TypeError("credentials are required");
    const retries = options.retries ?? 2;
    if (!Number.isInteger(retries) || retries < 0) throw new RangeError(`retries must be a non-negative integer, got ${retries}`);

    this.bucket = options.bucket;
    this.region = options.region ?? "auto";
    this.credentials = options.credentials;
    this.protocol = endpoint.protocol;
    this.host = endpoint.host;
    // An endpoint may sit under a path prefix behind a proxy; keep it without the trailing slash.
    this.basePath = endpoint.pathname.replace(/\/+$/, "");
    this.forcePathStyle = options.forcePathStyle ?? true;
    this.signPayload = (options.payload ?? "unsigned") === "signed";
    // Wrapped rather than stored bare: browsers and Workers throw "Illegal invocation" for a detached fetch.
    this.fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.retries = retries;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
  }

  /** URL of the bucket (key undefined) or of an object, with the path encoded exactly as it is signed. */
  private url(key: string | undefined, query?: Array<[string, string]>): string {
    const objectPath = key === undefined ? "" : encodeKey(key);
    let url: string;
    if (this.forcePathStyle) {
      url = `${this.protocol}//${this.host}${this.basePath}/${encodeRfc3986(this.bucket)}`;
      if (key !== undefined) url += `/${objectPath}`;
    } else {
      url = `${this.protocol}//${this.bucket}.${this.host}${this.basePath}/${objectPath}`;
    }
    if (query !== undefined && query.length > 0) {
      // A bare name (`?uploads`) for empty values: some servers only recognise subresources written that way.
      url += "?" + query.map(([name, value]) => (value === "" ? encodeRfc3986(name) : `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)).join("&");
    }
    return url;
  }

  private backoff(attempt: number): number {
    const cap = Math.min(this.retryBaseDelayMs * 20, this.retryBaseDelayMs * 2 ** (attempt - 1));
    return Math.random() * cap;
  }

  /**
   * Sends a signed request. Returns any HTTP response (callers decide what a status means); retries only
   * idempotent requests with a replayable body, re-signing each attempt so the timestamp stays fresh.
   */
  private async request(spec: RequestSpec): Promise<Response> {
    const url = this.url(spec.key, spec.query);
    const body = spec.body;
    const isStream = body !== undefined && !(body instanceof Uint8Array);
    const payloadHash = isStream || !this.signPayload ? UNSIGNED_PAYLOAD : body === undefined ? EMPTY_SHA256 : await sha256Hex(body);
    const maxAttempts = spec.idempotent && !isStream ? this.retries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      const auth = await signRequest({
        method: spec.method,
        url,
        headers: spec.headers,
        payloadHash,
        credentials: this.credentials,
        region: this.region,
        service: "s3",
      });
      const headers: Record<string, string> = { ...spec.headers, ...auth };
      if (spec.contentLength !== undefined && isStream) headers["content-length"] = String(spec.contentLength);
      const init: S3FetchInit = { method: spec.method, headers, signal: spec.signal };
      if (body !== undefined) {
        // fetch's typings want ArrayBuffer-backed views; a Uint8Array over a SharedArrayBuffer fails at runtime either way.
        init.body = body as Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
        if (isStream) init.duplex = "half";
      }

      let res: Response;
      try {
        res = await this.fetchFn(url, init);
      } catch (error) {
        if (spec.signal?.aborted) throw spec.signal.reason;
        if (attempt >= maxAttempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new S3Error({ status: 0, code: "NetworkError", message: `${spec.method} failed: ${message}`, cause: error });
        }
        await sleep(this.backoff(attempt), spec.signal);
        continue;
      }
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
        await discard(res);
        await sleep(this.backoff(attempt), spec.signal);
        continue;
      }
      return res;
    }
  }

  private async toError(res: Response, method: string): Promise<S3Error> {
    let text = "";
    if (method !== "HEAD") {
      try {
        text = await res.text();
      } catch {
        // Keep the status-derived error.
      }
    }
    const parsed = text === "" ? null : parseErrorXml(text);
    return new S3Error({
      status: res.status,
      code: parsed?.code || fallbackCode(res.status),
      message: parsed?.message || res.statusText || `HTTP ${res.status}`,
      requestId: res.headers.get("x-amz-request-id") ?? parsed?.requestId,
    });
  }

  /** Uploads an object in one request. A stream body needs `contentLength` and is never retried. */
  async putObject(
    key: string,
    body: Body,
    options: CallOptions & {
      contentType?: string;
      contentLength?: number;
      /** User metadata, sent as `x-amz-meta-<name>` (ASCII names and values) and returned by headObject. */
      metadata?: Record<string, string>;
      /** `"*"`: write only if the key doesn't exist (a conditional write; S3 answers 412 PreconditionFailed). */
      ifNoneMatch?: "*";
    } = {},
  ): Promise<{ etag: string }> {
    const contentLength = bodyLength(body, options.contentLength);
    const headers: Record<string, string> = {};
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      if (!/^[a-z0-9-]+$/.test(name) || !/^[\x20-\x7e]*$/.test(value)) throw new TypeError(`metadata ${name}: lowercase ASCII names and printable ASCII values only`);
      headers[`x-amz-meta-${name}`] = value;
    }
    if (options.ifNoneMatch !== undefined) headers["if-none-match"] = options.ifNoneMatch;
    const res = await this.request({
      method: "PUT", key, headers, body, contentLength, idempotent: true, signal: options.signal,
    });
    if (!res.ok) throw await this.toError(res, "PUT");
    await discard(res);
    return { etag: normalizeEtag(res.headers.get("etag")) };
  }

  /**
   * Reads an object, or a byte range of it. Returns null when the key does not exist. A range that starts at or
   * past the end of the object throws an S3Error with status 416.
   */
  async getObject(key: string, options: CallOptions & { range?: ByteRange } = {}): Promise<GetObjectResult | null> {
    const { range } = options;
    const headers: Record<string, string> = {};
    if (range !== undefined) headers.range = rangeHeader(range);
    const res = await this.request({ method: "GET", key, headers, idempotent: true, signal: options.signal });

    if (res.status === 404) {
      const error = await this.toError(res, "GET");
      // A missing bucket is a configuration error, not a missing object.
      if (error.code === "NoSuchBucket") throw error;
      return null;
    }
    if (res.status === 416) {
      const error = await this.toError(res, "GET");
      const total = parseContentRange(res.headers.get("content-range"))?.total;
      const size = total === undefined ? "" : ` (object size ${total})`;
      throw new S3Error({
        status: 416,
        code: error.code,
        message: `requested range (${range === undefined ? "none" : describeRange(range)}) is not satisfiable${size}`,
        requestId: error.requestId,
      });
    }
    if (!res.ok) throw await this.toError(res, "GET");

    const result: GetObjectResult = {
      body: res.body ?? emptyStream(),
      size: headerSize(res),
      etag: normalizeEtag(res.headers.get("etag")),
      contentType: res.headers.get("content-type") ?? undefined,
    };
    if (range === undefined) return result;

    if (res.status === 206) {
      const contentRange = parseContentRange(res.headers.get("content-range"));
      if (contentRange?.start === undefined || contentRange.end === undefined) {
        await res.body?.cancel();
        throw new S3Error({ status: 206, code: "InvalidResponse", message: "206 response without a usable Content-Range" });
      }
      result.size = contentRange.total ?? -1;
      result.range = { offset: contentRange.start, length: contentRange.end - contentRange.start + 1 };
      return result;
    }
    // 200 to a ranged request: the server ignored Range (HTTP allows that). That is only the bytes asked for
    // when the range covered the whole object; otherwise fail rather than hand back bytes from offset 0.
    const covers = "suffix" in range
      ? range.suffix >= result.size
      : range.offset === 0 && (range.length === undefined || range.length >= result.size);
    if (!covers || result.size < 0) {
      await res.body?.cancel();
      throw new S3Error({ status: 200, code: "RangeNotHonoured", message: `server ignored the Range header for ${describeRange(range)}` });
    }
    result.range = { offset: 0, length: result.size };
    return result;
  }

  /** Object metadata, or null when the key does not exist. */
  async headObject(key: string, options: CallOptions = {}): Promise<HeadObjectResult | null> {
    const res = await this.request({ method: "HEAD", key, idempotent: true, signal: options.signal });
    // HEAD has no body, so a 404 cannot say whether the bucket or the key is missing.
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, "HEAD");
    const lastModified = res.headers.get("last-modified");
    const metadata: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) metadata[name.slice(11)] = value;
    });
    return {
      size: headerSize(res),
      etag: normalizeEtag(res.headers.get("etag")),
      contentType: res.headers.get("content-type") ?? undefined,
      lastModified: lastModified === null ? undefined : new Date(lastModified),
      metadata,
    };
  }

  /** Deletes an object. Deleting a key that does not exist succeeds (S3 itself answers 204 either way). */
  async deleteObject(key: string, options: CallOptions = {}): Promise<void> {
    const res = await this.request({ method: "DELETE", key, idempotent: true, signal: options.signal });
    if (res.ok) {
      await discard(res);
      return;
    }
    const error = await this.toError(res, "DELETE");
    if (res.status === 404 && error.code !== "NoSuchBucket") return;
    throw error;
  }

  /**
   * One page of ListObjectsV2. `next` is the continuation token for the following page, absent on the last.
   * Keys containing characters XML 1.0 cannot carry (most C0 controls) are not supported.
   */
  async listObjects(
    prefix: string,
    options: CallOptions & { continuationToken?: string; maxKeys?: number } = {},
  ): Promise<{ objects: ListedObject[]; next?: string }> {
    const query: Array<[string, string]> = [["list-type", "2"]];
    if (prefix !== "") query.push(["prefix", prefix]);
    if (options.continuationToken !== undefined) query.push(["continuation-token", options.continuationToken]);
    if (options.maxKeys !== undefined) {
      if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 1000) {
        throw new RangeError(`maxKeys must be an integer from 1 to 1000, got ${options.maxKeys}`);
      }
      query.push(["max-keys", String(options.maxKeys)]);
    }
    const res = await this.request({ method: "GET", query, idempotent: true, signal: options.signal });
    if (!res.ok) throw await this.toError(res, "GET");
    const page = parseListObjectsV2(await res.text());
    const objects = page.objects.map((o) => ({ key: o.key, size: o.size, etag: normalizeEtag(o.etag) }));
    if (!page.isTruncated) return { objects };
    if (page.nextContinuationToken === undefined) {
      throw new S3Error({ status: res.status, code: "InvalidResponse", message: "truncated listing without NextContinuationToken" });
    }
    return { objects, next: page.nextContinuationToken };
  }

  /** Starts a multipart upload and returns its upload ID. Never retried: a repeat would create a second upload. */
  async createMultipartUpload(key: string, options: CallOptions & { contentType?: string } = {}): Promise<string> {
    const headers: Record<string, string> = {};
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    const res = await this.request({
      method: "POST", key, query: [["uploads", ""]], headers, idempotent: false, signal: options.signal,
    });
    if (!res.ok) throw await this.toError(res, "POST");
    return parseInitiateMultipartUpload(await res.text()).uploadId;
  }

  /** Uploads one part (1..10000). Byte bodies are retried; re-sending a part just replaces it. */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Body,
    options: CallOptions & { contentLength?: number } = {},
  ): Promise<{ etag: string }> {
    checkPartNumber(partNumber);
    const contentLength = bodyLength(body, options.contentLength);
    const res = await this.request({
      method: "PUT",
      key,
      query: [["partNumber", String(partNumber)], ["uploadId", uploadId]],
      body,
      contentLength,
      idempotent: true,
      signal: options.signal,
    });
    if (!res.ok) throw await this.toError(res, "PUT");
    await discard(res);
    return { etag: normalizeEtag(res.headers.get("etag")) };
  }

  /**
   * Every part uploaded so far, in part-number order, following pagination. This is how an interrupted upload
   * resumes: re-send only the parts missing here. A finished or aborted upload throws `NoSuchUpload` (404).
   */
  async listParts(key: string, uploadId: string, options: CallOptions = {}): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const query: Array<[string, string]> = [["uploadId", uploadId]];
      if (marker !== undefined) query.push(["part-number-marker", marker]);
      const res = await this.request({ method: "GET", key, query, idempotent: true, signal: options.signal });
      if (!res.ok) throw await this.toError(res, "GET");
      const page = parseListParts(await res.text());
      for (const part of page.parts) parts.push({ partNumber: part.partNumber, etag: normalizeEtag(part.etag), size: part.size });
      if (!page.isTruncated) break;
      if (page.nextPartNumberMarker === undefined || page.nextPartNumberMarker === marker) {
        throw new S3Error({ status: res.status, code: "InvalidResponse", message: "truncated part listing without a new NextPartNumberMarker" });
      }
      marker = page.nextPartNumberMarker;
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }

  /**
   * Joins the parts into the object. Parts may be given in any order. Not retried (it is not idempotent once
   * it has succeeded). S3 may answer 200 with an `<Error>` body; that throws an S3Error whose status is 200.
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
    options: CallOptions = {},
  ): Promise<{ etag: string }> {
    if (parts.length === 0) throw new TypeError("completeMultipartUpload needs at least one part");
    const sorted = parts
      .map((p) => {
        checkPartNumber(p.partNumber);
        const etag = normalizeEtag(p.etag);
        if (etag === "") throw new TypeError(`part ${p.partNumber} has no ETag`);
        return { partNumber: p.partNumber, etag };
      })
      .sort((a, b) => a.partNumber - b.partNumber);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].partNumber === sorted[i - 1].partNumber) throw new TypeError(`part ${sorted[i].partNumber} is listed twice`);
    }

    const res = await this.request({
      method: "POST",
      key,
      query: [["uploadId", uploadId]],
      headers: { "content-type": "application/xml" },
      body: encoder.encode(buildCompleteMultipartUpload(sorted)),
      idempotent: false,
      signal: options.signal,
    });
    if (!res.ok) throw await this.toError(res, "POST");
    const text = await res.text();
    const failure = parseErrorXml(text);
    if (failure !== null) {
      throw new S3Error({
        status: res.status,
        code: failure.code || "InternalError",
        message: failure.message || "CompleteMultipartUpload failed",
        requestId: res.headers.get("x-amz-request-id") ?? failure.requestId,
      });
    }
    return { etag: normalizeEtag(parseCompleteMultipartUpload(text).etag) };
  }

  /**
   * Abandons a multipart upload and frees its parts. An upload that is already gone (aborted, completed, or
   * expired) counts as success, so a retried or repeated abort does not fail.
   */
  async abortMultipartUpload(key: string, uploadId: string, options: CallOptions = {}): Promise<void> {
    const res = await this.request({
      method: "DELETE", key, query: [["uploadId", uploadId]], idempotent: true, signal: options.signal,
    });
    if (res.ok) {
      await discard(res);
      return;
    }
    const error = await this.toError(res, "DELETE");
    if (res.status === 404 && error.code !== "NoSuchBucket") return;
    throw error;
  }

  /**
   * A presigned URL for a plain `fetch` GET or PUT of `key`, valid for `expiresSeconds` (1..604800) from
   * `datetime` (default now; set it to correct for a skewed clock). A presigned PUT accepts any body and
   * content type: the payload is unsigned and only `host` is a signed header.
   */
  async presign(method: "GET" | "PUT", key: string, options: { expiresSeconds: number; datetime?: Date }): Promise<string> {
    return presignUrl({
      method,
      url: this.url(key),
      credentials: this.credentials,
      region: this.region,
      service: "s3",
      expiresSeconds: options.expiresSeconds,
      datetime: options.datetime,
    });
  }
}
