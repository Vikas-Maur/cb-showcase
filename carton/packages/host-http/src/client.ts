// Clients of a Carton host's HTTP API, as BlobStores, so code written against the BlobStore plug-in (the sync client,
// @carton/media) works through any host. Requests go through @carton/http-node: node:http(s) on Node (a body
// cut while its reader is paused rejects, where undici behind fetch could crash the process, CI #29), fetch elsewhere.
// - hostMessageBlobs: the sync envelope routes, for SyncClientOptions.blobs.
// - hostMediaBlobs: the project's media, for @carton/media: resumable multipart uploads through the session's routes,
//   small objects and ranged reads through short-lived signed URLs, and the §11 repair report.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { SHA256_HEADER } from "@carton/blob-memory/signed";
import { platformFetch } from "@carton/http-node";
import { eachLimit } from "./pool.ts";

export interface HostBlobsOptions {
  /** The host's origin, e.g. `https://carton.example` or `http://127.0.0.1:8787`. */
  origin: string;
  projectId: string;
  /** The session token, or a function that returns a fresh one. */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
}

const unsupported = (what: string): never => {
  throw new Error(`${what} is not available through the host's HTTP API`);
};

export function hostMessageBlobs(opts: HostBlobsOptions): BlobStore {
  const f = opts.fetch ?? platformFetch();
  const base = `${opts.origin.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(opts.projectId)}/messages/`;
  const auth = async () => ({ authorization: `Bearer ${typeof opts.token === "string" ? opts.token : await opts.token()}` });
  return {
    kind: "host-messages",
    async put(key, data, o = {}): Promise<BlobInfo> {
      const r = await f(base + key, { method: "PUT", body: data as Uint8Array<ArrayBuffer>, headers: { ...(await auth()), "content-type": o.contentType ?? "application/json" } });
      if (!r.ok) throw new Error(`envelope upload refused: ${r.status} ${await r.text()}`);
      return { key, size: data.byteLength, ...(o.sha256 ? { sha256: o.sha256 } : {}) };
    },
    async get(key) {
      const r = await f(base + key, { headers: await auth() });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`envelope fetch refused: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    head: async () => unsupported("head"),
    delete: async () => unsupported("delete"),
    list: async () => unsupported("list"),
    createMultipart: async (): Promise<MultipartUpload> => unsupported("multipart"),
    resumeMultipart: async (): Promise<MultipartUpload> => unsupported("multipart"),
  };
}

/** A failed media API call: the HTTP status and the API's error code (NoSuchUpload, InvalidPart…). */
export class HostApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(`${code ? `${code}: ` : ""}${message} (HTTP ${status})`);
    this.name = "HostApiError";
    this.status = status;
    this.code = code;
  }
}

// The stored object's info a signed PUT's answer carries, under the caller's key; null when it carries none.
async function storedInfo(r: Response, key: string): Promise<BlobInfo | null> {
  if (!/^application\/json\b/i.test(r.headers.get("content-type") ?? "")) {
    await r.body?.cancel();
    return null;
  }
  const j = (await r.json().catch(() => null)) as Partial<Record<keyof BlobInfo, unknown>> | null;
  if (!j || typeof j.size !== "number") return null;
  const info: BlobInfo = { key, size: j.size };
  if (typeof j.etag === "string") info.etag = j.etag;
  if (typeof j.contentType === "string") info.contentType = j.contentType;
  if (typeof j.sha256 === "string") info.sha256 = j.sha256;
  return info;
}

// A host from before POST /blobs/heads answers it as any unknown media route: 404 "no such route" to an editor, 403
// "read-only role" to a read role (it checked the role first). A host with the route answers neither.
// Null for any other status (its body unread); else whether it is that answer, and the body read.
async function olderHost(r: Response): Promise<{ older: boolean; text: string } | null> {
  if (r.status !== 404 && r.status !== 403) return null;
  const text = await r.text().catch(() => "");
  let error: unknown;
  try {
    error = (JSON.parse(text) as { error?: unknown }).error;
  } catch {}
  return { older: (r.status === 404 && error === "no such route") || (r.status === 403 && error === "read-only role"), text };
}

async function failed(r: Response, read?: string): Promise<never> {
  const text = read ?? (await r.text().catch(() => ""));
  let code: string | undefined, message = text || r.statusText;
  try {
    const j = JSON.parse(text) as { error?: string; code?: string };
    code = j.code;
    message = j.error ?? message;
  } catch {} // a signed blob URL answers in plain text
  throw new HostApiError(r.status, code, message);
}

export interface HostMediaBlobs extends BlobStore {
  getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  /** A short-lived URL for a player or ffmpeg (GET, with HTTP ranges) or for a direct upload (PUT). */
  signedUrl(key: string, opts: { method: "GET" | "PUT"; expiresIn: number }): Promise<string>;
  /**
   * §11's repair path: leaf `leaf` of media object `key` (`m/<hash>`) can never verify. The host checks it itself
   * against the manifest and removes the object only if it really is damaged, so the owner's next share uploads it
   * again. Resolves with what the host found.
   */
  reportDamaged(key: string, leaf: number): Promise<{ damaged: boolean; removed?: boolean }>;
  /**
   * `head` for many keys at once (REQ-11), by its rules: `{size}` or null for each key, in order. Up to 1,000 keys a
   * request (POST /blobs/heads), so a 2,000-part stream's reuse check takes 2 requests, not 2,000; a host with a
   * smaller budget answers fewer and is asked again for the rest. A host from before the route gets one `head` per key.
   * Not part of BlobStore: code that takes any store should look for it (`"heads" in store`).
   */
  heads(keys: readonly string[]): Promise<({ size: number } | null)[]>;
}

/** A store that answers many heads at once (hostMediaBlobs). */
export const hasHeads = (s: BlobStore): s is BlobStore & Pick<HostMediaBlobs, "heads"> => typeof (s as Partial<HostMediaBlobs>).heads === "function";

const MAX_BLOB_HEADS = 1000, MAX_BLOB_HEADS_JSON = 1024 * 1024;

const rangeHeader = (r: ByteRange) => (r.length === undefined ? `bytes=${r.offset}-` : `bytes=${r.offset}-${r.offset + r.length - 1}`);

/**
 * A project's media through the host's HTTP API. It has no list or delete (the API offers neither to clients).
 * `put` with `ifAbsent` sends `If-None-Match: *`, which the host applies atomically: 412 when the key was there. A
 * host's answer carries the stored object's info, so `put` needs no read-back. It decides by the answer, not by who
 * signed the URL: a URL presigned straight to a bucket (S3, R2) gets the bucket's answer, and an older host's has no
 * info either, so without a JSON body holding the info a create-only `put` reads back with `head`.
 * `put` with `sha256` sends it in `X-Carton-Sha256`: the host refuses a body that doesn't hash to it (400) and the
 * store keeps it, for `head`.
 */
export function hostMediaBlobs(opts: HostBlobsOptions): HostMediaBlobs {
  const f = opts.fetch ?? platformFetch();
  const base = `${opts.origin.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(opts.projectId)}`;
  const bearer = async () => `Bearer ${typeof opts.token === "string" ? opts.token : await opts.token()}`;
  const api = (path: string, key?: string) => base + path + (key === undefined ? "" : `?key=${encodeURIComponent(key)}`);
  async function call(method: string, url: string, body?: Uint8Array | object): Promise<Response> {
    const headers: Record<string, string> = { authorization: await bearer() };
    let payload: RequestInit["body"] | undefined;
    if (body instanceof Uint8Array) {
      payload = body as Uint8Array<ArrayBuffer>;
      headers["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const r = await f(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    if (!r.ok) await failed(r);
    return r;
  }
  async function sign(key: string, method: "GET" | "PUT", expiresIn = 300): Promise<string> {
    return ((await (await call("POST", api("/blobs/sign"), { key, method, expiresIn })).json()) as { url: string }).url;
  }
  async function read(key: string, range?: ByteRange): Promise<Response | null | "empty"> {
    if (range?.length === 0) return (await store.head(key)) ? "empty" : null;
    const r = await f(await sign(key, "GET"), range ? { headers: { range: rangeHeader(range) } } : {});
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (r.status === 416) {
      await r.body?.cancel();
      return "empty";
    }
    if (!r.ok) await failed(r);
    return r;
  }
  function handle(key: string, uploadId: string): MultipartUpload {
    const at = (sub = "") => api(`/uploads/${encodeURIComponent(uploadId)}${sub}`, key);
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, data) => (await (await call("PUT", at(`/${partNumber}`), data)).json()) as { partNumber: number; etag: string },
      listParts: async () => ((await (await call("GET", at())).json()) as { parts: { partNumber: number; etag: string; size: number }[] }).parts,
      complete: async (parts) => (await (await call("POST", at("/complete"), { parts })).json()) as BlobInfo,
      abort: async () => {
        await (await call("DELETE", at())).body?.cancel();
      },
    };
  }
  const store: HostMediaBlobs = {
    kind: "host-media",
    async put(key, data, o = {}) {
      const headers: Record<string, string> = {};
      if (o.contentType) headers["content-type"] = o.contentType;
      if (o.ifAbsent) headers["if-none-match"] = "*";
      if (o.sha256) headers[SHA256_HEADER] = o.sha256;
      const r = await f(await sign(key, "PUT"), { method: "PUT", body: data as Uint8Array<ArrayBuffer>, headers });
      const kept = o.ifAbsent && r.status === 412; // an earlier writer's object stays
      if (!r.ok && !kept) await failed(r);
      const said = await storedInfo(r, key);
      if (said) return said;
      // no info: a bucket's own answer (a presigned URL), or an older host's (200 and an etag whatever happened)
      if (o.ifAbsent) {
        const stored = await store.head(key);
        if (stored) return stored;
        if (kept) throw new HostApiError(412, undefined, `${key} was there, and is gone now`);
      }
      const info: BlobInfo = { key, size: data.byteLength };
      if (o.contentType) info.contentType = o.contentType;
      if (o.sha256) info.sha256 = o.sha256.toLowerCase();
      const etag = r.headers.get("etag");
      if (etag) info.etag = etag;
      return info;
    },
    async get(key, range) {
      const r = await read(key, range);
      if (r === null) return null;
      if (r === "empty") return new Uint8Array(0);
      return new Uint8Array(await r.arrayBuffer());
    },
    async getStream(key, range) {
      const r = await read(key, range);
      if (r === null) return null;
      if (r === "empty" || !r.body) return new ReadableStream({ start: (c) => c.close() });
      return r.body as ReadableStream<Uint8Array>;
    },
    async head(key) {
      const r = await f(api("/blobs/head", key), { headers: { authorization: await bearer() } });
      if (r.status === 404) {
        await r.body?.cancel();
        return null;
      }
      if (!r.ok) await failed(r);
      return (await r.json()) as BlobInfo;
    },
    async heads(keys) {
      const out: ({ size: number } | null)[] = [];
      const utf8 = new TextEncoder();
      let i = 0;
      while (i < keys.length) {
        // as many keys as one request takes: 1,000, and 1 MiB of JSON
        let j = i, bytes = '{"keys":[]}'.length;
        while (j < keys.length && j - i < MAX_BLOB_HEADS) {
          const k = keys[j];
          if (typeof k !== "string") throw new TypeError("heads: keys must be strings");
          const n = utf8.encode(JSON.stringify(k)).byteLength + 1;
          if (j > i && bytes + n > MAX_BLOB_HEADS_JSON) break;
          bytes += n;
          j++;
        }
        const r = await f(api("/blobs/heads"), { method: "POST", headers: { authorization: await bearer(), "content-type": "application/json" }, body: JSON.stringify({ keys: keys.slice(i, j) }) });
        const was = await olderHost(r);
        if (was && !was.older) await failed(r, was.text);
        if (was?.older) {
          // a host from before the route: one head per key, a few at a time
          const rest = keys.slice(i);
          const got: ({ size: number } | null)[] = new Array(rest.length);
          await eachLimit(rest, 8, async (k, n) => {
            const info = await store.head(k);
            got[n] = info ? { size: info.size } : null;
          });
          return out.concat(got);
        }
        if (!r.ok) await failed(r);
        const { blobs } = (await r.json()) as { blobs?: unknown };
        const ok = Array.isArray(blobs) && blobs.length >= 1 && blobs.length <= j - i && blobs.every((b) => b === null || (typeof b === "object" && typeof (b as { size?: unknown }).size === "number"));
        if (!ok) throw new HostApiError(r.status, undefined, "the host's heads answer isn't one entry per key");
        for (const b of blobs as ({ size: number } | null)[]) out.push(b && { size: b.size });
        i += blobs.length;
      }
      return out;
    },
    delete: async () => unsupported("delete"),
    list: async () => unsupported("list"),
    async createMultipart(key, o = {}) {
      const r = (await (await call("POST", api("/uploads"), { key, ...(o.contentType ? { contentType: o.contentType } : {}) })).json()) as { uploadId: string };
      return handle(key, r.uploadId);
    },
    resumeMultipart: async (key, uploadId) => handle(key, uploadId),
    signedUrl: (key, o) => sign(key, o.method, o.expiresIn),
    async reportDamaged(key, leaf) {
      return (await (await call("POST", api("/blobs/damaged"), { key, leaf })).json()) as { damaged: boolean; removed?: boolean };
    },
  };
  return store;
}
