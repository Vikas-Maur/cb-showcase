// What each run really used, from Cloudflare's GraphQL Analytics (they lag a few minutes; run this after): the run's
// project room (one Durable Object per project: the object in the host's ProjectRoom namespace that first appears in
// the run's window and took the most requests; inboundWebsocketMsgCount reads 0 for hibernatable sockets, so a room's
// requests, which include every inbound WebSocket message, are the count), its CPU time, active time (→ GB-s at 128 MB), rows read and
// written, WebSocket messages in and out, requests; and the Worker's requests in the window. Writes `<run>.cost.json`
// next to each run and prints per-edit figures.
//
//   node bench/cloudflare/cost.ts [run-id-substring]
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gql, ACCOUNT } from "./guard.ts";

export const NAMESPACES = {
  r2: { room: "cc8146d5f27843e68d666f18651203f2", vault: "e9a7fbec358f40e4a1d386cbef255f10", script: "carton-lab-r2" },
  nor2: { room: "7160eb0142534f11a2c6adc25e631d31", vault: "7b1ed609c136426fbb1667b3f14166c8", script: "carton-lab-nor2" },
} as const;
const RUNS = process.env.CARTON_LAB_RUNS ?? "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/carton-build/cf-lab/runs";
const minute = (iso: string, up = false) => {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  if (up) d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d.toISOString().replace(/\.\d+Z$/, "Z");
};

export async function costOf(host: "r2" | "nor2", start: string, end: string) {
  const ns = NAMESPACES[host];
  const f = `datetime_geq:"${minute(start)}", datetime_leq:"${minute(end, true)}"`;
  const d = await gql(`{ viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) {
    p: durableObjectsPeriodicGroups(limit:5000, filter:{${f}, namespaceId_in:["${ns.room}","${ns.vault}"]}) { sum { activeTime cpuTime rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount subrequests exceededCpuErrors exceededMemoryErrors } max { activeWebsocketConnections } dimensions { namespaceId objectId datetimeMinute } }
    i: durableObjectsInvocationsAdaptiveGroups(limit:5000, filter:{${f}, namespaceId_in:["${ns.room}","${ns.vault}"]}) { sum { requests } dimensions { namespaceId objectId status } }
    w: workersInvocationsAdaptive(limit:1000, filter:{${f}, scriptName:"${ns.script}"}) { sum { requests errors subrequests cpuTimeUs } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { status } }
  } } }`);
  const acc = d.viewer.accounts[0];
  const objs = new Map<string, any>();
  for (const g of acc.p) {
    const k = `${g.dimensions.namespaceId}/${g.dimensions.objectId}`;
    const o = objs.get(k) ?? { ns: g.dimensions.namespaceId === ns.room ? "room" : "vault", objectId: g.dimensions.objectId, first: g.dimensions.datetimeMinute, activeTime: 0, cpuTime: 0, rowsRead: 0, rowsWritten: 0, in: 0, out: 0, subrequests: 0, exceededCpu: 0, exceededMem: 0, maxSockets: 0, requests: 0 };
    o.first = o.first < g.dimensions.datetimeMinute ? o.first : g.dimensions.datetimeMinute;
    o.activeTime += g.sum.activeTime; o.cpuTime += g.sum.cpuTime; o.rowsRead += g.sum.rowsRead; o.rowsWritten += g.sum.rowsWritten;
    o.in += g.sum.inboundWebsocketMsgCount; o.out += g.sum.outboundWebsocketMsgCount; o.subrequests += g.sum.subrequests;
    o.exceededCpu += g.sum.exceededCpuErrors; o.exceededMem += g.sum.exceededMemoryErrors; o.maxSockets = Math.max(o.maxSockets, g.max.activeWebsocketConnections);
    objs.set(k, o);
  }
  const statuses: Record<string, number> = {};
  for (const g of acc.i) {
    const k = `${g.dimensions.namespaceId}/${g.dimensions.objectId}`;
    const o = objs.get(k);
    if (o) o.requests += g.sum.requests;
    statuses[g.dimensions.status] = (statuses[g.dimensions.status] ?? 0) + g.sum.requests;
  }
  const worker = acc.w.reduce((s: any, g: any) => ({ requests: s.requests + g.sum.requests, errors: s.errors + g.sum.errors, cpuTimeUs: s.cpuTimeUs + g.sum.cpuTimeUs, subrequests: s.subrequests + g.sum.subrequests, p50: Math.max(s.p50, g.quantiles.cpuTimeP50), p99: Math.max(s.p99, g.quantiles.cpuTimeP99), statuses: { ...s.statuses, [g.dimensions.status]: g.sum.requests } }), { requests: 0, errors: 0, cpuTimeUs: 0, subrequests: 0, p50: 0, p99: 0, statuses: {} });
  return { objects: [...objs.values()], doStatuses: statuses, worker };
}

if (import.meta.main) {
  const filter = process.argv[2] ?? "";
  const files = readdirSync(RUNS).filter((f) => f.endsWith(".json") && !f.endsWith(".cost.json") && f.includes(filter));
  for (const f of files.sort()) {
    const run = JSON.parse(readFileSync(join(RUNS, f), "utf8"));
    if (!run.window || !run.host) continue;
    const out = join(RUNS, f.replace(/\.json$/, ".cost.json"));
    if (existsSync(out) && !process.env.FORCE) continue;
    if (Date.now() - Date.parse(run.window.end) < 4 * 60_000) { console.log(`${run.runId}: too fresh for analytics`); continue; }
    const c = await costOf(run.host, run.window.start, run.window.end);
    // the run's room: a room object first seen in the window, with the most inbound messages
    const rooms = c.objects.filter((o) => o.ns === "room" && o.first >= minute(run.window.start)).sort((x, y) => y.requests - x.requests);
    const room = rooms[0];
    const edits = run.commits || 1;
    const per = room && {
      cpuMsPerRequest: room.cpuTime / 1000 / Math.max(1, room.requests),
      cpuMsPerEdit: room.cpuTime / 1000 / edits,
      outboundMsgsPerEdit: room.out / edits,
      rowsWrittenPerEdit: room.rowsWritten / edits,
      rowsReadPerEdit: room.rowsRead / edits,
      doRequestsPerEdit: room.requests / edits,
      gbSeconds: (room.activeTime / 1e6) * 0.128,
      activeSec: room.activeTime / 1e6,
      workerRequests: c.worker.requests,
    };
    writeFileSync(out, JSON.stringify({ runId: run.runId, room, per, others: c.objects.filter((o) => o !== room), worker: c.worker, doStatuses: c.doStatuses }, null, 1));
    console.log(run.runId, JSON.stringify(per));
  }
}
