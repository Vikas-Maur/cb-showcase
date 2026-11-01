// The host HTTP API suite on server-node, with blob-fs as its store and a static client directory.
import { after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpApiSuite } from "@carton/conformance";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";
import { startNodeHost, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ADMIN = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
let host: NodeHost | null = null;
after(() => host?.close());

httpApiSuite("server-node (blob-fs)", async () => {
  const dir = scratch("http");
  const site = join(dir, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<!doctype html><title>Carton</title>");
  host = await startNodeHost({ dataDir: join(dir, "data"), auth: createHmacAuth({ secret: SECRET }), secret: SECRET, adminToken: ADMIN, blobs: createFsBlobStore({ root: join(dir, "blobs") }), staticDir: site, durability: "normal" });
  return { origin: host.httpUrl, adminToken: ADMIN, servesStatic: true };
});
