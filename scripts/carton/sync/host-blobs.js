// A BlobStore over a Carton host's HTTP media API (@carton/host-http: `/blobs/sign`, `/blobs/head`, `/uploads`), so
// @carton/media shares and streams through any host the way the app does (e2e-qa's gap S5-G1): resumable multipart
// uploads through the session's routes, small objects and ranged reads through short-lived signed URLs. Keys are
// relative to the project's media scope. Web-standard fetch only (library worker, main, a helper).
// - A signed URL is moved onto the origin this computer reaches the host by: the signature covers the path and query,
//   not the origin, and a host behind a proxy signs with its own listen address (e2e-qa's S5-2).
// - Errors keep the HTTP status and the API's `code`, so an upload the host no longer knows (404 / NoSuchUpload) starts
//   over; a network failure stays fetch's own TypeError, which @carton/media retries.
// - The token is asked for on every request, so a session refreshed meanwhile (any process) is used at once.

export class HostStoreError extends Error {
  constructor(status, code, message) {
    super(`${code ? `${code}: ` : ""}${message} (HTTP ${status})`);
    this.name = "HostStoreError";
    this.status = status;
    this.code = code;
  }
}

const rangeHeader = (r) => (r.length === undefined ? `bytes=${r.offset}-` : `bytes=${r.offset}-${r.offset + r.length - 1}`);

async function fail(res) {
  const text = await res.text().catch(() => "");
  let code, message = text || res.statusText;
  try { const j = JSON.parse(text); code = j.code; message = j.error ?? message; } catch { /* a signed URL answers in plain text */ }
  throw new HostStoreError(res.status, code, message);
}

/** `{ origin, projectId, token: () => Promise<string>, fetchFn? }` → a BlobStore over the project's media scope. */
export function hostBlobStore({ origin, projectId, token, fetchFn = (u, i) => fetch(u, i) }) {
  const base = String(origin).replace(/\/+$/, "");
  const api = (p, key) => {
    const u = new URL(`${base}/api/projects/${encodeURIComponent(projectId)}${p}`);
    if (key !== undefined) u.searchParams.set("key", key);
    return u.toString();
  };
  const auth = async () => ({ authorization: `Bearer ${await token()}` });
  const call = async (method, url, body) => {
    const headers = await auth();
    let payload;
    if (body instanceof Uint8Array) { payload = body; headers["content-type"] = "application/octet-stream"; }
    else if (body) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const res = await fetchFn(url, { method, headers, body: payload });
    if (!res.ok) await fail(res);
    return res;
  };
  const sign = async (key, method) => {
    const { url } = await (await call("POST", api("/blobs/sign"), { key, method, expiresIn: 300 })).json();
    const u = new URL(url), b = new URL(base);
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  };
  const head = async (key) => {
    const res = await fetchFn(api("/blobs/head", key), { headers: await auth() });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (!res.ok) await fail(res);
    return res.json();
  };
  // null: no such object; "empty": a zero-length read (or past the end).
  const read = async (key, range) => {
    if (range?.length === 0) return (await head(key)) ? "empty" : null;
    const res = await fetchFn(await sign(key, "GET"), range ? { headers: { range: rangeHeader(range) } } : {});
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (res.status === 416) { await res.body?.cancel(); return "empty"; }
    if (!res.ok) await fail(res);
    return res;
  };
  const upload = (key, uploadId) => {
    const at = (sub = "") => api(`/uploads/${encodeURIComponent(uploadId)}${sub}`, key);
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, data) => (await call("PUT", at(`/${partNumber}`), data)).json(),
      listParts: async () => (await (await call("GET", at())).json()).parts,
      complete: async (parts) => (await call("POST", at("/complete"), { parts })).json(),
      abort: async () => { await (await call("DELETE", at())).body?.cancel(); },
    };
  };
  return {
    kind: "host-http",
    head,
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
      return r.body;
    },
    async put(key, data, opts = {}) {
      if (opts.ifAbsent) { const old = await head(key); if (old) return old; }
      const res = await fetchFn(await sign(key, "PUT"), { method: "PUT", body: data, headers: opts.contentType ? { "content-type": opts.contentType } : {} });
      if (!res.ok) await fail(res);
      await res.body?.cancel();
      return { key, size: data.length, ...(opts.contentType ? { contentType: opts.contentType } : {}) };
    },
    async delete() { throw new Error("A Carton host's media API has no delete"); },
    async list() { throw new Error("A Carton host's media API has no list"); },
    async createMultipart(key, opts = {}) {
      const { uploadId } = await (await call("POST", api("/uploads"), { key, ...(opts.contentType ? { contentType: opts.contentType } : {}) })).json();
      return upload(key, uploadId);
    },
    async resumeMultipart(key, uploadId) { return upload(key, uploadId); },
  };
}
