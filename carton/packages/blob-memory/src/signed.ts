// Short-lived signed URLs for any BlobStore (PLAN §14 "short-lived media URLs"), for stores that can't presign
// themselves (R2's binding, the DO-blob fallback, blob-fs). A host mounts `serveSignedBlob` on a route; whoever holds
// the URL may GET (with HTTP ranges, so a <video> element or ffmpeg can seek) or PUT that one key until it expires.
// blob-s3 presigns natively instead. Web-standard Request/Response, so Workers and Node hosts share it.

import type { BlobStore } from "@carton/core/plugins";
import { checkKey } from "./rules.ts";

export interface BlobUrlSigner {
  sign(method: "GET" | "PUT", key: string, expiresInSec: number): Promise<string>;
  // The key the URL grants `method` on, or null when it is forged, expired or for another method.
  verify(url: URL, method: string): Promise<string | null>;
}

const enc = new TextEncoder();
const MAX_EXPIRY_SEC = 7 * 24 * 3600;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// `baseUrl` is where the host mounts the route, e.g. `https://carton.example/blob`. The signing key is derived from
// `secret` with a label, so a blob URL's MAC can never pass as an auth token's, or the reverse.
export function createBlobUrlSigner(opts: { secret: string | Uint8Array; baseUrl: string; clock?: () => number }): BlobUrlSigner {
  const base = new URL(opts.baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "") + "/";
  const now = opts.clock ?? Date.now;
  const raw = typeof opts.secret === "string" ? enc.encode(opts.secret) : opts.secret;
  const key = crypto.subtle
    .importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((k) => crypto.subtle.sign("HMAC", k, enc.encode("carton-blob-url.v1")))
    .then((derived) => crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  const message = (method: string, k: string, exp: number) => enc.encode(`${method}\n${k}\n${exp}`);
  return {
    async sign(method, k, expiresInSec) {
      checkKey(k);
      const exp = Math.floor(now() / 1000) + Math.max(1, Math.min(MAX_EXPIRY_SEC, Math.floor(expiresInSec)));
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key, message(method, k, exp)));
      const u = new URL(base);
      u.pathname = prefix + k.split("/").map(encodeURIComponent).join("/");
      u.search = `?exp=${exp}&sig=${b64url(sig)}`;
      return u.toString();
    },
    async verify(url, method) {
      if (!url.pathname.startsWith(prefix)) return null;
      let k: string;
      try {
        k = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
        checkKey(k);
      } catch {
        return null;
      }
      const exp = Number(url.searchParams.get("exp"));
      const sig = fromB64url(url.searchParams.get("sig") ?? "");
      if (!Number.isSafeInteger(exp) || !sig || exp < Math.floor(now() / 1000)) return null;
      const m = method === "HEAD" ? "GET" : method;
      if (m !== "GET" && m !== "PUT") return null;
      // constant time: subtle.verify compares the MAC
      return (await crypto.subtle.verify("HMAC", await key, sig as Uint8Array<ArrayBuffer>, message(m, k, exp))) ? k : null;
    },
  };
}

// One `bytes=` range: `a-b`, `a-` or `-n`. Multiple ranges are answered with the whole body (RFC 9110 allows
// ignoring Range), which is what players and ffmpeg cope with.
export function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Math.min(Number(m[2]), size);
    if (n === 0) return "unsatisfiable";
    return { offset: size - n, length: n };
  }
  const a = Number(m[1]);
  if (a >= size) return "unsatisfiable";
  const b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (b < a) return "unsatisfiable";
  return { offset: a, length: b - a + 1 };
}

export interface ServeOptions {
  // Bodies of a signed PUT above this are refused (Workers' request limit is 100 MB on the Free plan). Large media go
  // through multipart instead.
  maxPutBytes?: number;
}

// Answers a request on a signed blob URL: GET/HEAD (with ranges) or PUT. 403 for a bad or expired signature.
export async function serveSignedBlob(req: Request, store: BlobStore, signer: BlobUrlSigner, opts: ServeOptions = {}): Promise<Response> {
  const url = new URL(req.url);
  const key = await signer.verify(url, req.method);
  if (!key) return new Response("forbidden", { status: 403 });
  if (req.method === "PUT") {
    const max = opts.maxPutBytes ?? 100 * 1024 * 1024;
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (declared > max) return new Response("too large", { status: 413 });
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > max) return new Response("too large", { status: 413 });
    const ct = req.headers.get("content-type");
    const info = await store.put(key, body, ct ? { contentType: ct } : {});
    return new Response(null, { status: 200, headers: info.etag ? { etag: info.etag } : {} });
  }
  const head = await store.head(key);
  if (!head) return new Response("not found", { status: 404 });
  const headers = new Headers({ "accept-ranges": "bytes", "content-type": head.contentType ?? "application/octet-stream", "cache-control": "private, max-age=60" });
  if (head.etag) headers.set("etag", head.etag);
  const range = parseRange(req.headers.get("range"), head.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  const length = range ? range.length : head.size;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  const status = range ? 206 : 200;
  if (req.method === "HEAD") return new Response(null, { status, headers });
  const r = range ?? { offset: 0, length: head.size };
  const body = store.getStream ? await store.getStream(key, r) : await store.get(key, r);
  if (body === null) return new Response("not found", { status: 404 });
  return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers });
}
