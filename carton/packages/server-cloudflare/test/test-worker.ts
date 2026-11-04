// Test-only Worker (never deployed): the real Worker, plus routes the Node tests use to reach inside workerd.
//   /__test/storage-checks       runs the SequencerStorage checks on a fresh Durable Object's ctx.storage.sql
//   /__test/vault/<name>/<path>  forwards to that project's BlobVault, so the Node-side DoBlobStore is the client (the
//                                body streamed through as it arrives, as the Worker's own calls send it)
//   /__test/r2-fixed-length      a streamed R2 part shorter, then longer, than its declared size, then whole: each
//                                outcome, the parts listed after the two bad ones, and the completed object's size
//   /__test/r2-lock?id=&n=       an R2 upload's part lock: its state ("held", "released") and when, or null
//   /__test/stats/<project>      the room's row counters and database size
//   /__test/wake/<project>       a new room instance over the same state, as after hibernation
//   /__test/legacy/<project>?at= the room as code from before `maintain_at` left it: its alarm at `at`, no due time
//   /__test/due/<project>        the room's recorded maintenance due time and its alarm
//   /__test/vault/<name>/__sweep  the vault's uploads, parts, chunks and alarm, and since the last report: the SQL rows
//                                written, the alarms set, and the rows each alarm wrote and read (the sweep's tests)
//   /__test/vault/<name>/__legacy the vault as code from before the sweep left it: uploads and parts with no time
//                                columns, one upload with a part, no alarm; then a new instance over that state
//   /__test/vault/<name>/__first  the vault as the sweep's first version left it: time columns, no walk state, an
//                                upload made `age` ms ago with a part written now, and a swept upload's leftover data
import worker, { ProjectRoom as Room, BlobVault as Vault } from "../src/worker.ts";
import { doSqlStorage } from "../src/storage.ts";
import { storageChecks } from "../../conformance/src/hosts/storage-checks.ts";
import { AUTH_HEADER, PROJECT_HEADER } from "../src/room.ts";
import { r2BlobStore } from "../src/blob-r2.ts";
import type { DurableObjectNamespace, DurableObjectState, DurableObjectStorage, ExecutionContext } from "../src/cf.ts";
import type { Env } from "../src/env.ts";

// BlobVault as deployed, over a storage that counts what it writes and reads: each statement's rowsWritten and rowsRead
// (Cloudflare bills both) and each setAlarm (billed as a row written too). Everything but the two routes above goes to
// it.
export class BlobVault {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;
  #vault: Vault;
  #cursors: { readonly rowsWritten: number; readonly rowsRead: number }[] = [];
  #rows = 0;
  #reads = 0;
  #alarmsSet = 0;
  #passes: number[] = [];
  #passReads: number[] = [];
  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    this.#vault = this.#make();
  }
  #make(): Vault {
    const st = this.#ctx.storage;
    const storage: DurableObjectStorage = {
      sql: {
        exec: <T,>(q: string, ...b: unknown[]) => {
          const c = st.sql.exec<T>(q, ...b);
          this.#cursors.push(c);
          return c;
        },
        get databaseSize() {
          return st.sql.databaseSize;
        },
      },
      transactionSync: (fn) => st.transactionSync(fn),
      getAlarm: () => st.getAlarm(),
      setAlarm: (t) => (this.#alarmsSet++, st.setAlarm(t)),
      deleteAlarm: () => st.deleteAlarm(),
    };
    return new Vault({ storage } as DurableObjectState, this.#env);
  }
  // a statement's rowsWritten is final once it has run; the vault runs each one within the event that made it
  #fold(): void {
    for (const c of this.#cursors) (this.#rows += c.rowsWritten), (this.#reads += c.rowsRead);
    this.#cursors = [];
  }
  async fetch(req: Request): Promise<Response> {
    this.#fold();
    const url = new URL(req.url);
    const sql = this.#ctx.storage.sql;
    const all = (q: string) => sql.exec<Record<string, unknown>>(q).toArray();
    if (url.pathname === "/__sweep") {
      const byId = (q: string) => Object.fromEntries(all(q).map((r) => [r.id, Number(r.n)]));
      const has = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'uploads'").length > 0;
      const out = {
        alarm: await this.#ctx.storage.getAlarm(),
        uploads: has ? all("SELECT * FROM uploads").map((r) => ({ id: r.id as string, touched: r.touched === undefined ? null : Number(r.touched) })) : [],
        parts: has ? byId("SELECT id, count(*) AS n FROM parts GROUP BY id") : {},
        chunks: has ? byId("SELECT id, count(*) AS n FROM part_chunks GROUP BY id") : {},
        rows: this.#rows,
        alarmsSet: this.#alarmsSet,
        passes: this.#passes,
        passReads: this.#passReads,
      };
      this.#rows = this.#alarmsSet = 0;
      this.#passes = [];
      this.#passReads = [];
      return Response.json(out);
    }
    if (url.pathname === "/__legacy") {
      for (const t of ["part_chunks", "parts", "uploads"]) sql.exec(`DROP TABLE IF EXISTS ${t}`);
      sql.exec("CREATE TABLE uploads (id TEXT PRIMARY KEY, key TEXT, ctype TEXT) WITHOUT ROWID");
      sql.exec("CREATE TABLE parts (id TEXT, n INTEGER, etag TEXT, size INTEGER, PRIMARY KEY (id, n)) WITHOUT ROWID");
      sql.exec("CREATE TABLE part_chunks (id TEXT, n INTEGER, c INTEGER, data BLOB, PRIMARY KEY (id, n, c)) WITHOUT ROWID");
      sql.exec("INSERT INTO uploads (id, key, ctype) VALUES ('legacy', ?, NULL)", url.searchParams.get("k"));
      sql.exec(`INSERT INTO parts (id, n, etag, size) VALUES ('legacy', 1, '"plegacy"', 3)`);
      sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES ('legacy', 1, 0, x'010203')");
      await this.#ctx.storage.deleteAlarm();
      this.#vault = this.#make(); // deployed anew: nothing of the old instance remains
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__first") {
      for (const t of ["part_chunks", "parts", "uploads", "vault_sweep"]) sql.exec(`DROP TABLE IF EXISTS ${t}`);
      sql.exec("CREATE TABLE uploads (id TEXT PRIMARY KEY, key TEXT, ctype TEXT, touched INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID");
      sql.exec("CREATE TABLE parts (id TEXT, n INTEGER, etag TEXT, size INTEGER, at INTEGER, PRIMARY KEY (id, n)) WITHOUT ROWID");
      sql.exec("CREATE TABLE part_chunks (id TEXT, n INTEGER, c INTEGER, data BLOB, PRIMARY KEY (id, n, c)) WITHOUT ROWID");
      const now = Date.now(), made = now - Number(url.searchParams.get("age"));
      // an upload made long ago whose last part is recent: that version took an upload's touch from its parts' `at`
      sql.exec("INSERT INTO uploads (id, key, ctype, touched) VALUES ('active', ?, NULL, ?)", url.searchParams.get("k"), made);
      sql.exec(`INSERT INTO parts (id, n, etag, size, at) VALUES ('active', 1, '"pactive"', 3, ?)`, now);
      sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES ('active', 1, 0, x'010203')");
      // what its sweep left of an upload whose row it had deleted
      sql.exec(`INSERT INTO parts (id, n, etag, size, at) VALUES ('leftover', 1, '"pleft"', 3, ?)`, made);
      sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES ('leftover', 1, 0, x'040506')");
      await this.#ctx.storage.deleteAlarm();
      this.#vault = this.#make();
      return new Response(null, { status: 204 });
    }
    return this.#vault.fetch(req);
  }
  async alarm(): Promise<void> {
    this.#fold();
    const before = this.#rows, read = this.#reads;
    await this.#vault.alarm();
    this.#fold();
    this.#passes.push(this.#rows - before);
    this.#passReads.push(this.#reads - read);
  }
}

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

// A CPU cutoff as Cloudflare's Free plan makes one (error 1102), for the writer's retry path (cf-proxy-path): while set
// (/__test/cpu-cutoff?parts=N, 0 to clear), a stream append of more than N parts is stopped partway, as the runtime
// stops a request over its CPU limit: its first R2 writes land, the rest never happen, and the client gets Cloudflare's
// answer, 503 "error code: 1102". `cutoffs` counts them.
let cutoffParts = 0, cutoffs = 0;
const APPEND = /^\/api\/projects\/[^/]+\/streams\/[^/]+\/append$/;
async function partsOf(req: Request): Promise<number> {
  const b = new Uint8Array(await req.clone().arrayBuffer());
  const n = new DataView(b.buffer, b.byteOffset).getUint32(0);
  const h = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n))) as { parts?: unknown[] };
  return h.parts?.length ?? 0;
}
/** env with R2 writes refused after the first `writes` of them (the request "cut off" there). */
function cutAfter(env: TestEnv, writes: number): TestEnv {
  if (!env.BLOBS) return env;
  let left = writes;
  const blobs = new Proxy(env.BLOBS, {
    get(t, k) {
      const v = Reflect.get(t, k, t) as unknown;
      if (k !== "put" || typeof v !== "function") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      return (...a: unknown[]) => (left-- > 0 ? (v as (...x: unknown[]) => unknown).apply(t, a) : Promise.reject(new Error("cut off")));
    },
  });
  return { ...env, BLOBS: blobs };
}

export default {
  async fetch(req: Request, env: TestEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__test/cpu-cutoff") {
      cutoffParts = Number(url.searchParams.get("parts") ?? 0);
      return Response.json({ parts: cutoffParts, cutoffs });
    }
    if (cutoffParts > 0 && req.method === "POST" && APPEND.test(url.pathname) && (await partsOf(req)) > cutoffParts) {
      cutoffs++;
      // the request runs until it is stopped: some of its writes land (3 R2 writes a part, so about one part's)
      await worker.fetch(req, cutAfter(env, 3), ctx).catch(() => {});
      return new Response("error code: 1102", { status: 503, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }
    if (url.pathname === "/__test/storage-checks") {
      const ns = env.STORAGE_PROBE;
      return ns.get(ns.idFromName(crypto.randomUUID())).fetch("https://probe/");
    }
    const v = /^\/__test\/vault\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (v) {
      if (!env.BLOB_VAULT) return new Response("no vault", { status: 404 });
      const init: RequestInit = { method: req.method };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
      return env.BLOB_VAULT.get(env.BLOB_VAULT.idFromName(decodeURIComponent(v[1]!))).fetch(`https://vault${v[2]}${url.search}`, init);
    }
    if (url.pathname === "/__test/r2-fixed-length") {
      if (!env.BLOBS) return new Response("no R2", { status: 404 });
      const store = r2BlobStore(env.BLOBS);
      const up = await store.createMultipart(`fixed-length/${crypto.randomUUID()}`);
      const SIZE = 64 * 1024;
      const body = (n: number) => new Blob([new Uint8Array(n).fill(7)]).stream();
      const outcome = async (n: number) => {
        try {
          await up.uploadPartStream!(1, body(n), SIZE);
          return "stored";
        } catch (e) {
          return `refused: ${(e as Error).message}`;
        }
      };
      const short = await outcome(SIZE - 100);
      const long = await outcome(SIZE + 100);
      const listed = (await up.listParts()).length;
      const whole = await outcome(SIZE); // the part's lock was released after each refusal: taken at once
      const parts = await up.listParts();
      const info = whole === "stored" ? await up.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag }))) : null;
      return Response.json({ short, long, listed, whole, size: info?.size ?? null });
    }
    if (url.pathname === "/__test/r2-lock") {
      if (!env.BLOBS) return new Response("no R2", { status: 404 });
      const n = String(url.searchParams.get("n")).padStart(5, "0");
      const lock = await env.BLOBS.head(`.carton-uploads/${url.searchParams.get("id")}/l${n}`);
      return Response.json(lock ? { state: lock.customMetadata?.state ?? null, at: Number(lock.customMetadata?.at ?? 0) } : null);
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
