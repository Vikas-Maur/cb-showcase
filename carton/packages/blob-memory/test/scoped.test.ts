import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobStore } from "../src/index.ts";
import { scopedBlobStore } from "../src/scoped.ts";
import { putCreated } from "../src/rules.ts";

// web-demo's report: keys of ~1004–1024 bytes passed the scoped store's check, then failed the inner store's against
// 1024 with the prefix counted, under a message naming a limit the caller's key was within.
test("a scoped store takes keys up to the room its prefix leaves, and names that room when it refuses one", async () => {
  const prefix = "projects/p1/media/"; // 18 bytes
  const s = scopedBlobStore(createMemoryBlobStore(), prefix);
  const room = 1024 - prefix.length;
  const fits = "k/" + "L".repeat(room - 2);
  await s.put(fits, new Uint8Array([1]));
  assert.equal((await s.head(fits))?.key, fits);
  const over = fits + "L";
  for (const call of [() => s.put(over, new Uint8Array([1])), () => s.get(over), () => s.getStream!(over), () => s.head(over), () => s.delete(over), () => s.createMultipart(over)])
    await assert.rejects(call(), (e: Error & { code?: string }) => e.code === "InvalidKey" && e.message.includes(`longer than ${room} bytes`) && e.message.includes("18-byte scope prefix"));
  // bytes, not UTF-16 units: a 3-byte character counts 3
  const wide = "k/" + "名".repeat(Math.floor((room - 2) / 3));
  await s.put(wide, new Uint8Array([2]));
  await assert.rejects(s.put(wide + "名", new Uint8Array([2])), /longer than 1006 bytes/);
  assert.throws(() => scopedBlobStore(createMemoryBlobStore(), "x".repeat(1023) + "/"), /no room/);
});

test("a scoped store carries on whether a create-only put created its object", async () => {
  const s = scopedBlobStore(createMemoryBlobStore(), "projects/p1/media/");
  assert.equal(putCreated(await s.put("k", new Uint8Array([1]), { ifAbsent: true })), true);
  assert.equal(putCreated(await s.put("k", new Uint8Array([2]), { ifAbsent: true })), false);
  assert.equal(putCreated(await s.put("k", new Uint8Array([3]))), undefined, "a plain put says nothing");
});
