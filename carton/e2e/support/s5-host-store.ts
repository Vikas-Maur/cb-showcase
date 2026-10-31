// A BlobStore over a Carton host's HTTP media API (host-http: `/api/projects/<p>/blobs/*` and `/uploads`), so
// @carton/media can share through server-node exactly as a desktop client would: resumable multipart uploads through
// the session's routes, small objects and ranged reads through short-lived signed URLs. No package ships such a
// client yet (S5 report: gap S5-G1), so the scenario carries its own; it follows the routes documented at the top of
// host-http's index.ts and nothing else.
//
// Errors keep the HTTP status and the API's `code`, so media's upload sees NoSuchUpload (or a 404) for an upload the
// host no longer knows and starts over; a network failure stays fetch's own TypeError, which media retries.
//
// server-node signs URLs with its own listen address, not the one the client used (bug S5-2), so this client moves
// a signed URL onto `baseUrl`'s origin (the signature covers the path and query, not the origin). Without
// that, a machine behind a proxy or port map couldn't fetch them, and S5's links wouldn't see the traffic.
import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";

export class HttpStoreError extends Error {
  override name = "HttpStoreError";
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(`${code ? `${code}: ` : ""}${message} (HTTP ${status})`);
    this.status = status;
    this.code = code;
  }
}

export interface HostStoreOptions {
  /** Where this machine reaches the host (possibly through a proxy): `http://127.0.0.1:<port>`. */
  baseUrl: string;
  projectId: string;
  token: string;
}

const rangeHeader = (r: ByteRange): string => (r.length === undefined ? `bytes=${r.offset}-` : `bytes=${r.offset}-${r.offset + r.length - 1}`);

export class HostBlobStore implements BlobStore {
  readonly kind = "host-http";
  readonly #o: HostStoreOptions;

  constructor(o: HostStoreOptions) {
    this.#o = o;
  }

  #api(path: string, key?: string): string {
    const u = new URL(`${this.#o.baseUrl}/api/projects/${encodeURIComponent(this.#o.projectId)}${path}`);
    if (key !== undefined) u.searchParams.set("key", key);
    return u.toString();
  }

  async #call(method: string, url: string, body?: Uint8Array | object): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#o.token}` };
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
      headers["content-type"] = "application/octet-stream";
    } else if (body) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(url, { method, headers, body: payload as RequestInit["body"] });
    if (!res.ok) await fail(res);
    return res;
  }

  async #sign(key: string, method: "GET" | "PUT"): Promise<string> {
    const r = (await (await this.#call("POST", this.#api("/blobs/sign"), { key, method, expiresIn: 300 })).json()) as { url: string };
    const u = new URL(r.url);
    const base = new URL(this.#o.baseUrl);
    u.protocol = base.protocol;
    u.host = base.host;
    return u.toString();
  }

  async head(key: string): Promise<BlobInfo | null> {
    const res = await fetch(this.#api("/blobs/head", key), { headers: { authorization: `Bearer ${this.#o.token}` } });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) await fail(res);
    return (await res.json()) as BlobInfo;
  }

  async #read(key: string, range?: ByteRange): Promise<Response | null | "empty"> {
    if (range?.length === 0) return (await this.head(key)) ? "empty" : null;
    const res = await fetch(await this.#sign(key, "GET"), range ? { headers: { range: rangeHeader(range) } } : {});
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 416) {
      await res.body?.cancel();
      return "empty";
    }
    if (!res.ok) await fail(res);
    return res;
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    const r = await this.#read(key, range);
    if (r === null) return null;
    if (r === "empty") return new Uint8Array(0);
    return new Uint8Array(await r.arrayBuffer());
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const r = await this.#read(key, range);
    if (r === null) return null;
    if (r === "empty" || !r.body) return new ReadableStream({ start: (c) => c.close() });
    return r.body as ReadableStream<Uint8Array>;
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    if (opts.ifAbsent) {
      const old = await this.head(key);
      if (old) return old;
    }
    const res = await fetch(await this.#sign(key, "PUT"), { method: "PUT", body: data as RequestInit["body"], headers: opts.contentType ? { "content-type": opts.contentType } : {} });
    if (!res.ok) await fail(res);
    await res.body?.cancel();
    return { key, size: data.length, ...(opts.contentType ? { contentType: opts.contentType } : {}) };
  }

  async delete(): Promise<void> {
    throw new Error("the host HTTP API has no delete");
  }
  async list(): Promise<{ blobs: BlobInfo[] }> {
    throw new Error("the host HTTP API has no list");
  }

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    const r = (await (await this.#call("POST", this.#api("/uploads"), { key, ...(opts.contentType ? { contentType: opts.contentType } : {}) })).json()) as { uploadId: string };
    return this.#handle(key, r.uploadId);
  }

  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    return this.#handle(key, uploadId);
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const at = (sub = "") => this.#api(`/uploads/${encodeURIComponent(uploadId)}${sub}`, key);
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, data) => (await (await this.#call("PUT", at(`/${partNumber}`), data)).json()) as { partNumber: number; etag: string },
      listParts: async () => ((await (await this.#call("GET", at())).json()) as { parts: { partNumber: number; etag: string; size: number }[] }).parts,
      complete: async (parts) => (await (await this.#call("POST", at("/complete"), { parts })).json()) as BlobInfo,
      abort: async () => {
        await (await this.#call("DELETE", at())).body?.cancel();
      },
    };
  }
}

async function fail(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let message = text || res.statusText;
  try {
    const j = JSON.parse(text) as { error?: string; code?: string };
    code = j.code;
    message = j.error ?? message;
  } catch {
    // not JSON (a signed blob URL answers in plain text)
  }
  throw new HttpStoreError(res.status, code, message);
}
