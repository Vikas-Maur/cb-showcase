// The lab's Worker: Carton's real Worker (packages/server-cloudflare/src/worker.ts), unchanged, plus two routes the
// lab needs and the product doesn't have, both behind the deployment's ADMIN_TOKEN (Bearer):
//   POST /api/lab/projects/:p/purge   delete up to 400 of the project's blobs (media and sequencer scopes) per call:
//                                     {deleted, more}; the lab calls it until `more` is false (every test cleans up).
//                                     `?retire=1` first retires the project: a purge is the end of a project's life, and
//                                     one whose sessions outlive it (a laptop pack's config: 48 hours) must not be run
//                                     again (stuck-sync, 2026-11-03: the pack ran a second time on its purged project;
//                                     its keyframes were gone, so no replica ever got up to date, and its 100 MB upload
//                                     went to a project nothing purges again). A retired room refuses WebSockets (410)
//   GET  /api/lab/projects/:p/retired whether the project is retired ({retired, at}), for a session of the project (the
//                                     laptop asks before anything else) or the admin token
//   GET  /api/lab/projects/:p/stats   the room's own counters (rows read and written by its SQL, database size)
//   POST /api/lab/projects/:p/vault-drop-uploads   drop the project's unfinished vault uploads (their parts stay in
//                                     the DO's SQLite otherwise: the vault has no lifecycle rule), and its size after
//   POST /api/lab/r2-abort-uploads    abort every unfinished R2 multipart upload the adapter has records for
//   POST /api/lab/r2-wipe             delete every object in the bucket, 500 a call (the lab's final cleanup)
//   GET  /api/lab/projects/:p/ids     the project's Durable Object ids (room, vault, and today's write-cap counter
//                                     room), so the lab reads each run's own objects from the analytics even when
//                                     several runs share the clock (idFromName only: wakes no object)
// Deletes are free on R2 and count as rows written on the vault.
import worker, { ProjectRoom as RealProjectRoom, BlobVault as RealBlobVault } from "../../packages/server-cloudflare/src/worker.ts";
import { createHmacAuth } from "@carton/server";
import type { DurableObjectState, ExecutionContext } from "../../packages/server-cloudflare/src/cf.ts";
import { mediaBlobs, sequencerBlobs, AUTH_HEADER, PROJECT_HEADER } from "../../packages/server-cloudflare/src/room.ts";
import type { Env } from "../../packages/server-cloudflare/src/env.ts";

// The room, plus the lab's retirement (`purge?retire=1`): one row, read once per instance and only for a WebSocket
// upgrade or the lab's own routes (a room never retired has no table, so the read costs no row).
const RETIRED_WORDS = "this lab project was cleaned up after its run and can't be used again: ask for a fresh config.json";
export class ProjectRoom extends RealProjectRoom {
  readonly #lab: DurableObjectState;
  /** When the project was retired, null if never; undefined until read. */
  #retired: number | null | undefined;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#lab = state;
  }
  #retiredAt(): number | null {
    if (this.#retired === undefined) {
      try {
        const row = this.#lab.storage.sql.exec<{ at: number }>("SELECT at FROM lab_retired LIMIT 1").toArray()[0];
        this.#retired = row ? Number(row.at) : null;
      } catch {
        this.#retired = null; // no table: never retired
      }
    }
    return this.#retired;
  }
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/lab/retire" && req.method === "POST") {
      if (this.#retiredAt() === null) {
        const sql = this.#lab.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS lab_retired (at INTEGER NOT NULL)");
        sql.exec("INSERT INTO lab_retired (at) VALUES (?)", (this.#retired = Date.now()));
      }
      return Response.json({ retired: true, at: this.#retired });
    }
    if (path === "/lab/retired") return Response.json({ retired: this.#retiredAt() !== null, at: this.#retiredAt() });
    if (path.endsWith("/ws") && this.#retiredAt() !== null) return new Response(RETIRED_WORDS, { status: 410 });
    return super.fetch(req);
  }
}

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

const LAB = /^\/api\/lab\/projects\/([A-Za-z0-9._~-]{1,128})\/(purge|stats|vault-drop-uploads|ids|retired)$/;

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
  // ctx goes through to the real Worker, which holds each request's work with waitUntil (fix/cf-part-lock)
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
    // the lab's last cleanup: every object in the bucket, 500 a call ({deleted, left})
    if (path === "/api/lab/r2-wipe") {
      if (!(await admin(req, env))) return Response.json({ error: "admin token required" }, { status: 401 });
      if (!env.BLOBS) return Response.json({ deleted: 0, left: false });
      const page = await env.BLOBS.list({ limit: 500 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await env.BLOBS.delete(keys);
      return Response.json({ deleted: keys.length, left: page.truncated });
    }
    const m = LAB.exec(path);
    if (!m) return worker.fetch(req, env, ctx);
    const [, projectId, what] = m;
    const roomOf = () => env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId!));
    // a session of this project may ask too (the laptop's config holds sessions, never the admin token)
    if (what === "retired") {
      const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const session = given && env.AUTH_SECRET ? await createHmacAuth({ secret: env.AUTH_SECRET }).verify(given).catch(() => null) : null;
      if (session?.projectId !== projectId && !(await admin(req, env))) return Response.json({ error: "a session of this project required" }, { status: 401 });
      return roomOf().fetch("https://room/lab/retired");
    }
    if (!(await admin(req, env))) return Response.json({ error: "admin token required" }, { status: 401 });
    if (what === "ids") {
      const day = new Date().toISOString().slice(0, 10);
      return Response.json({
        room: String(env.PROJECT_ROOM.idFromName(projectId!)),
        vault: env.BLOB_VAULT ? String(env.BLOB_VAULT.idFromName(projectId!)) : null,
        writeCap: String(env.PROJECT_ROOM.idFromName(`write-cap/${day}`)),
      });
    }
    if (what === "vault-drop-uploads") {
      if (!env.BLOB_VAULT) return Response.json({ dropped: 0 });
      return env.BLOB_VAULT.get(env.BLOB_VAULT.idFromName(projectId!)).fetch("https://vault/lab/drop-uploads", { method: "POST" });
    }
    if (what === "stats") {
      const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId!));
      const sys = { account: "lab", credential: "lab/stats", role: "owner", projectId, expires: Date.now() + 60_000 };
      return room.fetch(new Request(`https://room/${projectId}/stats`, { headers: { [PROJECT_HEADER]: projectId!, [AUTH_HEADER]: JSON.stringify(sys) } }));
    }
    // retired before anything is deleted: a run that starts meanwhile is refused, never left half-served
    let retired = false;
    if (new URL(req.url).searchParams.get("retire") === "1") retired = ((await (await roomOf().fetch("https://room/lab/retire", { method: "POST" })).json()) as { retired: boolean }).retired;
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
    return Response.json({ deleted, more, ...(retired ? { retired } : {}) });
  },
};
