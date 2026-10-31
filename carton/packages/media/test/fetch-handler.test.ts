import assert from "node:assert/strict";
import { test } from "node:test";
import { equalBytes } from "../src/bytes.ts";
import { MemoryLeafCache } from "../src/cache.ts";
import { serveMedia } from "../src/fetch-handler.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { mediaKey } from "../src/keys.ts";
import { LEAF_SIZE } from "../src/manifest.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import type { RangeSource } from "../src/range-source.ts";
import { MediaReader } from "../src/read.ts";
import { CountingMemoryStore, FaultyStore } from "../src/testing.ts";
import { uploadMedia } from "../src/upload.ts";
import { xorshiftBytes } from "./helpers.ts";

const MiB = LEAF_SIZE;

async function setup(size = 3 * MiB + 5) {
  const data = xorshiftBytes(size, 21);
  const manifest = await hashSource(bytesSource(data), nodeHasher);
  const mem = new CountingMemoryStore();
  await uploadMedia({ store: mem, hasher: nodeHasher, source: bytesSource(data), manifest });
  return { data, hash: manifest.hash, mem };
}
const req = (range?: string, method = "GET", signal?: AbortSignal) =>
  new Request("cardboard-media://media/x", { method, headers: range ? { range } : {}, signal });

test("serves whole bodies, ranges, HEAD, and 416 like an HTTP server", async () => {
  const { data, hash, mem } = await setup();
  const reader = new MediaReader({ store: mem, hasher: nodeHasher, cache: new MemoryLeafCache(), contentType: () => "video/mp4" });
  const full = await serveMedia(reader, hash, req());
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.ok(equalBytes(new Uint8Array(await full.arrayBuffer()), data));
  const part = await serveMedia(reader, hash, req(`bytes=${MiB - 2}-${MiB + 9}`));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes ${MiB - 2}-${MiB + 9}/${data.length}`);
  assert.equal(part.headers.get("content-length"), "12");
  assert.ok(equalBytes(new Uint8Array(await part.arrayBuffer()), data.subarray(MiB - 2, MiB + 10)));
  const tail = await serveMedia(reader, hash, req("bytes=-4"));
  assert.ok(equalBytes(new Uint8Array(await tail.arrayBuffer()), data.subarray(data.length - 4)));
  const head = await serveMedia(reader, hash, req("bytes=0-0", "HEAD"));
  assert.equal(head.status, 200, "Range applies to GET only");
  assert.equal(head.headers.get("content-length"), String(data.length));
  assert.equal(head.body, null);
  assert.equal(head.headers.get("etag"), `"${hash}"`);
  const bad = await serveMedia(reader, hash, req(`bytes=${data.length}-`));
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), `bytes */${data.length}`);
  assert.equal((await serveMedia(reader, "f".repeat(64), req())).status, 404);
  assert.equal((await serveMedia(reader, hash, req(undefined, "POST"))).status, 405);
});

test("a bad leaf errors the body after play-first bytes; the retry is good", async () => {
  const { data, hash, mem } = await setup();
  const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: 5, times: 1 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache() });
  const r = await serveMedia(reader, hash, req());
  await assert.rejects(r.arrayBuffer());
  const again = await serveMedia(reader, hash, req());
  assert.ok(equalBytes(new Uint8Array(await again.arrayBuffer()), data));
});

test("cancelling the body, or aborting the request, stops the source read", async () => {
  let stopped = 0;
  let pulled = 0;
  const source: RangeSource = {
    stat: async () => ({ size: 100 * MiB }),
    async *read(_h, _o, _l, signal) {
      try {
        for (let i = 0; i < 100; i++) {
          signal?.throwIfAborted();
          pulled++;
          yield new Uint8Array(MiB);
        }
      } finally {
        stopped++;
      }
    },
  };
  const r = await serveMedia(source, "a".repeat(64), req());
  const rd = r.body!.getReader();
  await rd.read();
  await rd.cancel();
  assert.equal(stopped, 1);
  assert.ok(pulled < 5, `pulled lazily: ${pulled}`);
  const ac = new AbortController();
  const r2 = await serveMedia(source, "a".repeat(64), req(undefined, "GET", ac.signal));
  const rd2 = r2.body!.getReader();
  await rd2.read();
  ac.abort();
  await assert.rejects(async () => {
    for (;;) if ((await rd2.read()).done) break;
  });
});
