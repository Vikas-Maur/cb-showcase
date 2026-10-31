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
    const flaky: BlobStore = {
      kind: "flaky",
      head: (k) => store.head(k),
      put: (k, d, o) => store.put(k, d, o),
      delete: (k) => store.delete(k),
      list: (p, o) => store.list(p, o),
      createMultipart: (k, o) => store.createMultipart(k, o),
      resumeMultipart: (k, u) => store.resumeMultipart(k, u),
      getStream: store.getStream,
      get: async (k, r) => {
        if (failOnce && r?.length !== undefined && r.length > MiB) {
          failOnce = false;
          throw new Error("ECONNRESET");
        }
        return store.get(k, r);
      },
    };
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
  assert.deepEqual(events.map((e) => [e.type, e.leaf]), [["mismatch", 1], ["repaired", 1], ["served-bad", 1]]);
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

test("toolSource hands out verified leaves only: a corrupted leaf is repaired, never streamed", async () => {
  const { data, hash, mem } = await shared(4 * MiB + 9, 12);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: 2 * MiB + 1, times: 1 } });
  const tools = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) }).toolSource();
  const pieces: Uint8Array[] = [];
  for await (const p of tools.read(hash, 100, data.length)) pieces.push(p.slice());
  assert.ok(equalBytes(concatBytes(pieces), data.subarray(100)));
  assert.equal(pieces[0].length, MiB - 100, "the first piece is the rest of a whole, verified leaf");
  assert.deepEqual(events.map((e) => [e.type, e.leaf, e.handedOut]), [["mismatch", 2, false], ["repaired", 2, undefined]]);
});

test("play-first mismatch events say whether bytes of the bad leaf already went out", async () => {
  const { hash, mem } = await shared(2 * MiB, 13);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: 10, times: 1 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
  await assert.rejects(collect(reader.read(hash, 0, 2 * MiB)), LeafMismatchError);
  assert.equal(events[0].handedOut, true);
});

test("the memory cache keeps its own copy of a leaf handed in as a Node Buffer view", async () => {
  const cache = new MemoryLeafCache();
  const parent = Buffer.alloc(4 * MiB, 7);
  const leaf = parent.subarray(MiB, 2 * MiB);
  await cache.putLeaf("a".repeat(64), 1, leaf);
  const got = (await cache.getLeaf("a".repeat(64), 1))!;
  assert.equal(got.buffer.byteLength, MiB, "the 4 MiB parent is not pinned");
  parent.fill(0);
  assert.equal(got[0], 7, "and later writes to the parent don't reach the cache");
});

test("a play-first read never ends on unverified bytes, even when the reader stops at the last byte", async () => {
  const { data, hash, mem } = await shared(2 * MiB, 14);
  for (const corruptAt of [MiB + 100, MiB + 900_000]) {
    const events: ReaderEvent[] = [];
    // The range ends inside leaf 1; the corruption is before the end (handed out) or after it (never asked for).
    const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: corruptAt, times: 1 } });
    const reader = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
    const want = MiB + 500_000;
    const got: Uint8Array[] = [];
    let n = 0;
    let error: unknown;
    try {
      // Like an HTTP server: stop pulling as soon as the asked-for bytes are in.
      for await (const p of reader.read(hash, 0, want)) {
        got.push(p.slice());
        if ((n += p.length) === want) break;
      }
    } catch (e) {
      error = e;
    }
    assert.ok(events.some((e) => e.type === "mismatch" && e.leaf === 1), `leaf 1 was checked (corrupt at ${corruptAt})`);
    if (corruptAt < want) {
      assert.ok(error instanceof LeafMismatchError, "a bad byte went out: the read fails");
      assert.ok(events.some((e) => e.type === "served-bad"));
    } else {
      assert.equal(error, undefined);
      assert.ok(equalBytes(concatBytes(got), data.subarray(0, want)), "nothing bad went out: the read completes, repaired");
      assert.equal(events.some((e) => e.type === "served-bad"), false);
    }
  }
});

test("abort ends a read that is waiting on a stalled store stream", async () => {
  const { hash, mem } = await shared(2 * MiB, 15);
  const stalled: BlobStore = {
    kind: "stalled",
    head: (k) => mem.head(k),
    get: (k, r) => mem.get(k, r),
    list: (p) => mem.list(p),
    put: (k, d, o) => mem.put(k, d, o),
    delete: (k) => mem.delete(k),
    createMultipart: (k) => mem.createMultipart(k),
    resumeMultipart: (k, u) => mem.resumeMultipart(k, u),
    // Sends 1 KiB, then nothing ever again.
    getStream: async () => new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(1024)), pull: () => new Promise(() => {}) }),
  };
  const ac = new AbortController();
  const reader = new MediaReader({ store: stalled, hasher: nodeHasher });
  const it = reader.read(hash, 0, 2 * MiB, ac.signal)[Symbol.asyncIterator]();
  await it.next(); // the first KiB
  const pending = it.next();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});

test("a failed repair after unverified bytes went out still tells the player (review round 2, finding 1)", async () => {
  const { hash, mem } = await shared(2 * MiB, 16);
  const events: ReaderEvent[] = [];
  const store = new FaultyStore(mem, { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(hash), offset: 20, times: 1000 } });
  const reader = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 2, onEvent: (e) => events.push(e) });
  await assert.rejects(collect(reader.read(hash, 0, 2 * MiB)), LeafMismatchError);
  assert.deepEqual(events.map((e) => e.type), ["mismatch", "mismatch", "mismatch", "repair-failed", "served-bad"]);
});

test("abort between the body arriving and the reader taking it still ends the read (review round 2, finding 2)", async () => {
  const { hash, mem } = await shared(2 * MiB, 17);
  // The gap is a few microtasks wide, so abort at every depth from 0 to 12 microtasks after the body resolves.
  for (let depth = 0; depth <= 12; depth++) {
    const ac = new AbortController();
    const stalled: BlobStore = {
      kind: "stalled",
      head: (k) => mem.head(k),
      get: (k, r) => mem.get(k, r),
      list: (p) => mem.list(p),
      put: (k, d, o) => mem.put(k, d, o),
      delete: (k) => mem.delete(k),
      createMultipart: (k) => mem.createMultipart(k),
      resumeMultipart: (k, u) => mem.resumeMultipart(k, u),
      // A body that resolves at once and then never sends a byte.
      getStream: async () => {
        let p = Promise.resolve();
        for (let i = 0; i < depth; i++) p = p.then(() => {});
        void p.then(() => ac.abort());
        return new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
      },
    };
    const reader = new MediaReader({ store: stalled, hasher: nodeHasher });
    const done = collect(reader.read(hash, 0, MiB, ac.signal)).then(() => "resolved", (e) => (e as Error).name);
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    assert.equal(outcome, "AbortError", `abort ${depth} microtasks after the body`);
  }
});

test("stat's wait on a store that never answers ends with the caller's abort (CI fix #9 review)", async () => {
  const { hash, mem } = await shared(MiB, 18);
  const never: BlobStore = {
    kind: "never",
    head: () => new Promise(() => {}),
    get: (k, r) => mem.get(k, r),
    list: (p) => mem.list(p),
    put: (k, d, o) => mem.put(k, d, o),
    delete: (k) => mem.delete(k),
    createMultipart: (k) => mem.createMultipart(k),
    resumeMultipart: (k, u) => mem.resumeMultipart(k, u),
  };
  const reader = new MediaReader({ store: never, hasher: nodeHasher, cache: new MemoryLeafCache() });
  const ac = new AbortController();
  const p = reader.toolSource().stat(hash, ac.signal);
  setTimeout(() => ac.abort(), 20);
  const outcome = await Promise.race([p.then(() => "resolved", (e) => (e as Error).name), new Promise((r) => setTimeout(() => r("hung"), 3000))]);
  assert.equal(outcome, "AbortError");
});

test("an abort just as stat asks the store leaves no unhandled rejection behind (CI fix #9 review round 2)", async () => {
  const { hash, mem } = await shared(MiB, 19);
  const cache = new MemoryLeafCache();
  await new MediaReader({ store: mem, hasher: nodeHasher, cache }).manifest(hash); // cached: stat's manifest step is quick
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    // head() fails a little later (the link drops); the caller aborts right before stat gets to it.
    const failing: BlobStore = {
      kind: "failing-head",
      head: () => new Promise((_, reject) => setTimeout(() => reject(new Error("ECONNRESET")), 20)),
      get: (k, r) => mem.get(k, r),
      list: (p) => mem.list(p),
      put: (k, d, o) => mem.put(k, d, o),
      delete: (k) => mem.delete(k),
      createMultipart: (k) => mem.createMultipart(k),
      resumeMultipart: (k, u) => mem.resumeMultipart(k, u),
    };
    for (let depth = 0; depth <= 6; depth++) {
      const ac = new AbortController();
      const reader = new MediaReader({ store: failing, hasher: nodeHasher, cache });
      let p = Promise.resolve();
      for (let i = 0; i < depth; i++) p = p.then(() => {});
      void p.then(() => ac.abort());
      await reader.stat(hash, ac.signal).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60)); // every head() has rejected by now
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
