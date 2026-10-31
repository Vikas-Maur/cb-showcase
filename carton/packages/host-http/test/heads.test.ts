// POST /blobs/heads (REQ-11): media's reuse check of a long stream heads every part, about 2,000 requests for a
// 2,000-part stream through a Carton host. One request answers up to 1,000 keys, by HEAD's rules; hostMediaBlobs.heads
// splits, follows a host's smaller budget, and falls back to one head per key on a host from before the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext, BlobStore } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { mediaHash, manifestKey, mediaKey, webCryptoHasher, LEAF_SIZE } from "@carton/media";
import { handleHttp, projectMediaStore, MAX_BLOB_HEADS, type HttpDeps } from "../src/index.ts";
import { hasHeads, hostMediaBlobs, HostApiError } from "../src/client.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
const enc = new TextEncoder();
const hex = (i: number) => i.toString(16).padStart(64, "0");

function host(store: BlobStore, over: Partial<HttpDeps> = {}) {
  const deps: HttpDeps = { auth, secret: SECRET, blobsFor: () => store, upgrade: async () => new Response(null, { status: 500 }), ...over };
  const seen: { path: string; keys: number }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    if (new URL(req.url).pathname.endsWith("/blobs/heads")) seen.push({ path: "heads", keys: ((await req.clone().json()) as { keys: string[] }).keys.length });
    else if (new URL(req.url).pathname.endsWith("/blobs/head")) seen.push({ path: "head", keys: 1 });
    return (await handleHttp(req, deps)) ?? new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const token = (role: AuthContext["role"] = "editor", branches?: string[]) =>
    auth.issue({ account: "a", credential: "a/dev", role, projectId: "p", ttlMs: 60_000, ...(branches ? { branches } : {}) });
  const client = async (role: AuthContext["role"] = "editor", branches?: string[]) => hostMediaBlobs({ origin: "http://host", projectId: "p", token: await token(role, branches), fetch });
  const raw = async (body: string, role: AuthContext["role"] = "editor", branches?: string[]) =>
    (await handleHttp(new Request("http://host/api/projects/p/blobs/heads", { method: "POST", body, headers: { authorization: `Bearer ${await token(role, branches)}`, "content-type": "application/json" } }), deps))!;
  return { seen, client, raw };
}

test("heads answers HEAD's size or null for each key, in order (a key named twice too), in one request per 1,000", async () => {
  const store = createMemoryBlobStore();
  await store.put(`m/${hex(1)}`, enc.encode("abc"));
  await store.put(`m/${hex(2)}`, enc.encode("hello"));
  const { seen, client } = host(store);
  const media = await client();
  assert.ok(hasHeads(media));
  const keys = Array.from({ length: 2500 }, (_, i) => `m/${hex(i % 7)}`);
  const want = keys.map((k) => (k === `m/${hex(1)}` ? { size: 3 } : k === `m/${hex(2)}` ? { size: 5 } : null));
  assert.deepEqual(await media.heads(keys), want);
  assert.deepEqual(seen.splice(0), [{ path: "heads", keys: 1000 }, { path: "heads", keys: 1000 }, { path: "heads", keys: 500 }]);
  assert.deepEqual(await media.heads([]), []);
  assert.deepEqual(seen, [], "nothing asked for nothing");
});

test("a host with a smaller budget answers a prefix, and the client asks again for the rest", async () => {
  const store = createMemoryBlobStore();
  await store.put(`m/${hex(3)}`, enc.encode("x"));
  const { seen, client, raw } = host(store, { maxBlobHeads: 3 });
  const keys = Array.from({ length: 8 }, (_, i) => `m/${hex(i)}`);
  const r = await raw(JSON.stringify({ keys }));
  assert.deepEqual(await r.json(), { blobs: [null, null, null] }, "the first three");
  assert.deepEqual(await (await client()).heads(keys), keys.map((_, i) => (i === 3 ? { size: 1 } : null)));
  assert.deepEqual(seen.map((s) => s.keys), [8, 5, 2]);
});

test("caps: at most 1,000 keys and 1 MiB of JSON; keys must be valid strings; the whole batch is refused otherwise", async () => {
  const { raw } = host(createMemoryBlobStore());
  const k = `m/${hex(1)}`;
  assert.equal((await raw(JSON.stringify({ keys: Array(MAX_BLOB_HEADS + 1).fill(k) }))).status, 400);
  assert.equal((await raw(JSON.stringify({ keys: Array(MAX_BLOB_HEADS).fill(k) }))).status, 200);
  for (const keys of [k, [k, 7], null, [k, "m/../x"], [k, ""]]) assert.equal((await raw(JSON.stringify({ keys }))).status, 400, JSON.stringify(keys));
  assert.equal((await raw("not json")).status, 400);
  assert.equal((await raw("null")).status, 400);
  // 1,000 keys of the longest a store takes (1,024 bytes) fit in one request
  const long = Array.from({ length: MAX_BLOB_HEADS }, (_, i) => `m/${String(i).padStart(4, "0")}${"x".repeat(1018)}`);
  assert.equal(enc.encode(long[0]!).byteLength, 1024);
  const r = await raw(JSON.stringify({ keys: long }));
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { blobs: unknown[] }).blobs.length, MAX_BLOB_HEADS);
  assert.equal((await raw(JSON.stringify({ keys: [k], pad: "x".repeat(1024 * 1024) }))).status, 413);
});

test("the client splits by size too: keys whose JSON is over 1 MiB go in more requests", async () => {
  const { seen, client } = host(createMemoryBlobStore());
  // escaped in JSON: each control character is 6 bytes, so 700 of these keys are about 4.3 MiB
  const keys = Array.from({ length: 700 }, (_, i) => `m/${String(i).padStart(4, "0")}${"\u0001".repeat(1000)}`);
  assert.deepEqual(await (await client()).heads(keys), keys.map(() => null));
  assert.ok(seen.length >= 5, `${seen.length} requests`);
  assert.equal(seen.reduce((n, s) => n + s.keys, 0), 700);
});

test("HEAD's scope: a watch link heads media named by content, and a batch naming anything else is refused whole", async () => {
  const store = createMemoryBlobStore();
  await store.put(`m/${hex(1)}`, enc.encode("abc"));
  await store.put("cuts/pub-1/poster.jpg", enc.encode("jpeg"));
  const { raw } = host(store);
  const watch = (keys: string[]) => raw(JSON.stringify({ keys }), "viewer", ["pub-1"]);
  assert.deepEqual(await (await watch([`m/${hex(1)}`, `mf/${hex(1)}`, "cuts/pub-1/poster.jpg"])).json(), { blobs: [{ size: 3 }, null, { size: 4 }] });
  assert.equal((await watch([`m/${hex(1)}`, "project.json"])).status, 403);
  assert.equal((await watch([`m/${hex(1)}`, "cuts/pub-2/poster.jpg"])).status, 403);
  // a viewer of the whole project heads anything
  assert.deepEqual(await (await raw(JSON.stringify({ keys: ["cuts/pub-1/poster.jpg"] }), "viewer")).json(), { blobs: [{ size: 4 }] });
});

test("through a team store, an editor's batch claims a teammate's copy as HEAD does; a viewer's claims nothing", async () => {
  const root = createMemoryBlobStore();
  const bytes = new Uint8Array(LEAF_SIZE + 5).map((_, i) => i & 0xff);
  const m = await mediaHash(bytes, webCryptoHasher());
  const teammate = projectMediaStore(root, "q", "t1");
  await teammate.put(manifestKey(m.hash), m.bytes);
  await teammate.put(mediaKey(m.hash), bytes);
  const { raw } = host(projectMediaStore(root, "p", "t1"));
  const keys = JSON.stringify({ keys: [mediaKey(m.hash), manifestKey(m.hash)] });
  assert.deepEqual(await (await raw(keys, "viewer")).json(), { blobs: [null, null] }, "no grant, and a viewer's head claims none");
  assert.deepEqual(await (await raw(keys, "editor")).json(), { blobs: [{ size: bytes.byteLength }, { size: m.bytes.byteLength }] });
  assert.deepEqual(await (await raw(keys, "viewer")).json(), { blobs: [{ size: bytes.byteLength }, { size: m.bytes.byteLength }] }, "granted now");
});

test("a host from before the route: one head per key, for an editor (404) and a read role (403) alike; other errors throw", async () => {
  const store = createMemoryBlobStore();
  await store.put(`m/${hex(1)}`, enc.encode("abc"));
  // the old host: the same API, without the route (an unknown media route is 403 to a read role, 404 to an editor)
  const old = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    if (new URL(req.url).pathname.endsWith("/blobs/heads")) {
      const role = (await auth.verify(req.headers.get("authorization")!.slice(7)))!.role;
      return role === "viewer" ? Response.json({ error: "read-only role" }, { status: 403 }) : Response.json({ error: "no such route" }, { status: 404 });
    }
    return (await handleHttp(req, { auth, secret: SECRET, blobsFor: () => store, upgrade: async () => new Response(null, { status: 500 }) }))!;
  }) as typeof globalThis.fetch;
  const keys = [`m/${hex(1)}`, `m/${hex(2)}`, `m/${hex(1)}`];
  for (const role of ["editor", "viewer"] as const) {
    const media = hostMediaBlobs({ origin: "http://host", projectId: "p", token: await auth.issue({ account: "a", credential: "a/dev", role, projectId: "p", ttlMs: 60_000 }), fetch: old });
    assert.deepEqual(await media.heads(keys), [{ size: 3 }, null, { size: 3 }], role);
  }
  // this host's own refusals are errors, not an older host
  const { client } = host(store);
  const watcher = await client("viewer", ["pub-1"]);
  await assert.rejects(watcher.heads(["project.json"]), (e: unknown) => e instanceof HostApiError && e.status === 403);
});

// REQ-11 review round 1: keys were checked by the generic rules only, so a key the store's scope can't hold (its
// prefix leaves less room) failed only when its turn came, after earlier keys had been claimed.
test("a key the store's scope can't hold refuses the whole batch before any call: nothing is claimed", async () => {
  const root = createMemoryBlobStore();
  const bytes = new Uint8Array(LEAF_SIZE + 5).map((_, i) => i & 0xff);
  const m = await mediaHash(bytes, webCryptoHasher());
  const teammate = projectMediaStore(root, "q", "t1");
  await teammate.put(manifestKey(m.hash), m.bytes);
  await teammate.put(mediaKey(m.hash), bytes);
  const { raw } = host(projectMediaStore(root, "p", "t1"), { maxBlobHeads: 1 });
  const tooLong = "x".repeat(1024); // a valid key on its own, too long under projects/p/media/
  const r = await raw(JSON.stringify({ keys: [mediaKey(m.hash), tooLong] }), "editor");
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { code?: string }).code, "InvalidKey");
  assert.deepEqual(await (await raw(JSON.stringify({ keys: [mediaKey(m.hash)] }), "viewer")).json(), { blobs: [null] }, "not claimed");
  // a plain scoped store too
  const scoped = host(projectMediaStore(createMemoryBlobStore(), "p", null));
  assert.equal((await scoped.raw(JSON.stringify({ keys: [`m/${hex(1)}`, tooLong] }))).status, 400);
});

// REQ-11 review round 1: after one head failed, the others went on starting heads after the answer (and after a
// host's close had resolved). Now no head starts after a failure, and the answer waits for those started.
test("a head that fails ends the batch: the answer waits for the heads started, and none starts after it", async () => {
  const store = createMemoryBlobStore();
  let started = 0, release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const head = store.head.bind(store);
  store.head = async (key) => {
    started++;
    if (key === `m/${hex(1)}`) throw new Error("the store failed");
    await gate;
    return head(key);
  };
  const { raw } = host(store);
  let answered = false;
  // a store's failure isn't the API's to answer: handleHttp throws it, and the host answers 500
  const answer = raw(JSON.stringify({ keys: Array.from({ length: 50 }, (_, i) => `m/${hex(i)}`) })).then(
    () => assert.fail("answered"),
    (e: unknown) => ((answered = true), e),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(answered, false, "not before the started heads end");
  const atFailure = started;
  release();
  assert.match(String(await answer), /the store failed/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, atFailure, "no head started after the failure");
  assert.ok(started <= 8, `${started} heads started`);
});

test("the client's fallback to one head per key stops the same way", async () => {
  let started = 0, release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const old = (async (url: string | URL | Request) => {
    const u = new URL(url instanceof Request ? url.url : url);
    if (u.pathname.endsWith("/blobs/heads")) return Response.json({ error: "no such route" }, { status: 404 });
    started++;
    if (u.searchParams.get("key") === `m/${hex(1)}`) return Response.json({ error: "the store failed" }, { status: 500 });
    await gate;
    return Response.json({ error: "no such blob" }, { status: 404 });
  }) as typeof globalThis.fetch;
  const media = hostMediaBlobs({ origin: "http://host", projectId: "p", token: "t", fetch: old });
  let settled = false;
  const done = media.heads(Array.from({ length: 50 }, (_, i) => `m/${hex(i)}`)).then(
    () => assert.fail("resolved"),
    (e: unknown) => ((settled = true), e),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  const atFailure = started;
  release();
  assert.ok((await done) instanceof HostApiError);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, atFailure, "no head started after the failure");
});

// REQ-11 review round 2: a scoped store's check counted only its own prefix, so in a scope inside another's a key the
// outer prefix leaves no room for passed, and failed at its turn after earlier keys were claimed.
test("scopes inside scopes: a key the outer prefix leaves no room for refuses the batch before any claim", async () => {
  const root = createMemoryBlobStore();
  const tenant = scopedBlobStore(root, "tenant-0001/"); // a host serving many tenants from one bucket
  const bytes = new Uint8Array(LEAF_SIZE + 5).map((_, i) => i & 0xff);
  const m = await mediaHash(bytes, webCryptoHasher());
  const teammate = projectMediaStore(tenant, "q", "t1");
  await teammate.put(manifestKey(m.hash), m.bytes);
  await teammate.put(mediaKey(m.hash), bytes);
  const { raw } = host(projectMediaStore(tenant, "p", "t1"), { maxBlobHeads: 1 });
  // fits projects/p/media/ (1,007 bytes of room), not with tenant-0001/ ahead of it too (995)
  const tooLong = "x".repeat(1000);
  assert.equal((await raw(JSON.stringify({ keys: [mediaKey(m.hash), tooLong] }), "editor")).status, 400);
  assert.deepEqual(await (await raw(JSON.stringify({ keys: [mediaKey(m.hash)] }), "viewer")).json(), { blobs: [null] }, "not claimed");
  await assert.rejects(projectMediaStore(tenant, "p", "t1").head(tooLong), /longer than/, "as its head refuses it");
});
