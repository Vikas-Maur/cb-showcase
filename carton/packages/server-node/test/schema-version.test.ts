// H-SV: a host as shipped takes the current Cardboard client. Every Cardboard client says CARDBOARD_SCHEMA_VERSION
// in hello; the host's default is that same constant, so the adapter's bump (to 2, cardboard-adapter's 82d8c70)
// can't leave hosts refusing every client again. A client newer than the host is refused with a message saying to
// update the server, never left waiting.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { sync } from "@carton/core";
import { createHmacAuth } from "@carton/server";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";
import { helloAtSchema } from "@carton/conformance";
import { startNodeHost, webSocketTransport, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const auth = createHmacAuth({ secret: "test-only-secret-test-only-secret-0123" });
const hosts: NodeHost[] = [];
after(async () => {
  for (const h of hosts) await h.close();
});

test("H-SV: server-node as shipped takes the current Cardboard client's hello, and tells a newer one to update the server", async () => {
  const h = await startNodeHost({ dataDir: join(scratch("schema-version"), "d"), auth, durability: "normal" });
  hosts.push(h);
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "owner", projectId: "p", ttlMs: 60_000 });
  assert.equal((await helloAtSchema(webSocketTransport({ keepaliveMs: 0 }), h.urlFor("p"), token, CARDBOARD_SCHEMA_VERSION)).type, "hello", `a client at schema ${CARDBOARD_SCHEMA_VERSION} was refused`);
  const newer = await helloAtSchema(webSocketTransport({ keepaliveMs: 0 }), h.urlFor("p"), token, CARDBOARD_SCHEMA_VERSION + 1);
  assert.equal(newer.type, "error");
  assert.match((newer as sync.ErrorMsg).reason, /newer than this server accepts .*update the server/);
});
