// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the host-side suites against your own SequencerHost (Carton's sequencer inside Cardboard's API, say).
// server-node stands in for it here. One fixture serves every suite: your host, the Transport your clients use, an
// AuthProvider that can mint test tokens, and the optional hooks (restart, rows) that unlock the stricter checks.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import {
  authProviderSuite,
  hostSuite,
  httpApiSuite,
  liveSyncSuite,
  sequencerHostSuite,
  sequencerStorageSuite,
  transportSuite,
  type HostFixture,
} from "@carton/conformance";
import type { Role } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server"; // ← your AuthProvider
import { startNodeHost, webSocketTransport, nodeSqliteStorage, type NodeHost, type NodeSqliteStorage } from "@carton/server-node"; // ← your host
import { createFsBlobStore } from "@carton/blob-fs";

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const scratch = mkdtempSync(join(root, "host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const SECRET = "example-only-secret-example-only-secret-01";
const PROJECT = "conformance-project";
let fixtures = 0;
let devices = 0;

async function myHost(): Promise<HostFixture> {
  const auth = createHmacAuth({ secret: SECRET });
  const dataDir = join(scratch, `host-${++fixtures}`);
  let node: NodeHost = await startNodeHost({ dataDir, auth, secret: SECRET, durability: "normal" });
  const port = node.port;
  const issue = (o: { credential: string; account?: string; role?: Role; projectId?: string }) =>
    auth.issue({ account: o.account ?? o.credential.split("/")[0]!, credential: o.credential, role: o.role ?? "editor", projectId: o.projectId ?? PROJECT, ttlMs: 3600_000 });
  return {
    host: { kind: "my-host", get url() { return node.urlFor(PROJECT); }, close: () => node.close() },
    transport: webSocketTransport({ keepaliveMs: 0 }),
    auth,
    // a fresh device credential on every call
    token: (role = "editor") => issue({ credential: `acct-${++devices}/device-${devices}`, role }),
    // exactly this credential (a reconnect of one device), or a token for another project
    tokenFor: issue,
    // restart on the same storage: unlocks the restart-safety checks
    async restart() {
      await node.close();
      node = await startNodeHost({ dataDir, auth, secret: SECRET, durability: "normal", port });
    },
    // rows your storage has read and written: unlocks the "host adds no rows of its own" check (P5)
    rows: async () => node.room(PROJECT)?.storage.stats() ?? { rowsRead: 0, rowsWritten: 0 },
    close: () => node.close(),
  };
}

sequencerHostSuite("my-host", myHost);
transportSuite("my-host", myHost);
hostSuite("my-host", myHost);
liveSyncSuite("my-host", myHost);

// The SQL storage under your sequencer (here node:sqlite on disk). `reopen` unlocks the durability check.
const db = join(scratch, "sequencer.db");
sequencerStorageSuite("my-sql", async () => nodeSqliteStorage(db), {
  reopen: async (s) => {
    (s as NodeSqliteStorage).close();
    return nodeSqliteStorage(db);
  },
  close: async (s) => (s as NodeSqliteStorage).close(),
});

// Your AuthProvider. `advanceClock` unlocks the expiry check, so give the provider an injectable clock.
let clock = Date.now();
authProviderSuite("my-auth", async () => createHmacAuth({ secret: SECRET, clock: () => clock }), { advanceClock: (ms) => (clock += ms) });

// The HTTP API (invites, join, refresh, signed media URLs, uploads), when your host serves Carton's routes.
const ADMIN = "example-admin-token-0123456789";
let http: NodeHost | null = null;
after(() => http?.close());
httpApiSuite("my-host", async () => {
  const dir = join(scratch, "http");
  http = await startNodeHost({ dataDir: join(dir, "data"), auth: createHmacAuth({ secret: SECRET }), secret: SECRET, adminToken: ADMIN, blobs: createFsBlobStore({ root: join(dir, "blobs") }), durability: "normal" });
  return { origin: http.httpUrl, adminToken: ADMIN /*, minPartSize: 5 * 1024 * 1024, servesStatic: true */ };
});
