// What one run used, read per object so runs may share the clock: a Durable Object's requests, active time (GB-s at
// 128 MB), CPU and rows by its id (the lab's /ids route names a project's objects), R2 operations by object name (a
// project's keys, and the upload records of its multipart uploads), and the Worker's requests and CPU from the tail
// (tail.ts). Analytics lag a few minutes: read a window at least 5 minutes after it ended.
import { gql, ACCOUNT } from "./guard.ts";
import { HOSTS, secrets, type HostName } from "./common.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tailOf, summarize, TAIL_DIR } from "./tail.ts";

export const SCRIPT = { r2: "carton-lab-r2", nor2: "carton-lab-nor2" } as const;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** The project's Durable Object ids (room, vault, today's write-cap counter room). */
export async function idsOf(host: HostName, projectId: string): Promise<{ room: string; vault: string | null; writeCap: string }> {
  const r = await fetch(`${HOSTS[host]}/api/lab/projects/${projectId}/ids`, { headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } });
  if (!r.ok) throw new Error(`ids: ${r.status}`);
  return (await r.json()) as any;
}

export interface DoUse { requests: number; activeSec: number; gbs: number; cpuMs: number; rowsRead: number; rowsWritten: number; wsIn: number; wsOut: number; maxSockets: number; statuses: Record<string, number>; types: Record<string, number>; minutes: Record<string, { requests: number; activeSec: number; rowsWritten: number; rowsRead: number; cpuMs: number; types: Record<string, number> }> }
const emptyDo = (): DoUse => ({ requests: 0, activeSec: 0, gbs: 0, cpuMs: 0, rowsRead: 0, rowsWritten: 0, wsIn: 0, wsOut: 0, maxSockets: 0, statuses: {}, types: {}, minutes: {} });

/** Per object id, in [start, end] (ms; widened to whole minutes), with a per-minute breakdown. */
export async function doUse(objectIds: string[], start: number, end: number): Promise<Record<string, DoUse>> {
  const s = new Date(start); s.setUTCSeconds(0, 0);
  const e = new Date(end); e.setUTCSeconds(59, 999);
  const f = `datetime_geq:"${iso(s.getTime())}", datetime_leq:"${iso(e.getTime())}", objectId_in:${JSON.stringify(objectIds)}`;
  const d = await gql(`{ viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) {
    p: durableObjectsPeriodicGroups(limit:10000, filter:{${f}}) { sum { activeTime cpuTime rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount } max { activeWebsocketConnections } dimensions { objectId datetimeMinute } }
    i: durableObjectsInvocationsAdaptiveGroups(limit:10000, filter:{${f}}) { sum { requests } dimensions { objectId status type datetimeMinute } }
  } } }`);
  const acc = d.viewer.accounts[0];
  const out: Record<string, DoUse> = Object.fromEntries(objectIds.map((id) => [id, emptyDo()]));
  const min = (o: DoUse, m: string) => (o.minutes[m] ??= { requests: 0, activeSec: 0, rowsWritten: 0, rowsRead: 0, cpuMs: 0, types: {} });
  for (const g of acc.p) {
    const o = out[g.dimensions.objectId]!;
    o.activeSec += g.sum.activeTime / 1e6; o.cpuMs += g.sum.cpuTime / 1000; o.rowsRead += g.sum.rowsRead; o.rowsWritten += g.sum.rowsWritten;
    o.wsIn += g.sum.inboundWebsocketMsgCount; o.wsOut += g.sum.outboundWebsocketMsgCount; o.maxSockets = Math.max(o.maxSockets, g.max.activeWebsocketConnections);
    const m = min(o, g.dimensions.datetimeMinute);
    m.activeSec += g.sum.activeTime / 1e6; m.rowsWritten += g.sum.rowsWritten; m.rowsRead += g.sum.rowsRead; m.cpuMs += g.sum.cpuTime / 1000;
  }
  for (const g of acc.i) {
    const o = out[g.dimensions.objectId]!;
    o.requests += g.sum.requests;
    o.statuses[g.dimensions.status] = (o.statuses[g.dimensions.status] ?? 0) + g.sum.requests;
    // http (a fetch: the socket's upgrade, a lab route, the write cap), hibernation (a WebSocket message or close
    // delivered to a hibernatable socket), alarm
    o.types[g.dimensions.type] = (o.types[g.dimensions.type] ?? 0) + g.sum.requests;
    const mm = min(o, g.dimensions.datetimeMinute);
    mm.requests += g.sum.requests;
    mm.types[g.dimensions.type] = (mm.types[g.dimensions.type] ?? 0) + g.sum.requests;
  }
  for (const o of Object.values(out)) o.gbs = o.activeSec * 0.128;
  return out;
}

/** Sums an object's minutes in [from, to) (ISO minute strings compare as text). */
export function minutesBetween(u: DoUse, from: number, to: number) {
  const a = iso(Math.ceil(from / 60_000) * 60_000), b = iso(Math.floor(to / 60_000) * 60_000);
  const sum = { minutes: 0, requests: 0, activeSec: 0, gbs: 0, rowsWritten: 0, rowsRead: 0, cpuMs: 0, types: {} as Record<string, number> };
  for (let t = Date.parse(a); t < Date.parse(b); t += 60_000) {
    const m = u.minutes[iso(t)];
    sum.minutes++;
    if (!m) continue;
    sum.requests += m.requests; sum.activeSec += m.activeSec; sum.rowsWritten += m.rowsWritten; sum.rowsRead += m.rowsRead; sum.cpuMs += m.cpuMs;
    for (const [k, v] of Object.entries(m.types)) sum.types[k] = (sum.types[k] ?? 0) + v;
  }
  sum.gbs = sum.activeSec * 0.128;
  return { from: a, to: b, ...sum };
}

// R2's classes (r2/pricing, 2026-11-01), as guard.ts
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

/** R2 operations in [start, end] on objects `match` accepts, by action type and class. */
export async function r2Use(start: number, end: number, match: (objectName: string) => boolean) {
  const s = new Date(start); s.setUTCSeconds(0, 0);
  const e = new Date(end); e.setUTCSeconds(59, 999);
  const d = await gql(`{ viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) {
    r: r2OperationsAdaptiveGroups(limit:10000, filter:{datetime_geq:"${iso(s.getTime())}", datetime_leq:"${iso(e.getTime())}", bucketName:"carton-lab"}) { sum { requests } dimensions { actionType objectName } }
  } } }`);
  const byAction: Record<string, number> = {};
  let classA = 0, classB = 0, free = 0, rows = 0;
  for (const g of d.viewer.accounts[0].r) {
    rows++;
    if (!match(g.dimensions.objectName ?? "")) continue;
    const a = g.dimensions.actionType as string, n = Number(g.sum.requests);
    byAction[a] = (byAction[a] ?? 0) + n;
    if (CLASS_A.has(a)) classA += n;
    else if (CLASS_B.has(a)) classB += n;
    else free += n;
  }
  return { classA, classB, free, byAction, groups: rows };
}

/** The Worker's requests for a project in [start, end] (ms), from the tail; `gap` when the tail wasn't following then. */
export function workerUse(host: HostName, projectId: string, start: number, end: number) {
  const f = join(TAIL_DIR, "gaps.json");
  const gaps: { from: number; to: number }[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  const gap = gaps.some((g) => g.from < end && g.to > start);
  return { ...summarize(tailOf(SCRIPT[host], projectId, start, end)), gap };
}

/**
 * The Worker's requests and CPU in [start, end] (ms) from the analytics, for the whole script: a fallback for a run
 * the tail missed, valid only when nothing else used that Worker then. CPU here is sampled (adaptive).
 */
export async function workerScriptUse(host: HostName, start: number, end: number) {
  const d = await gql(`{ viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) {
    w: workersInvocationsAdaptive(limit:1000, filter:{datetime_geq:"${iso(start)}", datetime_leq:"${iso(end)}", scriptName:"${SCRIPT[host]}"}) { sum { requests cpuTimeUs } dimensions { status } }
  } } }`);
  const w = d.viewer.accounts[0].w as any[];
  return { requests: w.reduce((s, g) => s + g.sum.requests, 0), cpuMs: w.reduce((s, g) => s + g.sum.cpuTimeUs, 0) / 1000 };
}

