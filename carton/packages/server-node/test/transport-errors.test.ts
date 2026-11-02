// A failed connect says why, as a code (REQ-9b): an offline client or a host that isn't there is `unreachable`, never
// told its token is bad; a session the host refuses is `unauthorized`. A browser's WebSocket closes a refused
// handshake with 1006 like a dropped one, so the transport asks the host's HTTP API once with the same token.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, webSocketTransport, type NodeHost, type TransportError } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const auth = createHmacAuth({ secret: "test-only-secret-test-only-secret-0123" });
const hosts: NodeHost[] = [];
after(async () => {
  for (const h of hosts) await h.close();
});
const failure = (p: Promise<unknown>) => p.then(() => assert.fail("connected"), (e: TransportError) => e);
const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

test("connect: no host there is `unreachable`, and the message doesn't blame the token", async () => {
  const port = await freePort();
  const e = await failure(webSocketTransport({ keepaliveMs: 0 }).connect(`ws://127.0.0.1:${port}/api/projects/p/ws`, { token: "whatever" }));
  assert.equal(e.code, "unreachable");
  assert.doesNotMatch(e.message, /token/i);
});

test("connect: a session the host refuses is `unauthorized` (a bad token, another project's, an expired one)", async () => {
  const h = await startNodeHost({ dataDir: join(scratch("transport-errors"), "d"), auth, durability: "normal" });
  hosts.push(h);
  const t = webSocketTransport({ keepaliveMs: 0 });
  const bad = await failure(t.connect(h.urlFor("p"), { token: "not-a-token" }));
  assert.equal(bad.code, "unauthorized", bad.message);
  const other = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "q", ttlMs: 60_000 });
  assert.equal((await failure(t.connect(h.urlFor("p"), { token: other }))).code, "unauthorized");
  const expired = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "p", ttlMs: -120_000 });
  assert.equal((await failure(t.connect(h.urlFor("p"), { token: expired }))).code, "unauthorized");
  const good = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
  (await t.connect(h.urlFor("p"), { token: good })).close();
  // the host gone: unreachable again, even with a token it would have refused
  await h.close();
  assert.equal((await failure(t.connect(h.urlFor("p"), { token: "not-a-token" }))).code, "unreachable");
});

/** A host whose WebSocket handshakes always drop (1006) and whose session route answers `session(token)`: a status, or
 * "stall" for never. */
async function droppingHandshakes(session: (token: string) => number | "stall") {
  const server = createHttpServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.url !== "/api/projects/p/session") return res.writeHead(404).end();
    const s = session(token);
    if (s === "stall") return; // never answers
    res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(s === 200 ? { role: "viewer" } : { error: "invalid token" }));
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  after(() => server.close());
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/p/ws`;
}

test("a dropped handshake with a session the host accepts is `unreachable`, a scoped watch link's included; a refused one `unauthorized`", async () => {
  const url = await droppingHandshakes((t) => (t === "good" ? 200 : 401));
  const t = webSocketTransport({ keepaliveMs: 0 });
  assert.equal((await failure(t.connect(url, { token: "good" }))).code, "unreachable");
  assert.equal((await failure(t.connect(url, { token: "bad" }))).code, "unauthorized");
});

test("the probe keeps to connect's deadline and the caller's abort", async () => {
  const url = await droppingHandshakes(() => "stall");
  const t0 = Date.now();
  const late = await failure(webSocketTransport({ keepaliveMs: 0, connectTimeoutMs: 400 }).connect(url, { token: "x" }));
  assert.equal(late.code, "unreachable");
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms past a 400 ms deadline`);
  const ac = new AbortController();
  const t1 = Date.now();
  const aborting = failure(webSocketTransport({ keepaliveMs: 0, connectTimeoutMs: 30_000 }).connect(url, { token: "x", signal: ac.signal }));
  setTimeout(() => ac.abort(new Error("stop")), 150);
  assert.equal((await aborting).message, "stop");
  assert.ok(Date.now() - t1 < 2000, `an abort took ${Date.now() - t1} ms`);
});
