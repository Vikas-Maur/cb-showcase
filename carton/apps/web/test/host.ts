// A real Node host for the media tests: server-node on port 0 with blob-fs under the scratch folder, the demo's HMAC
// auth with a random secret, and an admin token to bootstrap an owner invite, exactly as the seed script does it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBlobStore } from "@carton/blob-fs";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import type { BlobStore } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, type NodeHost } from "@carton/server-node";

// Under ~/gfv-scratch on the shared dev box (its /tmp is a small tmpfs), else the OS temp folder.
export const SCRATCH =
  process.env.CARTON_TEST_SCRATCH ??
  (existsSync(join(homedir(), "gfv-scratch")) ? join(homedir(), "gfv-scratch", "carton", "web-demo", "helper-media") : join(tmpdir(), "carton-web-demo"));

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export interface TestHost {
  host: NodeHost;
  /** The host's origin, e.g. http://127.0.0.1:41234 */
  url: string;
  dir: string;
  /** A session token for `projectId`, from an admin invite for `role`. */
  session(projectId: string, role?: "owner" | "editor" | "viewer"): Promise<string>;
  /** The project's media scope on the host's own store, bypassing HTTP (to check what landed, and to break it). */
  mediaScope(projectId: string): BlobStore;
  close(): Promise<void>;
}

export async function startTestHost(opts: { staticDir?: string } = {}): Promise<TestHost> {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, "host-"));
  // A fresh random secret per run: it never leaves this process.
  const secret = randomHex(32);
  const adminToken = randomHex(24);
  const blobs = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  const host = await startNodeHost({
    dataDir: join(dir, "data"),
    auth: createHmacAuth({ secret }),
    secret,
    blobs,
    adminToken,
    ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
    onError: (e) => console.error("test host:", e),
  });
  const url = host.httpUrl;
  return {
    host,
    url,
    dir,
    async session(projectId, role = "owner") {
      const inv = await fetch(`${url}/api/admin/projects/${projectId}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!inv.ok) throw new Error(`invite: ${inv.status} ${await inv.text()}`);
      const { invite } = (await inv.json()) as { invite: string };
      const j = await fetch(`${url}/api/projects/${projectId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite, account: `test-${role}`, installKey: randomHex(16) }),
      });
      if (!j.ok) throw new Error(`join: ${j.status} ${await j.text()}`);
      return ((await j.json()) as { token: string }).token;
    },
    mediaScope: (projectId) => scopedBlobStore(blobs, `projects/${projectId}/media/`),
    async close() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
