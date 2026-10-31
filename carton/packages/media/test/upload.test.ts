import assert from "node:assert/strict";
import { test } from "node:test";
import { equalBytes } from "../src/bytes.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { manifestKey, mediaKey } from "../src/keys.ts";
import { decodeManifest, LEAF_SIZE } from "../src/manifest.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { CountingMemoryStore, FaultyStore, LinkDroppedError } from "../src/testing.ts";
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
