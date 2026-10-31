// A request answered before its body was read whole (a 413 at the body budget, which stops reading) leaves the rest of
// that body on the connection. The host says `connection: close`, so a client doesn't keep the connection in its pool:
// without it, a later request on that connection failed with ECONNRESET (found by REQ-11's conformance test).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";
import { startNodeHost, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let host: NodeHost | null = null;
after(() => host?.close());

test("a request refused before its body was read closes its connection; the client's next requests go through", async () => {
  const dir = scratch("keepalive");
  const auth = createHmacAuth({ secret: SECRET });
  host = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs: createFsBlobStore({ root: join(dir, "blobs") }), durability: "normal" });
  const token = await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
  const post = (body: string) => fetch(`${host!.httpUrl}/api/projects/p/blobs/heads`, { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
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
