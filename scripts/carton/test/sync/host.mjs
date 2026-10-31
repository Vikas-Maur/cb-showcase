// A Carton host for the live-sync tests: server-node (the same sequencer and HTTP API as the Worker) on 127.0.0.1,
// the demo HMAC invites, an admin token for the first owner's invite, and blob-fs for the projects' media scope
// (share descriptors, media). State lives under <dir>, so a restart on the same port and dir is the same host.
// Prints one JSON line {ready, port, origin} when it listens; `exit` on stdin stops it. It never outlives 10 minutes.
// `hold-ends` makes it hold every segmented proxy's end entry (ps/<stream>/end) until `release-ends`, so a test can
// read a proxy that is still uploading (answers {held} / {released}).
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
const { CARDBOARD_SCHEMA_VERSION } = await load("@carton/cardboard");

export const SECRET = "carton-sync-test-secret-0123456789abcdef";
export const ADMIN = "carton-sync-test-admin";
const auth = createHmacAuth({ secret: SECRET });
let hold = null; // {promise, release} while ends are held
let keep = false; // media objects the host's repair path would remove are kept ("keep-objects")
const END = /(^|\/)ps\/[0-9a-f]{64}\/end$/;
const OBJECT = /(^|\/)m\/[0-9a-f]{64}$/;
const fsBlobs = createFsBlobStore({ root: path.join(dir, "blobs"), durable: false });
const blobs = new Proxy(fsBlobs, {
  get(t, k) {
    const v = Reflect.get(t, k);
    if (typeof v !== "function") return v;
    if (k === "delete") return async (key, ...a) => (keep && typeof key === "string" && OBJECT.test(key) ? undefined : v.call(t, key, ...a));
    if (!String(k).startsWith("put")) return v.bind(t);
    return async (...a) => {
      if (typeof a[0] === "string" && END.test(a[0]) && hold) await hold.promise;
      return v.apply(t, a);
    };
  },
});
const node = await startNodeHost({
  dataDir: path.join(dir, "rooms"),
  auth,
  secret: SECRET,
  adminToken: ADMIN,
  blobs,
  port: Number(port ?? 0),
  host: "127.0.0.1",
  durability: "normal",
  // The newest document schema the app's adapter writes (CARTON_TEST_SCHEMA_VERSION plays a host older than the app,
  // which refuses its hello).
  schemaVersion: Number(process.env.CARTON_TEST_SCHEMA_VERSION) || CARDBOARD_SCHEMA_VERSION,
});
process.stdout.write(JSON.stringify({ ready: true, port: node.port, origin: node.httpUrl }) + "\n");
setTimeout(() => process.exit(0), 600_000).unref();
for await (const line of createInterface({ input: process.stdin })) {
  let cmd = line.trim();
  try { cmd = JSON.parse(cmd); } catch {} // the tests send JSON lines ("exit")
  if (cmd === "exit") break;
  if (cmd === "hold-ends" && !hold) {
    let release;
    hold = { promise: new Promise((r) => (release = r)), release };
    process.stdout.write(JSON.stringify({ held: true }) + "\n");
  } else if (cmd === "keep-objects" || cmd === "remove-objects") {
    keep = cmd === "keep-objects";
    process.stdout.write(JSON.stringify({ keep }) + "\n");
  } else if (cmd === "release-ends") {
    hold?.release();
    hold = null;
    process.stdout.write(JSON.stringify({ released: true }) + "\n");
  }
}
await node.close();
process.exit(0);
