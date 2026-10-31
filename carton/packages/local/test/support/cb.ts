// A `cb` process for the process tests: one write handed to the lease holder through the same `submit` path the
// real `cb` uses (starting a helper when nobody holds the lease). Prints one JSON line.
//   cb <carton.db> <json: {ops, id?, retryOnReset?, config}>
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { submit } from "../../src/client.ts";
import { spawnHelper } from "../../src/helper.ts";
import { Lease } from "../../src/lease.ts";
import { identify } from "../../src/identity.ts";
import { openTestStore } from "./sqlite-store.ts";

const t0 = Date.now();
const [dbPath, json] = process.argv.slice(2);
const arg = JSON.parse(json);
const store = openTestStore(dbPath);
const lease = new Lease(store);
const id = arg.id ?? `${randomBytes(12).toString("hex")}.1`;
const events: Record<string, unknown>[] = [];
const factory = fileURLToPath(new URL("./mini-factory.ts", import.meta.url));
if (arg.waitForGo) {
  // started ahead of time, so process start-up doesn't decide whether the call lands inside a 500 ms stall
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  await new Promise<void>((r) => process.stdin.once("data", () => r()));
}
const started = Date.now();
const r = await submit("carton.commit", { id, actor: identify(), op: arg.op ?? { kind: "commit", ops: arg.ops }, waitMs: arg.waitMs }, {
  lease,
  needsHelper: async () => true,
  spawnHelper: (seen) => { spawnHelper({ dbPath, seen, factory, config: arg.config, idleMs: arg.idleMs }); },
  retryOnReset: arg.retryOnReset ?? true,
  log: (e) => events.push({ t: Date.now(), ...e }),
});
process.stdout.write(JSON.stringify({ id, processStarted: t0, started, ended: Date.now(), r, events }) + "\n");
process.stdin.destroy();
await store.close();
