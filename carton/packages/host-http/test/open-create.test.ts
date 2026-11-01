// Open creation (the free web demo's host): anyone may make a project and be its first owner, once per project id,
// a few a day per network; and the largest upload a host takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { handleHttp, type HttpDeps, type OpenCreate } from "../src/index.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const req = (path: string, init: RequestInit = {}) => new Request(`http://host${path}`, init);
const create = (p: string, account = "alice", ip = "1.2.3.4") => req(`/api/projects/${p}/create`, { method: "POST", headers: { "x-ip": ip }, body: JSON.stringify({ account, installKey: "k".repeat(32) }) });

function memoryOpenCreate(perDay: number): OpenCreate {
  const claimed = new Set<string>(), counts = new Map<string, number>();
  return {
    perDay,
    async claim(p, client) {
      const n = counts.get(client) ?? 0;
      if (n >= perDay) return "limit";
      counts.set(client, n + 1);
      if (claimed.has(p)) return "taken";
      claimed.add(p);
      return "ok";
    },
    async mark(p) {
      claimed.add(p);
    },
  };
}

function deps(over: Partial<HttpDeps> = {}): HttpDeps {
  const store = createMemoryBlobStore();
  return { auth: createHmacAuth({ secret: SECRET }), secret: SECRET, blobsFor: () => store, upgrade: async () => new Response(null, { status: 299 }), clientOf: (r) => r.headers.get("x-ip") ?? "?", ...over };
}

test("a host without open creation says so, and asks for nothing new", async () => {
  const d = deps();
  assert.deepEqual(await (await handleHttp(req("/api/host"), d))!.json(), { openCreate: false, maxUploadBytes: null });
  assert.equal((await handleHttp(create("p1"), d))!.status, 403);
});

test("open creation: an owner session for a new id, once; never an id in use; a daily limit per network", async () => {
  const d = deps({ openCreate: memoryOpenCreate(2), adminToken: "admin-token", maxUploadBytes: 1000 });
  assert.deepEqual(await (await handleHttp(req("/api/host"), d))!.json(), { openCreate: true, perDay: 2, maxUploadBytes: 1000 });
  const r = await handleHttp(create("p1"), d);
  assert.equal(r!.status, 200);
  const s = (await r!.json()) as { token: string; context: { role: string; account: string; projectId: string } };
  assert.equal(s.context.role, "owner");
  assert.equal(s.context.account, "alice");
  // the owner invites, as any owner
  const inv = await handleHttp(req("/api/projects/p1/invites", { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ role: "editor" }) }), d);
  assert.equal(inv!.status, 200);
  // the same id again: someone else can't become its owner
  assert.equal((await handleHttp(create("p1", "mallory", "5.6.7.8"), d))!.status, 409);
  // a project made with the admin token is in use too
  assert.equal((await handleHttp(req("/api/admin/projects/p2/invites", { method: "POST", headers: { authorization: "Bearer admin-token" }, body: "{}" }), d))!.status, 200);
  assert.equal((await handleHttp(create("p2", "mallory", "9.9.9.9"), d))!.status, 409);
  // alice's network makes its second for today, and no third
  assert.equal((await handleHttp(create("p3"), d))!.status, 200);
  assert.equal((await handleHttp(create("p5"), d))!.status, 429);
  // a bad account is refused before anything is claimed
  assert.equal((await handleHttp(create("p4", "no spaces", "7.7.7.7"), d))!.status, 400);
  assert.equal((await handleHttp(create("p4", "bob", "7.7.7.7"), d))!.status, 200);
});

test("the largest upload: a multipart part past it, and a signed PUT past it, are refused", async () => {
  const d = deps({ openCreate: memoryOpenCreate(5), maxUploadBytes: 1000 });
  const { token } = (await (await handleHttp(create("p1"), d))!.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const up = (await (await handleHttp(req("/api/projects/p1/uploads", { method: "POST", headers: auth, body: JSON.stringify({ key: "m/" + "a".repeat(64) }) }), d))!.json()) as { uploadId: string };
  const part = await handleHttp(req(`/api/projects/p1/uploads/${up.uploadId}/3?key=m/${"a".repeat(64)}`, { method: "PUT", headers: auth, body: new Uint8Array(400) }), d);
  assert.equal(part!.status, 413, "part 3 of 400 bytes means at least 1200 bytes");
  assert.equal((await handleHttp(req("/api/projects/p1/uploads", { method: "POST", headers: auth, body: JSON.stringify({ key: "m/" + "b".repeat(64), size: 5000 }) }), d))!.status, 413);
  const { url } = (await (await handleHttp(req("/api/projects/p1/blobs/sign", { method: "POST", headers: auth, body: JSON.stringify({ key: "t1/x", method: "PUT" }) }), d))!.json()) as { url: string };
  const put = await handleHttp(new Request(url, { method: "PUT", body: new Uint8Array(2000) }), d);
  assert.equal(put!.status, 413);
});

test("pieces-done removes a clip's pieces only once its whole file is there", async () => {
  const store = createMemoryBlobStore();
  const d = deps({ openCreate: memoryOpenCreate(5), blobsFor: () => store });
  const { token } = (await (await handleHttp(create("p1"), d))!.json()) as { token: string };
  const hash = "c".repeat(64);
  await store.put(`lv/${hash}/info`, new TextEncoder().encode(JSON.stringify({ v: 1, size: 3, pieceSize: 1 << 21, pieces: 2 })));
  await store.put(`lv/${hash}/0`, new Uint8Array(2));
  await store.put(`lv/${hash}/1`, new Uint8Array(1));
  const done = () => handleHttp(req("/api/projects/p1/blobs/pieces-done", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ hash }) }), d);
  assert.equal((await done())!.status, 409);
  assert.ok(await store.head(`lv/${hash}/0`));
  await store.put(`m/${hash}`, new Uint8Array(3));
  assert.deepEqual(await (await done())!.json(), { removed: 2 });
  assert.equal(await store.head(`lv/${hash}/0`), null);
  assert.equal(await store.head(`lv/${hash}/info`), null);
});
