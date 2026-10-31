// The media API as a client uses it (e2e-qa S5): hostMediaBlobs over server-node, the §11 repair path (a damaged
// object reported, checked by the host, removed, shared again), signed URLs built for the address the client used,
// and media dedup within a team (S5-3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { request } from "node:http";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";
import { hostMediaBlobs } from "@carton/host-http/client";
import { mediaHash, manifestKey, mediaKey, webCryptoHasher, uploadMedia, bytesSource, LEAF_SIZE } from "@carton/media";
import { startNodeHost, type NodeHost, type NodeHostOptions } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
const hosts: NodeHost[] = [];
after(async () => {
  for (const h of hosts) await h.close();
});
async function host(extra: Partial<NodeHostOptions> = {}) {
  const dir = scratch("media-api");
  const blobs = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  const h = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs, durability: "normal", ...extra });
  hosts.push(h);
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "p", ttlMs: 3600_000 });
  return { h, blobs, token, media: hostMediaBlobs({ origin: h.httpUrl, projectId: "p", token }) };
}
const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 0xff);

test("hostMediaBlobs: small objects, ranges, streams, resumable multipart and signed URLs through server-node", async () => {
  const { media } = await host();
  const small = fill(5000, 1);
  await media.put("m/small", small, { contentType: "video/mp4" });
  assert.deepEqual(await media.get("m/small", { offset: 100, length: 10 }), small.subarray(100, 110));
  assert.equal((await media.head("m/small"))?.size, 5000);
  assert.equal(await media.head("m/none"), null);
  assert.equal(await media.get("m/none"), null);
  assert.deepEqual(await media.get("m/small", { offset: 9000 }), new Uint8Array(0));
  const streamed = new Uint8Array(await new Response(await media.getStream("m/small", { offset: 4990 })).arrayBuffer());
  assert.deepEqual(streamed, small.subarray(4990));
  // a resumable upload: parts out of order, resumed from the id alone, completed
  const p1 = fill(64 * 1024, 2), p2 = fill(64 * 1024, 3), p3 = fill(100, 4);
  const up = await media.createMultipart("m/big", { contentType: "video/mp4" });
  const r2 = await up.uploadPart(2, p2);
  const r1 = await up.uploadPart(1, p1);
  const again = await media.resumeMultipart("m/big", up.uploadId);
  assert.deepEqual((await again.listParts()).map((p) => p.partNumber), [1, 2]);
  const r3 = await again.uploadPart(3, p3);
  assert.equal((await again.complete([r1, r2, r3])).size, 128 * 1024 + 100);
  assert.deepEqual(await media.get("m/big", { offset: 64 * 1024 - 2, length: 4 }), new Uint8Array([...p1.subarray(-2), ...p2.subarray(0, 2)]));
  // a player gets a URL it can seek in
  const url = await media.signedUrl("m/big", { method: "GET", expiresIn: 60 });
  const seek = await fetch(url, { headers: { range: "bytes=10-19" } });
  assert.equal(seek.status, 206);
  assert.deepEqual(new Uint8Array(await seek.arrayBuffer()), p1.subarray(10, 20));
  // ifAbsent leaves an existing object alone
  await media.put("m/small", fill(5000, 9), { ifAbsent: true });
  assert.deepEqual(await media.get("m/small", { offset: 0, length: 4 }), small.subarray(0, 4));
});

test("§11 repair: a damaged object is checked by the host and removed, so sharing it again replaces it; a sound one stays", async () => {
  const { media, blobs } = await host();
  const bytes = fill(3 * LEAF_SIZE + 12345, 7);
  const manifest = await mediaHash(bytes, webCryptoHasher());
  const key = mediaKey(manifest.hash);
  await media.put(manifestKey(manifest.hash), manifest.bytes);
  await media.put(key, bytes, { contentType: "video/mp4" });
  // a report on a leaf that verifies changes nothing (a reporter can't remove a good object)
  assert.deepEqual(await media.reportDamaged(key, 1), { damaged: false });
  assert.ok(await media.head(key));
  // disk rot on the host: one byte of leaf 2 flips, the size stays the same
  const stored = (await blobs.get(`projects/p/media/${key}`))!;
  stored[2 * LEAF_SIZE + 99] ^= 0xff;
  await blobs.put(`projects/p/media/${key}`, stored);
  assert.deepEqual(await media.reportDamaged(key, 2), { damaged: true, removed: true });
  assert.equal(await media.head(key), null, "the damaged object is gone, so the owner's next share uploads it");
  await media.put(key, bytes, { contentType: "video/mp4", ifAbsent: true });
  assert.deepEqual(await media.get(key, { offset: 2 * LEAF_SIZE + 90, length: 20 }), bytes.subarray(2 * LEAF_SIZE + 90, 2 * LEAF_SIZE + 110));
  // what can't be checked is refused, never removed
  await assert.rejects(media.reportDamaged("m/" + "0".repeat(64), 0), /409/);
  await assert.rejects(media.reportDamaged("other/key", 0), /400/);
  await assert.rejects(media.reportDamaged(key, 99), /400/);
});

test("S5-2: signed URLs carry the address the client used, a configured public origin, or a trusted proxy's", async () => {
  // node:http, since fetch won't send a Host header of the caller's choosing
  const sign = (h: NodeHost, token: string, headers: Record<string, string> = {}) =>
    new Promise<URL>((ok, fail) => {
      const body = JSON.stringify({ key: "m/x", method: "GET" });
      const req = request(`${h.httpUrl}/api/projects/p/blobs/sign`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(body.length), ...headers } }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          try {
            ok(new URL((JSON.parse(text) as { url: string }).url));
          } catch (e) {
            fail(new Error(`${res.statusCode}: ${text} (${e})`));
          }
        });
      });
      req.on("error", fail);
      req.end(body);
    });
  const plain = await host();
  const port = new URL(plain.h.httpUrl).port;
  assert.equal((await sign(plain.h, plain.token, { host: `localhost:${port}` })).origin, `http://localhost:${port}`, "the Host the client sent");
  assert.equal((await sign(plain.h, plain.token, { host: `localhost:${port}`, "x-forwarded-host": "evil.example" })).host, `localhost:${port}`, "forwarded headers are ignored unless trusted");
  assert.equal((await sign(plain.h, plain.token, { host: "bad host@x" })).origin, plain.h.httpUrl, "a malformed Host falls back to the listen address");
  const proxied = await host({ trustProxy: true });
  assert.equal((await sign(proxied.h, proxied.token, { "x-forwarded-host": "carton.example", "x-forwarded-proto": "https" })).origin, "https://carton.example");
  const fixed = await host({ publicOrigin: "https://media.carton.example/" });
  assert.equal((await sign(fixed.h, fixed.token, { host: "elsewhere:1" })).origin, "https://media.carton.example");
  // and a URL signed for one origin works at another that reaches the same host: the signature covers the route
  const u = await sign(plain.h, plain.token, { host: `localhost:${port}` });
  await plain.media.put("m/x", fill(10, 1));
  u.hostname = "127.0.0.1";
  assert.equal((await fetch(u)).status, 200);
});

test("S5-3: a team keeps one copy of a file its projects share; a project reads only what it was granted", async () => {
  const dir = scratch("media-team");
  const blobs = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  const teams: Record<string, string> = { a: "studio", b: "studio", c: "studio", x: "other" };
  const h = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs, durability: "normal", teamOf: (p) => teams[p] });
  hosts.push(h);
  const client = async (projectId: string, role: "editor" | "viewer" = "editor") =>
    hostMediaBlobs({ origin: h.httpUrl, projectId, token: await auth.issue({ account: "o", credential: "o/dev", role, projectId, ttlMs: 3600_000 }) });
  const hasher = webCryptoHasher();
  const bytes = fill(2 * LEAF_SIZE + 5, 11);
  const manifest = await mediaHash(bytes, hasher);
  const key = mediaKey(manifest.hash);
  // a's editor shares the file: uploaded once, into the team's scope
  const a = await client("a");
  const first = await uploadMedia({ store: a, hasher, source: bytesSource(bytes), manifest, partSize: LEAF_SIZE });
  assert.equal(first.deduped, false);
  assert.ok(await blobs.head(`teams/studio/media/${key}`));
  assert.equal(await blobs.head(`projects/a/media/${key}`), null);
  // c never brought it in: its viewer can't see it or read it, not even through a signed URL
  const cView = await client("c", "viewer");
  assert.equal(await cView.head(key), null);
  assert.equal((await fetch(await cView.signedUrl(key, { method: "GET", expiresIn: 60 }))).status, 404);
  assert.equal(await cView.head(manifestKey(manifest.hash)), null);
  // b's editor shares the same file: the upload finds the team's copy and sends nothing
  const b = await client("b");
  const second = await uploadMedia({ store: b, hasher, source: bytesSource(bytes), manifest });
  assert.equal(second.deduped, true);
  assert.equal(second.bytesSent, 0);
  // and b's viewers read it
  const bView = await client("b", "viewer");
  assert.deepEqual(await bView.get(key, { offset: LEAF_SIZE - 4, length: 8 }), bytes.subarray(LEAF_SIZE - 4, LEAF_SIZE + 4));
  // another team's editor finds nothing; c still holds no grant
  assert.equal(await (await client("x")).head(key), null);
  assert.equal(await cView.head(key), null);
  // a write from b can't replace the sound team copy
  await b.put(key, fill(bytes.length, 1));
  assert.deepEqual(await blobs.get(`teams/studio/media/${key}`, { offset: 0, length: 16 }), bytes.subarray(0, 16));
});
