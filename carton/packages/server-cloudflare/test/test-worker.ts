// Test-only Worker (never deployed): the real Worker, plus routes the Node tests use to reach inside workerd.
//   /__test/storage-checks       runs the SequencerStorage checks on a fresh Durable Object's ctx.storage.sql
//   /__test/vault/<name>/<path>  forwards to that project's BlobVault, so the Node-side DoBlobStore is the client
//   /__test/stats/<project>      the room's row counters and database size
import worker, { ProjectRoom, BlobVault } from "../src/worker.ts";
import { doSqlStorage } from "../src/storage.ts";
import { storageChecks } from "../../conformance/src/hosts/storage-checks.ts";
import { AUTH_HEADER, PROJECT_HEADER } from "../src/room.ts";
import type { DurableObjectNamespace, DurableObjectState } from "../src/cf.ts";
import type { Env } from "../src/env.ts";

export { ProjectRoom, BlobVault };

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
  async fetch(req: Request, env: TestEnv): Promise<Response> {
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
    const st = /^\/__test\/stats\/([^/]+)$/.exec(url.pathname);
    if (st) {
      const p = decodeURIComponent(st[1]!);
      const auth = { account: "test", credential: "test/stats", role: "owner", projectId: p, expires: Date.now() + 60_000 };
      return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(p)).fetch(new Request(`https://room/${p}/stats`, { headers: { [PROJECT_HEADER]: p, [AUTH_HEADER]: JSON.stringify(auth) } }));
    }
    return worker.fetch(req, env);
  },
};
