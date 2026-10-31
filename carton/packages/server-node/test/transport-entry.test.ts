// `@carton/server-node/transport` is the WebSocket Transport alone, for browsers and the web client: the package's main
// entry also carries the Node host (node:http, node:path), which a browser bundle can't resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { webSocketTransport } from "@carton/server-node/transport";
import * as main from "@carton/server-node";

test("the transport entry is the same transport, and bundles for the browser with no node: imports", async () => {
  assert.equal(webSocketTransport, main.webSocketTransport);
  const r = await build({
    entryPoints: [fileURLToPath(new URL("../src/transport.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent",
  });
  assert.equal(r.errors.length, 0);
  assert.doesNotMatch(r.outputFiles[0]!.text, /from\s*["']node:/);
});
