import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { concatBytes, equalBytes } from "../src/bytes.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { LEAF_SIZE } from "../src/manifest.ts";
import { FsLeafCache, FsUploadStateStore } from "../src/node/fs-cache.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { MediaReader } from "../src/read.ts";
import { CountingMemoryStore, FaultyStore } from "../src/testing.ts";
import { uploadMedia } from "../src/upload.ts";
import { scratchDir, xorshiftBytes } from "./helpers.ts";

const MiB = LEAF_SIZE;
const s = scratchDir("fs-cache");
after(() => s.cleanup());

test("leaves and manifests survive a new cache object (a restart), and readers share them", async () => {
  const data = xorshiftBytes(3 * MiB + 10, 1);
  const m = await hashSource(bytesSource(data), nodeHasher);
  const mem = new CountingMemoryStore();
  await uploadMedia({ store: mem, hasher: nodeHasher, source: bytesSource(data), manifest: m });
  const dir = join(s.dir, "cache1");
  const r1 = new MediaReader({ store: mem, hasher: nodeHasher, cache: new FsLeafCache(dir) });
  const parts: Uint8Array[] = [];
  for await (const p of r1.read(m.hash, 0, data.length)) parts.push(p.slice());
  assert.ok(equalBytes(concatBytes(parts), data));
  const down = mem.counters.bytesDown;
  // A new process: nothing fetched again, even with the link down.
  const offline = new FaultyStore(mem, {});
  offline.get = async () => {
    throw new Error("offline");
  };
  const r2 = new MediaReader({ store: offline, hasher: nodeHasher, cache: new FsLeafCache(dir), retries: 0 });
  assert.ok(equalBytes(await r2.readVerified(m.hash, MiB - 1, 2 * MiB), data.subarray(MiB - 1, 3 * MiB - 1)));
  assert.equal(mem.counters.bytesDown, down);
  const leafDir = join(dir, m.hash.slice(0, 2), m.hash);
  assert.deepEqual(readdirSync(leafDir).sort(), ["0", "1", "2", "3", "manifest"], "no temporary files left");
});

test("over budget, the least recently used leaves go first", async () => {
  const dir = join(s.dir, "cache2");
  const cache = new FsLeafCache(dir, { maxBytes: 3 * MiB });
  const h = "ab".repeat(32);
  for (let i = 0; i < 3; i++) await cache.putLeaf(h, i, xorshiftBytes(MiB, i + 1));
  await cache.getLeaf(h, 0); // 0 is now the most recent
  await cache.putLeaf(h, 3, xorshiftBytes(MiB, 9));
  assert.equal(await cache.hasLeaf(h, 1), false, "leaf 1 was the least recently used");
  assert.equal(await cache.hasLeaf(h, 0), true);
  assert.equal(cache.bytes, 3 * MiB);
  // A fresh object learns the folder's contents and keeps enforcing the budget.
  const again = new FsLeafCache(dir, { maxBytes: 3 * MiB });
  await again.putLeaf(h, 4, xorshiftBytes(MiB, 10));
  assert.equal(again.bytes, 3 * MiB);
  await assert.rejects(cache.hasLeaf("../etc", 0), TypeError);
});

test("upload state persists across processes, and a damaged file reads as no state", async () => {
  const dir = join(s.dir, "uploads");
  const st = { v: 1 as const, key: `m/${"cd".repeat(32)}`, hash: "cd".repeat(32), size: 10, partSize: 8 * MiB, uploadId: "u1", parts: [{ partNumber: 1, etag: "e", size: 8 * MiB }] };
  await new FsUploadStateStore(dir).save(st);
  assert.deepEqual(await new FsUploadStateStore(dir).load(st.key), st);
  await new FsUploadStateStore(dir).delete(st.key);
  assert.equal(await new FsUploadStateStore(dir).load(st.key), null);
  assert.equal(existsSync(dir), true);
});
