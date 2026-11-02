// A stream read held at the live edge (host-http streams.ts, cf-proxy-path) stops reading the store when its client
// goes away: server-node gives each request a signal that aborts when the client disconnects before the answer is done.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { BlobStore } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { startNodeHost, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let host: NodeHost | null = null;
after(() => host?.close());

test("a held stream read stops reading the store when its client goes away", async () => {
  const inner = createMemoryBlobStore();
  let gets = 0;
  const blobs = new Proxy(inner, { get: (t, p) => (p === "get" ? (...a: Parameters<BlobStore["get"]>) => (gets++, t.get(...a)) : Reflect.get(t, p, t)) }) as BlobStore;
  const auth = createHmacAuth({ secret: SECRET });
  host = await startNodeHost({ dataDir: join(scratch("stream-cancel"), "data"), auth, secret: SECRET, blobs, durability: "normal" });
  const token = await auth.issue({ account: "a", credential: "a/dev", role: "viewer", projectId: "p", ttlMs: 60_000 });
  const ac = new AbortController();
  const read = fetch(`${host.httpUrl}/api/projects/p/streams/${"ab".repeat(32)}/read?from=0&wait=20000`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  read.catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const held = gets;
  assert.ok(held >= 2, `the read is checking the store (${held} reads)`);
  ac.abort();
  await new Promise((r) => setTimeout(r, 4500));
  assert.ok(gets - held <= 2, `${gets - held} reads after the client went away`);
});
