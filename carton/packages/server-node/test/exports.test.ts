// The `./transport` subpath (web-demo REQ-6): a browser bundle takes the WebSocket transport without the package's
// root entry, which pulls in node:http. The module itself imports nothing at run time but types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("@carton/server-node/transport exports the WebSocket transport, and imports only types", async () => {
  const t = await import("@carton/server-node/transport");
  assert.equal(typeof t.webSocketTransport, "function");
  const src = readFileSync(join(import.meta.dirname, "..", "src", "transport.ts"), "utf8");
  const runtimeImports = src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
  assert.deepEqual(runtimeImports, [], "a browser bundle can't take node built-ins");
});
