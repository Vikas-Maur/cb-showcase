// A real sequencer host for the live-sync scenarios: `@carton/server-node` (node:sqlite rooms, RFC 6455 WebSocket,
// the HTTP API) on 127.0.0.1 with the demo HMAC auth. The secret comes from the environment (a random one per run),
// never from code.
//   host-node <dataDir> [port]          env: CARTON_E2E_SECRET
// Prints {ready, port, origin}; commands on stdin (JSON, answered with the same seq):
//   {cmd: "rows", projectId}            the room's change rows: [{branch, seq, id}]
//   {cmd: "exit"}
import { createInterface } from "node:readline";
import { createHmacAuth } from "@carton/server";
import { startNodeHost } from "@carton/server-node";

const [dataDir, port = "0"] = process.argv.slice(2);
const secret = process.env.CARTON_E2E_SECRET;
if (!secret) throw new Error("CARTON_E2E_SECRET is not set");
const auth = createHmacAuth({ secret });
const node = await startNodeHost({ dataDir: dataDir!, auth, secret, port: Number(port), host: "127.0.0.1", durability: "normal" });
process.stdout.write(JSON.stringify({ ready: true, port: node.port, origin: node.httpUrl }) + "\n");
setTimeout(() => process.exit(0), Number(process.env.CARTON_E2E_APP_TTL_MS ?? 600_000)).unref();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  try {
    if (m.cmd === "rows") {
      const room = node.room(m.projectId);
      const rows = room ? room.storage.exec("SELECT branch, seq, id FROM changes ORDER BY branch, seq") : [];
      process.stdout.write(JSON.stringify({ seq: m.seq, rows }) + "\n");
    } else if (m.cmd === "exit") {
      await node.close();
      process.stdout.write(JSON.stringify({ seq: m.seq, ok: true }) + "\n");
      process.exit(0);
    } else throw new Error(`unknown command ${m.cmd}`);
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ seq: m.seq, error: String(e?.message ?? e) }) + "\n");
  }
}
