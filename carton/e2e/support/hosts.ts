// The sequencer hosts a shared cut syncs through, behind one interface so a scenario runs on each:
//   - "node": `@carton/server-node` in a process of its own (support/host-node.ts), restartable on the same port and data;
//   - "cloudflare": `@carton/server-cloudflare`'s Worker + ProjectRoom Durable Object under `wrangler dev`, locally only
//     (never deployed), state on disk under the scenario's scratch folder.
// Tokens are the demo HMAC tokens, issued here with the run's random secret.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { pkg } from "./env.ts";
import { Procs, type Proc } from "./procs.ts";
import { support } from "./env.ts";

export type HostKind = "node" | "cloudflare";

export interface Host {
  kind: HostKind;
  port: number;
  /** A token file for `account` (a machine's install), as the app keeps it in app data. */
  tokenFile(dir: string, account: string, projectId: string): Promise<string>;
  /** The server's change rows for a project (node only; null elsewhere). */
  rows(projectId: string): Promise<{ branch: string; seq: number; id: string }[] | null>;
  /** Stop and start again on the same port and state (a deploy, an eviction, a crash). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const WRANGLER = join(pkg("..", "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler"));

/** Why a host kind can't run here (null when it can). */
export function hostMissing(kind: HostKind): string | null {
  if (kind === "cloudflare" && !existsSync(WRANGLER)) return `wrangler isn't installed (${WRANGLER}): run npm ci in carton/`;
  return null;
}

export async function startHost(kind: HostKind, dir: string, procs: Procs): Promise<Host> {
  const secret = randomBytes(32).toString("base64url");
  const auth = createHmacAuth({ secret });
  const tokenFile = async (d: string, account: string, projectId: string) => {
    const f = join(d, `token-${account}`);
    writeFileSync(f, await auth.issue({ account, credential: `${account}/install`, role: "editor", projectId, ttlMs: 3600_000 }));
    return f;
  };
  if (kind === "node") {
    const data = join(dir, "host-data");
    let proc: Proc;
    let port = 0;
    const up = async () => {
      proc = procs.start("host-node", [support("host-node.ts"), data, String(port)], { env: { CARTON_E2E_SECRET: secret } });
      port = (await proc.next((x) => x.ready, 30_000)).port;
    };
    await up();
    return {
      kind,
      get port() { return port; },
      tokenFile,
      rows: async (projectId) => (await proc.ask({ cmd: "rows", projectId })).rows,
      restart: async () => { await proc.kill(); await up(); },
      stop: async () => { await proc.kill(); },
    };
  }
  // wrangler dev, with the production wrangler.toml (local R2 and Durable Objects, persisted under `dir`)
  const { startDev } = await import("../../packages/server-cloudflare/test/dev-server.ts");
  const state = join(dir, "wrangler-state");
  mkdirSync(state, { recursive: true });
  const dev = await startDev({ config: pkg("server-cloudflare", "wrangler.toml"), state, vars: { AUTH_SECRET: secret, ADMIN_TOKEN: randomBytes(16).toString("base64url") }, timeoutMs: 180_000 });
  return {
    kind,
    port: dev.port,
    tokenFile,
    rows: async () => null,
    restart: () => dev.restart(),
    stop: () => dev.stop(),
  };
}
