// The Worker (PLAN §3, §17): the HTTP API (@carton/host-http), the static web client, and the door to each
// project's ProjectRoom. It checks the session token before a room wakes, so a bad token costs no Durable Object
// request, and passes the verified context to the room in a header a client can't set (the Worker builds the
// room's request itself).

import type { AuthContext } from "@carton/core/plugins";
import { createHmacAuth, type HmacAuth, offersCartonProtocol } from "@carton/server";
import { handleHttp, dayOf, OPEN_CREATE_MAX_UPLOAD, OPEN_CREATE_PER_DAY, type HttpDeps, type OpenCreate } from "@carton/host-http";
import type { Env } from "./env.ts";
import type { ExecutionContext } from "./cf.ts";
import { ProjectRoom, mediaBlobs, mediaBlobsForWrites, sequencerBlobs, maxEnvelopeOf, AUTH_HEADER, PROJECT_HEADER } from "./room.ts";
import { BlobVault } from "./blob-do.ts";
import { WriteCapError, writeCapResponse } from "./write-cap.ts";

export { ProjectRoom, BlobVault };

// One auth per isolate and secret: importing the HMAC key costs a little, and isolates are reused across requests.
let cached: { secret: string; auth: HmacAuth } | null = null;
function authFor(env: Env): HmacAuth {
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set (wrangler secret put AUTH_SECRET, or .dev.vars locally)");
  if (cached?.secret !== env.AUTH_SECRET) cached = { secret: env.AUTH_SECRET, auth: createHmacAuth({ secret: env.AUTH_SECRET }) };
  return cached.auth;
}

export function depsFor(env: Env): HttpDeps {
  const deps: HttpDeps = {
    auth: authFor(env),
    secret: env.AUTH_SECRET,
    blobsFor: (projectId) => mediaBlobs(env, projectId),
    // a stream append reserves the daily write cap once for all its writes (one counter request, not one per write)
    blobsForWrites: (projectId, bytes, ops) => mediaBlobsForWrites(env, projectId, bytes, ops),
    sequencerBlobsFor: (projectId) => sequencerBlobs(env, projectId),
    maxEnvelopeBytes: maxEnvelopeOf(env),
    maxBlobHeads: Number(env.BLOB_HEADS_PER_REQUEST ?? 200) || 200,
    // an envelope upload arms the room's sweep, so an upload whose message never comes is still swept
    async onEnvelope(projectId) {
      const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
      const sweeper = { account: "worker", credential: "worker/sweep", role: "owner", projectId, expires: Date.now() + 60_000 };
      await room.fetch(new Request(`https://room/${projectId}/sweep`, { method: "POST", headers: { [PROJECT_HEADER]: projectId, [AUTH_HEADER]: JSON.stringify(sweeper) } }));
    },
    async upgrade(req: Request, auth: AuthContext, projectId: string) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
      if (!offersCartonProtocol(req.headers) && !req.headers.get("authorization"))
        return new Response("offer the carton.v1 subprotocol", { status: 400 });
      const headers = new Headers({ upgrade: "websocket", [PROJECT_HEADER]: projectId, [AUTH_HEADER]: JSON.stringify(auth) });
      for (const h of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]) {
        const v = req.headers.get(h);
        if (v) headers.set(h, v);
      }
      const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
      return room.fetch(new Request(`https://room/${projectId}/ws`, { headers }));
    },
  };
  if (env.ADMIN_TOKEN) deps.adminToken = env.ADMIN_TOKEN;
  const open = env.OPEN_CREATE === "1" || env.OPEN_CREATE === "true";
  if (open) {
    deps.openCreate = openCreateOf(env);
    deps.clientOf = (req) => req.headers.get("cf-connecting-ip") ?? "unknown";
  }
  const maxUpload = env.MAX_UPLOAD_BYTES ? Number(env.MAX_UPLOAD_BYTES) : open ? OPEN_CREATE_MAX_UPLOAD : undefined;
  if (maxUpload !== undefined && Number.isFinite(maxUpload) && maxUpload > 0) deps.maxUploadBytes = maxUpload;
  return deps;
}

/**
 * Open creation on Workers: the daily count in one room per UTC day (`open-create/<day>`), the claim in the project's
 * own room (its `carton_room` table: claimed once, never a project with a cut already on the host).
 */
function openCreateOf(env: Env): OpenCreate {
  const perDay = Math.max(1, Math.floor(Number(env.OPEN_CREATE_PER_DAY ?? OPEN_CREATE_PER_DAY) || OPEN_CREATE_PER_DAY));
  const system = (projectId: string) => ({ [PROJECT_HEADER]: projectId, [AUTH_HEADER]: JSON.stringify({ account: "worker", credential: "worker/create", role: "owner", projectId, expires: Date.now() + 60_000 }) });
  const claimIn = async (projectId: string): Promise<boolean> => {
    const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
    const r = await room.fetch(new Request(`https://room/${projectId}/claim`, { method: "POST", headers: system(projectId) }));
    if (!r.ok) throw new Error(`claim: ${r.status}`);
    return !((await r.json()) as { taken: boolean }).taken;
  };
  return {
    perDay,
    async claim(projectId, client) {
      const day = dayOf(Date.now());
      const counter = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(`open-create/${day}`));
      const c = await counter.fetch(new Request("https://room/open-create/count", { method: "POST", body: JSON.stringify({ client, max: perDay }) }));
      if (!((await c.json()) as { ok: boolean }).ok) return "limit";
      return (await claimIn(projectId)) ? "ok" : "taken";
    },
    async mark(projectId) {
      await claimIn(projectId);
    },
  };
}

export default {
  // The request's work is handed to waitUntil, so a client that goes away mid-request (a killed app, a dead link)
  // doesn't cancel it halfway: the runtime cancels a request's work when its client disconnects unless it is held
  // this way (up to 30 s more). A part upload holds that part's lock in R2 (blob-r2.ts) while its body arrives; cut
  // off before its `finally`, it left the lock held for LOCK_TTL_MS (30 minutes), and every resume of that upload was
  // refused "part N is being uploaded by another request" until then (cf-lab, 2026-11-02). Ordinary requests settle
  // with their response, so this keeps nothing alive longer.
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    let res: Response | null;
    const work = handleHttp(req, depsFor(env));
    ctx?.waitUntil(work.catch(() => {}));
    try {
      res = await work;
    } catch (e) {
      // the daily write cap refused a write (write-cap.ts): 429 with Retry-After, before any byte was stored
      if (e instanceof WriteCapError) return writeCapResponse(e);
      throw e;
    }
    if (res) return res;
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("not found", { status: 404 });
  },
};
