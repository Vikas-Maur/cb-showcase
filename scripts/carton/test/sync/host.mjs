// A Carton host for the live-sync tests: server-node (the same sequencer and HTTP API as the Worker) on 127.0.0.1,
// the demo HMAC invites, an admin token for the first owner's invite, and blob-fs for the projects' media scope
// (share descriptors, media). State lives under <dir>, so a restart on the same port and dir is the same host.
// Prints one JSON line {ready, port, origin} when it listens; `exit` on stdin stops it. It never outlives 10 minutes.
//   node host.mjs <dir> [port]
// Test-only secrets: the host's signing secret and admin token are fixed strings, for a host on loopback.
import path from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [dir, port] = process.argv.slice(2);
const carton = path.join(import.meta.dirname, "..", "..", "..", "..", "carton");
const req = createRequire(path.join(carton, "package.json"));
const load = (name) => import(pathToFileURL(req.resolve(name)).href);
const { createHmacAuth } = await load("@carton/server");
const { startNodeHost } = await load("@carton/server-node");
const { createFsBlobStore } = await load("@carton/blob-fs");

export const SECRET = "carton-sync-test-secret-0123456789abcdef";
export const ADMIN = "carton-sync-test-admin";
const auth = createHmacAuth({ secret: SECRET });
const node = await startNodeHost({
  dataDir: path.join(dir, "rooms"),
  auth,
  secret: SECRET,
  adminToken: ADMIN,
  blobs: createFsBlobStore({ root: path.join(dir, "blobs"), durable: false }),
  port: Number(port ?? 0),
  host: "127.0.0.1",
  durability: "normal",
});
process.stdout.write(JSON.stringify({ ready: true, port: node.port, origin: node.httpUrl }) + "\n");
setTimeout(() => process.exit(0), 600_000).unref();
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "exit") break;
}
await node.close();
process.exit(0);
