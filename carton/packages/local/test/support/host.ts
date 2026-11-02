// A real sequencer host for the shared-cut process tests: server-node over WebSocket on 127.0.0.1, demo HMAC auth.
// Writes `<dir>/host.json` ({port, url}) and a token file per replica (`token-alice`, `token-bob`); answers `rows` on
// stdin with the server's change rows (branch, seq, id) as one JSON line; `exit` stops it.
//   host <dir> <projectId> [port]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHmacAuth } from "@carton/server";
import { startNodeHost } from "@carton/server-node";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";

const [dir, projectId, port] = process.argv.slice(2);
const SECRET = "test-only-secret-test-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
// configured for Cardboard's documents, as a deployment reads the adapter's constant (H-SV): a Cardboard client of that
// version is accepted whatever server-node's own default is; the test adapter's (1) is older, so accepted too
const node = await startNodeHost({ dataDir: join(dir, "host-data"), auth, secret: SECRET, port: Number(port ?? 0), host: "127.0.0.1", durability: "normal", schemaVersion: CARDBOARD_SCHEMA_VERSION });
for (const name of ["alice", "bob"]) writeFileSync(join(dir, `token-${name}`), await auth.issue({ account: name, credential: `${name}/install`, role: "editor", projectId, ttlMs: 3600_000 }));
writeFileSync(join(dir, "host.json"), JSON.stringify({ port: node.port, url: node.urlFor(projectId) }));
process.stdout.write(JSON.stringify({ ready: true, port: node.port }) + "\n");
setTimeout(() => process.exit(0), 300_000).unref(); // never outlive the test run
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "rows") {
    const room = node.room(projectId);
    const rows = room ? room.storage.exec("SELECT branch, seq, id FROM changes ORDER BY branch, seq") : [];
    process.stdout.write(JSON.stringify({ rows }) + "\n");
  } else if (line.trim() === "exit") { await node.close(); process.exit(0); }
}
