// The HTTP API every Carton host serves (PLAN §3, §11, §14), on web-standard Request/Response so the Worker and
// the Node host run the same code. A host supplies its blob store per project and its WebSocket upgrade; everything
// else (joining, invites, signed media URLs, resumable multipart uploads) is here, so a client talks to every host
// the same way and a new host gets the API by mounting one function.
//
//   POST /api/projects/:p/join               {invite, account, installKey} → session
//   POST /api/projects/:p/refresh            {token, installKey}           → session (same credential)
//   POST /api/projects/:p/invites            {role, ttlMs?, branches?}  owner  → {invite}
//   POST /api/admin/projects/:p/invites      {role}  Bearer ADMIN_TOKEN    → {invite}   (bootstrap; off without one)
//   POST /api/projects/:p/create             {account, installKey}  → owner session  (open creation: a host that lets
//                                            anyone make a project, `openCreate`; once per project id, never one in
//                                            use, a few a day per network; 403 when the host doesn't, 409, 429)
//   GET  /api/host                                                         → {openCreate, perDay?, maxUploadBytes}
//   GET  /api/projects/:p/ws                 WebSocket (token: Bearer, or the carton.auth.<token> subprotocol)
//   GET  /api/projects/:p/session            any valid session → {role}  (the transport's probe after a failed handshake)
//   POST /api/projects/:p/blobs/sign         {key, method, expiresIn}      → {url}  (PUT needs edit rights)
//   GET  /api/projects/:p/blobs/head?key=                                  → BlobInfo | 404  (an editor's head of a
//                                            team object claims it for the project: team.ts)
//   POST /api/projects/:p/blobs/heads        {keys: string[≤1000]}         → {blobs: ({size} | null)[]}  (HEAD's rules,
//                                            for a prefix of the keys: at most the host's maxBlobHeads; ask again
//                                            for the rest)
//   POST /api/projects/:p/blobs/damaged      {key: "m/<hash>", leaf}       → {damaged, removed?}  (§11 repair path)
//   POST /api/projects/:p/blobs/pieces-done  {hash}  editor  → {removed}  (a clip's live pieces, lv/<hash>/…, removed
//                                            once its whole object m/<hash> is there: see PIECES below)
//   POST /api/projects/:p/uploads            {key, contentType?}  editor   → {uploadId}
//   PUT  /api/projects/:p/uploads/:id/:n?key=  part bytes          editor   → {partNumber, etag}
//   GET  /api/projects/:p/uploads/:id?key=                         editor   → {parts}   (resume after a cut link)
//   POST /api/projects/:p/uploads/:id/complete?key=  {parts}       editor   → BlobInfo
//   DELETE /api/projects/:p/uploads/:id?key=                       editor   → {}
//   GET|HEAD|PUT /blob/:p/<key>?exp=…&sig=…  a signed URL (ranges)         → bytes  (a PUT may send If-None-Match: *
//                                            for create-only, and X-Carton-Sha256 for a checked, recorded digest;
//                                            it answers the stored BlobInfo, 412 when If-None-Match: * found the key)
//   PUT  /api/projects/:p/messages/<key>     an oversized message, editor  → {}   (key messages/c/<hour>/<sha>-<nonce>)
//   GET  /api/projects/:p/messages/<key>     the server's oversized message → bytes (key messages/s/<hour>/<sha>)
//   GET  /api/health
//
// The two message routes carry the sync protocol's envelopes (core/src/sync/envelope.ts): a message over 1 MiB
// travels through the sequencer's own blob scope, and these routes reach exactly the two envelope key patterns of
// that scope, nothing else in it (keyframes, segments).
//
// A host may give a project's media API a team store (team.ts, `projectMediaStore`): media bytes and manifests are
// then kept once per team, and a project reads only the hashes it was granted.

import type { AuthContext, AuthProvider, BlobStore } from "@carton/core/plugins";
import { type HmacAuth, AuthError, tokenFromRequest, canPush, canInvite } from "@carton/server";
import { createBlobUrlSigner, serveSignedBlob, readBody, BodyTooLarge, type BlobUrlSigner } from "@carton/blob-memory/signed";
import { BlobError, MAX_PARTS, checkKey, checksKeys } from "@carton/blob-memory/rules";
import { eachLimit } from "./pool.ts";
import { decodeManifest, leafSpan, manifestKey, verifyLeaf, webCryptoHasher } from "@carton/media";
import { isTeamMediaStore, mediaLockScope } from "./team.ts";

// Any AuthProvider serves sessions; the invite routes need the demo's invite flow (HmacAuth). With another provider
// (Cardboard's accounts) those routes answer 501 and sessions come from that provider.
export type HttpAuth = AuthProvider & Partial<Pick<HmacAuth, "join" | "refresh" | "createInvite" | "check">>;

export interface HttpDeps {
  auth: HttpAuth;
  // signs blob URLs (derived under its own label, so it can be the auth secret)
  secret: string | Uint8Array;
  blobsFor(projectId: string): BlobStore | undefined;
  // the sequencer's blob scope, for the envelope routes (only its messages/ keys are ever reachable)
  sequencerBlobsFor?(projectId: string): BlobStore | undefined;
  // the host's WebSocket upgrade, called with the verified context
  upgrade(req: Request, auth: AuthContext, projectId: string): Promise<Response>;
  adminToken?: string;
  // the largest part or signed PUT body accepted (Workers' request limit is 100 MB on the Free plan)
  maxBodyBytes?: number;
  // the largest envelope upload accepted: the sequencer's maxEnvelopeBytes (default 64 MiB; a Durable Object host
  // sets it lower, for its 128 MB of memory)
  maxEnvelopeBytes?: number;
  // the most keys one POST /blobs/heads checks (default and most MAX_BLOB_HEADS); it answers for that many and the
  // client asks again for the rest. A host whose requests have a budget of storage calls (a Worker's) sets fewer.
  maxBlobHeads?: number;
  // after an envelope upload: a host whose sequencer sweeps on a schedule makes sure the sweep will run
  onEnvelope?(projectId: string): Promise<void> | void;
  // Open creation: anyone may make a project and be its first owner, with no admin token (the free web demo). Off
  // without it.
  openCreate?: OpenCreate;
  // who is asking, for openCreate's daily limit: the client's IP address as the host knows it
  clientOf?(req: Request): string;
  // the largest file one upload may store (a multipart object, or a signed PUT); none by default
  maxUploadBytes?: number;
}

/** A host's open creation (HttpDeps.openCreate): its record of project ids in use, and its daily limit. */
export interface OpenCreate {
  /** New projects one client (IP address) may make per UTC day. */
  readonly perDay: number;
  /**
   * Claim `projectId` for a new project made by `client`: "ok" once per id, ever; "taken" for an id already claimed or
   * in use (a project made any other way); "limit" when the client has made `perDay` projects today.
   */
  claim(projectId: string, client: string): Promise<"ok" | "taken" | "limit">;
  /** Record an id as in use without counting it (an admin invite made the project). */
  mark(projectId: string): Promise<void>;
}

/** The UTC day of `ms`, as the daily limit counts (`2026-11-01`). */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Defaults for open creation, used by the hosts when a setting is not given. */
export const OPEN_CREATE_PER_DAY = 10;
export const OPEN_CREATE_MAX_UPLOAD = 200 * 1024 * 1024;

const PROJECT = /^\/(?:api\/(?:admin\/)?projects|blob)\/([A-Za-z0-9._~-]{1,128})(\/.*)?$/;
const MAX_JSON = 64 * 1024;
const ROLES = new Set(["owner", "editor", "commenter", "viewer"]);
const ACCOUNT = /^[A-Za-z0-9._~-]{1,128}$/;
const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

export { teamMediaStore, projectMediaStore, isTeamMediaStore, mediaLockScope, type TeamMediaStore, type TeamMediaOptions } from "./team.ts";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, message: string) => json({ error: message }, status);

// A complete request lists up to 10,000 parts: {"partNumber":10000,"etag":"…"} is under 100 bytes each.
const MAX_COMPLETE_JSON = MAX_PARTS * 128 + 1024;

/** The most keys a POST /blobs/heads may name (REQ-11: media's reuse check, one request per 1,000 parts). */
export const MAX_BLOB_HEADS = 1000;
/** Its largest body: 1,000 keys of the longest (1,024 bytes) fit, unescaped. */
export const MAX_BLOB_HEADS_JSON = 1024 * 1024;
// heads of one batch in flight at once (a Worker opens at most six connections at a time anyway)
const HEADS_AT_ONCE = 8;

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
  // what a client needs to know before it creates or uploads (the web app's New project, the desktop Share form)
  if (url.pathname === "/api/host" && req.method === "GET")
    return json({ openCreate: !!deps.openCreate, ...(deps.openCreate ? { perDay: deps.openCreate.perDay } : {}), maxUploadBytes: deps.maxUploadBytes ?? null });
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
      const maxPut = Math.min(deps.maxBodyBytes ?? Infinity, deps.maxUploadBytes ?? Infinity);
      return await serveSignedBlob(req, store, blobSigner(deps, url.origin, projectId), { ...(Number.isFinite(maxPut) ? { maxPutBytes: maxPut } : {}), aroundPut: (k, write) => withMediaLock(mediaLockScope(store, projectId), k, write) });
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (req.method !== "POST" || rest !== "/invites") return err(404, "no such route");
      const given = tokenFromRequest(req.headers);
      if (!deps.adminToken || !given || !(await sameSecret(given, deps.adminToken))) return err(401, "admin token required");
      const b = await body<{ role?: string; ttlMs?: number }>(req);
      const role = (b.role ?? "owner") as AuthContext["role"];
      if (!ROLES.has(role)) return err(400, "bad role");
      const invite = await invites().createInvite(projectId, role, b.ttlMs);
      // a project made this way is in use: open creation never hands it to someone else
      await deps.openCreate?.mark(projectId);
      return json({ invite });
    }
    // open creation: the first owner's session, with no admin token, for a project id never used on this host
    if (req.method === "POST" && rest === "/create") {
      const oc = deps.openCreate;
      if (!oc) return err(403, "this host doesn't let anyone create projects: ask its owner for an invite");
      const b = await body<{ account?: string; installKey?: string }>(req);
      const account = String(b.account ?? ""), installKey = String(b.installKey ?? "");
      // checked before the claim, which can't be undone
      if (!ACCOUNT.test(account)) return err(400, "bad account id");
      if (installKey.length < 16 || installKey.length > 512) return err(400, "bad install key");
      const { createInvite, join } = invites();
      const claimed = await oc.claim(projectId, deps.clientOf?.(req) ?? "unknown");
      if (claimed === "limit") return err(429, `This host takes ${oc.perDay} new projects a day from one network. Try again tomorrow.`);
      if (claimed === "taken") return err(409, "a project with this id already exists on this host");
      const j = await join(await createInvite(projectId, "owner", 60_000), account, installKey);
      return json({ token: j.token, context: j.context });
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
    // the session alone, open to every valid one (a scoped watch link too): a WebSocket client whose handshake failed
    // asks it to tell a refused session (401/403) from a host it couldn't reach
    if (req.method === "GET" && rest === "/session") return json({ role: ctx.role });
    if (req.method === "POST" && rest === "/invites") {
      if (!canInvite(ctx)) return err(403, "only the owner invites");
      const b = await body<{ role?: string; ttlMs?: number; branches?: string[] }>(req);
      if (!ROLES.has(String(b.role))) return err(400, "bad role");
      // `branches`: the cuts its sessions are scoped to (a Published cut's watch link reads that cut only). An owner
      // whose own session is scoped invites only within that scope, never wider.
      if (ctx.branches && !(Array.isArray(b.branches) && b.branches.every((x) => ctx.branches!.includes(x)))) return err(403, "an invite can't reach past your own cuts");
      return json({ invite: await invites().createInvite(projectId, b.role as AuthContext["role"], b.ttlMs, b.branches) });
    }
    if (rest.startsWith("/messages/")) return await messageRoutes(req, rest.slice("/messages/".length), ctx, deps, projectId);
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

// A client's envelope upload and the server's envelopes it reads: exactly the keys core's envelope code makes.
const CLIENT_ENVELOPE = /^messages\/c\/\d{1,12}\/([0-9a-f]{64})-[0-9a-f]{8,64}$/;
const SERVER_ENVELOPE = /^messages\/s\/\d{1,12}\/[0-9a-f]{64}$/;
// A client envelope's key hour may differ from the server's clock by this many hours (clock skew).
const ENVELOPE_HOUR_SKEW = 2;
// The sequencer reads at most 64 MiB from one client envelope by default (createSequencer's maxEnvelopeBytes).
const MAX_ENVELOPE = 64 << 20;

async function messageRoutes(req: Request, key: string, ctx: AuthContext, deps: HttpDeps, projectId: string): Promise<Response> {
  const store = deps.sequencerBlobsFor?.(projectId);
  if (!store) return err(404, "this host carries no oversized messages");
  if (req.method === "PUT") {
    const m = CLIENT_ENVELOPE.exec(key);
    if (!m) return err(404, "not a client envelope key");
    // the key's hour decides when the sweep removes it: one far from now would never expire (or expire at once)
    const hour = Number(key.split("/")[2]), now = Math.floor(Date.now() / 3600_000);
    if (Math.abs(hour - now) > ENVELOPE_HOUR_SKEW) return err(400, "envelope key hour too far from the server's clock");
    // only writers send messages big enough to need one (pushes, adoptions, keyframes)
    if (!canPush(ctx)) return err(403, "read-only role");
    let data: Uint8Array;
    try {
      data = await readBody(req, deps.maxEnvelopeBytes ?? MAX_ENVELOPE);
    } catch (e) {
      if (e instanceof BodyTooLarge) return err(413, "envelope too large");
      throw e;
    }
    // the key names the message's SHA-256; a store that verifies (R2) refuses bytes that don't match, and the
    // sequencer checks the digest again when it reads the envelope
    await store.put(key, data, { contentType: "application/json", sha256: m[1]!, ifAbsent: true });
    await deps.onEnvelope?.(projectId);
    return json({});
  }
  if (req.method === "GET") {
    if (!SERVER_ENVELOPE.test(key)) return err(404, "not a server envelope key");
    const body = store.getStream ? await store.getStream(key) : await store.get(key);
    if (body === null) return err(404, "no such envelope");
    return new Response(body as ConstructorParameters<typeof Response>[0], { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return err(405, "PUT or GET");
}

// §11's repair path, host side: a reader whose leaf can never verify reports it; the host checks that leaf itself
// against the manifest (mf/<hash>, which the hash itself verifies) and, only if the stored bytes really are wrong,
// removes the object, so the owner's next share finds it missing and uploads it again. A report can't remove a good
// object: the host reads the leaf and the manifest, and trusts neither the reporter nor its claim. If the object was
// replaced while it was being checked (its etag changed), it is left alone: the new one may be good. Writes of an
// `m/<hash>` key through this API (a signed PUT's store write, once its body has arrived; a multipart complete) wait
// for a check of that key in progress, and the check waits for them, so a replacement can't land between the last head
// and the delete. The lock is per physical scope and key (`mediaLockScope`: a team's media, shared by its projects, or
// one project's), so other projects' writes of the same hash don't wait. It is per process: on a host of many processes (Workers), a write served by another one can still land there, and since
// BlobStore has no conditional delete it is removed too. The cost is that one write undone (the uploader's next share
// uploads it again), never wrong bytes served.
const hasher = webCryptoHasher();
const MEDIA_KEY = /^m\/[0-9a-f]{64}$/;
const mediaLocks = new Map<string, Promise<void>>();
async function withMediaLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
  if (!MEDIA_KEY.test(key)) return fn();
  const id = `${scope}\n${key}`;
  const before = mediaLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = before.then(() => new Promise<void>((r) => (release = r)));
  mediaLocks.set(id, mine);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (mediaLocks.get(id) === mine) mediaLocks.delete(id);
  }
}

async function checkDamaged(store: BlobStore, scope: string, key: string, leaf: number): Promise<Response> {
  const m = /^m\/([0-9a-f]{64})$/.exec(key);
  if (!m) return err(400, "only media objects (m/<hash>) are checked");
  return withMediaLock(scope, key, () => checkDamagedLocked(store, key, m[1]!, leaf));
}
async function checkDamagedLocked(store: BlobStore, key: string, hash: string, leaf: number): Promise<Response> {
  const manifestBytes = await store.get(manifestKey(hash));
  if (!manifestBytes) return err(409, "no manifest to check it against");
  let manifest;
  try {
    manifest = await decodeManifest(manifestBytes, hasher, hash);
  } catch {
    return err(409, "the manifest doesn't verify");
  }
  const before = await store.head(key);
  if (!before) return json({ damaged: true, removed: false, missing: true });
  let damaged: boolean;
  if (before.size !== manifest.size) damaged = true;
  else {
    if (!Number.isInteger(leaf) || leaf < 0 || leaf >= manifest.leafCount) return err(400, `leaf must be 0..${manifest.leafCount - 1}`);
    const bytes = await store.get(key, leafSpan(manifest.size, leaf));
    damaged = !bytes || !(await verifyLeaf(manifest, leaf, bytes, hasher));
  }
  if (!damaged) return json({ damaged: false });
  const now = await store.head(key);
  if (!now || now.etag !== before.etag) return json({ damaged: true, removed: false, replaced: true });
  await store.delete(key);
  return json({ damaged: true, removed: true });
}

// Keys named by content (@carton/media: `m/<hash>` bytes, `mf/<hash>` manifests, `px/<hash>/…` proxy pointers, `t1/<hash>/…`
// T1 extras, §11): reading one needs its content hash, which only a document that uses the media gives away.
const CONTENT_KEYS = ["m/", "mf/", "px/", "t1/", "lv/"];

/**
 * What a reader scoped to some cuts (a Published cut's watch link, §14) may read from the media scope: media named by
 * content, and files kept for one of its cuts under `cuts/<cutId>/`. Never the project's own files (its descriptor
 * holds Main's root; web-demo review R2-1). An unscoped session, or a writer, reads the whole scope. (web-demo a05f18e)
 */
export function mayRead(ctx: AuthContext, key: string): boolean {
  if (!ctx.branches || canPush(ctx)) return true;
  if (CONTENT_KEYS.some((p) => key.startsWith(p))) return true;
  return ctx.branches.some((b) => key.startsWith(`cuts/${b}/`));
}

/** A head through the media API: an editor's claims a team object (team.ts), as an upload's head must. */
async function headFor(ctx: AuthContext, store: BlobStore, key: string) {
  // an editor could reference this hash in the document anyway; claiming it here lets an upload find a teammate's copy
  if (canPush(ctx) && isTeamMediaStore(store)) await store.claim(key);
  return store.head(key);
}

/**
 * POST /blobs/heads (REQ-11): HEAD for many keys, by HEAD's rules: every key valid and within the session's scope, or
 * the whole request is refused (400, 403); an editor's claims team objects. It answers `{blobs}`, one entry per key in
 * order, `{size}` or null, for the first `maxBlobHeads` keys (all of them, unless the host has a smaller budget); the
 * client asks again for the rest.
 */
async function headsFor(req: Request, ctx: AuthContext, store: BlobStore, deps: HttpDeps): Promise<Response> {
  const b = await body<{ keys?: unknown } | null>(req, MAX_BLOB_HEADS_JSON);
  const keys = b?.keys;
  if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === "string")) return err(400, "keys must be an array of strings");
  if (keys.length > MAX_BLOB_HEADS) return err(400, `at most ${MAX_BLOB_HEADS} keys a request`);
  // every key, by the store's own rules (a scope's prefix leaves less room), before any call: one it would refuse
  // refuses the whole batch, and nothing is claimed
  for (const k of keys) checksKeys(store) ? store.checkKey(k) : checkKey(k);
  if (!keys.every((k) => mayRead(ctx, k))) return err(403, "outside this link's scope");
  const budget = Math.max(1, Math.min(MAX_BLOB_HEADS, Math.floor(deps.maxBlobHeads ?? MAX_BLOB_HEADS)));
  const todo = keys.slice(0, budget);
  // a key named twice is looked up once
  const unique = [...new Set(todo)];
  const found = new Map<string, { size: number } | null>();
  await eachLimit(unique, HEADS_AT_ONCE, async (k) => {
    const info = await headFor(ctx, store, k);
    found.set(k, info ? { size: info.size } : null);
  });
  return json({ blobs: todo.map((k) => found.get(k) ?? null) });
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
  if (req.method === "POST" && rest === "/blobs/damaged") {
    const b = await body<{ key?: string; leaf?: number }>(req);
    return checkDamaged(store, mediaLockScope(store, projectId), String(b.key ?? ""), Number(b.leaf));
  }
  if (req.method === "GET" && rest === "/blobs/head") {
    if (!mayRead(ctx, key)) return err(403, "outside this link's scope");
    const info = await headFor(ctx, store, key);
    return info ? json(info) : err(404, "no such blob");
  }
  if (req.method === "POST" && rest === "/blobs/heads") return headsFor(req, ctx, store, deps);
  if (!canPush(ctx)) return err(403, "read-only role");
  if (req.method === "POST" && rest === "/blobs/pieces-done") {
    const b = await body<{ hash?: string }>(req);
    return piecesDone(store, String(b.hash ?? ""));
  }
  const up = /^\/uploads(?:\/([^/]+)(?:\/(\d+|complete))?)?$/.exec(rest);
  if (!up) return err(404, "no such route");
  const [, id, sub] = up;
  if (!id && req.method === "POST") {
    const b = await body<{ key?: string; contentType?: string; size?: number }>(req);
    if (deps.maxUploadBytes !== undefined && typeof b.size === "number" && b.size > deps.maxUploadBytes) return err(413, `This file is bigger than this host takes (${mb(deps.maxUploadBytes)}).`);
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
    // every part but the last has one size, so part n of this size means at least n × it in the whole file
    if (deps.maxUploadBytes !== undefined && Number(sub) * data.length > deps.maxUploadBytes) {
      await handle.abort().catch(() => {});
      return err(413, `This file is bigger than this host takes (${mb(deps.maxUploadBytes)}).`);
    }
    return json(await handle.uploadPart(Number(sub), data));
  }
  if (req.method === "GET" && !sub) return json({ parts: await handle.listParts() });
  if (req.method === "POST" && sub === "complete") {
    const b = await body<{ parts?: unknown }>(req, MAX_COMPLETE_JSON);
    const parts = b.parts;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS || parts.some((p) => !p || typeof p.etag !== "string" || p.etag.length > 256 || !Number.isInteger(p.partNumber)))
      return err(400, `parts must be 1..${MAX_PARTS} {partNumber, etag} entries`);
    const info = await withMediaLock(mediaLockScope(store, projectId), key, () => handle.complete(parts as { partNumber: number; etag: string }[]));
    // the whole file over the cap (parts of uneven sizes passed the per-part check): not kept
    if (deps.maxUploadBytes !== undefined && info.size > deps.maxUploadBytes) {
      await store.delete(key).catch(() => {});
      return err(413, `This file is bigger than this host takes (${mb(deps.maxUploadBytes)}).`);
    }
    return json(info);
  }
  if (req.method === "DELETE" && !sub) {
    await handle.abort();
    return json({});
  }
  return err(404, "no such route");
}

// PIECES: a clip uploaded from a browser plays for teammates while it uploads. A multipart object is invisible until it
// completes, so the uploader first puts the file up in pieces, each its own object (`lv/<hash>/<n>`, whole leaves, so
// a reader verifies them against the manifest at mf/<hash> like any media), with `lv/<hash>/info` ({size, pieceSize,
// pieces}) first; then the whole file as m/<hash>. Once m/<hash> is there the pieces are redundant: any editor may have
// them removed, and only then.
const MEDIA_HASH = /^[0-9a-f]{64}$/;
async function piecesDone(store: BlobStore, hash: string): Promise<Response> {
  if (!MEDIA_HASH.test(hash)) return err(400, "hash must be a media hash");
  if (!(await store.head(`m/${hash}`))) return err(409, "the whole file isn't there yet");
  const infoBytes = await store.get(`lv/${hash}/info`);
  if (!infoBytes) return json({ removed: 0 });
  let pieces = 0;
  try {
    pieces = Number((JSON.parse(new TextDecoder().decode(infoBytes)) as { pieces?: number }).pieces);
  } catch {
    pieces = 0;
  }
  if (!Number.isInteger(pieces) || pieces < 0 || pieces > MAX_PARTS) pieces = 0;
  await eachLimit(Array.from({ length: pieces }, (_, i) => i), HEADS_AT_ONCE, (i) => store.delete(`lv/${hash}/${i}`));
  await store.delete(`lv/${hash}/info`);
  return json({ removed: pieces });
}
