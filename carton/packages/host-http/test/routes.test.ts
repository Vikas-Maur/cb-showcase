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
  const seq = createMemoryBlobStore();
  return { auth: createHmacAuth({ secret: SECRET }), secret: SECRET, blobsFor: () => store, sequencerBlobsFor: () => seq, upgrade: async () => new Response("upgraded", { status: 299 }), ...over };
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

test("the message routes reach exactly the two envelope key patterns of the sequencer's scope", async () => {
  const d = deps();
  const seq = d.sequencerBlobsFor!("p")!;
  const editor = await d.auth.issue!({ ...ctx, ttlMs: 60_000 });
  const viewer = await d.auth.issue!({ ...ctx, credential: "v/dev", role: "viewer", ttlMs: 60_000 });
  const sha = "a".repeat(64);
  const call = (method: string, key: string, token = editor, body?: Uint8Array) =>
    handleHttp(req(`/api/projects/p/messages/${key}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}) }), d);
  const hour = Math.floor(Date.now() / 3600_000);
  const up = `messages/c/${hour}/${sha}-0123abcd`;
  assert.equal((await call("PUT", up, editor, new TextEncoder().encode("{}")))?.status, 200);
  assert.ok(await seq.head(up), "the upload lands under the client envelope key");
  assert.equal((await call("PUT", up, viewer, new TextEncoder().encode("{}")))?.status, 403, "a viewer uploaded");
  for (const bad of [`messages/s/${hour}/${sha}`, "keyframes/main/0", `segments/main/10000.json.gz`, `messages/c/1/${sha}`, "messages/c/../x", `messages/c/999999999999/${sha}-0123abcd`, `messages/c/${hour - 30}/${sha}-0123abcd`])
    assert.notEqual((await call("PUT", bad, editor, new Uint8Array([1])))?.status, 200, `PUT ${bad}`);
  await seq.put(`messages/s/481234/${sha}`, new TextEncoder().encode('{"type":"changes"}'));
  await seq.put("keyframes/main/0", new TextEncoder().encode("secret state"));
  const got = await call("GET", `messages/s/481234/${sha}`);
  assert.equal(got?.status, 200);
  assert.equal(await got!.text(), '{"type":"changes"}');
  for (const bad of ["keyframes/main/0", up, `messages/s/481234/${"b".repeat(64)}x`]) assert.notEqual((await call("GET", bad))?.status, 200, `GET ${bad}`);
  assert.equal((await handleHttp(req(`/api/projects/p/messages/${up}`, { method: "PUT", body: "{}" }), d))?.status, 401, "no session");
});

test("POST /invites {branches}: the invite's sessions are scoped to those cuts; a scoped owner invites only within its own", async () => {
  const d = deps();
  const post = (path: string, tok: string | null, b: unknown) =>
    handleHttp(req(`/api/projects/p${path}`, { method: "POST", body: JSON.stringify(b), headers: tok ? { authorization: `Bearer ${tok}` } : {} }), d);
  const owner = await d.auth.issue!({ ...ctx, role: "owner", ttlMs: 60_000 });
  const r = await post("/invites", owner, { role: "viewer", branches: ["pub-1"] });
  assert.equal(r?.status, 200);
  const { invite } = (await r!.json()) as { invite: string };
  const j = await post("/join", null, { invite, account: "watcher", installKey: "k".repeat(20) });
  const session = (await j!.json()) as { token: string; context: AuthContext };
  assert.deepEqual(session.context.branches, ["pub-1"], "a watch link's viewer reads the Published cut only");
  assert.deepEqual((await d.auth.verify(session.token))?.branches, ["pub-1"]);
  assert.equal((await post("/invites", owner, { role: "viewer", branches: ["bad id/x"] }))?.status, 400);
  // an owner scoped to one cut can't mint a wider invite
  const scopedOwner = await d.auth.issue!({ ...ctx, role: "owner", branches: ["pub-1"], ttlMs: 60_000 });
  assert.equal((await post("/invites", scopedOwner, { role: "editor" }))?.status, 403, "unscoped");
  assert.equal((await post("/invites", scopedOwner, { role: "viewer", branches: ["main"] }))?.status, 403, "another cut");
  assert.equal((await post("/invites", scopedOwner, { role: "viewer", branches: ["pub-1"] }))?.status, 200);
});

test("a reader scoped to a Published cut signs reads of media named by content and its cut's files only (web demo review R2-1)", async () => {
  const d = deps();
  const sign = async (tok: string, key: string, method = "GET") =>
    (await handleHttp(req("/api/projects/p/blobs/sign", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ key, method }) }), d))!.status;
  const head = async (tok: string, key: string) => (await handleHttp(req(`/api/projects/p/blobs/head?key=${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${tok}` } }), d))!.status;
  const watcher = await d.auth.issue!({ ...ctx, account: "viewer", role: "viewer", branches: ["pub-1"], ttlMs: 60_000 });
  for (const key of [`m/${"a".repeat(64)}`, `mf/${"a".repeat(64)}`, `px/${"a".repeat(64)}/720p`, `t1/${"a".repeat(64)}/poster.jpg`, "cuts/pub-1/watch.json"]) assert.equal(await sign(watcher, key), 200, key);
  for (const key of ["carton/project.json", "cuts/main-1/watch.json", "cuts/pub-10/watch.json", "secret"]) assert.equal(await sign(watcher, key), 403, key);
  assert.equal(await head(watcher, "carton/project.json"), 403);
  assert.equal(await sign(watcher, "cuts/pub-1/watch.json", "PUT"), 403, "a viewer still can't write");
  // an unscoped viewer (a teammate who may read the project) and a writer read the whole scope
  const teammate = await d.auth.issue!({ ...ctx, account: "t", role: "viewer", ttlMs: 60_000 });
  assert.equal(await sign(teammate, "carton/project.json"), 200);
  const scopedWriter = await d.auth.issue!({ ...ctx, branches: ["pub-1"], ttlMs: 60_000 });
  assert.equal(await sign(scopedWriter, "carton/project.json"), 200);
});
