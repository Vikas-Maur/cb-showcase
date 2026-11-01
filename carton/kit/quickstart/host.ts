// Quickstart: a Carton host on this machine (the Node host; Cloudflare's is the same sequencer in a Durable Object).
//   node kit/quickstart/host.ts <data dir> [port]        stop it with Ctrl+C
// It keeps one SQLite file per project and media in <data dir>/blobs. Its secrets go to <data dir>/secrets.json
// (made on first run, readable only by you): the clients read the admin token from there, it is never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFsBlobStore } from "@carton/blob-fs";
import { createHmacAuth, newSecret } from "@carton/server";
import { startNodeHost } from "@carton/server-node";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node kit/quickstart/host.ts <data dir> [port]");
mkdirSync(dir, { recursive: true });
const file = join(dir, "secrets.json");
if (!existsSync(file)) {
  writeFileSync(file, JSON.stringify({ secret: newSecret(), adminToken: newSecret() }), { mode: 0o600 });
  chmodSync(file, 0o600);
}
const { secret, adminToken } = JSON.parse(readFileSync(file, "utf8")) as { secret: string; adminToken: string };

const host = await startNodeHost({
  dataDir: join(dir, "rooms"),
  auth: createHmacAuth({ secret }),
  secret,
  blobs: createFsBlobStore({ root: join(dir, "blobs") }),
  adminToken,
  host: "127.0.0.1",
  port: Number(process.argv[3] ?? 8787),
});
console.log(`Carton host on ${host.httpUrl} (projects connect to ${host.urlFor("<project id>")})`);
const stop = async () => {
  await host.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
