// A request answered before its body was read whole (a 413 at the body budget, which stops reading) leaves the rest of
// that body on the connection. The host says `connection: close`, so a client doesn't keep the connection in its pool:
// without it, a later request on that connection failed with ECONNRESET (found by REQ-11's conformance test). And it
// closes in stages (RFC 9112 §9.6): half-close after the answer, then drop the rest of the body until the client closes.
// Closing at once, with the body's bytes unread, reset the connection, and on Windows the reset lost the 413 before
// the client read it (`fetch failed`, CI on Windows only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";
import { startNodeHost, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const auth = createHmacAuth({ secret: SECRET });
let host: NodeHost | null = null;
after(() => host?.close());

async function started() {
  if (!host) {
    const dir = scratch("keepalive");
    host = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs: createFsBlobStore({ root: join(dir, "blobs") }), durability: "normal" });
  }
  const token = await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
  return { origin: host.httpUrl, token };
}

test("a request refused before its body was read closes its connection; the client's next requests go through", async () => {
  const { origin, token } = await started();
  const post = (body: string) => fetch(`${origin}/api/projects/p/blobs/heads`, { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const refused = await post(JSON.stringify({ keys: ["m/x"], pad: "x".repeat(2 << 20) }));
  assert.equal(refused.status, 413);
  await refused.body?.cancel();
  for (let i = 0; i < 3; i++) {
    const r = await post(JSON.stringify({ keys: ["m/x"] }));
    assert.deepEqual(await r.json(), { blobs: [null] }, `request ${i + 1} after the refusal`);
  }
  assert.equal(refused.headers.get("connection"), "close");
  // a request whose body was read whole keeps its connection
  const ok = await post(JSON.stringify({ keys: ["m/x"] }));
  assert.notEqual(ok.headers.get("connection"), "close");
  await ok.body?.cancel();
});

// What a client sees on the wire: the 413, then the host's FIN (a half-close), and the rest of its body taken without
// a reset. Closing at once instead reset the connection as the client went on sending (on Linux a write error after
// the answer; on Windows the answer itself was lost). With a declared length the host answers at once; a chunked body
// is answered once the reader passes the route's budget (1 MiB), which stops reading without destroying the request
// (cancelling node's own web stream did: the request then stopped reading its socket, and the rest sat unread).
for (const framing of ["content-length", "chunked"] as const) {
  test(`the close is staged (${framing}): the 413, then a half-close, and the rest of the body is taken (dropped) without a reset`, async () => {
    const { origin, token } = await started();
    const total = 3 << 20;
    const sock = connect({ host: "127.0.0.1", port: Number(new URL(origin).port), allowHalfOpen: true });
    await new Promise<void>((r) => sock.once("connect", () => r()));
    let answer = "", ended = false, error: Error | null = null;
    sock.on("data", (b: Buffer) => void (answer += b.toString("latin1")));
    sock.on("end", () => void (ended = true));
    sock.on("error", (e) => void (error = e));
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const framed = (b: Buffer) => (framing === "chunked" ? Buffer.concat([Buffer.from(`${b.byteLength.toString(16)}\r\n`), b, Buffer.from("\r\n")]) : b);
    sock.write(`POST /api/projects/p/blobs/heads HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\n${framing === "chunked" ? "transfer-encoding: chunked" : `content-length: ${total}`}\r\n\r\n`);
    for (let sent = 0; sent < total && !error && !sock.destroyed; sent += chunk.byteLength) {
      if (!sock.write(framed(chunk))) await new Promise((r) => (sock.once("drain", r), sock.once("close", r)));
    }
    if (framing === "chunked") sock.write("0\r\n\r\n");
    sock.end();
    await new Promise<void>((r) => (sock.destroyed ? r() : sock.once("close", () => r())));
    assert.match(answer, /^HTTP\/1\.1 413 /);
    assert.match(answer, /\r\nconnection: close\r\n/i);
    assert.ok(ended, "the host half-closed after its answer");
    assert.equal(error, null, "no reset while the client finished its body");
  });
}

// A body without a declared length (chunked), over the budget, through fetch: the 413 arrives, and the connection
// isn't reused.
test("a chunked body over the budget gets its 413, and the client's next requests go through", async () => {
  const { origin, token } = await started();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n++ >= 40) return c.close(); // 40 × 64 KiB: 2.5 MiB, over the route's 1 MiB
      c.enqueue(new Uint8Array(64 * 1024).fill(0x78));
    },
  });
  const r = await fetch(`${origin}/api/projects/p/blobs/heads`, { method: "POST", body, duplex: "half", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } } as RequestInit);
  assert.equal(r.status, 413);
  assert.equal(r.headers.get("connection"), "close");
  await r.body?.cancel();
  const next = await fetch(`${origin}/api/projects/p/blobs/heads`, { method: "POST", body: JSON.stringify({ keys: ["m/x"] }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  assert.deepEqual(await next.json(), { blobs: [null] });
});

// The staged close never takes an unbounded body: what it drops is counted, and past 16 MiB the host closes anyway.
test("the staged close drops at most 16 MiB of what follows the answer, then closes", async () => {
  const { origin, token } = await started();
  const total = 256 << 20;
  const sock = connect({ host: "127.0.0.1", port: Number(new URL(origin).port), allowHalfOpen: true });
  await new Promise<void>((r) => sock.once("connect", () => r()));
  let answer = "";
  sock.on("data", (b: Buffer) => void (answer += b.toString("latin1")));
  sock.on("error", () => {});
  sock.write(`POST /api/projects/p/blobs/heads HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${token}\r\ncontent-length: ${total}\r\n\r\n`);
  const chunk = Buffer.alloc(256 * 1024, 0x78);
  let sent = 0;
  while (sent < total && !sock.destroyed && sock.writable) {
    sent += chunk.byteLength;
    if (!sock.write(chunk)) await new Promise((r) => (sock.once("drain", r), sock.once("close", r)));
  }
  if (!sock.destroyed) sock.end(); // a host without the cap took it all
  await new Promise<void>((r) => (sock.destroyed ? r() : sock.once("close", () => r())));
  assert.match(answer, /^HTTP\/1\.1 413 /);
  assert.ok(sent < 64 << 20, `the host took ${sent >> 20} MiB before closing`);
});
