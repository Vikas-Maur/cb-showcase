// A failed connect says why, as a code (REQ-9b): an offline client or a host that isn't there is `unreachable`, never
// told its token is bad; a session the host refuses is `unauthorized`. A browser's WebSocket closes a refused
// handshake with 1006 like a dropped one, so the transport asks the host's HTTP API once with the same token.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:net";
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
