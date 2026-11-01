// The lab's Worker: Carton's real Worker (packages/server-cloudflare/src/worker.ts), unchanged, plus two routes the
// lab needs and the product doesn't have, both behind the deployment's ADMIN_TOKEN (Bearer):
//   POST /api/lab/projects/:p/purge   delete up to 400 of the project's blobs (media and sequencer scopes) per call:
//                                     {deleted, more}; the lab calls it until `more` is false (every test cleans up)
//   GET  /api/lab/projects/:p/stats   the room's own counters (rows read and written by its SQL, database size)
//   POST /api/lab/projects/:p/vault-drop-uploads   drop the project's unfinished vault uploads (their parts stay in
//                                     the DO's SQLite otherwise: the vault has no lifecycle rule), and its size after
//   POST /api/lab/r2-abort-uploads    abort every unfinished R2 multipart upload the adapter has records for
// Deletes are free on R2 and count as rows written on the vault.
import worker, { ProjectRoom, BlobVault as RealBlobVault } from "../../packages/server-cloudflare/src/worker.ts";
import type { DurableObjectState } from "../../packages/server-cloudflare/src/cf.ts";
import { mediaBlobs, sequencerBlobs, AUTH_HEADER, PROJECT_HEADER } from "../../packages/server-cloudflare/src/room.ts";
import type { Env } from "../../packages/server-cloudflare/src/env.ts";

export { ProjectRoom };

// The vault, plus the lab's cleanup of unfinished uploads and a size probe (the class name the binding uses).
export class BlobVault extends RealBlobVault {
  readonly #lab: DurableObjectState;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.#lab = state;
  }
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/lab/drop-uploads") {
      const sql = this.#lab.storage.sql;
      let dropped = 0;
      for (const t of ["part_chunks", "parts", "uploads"]) {
        try {
          dropped += sql.exec(`DELETE FROM ${t}`).rowsWritten;
        } catch {} // no such table: nothing was ever uploaded in parts
      }
      return Response.json({ dropped, size: sql.databaseSize });
    }
    return super.fetch(req);
  }
}

const LAB = /^\/api\/lab\/projects\/([A-Za-z0-9._~-]{1,128})\/(purge|stats|vault-drop-uploads)$/;

async function admin(req: Request, env: Env): Promise<boolean> {
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!env.ADMIN_TOKEN || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_TOKEN))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/api/lab/r2-abort-uploads") {
      if (!(await admin(req, env))) return Response.json({ error: "admin token required" }, { status: 401 });
      if (!env.BLOBS) return Response.json({ aborted: 0 });
      let aborted = 0, cursor: string | undefined;
      do {
        const page = await env.BLOBS.list({ prefix: ".carton-uploads/", limit: 200, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) {
          if (!o.key.endsWith("/meta") || !o.customMetadata?.key) continue;
          const id = o.key.slice(".carton-uploads/".length, -"/meta".length);
          await env.BLOBS.resumeMultipartUpload(o.customMetadata.key, id).abort().catch(() => {});
          aborted++;
        }
        const keys = page.objects.map((o) => o.key);
        if (keys.length) await env.BLOBS.delete(keys);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && aborted < 300);
      return Response.json({ aborted });
    }
    const m = LAB.exec(path);
    if (!m) return worker.fetch(req, env);
    if (!(await admin(req, env))) return Response.json({ error: "admin token required" }, { status: 401 });
    const [, projectId, what] = m;
    if (what === "vault-drop-uploads") {
      if (!env.BLOB_VAULT) return Response.json({ dropped: 0 });
      return env.BLOB_VAULT.get(env.BLOB_VAULT.idFromName(projectId!)).fetch("https://vault/lab/drop-uploads", { method: "POST" });
    }
    if (what === "stats") {
      const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId!));
      const sys = { account: "lab", credential: "lab/stats", role: "owner", projectId, expires: Date.now() + 60_000 };
      return room.fetch(new Request(`https://room/${projectId}/stats`, { headers: { [PROJECT_HEADER]: projectId!, [AUTH_HEADER]: JSON.stringify(sys) } }));
    }
    let budget = 400, deleted = 0, more = false;
    for (const store of [mediaBlobs(env, projectId!), sequencerBlobs(env, projectId!)]) {
      if (!store) continue;
      for (;;) {
        const page = await store.list("", { limit: Math.min(100, budget) });
        for (const b of page.blobs) await store.delete(b.key), deleted++, budget--;
        if (budget <= 0) { more = page.blobs.length > 0; break; }
        if (!page.cursor || page.blobs.length === 0) break;
      }
      if (budget <= 0) break;
    }
    return Response.json({ deleted, more });
  },
};
