// The free-tier guard: every lab test runs this first. It reads this month's and today's real usage from Cloudflare's
// GraphQL Analytics API (R2 operations by action, R2 storage, Workers requests, Durable Object requests, duration,
// rows), adds the test's worst case, and refuses to start if any ceiling could be crossed. Analytics lag by minutes,
// so it also keeps its own ledger (outside the repo) of what each test declared, and counts a test's declared use on
// top of the analytics until LAG_MS after it ended.
//
//   node bench/cloudflare/guard.ts status
//   node bench/cloudflare/guard.ts check '{"test":"sync-good","workers":200,"doReq":3000}'
//   import { guard, endTest } from "./guard.ts"
//
// Ceilings (the lab's rules, against the plans' published free amounts, fetched 2026-11-01):
// - R2, per month: Class A 1M → 40% = 400k; Class B 10M → 4M; storage 10 GB-month → 4 GB-month; never more than
//   4 GB stored at once (an email alert fires at 5 GB).
// - Workers Free, per UTC day: 100k requests → 50%.
// - Durable Objects Free, per UTC day: 100k requests, 13,000 GB-s, 5M rows read, 100k rows written → 50% of each;
//   5 GB stored in total → 50%.
// - Upload from this box: 20 GB in total over the lab.
// The day's numbers include the live showcase Worker, which shares the account's limits.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const ACCOUNT = "62355b0692d0804d456d54e711776037";
const TOKEN_FILE = "/home/ubuntu/.config/carton-cf-token";
export const LEDGER_FILE = process.env.CARTON_LAB_LEDGER ?? "/home/ubuntu/.config/carton-lab-ledger.json";
/** How long a finished test's declared use still counts on top of the analytics (they lag a few minutes). */
const LAG_MS = 20 * 60_000;

const GB = 1e9;
export const CEILING = {
  r2ClassA: 400_000,
  r2ClassB: 4_000_000,
  r2GBMonth: 4,
  r2StoredBytes: 4 * GB,
  workersReq: 50_000,
  doReq: 50_000,
  doGBs: 6_500,
  doRowsRead: 2_500_000,
  doRowsWritten: 50_000,
  doStoredBytes: 2.5 * GB,
  uploadBytes: 20 * GB,
};
export type Usage = { [K in keyof typeof CEILING]: number };
export type Estimate = Partial<Usage> & { test: string; limitTest?: boolean };

// R2 operations by class (https://developers.cloudflare.com/r2/pricing/, 2026-11-01). Deletes and aborts are free.
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const FREE_OPS = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

function token(): string {
  const t = process.env.CLOUDFLARE_API_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");
  if (!t) throw new Error("no Cloudflare API token");
  return t;
}

export async function gql<T = any>(query: string): Promise<T> {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = (await r.json()) as { data: T; errors: unknown };
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors).slice(0, 500)}`);
  return j.data;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export interface Analytics {
  at: string;
  usage: Omit<Usage, "uploadBytes">;
  r2ByAction: Record<string, number>;
  r2Unclassified: string[];
  workersByScript: Record<string, { requests: number; errors: number; cpuTimeUs: number; subrequests: number }>;
  doByNamespace: Record<string, Record<string, number>>;
  r2Buckets: Record<string, { objectCount: number; payloadSize: number; uploadCount: number }>;
}

/** Real usage: R2 this month, Workers and Durable Objects today (UTC). */
export async function analytics(now = new Date()): Promise<Analytics> {
  const day = iso(dayStart(now)), month = iso(monthStart(now)), end = iso(now);
  const d = await gql(`{ viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) {
    r2ops: r2OperationsAdaptiveGroups(limit:1000, filter:{datetime_geq:"${month}", datetime_leq:"${end}"}) { sum { requests } dimensions { actionType } }
    r2store: r2StorageAdaptiveGroups(limit:1000, filter:{datetime_geq:"${month}", datetime_leq:"${end}"}) { max { objectCount payloadSize metadataSize uploadCount } dimensions { bucketName datetimeHour } }
    w: workersInvocationsAdaptive(limit:1000, filter:{datetime_geq:"${day}", datetime_leq:"${end}"}) { sum { requests errors subrequests cpuTimeUs } dimensions { scriptName } }
    doi: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{datetime_geq:"${day}", datetime_leq:"${end}"}) { sum { requests } dimensions { scriptName } }
    dop: durableObjectsPeriodicGroups(limit:1000, filter:{datetime_geq:"${day}", datetime_leq:"${end}"}) { sum { activeTime cpuTime rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount exceededCpuErrors exceededMemoryErrors subrequests } dimensions { namespaceId } }
    dos: durableObjectsSqlStorageGroups(limit:1000, filter:{date_geq:"${day.slice(0, 10)}"}) { max { storedBytes } dimensions { date } }
  } } }`);
  const a = d.viewer.accounts[0];
  const r2ByAction: Record<string, number> = {};
  let r2ClassA = 0, r2ClassB = 0;
  const r2Unclassified: string[] = [];
  for (const g of a.r2ops) {
    const act = g.dimensions.actionType as string, n = Number(g.sum.requests);
    r2ByAction[act] = (r2ByAction[act] ?? 0) + n;
    if (CLASS_A.has(act)) r2ClassA += n;
    else if (CLASS_B.has(act)) r2ClassB += n;
    else if (!FREE_OPS.has(act)) (r2ClassA += n), r2Unclassified.push(act); // unknown: counted as the dearer class
  }
  // storage: the newest hour's max per bucket is what is stored now; GB-month is the mean over the month's hours
  const r2Buckets: Analytics["r2Buckets"] = {};
  const latest = new Map<string, string>();
  const byHour = new Map<string, number>();
  for (const g of a.r2store) {
    const b = g.dimensions.bucketName as string, h = g.dimensions.datetimeHour as string;
    byHour.set(h, (byHour.get(h) ?? 0) + Number(g.max.payloadSize) + Number(g.max.metadataSize));
    if (!latest.has(b) || latest.get(b)! < h) {
      latest.set(b, h);
      r2Buckets[b] = { objectCount: Number(g.max.objectCount), payloadSize: Number(g.max.payloadSize), uploadCount: Number(g.max.uploadCount) };
    }
  }
  const hoursInMonth = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - monthStart(now).getTime()) / 3600_000;
  const byteHours = [...byHour.values()].reduce((s, v) => s + v, 0);
  const workersByScript: Analytics["workersByScript"] = {};
  let workersReq = 0;
  for (const g of a.w) {
    workersByScript[g.dimensions.scriptName] = { requests: g.sum.requests, errors: g.sum.errors, cpuTimeUs: g.sum.cpuTimeUs, subrequests: g.sum.subrequests };
    workersReq += Number(g.sum.requests);
  }
  const doReq = a.doi.reduce((s: number, g: any) => s + Number(g.sum.requests), 0);
  const doByNamespace: Analytics["doByNamespace"] = {};
  let activeUs = 0, rowsRead = 0, rowsWritten = 0;
  for (const g of a.dop) {
    doByNamespace[g.dimensions.namespaceId] = g.sum;
    activeUs += Number(g.sum.activeTime);
    rowsRead += Number(g.sum.rowsRead);
    rowsWritten += Number(g.sum.rowsWritten);
  }
  const doStored = Math.max(0, ...a.dos.map((g: any) => Number(g.max.storedBytes)));
  return {
    at: iso(now),
    usage: {
      r2ClassA,
      r2ClassB,
      r2GBMonth: byteHours / GB / hoursInMonth,
      r2StoredBytes: Object.values(r2Buckets).reduce((s, b) => s + b.payloadSize, 0),
      workersReq,
      doReq,
      // duration is billed for the 128 MB a Durable Object is allocated (DO pricing page, footnote 5)
      doGBs: (activeUs / 1e6) * 0.128,
      doRowsRead: rowsRead,
      doRowsWritten: rowsWritten,
      doStoredBytes: doStored,
    },
    r2ByAction,
    r2Unclassified,
    workersByScript,
    doByNamespace,
    r2Buckets,
  };
}

// ------------------------------------------------------------------ the ledger

interface LedgerEntry {
  test: string;
  start: number;
  end?: number;
  declared: Partial<Usage>;
  /** Our own counters, filled by the harness when the test ends. */
  counted?: Partial<Usage> & Record<string, number>;
}
interface Ledger {
  entries: LedgerEntry[];
  /** Bytes this lab holds in R2 / the DO vault right now (added on upload, removed on delete). */
  heldR2Bytes: number;
  heldDoBytes: number;
  /** Bytes sent from this box over the lab (uploads). */
  uploadedBytes: number;
}

export function loadLedger(): Ledger {
  if (!existsSync(LEDGER_FILE)) return { entries: [], heldR2Bytes: 0, heldDoBytes: 0, uploadedBytes: 0 };
  return JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Ledger;
}
export function saveLedger(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 1), { mode: 0o600 });
}

/** Declared use of tests still running or ended within LAG_MS (analytics may not show them yet), in this period. */
function inFlight(l: Ledger, now: number, sinceMs: number): Partial<Usage> {
  const sum: Partial<Usage> = {};
  for (const e of l.entries) {
    if (e.end !== undefined && now - e.end > LAG_MS) continue;
    if ((e.end ?? now) < sinceMs) continue;
    for (const [k, v] of Object.entries(e.declared)) (sum as any)[k] = ((sum as any)[k] ?? 0) + Number(v);
  }
  return sum;
}

export interface Verdict {
  ok: boolean;
  why: string[];
  projected: Usage;
  analytics: Analytics;
}

/** The check alone: would this test, on top of what is used and in flight, stay under every ceiling? */
export async function check(est: Estimate, now = new Date()): Promise<Verdict> {
  const why: string[] = [];
  if (est.limitTest) {
    const h = now.getUTCHours(), m = now.getUTCMinutes();
    if (!(h === 23 && m < 50)) why.push(`a test that hits a daily limit runs only 23:00–23:50 UTC (now ${iso(now)})`);
    if (!process.env.CARTON_LAB_LIMIT_TEST_APPROVED) why.push("a limit test needs the orchestrator's yes (CARTON_LAB_LIMIT_TEST_APPROVED)");
  }
  const an = await analytics(now);
  const l = loadLedger();
  const dayFlight = inFlight(l, now.getTime(), dayStart(now).getTime());
  const monthFlight = inFlight(l, now.getTime(), monthStart(now).getTime());
  const monthly = new Set(["r2ClassA", "r2ClassB", "r2GBMonth"]);
  const projected = {} as Usage;
  for (const k of Object.keys(CEILING) as (keyof Usage)[]) {
    let base: number;
    if (k === "uploadBytes") base = l.uploadedBytes;
    else if (k === "r2StoredBytes") base = Math.max(an.usage.r2StoredBytes, l.heldR2Bytes);
    else if (k === "doStoredBytes") base = an.usage.doStoredBytes + l.heldDoBytes;
    else base = an.usage[k] + Number((monthly.has(k) ? monthFlight : dayFlight)[k] ?? 0);
    projected[k] = base + Number(est[k] ?? 0);
    if (!est.limitTest && projected[k] > CEILING[k]) why.push(`${k}: ${fmt(projected[k])} would pass the ceiling ${fmt(CEILING[k])}`);
  }
  if (an.r2Unclassified.length) why.push(`unknown R2 actions counted as Class A: ${an.r2Unclassified.join(", ")}`);
  return { ok: why.filter((w) => !w.startsWith("unknown")).length === 0, why, projected, analytics: an };
}

/**
 * Check, then record the test as started. Throws when it must not run. With CARTON_LAB_GUARD_WAIT_SEC set, a test the
 * ceilings refuse waits (re-checking every 30 s, up to that long) for earlier tests' declared use to age out of the
 * lag window, instead of failing at once: a queue of runs then pauses rather than skipping them. The ceilings are the
 * same either way.
 */
export async function guard(est: Estimate): Promise<{ id: number; verdict: Verdict }> {
  const waitUntil = Date.now() + Number(process.env.CARTON_LAB_GUARD_WAIT_SEC ?? 0) * 1000;
  let verdict = await check(est);
  while (!verdict.ok && Date.now() < waitUntil && !est.limitTest) {
    console.error(`guard: ${est.test} waits: ${verdict.why.filter((w) => !w.startsWith("unknown")).join("; ")}`);
    await new Promise((r) => setTimeout(r, 30_000));
    verdict = await check(est);
  }
  if (!verdict.ok) throw new Error(`guard refused ${est.test}:\n  ${verdict.why.join("\n  ")}`);
  const l = loadLedger();
  const { test, limitTest: _lt, ...declared } = est;
  l.entries.push({ test, start: Date.now(), declared });
  saveLedger(l);
  return { id: l.entries.length - 1, verdict };
}

/** Mark a test ended, with what the harness counted itself; adjust the bytes held and uploaded. */
export function endTest(id: number, counted: Record<string, number> = {}, held: { r2?: number; doVault?: number; uploaded?: number } = {}): void {
  const l = loadLedger();
  const e = l.entries[id];
  if (e) (e.end = Date.now()), (e.counted = counted);
  l.heldR2Bytes = Math.max(0, l.heldR2Bytes + (held.r2 ?? 0));
  l.heldDoBytes = Math.max(0, l.heldDoBytes + (held.doVault ?? 0));
  l.uploadedBytes += held.uploaded ?? 0;
  saveLedger(l);
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2));

export function table(v: Verdict): string {
  const rows = (Object.keys(CEILING) as (keyof Usage)[]).map((k) => {
    const pct = (100 * v.projected[k]) / CEILING[k];
    return `${k.padEnd(14)} ${fmt(v.projected[k]).padStart(10)} / ${fmt(CEILING[k]).padStart(8)}  ${pct.toFixed(1).padStart(5)}% of the lab ceiling`;
  });
  return rows.join("\n");
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "status") {
    const v = await check({ test: "status" });
    console.log(`analytics at ${v.analytics.at}`);
    console.log(table(v));
    console.log("R2 by action (month):", JSON.stringify(v.analytics.r2ByAction));
    console.log("R2 buckets:", JSON.stringify(v.analytics.r2Buckets));
    console.log("Workers by script (today):", JSON.stringify(v.analytics.workersByScript));
    console.log("ledger:", JSON.stringify((({ entries, ...rest }) => ({ ...rest, tests: entries.length }))(loadLedger())));
    if (v.why.length) console.log("notes:", v.why.join("; "));
  } else if (cmd === "check") {
    const v = await check(JSON.parse(arg ?? "{}"));
    console.log(table(v));
    console.log(v.ok ? "OK" : `REFUSED:\n  ${v.why.join("\n  ")}`);
    process.exit(v.ok ? 0 : 1);
  } else {
    console.log("usage: guard.ts status | check '<estimate json>'");
    process.exit(2);
  }
}
