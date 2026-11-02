// The deployment's daily write cap (src/write-cap.ts): the counter on real SQLite (node:sqlite, the same SQL a
// ProjectRoom runs), the cap wrapped around a real blob store, and the Worker's 429.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { cappedBlobStore, prepaidCap, reserveIn, writeCapOf, writeCapResponse, WriteCapError, WRITE_CAP_PATH } from "../src/write-cap.ts";
import { mediaBlobs, mediaBlobsForWrites } from "../src/room.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";

// DO SQL's shape over node:sqlite: exec runs at once, as ctx.storage.sql.exec does
const sqlOf = (db: DatabaseSync) => ({
  exec: (q: string, ...b: unknown[]) => {
    const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
    return { toArray: () => rows };
  },
});

/** A namespace whose rooms are SQLite databases answering the counter's route, as ProjectRoom.fetch does. */
function counterRooms() {
  const rooms = new Map<string, DatabaseSync>();
  const calls: string[] = [];
  const ns: DurableObjectNamespace = {
    idFromName: (n) => n,
    get: (id) => ({
      async fetch(input: Request | string) {
        const req = input as Request;
        const name = String(id);
        calls.push(name);
        assert.equal(new URL(req.url).pathname, WRITE_CAP_PATH);
        if (!rooms.has(name)) rooms.set(name, new DatabaseSync(":memory:"));
        return Response.json(reserveIn(sqlOf(rooms.get(name)!), (await req.json()) as never));
      },
    }),
  };
  return { ns, rooms, calls };
}

test("no cap configured: the store is returned as it is", () => {
  const inner = createMemoryBlobStore();
  assert.equal(cappedBlobStore(inner, writeCapOf({ PROJECT_ROOM: counterRooms().ns })), inner);
  assert.equal(writeCapOf({ PROJECT_ROOM: counterRooms().ns, WRITE_CAP_BYTES_PER_DAY: "0", WRITE_CAP_OPS_PER_DAY: "x" }), undefined);
});

test("bytes over the daily cap are refused before anything is stored; reads and deletes go on", async () => {
  const { ns, calls } = counterRooms();
  const inner = createMemoryBlobStore();
  const store = cappedBlobStore(inner, writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_BYTES_PER_DAY: "10" }));
  await store.put("a", new Uint8Array(6));
  await assert.rejects(store.put("b", new Uint8Array(6)), (e: unknown) => e instanceof WriteCapError && e.code === "DailyWriteCap" && e.retryAfterSec > 0 && e.retryAfterSec <= 86_400);
  assert.equal(await inner.head("b"), null, "the refused put stored nothing");
  // a refused reservation reserved nothing: 4 bytes still fit
  await store.put("c", new Uint8Array(4));
  assert.equal((await store.get("a"))?.byteLength, 6);
  await store.delete("a");
  assert.equal(await inner.head("a"), null);
  assert.ok(calls.every((n) => /^write-cap\/\d{4}-\d{2}-\d{2}$/.test(n)), `one counter room per UTC day: ${calls}`);
  assert.equal(new Set(calls).size, 1);
});

test("multipart: each part reserves its bytes, create and complete one operation each, and the ops cap holds", async () => {
  const { ns, rooms } = counterRooms();
  const inner = createMemoryBlobStore();
  const store = cappedBlobStore(inner, writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_BYTES_PER_DAY: String(20 << 20), WRITE_CAP_OPS_PER_DAY: "4" }));
  const up = await store.createMultipart("big"); // op 1
  const p1 = await up.uploadPart(1, new Uint8Array(5 << 20)); // op 2
  // a resumed handle is capped too
  const again = await store.resumeMultipart("big", up.uploadId);
  const p2 = await again.uploadPart(2, new Uint8Array(1 << 20)); // op 3
  assert.deepEqual((await again.listParts()).map((p) => p.partNumber), [1, 2]);
  const info = await again.complete([p1, p2]); // op 4
  assert.equal(info.size, 6 << 20);
  await assert.rejects(store.put("one-more", new Uint8Array(1)), WriteCapError);
  const [db] = [...rooms.values()];
  assert.deepEqual({ ...db!.prepare("SELECT bytes, ops FROM carton_write_cap").get() }, { bytes: 6 << 20, ops: 4 });
});

test("whatever else the store offers passes through, bound to the store", async () => {
  const { ns } = counterRooms();
  // a store whose methods use private fields, as R2BlobStore's and DoBlobStore's do
  const mem = createMemoryBlobStore();
  class Private {
    readonly kind = "private";
    #n = 0;
    count() {
      return ++this.#n;
    }
    put(...a: Parameters<typeof mem.put>) {
      this.#n++;
      return mem.put(...a);
    }
  }
  const inner = new Private() as unknown as Parameters<typeof cappedBlobStore>[0] & { count(): number };
  const store = cappedBlobStore(inner, writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_OPS_PER_DAY: "5" })) as typeof inner;
  await store.put("k", new Uint8Array(1));
  assert.equal(store.kind, "private");
  assert.equal(store.count(), 2, "methods using a private field still work through the wrapper, put included");
});

test("the Worker answers a refused write 429 with Retry-After and the code", async () => {
  const e = new WriteCapError("full", 123);
  const r = writeCapResponse(e);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "123");
  // the wait in the body too: when (retryAt) and how long (retryAfterMs, whatever the client's clock says)
  assert.deepEqual(await r.json(), { error: "full", code: "DailyWriteCap", retryAt: e.retryAt, retryAfterMs: 123_000 });
});

test("a streamed part reserves its declared size before the store sees it", async () => {
  const { ns, rooms } = counterRooms();
  const got: number[] = [];
  const inner = createMemoryBlobStore();
  const streaming = Object.assign(Object.create(inner), {
    createMultipart: async (k: string) => {
      const u = await inner.createMultipart(k);
      return { ...u, key: u.key, uploadId: u.uploadId, uploadPart: u.uploadPart.bind(u), listParts: u.listParts.bind(u), complete: u.complete.bind(u), abort: u.abort.bind(u), uploadPartStream: async (n: number, body: ReadableStream<Uint8Array>, size: number) => (got.push(size), u.uploadPart(n, new Uint8Array(await new Response(body).arrayBuffer()))) };
    },
  });
  const store = cappedBlobStore(streaming, writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_BYTES_PER_DAY: String(6 << 20) }));
  const up = (await store.createMultipart("s")) as Awaited<ReturnType<typeof store.createMultipart>> & { uploadPartStream?: (n: number, b: ReadableStream<Uint8Array>, s: number) => Promise<unknown> };
  assert.ok(up.uploadPartStream, "the capped handle still takes streams");
  await up.uploadPartStream!(1, new Blob([new Uint8Array(5 << 20)]).stream(), 5 << 20);
  await assert.rejects(up.uploadPartStream!(2, new Blob([new Uint8Array(2 << 20)]).stream(), 2 << 20), WriteCapError);
  assert.deepEqual(got, [5 << 20], "the refused part never reached the store");
  const [db] = [...rooms.values()];
  assert.equal((db!.prepare("SELECT bytes FROM carton_write_cap").get() as { bytes: number }).bytes, 5 << 20);
});

test("a prepaid reservation: one counter request for a request's writes; past it, each write reserves again; over the cap, nothing is reserved (cf-proxy-path)", async () => {
  const { ns, calls } = counterRooms();
  const cap = writeCapOf({ PROJECT_ROOM: ns, WRITE_CAP_BYTES_PER_DAY: "1000", WRITE_CAP_OPS_PER_DAY: "10" })!;
  const pre = await prepaidCap(cap, 300, 3);
  assert.equal(calls.length, 1, "reserved up front");
  const store = cappedBlobStore(createMemoryBlobStore(), pre);
  await store.put("a", new Uint8Array(100));
  await store.put("b", new Uint8Array(100));
  await store.put("c", new Uint8Array(100));
  assert.equal(calls.length, 1, "the three writes drew on it");
  await store.put("d", new Uint8Array(10));
  assert.equal(calls.length, 2, "past it: reserved on its own");
  await assert.rejects(prepaidCap(cap, 700, 1), WriteCapError, "over the bytes cap");
  await assert.rejects(prepaidCap(cap, 1, 7), WriteCapError, "over the ops cap");
  // what was refused reserved nothing: what's left still fits
  await prepaidCap(cap, 590, 5);
});

test("mediaBlobsForWrites: no blob binding, no store (and no reservation)", async () => {
  const { ns, calls } = counterRooms();
  const env = { PROJECT_ROOM: ns, WRITE_CAP_BYTES_PER_DAY: "100000", AUTH_SECRET: "x".repeat(32) } as unknown as Parameters<typeof mediaBlobsForWrites>[0];
  assert.equal(mediaBlobs(env, "p"), undefined);
  assert.equal(await mediaBlobsForWrites(env, "p", 10, 2), undefined);
  assert.equal(calls.length, 1, "the reservation is made before the store (a refused one stores nothing)");
});
