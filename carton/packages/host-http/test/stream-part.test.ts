// A part upload goes straight to a store that takes a stream (cf-lab): on a Worker, reading an 8 to 64 MiB part into a
// buffer cost 60 to 360 ms of CPU against the Free plan's 10, and Cloudflare killed such requests (error 1102) until a
// 1 GB upload could not finish. The route passes the body through when the store streams and the length is declared,
// and keeps every check it made on a buffered part.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BlobStore, MultipartUpload } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { handleHttp, type HttpDeps } from "../src/index.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const req = (path: string, init: RequestInit = {}) => new Request(`http://host${path}`, init);
const KEY = `m/${"c".repeat(64)}`;

/** A memory store whose uploads also take streams, counting which way each part came. */
function streamingStore() {
  const inner = createMemoryBlobStore();
  const calls = { stream: 0, buffered: 0, sizes: [] as number[] };
  const wrap = (u: MultipartUpload): MultipartUpload => ({
    key: u.key,
    uploadId: u.uploadId,
    uploadPart: (n, d) => (calls.buffered++, u.uploadPart(n, d)),
    async uploadPartStream(n, body, size) {
      calls.stream++;
      calls.sizes.push(size);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      assert.equal(bytes.byteLength, size, "the stream carries the declared length");
      return u.uploadPart(n, bytes);
    },
    listParts: () => u.listParts(),
    complete: (p) => u.complete(p),
    abort: () => u.abort(),
  });
  const store: BlobStore = Object.assign(Object.create(inner), {
    kind: "streaming-memory",
    createMultipart: async (k: string, o?: { contentType?: string }) => wrap(await inner.createMultipart(k, o)),
    resumeMultipart: async (k: string, id: string) => wrap(await inner.resumeMultipart(k, id)),
  });
  for (const m of ["put", "get", "head", "delete", "list"] as const) (store as unknown as Record<string, unknown>)[m] = (inner[m] as (...a: unknown[]) => unknown).bind(inner);
  return { store, calls, inner };
}

async function setup(over: Partial<HttpDeps> = {}, scoped = false) {
  const s = streamingStore();
  const store = scoped ? scopedBlobStore(s.store, "projects/p/media/") : s.store;
  const d: HttpDeps = { auth: createHmacAuth({ secret: SECRET }), secret: SECRET, blobsFor: () => store, upgrade: async () => new Response(null, { status: 500 }), ...over };
  const tok = await d.auth.issue!({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
  const auth = { authorization: `Bearer ${tok}` };
  const up = (await (await handleHttp(req("/api/projects/p/uploads", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) }), d))!.json()) as { uploadId: string };
  const put = (n: number, bytes: Uint8Array, declare = true) =>
    handleHttp(req(`/api/projects/p/uploads/${up.uploadId}/${n}?key=${KEY}`, { method: "PUT", headers: { ...auth, ...(declare ? { "content-length": String(bytes.byteLength) } : {}) }, body: bytes as Uint8Array<ArrayBuffer> }), d);
  return { ...s, d, auth, up, put };
}

test("a part with a declared length streams to a store that takes streams, and the object is whole", async () => {
  for (const scoped of [false, true]) {
    const { calls, auth, up, put, d, inner } = await setup({}, scoped);
    const a = new Uint8Array(5 << 20).fill(1), b = new Uint8Array(1000).fill(2);
    const r1 = await put(1, a), r2 = await put(2, b);
    assert.equal(r1?.status, 200);
    assert.equal(r2?.status, 200);
    assert.deepEqual({ stream: calls.stream, buffered: calls.buffered }, { stream: 2, buffered: 0 }, `scoped ${scoped}: every part streamed`);
    assert.deepEqual(calls.sizes, [5 << 20, 1000]);
    const parts = [(await r1!.json()) as { partNumber: number; etag: string }, (await r2!.json()) as { partNumber: number; etag: string }];
    const done = await handleHttp(req(`/api/projects/p/uploads/${up.uploadId}/complete?key=${KEY}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ parts }) }), d);
    assert.equal(done?.status, 200);
    const got = await inner.get(scoped ? `projects/p/media/${KEY}` : KEY);
    assert.equal(got?.byteLength, (5 << 20) + 1000);
    assert.equal(got![0], 1);
    assert.equal(got![(5 << 20) + 999], 2);
  }
});

test("without a declared length the part is read as before (buffered)", async () => {
  const { calls, put } = await setup();
  const r = await put(1, new Uint8Array(4096).fill(3), false);
  assert.equal(r?.status, 200);
  assert.deepEqual({ stream: calls.stream, buffered: calls.buffered }, { stream: 0, buffered: 1 });
});

test("the streamed path keeps the size checks: a part over the body cap, and a file over the host's upload cap", async () => {
  const big = await setup({ maxBodyBytes: 1000 });
  assert.equal((await big.put(1, new Uint8Array(1001)))?.status, 413);
  assert.equal(big.calls.stream + big.calls.buffered, 0, "nothing was stored");
  const capped = await setup({ maxUploadBytes: 10_000 });
  const r = await capped.put(3, new Uint8Array(4000)); // part 3 of 4,000-byte parts: at least 12,000 bytes
  assert.equal(r?.status, 413);
  assert.equal(capped.calls.stream, 0);
});
