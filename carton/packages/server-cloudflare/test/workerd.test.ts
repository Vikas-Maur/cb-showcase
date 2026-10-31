// Inside real workerd (wrangler dev, R2 bound): the SequencerStorage checks on DO SQLite, the BlobStore suite on the
// DO-blob fallback (BlobVault), and the host and transport suites on the Worker + ProjectRoom, with a restart on the
// same on-disk state.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { blobStoreSuite, sequencerHostSuite, transportSuite, httpApiSuite, liveSyncSuite, hostSuite, type HostFixture } from "@carton/conformance";
import { createHmacAuth } from "@carton/server";
import { webSocketTransport } from "@carton/server-node";
import { hostMessageBlobs, hostMediaBlobs } from "@carton/host-http/client";
import { mediaHash, manifestKey, mediaKey, webCryptoHasher, uploadMedia, bytesSource, LEAF_SIZE } from "@carton/media";
import type { Role } from "@carton/core/plugins";
import { doBlobStore } from "../src/blob-do.ts";
import { R2_MIN_PART_SIZE } from "../src/blob-r2.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";
import { startDev, type DevServer } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ADMIN = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const PROJECT = "cf-conformance";
// the maintenance alarm every 2 s here, so the sweep tests see it run; three projects of one team and one of another
// for the team dedup test (no other test uses these ids)
const TEAMS = { "team-a": "studio", "team-b": "studio", "team-c": "studio", "team-x": "other" };
const dev: DevServer = await startDev({ config: join(import.meta.dirname, "wrangler.r2.dev.toml"), state: stateDir(`dev-r2-${Date.now()}`), vars: { AUTH_SECRET: SECRET, ADMIN_TOKEN: ADMIN, ARCHIVE_EVERY_MS: "2000", TEAMS: JSON.stringify(TEAMS) } });
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
    clientBlobs: (token) => hostMessageBlobs({ origin: dev.origin, projectId: PROJECT, token }),
    bigMessageBytes: 20 << 20, // under the room's 24 MiB cap (a Durable Object has 128 MB)
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
hostSuite("server-cloudflare (Worker + ProjectRoom)", fixture);

httpApiSuite("server-cloudflare (Worker, R2)", async () => ({ origin: dev.origin, adminToken: ADMIN, minPartSize: R2_MIN_PART_SIZE }));

test("envelope uploads: over the room's 24 MiB cap refused; an upload arms the sweep, which re-arms while one is young", async () => {
  const auth = createHmacAuth({ secret: SECRET });
  const project = `sweep-${Date.now().toString(36)}`;
  const token = await auth.issue({ account: "w", credential: "w/dev", role: "editor", projectId: project, ttlMs: 3600_000 });
  const put = (key: string, bytes: Uint8Array) => fetch(`${dev.origin}/api/projects/${project}/messages/${key}`, { method: "PUT", body: bytes as Uint8Array<ArrayBuffer>, headers: { authorization: `Bearer ${token}` } });
  const hour = Math.floor(Date.now() / 3600_000);
  const sha = (b: Uint8Array) => crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>).then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  const big = new Uint8Array((24 << 20) + 1).fill(32);
  assert.equal((await put(`messages/c/${hour}/${await sha(big)}-0123abcd`, big)).status, 413, "an envelope over the room's cap");
  const young = new TextEncoder().encode('{"type":"push"}');
  assert.equal((await put(`messages/c/${hour}/${await sha(young)}-0123abcd`, young)).status, 200);
  const alarm = async () => ((await (await fetch(`${dev.origin}/__test/alarm/${project}`)).json()) as { alarm: number | null }).alarm;
  assert.ok(await alarm(), "the upload armed the room's sweep");
  await new Promise((r) => setTimeout(r, 4500)); // the alarm ran at least once; the young envelope is still there
  assert.ok(await alarm(), "the alarm was not re-armed while an envelope remains");
});

test("media through the Worker and R2 (hostMediaBlobs): ranged reads, and §11's repair removing only a damaged object", async () => {
  const auth = createHmacAuth({ secret: SECRET });
  const project = `media-${Date.now().toString(36)}`;
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: project, ttlMs: 3600_000 });
  const media = hostMediaBlobs({ origin: dev.origin, projectId: project, token });
  const bytes = new Uint8Array(2 * LEAF_SIZE + 777).map((_, i) => (i * 13) & 0xff);
  const m = await mediaHash(bytes, webCryptoHasher());
  const key = mediaKey(m.hash);
  await media.put(manifestKey(m.hash), m.bytes);
  await media.put(key, bytes, { contentType: "video/mp4" });
  assert.deepEqual(await media.get(key, { offset: LEAF_SIZE - 3, length: 6 }), bytes.subarray(LEAF_SIZE - 3, LEAF_SIZE + 3));
  assert.deepEqual(await media.reportDamaged(key, 1), { damaged: false });
  const bad = bytes.slice();
  bad[LEAF_SIZE + 5] ^= 1; // a bad copy into the bucket: same size, one bit off in leaf 1
  await media.put(key, bad);
  assert.deepEqual(await media.reportDamaged(key, 0), { damaged: false }, "leaf 0 is fine");
  assert.deepEqual(await media.reportDamaged(key, 1), { damaged: true, removed: true });
  assert.equal(await media.head(key), null);
});

test("media dedup within a team (TEAMS, R2): one copy, found by a teammate's upload; no grant, no read", async () => {
  const auth = createHmacAuth({ secret: SECRET });
  const client = async (projectId: keyof typeof TEAMS, role: Role = "editor") =>
    hostMediaBlobs({ origin: dev.origin, projectId, token: await auth.issue({ account: "o", credential: "o/dev", role, projectId, ttlMs: 3600_000 }) });
  const hasher = webCryptoHasher();
  const bytes = new Uint8Array(LEAF_SIZE + 999).map((_, i) => (i * 7 + 1) & 0xff);
  const manifest = await mediaHash(bytes, hasher);
  const key = mediaKey(manifest.hash);
  assert.equal((await uploadMedia({ store: await client("team-a"), hasher, source: bytesSource(bytes), manifest })).deduped, false);
  const cView = await client("team-c", "viewer");
  assert.equal(await cView.head(key), null, "a project that never brought it in can't see it");
  assert.equal((await fetch(await cView.signedUrl(key, { method: "GET", expiresIn: 60 }))).status, 404);
  const second = await uploadMedia({ store: await client("team-b"), hasher, source: bytesSource(bytes), manifest });
  assert.equal(second.deduped, true);
  assert.equal(second.bytesSent, 0);
  assert.deepEqual(await (await client("team-b", "viewer")).get(key, { offset: LEAF_SIZE - 2, length: 4 }), bytes.subarray(LEAF_SIZE - 2, LEAF_SIZE + 2));
  assert.equal(await (await client("team-x")).head(key), null, "another team's editor finds nothing");
});
