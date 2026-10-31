import { test } from "node:test";
import assert from "node:assert/strict";
import { blobStoreSuite } from "@carton/conformance";
import { MemoryBlobStore } from "../src/index.ts";
import { createBlobUrlSigner, serveSignedBlob, parseRange } from "../src/signed.ts";

// A memory store that signs URLs, answered in-process by serveSignedBlob: the suite's signed-URL test runs on it.
let clock = Date.now();
const signer = createBlobUrlSigner({ secret: "test-secret-test-secret-test-secret!", baseUrl: "https://carton.test/api/blob", clock: () => clock });
class SigningMemoryStore extends MemoryBlobStore {
  signedUrl(key: string, o: { method: "GET" | "PUT"; expiresIn: number }) {
    return signer.sign(o.method, key, o.expiresIn);
  }
}
const store = new SigningMemoryStore();
const local = (async (input: string | URL | Request, init?: RequestInit) => serveSignedBlob(new Request(input, init), store, signer)) as typeof fetch;
blobStoreSuite("memory with signed URLs", async () => store, { fetch: local });

test("a signed URL is bound to its method, key and expiry", async () => {
  await store.put("clip.mp4", new Uint8Array([1, 2, 3]));
  const get = await signer.sign("GET", "clip.mp4", 60);
  assert.equal((await local(get, { method: "PUT", body: new Uint8Array([9]) })).status, 403, "GET URL used for PUT");
  assert.equal((await local(get, { method: "HEAD" })).status, 200, "HEAD rides on a GET URL");
  const u = new URL(get);
  u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 3600));
  assert.equal((await local(u.toString())).status, 403, "extended expiry");
  clock += 120_000;
  assert.equal((await local(get)).status, 403, "expired");
  clock -= 120_000;
  const other = createBlobUrlSigner({ secret: "another-secret-another-secret-12345", baseUrl: "https://carton.test/api/blob" });
  assert.equal((await local(await other.sign("GET", "clip.mp4", 60))).status, 403, "another secret");
  assert.equal((await local("https://carton.test/api/blob/clip.mp4")).status, 403, "unsigned");
});

test("ranges: a-b, a-, -n, unsatisfiable, and multi-range served whole", async () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { offset: 0, length: 10 });
  assert.deepEqual(parseRange("bytes=90-", 100), { offset: 90, length: 10 });
  assert.deepEqual(parseRange("bytes=-5", 100), { offset: 95, length: 5 });
  assert.deepEqual(parseRange("bytes=-500", 100), { offset: 0, length: 100 });
  assert.deepEqual(parseRange("bytes=95-500", 100), { offset: 95, length: 5 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=5-2", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  await store.put("r.bin", new Uint8Array(100).map((_, i) => i));
  const url = await signer.sign("GET", "r.bin", 60);
  const r = await local(url, { headers: { range: "bytes=200-" } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */100");
  const ok = await local(url, { headers: { range: "bytes=-3" } });
  assert.equal(ok.status, 206);
  assert.equal(ok.headers.get("content-range"), "bytes 97-99/100");
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [97, 98, 99]);
});
