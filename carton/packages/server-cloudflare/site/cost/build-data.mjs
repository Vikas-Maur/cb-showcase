// Builds site/cost/data.json, the one file the calculator page loads: the lab's measurements (measured.json, schema 1),
// an independent verifier's verdicts on them (verified.json, optional) and Cloudflare's prices (prices.json), checked.
//
//   node site/cost/build-data.mjs <measured.json> [prices.json] [--verified <verified.json>]
//     [--proxy-verified <cf-verify2 verified.json>] [--out <data.json>]                (from packages/server-cloudflare)
//
// Status of each input the page shows:
// - Verified: the verifier confirmed it (by re-running, or by recomputing it from the lab's records), or revised it;
//   a revised input takes the verifier's value, and keeps the lab's as `was`;
// - Measured: from the lab's runs, not re-checked (no verdict, or "not-verified");
// - Estimated: the file says so, or the file lacks a key the model reads, so the model's own figure drives the bill.
//   Never silent: the page counts them in a banner, and the build lists them.
// A structural problem (not schema 1, inputs not an object, a price missing) stops the build; a bad single entry is
// dropped with a warning. Lab keys the model doesn't read are kept and listed on the page as extra measurements.
//
// The lab's file: `git show origin/lab/cloudflare:carton/bench/cloudflare/results/measured.json > /tmp/measured.json`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INPUT_DEFAULTS, INPUT_NOTES } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : undefined;
};
const out = flag("--out") ?? join(here, "data.json");
const verifiedPath = flag("--verified");
const proxyVerifiedPath = flag("--proxy-verified");
const [measuredPath, pricesPath = join(here, "prices.json")] = args;
if (!measuredPath) {
  console.error("usage: node build-data.mjs <measured.json> [prices.json] [--verified verified.json] [--out data.json]");
  process.exit(2);
}

const warnings = [];
const warn = (m) => warnings.push(m);
const fail = (m) => {
  console.error(`build-data: ${m}`);
  process.exit(1);
};
const load = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return fail(`can't read ${p}: ${e.message}`);
  }
};
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const str = (x, max = 2000) => (typeof x === "string" ? x.slice(0, max) : "");
const numOrNull = (x) => (isNum(x) ? x : null);
const strList = (x) => (Array.isArray(x) ? x.filter((r) => typeof r === "string").slice(0, 200) : []);

const measured = load(measuredPath);
const prices = load(pricesPath);
const verified = verifiedPath ? load(verifiedPath) : null;
const proxyVerified = proxyVerifiedPath ? load(proxyVerifiedPath) : null;
let proxyCheck = null;

// ---- measured.json
if (!isObj(measured)) fail("measured.json is not an object");
if (measured.schema !== 1) fail(`measured.json schema is ${JSON.stringify(measured.schema)}, expected 1`);
if (!isObj(measured.inputs)) fail("measured.json has no `inputs` object");
for (const k of ["speeds", "limits"]) if (measured[k] !== undefined && !Array.isArray(measured[k])) fail(`measured.json \`${k}\` is not an array`);
if (measured.networkProfiles !== undefined && !isObj(measured.networkProfiles)) fail("measured.json `networkProfiles` is not an object");

// ---- verified.json: { checked: { commit }, inputs: { key: { verdict, theirs, ours, n, min, max, note } }, speeds: { id: … } }
const VERDICTS = new Set(["confirmed", "confirmed-from-data", "revised", "not-verified"]);
if (verified) {
  if (!isObj(verified) || !isObj(verified.inputs)) fail("verified.json has no `inputs` object");
  const checked = str(verified.checked?.commit, 60);
  const src = str(measured.source?.commit, 60);
  if (checked && src && !checked.startsWith(src.slice(0, 7)) && !src.startsWith(checked.slice(0, 7)))
    warn(`verified.json checked ${checked.slice(0, 8)}; measured.json names ${src.slice(0, 8)} (its generator's HEAD): make sure they're the same file`);
}
const verdictOf = (key) => {
  const v = verified?.inputs?.[key];
  if (!isObj(v)) return null;
  if (!VERDICTS.has(v.verdict)) {
    warn(`verified.json: input ${key} has verdict ${JSON.stringify(v.verdict)}; ignored`);
    return null;
  }
  return v;
};

const INPUT_STATUS = new Set(["measured", "estimated", "verified"]);
const inputs = {};
const raw = {}; // the lab's own values, before revisions
for (const [key, v] of Object.entries(measured.inputs)) {
  if (!isObj(v) || !isNum(v.value) || v.value < 0) {
    warn(`input ${key}: no usable value, dropped (the page shows the model's estimate, marked Estimated)`);
    continue;
  }
  raw[key] = v;
  let status = v.status;
  if (!INPUT_STATUS.has(status)) {
    warn(`input ${key}: status ${JSON.stringify(status)} is not measured|estimated|verified; shown as Estimated`);
    status = "estimated";
  }
  const entry = {
    value: v.value,
    unit: str(v.unit, 120),
    status,
    source: "lab",
    n: numOrNull(v.n),
    min: numOrNull(v.min),
    max: numOrNull(v.max),
    runs: strList(v.runs),
    how: str(v.how),
    verdict: null,
  };
  const vd = status === "estimated" ? null : verdictOf(key);
  if (vd) {
    entry.verdict = vd.verdict;
    entry.check = { value: numOrNull(vd.ours), n: numOrNull(vd.n), min: numOrNull(vd.min), max: numOrNull(vd.max), note: str(vd.note, 1500) };
    if (vd.verdict === "confirmed" || vd.verdict === "confirmed-from-data") entry.status = "verified";
    else if (vd.verdict === "revised") {
      if (isNum(vd.ours) && vd.ours >= 0) {
        entry.status = "verified";
        entry.was = v.value;
        entry.value = vd.ours;
      } else warn(`input ${key}: revised without a usable value; kept as Measured`);
    } else entry.status = "measured"; // not-verified
  } else if (status === "estimated") warn(`input ${key}: the file marks it estimated; it drives the bill and the page counts it as an estimate`);
  inputs[key] = entry;
}

// ---- the preview path, from its own re-check (--proxy-verified: cf-verify2's verified.json, CF-VERIFY-PROXY.md).
// Both paths were measured on one 80 s clip (40 segments and the init). Per-stream costs are split from per-segment
// ones by the request structure the re-check gives (e.g. before: 418 Worker requests a stream = 10 a segment + 18;
// optimized: 4 Class B a stream). Confirmed and revised values are Verified (a revised one keeps the claim as `was`);
// the release batch size's values (4 parts / 2 MiB) are the verifier's own runs, not re-checked by another: Measured.
if (proxyVerified) {
  const PM = proxyVerified.metrics;
  if (!isObj(PM)) fail("proxy verified.json has no `metrics` object");
  const SEGS = 40; // the clip's segments (meta.clip)
  const CPU = isObj(PM["cpu.perRequestMs"]) ? PM["cpu.perRequestMs"] : {};
  const metric = (name) => {
    const m = PM[name]?.good;
    if (!isObj(m)) fail(`proxy verified.json: metrics["${name}"].good is missing`);
    return m;
  };
  const statusOf = (m) => (m.verdict === "confirmed" || m.verdict === "revised" || m.verdict === "confirmed-from-data" ? "verified" : "measured");
  const by = "the preview-path re-check (cf-verify2, CF-VERIFY-PROXY.md)";
  const put = (key, value, m, how, extra = {}) => {
    if (!isNum(value)) fail(`proxy verified.json: no number for ${key}`);
    inputs[key] = { value: Math.round(value * 1e6) / 1e6, unit: extra.unit ?? "", status: extra.status ?? statusOf(m), source: "proxy-check", n: extra.n ?? null, min: extra.min ?? null, max: extra.max ?? null, runs: [], how, verdict: extra.status === "measured" ? null : m.verdict ?? null, ...(extra.was !== undefined ? { was: extra.was } : {}), check: { value, n: extra.n ?? null, min: extra.min ?? null, max: extra.max ?? null, note: str(m.note ?? m.basis, 1500) } };
  };
  const wr = metric("publish.workerRequestsPerSegment");
  const ca = metric("publish.r2ClassAPerSegment");
  const cb = metric("publish.r2ClassBPerSegment");
  const cap = metric("publish.writeCapDoRequestsPerSegment");
  const cpuP = metric("publish.workerCpuMsPerSegment");
  const vr = metric("play.workerRequestsPerMiB");
  const vb = metric("play.r2ClassBPerMiB");
  const cpuV = metric("play.workerCpuMsPerMiB");
  // before: part by part
  const beforeReq = wr.before * SEGS; // 418: 10 a segment + 18 a stream
  put("pvSegWorkerReq", 10, wr, `Before the fix: ${wr.before} Worker requests a segment on the 80 s clip, exact (${beforeReq} a stream: 10 a segment, signs and signed requests for 3 objects and 2 checks, plus 18 a stream). By ${by}.`, { unit: "Worker requests per segment" });
  put("pvStreamWorkerReq", beforeReq - 10 * SEGS, wr, `Before the fix: the stream's own requests (pointer, claim, init, end), ${beforeReq} − 10 × ${SEGS}. By ${by}.`, { unit: "Worker requests per stream" });
  const beforeB = cb.before * SEGS; // 169: 4 a part + end + pointer
  put("pvSegClassB", 4, cb, `Before the fix: ${beforeB} Class B a stream by the code path (2 heads, the damage check and the entry's create-only head per part, plus the end's and 4 for the pointer): 4 a segment + ${beforeB - 4 * SEGS} a stream. Revised from the claimed ${cb.claimed?.before} a segment (R2 analytics sampling). By ${by}.`, { unit: "Class B per segment", was: cb.claimed?.before });
  put("pvStreamClassB", beforeB - 4 * SEGS, cb, `Before the fix: the stream's own Class B (the init part, the end, the pointer). By ${by}.`, { unit: "Class B per stream" });
  const writes = ca.before * SEGS; // 125: 3 a part + end + pointer
  put("pubSegClassA", 3, ca, `Both paths write the same objects: ${writes} PutObject a stream (manifest, bytes and list entry per part, the end, the pointer) = 3 a segment + ${writes - 3 * SEGS} a stream. Confirmed by ${by}.`, { unit: "Class A per segment" });
  put("pubStreamClassA", writes - 3 * SEGS, ca, `The stream's own writes (the init part, the end, the pointer). Confirmed by ${by}.`, { unit: "Class A per stream" });
  const beforeCap = cap.before * SEGS;
  put("pvSegCapReserves", 3, cap, `Before the fix, with the daily write cap on: one reserve per write, ${beforeCap} a stream = 3 a segment + ${beforeCap - 3 * SEGS} a stream (exact; GraphQL unsampled). By ${by}.`, { unit: "write-cap reserves per segment" });
  put("pvStreamCapReserves", beforeCap - 3 * SEGS, cap, `Before the fix: the stream's own reserves. By ${by}.`, { unit: "write-cap reserves per stream" });
  put("pvSegCpuMs", cpuP.before, cpuP, `Before the fix: Worker CPU per segment from Cloudflare's own CPU sums (GraphQL), 5 runs; the stream's own requests are spread over its 40 segments. Revised from the claimed ${cpuP.claimed?.before} (wrangler tail rounds each request down to whole ms). By ${by}.`, { unit: "Worker CPU ms per segment", was: cpuP.claimed?.before, n: 5, min: cpuP.beforeRange?.[0], max: cpuP.beforeRange?.[1] });
  put("pvViewWorkerReqPerMiB", vr.before, vr, `Before the fix: a sign and a signed GET for each of a segment's 3 objects, exact: 250 requests for the 25.33 MiB stream. By ${by}.`, { unit: "Worker requests per MiB played" });
  put("pvViewClassBPerMiB", vb.before, vb, `Before the fix: each signed GET is a head and a get: 249 Class B for the stream by the code path, checked against pooled analytics. By ${by}.`, { unit: "Class B per MiB played" });
  put("pvViewCpuMsPerMiB", cpuV.before, cpuV, `Before the fix: Worker CPU per MiB played (GraphQL), 5 runs. Revised from the claimed ${cpuV.claimed?.before}. By ${by}.`, { unit: "Worker CPU ms per MiB played", was: cpuV.claimed?.before, n: 5, min: cpuV.beforeRange?.[0], max: cpuV.beforeRange?.[1] });
  // optimized: the request structure is confirmed at 8 parts / 4 MiB; the release's 4 parts / 2 MiB was measured by the verifier
  const appends8 = cap.after * SEGS - 1; // 10 reserves a run = 9 appends + the pointer
  put("pvoStreamWorkerReq", wr.after * SEGS - appends8, wr, `Optimized: the stream's setup (pointer check, claim, read back: 3 signs and 3 signed requests) and one dedup probe: ${wr.after * SEGS} requests at 8 parts = ${appends8} appends + this. Confirmed exact by ${by}.`, { unit: "Worker requests per stream" });
  put("pvoStreamCapReserves", 1, cap, `Optimized, with the daily write cap on: one reserve per append, plus 1 a stream (${cap.after * SEGS} = ${appends8} appends + 1). Confirmed exact by ${by}.`, { unit: "write-cap reserves per stream" });
  put("pvoStreamClassB", cb.after * SEGS, cb, `Optimized: 4 Class B a stream (pointer GET, the pointer's create-only head, pointer read-back, one dedup head), fixed per stream. Revised from the claimed ${cb.claimed?.after} a segment. By ${by}.`, { unit: "Class B per stream", was: cb.claimed?.after !== undefined ? cb.claimed.after * SEGS : undefined });
  const appendsSmall = cap.afterSmall * SEGS - 1; // 16 reserves = 15 appends + 1
  put("pvoAppendsPerSeg", appendsSmall / SEGS, cap, `Optimized at the release's batches (4 parts / 2 MiB): ${appendsSmall} appends for the clip's 41 parts of 0.62 MiB (bytes decide: 3 parts fit 2 MiB), exact, 2 runs by the verifier (not re-checked by another). The model scales it with the segment's size.`, { unit: "appends per segment", status: "measured", n: 2 });
  put("pvoSegCpuMs", cpuP.afterSmall, cpuP, `Optimized at the release's batches: Worker CPU per segment (GraphQL), the verifier's 2 runs on the final build (not re-checked by another). The 8-part build read ${cpuP.after}–${cpuP.afterFinalBuild}.`, { unit: "Worker CPU ms per segment", status: "measured", n: 2, min: cpuP.afterSmallRange?.[0], max: cpuP.afterSmallRange?.[1] });
  put("pvoViewWorkerReqPerMiB", vr.afterSmall, vr, `Optimized at the release's 2 MiB reads: ${Math.round(vr.afterSmall * 25.33)} reads for the 25.33 MiB stream, exact, the verifier's 2 runs (8 parts / 4 MiB, confirmed: ${vr.after}).`, { unit: "Worker requests per MiB played", status: "measured", n: 2 });
  put("pvoViewClassBPerMiB", vb.afterSmall, vb, `Optimized at 2 MiB reads: a GET of each segment's entry and bytes, plus the reads' edge GETs: 100 Class B for the stream by the code path, the verifier's 2 runs (4 MiB reads, confirmed: ${vb.after}).`, { unit: "Class B per MiB played", status: "measured", n: 2 });
  put("pvoViewCpuMsPerMiB", cpuV.afterSmall, cpuV, `Optimized at 2 MiB reads: Worker CPU per MiB played (GraphQL), the verifier's 2 runs (4 MiB reads: ${cpuV.after}, revised).`, { unit: "Worker CPU ms per MiB played", status: "measured", n: 2, min: cpuV.afterSmallRange?.[0], max: cpuV.afterSmallRange?.[1] });
  const ap = CPU.append?.finalBuild_4parts2MiB;
  const rd = CPU.read?.finalBuild_2MiB;
  if (!isObj(ap) || !isObj(rd)) fail("proxy verified.json: cpu.perRequestMs for 4 parts / 2 MiB is missing");
  const cpuMeta = { verdict: null, basis: CPU.append?.basis };
  put("pvoAppendCpuMsMean", ap.mean, cpuMeta, `Optimized: CPU of one append at the release's batches, exact per request (GraphQL), ${ap.n} appends: p50 ${ap.p50}, p90 ${ap.p90}, max ${ap.max} ms; ${ap.over10ms} of ${ap.n} over 10 ms.`, { unit: "Worker CPU ms per append (mean)", status: "measured", n: ap.n, min: null, max: ap.max });
  put("pvoAppendCpuMsMax", ap.max, cpuMeta, `Optimized: the slowest of ${ap.n} appends at the release's batches.`, { unit: "Worker CPU ms (max)", status: "measured", n: ap.n });
  put("pvoAppendOver10Share", ap.over10ms / ap.n, cpuMeta, `Optimized: the share of appends over 10 ms of CPU (${ap.over10ms} of ${ap.n}).`, { unit: "share of appends", status: "measured", n: ap.n });
  put("pvoReadCpuMsMean", rd.mean, cpuMeta, `Optimized: CPU of one 2 MiB read, exact per request, ${rd.n} reads: p50 ${rd.p50}, max ${rd.max} ms; none over 10 ms.`, { unit: "Worker CPU ms per read (mean)", status: "measured", n: rd.n, max: rd.max });
  put("pvoReadCpuMsMax", rd.max, cpuMeta, `Optimized: the slowest of ${rd.n} 2 MiB reads.`, { unit: "Worker CPU ms (max)", status: "measured", n: rd.n });
  proxyCheck = { by: str(proxyVerified.meta?.verifier, 60), at: str(proxyVerified.meta?.at, 40), subject: str(proxyVerified.meta?.subject, 300), ap, rd, burst2: CPU.read?.["burst_2MiB_120back-to-back"], failures: CPU.exceededCpuOr1102, one: CPU.append?.finalBuild_1part };
}

// The lab's gbDoReq is all the optional daily write cap's counter (the verifier), which a default deployment doesn't
// run: revised to 0, and kept, as the lab measured it, for the "daily write cap on" setting.
if (raw.gbDoReq && !("writeCapDoReqPerGB" in inputs)) {
  inputs.writeCapDoReqPerGB = {
    value: raw.gbDoReq.value,
    unit: "write-cap counter requests per GB written",
    status: "measured",
    source: "lab",
    n: numOrNull(raw.gbDoReq.n),
    min: numOrNull(raw.gbDoReq.min),
    max: numOrNull(raw.gbDoReq.max),
    runs: strList(raw.gbDoReq.runs),
    how: `The lab's gbDoReq: all of it is the optional daily write cap's counter (the verifier), so it counts only with the cap on. An upper bound: other runs shared the counter in those minutes; the code path gives about 122 per GB. ${str(raw.gbDoReq.how)}`,
    verdict: null,
  };
}

const used = Object.keys(INPUT_DEFAULTS);
const missing = used.filter((k) => !(k in inputs));
for (const k of missing) {
  inputs[k] = {
    value: INPUT_DEFAULTS[k],
    unit: "",
    status: "estimated",
    source: "model",
    n: null,
    min: null,
    max: null,
    runs: [],
    how: INPUT_NOTES[k] ?? "Not in the measurement file: the model's own figure.",
    verdict: null,
  };
  warn(`input ${k}: not in measured.json; the model's figure (${INPUT_DEFAULTS[k]}) drives the bill, marked Estimated`);
}
const extra = Object.keys(inputs).filter((k) => !used.includes(k));
for (const k of extra) warn(`input ${k}: not used by the model; listed on the page as an extra measurement`);

// ---- speeds
const SPEED_STATUS = new Set(["measured", "verified", "estimated"]);
const STORAGE = { r2: "r2", vault: "vault", nor2: "vault", either: "either" };
const speeds = [];
for (const [i, s] of (measured.speeds ?? []).entries()) {
  if (!isObj(s) || typeof s.id !== "string" || typeof s.network !== "string") {
    warn(`speeds[${i}]: needs an id and a network, dropped`);
    continue;
  }
  const row = {
    id: s.id,
    what: str(s.what, 300),
    network: s.network,
    storage: STORAGE[s.storage] ?? "either",
    parties: numOrNull(s.parties),
    sizeMB: numOrNull(s.sizeMB),
    metric: str(s.metric, 60) || "time",
    p50: numOrNull(s.p50),
    p90: numOrNull(s.p90),
    p99: numOrNull(s.p99),
    unit: str(s.unit, 20) || "ms",
    runs: isNum(s.runs) ? s.runs : 0,
    status: SPEED_STATUS.has(s.status) ? s.status : "measured",
    note: str(s.note, 600),
    verdict: null,
  };
  const vd = verified?.speeds?.[s.id];
  if (isObj(vd) && VERDICTS.has(vd.verdict)) {
    row.verdict = vd.verdict;
    row.check = { p50: numOrNull(vd.ours?.p50), p90: numOrNull(vd.ours?.p90), p99: numOrNull(vd.ours?.p99), runs: numOrNull(vd.runs), note: str(vd.note, 1500) };
    // re-run, or recomputed exactly from the per-run records: Verified; a percentile the re-run didn't reproduce stays open
    if (vd.verdict === "confirmed" || vd.verdict === "confirmed-from-data") row.status = "verified";
    const open = {};
    for (const [, p] of str(vd.note, 1500).matchAll(/\b(p50|p90|p99) NOT confirmed/gi)) open[p.toLowerCase()] = "not confirmed (one slow edit decides it)";
    if (Object.keys(open).length) row.unconfirmed = open;
  }
  speeds.push(row);
}
// the preview path's speeds, before and after the fix, from its re-check (good and 4G; the release's batches on good)
if (proxyVerified?.metrics) {
  const PM = proxyVerified.metrics;
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const ROWS = [
    ["pvpublish", "publish.speedXRealTime", "x", "publish the preview, as a multiple of real time (higher is faster)"],
    ["pvplay", "play.speedXRealTime", "x", "fetch the whole finished preview, as a multiple of real time (higher is faster)"],
    ["pvfirstseg", "play.firstMediaSegmentMs", "ms", "time to the first video segment of a finished preview, from play start"],
    ["pvlive", "live.firstSegmentMsFromShareStart", "ms", "a live viewer's first segment, from the share's start"],
  ];
  const statusOf = (m) => (m.verdict === "confirmed" || m.verdict === "revised" ? "verified" : "measured");
  for (const [kind, name, unit, what] of ROWS)
    for (const net of ["good", "4g"]) {
      const m = PM[name]?.[net];
      if (!isObj(m)) continue;
      const variants = [
        ["before", m.before, m.beforeRuns ?? null, m.n?.before, statusOf(m), "before the fix (part by part)"],
        ["release", m.afterSmallRuns ? median(m.afterSmallRuns) : m.afterSmall, m.afterSmallRuns ?? null, m.afterSmallRuns?.length, "measured", "the fix, release batches (4 parts / 2 MiB); the verifier's own runs"],
        ["8parts", m.after, m.afterRuns ?? null, m.n?.after, statusOf(m), "the fix, the first test's batches (8 parts / 4 MiB)"],
      ];
      for (const [tag, value, runs, n, status, words] of variants) {
        if (!isNum(value)) continue;
        const count = Array.isArray(runs) ? runs.length : isNum(n) ? n : 1;
        const claimed = m.claimed?.[tag === "8parts" ? "after" : tag];
        speeds.push({
          id: `${kind}-${net}-${tag}`,
          what,
          network: net,
          storage: "r2",
          parties: null,
          sizeMB: null,
          metric: unit === "x" ? "realtime" : "time",
          p50: value,
          p90: null,
          p99: null,
          unit,
          runs: count,
          status,
          note: `${words}${Array.isArray(runs) ? `; per run: ${runs.join(", ")}` : ""}${m.verdict === "revised" && tag !== "release" && isNum(claimed) && claimed !== value ? `; revised from the claimed ${claimed}` : ""}`,
          verdict: status === "verified" ? (m.verdict === "revised" ? "revised" : "confirmed") : null,
          check: { p50: value, p90: null, p99: null, runs: count, note: str(m.basis, 600) },
        });
      }
    }
}
if (verified?.speeds) for (const id of Object.keys(verified.speeds)) if (!speeds.some((s) => s.id === id)) warn(`verified.json: speed ${id} isn't in measured.json`);

// ---- limits: the lab's, then Cloudflare's documented ones the lab's file doesn't carry (prices.json)
const LIMIT_STATUS = new Set(["measured", "documented", "verified", "estimated"]);
const limits = [];
for (const [i, l] of [...(measured.limits ?? []).entries()]) {
  if (!isObj(l) || typeof l.id !== "string") {
    warn(`limits[${i}]: needs an id, dropped`);
    continue;
  }
  limits.push({ id: l.id, status: LIMIT_STATUS.has(l.status) ? l.status : "documented", value: str(l.value, 400), observed: str(l.observed, 1200), carton: str(l.carton, 1200), runs: strList(l.runs) });
}
for (const l of Array.isArray(prices.documentedLimits) ? prices.documentedLimits : [])
  if (isObj(l) && typeof l.id === "string" && !limits.some((x) => x.id === l.id))
    limits.push({ id: l.id, status: "documented", value: str(l.value, 400), observed: str(l.observed, 1200), carton: str(l.carton, 1200), runs: [] });

// the preview path against Workers Free's 10 ms of CPU per request, from its re-check
if (proxyCheck) {
  const { ap, rd, burst2, failures, one } = proxyCheck;
  limits.unshift({
    id: "worker-cpu-10ms-preview",
    status: "measured",
    value: "10 ms of CPU per request on Workers Free (on Paid, 5 minutes: it doesn't apply in practice)",
    observed: `With the release's batches (4 parts / 2 MiB), an append averages ${ap.mean} ms and ${ap.over10ms} of ${ap.n} went over 10 ms (p90 ${ap.p90}, max ${ap.max} ms). 2 MiB reads stayed under it in the runs (max ${rd.max} ms${isObj(burst2) ? `; ${burst2.graphqlQuantiles?.max} ms at most in a burst of 120 back to back` : ""}). One-part appends stayed under in every case (max ${one?.range?.[1] ?? "7.3"} ms). No request failed (${failures?.count ?? 0} exceededCpu / 1102 on any lab Worker that day). But the Free plan does enforce it: on 2026-11-01 Cloudflare cut the lab's requests off at about 10 ms after bursts of slow part uploads.`,
    carton: "An append Cloudflare cuts off is sent again in smaller batches, down to one part (confirmed from the code and a unit test; not yet against a real 1102). The tighter fix would stream each part to storage instead of buffering it, so larger batches fit. On Workers Paid the limit is 5 minutes a request.",
    runs: [],
  });
}

const networkProfiles = {};
for (const [k, v] of Object.entries(measured.networkProfiles ?? {})) if (typeof v === "string") networkProfiles[k] = v.slice(0, 300);

// ---- prices.json: every number the model reads must be there
const need = {
  paid: ["base", "wsMessagesPerRequest", "doObjectGB"],
  free: ["workersReqDay", "workersCpuMsPerRequest", "doReqDay", "doGBsDay", "doRowsReadDay", "doRowsWrittenDay", "doStorageGB", "doObjectGB"],
};
const tiers = { paid: ["workersReq", "workersCpuMs", "doReq", "doGBs", "doRowsRead", "doRowsWritten", "doStorageGBMonth"], r2: ["storageGBMonth", "classA", "classB"] };
for (const [group, keys] of Object.entries(need)) for (const k of keys) if (!isNum(prices?.[group]?.[k])) fail(`prices.json: ${group}.${k} must be a number`);
for (const [group, keys] of Object.entries(tiers))
  for (const k of keys) for (const f of ["included", "per", "perUnit"]) if (!isNum(prices?.[group]?.[k]?.[f])) fail(`prices.json: ${group}.${k}.${f} must be a number`);
if (!Array.isArray(prices.sources) || !prices.sources.every((s) => typeof s?.url === "string" && /^https:\/\//.test(s.url))) fail("prices.json: sources must list https URLs");
if (typeof prices.fetched !== "string") fail("prices.json: `fetched` (the date) is missing");

const count = (st) => used.filter((k) => inputs[k].status === st).length;
const data = {
  schema: 1,
  built: new Date().toISOString(),
  measured: { generated: str(measured.generated, 40), source: isObj(measured.source) ? measured.source : {} },
  verified: verified ? { by: str(verified.verifier, 60), at: str(verified.at, 40), commit: str(verified.checked?.commit, 60) } : null,
  proxyCheck: proxyCheck ? { by: proxyCheck.by, at: proxyCheck.at, subject: proxyCheck.subject } : null,
  inputs,
  estimatedInputs: used.filter((k) => inputs[k].status === "estimated"),
  missingInputs: missing,
  extraInputs: extra,
  speeds,
  limits,
  networkProfiles,
  prices,
};
writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
for (const w of warnings) console.warn(`build-data: ${w}`);
console.log(`build-data: wrote ${out}`);
console.log(`  model inputs: ${used.length} (Verified ${count("verified")}, Measured ${count("measured")}, Estimated ${count("estimated")}: ${data.estimatedInputs.join(", ") || "none"})`);
console.log(`  extra lab inputs: ${extra.length} (${extra.join(", ")}); speeds ${speeds.length} (Verified ${speeds.filter((s) => s.status === "verified").length}); limits ${limits.length}; prices of ${prices.fetched}`);
