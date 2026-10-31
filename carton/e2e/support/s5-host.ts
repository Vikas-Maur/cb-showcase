// S5's host: a real server-node on 127.0.0.1 with blob-fs as its blob store (5 MiB part minimum, as S3 and R2) and
// the demo HMAC auth, so media goes through the HTTP media API (resumable uploads, signed URLs). Prints one line:
// {ready, port, httpUrl, blobRoot, tokens: {<projectId>: {owner, mate}}}, both editors of each project. The same
// secret every run, so a restarted host accepts the tokens of the one before. `exit` on stdin stops it.
//   s5-host <dir> <projectId>[,<projectId>…] [port]      env S5_TEAM: these projects are one team (team-scoped media
//                                                          dedup, server-node `teamOf`; off when unset, as shipped)
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createFsBlobStore } from "@carton/blob-fs";
import { createHmacAuth } from "@carton/server";
import { startNodeHost } from "@carton/server-node";

const [dir, projectIds, port] = process.argv.slice(2) as [string, string, string | undefined];
const SECRET = "test-only-secret-test-only-secret-s5-media";
const auth = createHmacAuth({ secret: SECRET });
const blobRoot = join(dir, "blobs");
const blobs = createFsBlobStore({ root: blobRoot, minPartSize: 5 * 1024 * 1024, durable: false });
const team = process.env.S5_TEAM;
const mine = new Set(projectIds.split(","));
const node = await startNodeHost({ dataDir: join(dir, "host-data"), auth, secret: SECRET, blobs, port: Number(port ?? 0), host: "127.0.0.1", durability: "normal", ...(team ? { teamOf: (p: string) => (mine.has(p) ? team : null) } : {}) });
const token = (account: string, projectId: string) => auth.issue({ account, credential: `${account}/install`, role: "editor", projectId, ttlMs: 3600_000 });
const tokens: Record<string, { owner: string; mate: string }> = {};
for (const p of projectIds.split(",")) tokens[p] = { owner: await token("owner", p), mate: await token("mate", p) };
process.stdout.write(JSON.stringify({ ready: true, port: node.port, httpUrl: node.httpUrl, blobRoot, tokens }) + "\n");
setTimeout(() => process.exit(0), 600_000).unref(); // never outlive the test run
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "exit") {
    await node.close();
    process.exit(0);
  }
}
