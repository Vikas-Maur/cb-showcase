// Cloudflare's per-request limits against Carton, on the deployed Workers: what bites, and what the client sees.
//   body     one upload part of N MiB through the media API (Free plan: 100 MB request bodies; a Worker has 128 MB)
//   change   one change of N MiB through a real SyncClient (over 1 MiB it travels as an envelope through the blob
//            store; the room caps a message at 24 MiB; a DO receives WebSocket messages of at most 32 MiB)
//   frame    one raw WebSocket text frame of N MiB, no envelope (what an old or foreign client would send)
//   heads    POST /blobs/heads with N keys (each key is R2 calls: the internal-services subrequest limit)
//   node bench/cloudflare/limits.ts --host r2 --probe body --mib 99
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sync } from "@carton/core";
import { webSocketTransport } from "@carton/server-node";
import { hostMessageBlobs } from "@carton/host-http/client";
import { HOSTS, DOC0, schema, SCHEMA_VERSION, adopt, tokenFor, wsUrl, now, secrets, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({ options: { host: { type: "string", default: "r2" }, probe: { type: "string" }, mib: { type: "string", default: "1" }, n: { type: "string", default: "1000" } } });
const host = a.host as HostName, MiB = 1 << 20, mib = Number(a.mib);
const runId = `limits-${host}-${a.probe}-${a.probe === "heads" ? a.n : `${mib}MiB`}-${Date.now().toString(36)}`;
const projectId = runId.replace(/\./g, "_");
const origin = HOSTS[host];
const g = await guard({ test: runId, workersReq: 50, doReq: 100, uploadBytes: mib * MiB * 2, doRowsWritten: Math.ceil(mib) * 6 + 100, ...(host === "r2" ? { r2ClassA: 40, r2ClassB: Number(a.n) * 2 + 20, r2StoredBytes: mib * MiB * 2 } : { doStoredBytes: mib * MiB * 3 }) });
const token = await tokenFor(projectId, "prober");
const auth = { authorization: `Bearer ${token}` };
const out: Record<string, unknown> = { runId, host, probe: a.probe, mib, start: new Date().toISOString() };

if (a.probe === "body") {
  const key = `m/${"ab".repeat(32)}`;
  const c = await fetch(`${origin}/api/projects/${projectId}/uploads`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const { uploadId } = (await c.json()) as { uploadId: string };
  const body = new Uint8Array(Math.round(mib * MiB)).fill(7);
  const t0 = now();
  const r = await fetch(`${origin}/api/projects/${projectId}/uploads/${encodeURIComponent(uploadId)}/1?key=${encodeURIComponent(key)}`, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body }).catch((e) => ({ status: -1, text: async () => String(e), headers: new Headers() }) as unknown as Response);
  out.status = r.status;
  out.ms = now() - t0;
  out.answer = (await r.text()).slice(0, 300);
  out.cfRay = r.headers.get("cf-ray");
  await fetch(`${origin}/api/projects/${projectId}/uploads/${encodeURIComponent(uploadId)}?key=${encodeURIComponent(key)}`, { method: "DELETE", headers: auth }).catch(() => {});
} else if (a.probe === "change") {
  await adopt(host, projectId, "main");
  const q = new sync.ReplicaQueue(schema);
  q.addBranch({ id: "main", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
  const events: unknown[] = [];
  const client = sync.createSyncClient(q, { transport: webSocketTransport(), url: wsUrl(host, projectId), token, branchId: "main", schemaVersion: SCHEMA_VERSION, blobs: hostMessageBlobs({ origin, projectId, token }), onEvent: (e) => void (["reject", "error", "offline", "status"].includes(e.type) && events.push({ t: Math.round(now()), ...e })) });
  const settled = new Promise<string>((ok) => q.on((e) => (e.type === "confirmed" ? ok("confirmed") : e.type === "rejected" ? ok(`rejected: ${e.reason}`) : undefined)));
  client.start();
  await client.whenCaughtUp(30_000);
  const notes = "x".repeat(Math.round(mib * MiB));
  const t0 = now();
  q.commit("main", { id: `big.${Date.now()}`, author: { kind: "human", id: "prober" }, ops: [{ op: "set", path: ["timelineItems", "c0", "notes"], value: notes }], at: Date.now() });
  client.pump();
  out.outcome = await Promise.race([settled, new Promise((r) => setTimeout(() => r("no answer in 120 s"), 120_000))]);
  out.ms = now() - t0;
  out.events = events.slice(-8);
  out.stats = client.stats;
  // and a small edit after it still goes through
  const t1 = now();
  const small = new Promise<string>((ok) => q.on((e) => (e.type === "confirmed" && e.row.id.startsWith("small") ? ok("confirmed") : undefined)));
  q.commit("main", { id: `small.${Date.now()}`, author: { kind: "human", id: "prober" }, ops: [{ op: "set", path: ["timelineItems", "c1", "opacity"], value: 0.5 }], at: Date.now() });
  client.pump();
  out.afterwards = await Promise.race([small, new Promise((r) => setTimeout(() => r("no answer in 60 s"), 60_000))]);
  out.afterwardsMs = now() - t1;
  client.stop();
} else if (a.probe === "frame") {
  await adopt(host, projectId, "main");
  const ws = new WebSocket(wsUrl(host, projectId), ["carton.v1", `carton.auth.${token}`]);
  const t0 = now();
  out.result = await new Promise((ok) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", branchId: "main", have: 0, pending: [], rids: [], schemaVersion: SCHEMA_VERSION }));
      setTimeout(() => ws.send(JSON.stringify({ type: "push", branchId: "main", epoch: 1, changes: [{ id: "frame.1", notes: "x".repeat(Math.round(mib * MiB)) }] })), 1000);
    };
    const msgs: string[] = [];
    ws.onmessage = (e) => void msgs.push(String(e.data).slice(0, 160));
    ws.onclose = (e) => ok({ closed: e.code, reason: e.reason, afterMs: Math.round(now() - t0), msgs: msgs.slice(-4) });
    setTimeout(() => ok({ open: true, afterMs: Math.round(now() - t0), msgs: msgs.slice(-4) }), 60_000);
  });
  try { ws.close(); } catch {}
} else if (a.probe === "heads") {
  const keys = Array.from({ length: Number(a.n) }, (_, i) => `m/${i.toString(16).padStart(64, "0")}`);
  const t0 = now();
  const r = await fetch(`${origin}/api/projects/${projectId}/blobs/heads`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ keys }) });
  out.status = r.status;
  out.ms = now() - t0;
  const j = (await r.json().catch(() => null)) as { blobs?: unknown[]; error?: string } | null;
  out.answered = j?.blobs?.length ?? null;
  out.error = j?.error ?? null;
}
// clean up whatever the probe stored
await fetch(`${origin}/api/lab/projects/${projectId}/purge`, { method: "POST", headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } }).catch(() => {});
out.end = new Date().toISOString();
writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(out, null, 1));
endTest(g.id, {}, { uploaded: a.probe === "heads" ? 0 : mib * MiB });
console.log(JSON.stringify(out).slice(0, 1200));
process.exit(0);
