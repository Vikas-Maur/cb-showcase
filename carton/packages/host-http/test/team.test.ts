// Media dedup within a team (S5-3): two projects of one team share an object's bytes, a project reads only what it
// was granted, and a sound team object can't be overwritten from another project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { mediaHash, manifestKey, mediaKey, webCryptoHasher, LEAF_SIZE } from "@carton/media";
import { projectMediaStore, isTeamMediaStore } from "../src/team.ts";

const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 0xff);

async function setup() {
  const root = createMemoryBlobStore();
  const a = projectMediaStore(root, "a", "t1");
  const b = projectMediaStore(root, "b", "t1");
  const other = projectMediaStore(root, "x", "t2");
  const bytes = fill(2 * LEAF_SIZE + 77, 3);
  const m = await mediaHash(bytes, webCryptoHasher());
  return { root, a, b, other, bytes, m, key: mediaKey(m.hash), mf: manifestKey(m.hash) };
}

test("without a team a project's media is its own scope, as before", async () => {
  const root = createMemoryBlobStore();
  const s = projectMediaStore(root, "p", null);
  assert.equal(isTeamMediaStore(s), false);
  await s.put("m/" + "a".repeat(64), fill(10, 1));
  assert.ok(await root.head(`projects/p/media/m/${"a".repeat(64)}`));
});

test("one copy per team: a second project claims what a teammate uploaded, and reads it", async () => {
  const { root, a, b, other, bytes, m, key, mf } = await setup();
  assert.ok(isTeamMediaStore(a) && isTeamMediaStore(b) && isTeamMediaStore(other));
  await a.put(mf, m.bytes);
  await a.put(key, bytes, { contentType: "video/mp4" });
  assert.ok(await root.head(`teams/t1/media/${key}`), "stored once, under the team");
  assert.equal(await root.head(`projects/a/media/${key}`), null);
  // b holds no grant: it can't read or see it
  assert.equal(await b.head(key), null);
  assert.equal(await b.get(key), null);
  assert.equal(await b.getStream!(key), null);
  // an editor of b claims it (the media API's head does), then reads it
  assert.equal(await b.claim(key), true);
  assert.equal((await b.head(key))?.size, bytes.length);
  assert.deepEqual(await b.get(key, { offset: LEAF_SIZE, length: 5 }), bytes.subarray(LEAF_SIZE, LEAF_SIZE + 5));
  // another team never sees it, even by claiming
  assert.equal(await other.claim(key), false);
  assert.equal(await other.head(key), null);
  // claiming what the team doesn't hold grants nothing
  assert.equal(await b.claim("m/" + "f".repeat(64)), false);
  assert.equal(await root.head(`projects/b/grants/${"f".repeat(64)}`), null);
  // other keys stay per project
  await a.put("px/" + m.hash + "/p720", new TextEncoder().encode("{}"));
  assert.equal(await b.get("px/" + m.hash + "/p720"), null);
  assert.ok(await root.head(`projects/a/media/px/${m.hash}/p720`));
});

test("a sound team object can't be overwritten from another project; a broken one is replaced", async () => {
  const { root, a, b, bytes, m, key, mf } = await setup();
  await a.put(mf, m.bytes);
  await a.put(key, bytes);
  // b writes garbage of any size over a sound object: a no-op (it does get the grant: it claimed to have the bytes)
  await b.put(key, fill(bytes.length, 9));
  await b.put(key, fill(10, 9));
  assert.deepEqual(await root.get(`teams/t1/media/${key}`, { offset: 0, length: 8 }), bytes.subarray(0, 8));
  assert.equal((await root.head(`teams/t1/media/${key}`))?.size, bytes.length);
  // a manifest that doesn't verify is refused; a sound one stays
  await assert.rejects(b.put(mf, fill(m.bytes.length, 1)), /PreconditionFailed|doesn't verify/);
  assert.deepEqual(await root.get(`teams/t1/media/${mf}`), m.bytes);
  // a multipart upload over a sound object completes to the sound object, and its parts are dropped
  const up = await b.createMultipart(key);
  const part = await up.uploadPart(1, fill(bytes.length, 5));
  assert.equal((await up.complete([part])).size, bytes.length);
  assert.deepEqual(await root.get(`teams/t1/media/${key}`, { offset: 100, length: 8 }), bytes.subarray(100, 108));
  // a wrong-sized object is broken: an upload replaces it
  await root.put(`teams/t1/media/${key}`, fill(5, 1));
  await b.put(key, bytes);
  assert.equal((await root.head(`teams/t1/media/${key}`))?.size, bytes.length);
});

test("grants: writing grants, resuming needs one, delete reaches the team copy only with one", async () => {
  const { root, a, b, bytes, m, key, mf } = await setup();
  const up = await a.createMultipart(key);
  assert.ok(await root.head(`projects/a/grants/${m.hash}`), "starting an upload grants it");
  await assert.rejects(b.resumeMultipart(key, up.uploadId), /NoSuchUpload|no such upload/);
  await a.put(mf, m.bytes);
  const again = await a.resumeMultipart(key, up.uploadId);
  const p = await again.uploadPart(1, bytes);
  await again.complete([p]);
  await b.delete(key);
  assert.ok(await root.head(`teams/t1/media/${key}`), "a project without a grant can't delete it");
  await a.delete(key);
  assert.equal(await root.head(`teams/t1/media/${key}`), null);
  assert.throws(() => projectMediaStore(root, "a", "bad/team"), /team/);
});
