// The Worker (PLAN §3, §17): the HTTP API (@carton/host-http), the static web client, and the door to each
// project's ProjectRoom. It checks the session token before a room wakes, so a bad token costs no Durable Object
// request, and passes the verified context to the room in a header a client can't set (the Worker builds the
// room's request itself).

import type { AuthContext } from "@carton/core/plugins";
import { createHmacAuth, type HmacAuth, offersCartonProtocol } from "@carton/server";
import { handleHttp, type HttpDeps } from "@carton/host-http";
import type { Env } from "./env.ts";
import { ProjectRoom, mediaBlobs, AUTH_HEADER, PROJECT_HEADER } from "./room.ts";
import { BlobVault } from "./blob-do.ts";

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
  return deps;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await handleHttp(req, depsFor(env));
    if (res) return res;
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("not found", { status: 404 });
  },
};
