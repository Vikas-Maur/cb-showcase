import { test } from "node:test";
import assert from "node:assert/strict";
import { blobStoreSuite } from "@carton/conformance";
import { MemoryBlobStore } from "../src/index.ts";
import { createBlobUrlSigner, serveSignedBlob, parseRange, SHA256_HEADER } from "../src/signed.ts";

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
blobStoreSuite("memory with signed URLs", async () => store, { fetch: local, reportsCreated: true });

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

test("a URL signed under one scope (one project's route) is refused under another, though the key and secret match", async () => {
  const a = createBlobUrlSigner({ secret: "test-secret-test-secret-test-secret!", baseUrl: "https://carton.test/blob/project-a" });
  const b = createBlobUrlSigner({ secret: "test-secret-test-secret-test-secret!", baseUrl: "https://carton.test/blob/project-b" });
  const url = await a.sign("GET", "media/clip.mp4", 60);
  assert.equal(await a.verify(new URL(url), "GET"), "media/clip.mp4");
  assert.equal(await b.verify(new URL(url.replace("/blob/project-a/", "/blob/project-b/")), "GET"), null);
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

test("list pages in code-point order across the BMP / astral boundary (U+E000 sorts before U+10000)", async () => {
  const st = new MemoryBlobStore();
  await st.put("u/\uE000", new Uint8Array([1]));
  await st.put("u/\u{10000}", new Uint8Array([2]));
  const first = await st.list("u/", { limit: 1 });
  assert.deepEqual(first.blobs.map((b) => b.key), ["u/\uE000"]);
  const second = await st.list("u/", { limit: 1, cursor: first.cursor! });
  assert.deepEqual(second.blobs.map((b) => b.key), ["u/\u{10000}"]);
});

test("a signed PUT with If-None-Match: * creates only: 412 when the key is there, and every answer carries the stored info", async () => {
  await store.put("once.bin", new Uint8Array([1, 1]), { contentType: "a/first" });
  const put = await signer.sign("PUT", "once.bin", 60);
  const refused = await local(put, { method: "PUT", body: new Uint8Array([2, 2, 2]), headers: { "if-none-match": "*", "content-type": "a/second" } });
  assert.equal(refused.status, 412);
  const first = (await refused.json()) as { key: string; size: number; etag?: string; contentType?: string };
  assert.deepEqual([first.key, first.size, first.contentType], ["once.bin", 2, "a/first"], "the earlier object's info");
  assert.equal(refused.headers.get("etag"), first.etag ?? null);
  assert.deepEqual(await store.get("once.bin"), new Uint8Array([1, 1]));
  const fresh = await signer.sign("PUT", "fresh.bin", 60);
  const made = await local(fresh, { method: "PUT", body: new Uint8Array([3]), headers: { "if-none-match": "*", "content-type": "a/third" } });
  assert.equal(made.status, 200);
  assert.deepEqual(await made.json(), await store.head("fresh.bin"), "the new object's info, as head reports it");
  assert.deepEqual(await store.get("fresh.bin"), new Uint8Array([3]));
  assert.equal((await local(put, { method: "PUT", body: new Uint8Array([4]) })).status, 200, "without the header a PUT replaces");
  assert.deepEqual(await store.get("once.bin"), new Uint8Array([4]));
});

// Round 3: the 412 was inferred from the kept object's size, digest and type, so a racing writer of other bytes of
// the same size (or a multipart complete, with no digest) went unseen and both PUTs got 200.
test("a create-only signed PUT that loses a race to bytes of the same size answers 412: the store says it created nothing", async () => {
  const url = await signer.sign("PUT", "same-size.bin", 60);
  const racing = {
    kind: store.kind,
    put: store.put.bind(store),
    head: async () => {
      await store.put("same-size.bin", new Uint8Array([7, 7, 7])); // theirs: 3 bytes, no digest
      return null;
    },
  } as unknown as typeof store;
  const r = await serveSignedBlob(new Request(url, { method: "PUT", body: new Uint8Array([1, 2, 3]), headers: { "if-none-match": "*" } }), racing, signer);
  assert.equal(r.status, 412);
  assert.deepEqual(await store.get("same-size.bin"), new Uint8Array([7, 7, 7]));
});

test("a store that doesn't say whether it created: 200 only when the client's digest proves the stored bytes are its own", async () => {
  // the store's own outcome stripped, as a store from elsewhere might return it
  const plain = { kind: store.kind, head: store.head.bind(store), put: async (...a: Parameters<typeof store.put>) => ({ ...(await store.put(...a)) }) } as unknown as typeof store;
  const put = async (key: string, body: Uint8Array, digest?: string) =>
    (await serveSignedBlob(new Request(await signer.sign("PUT", key, 60), { method: "PUT", body, headers: { "if-none-match": "*", ...(digest ? { [SHA256_HEADER]: digest } : {}) } }), plain, signer)).status;
  const bytes = new Uint8Array([4, 5, 6]);
  const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  assert.equal(await put("proven.bin", bytes, sha), 200, "created, and the stored digest is the client's");
  assert.equal(await put("unproven.bin", bytes), 412, "created, but nothing proves it: the answer still carries the info");
  assert.deepEqual(await store.get("unproven.bin"), bytes);
});

test("a create-only signed PUT that loses a race to a writer the host doesn't serialize with answers 412 with that writer's info", async () => {
  const url = await signer.sign("PUT", "raced.bin", 60);
  // the other writer gets in between this host's head and its put
  const racing = {
    kind: store.kind,
    put: store.put.bind(store),
    head: async () => {
      await store.put("raced.bin", new Uint8Array([9, 9, 9, 9]), { contentType: "a/theirs" });
      return null;
    },
  } as unknown as typeof store;
  const r = await serveSignedBlob(new Request(url, { method: "PUT", body: new Uint8Array([5]), headers: { "if-none-match": "*" } }), racing, signer);
  assert.equal(r.status, 412);
  assert.deepEqual([((await r.json()) as { size: number }).size, await store.get("raced.bin")], [4, new Uint8Array([9, 9, 9, 9])]);
});
