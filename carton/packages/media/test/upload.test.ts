import assert from "node:assert/strict";
import { test } from "node:test";
import { equalBytes } from "../src/bytes.ts";
import type { BlobStore } from "../src/contracts.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { damagedKey, manifestKey, mediaKey } from "../src/keys.ts";
import { decodeManifest, LEAF_SIZE } from "../src/manifest.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { CountingMemoryStore, FaultyStore, LinkDroppedError } from "../src/testing.ts";
import { MediaReader } from "../src/read.ts";
import { LeafMismatchError } from "../src/range-source.ts";
import { cancelUpload, choosePartSize, MAX_PARTS, MemoryUploadStateStore, SourceChangedError, uploadMedia } from "../src/upload.ts";
import { xorshiftBytes } from "./helpers.ts";

const MiB = LEAF_SIZE;

async function setup(size: number, seed = 1) {
  const data = xorshiftBytes(size, seed);
  const manifest = await hashSource(bytesSource(data), nodeHasher);
  return { data, manifest, source: bytesSource(data) };
}

test("part size: 8 MiB when the link is slow or unknown, up to 64 MiB on fast links, never over 10,000 parts", () => {
  assert.equal(choosePartSize(1e9), 8 * MiB);
  assert.equal(choosePartSize(1e9, 1e6), 8 * MiB);
  assert.equal(choosePartSize(1e9, 5e6), 32 * MiB);
  assert.equal(choosePartSize(1e9, 100e6), 64 * MiB);
  const huge = 2e12;
  const p = choosePartSize(huge, 1e6);
  assert.ok(Math.ceil(huge / p) <= MAX_PARTS);
  assert.equal(p % MiB, 0);
});

test("a small file goes up in one put, with its manifest; the second upload is deduped", async () => {
  const { manifest, source, data } = await setup(3 * MiB + 5);
  const store = new CountingMemoryStore();
  const r1 = await uploadMedia({ store, hasher: nodeHasher, source, manifest });
  assert.equal(r1.deduped, false);
  assert.equal(r1.partsSent, 1);
  assert.ok(equalBytes(store.objects.get(mediaKey(manifest.hash))!, data));
  const mf = await decodeManifest(store.objects.get(manifestKey(manifest.hash))!, nodeHasher, manifest.hash);
  assert.equal(mf.size, data.length);
  const before = store.counters.bytesUp;
  const r2 = await uploadMedia({ store, hasher: nodeHasher, source, manifest });
  assert.equal(r2.deduped, true);
  assert.equal(store.counters.bytesUp, before, "dedup sends nothing");
});

test("multipart: equal parts, then a shorter last part, reassembled exactly", async () => {
  const { manifest, source, data } = await setup(10 * MiB + 123, 2);
  const store = new CountingMemoryStore();
  const r = await uploadMedia({ store, hasher: nodeHasher, source, manifest, partSize: 2 * MiB, concurrency: 3 });
  assert.equal(r.partsSent, 6);
  assert.equal(r.bytesSent, data.length);
  assert.ok(equalBytes(store.objects.get(mediaKey(manifest.hash))!, data));
  assert.equal(store.uploads.size, 0, "no open upload left behind");
});

for (const listParts of [true, false]) {
  test(`resume after a cut link re-sends only the lost part (${listParts ? "with" : "without"} listParts)`, async () => {
    const { manifest, source, data } = await setup(12 * MiB, 3);
    const mem = new CountingMemoryStore();
    // The link dies inside the 3rd part (parts of 2 MiB, one at a time).
    const store = new FaultyStore(mem, { dropUploadAfterBytes: 5 * MiB, noListParts: !listParts });
    const state = new MemoryUploadStateStore();
    const opts = { store, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 };
    await assert.rejects(uploadMedia(opts), LinkDroppedError);
    const saved = await state.load(mediaKey(manifest.hash));
    assert.equal(saved?.parts.length, 2, "two parts landed before the cut");
    const r = await uploadMedia(opts);
    assert.equal(r.resumedParts, 2);
    assert.equal(r.partsSent, 4);
    assert.equal(r.bytesSent, 8 * MiB, "the second session sends only the missing parts");
    assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
    assert.equal(await state.load(mediaKey(manifest.hash)), null, "state cleared once complete");
  });
}

test("retries inside one session ride out a dropped connection", async () => {
  const { manifest, source, data } = await setup(9 * MiB, 4);
  const mem = new CountingMemoryStore();
  const store = new FaultyStore(mem, { dropUploadAfterBytes: 3 * MiB, drops: 2 });
  const r = await uploadMedia({ store, hasher: nodeHasher, source, manifest, partSize: 2 * MiB, concurrency: 2, retries: 3, retryDelayMs: 1 });
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
  assert.ok(r.bytesSent > data.length && r.bytesSent <= data.length + 2 * 2 * 2 * MiB, `resent at most the parts in flight per drop: ${r.bytesSent}`);
});

test("bytes that changed on disk since hashing are never uploaded under the old hash", async () => {
  const { manifest, data } = await setup(6 * MiB, 5);
  const changed = data.slice();
  changed[4 * MiB + 10] ^= 1;
  const store = new CountingMemoryStore();
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source: bytesSource(changed), manifest, partSize: 2 * MiB, concurrency: 1 }), SourceChangedError);
  assert.equal(store.objects.has(mediaKey(manifest.hash)), false);
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source: bytesSource(data.subarray(1)), manifest }), SourceChangedError);
});

test("a saved upload with another part size starts over and aborts the old one", async () => {
  const { manifest, source } = await setup(8 * MiB, 6);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const store = new FaultyStore(mem, { dropUploadAfterBytes: 3 * MiB });
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 }));
  assert.equal(mem.uploads.size, 1);
  const r = await uploadMedia({ store, hasher: nodeHasher, source, manifest, state, partSize: 4 * MiB, concurrency: 1 });
  assert.equal(r.resumedParts, 0);
  assert.equal(mem.uploads.size, 0, "the 2 MiB upload was aborted");
});

test("cancelUpload drops the open upload and its state", async () => {
  const { manifest, source } = await setup(8 * MiB, 7);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const store = new FaultyStore(mem, { dropUploadAfterBytes: 3 * MiB });
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 }));
  await cancelUpload(mem, state, manifest.hash);
  assert.equal(mem.uploads.size, 0);
  assert.equal(await state.load(mediaKey(manifest.hash)), null);
});

test("abort stops the upload and keeps it resumable", async () => {
  const { manifest, source, data } = await setup(8 * MiB, 8);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const ac = new AbortController();
  let parts = 0;
  const p = uploadMedia({ store: mem, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, signal: ac.signal, onProgress: () => { if (++parts === 2) ac.abort(); } });
  await assert.rejects(p, { name: "AbortError" });
  const r = await uploadMedia({ store: mem, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1 });
  assert.ok(r.resumedParts >= 1);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
});

test("an upload the store forgot (expired) is started again instead of failing forever", async () => {
  const { manifest, source, data } = await setup(8 * MiB, 9);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const store = new FaultyStore(mem, { dropUploadAfterBytes: 3 * MiB, noListParts: true });
  const opts = { store, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 };
  await assert.rejects(uploadMedia(opts));
  mem.uploads.clear(); // the store expired it
  await assert.rejects(uploadMedia(opts), /NoSuchUpload/);
  assert.equal(await state.load(mediaKey(manifest.hash)), null, "the dead upload is forgotten");
  const r = await uploadMedia(opts);
  assert.equal(r.resumedParts, 0);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
});

test("a resume keeps the part size it started with, even when the link now measures faster", async () => {
  const { manifest, source, data } = await setup(40 * MiB, 10);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const store = new FaultyStore(mem, { dropUploadAfterBytes: 20 * MiB });
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source, manifest, state, bytesPerSecond: 1e6, concurrency: 1, retries: 0 }));
  const r = await uploadMedia({ store, hasher: nodeHasher, source, manifest, state, bytesPerSecond: 100e6, concurrency: 1 });
  assert.equal(r.partSize, 8 * MiB);
  assert.equal(r.resumedParts, 2);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
});

test("an open upload is dropped when someone else completed the same object", async () => {
  const { manifest, source } = await setup(8 * MiB, 11);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  await assert.rejects(uploadMedia({ store: new FaultyStore(mem, { dropUploadAfterBytes: 3 * MiB }), hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 }));
  await uploadMedia({ store: mem, hasher: nodeHasher, source, manifest, partSize: 2 * MiB }); // a teammate, no shared state
  assert.equal(mem.uploads.size, 1);
  const r = await uploadMedia({ store: mem, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB });
  assert.equal(r.deduped, true);
  assert.equal(mem.uploads.size, 0);
  assert.equal(await state.load(mediaKey(manifest.hash)), null);
});

test("two callers resuming the same upload both succeed (review round 1, finding 5)", async () => {
  const { manifest, source, data } = await setup(12 * MiB, 12);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  await assert.rejects(uploadMedia({ store: new FaultyStore(mem, { dropUploadAfterBytes: 5 * MiB }), hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 }));
  // Both resume from the same saved state; whichever completes second finds the upload gone.
  const o = { store: mem, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 };
  const [a, b] = await Promise.all([uploadMedia(o), uploadMedia(o)]);
  assert.ok(a.hash === manifest.hash && b.hash === manifest.hash);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
  assert.equal(await state.load(mediaKey(manifest.hash)), null);
});

test("two processes resuming one upload both succeed although part ETags change (review round 2, finding 5)", async () => {
  const { manifest, source, data } = await setup(12 * MiB, 13);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  await assert.rejects(uploadMedia({ store: new FaultyStore(mem, { dropUploadAfterBytes: 5 * MiB }), hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 }));
  // Two store objects over one backend, as two processes have: both send the missing parts, each ETag replacing the
  // other's, then both complete.
  const opts = (store: FaultyStore) => ({ store, hasher: nodeHasher, source, manifest, state, partSize: 2 * MiB, concurrency: 1, retries: 0 });
  const results = await Promise.allSettled([uploadMedia(opts(new FaultyStore(mem, {}))), uploadMedia(opts(new FaultyStore(mem, {})))]);
  assert.deepEqual(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")), ["ok", "ok"]);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
});

test("a caller waiting for its turn on the same object can still abort (review round 3, finding 1)", async () => {
  const { manifest, source } = await setup(12 * MiB, 14);
  const mem = new CountingMemoryStore();
  // The first upload stalls inside the store: its createMultipart never answers.
  let release!: () => void;
  const stall = new Promise<void>((r) => (release = r));
  const stalled = new FaultyStore(mem, {});
  const realCreate = stalled.createMultipart.bind(stalled);
  stalled.createMultipart = async (k, o) => (await stall, realCreate(k, o));
  const first = uploadMedia({ store: stalled, hasher: nodeHasher, source, manifest, partSize: 2 * MiB });
  const ac = new AbortController();
  const second = uploadMedia({ store: stalled, hasher: nodeHasher, source, manifest, partSize: 2 * MiB, signal: ac.signal });
  ac.abort();
  const outcome = await Promise.race([second.then(() => "resolved", (e) => (e as Error).name), new Promise((r) => setTimeout(() => r("pending"), 2000))]);
  assert.equal(outcome, "AbortError");
  // A third caller still waits for the first, which is still running.
  let thirdDone = false;
  const third = uploadMedia({ store: stalled, hasher: nodeHasher, source, manifest, partSize: 2 * MiB }).then((r) => ((thirdDone = true), r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(thirdDone, false, "serialization holds for later callers");
  release();
  await first;
  assert.equal((await third).deduped, true);
});

test("a completion with ETags another process replaced is recovered by listing them again (review round 3, suggestion)", async () => {
  const { manifest, source, data } = await setup(12 * MiB, 15);
  const mem = new CountingMemoryStore();
  const store = new FaultyStore(mem, {});
  // Just before this caller completes, "another process" sends every part again (new ETags) and does not complete.
  const wrapHandle = (u: Awaited<ReturnType<BlobStore["createMultipart"]>>) => {
    let first = true;
    return {
      ...u,
      key: u.key,
      uploadId: u.uploadId,
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        if (first) {
          first = false;
          const other = await mem.resumeMultipart(u.key, u.uploadId);
          for (let n = 1; n <= parts.length; n++) await other.uploadPart(n, data.subarray((n - 1) * 2 * MiB, n * 2 * MiB));
        }
        return u.complete(parts);
      },
    };
  };
  const create = store.createMultipart.bind(store);
  store.createMultipart = async (k, o) => wrapHandle(await create(k, o));
  const r = await uploadMedia({ store, hasher: nodeHasher, source, manifest, partSize: 2 * MiB, retryDelayMs: 1 });
  assert.equal(r.deduped, false);
  assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data));
});

test("an upload the store dropped mid-way costs at most the parts in flight: NoSuchUpload is never retried (S5-4)", async () => {
  const { manifest, source } = await setup(24 * MiB, 16);
  const mem = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  let partsSeen = 0;
  let sent = 0; // every attempt's bytes: over a network they go out before the store answers NoSuchUpload
  const store = new FaultyStore(mem, {});
  const create = store.createMultipart.bind(store);
  // The store drops the upload once its second part has landed (expired, or completed by another process).
  store.createMultipart = async (k, o) => {
    const u = await create(k, o);
    return {
      ...u,
      key: u.key,
      uploadId: u.uploadId,
      uploadPart: async (n: number, d: Uint8Array) => {
        sent += d.length;
        const r = await u.uploadPart(n, d);
        if (++partsSeen === 2) mem.uploads.clear();
        return r;
      },
    };
  };
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source, manifest, state, partSize: 4 * MiB, concurrency: 2, retries: 5, retryDelayMs: 1 }), /NoSuchUpload/);
  // 2 parts landed before the drop, at most 2 more were in flight: anything above that is retries into a dead upload.
  assert.ok(sent <= 4 * 4 * MiB + 64 * 1024, `${sent} bytes went up for an upload that died after 2 parts`);
  assert.equal(await state.load(mediaKey(manifest.hash)), null, "the dead upload is forgotten");
});

for (const size of [3 * MiB + 9, 10 * MiB + 9]) {
  test(`a damaged stored object is reported by a reader and replaced by the next upload (S5-5, ${size > 4 * MiB ? "multipart" : "one put"})`, async () => {
    const { manifest, source, data } = await setup(size, 17);
    const mem = new CountingMemoryStore();
    const o = { store: mem, hasher: nodeHasher, source, manifest, partSize: 4 * MiB };
    await uploadMedia(o);
    // Disk rot on the host: one byte of leaf 2 changes for good.
    mem.objects.get(mediaKey(manifest.hash))![2 * MiB + 5] ^= 0xff;
    const reader = new MediaReader({ store: mem, hasher: nodeHasher, repairAttempts: 2 });
    await assert.rejects(reader.readVerified(manifest.hash, 0, size), LeafMismatchError);
    assert.ok(mem.objects.has(damagedKey(manifest.hash)), "the reader reported it");
    const again = await uploadMedia(o);
    assert.equal(again.deduped, false, "not deduped on a damaged object");
    assert.ok(equalBytes(mem.objects.get(mediaKey(manifest.hash))!, data), "replaced byte for byte");
    assert.equal(mem.objects.has(damagedKey(manifest.hash)), false, "the report is cleared once replaced");
    const fresh = new MediaReader({ store: mem, hasher: nodeHasher });
    assert.ok(equalBytes(await fresh.readVerified(manifest.hash, 0, size), data), "a teammate reads it again");
    assert.equal((await uploadMedia(o)).deduped, true, "and the next upload dedups as usual");
  });
}

test("a part waiting to retry doesn't go up again once a sibling found the upload gone (S5-4, review round 2 suggestion)", async () => {
  const { manifest, source } = await setup(8 * MiB, 18);
  const mem = new CountingMemoryStore();
  const attempts = new Map<number, number>();
  const store = new FaultyStore(mem, {});
  const create = store.createMultipart.bind(store);
  store.createMultipart = async (k, o) => {
    const u = await create(k, o);
    return {
      ...u,
      key: u.key,
      uploadId: u.uploadId,
      uploadPart: async (n: number, d: Uint8Array) => {
        attempts.set(n, (attempts.get(n) ?? 0) + 1);
        if (n === 1 && attempts.get(1) === 1) throw new Error("ECONNRESET"); // part 1 backs off and will retry
        if (n === 2) mem.uploads.clear(); // meanwhile the store drops the upload: part 2 sees NoSuchUpload
        return u.uploadPart(n, d);
      },
    };
  };
  await assert.rejects(uploadMedia({ store, hasher: nodeHasher, source, manifest, partSize: 4 * MiB, concurrency: 2, retries: 3, retryDelayMs: 80 }), /NoSuchUpload/);
  await new Promise((r) => setTimeout(r, 300)); // past part 1's backoff
  assert.equal(attempts.get(1), 1, "part 1 was not sent again into the dead upload");
});
