// A BlobStore over a Carton host's HTTP API (@carton/host-http, the same on server-node and the Worker), with `fetch`
// only, so one file runs in the page, the Service Worker and Node 24 (the seed script). Keys are relative to the
// project's media scope on the host (`projects/<p>/media/`), which the host adds; a client can't name anything else.
//
// - Reads go to short-lived signed URLs (`/blob/<p>/<key>?exp&sig`) with an HTTP Range, so the host streams exactly
//   the bytes asked for. A key's URL is signed once and reused until shortly before it expires: MediaReader reads a
//   proxy as many ranged requests, and one sign round trip per range would double them.
// - Writes: a signed PUT for whole objects, the `/uploads` routes for resumable multipart uploads.
// - The API has no list or delete, so those throw.
// - The session token is asked for on every request: tokens expire and the caller refreshes them.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkPartNumber, checkRange } from "@carton/blob-memory/rules";
import { SHA256_HEADER } from "@carton/blob-memory/signed";

export interface HttpBlobStoreOptions {
  /** The host as this client reaches it, e.g. `https://carton.example` (in a page or Service Worker: `location.origin`). */
  baseUrl: string;
  projectId: string;
  /** The current session token. Called for every request, so a refreshed token is used at once. */
  token: () => Promise<string> | string;
  fetch?: typeof fetch;
  /** Lifetime asked for signed read URLs, in seconds (hosts cap it at 3600). Default 600. */
  urlTtlSec?: number;
}

export type HttpBlobStore = BlobStore & {
  signedUrl(key: string, opts: { method: "GET" | "PUT"; expiresIn: number }): Promise<string>;
};

/**
 * A failed request. `status` is the HTTP status; `code` is the host's BlobError code when it sent one (NoSuchUpload
 * with 404 for an unknown or finished upload id, which is what @carton/media's uploadMedia looks for to start over).
 */
export class HttpBlobError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpBlobError";
    this.status = status;
    if (code) this.code = code;
  }
}

// A signed URL is re-signed this long before it expires, so a request never leaves with one about to lapse.
const RESIGN_MARGIN_MS = 30_000;
// Signed read URLs kept. Each is a short string; a player reads a handful of keys, the seed a few dozen.
const MAX_URLS = 256;

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });

async function errorOf(res: Response, what: string): Promise<HttpBlobError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof j?.error === "string") message = j.error;
    if (typeof j?.code === "string") code = j.code;
  } catch {
    // not JSON (a signed URL answers in plain text)
  }
  return new HttpBlobError(res.status, `${what}: ${message}`, code);
}

/**
 * The stored object's info a PUT's answer carries (a Carton host's 200 or 412: `key`, `size`, `etag`, `contentType`,
 * `sha256`), under the caller's key; null for an answer without a JSON body holding a numeric `size`: a bucket's own
 * answer on a presigned URL, or an older host's. Consumes the body.
 */
async function storedInfo(res: Response, key: string): Promise<BlobInfo | null> {
  let j: Partial<Record<keyof BlobInfo, unknown>> | null = null;
  try {
    j = JSON.parse(await res.text());
  } catch {
    return null; // empty, or not JSON (a bucket's XML)
  }
  if (!j || typeof j !== "object" || typeof j.size !== "number") return null;
  const info: BlobInfo = { key, size: j.size };
  if (typeof j.etag === "string") info.etag = j.etag;
  if (typeof j.contentType === "string") info.contentType = j.contentType;
  if (typeof j.sha256 === "string") info.sha256 = j.sha256;
  return info;
}

export function httpBlobStore(o: HttpBlobStoreOptions): HttpBlobStore {
  const base = o.baseUrl.replace(/\/+$/, "");
  const api = `${base}/api/projects/${encodeURIComponent(o.projectId)}`;
  const blobPath = `/blob/${encodeURIComponent(o.projectId)}/`;
  // Called through a closure: a Service Worker's fetch throws "Illegal invocation" when called as another object's method.
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
  const ttl = Math.min(3600, Math.max(60, Math.floor(o.urlTtlSec ?? 600)));
  const readUrls = new Map<string, { url: Promise<string>; until: number }>();

  /** An API request with the session token. A 401 is tried once more if the token changed meanwhile (a refresh raced it). */
  async function call(method: string, path: string, body?: Uint8Array | object): Promise<Response> {
    const headers: Record<string, string> = {};
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as Uint8Array<ArrayBuffer>;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    let token = await o.token();
    for (;;) {
      headers.authorization = `Bearer ${token}`;
      const res = await doFetch(api + path, { method, headers, body: payload });
      if (res.status !== 401) return res;
      const fresh = await o.token();
      if (fresh === token) return res;
      await res.body?.cancel();
      token = fresh;
    }
  }

  async function json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw await errorOf(res, what);
    return (await res.json()) as T;
  }

  // host-http signs `<origin>/blob/<p>/<key>` with the origin the client reached (its Host header). Behind a proxy
  // without `trustProxy` or `publicOrigin` that is the proxy's upstream address, which a browser can't fetch. The
  // signature covers the path and query only, so the same path on the base we already reach works on every host.
  function rebase(signed: string): string {
    const u = new URL(signed, base + "/");
    return u.pathname.startsWith(blobPath) ? base + u.pathname + u.search : u.href;
  }

  async function sign(method: "GET" | "PUT", key: string, expiresIn: number): Promise<string> {
    const r = await json<{ url: string }>(await call("POST", "/blobs/sign", { key, method, expiresIn }), `sign ${method} ${key}`);
    return rebase(r.url);
  }

  /** The signed read URL for `key`: cached until shortly before it expires; `fresh` signs again (after a 403). */
  function readUrl(key: string, fresh: boolean): Promise<string> {
    const now = Date.now();
    const hit = readUrls.get(key);
    if (hit && !fresh && now < hit.until) return hit.url;
    const entry = { url: sign("GET", key, ttl), until: now + ttl * 1000 - Math.min(RESIGN_MARGIN_MS, (ttl * 1000) / 4) };
    readUrls.delete(key);
    readUrls.set(key, entry);
    if (readUrls.size > MAX_URLS) readUrls.delete(readUrls.keys().next().value!);
    entry.url.catch(() => {
      if (readUrls.get(key) === entry) readUrls.delete(key);
    });
    return entry.url;
  }

  async function head(key: string): Promise<BlobInfo | null> {
    checkKey(key);
    const res = await call("GET", `/blobs/head?key=${encodeURIComponent(key)}`);
    if (res.ok) return (await res.json()) as BlobInfo;
    const e = await errorOf(res, `head ${key}`);
    // Only "no such blob" means absent: a 404 for a missing route or blob store is a broken host, not a missing key.
    if (res.status === 404 && e.message.endsWith(": no such blob")) return null;
    throw e;
  }

  /** The response for `range` of `key`: null when the key is absent, "empty" when the range holds no bytes. */
  async function open(key: string, range: ByteRange | undefined): Promise<Response | null | "empty"> {
    checkKey(key);
    if (range) checkRange(range);
    // HTTP can't ask for zero bytes, so a zero-length range only needs to know the key exists.
    if (range?.length === 0) return (await head(key)) ? "empty" : null;
    const offset = range?.offset ?? 0;
    const headers: Record<string, string> = {};
    if (offset > 0 || range?.length !== undefined) headers.range = `bytes=${offset}-${range?.length === undefined ? "" : offset + range.length - 1}`;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(await readUrl(key, attempt > 0), { headers });
      if (res.status === 200 || res.status === 206) {
        // Exact ranges or nothing: a host (or proxy) that ignored Range would send the whole object for every leaf.
        const start = res.status === 206 ? Number(/^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]) : headers.range ? NaN : 0;
        if (start !== offset) {
          await res.body?.cancel();
          throw new HttpBlobError(502, `GET ${key}: asked for bytes from ${offset}, got ${res.status} from ${start}`);
        }
        return res;
      }
      await res.body?.cancel();
      if (res.status === 404) return null;
      if (res.status === 416) return "empty"; // the range starts at or past the end
      // Expired early (clock skew) or the host rotated its secret: sign again, once.
      if (res.status === 403 && attempt === 0) continue;
      throw new HttpBlobError(res.status, `GET ${key}: HTTP ${res.status}`);
    }
  }

  function upload(key: string, uploadId: string): MultipartUpload {
    const at = `/uploads/${encodeURIComponent(uploadId)}`;
    const q = `?key=${encodeURIComponent(key)}`;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        return json<{ partNumber: number; etag: string }>(await call("PUT", `${at}/${partNumber}${q}`, data), `upload part ${partNumber} of ${key}`);
      },
      async listParts() {
        return (await json<{ parts: { partNumber: number; etag: string; size: number }[] }>(await call("GET", at + q), `list parts of ${key}`)).parts;
      },
      async complete(parts) {
        return json<BlobInfo>(await call("POST", `${at}/complete${q}`, { parts }), `complete ${key}`);
      },
      async abort() {
        await json<unknown>(await call("DELETE", at + q), `abort upload of ${key}`);
      },
    };
  }

  const unsupported = (what: string) => async (): Promise<never> => {
    throw new HttpBlobError(501, `${what} is not supported over HTTP: the host API has no such route`, "NotSupported");
  };

  return {
    kind: "http",
    head,
    async get(key, range) {
      const res = await open(key, range);
      if (res === null) return null;
      if (res === "empty") return new Uint8Array(0);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getStream(key, range) {
      const res = await open(key, range);
      if (res === null) return null;
      if (res === "empty") return emptyStream();
      return res.body ?? emptyStream();
    },
    async put(key, data, opts = {}) {
      checkKey(key);
      const headers: Record<string, string> = {};
      if (opts.contentType) headers["content-type"] = opts.contentType;
      // create-only, applied by the host's store atomically: of two writers of a new key, one writes
      if (opts.ifAbsent) headers["if-none-match"] = "*";
      // the host refuses a body that doesn't hash to it (400), and its store keeps it for `head`
      if (opts.sha256) headers[SHA256_HEADER] = opts.sha256;
      const res = await doFetch(await sign("PUT", key, 300), { method: "PUT", headers, body: data as Uint8Array<ArrayBuffer> });
      const kept = opts.ifAbsent === true && res.status === 412; // the key was there: an earlier writer's object stays
      if (!res.ok && !kept) throw await errorOf(res, `PUT ${key}`);
      // `put` resolves the stored object's info, which a host's answer carries (REQ-10): no read-back
      const said = await storedInfo(res, key);
      if (said) return said;
      // An answer without it (a bucket's, an older host's 200 whatever happened): a create-only put reads back, as the
      // stored object may be an earlier writer's; a plain put stored these bytes.
      if (opts.ifAbsent) {
        const stored = await head(key);
        if (stored) return stored;
        if (kept) throw new HttpBlobError(412, `PUT ${key}: the key was there, and is gone now`, "PreconditionFailed");
      }
      const etag = res.headers.get("etag");
      return {
        key,
        size: data.byteLength,
        ...(etag ? { etag } : {}),
        ...(opts.contentType ? { contentType: opts.contentType } : {}),
        ...(opts.sha256 ? { sha256: opts.sha256.toLowerCase() } : {}),
      };
    },
    async createMultipart(key, opts = {}) {
      checkKey(key);
      const r = await json<{ uploadId: string }>(await call("POST", "/uploads", { key, ...(opts.contentType ? { contentType: opts.contentType } : {}) }), `start upload of ${key}`);
      return upload(key, r.uploadId);
    },
    // Like R2 and S3, resuming only makes a handle: an unknown id fails on first use, with NoSuchUpload.
    async resumeMultipart(key, uploadId) {
      checkKey(key);
      return upload(key, uploadId);
    },
    async signedUrl(key, opts) {
      checkKey(key);
      return sign(opts.method, key, opts.expiresIn);
    },
    list: unsupported("list"),
    delete: unsupported("delete"),
  };
}
