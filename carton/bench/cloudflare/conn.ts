// What a connect costs: `--n` connects to one project's room, one after another, each a real client (core's
// ReplicaQueue + SyncClient over the WebSocket transport, carrying the person as the app's hello does) that opens,
// waits until it is up to date, and closes. `--mode fresh` is a new replica each time (opening the project on a new
// device); `--mode reconnect` keeps one replica (the same queue, so its hello names the head it has), as after
// sleep/wake or a network change. The connects start on a fresh minute after the cut's adoption, so the analytics'
// per-minute groups hold the connects alone. Read back later with analyze.ts (it needs the analytics' lag).
//
//   node bench/cloudflare/conn.ts --host r2 --n 20 --mode fresh --rep 1
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sync } from "@carton/core";
import { webSocketTransport } from "@carton/server-node";
import { adopt, tokenFor, now, DOC0, schema, SCHEMA_VERSION, HOSTS, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { idsOf } from "./objcost.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({ options: { host: { type: "string", default: "r2" }, n: { type: "string", default: "20" }, mode: { type: "string", default: "fresh" }, rep: { type: "string", default: "1" }, tag: { type: "string", default: "" } } });
const host = a.host as HostName;
const N = Number(a.n);
const mode = a.mode as "fresh" | "reconnect";
const runId = `conn-${host}-${mode}-${N}x-r${a.rep}${a.tag ? `-${a.tag}` : ""}-${Date.now().toString(36)}`;
const projectId = runId;
const branch = "main";
const g = await guard({ test: runId, workersReq: N * 3 + 10, doReq: N * 6 + 20, doRowsWritten: N * 6 + 50, doRowsRead: N * 50 + 500, doGBs: 20 });
const t0 = Date.now();
await adopt(host, projectId, branch);
// start on a fresh minute, 2 s in: the adoption's use stays in earlier minutes
const startAt = Math.ceil((Date.now() + 1000) / 60_000) * 60_000 + 2000;
await new Promise((r) => setTimeout(r, startAt - Date.now()));
const token = await tokenFor(projectId, "person0");
const url = `${HOSTS[host].replace(/^http/, "ws")}/api/projects/${projectId}/ws`;

let q: sync.ReplicaQueue | null = null;
const replica = () => {
  const r = new sync.ReplicaQueue(schema);
  r.addBranch({ id: branch, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
  return r;
};
const times: number[] = [];
const sent: Record<string, number> = {};
const tStart = now();
for (let i = 0; i < N; i++) {
  if (mode === "fresh" || !q) q = replica();
  const base = webSocketTransport({});
  const t = now();
  const up = new Promise<void>((ok, no) => {
    const timer = setTimeout(() => no(new Error(`connect ${i} timed out`)), 30_000);
    const client = sync.createSyncClient(q!, {
      transport: { ...base, async connect(u, o) { const c = await base.connect(u, o); return { get open() { return c.open; }, send: (m) => { sent[m.type] = (sent[m.type] ?? 0) + 1; c.send(m); }, onMessage: (f) => c.onMessage(f), onClose: (f) => c.onClose(f), close: () => c.close() }; } },
      url, token, branchId: branch, schemaVersion: SCHEMA_VERSION,
      identity: () => ({ id: "person0", name: "Person Zero" }),
      onEvent: (e) => {
        if (e.type === "status" && e.status === "up-to-date") {
          clearTimeout(timer);
          times.push(now() - t);
          client.stop();
          ok();
        }
      },
    });
    client.start();
  });
  await up;
  await new Promise((r) => setTimeout(r, 1000)); // the close reaches the room before the next opens
}
const tEnd = now();
const result = {
  runId, projectId, host, mode, n: N, rep: Number(a.rep),
  window: { start: new Date(t0).toISOString(), end: new Date().toISOString() },
  phases: { connects: Math.round(tStart), connectsEnd: Math.round(tEnd) },
  ids: await idsOf(host, projectId),
  connectMs: times.map(Math.round),
  sentByType: sent,
};
mkdirSync(RUNS_DIR, { recursive: true });
writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(result, null, 1));
endTest(g.id, { connects: N });
console.log(JSON.stringify({ runId, n: N, mode, connectMsP50: [...times].sort((x, y) => x - y)[Math.floor(times.length / 2)], sent }));
process.exit(0);
