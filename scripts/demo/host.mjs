// A local sharing server for rehearsals: Carton's server-node (the same sequencer and HTTP API as the Cloudflare Worker
// at cardboard-showcase.vikasmaur10.workers.dev) on 127.0.0.1, with open creation on, as that server has it (anyone may
// share a project, no token), and blob-fs for the projects' media. State lives under <dir>, so a restart on the same
// port and dir is the same server. Prints one JSON line {ready, port, origin} when it listens; runs until stopped.
//   node host.mjs <dir> [port]
// Its signing secret is a fixed string: it listens on loopback only, for rehearsals on this box.
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [dir, port] = process.argv.slice(2);
if (!dir) throw new Error("usage: node host.mjs <dir> [port]");
const carton = path.join(import.meta.dirname, "..", "..", "carton");
const req = createRequire(path.join(carton, "package.json"));
const load = (name) => import(pathToFileURL(req.resolve(name)).href);
const { createHmacAuth } = await load("@carton/server");
const { startNodeHost } = await load("@carton/server-node");
const { createFsBlobStore } = await load("@carton/blob-fs");
const { CARDBOARD_SCHEMA_VERSION } = await load("@carton/cardboard");

const SECRET = "carton-demo-rehearsal-secret-0123456789abcdef";
const node = await startNodeHost({
  dataDir: path.join(dir, "rooms"),
  auth: createHmacAuth({ secret: SECRET }),
  secret: SECRET,
  adminToken: "carton-demo-rehearsal-admin",
  blobs: createFsBlobStore({ root: path.join(dir, "blobs"), durable: false }),
  port: Number(port ?? 0),
  host: "127.0.0.1",
  durability: "normal",
  // the live server takes 10 new projects per address per day; rehearsals on loopback make more than that
  openCreate: { perDay: 1000 },
  // the live server's upload cap (its /api/host says maxUploadBytes 209715200)
  maxUploadBytes: 209_715_200,
  schemaVersion: CARDBOARD_SCHEMA_VERSION,
});
process.stdout.write(JSON.stringify({ ready: true, port: node.port, origin: node.httpUrl }) + "\n");
const stop = async () => { await node.close().catch(() => {}); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
