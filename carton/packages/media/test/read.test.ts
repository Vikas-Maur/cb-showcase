import assert from "node:assert/strict";
import { test } from "node:test";
import { concatBytes, equalBytes } from "../src/bytes.ts";
import { MemoryLeafCache } from "../src/cache.ts";
import type { BlobStore } from "../src/contracts.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { mediaKey } from "../src/keys.ts";
import { LEAF_SIZE } from "../src/manifest.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { LeafMismatchError } from "../src/range-source.ts";
import { MediaReader, type ReaderEvent } from "../src/read.ts";
import { CountingMemoryStore, FaultyStore } from "../src/testing.ts";
import { uploadMedia } from "../src/upload.ts";
import { xorshiftBytes } from "./helpers.ts";

const MiB = LEAF_SIZE;

async function shared(size: number, seed = 1) {
  const data = xorshiftBytes(size, seed);
  const manifest = await hashSource(bytesSource(data), nodeHasher);
  const mem = new CountingMemoryStore();
  await uploadMedia({ store: mem, hasher: nodeHasher, source: bytesSource(data), manifest, partSize: 4 * MiB });
  mem.reads.length = 0;
  mem.counters.bytesDown = 0;
  return { data, hash: manifest.hash, mem };
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p.slice());
  return concatBytes(parts);
}

for (const streamChunk of [undefined, 64 * 1024]) {
  const how = streamChunk ? "streamed" : "whole responses";
  test(`read returns exactly the bytes asked for (${how})`, async () => {
    const { data, hash, mem } = await shared(5 * MiB + 777, 2);
    const store = new FaultyStore(mem, { streamChunk });
    const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache() });
    const ranges = [[0, 1], [0, data.length], [MiB - 3, 10], [2 * MiB, MiB], [5 * MiB + 700, 1000], [123456, 3 * MiB], [data.length - 1, 5], [data.length, 10]];
    for (const [o, l] of ranges) {
      const got = await collect(reader.read(hash, o, l));
      assert.ok(equalBytes(got, data.subarray(o, Math.min(data.length, o + l))), `range ${o}+${l}`);
    }
    assert.deepEqual(await reader.stat(hash), { size: data.length, contentType: undefined });
  });

  test(`a second read is served from the cache (${how})`, async () => {
    const { data, hash, mem } = await shared(3 * MiB, 3);
    const reader = new MediaReader({ store: new FaultyStore(mem, { streamChunk }), hasher: nodeHasher, cache: new MemoryLeafCache() });
    await collect(reader.read(hash, 0, data.length));
    const down = mem.counters.bytesDown;
    assert.ok(equalBytes(await collect(reader.read(hash, 100, 2 * MiB)), data.subarray(100, 100 + 2 * MiB)));
    assert.equal(mem.counters.bytesDown, down, "no bytes fetched again");
  });

  test(`a link drop mid-response is invisible to the reader (${how})`, async () => {
    const { data, hash, mem } = await shared(4 * MiB, 4);
    const store = new FaultyStore(mem, { streamChunk, dropReadAfterBytes: MiB + 5000 });
    // Without streaming, the cut shows up as a failed get: make that happen once.
    let failOnce = !streamChunk;
    const flaky: BlobStore = Object.assign(Object.create(null), store, {
      head: store.head.bind(store), put: store.put.bind(store), delete: store.delete.bind(store),
      createMultipart: store.createMultipart.bind(store), uploadPart: store.uploadPart.bind(store),
      completeMultipart: store.completeMultipart.bind(store), abortMultipart: store.abortMultipart.bind(store),
      getStream: store.getStream?.bind(store),
      get: async (...a: Parameters<BlobStore["get"]>) => {
        if (failOnce && a[1] && a[1].length > MiB) {
          failOnce = false;
          throw new Error("ECONNRESET");
        }
        return store.get(...a);
      },
    });
    const reader = new MediaReader({ store: flaky, hasher: nodeHasher, cache: new MemoryLeafCache(), retryDelayMs: 1 });
    assert.ok(equalBytes(await collect(reader.read(hash, 0, data.length)), data));
  });
}

test("whole responses: a corrupted leaf is repaired before any of it goes out", async () => {
  const { data, hash, mem } = await shared(4 * MiB, 5);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { corruptAt: { key: mediaKey(hash), offset: 2 * MiB + 99, times: 1 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
  assert.ok(equalBytes(await collect(reader.read(hash, 0, data.length)), data));
  assert.deepEqual(events.map((e) => [e.type, e.leaf]), [["mismatch", 2], ["repaired", 2]]);
});

test("streamed: a corrupted leaf stops the read after play-first bytes, and the retry gets repaired bytes", async () => {
  const { data, hash, mem } = await shared(4 * MiB, 6);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: MiB + 10, times: 1 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
  let handedOut = 0;
  await assert.rejects(async () => {
    for await (const p of reader.read(hash, 0, data.length)) handedOut += p.length;
  }, LeafMismatchError);
  assert.ok(handedOut > MiB, "bytes of the bad leaf went out before it completed (play first)");
  assert.deepEqual(events.map((e) => [e.type, e.leaf]), [["mismatch", 1], ["repaired", 1]]);
  const down = mem.counters.bytesDown;
  assert.ok(equalBytes(await collect(reader.read(hash, MiB, MiB)), data.subarray(MiB, 2 * MiB)));
  assert.equal(mem.counters.bytesDown, down, "the retry is served from the repaired, cached leaf");
});

test("a leaf that stays bad fails the read after the repair attempts", async () => {
  const { hash, mem } = await shared(2 * MiB, 7);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { corruptAt: { key: mediaKey(hash), offset: 5, times: 100 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 2, onEvent: (e) => events.push(e) });
  await assert.rejects(collect(reader.read(hash, 0, 10)), LeafMismatchError);
  assert.equal(events.at(-1)?.type, "repair-failed");
  await assert.rejects(reader.readVerified(hash, 0, 10), LeafMismatchError);
});

test("the first request is one leaf, then requests grow", async () => {
  const { data, hash, mem } = await shared(20 * MiB, 8);
  const reader = new MediaReader({ store: mem, hasher: nodeHasher, maxWindowLeaves: 8 });
  await collect(reader.read(hash, 0, data.length));
  const lens = mem.reads.filter((r) => r.key === mediaKey(hash)).map((r) => r.length / MiB);
  assert.deepEqual(lens, [1, 2, 4, 8, 5]);
});

test("readVerified and leaf() return verified bytes; stat knows unknown and half-uploaded media", async () => {
  const { data, hash, mem } = await shared(3 * MiB + 1, 9);
  const reader = new MediaReader({ store: mem, hasher: nodeHasher });
  assert.ok(equalBytes(await reader.readVerified(hash, MiB - 5, MiB + 10), data.subarray(MiB - 5, 2 * MiB + 5)));
  assert.equal(await reader.stat("a".repeat(64)), null);
  mem.objects.delete(mediaKey(hash));
  assert.equal(await new MediaReader({ store: mem, hasher: nodeHasher }).stat(hash), null, "manifest only: not readable yet");
});

test("offline: cached leaves are still served", async () => {
  const { data, hash, mem } = await shared(2 * MiB, 10);
  const cache = new MemoryLeafCache();
  await collect(new MediaReader({ store: mem, hasher: nodeHasher, cache }).read(hash, 0, data.length));
  const down: BlobStore = new Proxy(mem, { get: (t, k) => (typeof (t as any)[k] === "function" ? async () => { throw new Error("offline"); } : (t as any)[k]) });
  const reader = new MediaReader({ store: down, hasher: nodeHasher, cache, retries: 0 });
  assert.deepEqual(await reader.stat(hash), { size: data.length, contentType: undefined });
  assert.ok(equalBytes(await collect(reader.read(hash, 0, data.length)), data));
});

test("abort stops a read", async () => {
  const { hash, mem } = await shared(6 * MiB, 11);
  const ac = new AbortController();
  const reader = new MediaReader({ store: new FaultyStore(mem, { streamChunk: 32 * 1024 }), hasher: nodeHasher });
  await assert.rejects(async () => {
    let n = 0;
    for await (const p of reader.read(hash, 0, 6 * MiB, ac.signal)) if ((n += p.length) > MiB) ac.abort();
  }, { name: "AbortError" });
});
