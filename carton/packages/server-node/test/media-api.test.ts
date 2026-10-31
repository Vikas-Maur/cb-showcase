// The media API as a client uses it (e2e-qa S5): hostMediaBlobs over server-node, the §11 repair path (a damaged
// object reported, checked by the host, removed, shared again), signed URLs built for the address the client used,
// and media dedup within a team (S5-3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { request } from "node:http";
import { createHmacAuth } from "@carton/server";
import type { BlobStore } from "@carton/core/plugins";
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

test("§11 repair and a replacement racing it: the replacement waits for the check, then stands", async () => {
  const dir = scratch("media-repair-race");
  const inner = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  let atDelete!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (atDelete = r));
  const gate = new Promise<void>((r) => (release = r));
  let held = false, putArrived = false;
  const gated = new Proxy(inner, {
    get(t, prop) {
      if (prop === "put")
        return async (...a: Parameters<BlobStore["put"]>) => {
          if (held && a[0].includes("/media/m/")) putArrived = true;
          return t.put(...a);
        };
      if (prop === "delete")
        return async (key: string) => {
          if (key.includes("/media/m/")) {
            atDelete();
            await gate;
          }
          return t.delete(key);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as BlobStore;
  const h = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs: gated, durability: "normal" });
  hosts.push(h);
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "p", ttlMs: 3600_000 });
  const media = hostMediaBlobs({ origin: h.httpUrl, projectId: "p", token });
  const bytes = fill(2 * LEAF_SIZE + 3, 5);
  const m = await mediaHash(bytes, webCryptoHasher());
  const key = mediaKey(m.hash);
  await media.put(manifestKey(m.hash), m.bytes);
  const bad = bytes.slice();
  bad[LEAF_SIZE + 1] ^= 0xff;
  await media.put(key, bad);
  const report = media.reportDamaged(key, 1);
  await reached; // the host found the damage and is about to remove it
  held = true;
  const replacement = media.put(key, bytes);
  // without the lock the replacement's write reaches the store now; with it, nothing does until the check is over
  for (const end = Date.now() + 2000; !putArrived && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(putArrived, false, "a replacement was written in the middle of the repair check");
  held = false;
  release();
  assert.deepEqual(await report, { damaged: true, removed: true });
  await replacement;
  assert.deepEqual(await media.get(key, { offset: LEAF_SIZE, length: 4 }), bytes.subarray(LEAF_SIZE, LEAF_SIZE + 4), "the good replacement stands");
});

test("put with ifAbsent is one create-only PUT: an existing object stays, and its info comes back", async () => {
  const { h, token, media } = await host();
  const first = fill(300, 1);
  await media.put("m/once", first);
  const calls: string[] = [];
  const counted = (async (u: string | URL | Request, i?: RequestInit) => {
    const path = new URL(u instanceof Request ? u.url : String(u)).pathname;
    calls.push(`${i?.method ?? "GET"} ${path.endsWith("/blobs/sign") ? "sign" : path.endsWith("/blobs/head") ? "head" : "blob"}`);
    return fetch(u, i);
  }) as typeof fetch;
  const client = hostMediaBlobs({ origin: h.httpUrl, projectId: "p", token, fetch: counted });
  const info = await client.put("m/once", fill(10, 2), { ifAbsent: true });
  assert.deepEqual(calls, ["POST sign", "PUT blob", "GET head"], "no head before the PUT: the PUT itself is create-only");
  assert.equal(info.size, 300, "the stored object's info, not the refused bytes'");
  assert.deepEqual(await media.get("m/once", { offset: 0, length: 4 }), first.subarray(0, 4));
  assert.equal((await client.put("m/new", fill(7, 3), { ifAbsent: true })).size, 7);
});

// web-demo's report: a signed PUT kept only the content type, so the client's sha256 never reached the store.
test("put with sha256 carries it through the signed PUT: the host refuses bytes that don't match, and head reports it", async () => {
  const { h, token, media } = await host();
  const bytes = fill(5000, 4);
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  assert.equal((await media.put("px/poster", bytes, { contentType: "image/jpeg", sha256 })).sha256, sha256);
  assert.equal((await media.head("px/poster"))?.sha256, sha256, "the store kept the digest");
  const wrong = sha256.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  await assert.rejects(media.put("px/other", bytes, { sha256: wrong }), /400/);
  assert.equal(await media.head("px/other"), null, "nothing was written");
  // a raw signed PUT: the header must be a digest at all
  const { url } = (await (await fetch(`${h.httpUrl}/api/projects/p/blobs/sign`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ key: "px/raw", method: "PUT" }) })).json()) as { url: string };
  assert.equal((await fetch(url, { method: "PUT", body: bytes, headers: { "x-carton-sha256": "not-hex" } })).status, 400);
  assert.equal((await fetch(url, { method: "PUT", body: bytes, headers: { "x-carton-sha256": sha256.toUpperCase() } })).status, 200, "hex in either case");
  assert.equal((await media.head("px/raw"))?.sha256, sha256);
});

// Round 4 finding 2: the media lock is per physical scope. A host whose store pauses the repair's delete of `prefix`.
async function pausedRepair(name: string, prefix: string, teams?: Record<string, string>) {
  const dir = scratch(name);
  const inner = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  let atDelete!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (atDelete = r));
  const gate = new Promise<void>((r) => (release = r));
  const gated = new Proxy(inner, {
    get(t, prop) {
      if (prop === "delete")
        return async (key: string) => {
          if (key.startsWith(prefix)) {
            atDelete();
            await gate;
          }
          return t.delete(key);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as BlobStore;
  const h = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs: gated, durability: "normal", ...(teams ? { teamOf: (p: string) => teams[p] } : {}) });
  hosts.push(h);
  const client = async (projectId: string) =>
    hostMediaBlobs({ origin: h.httpUrl, projectId, token: await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId, ttlMs: 3600_000 }) });
  const p = await client("p"), q = await client("q");
  const bytes = fill(LEAF_SIZE + 9, 7);
  const m = await mediaHash(bytes, webCryptoHasher());
  const key = mediaKey(m.hash);
  await p.put(manifestKey(m.hash), m.bytes);
  const bad = bytes.slice();
  bad[3] ^= 0xff;
  await p.put(key, bad);
  const report = p.reportDamaged(key, 0);
  await reached; // p's repair found the damage and holds the lock, about to delete
  return { p, q, bytes, m, key, report, release };
}
const within = <T,>(ms: number, x: Promise<T>) => Promise.race([x.then(() => "done" as const), new Promise<"waiting">((ok) => setTimeout(() => ok("waiting"), ms).unref())]);

test("a repair in one project doesn't hold up another project's write of the same hash: their stores are apart", async () => {
  const { q, bytes, m, key, report, release } = await pausedRepair("media-lock-apart", "projects/p/media/m/");
  try {
    await q.put(manifestKey(m.hash), m.bytes);
    assert.equal(await within(10_000, q.put(key, bytes)), "done", "q's write waited for p's repair");
  } finally {
    release();
  }
  assert.deepEqual(await report, { damaged: true, removed: true });
  assert.deepEqual(await q.get(key, { offset: 0, length: 4 }), bytes.subarray(0, 4));
});

test("within a team a repair in one project holds a teammate's write of that object until it's done, so the good copy stands", async () => {
  const { q, bytes, key, report, release } = await pausedRepair("media-lock-team", "teams/studio/media/m/", { p: "studio", q: "studio" });
  const write = q.put(key, bytes);
  // without one lock for the team, q's write finds a right-sized object and keeps it, then the repair deletes it
  assert.equal(await within(1500, write), "waiting", "q's write went ahead during p's repair");
  release();
  assert.deepEqual(await report, { damaged: true, removed: true });
  await write;
  assert.deepEqual(await q.get(key, { offset: 0, length: 4 }), bytes.subarray(0, 4), "the teammate's good copy stands");
});
