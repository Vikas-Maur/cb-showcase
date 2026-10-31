// httpBlobStore against a real Node host (server-node + blob-fs + the demo's HMAC auth): what @carton/media relies on
// (exact ranges, streaming, head, put, multipart that resumes) and how it uses the API (one signature per key, a
// fresh token per request). The full BlobStore conformance suite runs in http-blobs-conformance.test.ts.

import { createHash } from "node:crypto";
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
  // the conformance suite's list, minus its 1024-byte key (a media scope leaves 1006 bytes: see the test below)
  const keys = ["Clip.MP4", "clip.mp4", "dir/Ünïcødé 名前.mov", "a b+c%20d?e#f&g=h", "CON", "nul.txt", "trailing.", "~tilde~b", ".hidden", "...", "deep/b/c"];
  const s = store();
  for (const [i, key] of keys.entries()) await s.put(`opaque/${key}`, new TextEncoder().encode(`v${i}`));
  for (const [i, key] of keys.entries()) {
    assert.equal(new TextDecoder().decode((await s.get(`opaque/${key}`))!), `v${i}`, key);
    assert.equal((await s.head(`opaque/${key}`))?.size, `v${i}`.length, key);
  }
});

// S3 and R2 cap the whole key, prefix included, at 1024 bytes, so a project's media scope (`projects/p1/media/`, 18
// bytes) takes keys up to 1006 bytes and refuses longer ones with InvalidKey, over HTTP too.
test("a project's media scope takes keys up to 1024 bytes less its prefix, and says so past it", async () => {
  const room = 1024 - "projects/p1/media/".length;
  const fits = "k/" + "L".repeat(room - 2);
  await th.mediaScope("p1").put(fits, new Uint8Array([1]));
  await assert.rejects(th.mediaScope("p1").put(fits + "L", new Uint8Array([1])), (e: Error & { code?: string }) => e.code === "InvalidKey");
  await store().put(fits, new Uint8Array([2]));
  assert.equal((await store().head(fits))?.size, 1);
  await assert.rejects(store().put(fits + "L", new Uint8Array([2])), (e: HttpBlobError) => e.code === "InvalidKey" && e.status >= 400 && e.status < 500);
});

test("put with ifAbsent keeps the first bytes", async () => {
  const s = store();
  await s.put("once", seededBytes(8, 4));
  const info = await s.put("once", seededBytes(20, 5), { ifAbsent: true });
  assert.equal(info.size, 8);
  assert.ok(sameBytes((await s.get("once"))!, seededBytes(8, 4)));
});

// REQ-10: a host's answer to a signed PUT carries the stored object's info (200 written, 412 kept), so put reads
// nothing back; an answer without it (a bucket's own on a presigned URL, an older host's) falls back to a head.
const heads = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.endsWith("/blobs/head")).length;

test("a create-only put of a new key takes the stored info from the answer: no read-back", async () => {
  const rec = recordingFetch();
  const data = seededBytes(40, 40);
  const hex = createHash("sha256").update(data).digest("hex");
  const info = await store(rec.fetch).put("fresh-key", data, { ifAbsent: true, contentType: "image/jpeg", sha256: hex });
  assert.deepEqual(rec.calls.map((c) => c.method), ["POST", "PUT"], "sign, PUT: nothing else");
  assert.equal(info.size, 40);
  assert.equal(info.contentType, "image/jpeg");
  assert.equal(info.sha256, hex);
  assert.equal(info.etag, (await store().head("fresh-key"))?.etag);
});

test("a create-only put of an existing key gets 412 with the kept object's info: no read-back, no write", async () => {
  await store().put("kept-key", seededBytes(8, 41), { contentType: "text/plain" });
  const rec = recordingFetch();
  const statuses: number[] = [];
  const info = await store(async (input, init) => {
    const r = await rec.fetch(input, init);
    if (init?.method === "PUT") statuses.push(r.status);
    return r;
  }).put("kept-key", seededBytes(30, 42), { ifAbsent: true, contentType: "image/png" });
  assert.deepEqual(statuses, [412]);
  assert.equal(heads(rec.calls), 0, "no head");
  assert.deepEqual([info.key, info.size, info.contentType], ["kept-key", 8, "text/plain"]);
  assert.ok(sameBytes((await store().get("kept-key"))!, seededBytes(8, 41)), "the first bytes stay");
});

test("an answer with no info (a bucket's, an older host's) falls back to a head for a create-only put only", async () => {
  // what a bucket answers on a presigned URL, or a host before REQ-10: the status and an etag, no JSON body
  const bare: typeof fetch = async (input, init) => {
    const r = await fetch(input, init);
    if (init?.method !== "PUT") return r;
    await r.body?.cancel();
    return new Response(null, { status: r.status, headers: r.headers.get("etag") ? { etag: r.headers.get("etag")! } : {} });
  };
  const rec = recordingFetch(bare);
  await store().put("old-key", seededBytes(8, 43));
  const kept = await store(rec.fetch).put("old-key", seededBytes(30, 44), { ifAbsent: true });
  assert.equal(kept.size, 8, "the stored object's size, read back");
  assert.equal(heads(rec.calls), 1);
  const fresh = await store(rec.fetch).put("new-key-bare", seededBytes(12, 45), { ifAbsent: true });
  assert.equal(fresh.size, 12);
  assert.equal(heads(rec.calls), 2, "create-only reads back: the answer can't say whose bytes are stored");
  const plain = await store(rec.fetch).put("plain-bare", seededBytes(5, 46));
  assert.equal(plain.size, 5);
  assert.equal(heads(rec.calls), 2, "a plain put stored these bytes: nothing to read back");
});

test("ifAbsent is atomic: of writers racing for a new key, one writes and all of them report its bytes", async () => {
  const s = store();
  const tries = [1, 2, 3, 4, 5, 6].map((i) => seededBytes(10 * i, 20 + i));
  const infos = await Promise.all(tries.map((b) => s.put("race", b, { ifAbsent: true })));
  const stored = (await s.get("race"))!;
  assert.ok(tries.some((b) => sameBytes(b, stored)), "the stored bytes are one writer's, whole");
  for (const info of infos) assert.equal(info.size, stored.byteLength);
});

test("put sends its sha256: the host refuses a body that doesn't match and keeps one that does", async () => {
  const s = store();
  const data = seededBytes(64, 30);
  const hex = createHash("sha256").update(data).digest("hex");
  const info = await s.put("checked", data, { sha256: hex });
  assert.equal(info.sha256, hex);
  assert.equal((await s.head("checked"))?.sha256, hex);
  await assert.rejects(s.put("tampered", seededBytes(64, 31), { sha256: hex }), (e: HttpBlobError) => e.status === 400);
  assert.equal(await s.head("tampered"), null, "nothing written");
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

// host-http signs blob URLs with the origin the client reached (its Host header; behind a proxy, `trustProxy` or
// `publicOrigin`), so a page using /blobs/sign directly (an <img> for a poster) gets a URL it can fetch.
test("server-node signs blob URLs for the Host the client used", async () => {
  const viaName = th.url.replace("127.0.0.1", "localhost");
  const r = await fetch(`${viaName}/api/projects/p1/blobs/sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ key: "where", method: "GET", expiresIn: 60 }),
  });
  const { url } = (await r.json()) as { url: string };
  assert.ok(url.startsWith(`${viaName}/`), url);
});
