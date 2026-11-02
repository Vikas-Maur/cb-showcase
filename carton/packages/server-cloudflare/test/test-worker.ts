// Test-only Worker (never deployed): the real Worker, plus routes the Node tests use to reach inside workerd.
//   /__test/storage-checks       runs the SequencerStorage checks on a fresh Durable Object's ctx.storage.sql
//   /__test/vault/<name>/<path>  forwards to that project's BlobVault, so the Node-side DoBlobStore is the client
//   /__test/stats/<project>      the room's row counters and database size
//   /__test/wake/<project>       a new room instance over the same state, as after hibernation
//   /__test/legacy/<project>?at= the room as code from before `maintain_at` left it: its alarm at `at`, no due time
//   /__test/due/<project>        the room's recorded maintenance due time and its alarm
import worker, { ProjectRoom as Room, BlobVault } from "../src/worker.ts";
import { doSqlStorage } from "../src/storage.ts";
import { storageChecks } from "../../conformance/src/hosts/storage-checks.ts";
import { AUTH_HEADER, PROJECT_HEADER } from "../src/room.ts";
import type { DurableObjectNamespace, DurableObjectState, ExecutionContext } from "../src/cf.ts";
import type { Env } from "../src/env.ts";

export { BlobVault };

// ProjectRoom as deployed, plus `…/__wake`: a new instance over the same state, as after hibernation (its memory
// gone, its sockets back with their attachments). Everything else goes to the current instance.
export class ProjectRoom {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;
  #room: Room;
  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    this.#room = new Room(ctx, env);
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/__wake")) {
      this.#room = new Room(this.#ctx, this.#env);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/__unseen")) {
      // every socket's attachment as code from before `seen` wrote it, then a wake
      for (const ws of this.#ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as { seen?: number } | null;
        if (att) delete att.seen, ws.serializeAttachment(att);
      }
      this.#room = new Room(this.#ctx, this.#env);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/__legacy")) {
      this.#ctx.storage.sql.exec("DELETE FROM carton_room WHERE k = 'maintain_at'");
      await this.#ctx.storage.setAlarm(Number(url.searchParams.get("at")));
      this.#room = new Room(this.#ctx, this.#env); // deployed anew: nothing of the old instance remains
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/__due")) {
      const row = this.#ctx.storage.sql.exec<Record<string, unknown>>("SELECT v FROM carton_room WHERE k = 'maintain_at'").toArray()[0];
      return Response.json({ maintainAt: row ? Number(row.v) : null, alarm: await this.#ctx.storage.getAlarm() });
    }
    return this.#room.fetch(req);
  }
  webSocketMessage(...a: Parameters<Room["webSocketMessage"]>) {
    return this.#room.webSocketMessage(...a);
  }
  webSocketClose(...a: Parameters<Room["webSocketClose"]>) {
    return this.#room.webSocketClose(...a);
  }
  webSocketError(...a: Parameters<Room["webSocketError"]>) {
    return this.#room.webSocketError(...a);
  }
  alarm() {
    return this.#room.alarm();
  }
}

export class StorageProbe {
  readonly #ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
  }
  async fetch(): Promise<Response> {
    const s = doSqlStorage(this.#ctx.storage);
    const results = storageChecks().map((c) => {
      try {
        c.run(s);
        return { name: c.name, ok: true };
      } catch (e) {
        return { name: c.name, ok: false, error: String((e as Error)?.stack ?? e) };
      }
    });
    return Response.json(results);
  }
}

type TestEnv = Env & { STORAGE_PROBE: DurableObjectNamespace };

export default {
  async fetch(req: Request, env: TestEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__test/storage-checks") {
      const ns = env.STORAGE_PROBE;
      return ns.get(ns.idFromName(crypto.randomUUID())).fetch("https://probe/");
    }
    const v = /^\/__test\/vault\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (v) {
      if (!env.BLOB_VAULT) return new Response("no vault", { status: 404 });
      const init: RequestInit = { method: req.method };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
      return env.BLOB_VAULT.get(env.BLOB_VAULT.idFromName(decodeURIComponent(v[1]!))).fetch(`https://vault${v[2]}${url.search}`, init);
    }
    const al = /^\/__test\/alarm\/([^/]+)$/.exec(url.pathname);
    if (al) {
      const p = decodeURIComponent(al[1]!);
      const auth = { account: "test", credential: "test/alarm", role: "owner", projectId: p, expires: Date.now() + 60_000 };
      return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(p)).fetch(new Request(`https://room/${p}/alarm`, { headers: { [PROJECT_HEADER]: p, [AUTH_HEADER]: JSON.stringify(auth) } }));
    }
    const wk = /^\/__test\/(wake|unseen|legacy|due)\/([^/]+)$/.exec(url.pathname);
    if (wk) {
      const p = decodeURIComponent(wk[2]!);
      const auth = { account: "test", credential: `test/${wk[1]}`, role: "owner", projectId: p, expires: Date.now() + 60_000 };
      return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(p)).fetch(new Request(`https://room/${p}/__${wk[1]}${url.search}`, { headers: { [PROJECT_HEADER]: p, [AUTH_HEADER]: JSON.stringify(auth) } }));
    }
    const st = /^\/__test\/stats\/([^/]+)$/.exec(url.pathname);
    if (st) {
      const p = decodeURIComponent(st[1]!);
      const auth = { account: "test", credential: "test/stats", role: "owner", projectId: p, expires: Date.now() + 60_000 };
      return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(p)).fetch(new Request(`https://room/${p}/stats`, { headers: { [PROJECT_HEADER]: p, [AUTH_HEADER]: JSON.stringify(auth) } }));
    }
    return worker.fetch(req, env, ctx);
  },
};
