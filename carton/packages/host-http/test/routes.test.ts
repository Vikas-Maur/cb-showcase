// handleHttp without a network: route matching, the 501 for a provider without invite links, and session checks.
// The full API runs over real HTTP in both hosts' tests (httpApiSuite).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { handleHttp, checkSession, type HttpDeps } from "../src/index.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const ctx: Omit<AuthContext, "expires"> = { account: "a", credential: "a/dev", role: "editor", projectId: "p" };
const req = (path: string, init: RequestInit = {}) => new Request(`http://host${path}`, init);

function deps(over: Partial<HttpDeps> = {}): HttpDeps {
  const store = createMemoryBlobStore();
  return { auth: createHmacAuth({ secret: SECRET }), secret: SECRET, blobsFor: () => store, upgrade: async () => new Response("upgraded", { status: 299 }), ...over };
}

test("non-API paths are left to the host (static files); unknown API paths are 404", async () => {
  assert.equal(await handleHttp(req("/index.html"), deps()), null);
  assert.equal((await handleHttp(req("/api/nope"), deps()))?.status, 404);
  assert.equal((await handleHttp(req("/api/health"), deps()))?.status, 200);
  assert.equal((await handleHttp(req("/api/projects/bad%20id/ws"), deps()))?.status, 404, "project ids are restricted");
});

test("the WebSocket route reaches the host's upgrade only with a session for that project", async () => {
  const d = deps();
  const tok = await d.auth.issue!({ ...ctx, ttlMs: 60_000 });
  assert.equal((await handleHttp(req("/api/projects/p/ws"), d))?.status, 401);
  assert.equal((await handleHttp(req("/api/projects/q/ws", { headers: { authorization: `Bearer ${tok}` } }), d))?.status, 403);
  assert.equal((await handleHttp(req("/api/projects/p/ws", { headers: { "sec-websocket-protocol": `carton.v1, carton.auth.${tok}` } }), d))?.status, 299);
});

test("an AuthProvider without invite links answers 501 on the invite routes, and still serves sessions", async () => {
  const hmac = createHmacAuth({ secret: SECRET });
  const plain = { kind: "accounts", verify: (t: string) => hmac.verify(t) };
  const d = deps({ auth: plain, adminToken: "admin" });
  const r = await handleHttp(req("/api/projects/p/join", { method: "POST", body: JSON.stringify({ invite: "x", account: "a", installKey: "k".repeat(20) }) }), d);
  assert.equal(r?.status, 501);
  const tok = await hmac.issue({ ...ctx, ttlMs: 60_000 });
  assert.equal((await checkSession(plain, tok, "p")).credential, "a/dev");
  await assert.rejects(checkSession(plain, tok, "q"), /another project/);
  await assert.rejects(checkSession(plain, "garbage", "p"), /invalid/);
});

test("oversized JSON bodies are refused", async () => {
  const r = await handleHttp(req("/api/projects/p/join", { method: "POST", body: "x".repeat(70_000) }), deps());
  assert.equal(r?.status, 413);
});

test("a chunked body with no Content-Length is cut off at the budget, and its stream cancelled", async () => {
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const r = await handleHttp(new Request("http://host/api/projects/p/join", { method: "POST", body: endless, duplex: "half" } as RequestInit), deps());
  assert.equal(r?.status, 413);
  assert.ok(cancelled, "the stream was not cancelled");
  assert.ok(pulled < 16, `read ${pulled} chunks past a 64 KB budget`);
});

test("a complete request for the maximum 10,000 parts is not refused for its size", async () => {
  const d = deps();
  const tok = await d.auth.issue!({ ...ctx, ttlMs: 60_000 });
  const store = d.blobsFor("p")!;
  const up = await store.createMultipart("big");
  const parts = Array.from({ length: 10_000 }, (_, i) => ({ partNumber: i + 1, etag: `"${"e".repeat(32)}"` }));
  const r = await handleHttp(req(`/api/projects/p/uploads/${up.uploadId}/complete?key=big`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ parts }) }), d);
  assert.notEqual(r?.status, 413);
  assert.equal(r?.status, 400, "the store refuses the parts (never uploaded), not the HTTP layer");
});
