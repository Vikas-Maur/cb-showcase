import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../src/bytes.ts";
import { blobSource, bytesSource, hashSource, webCryptoHasher } from "../src/hash.ts";
import { decodeManifest, LEAF_SIZE, leafDigest, leavesCovering, leafSpan, ManifestError } from "../src/manifest.ts";
import { nodeHasher, sha256Sync } from "../src/node/node-hasher.ts";
import { xorshiftBytes } from "./helpers.ts";

// Computed independently with Python's hashlib (conformance/src/media/vectors.ts has the full set and the script).
const VECTORS: [number, number, string][] = [
  [0, 1, "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc"],
  [LEAF_SIZE, 3, "5f3ab0bae169a48c8fe7363d9d6722803b04607f412fc137bf9bb20cb97455e9"],
  [3 * LEAF_SIZE + 12345, 5, "4408ad9f367157d7751412c3742538936f1a3780098b12b7a572cf8daafba1ab"],
];

test("ids match the independent vectors with node:crypto and WebCrypto", async () => {
  for (const [n, seed, want] of VECTORS) {
    const data = xorshiftBytes(n, seed);
    assert.equal((await hashSource(bytesSource(data), nodeHasher)).hash, want, `node ${n}`);
    assert.equal((await hashSource(bytesSource(data), webCryptoHasher())).hash, want, `webcrypto ${n}`);
    assert.equal((await hashSource(blobSource(new Blob([data as Uint8Array<ArrayBuffer>])), webCryptoHasher(), { readSize: LEAF_SIZE, concurrency: 3 })).hash, want, `blob ${n}`);
  }
});

test("the manifest holds each leaf's digest and round-trips through its encoding", async () => {
  const data = xorshiftBytes(2 * LEAF_SIZE + 7, 9);
  const m = await hashSource(bytesSource(data), nodeHasher);
  assert.equal(m.leafCount, 3);
  for (let i = 0; i < 3; i++) {
    const { offset, length } = leafSpan(m.size, i);
    assert.equal(toHex(leafDigest(m, i)), toHex(sha256Sync(data.subarray(offset, offset + length))));
  }
  const back = await decodeManifest(m.bytes.slice(), nodeHasher, m.hash);
  assert.equal(back.hash, m.hash);
  assert.equal(back.size, m.size);
});

test("a manifest for other media, or a tampered one, is refused", async () => {
  const m = await hashSource(bytesSource(xorshiftBytes(LEAF_SIZE + 1, 2)), nodeHasher);
  const other = "0".repeat(64);
  await assert.rejects(decodeManifest(m.bytes, nodeHasher, other), ManifestError);
  const bad = m.bytes.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decodeManifest(bad, nodeHasher, m.hash), ManifestError);
  await assert.rejects(decodeManifest(m.bytes.subarray(0, m.bytes.length - 1), nodeHasher), ManifestError);
  const wrongLeaf = m.bytes.slice();
  wrongLeaf[4] = 23;
  await assert.rejects(decodeManifest(wrongLeaf, nodeHasher), /leaf size/);
});

test("leavesCovering maps byte ranges to leaves", () => {
  assert.deepEqual(leavesCovering(0, 1), { first: 0, end: 1 });
  assert.deepEqual(leavesCovering(LEAF_SIZE - 1, 2), { first: 0, end: 2 });
  assert.deepEqual(leavesCovering(LEAF_SIZE, LEAF_SIZE), { first: 1, end: 2 });
  assert.deepEqual(leavesCovering(5, 0), { first: 0, end: 0 });
});

test("hashing stops on a short read instead of hashing a changed file", async () => {
  const data = xorshiftBytes(3 * LEAF_SIZE, 4);
  const src = { size: data.length + 10, read: async (o: number, l: number) => data.subarray(o, Math.min(data.length, o + l)) };
  await assert.rejects(hashSource(src, nodeHasher), /short read/);
});
