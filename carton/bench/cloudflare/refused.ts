// A client whose session the host refuses (a token for another project: what an expired or revoked session looks
// like to the host) left running for `--seconds`: how often does it try again, and what does each try cost? The
// Worker's requests in the window are read back from analytics (cost.ts) to count the probes too.
//   node bench/cloudflare/refused.ts --host r2 --seconds 60 [--client '{"maxBackoffMs":…}']
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sync } from "@carton/core";
import { webSocketTransport } from "@carton/server-node";
import { DOC0, schema, SCHEMA_VERSION, tokenFor, wsUrl, now, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({ options: { host: { type: "string", default: "r2" }, seconds: { type: "string", default: "60" }, client: { type: "string", default: "" }, tag: { type: "string", default: "" } } });
const host = a.host as HostName, S = Number(a.seconds);
const runId = `refused-${host}-${S}s${a.tag ? `-${a.tag}` : ""}-${Date.now().toString(36)}`;
const g = await guard({ test: runId, workersReq: Math.ceil(S * 10) + 20 });
const q = new sync.ReplicaQueue(schema);
q.addBranch({ id: "main", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
const attempts: { t: number; code?: string; error: string }[] = [];
const start = new Date().toISOString();
const client = sync.createSyncClient(q, {
  transport: webSocketTransport(),
  url: wsUrl(host, "refused-a"),
  token: await tokenFor("refused-b", "stranger"), // valid signature, another project: the host answers 403
  branchId: "main",
  schemaVersion: SCHEMA_VERSION,
  ...(a.client ? JSON.parse(a.client) : {}),
  onEvent: (e) => void (e.type === "error" && attempts.push({ t: now(), code: e.code, error: e.error.slice(0, 120) })),
});
client.start();
await new Promise((r) => setTimeout(r, S * 1000));
client.stop();
const r = { runId, host, seconds: S, client: a.client || null, window: { start, end: new Date().toISOString() }, attempts: attempts.length, perMinute: (attempts.length * 60) / S, codes: [...new Set(attempts.map((x) => x.code))], sample: attempts[0]?.error, gapsMs: attempts.slice(1).map((x, i) => Math.round(x.t - attempts[i]!.t)) };
writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(r, null, 1));
endTest(g.id, { attempts: attempts.length });
console.log(JSON.stringify({ ...r, gapsMs: r.gapsMs.slice(0, 12) }));
process.exit(0);
