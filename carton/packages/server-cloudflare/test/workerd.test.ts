// Inside real workerd (wrangler dev, R2 bound): the SequencerStorage checks on DO SQLite, the BlobStore suite on the
// DO-blob fallback (BlobVault), and the host and transport suites on the Worker + ProjectRoom, with a restart on the
// same on-disk state.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { blobStoreSuite, sequencerHostSuite, transportSuite, httpApiSuite, liveSyncSuite, type HostFixture } from "@carton/conformance";
import { createHmacAuth } from "@carton/server";
import { webSocketTransport } from "@carton/server-node";
import type { Role } from "@carton/core/plugins";
import { doBlobStore } from "../src/blob-do.ts";
import { R2_MIN_PART_SIZE } from "../src/blob-r2.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";
import { startDev, type DevServer } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ADMIN = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const PROJECT = "cf-conformance";
const dev: DevServer = await startDev({ config: join(import.meta.dirname, "wrangler.r2.dev.toml"), state: stateDir(`dev-r2-${Date.now()}`), vars: { AUTH_SECRET: SECRET, ADMIN_TOKEN: ADMIN } });
after(() => dev.stop());

test("SequencerStorage checks pass on a Durable Object's SQLite (inside workerd)", async () => {
  const results = (await (await fetch(`${dev.origin}/__test/storage-checks`)).json()) as { name: string; ok: boolean; error?: string }[];
  assert.ok(results.length >= 5);
  for (const r of results) assert.ok(r.ok, `${r.name}: ${r.error}`);
});

// The Node-side DoBlobStore as the client, its vault inside workerd: requests go through the test worker's
// /__test/vault route, the way the Worker's own stub.fetch would.
const vaultNs: DurableObjectNamespace = {
  idFromName: (n) => n,
  get: (id) => ({
    fetch: (u: Request | string, init?: RequestInit) => {
      const url = new URL(typeof u === "string" ? u : u.url);
      return fetch(`${dev.origin}/__test/vault/${encodeURIComponent(String(id))}${url.pathname}${url.search}`, init);
    },
  }),
};
blobStoreSuite("do-blob (BlobVault in workerd)", async () => doBlobStore(vaultNs, `vault-${Date.now()}`));

let devN = 0;
async function fixture(): Promise<HostFixture> {
  const auth = createHmacAuth({ secret: SECRET });
  const issue = (account: string, credential: string, role: Role, projectId = PROJECT) => auth.issue({ account, credential, role, projectId, ttlMs: 3600_000 });
  return {
    host: { kind: "cloudflare (wrangler dev)", url: `ws://127.0.0.1:${dev.port}/api/projects/${PROJECT}/ws`, close: async () => {} },
    transport: webSocketTransport({ keepaliveMs: 0 }),
    auth,
    token: (role = "editor") => {
      const a = `cf-${++devN}`;
      return issue(a, `${a}/dev-${devN}-${Math.random().toString(36).slice(2, 8)}`, role);
    },
    tokenFor: (o) => issue(o.account ?? o.credential.split("/")[0]!, o.credential, o.role ?? "editor", o.projectId),
    restart: () => dev.restart(),
    async rows() {
      const s = (await (await fetch(`${dev.origin}/__test/stats/${PROJECT}`)).json()) as { stats: { rowsRead: number; rowsWritten: number } };
      return { rowsRead: s.stats.rowsRead, rowsWritten: s.stats.rowsWritten };
    },
    close: async () => {},
  };
}

sequencerHostSuite("server-cloudflare (Worker + ProjectRoom in wrangler dev)", fixture);
transportSuite("server-cloudflare (WebSocket through the Worker)", fixture);
liveSyncSuite("server-cloudflare (Worker + ProjectRoom)", fixture);

httpApiSuite("server-cloudflare (Worker, R2)", async () => ({ origin: dev.origin, adminToken: ADMIN, minPartSize: R2_MIN_PART_SIZE }));
