// The HTTP API every Carton host serves (PLAN §3, §11, §14), on web-standard Request/Response so the Worker and
// the Node host run the same code. A host supplies its blob store per project and its WebSocket upgrade; everything
// else (joining, invites, signed media URLs, resumable multipart uploads) is here, so a client talks to every host
// the same way and a new host gets the API by mounting one function.
//
//   POST /api/projects/:p/join               {invite, account, installKey} → session
//   POST /api/projects/:p/refresh            {token, installKey}           → session (same credential)
//   POST /api/projects/:p/invites            {role, ttlMs?, branches?}  owner  → {invite}
//   POST /api/admin/projects/:p/invites      {role}  Bearer ADMIN_TOKEN    → {invite}   (bootstrap; off without one)
//   GET  /api/projects/:p/ws                 WebSocket (token: Bearer, or the carton.auth.<token> subprotocol)
//   POST /api/projects/:p/blobs/sign         {key, method, expiresIn}      → {url}  (PUT needs edit rights)
//   GET  /api/projects/:p/blobs/head?key=                                  → BlobInfo | 404
//   POST /api/projects/:p/uploads            {key, contentType?}  editor   → {uploadId}
//   PUT  /api/projects/:p/uploads/:id/:n?key=  part bytes          editor   → {partNumber, etag}
//   GET  /api/projects/:p/uploads/:id?key=                         editor   → {parts}   (resume after a cut link)
//   POST /api/projects/:p/uploads/:id/complete?key=  {parts}       editor   → BlobInfo
//   DELETE /api/projects/:p/uploads/:id?key=                       editor   → {}
//   GET|HEAD|PUT /blob/:p/<key>?exp=…&sig=…  a signed URL (ranges)         → bytes
//   GET  /api/health

import type { AuthContext, AuthProvider, BlobStore } from "@carton/core/plugins";
import { type HmacAuth, AuthError, tokenFromRequest, canPush, canInvite } from "@carton/server";
import { createBlobUrlSigner, serveSignedBlob, readBody, BodyTooLarge, type BlobUrlSigner } from "@carton/blob-memory/signed";
import { BlobError, MAX_PARTS } from "@carton/blob-memory/rules";

// Any AuthProvider serves sessions; the invite routes need the demo's invite flow (HmacAuth). With another provider
// (Cardboard's accounts) those routes answer 501 and sessions come from that provider.
export type HttpAuth = AuthProvider & Partial<Pick<HmacAuth, "join" | "refresh" | "createInvite" | "check">>;

export interface HttpDeps {
  auth: HttpAuth;
  // signs blob URLs (derived under its own label, so it can be the auth secret)
  secret: string | Uint8Array;
  blobsFor(projectId: string): BlobStore | undefined;
  // the host's WebSocket upgrade, called with the verified context
  upgrade(req: Request, auth: AuthContext, projectId: string): Promise<Response>;
  adminToken?: string;
  // the largest part or signed PUT body accepted (Workers' request limit is 100 MB on the Free plan)
  maxBodyBytes?: number;
}

const PROJECT = /^\/(?:api\/(?:admin\/)?projects|blob)\/([A-Za-z0-9._~-]{1,128})(\/.*)?$/;
const MAX_JSON = 64 * 1024;
const ROLES = new Set(["owner", "editor", "commenter", "viewer"]);

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, message: string) => json({ error: message }, status);

// A complete request lists up to 10,000 parts: {"partNumber":10000,"etag":"…"} is under 100 bytes each.
const MAX_COMPLETE_JSON = MAX_PARTS * 128 + 1024;

async function body<T>(req: Request, max = MAX_JSON): Promise<T> {
  let bytes: Uint8Array;
  try {
    bytes = await readBody(req, max);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new AuthError("request body too large", 413);
    throw e;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new AuthError("body must be JSON", 400);
  }
}

// Constant-time string comparison for the admin token (both sides hashed, so lengths don't leak either).
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i]! ^ v[i]!;
  return d === 0;
}

// The session behind a token, for this project: 401 when it doesn't verify, 403 when it's another project's.
export async function checkSession(auth: HttpAuth, token: string, projectId: string): Promise<AuthContext> {
  if (auth.check) return auth.check(token, projectId);
  const ctx = await auth.verify(token);
  if (!ctx) throw new AuthError("invalid or expired token");
  if (ctx.projectId !== projectId) throw new AuthError("token is for another project", 403);
  return ctx;
}

export function blobSigner(deps: HttpDeps, origin: string, projectId: string): BlobUrlSigner {
  return createBlobUrlSigner({ secret: deps.secret, baseUrl: `${origin}/blob/${projectId}` });
}

// Answers the request, or returns null when it isn't an API route (the host then serves static files).
export async function handleHttp(req: Request, deps: HttpDeps): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/api/health") return json({ ok: true });
  const m = PROJECT.exec(url.pathname);
  if (!m) return url.pathname.startsWith("/api/") ? err(404, "no such route") : null;
  const projectId = m[1]!, rest = m[2] ?? "";
  const a = deps.auth;
  const invites = (): Required<Pick<HmacAuth, "join" | "refresh" | "createInvite">> => {
    if (!a.join || !a.refresh || !a.createInvite) throw new AuthError("this host's auth has no invite links", 501);
    return { join: a.join.bind(a), refresh: a.refresh.bind(a), createInvite: a.createInvite.bind(a) };
  };
  try {
    if (url.pathname.startsWith("/blob/")) {
      const store = deps.blobsFor(projectId);
      if (!store) return err(404, "this host has no blob store");
      return await serveSignedBlob(req, store, blobSigner(deps, url.origin, projectId), deps.maxBodyBytes ? { maxPutBytes: deps.maxBodyBytes } : {});
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (req.method !== "POST" || rest !== "/invites") return err(404, "no such route");
      const given = tokenFromRequest(req.headers);
      if (!deps.adminToken || !given || !(await sameSecret(given, deps.adminToken))) return err(401, "admin token required");
      const b = await body<{ role?: string; ttlMs?: number }>(req);
      const role = (b.role ?? "owner") as AuthContext["role"];
      if (!ROLES.has(role)) return err(400, "bad role");
      return json({ invite: await invites().createInvite(projectId, role, b.ttlMs) });
    }
    // routes that need no session
    if (req.method === "POST" && rest === "/join") {
      const b = await body<{ invite?: string; account?: string; installKey?: string }>(req);
      const j = await invites().join(String(b.invite ?? ""), String(b.account ?? ""), String(b.installKey ?? ""));
      if (j.context.projectId !== projectId) return err(403, "invite is for another project");
      return json({ token: j.token, context: j.context });
    }
    if (req.method === "POST" && rest === "/refresh") {
      const b = await body<{ token?: string; installKey?: string }>(req);
      const j = await invites().refresh(String(b.token ?? ""), String(b.installKey ?? ""));
      if (j.context.projectId !== projectId) return err(403, "token is for another project");
      return json({ token: j.token, context: j.context });
    }
    // everything else is for a session of this project
    const token = tokenFromRequest(req.headers);
    if (!token) return err(401, "session token required");
    const ctx = await checkSession(a, token, projectId);
    if (rest === "/ws") return await deps.upgrade(req, ctx, projectId);
    if (req.method === "POST" && rest === "/invites") {
      if (!canInvite(ctx)) return err(403, "only the owner invites");
      const b = await body<{ role?: string; ttlMs?: number; branches?: string[] }>(req);
      if (!ROLES.has(String(b.role))) return err(400, "bad role");
      // `branches`: the cuts its sessions are scoped to (a Published cut's watch link reads that cut only)
      return json({ invite: await invites().createInvite(projectId, b.role as AuthContext["role"], b.ttlMs, b.branches) });
    }
    const store = deps.blobsFor(projectId);
    if (rest.startsWith("/blobs/") || rest.startsWith("/uploads")) {
      if (!store) return err(404, "this host has no blob store");
      return await blobRoutes(req, url, rest, ctx, store, deps, projectId);
    }
    return err(404, "no such route");
  } catch (e) {
    if (e instanceof AuthError) return err(e.status, e.message);
    if (e instanceof BlobError) return json({ error: e.message, code: e.code }, e.code === "NoSuchUpload" ? 404 : 400);
    throw e;
  }
}

// Keys named by content (@carton/media: `m/<hash>` bytes, `mf/<hash>` manifests, `px/<hash>/…` proxy pointers; `t1/<hash>/…`
// T1 extras, §11): reading one needs its content hash, which only a document that uses the media gives away.
const CONTENT_KEYS = ["m/", "mf/", "px/", "t1/"];

/**
 * What a reader scoped to some cuts (a Published cut's watch link, §14) may read from the media scope: media named by
 * content, and files kept for one of its cuts under `cuts/<cutId>/`. Never the project's own files (its descriptor
 * holds Main's root, review round 2, R2-1). An unscoped session, or a writer, reads the whole scope.
 */
export function mayRead(ctx: AuthContext, key: string): boolean {
  if (!ctx.branches || canPush(ctx)) return true;
  if (CONTENT_KEYS.some((p) => key.startsWith(p))) return true;
  return ctx.branches.some((b) => key.startsWith(`cuts/${b}/`));
}

async function blobRoutes(req: Request, url: URL, rest: string, ctx: AuthContext, store: BlobStore, deps: HttpDeps, projectId: string): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  if (req.method === "POST" && rest === "/blobs/sign") {
    const b = await body<{ key?: string; method?: string; expiresIn?: number }>(req);
    const method = b.method === "PUT" ? "PUT" : "GET";
    if (method === "PUT" && !canPush(ctx)) return err(403, "read-only role");
    if (!mayRead(ctx, String(b.key ?? ""))) return err(403, "outside this link's scope");
    const signer = blobSigner(deps, url.origin, projectId);
    return json({ url: await signer.sign(method, String(b.key ?? ""), Math.min(Number(b.expiresIn ?? 300), 3600)) });
  }
  if (req.method === "GET" && rest === "/blobs/head") {
    if (!mayRead(ctx, key)) return err(403, "outside this link's scope");
    const info = await store.head(key);
    return info ? json(info) : err(404, "no such blob");
  }
  if (!canPush(ctx)) return err(403, "read-only role");
  const up = /^\/uploads(?:\/([^/]+)(?:\/(\d+|complete))?)?$/.exec(rest);
  if (!up) return err(404, "no such route");
  const [, id, sub] = up;
  if (!id && req.method === "POST") {
    const b = await body<{ key?: string; contentType?: string }>(req);
    const u = await store.createMultipart(String(b.key ?? ""), b.contentType ? { contentType: b.contentType } : {});
    return json({ uploadId: u.uploadId, key: u.key });
  }
  if (!id) return err(404, "no such route");
  const handle = await store.resumeMultipart(key, decodeURIComponent(id));
  if (req.method === "PUT" && sub && sub !== "complete") {
    const max = deps.maxBodyBytes ?? 100 * 1024 * 1024;
    let data: Uint8Array;
    try {
      data = await readBody(req, max);
    } catch (e) {
      if (e instanceof BodyTooLarge) return err(413, "part too large");
      throw e;
    }
    return json(await handle.uploadPart(Number(sub), data));
  }
  if (req.method === "GET" && !sub) return json({ parts: await handle.listParts() });
  if (req.method === "POST" && sub === "complete") {
    const b = await body<{ parts?: unknown }>(req, MAX_COMPLETE_JSON);
    const parts = b.parts;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS || parts.some((p) => !p || typeof p.etag !== "string" || p.etag.length > 256 || !Number.isInteger(p.partNumber)))
      return err(400, `parts must be 1..${MAX_PARTS} {partNumber, etag} entries`);
    return json(await handle.complete(parts as { partNumber: number; etag: string }[]));
  }
  if (req.method === "DELETE" && !sub) {
    await handle.abort();
    return json({});
  }
  return err(404, "no such route");
}
