// A proxy stream's append under the deployment's daily write cap (cf-proxy-path on cf-hardening): the append reserves
// once for all its writes; refused, nothing is written, the Worker answers 429 with the wait, and the writer keeps the
// batch and sends it again after the reset, so the stream comes out whole. The real cap and counter SQL, the real
// routes and client, a clock moved across midnight UTC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { createHmacAuth } from "@carton/server";
import { handleHttp, type HttpDeps } from "@carton/host-http";
import { hostMediaBlobs } from "@carton/host-http/client";
import { MediaReader, MemoryLeafCache, ProxyStreamReader, ProxyStreamWriter, webCryptoHasher } from "@carton/media";
import { cappedBlobStore, prepaidCap, reserveIn, writeCapOf, writeCapResponse, WriteCapError, WRITE_CAP_PATH } from "../src/write-cap.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";

const sqlOf = (db: DatabaseSync) => ({
  exec: (q: string, ...b: unknown[]) => {
    const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
    return { toArray: () => rows };
  },
});
function counterRooms() {
  const rooms = new Map<string, DatabaseSync>();
  const ns: DurableObjectNamespace = {
    idFromName: (n) => n,
    get: (id) => ({
      async fetch(input: Request | string) {
        const req = input as Request;
        assert.equal(new URL(req.url).pathname, WRITE_CAP_PATH);
        const name = String(id);
        if (!rooms.has(name)) rooms.set(name, new DatabaseSync(":memory:"));
        return Response.json(reserveIn(sqlOf(rooms.get(name)!), (await req.json()) as never));
      },
    }),
  };
  return { ns };
}

const SECRET = "test-only-secret-test-only-secret-0123";
const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7 + (i >> 8)) & 0xff);

test("an append the daily cap refuses writes nothing, answers 429 with the wait, and goes again whole after the reset", async () => {
  let now = Date.UTC(2026, 10, 2, 23, 59, 59, 500);
  const { ns } = counterRooms();
  const cap = writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_OPS_PER_DAY: "100" }, { now: () => now })!;
  await cap.reserve(0, 97); // the day's other writes: three operations left
  const store = createMemoryBlobStore();
  const auth = createHmacAuth({ secret: SECRET });
  let reservations = 0;
  const deps: HttpDeps = {
    auth,
    secret: SECRET,
    blobsFor: () => cappedBlobStore(store, cap),
    blobsForWrites: async (_p, bytes, ops) => (reservations++, cappedBlobStore(store, await prepaidCap(cap, bytes, ops))),
    upgrade: async () => new Response(null, { status: 500 }),
  };
  // the Worker's answer to a refused write (worker.ts)
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    try {
      return (await handleHttp(new Request(url, init), deps)) ?? new Response(null, { status: 404 });
    } catch (e) {
      if (e instanceof WriteCapError) return writeCapResponse(e);
      throw e;
    }
  }) as typeof globalThis.fetch;
  const token = await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
  const media = hostMediaBlobs({ origin: "http://host", projectId: "p", token, fetch });
  const waits: number[] = [];
  const w = new ProxyStreamWriter({
    store: media,
    hasher: webCryptoHasher(),
    writeLimitJitterMs: 0,
    onWriteLimit: (until) => {
      waits.push(until - Date.now());
      now = Date.UTC(2026, 10, 3, 0, 0, 1); // the reset passes while the writer waits
    },
  });
  const segs = [fill(90_000, 1), fill(80_000, 2), fill(70_000, 3)];
  await w.init(fill(700, 9));
  // the first frame's batch (init and segment 0: six writes) is refused; nothing of it is stored
  await w.segment(segs[0]!, 2);
  for (let i = 0; i < 50 && waits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(waits.length, 1, "told of the limit");
  assert.ok(waits[0]! > 0 && waits[0]! <= 1000, `waits until the reset (${waits[0]} ms)`);
  assert.deepEqual((await store.list("")).blobs, [], "the refused append wrote nothing");
  for (const s of segs.slice(1)) await w.segment(s, 2);
  await w.end();
  assert.equal(w.segments, 3);
  // the stream reads back whole
  const r = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: webCryptoHasher(), cache: new MemoryLeafCache() }), id: w.id });
  const got: Uint8Array[] = [];
  for await (const p of r.play()) if (p.part === "segment") got.push(p.bytes);
  assert.deepEqual(got, segs);
  assert.ok(reservations >= 2, "one reservation per append");
});
