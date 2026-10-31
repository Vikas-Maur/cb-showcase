// The headless helper's sync client gets the host's blob store (kit-docs): `hostMessageBlobs` of
// `@carton/host-http/client` at the sync URL's HTTP origin, with the project id and the token file's token, so a change
// or a share over 1 MiB travels as an envelope instead of being refused "too large". Off with `blobs: false`; none when
// the client isn't installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostBlobs, httpOrigin } from "../src/factory.ts";
import { scratch } from "./support/scratch.ts";

const stub = pathToFileURL(fileURLToPath(new URL("./support/stub-host-blobs.ts", import.meta.url))).href;

test("the sync URL's HTTP origin", () => {
  assert.equal(httpOrigin("ws://127.0.0.1:8787/projects/p/sync"), "http://127.0.0.1:8787");
  assert.equal(httpOrigin("wss://carton.example/api/projects/p/sync?x=1"), "https://carton.example");
  assert.equal(httpOrigin("https://carton.example/sync"), "https://carton.example");
});

test("a helper with a sync server gets the host's blob client: origin, project, token", async () => {
  const dir = mkdtempSync(join(scratch(), "helper-blobs-"));
  writeFileSync(join(dir, "token"), "tok-123\n");
  const token = async () => "tok-123";
  const store = await hostBlobs({ url: "ws://127.0.0.1:9/projects/p-1/sync", tokenFile: join(dir, "token"), blobs: stub }, "p-1", token);
  assert.ok(store && typeof store.put === "function", "a BlobStore");
  const { calls } = (await import(stub)) as typeof import("./support/stub-host-blobs.ts");
  for (let i = 0; i < 50 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.at(-1), { origin: "http://127.0.0.1:9", projectId: "p-1", token: "tok-123" });
  assert.ok(await hostBlobs({ url: "ws://h/x", tokenFile: "t", blobs: stub, origin: "https://media.example" }, "p-1", token));
  assert.equal(calls.length >= 1, true);
});

test("no blob client: turned off, not installed, or no project id", async () => {
  const token = async () => "t";
  assert.equal(await hostBlobs({ url: "ws://h/x", tokenFile: "t", blobs: false }, "p", token), null);
  assert.equal(await hostBlobs({ url: "ws://h/x", tokenFile: "t", blobs: "@carton/no-such-client" }, "p", token), null);
  assert.equal(await hostBlobs({ url: "ws://h/x", tokenFile: "t", blobs: stub }, "", token), null);
});
