// Serve the web demo from server-node (PLAN §3.1: the same client against the Node host, proving the plug-in
// boundary): the HTTP API, the WebSocket sequencer, blob-fs media, and the built client as static files.
//   node scripts/serve-node.ts [--port 8787] [--data <dir>] [--static <dir>] [--max-ms 7200000]
// Prints one JSON line: {"url": "...", "adminToken": "..."}. Local use only. The auth secret and admin token come from
// CARTON_AUTH_SECRET / CARTON_ADMIN_TOKEN, else they are made once per data dir (never in code).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startNodeHost, type NodeHost } from "@carton/server-node";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";

export interface DemoNodeHost {
  host: NodeHost;
  url: string;
  adminToken: string;
  close(): Promise<void>;
}

function secretIn(dir: string, name: string, env: string | undefined): string {
  if (env) return env;
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const v = randomBytes(32).toString("base64url");
  writeFileSync(file, v, { mode: 0o600 });
  return v;
}

export async function serveDemo(o: { dataDir: string; staticDir: string; port?: number; host?: string; sessionTtlMs?: number }): Promise<DemoNodeHost> {
  mkdirSync(o.dataDir, { recursive: true });
  const secret = secretIn(o.dataDir, "auth-secret", process.env.CARTON_AUTH_SECRET);
  const adminToken = secretIn(o.dataDir, "admin-token", process.env.CARTON_ADMIN_TOKEN);
  const auth = createHmacAuth({ secret, ...(o.sessionTtlMs ? { sessionTtlMs: o.sessionTtlMs } : {}) });
  const blobs = createFsBlobStore({ root: join(o.dataDir, "blobs"), durable: false });
  const host = await startNodeHost({ dataDir: o.dataDir, auth, secret, blobs, port: o.port ?? 0, host: o.host ?? "127.0.0.1", staticDir: o.staticDir, adminToken, onError: (e) => console.error("host error:", e) });
  return { host, url: host.httpUrl, adminToken, close: () => host.close() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (k: string, d?: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(arg("--data", join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "node-host"))!);
  const staticDir = resolve(arg("--static", join(here, "..", "dist"))!);
  const maxMs = Number(arg("--max-ms", "7200000"));
  const d = await serveDemo({ dataDir, staticDir, port: Number(arg("--port", "8787")) });
  console.log(JSON.stringify({ url: d.url, adminToken: d.adminToken }));
  const stop = async () => {
    await d.close();
    process.exit(0);
  };
  setTimeout(stop, maxMs).unref();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
