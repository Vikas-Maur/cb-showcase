// The Cardboard app on one machine, as far as Carton is concerned: its library worker's engine thread (`@carton/local`
// EngineThread) holding the sync lease, with Carton and the materializer on it (app-factory.ts). `cb` processes find it
// through the lease row and hand their writes to it over its control socket.
//   app <bundle> <projectId> <json config>
// Prints {ready, pid, nonce}; then reads one JSON command per line and answers with the same `seq`:
//   {cmd: "serve", req}   a request to the engine thread (a cb write, or an `e2e` request: gui, idle, state)
//   {cmd: "exit"}         hand the lease over and stop
import { createInterface } from "node:readline";
import { locateCartonDb } from "@carton/store-sqlite";
import { EngineThread } from "@carton/local";
import { assertInScratch, dataDirFor, support } from "./env.ts";

const [bundle, projectId, json = "{}"] = process.argv.slice(2);
const { dbPath } = locateCartonDb({ bundleDir: bundle!, projectId: projectId!, appDataDir: dataDirFor(bundle!) });
assertInScratch(dbPath, "carton.db");
const th = await EngineThread.start({ dbPath, factory: support("app-factory.ts"), config: { projectDir: bundle, projectId, ...JSON.parse(json) } });
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, nonce: th.nonce, dbPath }) + "\n");
// never outlive a test run that died without killing us
setTimeout(() => process.exit(0), Number(process.env.CARTON_E2E_APP_TTL_MS ?? 600_000)).unref();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  try {
    if (m.cmd === "serve") process.stdout.write(JSON.stringify({ seq: m.seq, result: await th.call("serve", m.req) }) + "\n");
    else if (m.cmd === "exit") {
      await th.stop();
      process.stdout.write(JSON.stringify({ seq: m.seq, ok: true }) + "\n");
      process.exit(0);
    } else throw new Error(`unknown command ${m.cmd}`);
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ seq: m.seq, error: String(e?.message ?? e) }) + "\n");
  }
}
