// httpBlobStore against a real Node host (server-node + blob-fs + the demo's HMAC auth): what @carton/media relies on
// (exact ranges, streaming, head, put, multipart that resumes) and how it uses the API (one signature per key, a
// fresh token per request). The full BlobStore conformance suite runs in http-blobs-conformance.test.ts.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LEAF_SIZE, mediaHash, mediaKey, MemoryUploadStateStore, uploadMedia, bytesSource } from "@carton/media";
import { nodeHasher } from "@carton/media/node";
import { FaultyStore, LinkDroppedError } from "@carton/media/testing";
import { HttpBlobError, httpBlobStore } from "../src/http-blobs.ts";
import { startTestHost, type TestHost } from "./host.ts";
import { collect, recordingFetch, sameBytes, seededBytes } from "./util.ts";

let th: TestHost;
let token: string;
before(async () => {
  th = await startTestHost();
  token = await th.session("p1");
});
after(() => th.close());

const store = (fetchImpl?: typeof fetch, projectId = "p1", tok = () => token) =>
  httpBlobStore({ baseUrl: th.url, projectId, token: tok, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

const signs = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.endsWith("/blobs/sign")).length;

test("put, head, get and exact ranges; one signature per key for many reads", async () => {
  const rec = recordingFetch();
  const s = store(rec.fetch);
  const data = seededBytes(3000, 1);
  const info = await s.put("dir/a b+c.bin", data, { contentType: "application/x-test" });
  assert.equal(info.size, 3000);
  const h = await s.head("dir/a b+c.bin");
  assert.equal(h?.size, 3000);
  assert.equal(h?.contentType, "application/x-test");
  assert.equal(h?.key, "dir/a b+c.bin", "keys are relative to the project's media scope");
  // what landed on the host, under the project's media scope
  assert.ok(sameBytes((await th.mediaScope("p1").get("dir/a b+c.bin"))!, data));

  const before = signs(rec.calls);
  assert.ok(sameBytes((await s.get("dir/a b+c.bin"))!, data), "whole");
  assert.ok(sameBytes((await s.get("dir/a b+c.bin", { offset: 0, length: 10 }))!, data.subarray(0, 10)), "head of it");
  assert.ok(sameBytes((await s.get("dir/a b+c.bin", { offset: 1234, length: 1000 }))!, data.subarray(1234, 2234)), "middle");
  assert.ok(sameBytes((await s.get("dir/a b+c.bin", { offset: 2990, length: 100 }))!, data.subarray(2990)), "clipped at the end");
  assert.ok(sameBytes((await s.get("dir/a b+c.bin", { offset: 2000 }))!, data.subarray(2000)), "to the end");
  assert.equal((await s.get("dir/a b+c.bin", { offset: 3000, length: 5 }))!.length, 0, "at the end");
  assert.equal((await s.get("dir/a b+c.bin", { offset: 9000 }))!.length, 0, "past the end");
  assert.equal((await s.get("dir/a b+c.bin", { offset: 10, length: 0 }))!.length, 0, "length 0");
  const streamed = await s.getStream!("dir/a b+c.bin", { offset: 100, length: 2500 });
  assert.ok(sameBytes(await collect(streamed! as unknown as AsyncIterable<Uint8Array>), data.subarray(100, 2600)), "streamed range");
  assert.equal(signs(rec.calls) - before, 1, "the read URL is signed once and reused");
  const ranges = rec.calls.filter((c) => c.method === "GET" && c.url.pathname.startsWith("/blob/")).map((c) => c.headers.get("range"));
  assert.deepEqual(ranges, [null, "bytes=0-9", "bytes=1234-2233", "bytes=2990-3089", "bytes=2000-", "bytes=3000-3004", "bytes=9000-", "bytes=100-2599"]);

  assert.equal(await s.get("nope"), null);
  assert.equal(await s.get("nope", { offset: 0, length: 1 }), null);
  assert.equal(await s.getStream!("nope"), null);
  assert.equal(await s.head("nope"), null);
  await assert.rejects(s.get("a/../b"), /InvalidKey|segment/, "bad keys are refused before any request");
  await assert.rejects(s.get("x", { offset: -1 }), /range/);
});

test("a read URL the host refuses (expired early, rotated secret) is signed again, once", async () => {
  await store().put("re-sign", seededBytes(100, 2));
  let spoil = 1;
  const rec = recordingFetch((input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/blob/") && spoil-- > 0) url.searchParams.set("sig", "AAAA");
    return fetch(url, init);
  });
  const s = store(rec.fetch);
  assert.ok(sameBytes((await s.get("re-sign"))!, seededBytes(100, 2)));
  assert.equal(signs(rec.calls), 2);
});

test("the token is asked for on every request; a 401 is retried once with a newer token", async () => {
  await store().put("tok", seededBytes(10, 3));
  const tokens = ["ct1.expired-or-bogus", token];
  let asked = 0;
  const s = store(undefined, "p1", () => tokens[Math.min(asked++, 1)]!);
  assert.equal((await s.head("tok"))?.size, 10);
  assert.equal(asked, 2);
  await s.head("tok");
  assert.equal(asked, 3, "a new request asks again");
  const stuck = store(undefined, "p1", () => "ct1.bogus");
  await assert.rejects(stuck.head("tok"), (e: HttpBlobError) => e.status === 401);
});

test("keys are opaque over HTTP: case, unicode, spaces, reserved characters", async () => {
  // the conformance suite's list, minus its 1024-byte key (see the todo test below)
  const keys = ["Clip.MP4", "clip.mp4", "dir/Ünïcødé 名前.mov", "a b+c%20d?e#f&g=h", "CON", "nul.txt", "trailing.", "~tilde~b", ".hidden", "...", "deep/b/c"];
  const s = store();
  for (const [i, key] of keys.entries()) await s.put(`opaque/${key}`, new TextEncoder().encode(`v${i}`));
  for (const [i, key] of keys.entries()) {
    assert.equal(new TextDecoder().decode((await s.get(`opaque/${key}`))!), `v${i}`, key);
    assert.equal((await s.head(`opaque/${key}`))?.size, `v${i}`.length, key);
  }
});

// scopedBlobStore checks the caller's key against the 1024-byte limit and then hands `projects/<p>/media/<key>` to
// the inner store, which checks it again with the prefix included: keys between 1024 minus the prefix and 1024 bytes
// pass the first check and fail the second. Not an HTTP problem: the host's own scoped store refuses them too.
test("a 1024-byte key fits in a project's media scope", { todo: "blob-memory scoped.ts: the prefix counts against the limit" }, async () => {
  const key = "k/" + "L".repeat(1022);
  await th.mediaScope("p1").put(key, new Uint8Array([1]));
});

test("put with ifAbsent keeps the first bytes", async () => {
  const s = store();
  await s.put("once", seededBytes(8, 4));
  const info = await s.put("once", seededBytes(20, 5), { ifAbsent: true });
  assert.equal(info.size, 8);
  assert.ok(sameBytes((await s.get("once"))!, seededBytes(8, 4)));
});

test("uploadMedia over HTTP in 1 MiB parts: a cut link resumes from the parts the host lists", async () => {
  const data = seededBytes(5 * LEAF_SIZE + 7, 6);
  const manifest = await mediaHash(data, nodeHasher);
  const state = new MemoryUploadStateStore();
  const flaky = new FaultyStore(store(), { dropUploadAfterBytes: 2.5 * LEAF_SIZE });
  const opts = { hasher: nodeHasher, source: bytesSource(data), manifest, state, partSize: LEAF_SIZE, concurrency: 1, contentType: "video/mp4" };
  await assert.rejects(uploadMedia({ ...opts, store: flaky, retries: 0 }), LinkDroppedError);
  const saved = await state.load(mediaKey(manifest.hash));
  assert.equal(saved?.parts.length, 2, "two parts landed before the cut");
  const r = await uploadMedia({ ...opts, store: store() });
  assert.equal(r.resumedParts, 2);
  assert.equal(r.partsSent, 4);
  assert.equal(await state.load(mediaKey(manifest.hash)), null, "the finished upload is forgotten");
  const back = await store().get(mediaKey(manifest.hash));
  assert.ok(sameBytes(back!, data));
  assert.equal((await store().head(mediaKey(manifest.hash)))?.contentType, "video/mp4");
  const again = await uploadMedia({ ...opts, store: store() });
  assert.equal(again.deduped, true, "a second upload of the same bytes sends nothing");
});

test("an unknown or finished upload id fails with NoSuchUpload and 404, which uploadMedia reads as gone", async () => {
  const s = store();
  const isGone = (e: unknown) => {
    // the check @carton/media's upload.ts makes
    const err = e as HttpBlobError;
    assert.ok(/NoSuchUpload/i.test(`${err.name} ${err.code} ${err.message}`) && err.status === 404, String(e));
    return true;
  };
  await assert.rejects((await s.resumeMultipart("mp/x", "no-such-upload")).listParts(), isGone);
  const up = await s.createMultipart("mp/done");
  const p1 = await up.uploadPart(1, seededBytes(100, 7));
  await up.complete([p1]);
  await assert.rejects(up.uploadPart(2, seededBytes(10, 8)), isGone);
  await assert.rejects(up.uploadPart(0, seededBytes(1, 9)), /part number/, "bad part numbers are refused before any request");
});

test("a viewer reads but can't write", async () => {
  await store().put("shared", seededBytes(50, 10));
  const viewer = await th.session("p1", "viewer");
  const s = store(undefined, "p1", () => viewer);
  assert.ok(sameBytes((await s.get("shared"))!, seededBytes(50, 10)));
  await assert.rejects(s.put("mine", seededBytes(5, 11)), (e: HttpBlobError) => e.status === 403);
  await assert.rejects(s.createMultipart("mine"), (e: HttpBlobError) => e.status === 403);
});

test("a project's session can't read another project's media", async () => {
  await store().put("private", seededBytes(10, 12));
  const other = await th.session("p2");
  await assert.rejects(store(undefined, "p1", () => other).head("private"), (e: HttpBlobError) => e.status === 403);
  assert.equal(await store(undefined, "p2", () => other).head("private"), null, "p2's scope has no such key");
});

test("list and delete say they are not supported over HTTP", async () => {
  await assert.rejects(store().list(""), /not supported over HTTP/);
  await assert.rejects(store().delete("x"), /not supported over HTTP/);
});

test("signed URLs point at the base URL the client uses, whatever address the host listens on", async () => {
  await store().put("where", seededBytes(10, 13));
  const viaName = th.url.replace("127.0.0.1", "localhost");
  const s = httpBlobStore({ baseUrl: viaName, projectId: "p1", token: () => token });
  const url = await s.signedUrl("where", { method: "GET", expiresIn: 60 });
  assert.ok(url.startsWith(`${viaName}/blob/p1/where?`), url);
  assert.equal((await fetch(url)).status, 200);
  assert.ok(sameBytes((await s.get("where"))!, seededBytes(10, 13)));
});

// server-node builds its origin from the listen address (host.ts: `http://${hostPart}:${port}`), and host-http signs
// blob URLs with that origin, so a browser that reached the host as `localhost`, a LAN name or through a tunnel gets
// URLs for 127.0.0.1 or 0.0.0.0: another origin, which it can't fetch (no CORS) or can't reach. httpBlobStore works
// around it (above); a page using /blobs/sign directly (an <img> for a poster) would not.
test("server-node signs blob URLs for the Host the client used", { todo: "server-node uses its listen address as the origin" }, async () => {
  const viaName = th.url.replace("127.0.0.1", "localhost");
  const r = await fetch(`${viaName}/api/projects/p1/blobs/sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ key: "where", method: "GET", expiresIn: 60 }),
  });
  const { url } = (await r.json()) as { url: string };
  assert.ok(url.startsWith(`${viaName}/`), url);
});
