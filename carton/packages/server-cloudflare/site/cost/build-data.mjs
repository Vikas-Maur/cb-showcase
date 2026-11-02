// Builds site/cost/data.json, the one file the calculator page loads: the lab's measurements (measured.json, schema 1),
// an independent verifier's verdicts on them (verified.json, optional) and Cloudflare's prices (prices.json), checked.
//
//   node site/cost/build-data.mjs <measured.json> [prices.json] [--verified <verified.json>]
//     [--proxy-verified <cf-verify2 verified.json>] [--proxy-release <bench/cost/proxy-release.json>]
//     [--proxy-final <cf-verify4 verified.json>] [--out <data.json>]                    (from packages/server-cloudflare)
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
const proxyReleasePath = flag("--proxy-release");
const proxyFinalPath = flag("--proxy-final");
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
const proxyRelease = proxyReleasePath ? load(proxyReleasePath) : null;
const proxyFinal = proxyFinalPath ? load(proxyFinalPath) : null;
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
  // optimized: the server's fixed costs a stream (4 Class B: the pointer and one dedup head) are the same in the release
  put("pvoStreamClassB", cb.after * SEGS, cb, `Optimized: 4 Class B a stream (pointer GET, the pointer's create-only head, pointer read-back, one dedup head), fixed per stream. Revised from the claimed ${cb.claimed?.after} a segment. By ${by}.`, { unit: "Class B per stream", was: cb.claimed?.after !== undefined ? cb.claimed.after * SEGS : undefined });
}

// ---- the release's preview settings (1 part / 1 MiB per append, 4 in flight; 1 MiB reads, 2 in flight): request
// structure and per-segment CPU from cf-verify3 and the final runs (--proxy-release, bench/cost/proxy-release.json),
// the per-request CPU and the final 4G speeds from cf-verify4's independent check (--proxy-final, its verified.json)
if (proxyRelease) {
  const st = proxyRelease.structure;
  const v3 = proxyRelease.cfVerify3;
  const SEGS = proxyRelease.clip?.segments;
  if (!isObj(st?.publish) || !isObj(v3) || !isNum(SEGS)) fail("proxy-release.json: needs clip.segments, structure.publish and cfVerify3");
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const by3 = "cf-verify3 (CF-VERIFY-PROXY-3.md)";
  const pub = st.publish;
  const setup = pub.sign + pub.signedGET + pub.signedPUT + pub.heads;
  const meta = { verdict: "confirmed", note: str(st._source, 600) };
  const putR = (key, value, how, extra = {}) => {
    if (!isNum(value)) fail(`proxy-release.json: no number for ${key}`);
    inputs[key] = { value: Math.round(value * 1e6) / 1e6, unit: extra.unit ?? "", status: extra.status ?? "verified", source: "proxy-check", n: extra.n ?? null, min: extra.min ?? null, max: extra.max ?? null, runs: [], how, verdict: extra.verdict ?? "confirmed", check: { value, n: extra.n ?? null, min: extra.min ?? null, max: extra.max ?? null, note: str(extra.note ?? meta.note, 1500) } };
  };
  putR("pvoAppendsPerSeg", 1, `The release: one part per append (the server advertises 1 part / 1 MiB), so one append a segment. ${pub.appends} appends for the clip's ${SEGS} segments: ${pub.appendsNote}. Checked by ${st.checkedBy}.`, { unit: "appends per segment" });
  putR("pvoStreamAppends", pub.appends - SEGS, `The release: a stream's own appends, the lease and the end (${pub.appends} − ${SEGS}). Checked by ${st.checkedBy}.`, { unit: "appends per stream" });
  putR("pvoStreamWorkerReq", setup, `The release: a stream's setup, ${pub.sign} signs, ${pub.signedGET} signed GETs and ${pub.signedPUT} signed PUT (the pointer: check, claim, read back), and ${pub.heads} dedup probe: ${pub.workerRequests} requests a share with the appends. ${by3} counted ${v3.workerRequestsPerSegment} a segment (${v3.workerRequestsNote}) before the end went alone.`, { unit: "Worker requests per stream" });
  putR("pvoSegCapReserves", 1, `The release, with the daily write cap on: ${st.writeCapReserves} reserves a share = 1 a segment + ${st.writeCapReserves - SEGS}. ${by3}: ${v3.writeCapDoRequestsPerSegment} a segment (${v3.writeCapNote}); cf-verify4's run: ${st.writeCapReserves}.`, { unit: "write-cap reserves per segment" });
  putR("pvoStreamCapReserves", st.writeCapReserves - SEGS, `The release, with the daily write cap on: a stream's own reserves (${st.writeCapReserves} − ${SEGS}).`, { unit: "write-cap reserves per stream" });
  const cpuSeg = [...v3.publishCpuMsPerSegment.good, ...v3.publishCpuMsPerSegment["4g"]];
  putR("pvoSegCpuMs", median(cpuSeg), `The release: Worker CPU per segment published (GraphQL per phase), ${by3}'s 4 runs: ${cpuSeg.join(", ")} (good, good, 4G, 4G). The server is the release's (byte-identical); its client then sent the last appends one at a time, which doesn't change their CPU.`, { unit: "Worker CPU ms per segment", n: cpuSeg.length, min: Math.min(...cpuSeg), max: Math.max(...cpuSeg) });
  putR("pvoStreamReads", st.play.reads - SEGS, `The release: a 1 MiB read holds one of the clip's 0.62 MiB segments (${st.play.readsNote}): ${st.play.reads} reads for ${SEGS} segments, so 1 more a stream. Checked by ${st.checkedBy}; ${by3} counted ${v3.playRequestsPerMiB} reads per MiB (${v3.playRequestsNote}).`, { unit: "reads per stream" });
  const cpuMiB = [...v3.playCpuMsPerMiB.good, ...v3.playCpuMsPerMiB["4g"]];
  const perRead = median(cpuMiB) / v3.playRequestsPerMiB;
  putR("pvoReadCpuMs", perRead, `The release: Worker CPU per 1 MiB read, ${by3}'s CPU per MiB played (${cpuMiB.join(", ")}; median ${median(cpuMiB)}) over its ${v3.playRequestsPerMiB} reads per MiB. Its exact single reads: p50 ${v3.readCpu.exact.p50}, max ${v3.readCpu.exact.max} ms.`, { unit: "Worker CPU ms per read", n: cpuMiB.length, min: Math.min(...cpuMiB) / v3.playRequestsPerMiB, max: Math.max(...cpuMiB) / v3.playRequestsPerMiB });
}
if (proxyFinal) {
  const runs = proxyFinal.runs;
  if (!isObj(runs)) fail("proxy-final verified.json: no `runs`");
  const all = Object.values(runs).filter(isObj);
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const ap = all.map((r) => r.append_cpu);
  const rd = all.map((r) => r.read_cpu);
  const appendTyp = median(ap.map((x) => x.exact.p50));
  const appendMax = Math.max(...ap.map((x) => Math.max(x.exact.max, x.tail.max)));
  const readTyp = median(rd.map((x) => x.exact.p50));
  const readMax = Math.max(...rd.map((x) => Math.max(x.exact.max ?? 0, x.tail.max)));
  const count = [...ap, ...rd].reduce((t, x) => t + x.tail.ge10, 0);
  const of = [...ap, ...rd].reduce((t, x) => t + x.tail.n, 0);
  const by4 = "cf-verify4 (CF-VERIFY-PROXY-4.md), recomputed exactly from the runs and its own live run";
  const putF = (key, value, how, extra = {}) => {
    inputs[key] = { value: Math.round(value * 1e6) / 1e6, unit: extra.unit ?? "", status: "verified", source: "proxy-check", n: extra.n ?? null, min: null, max: extra.max ?? null, runs: [], how, verdict: "confirmed-from-data", check: { value, n: extra.n ?? null, min: null, max: extra.max ?? null, note: str(proxyFinal.ge10_only_first_requests?.value, 1500) } };
  };
  putF("pvoAppendCpuMsTypical", appendTyp, `The release: a typical append's CPU, the median of ${all.length} runs' exact p50s (${ap.map((x) => x.exact.p50).join(", ")} ms). By ${by4}.`, { unit: "Worker CPU ms per append (typical)", n: all.length });
  putF("pvoAppendCpuMsMax", appendMax, `The release: the slowest append in ${all.length} runs (${ap.map((x) => x.exact.max).join(", ")} ms exact). By ${by4}.`, { unit: "Worker CPU ms (max)", n: all.length });
  putF("pvoReadCpuMsTypical", readTyp, `The release: a typical 1 MiB read's CPU, the median of ${all.length} runs' exact p50s (${rd.map((x) => x.exact.p50).join(", ")} ms). By ${by4}.`, { unit: "Worker CPU ms per read (typical)", n: all.length });
  putF("pvoReadCpuMsMax", readMax, `The release: the slowest read, a live viewer's first (${readMax} ms, whole-ms floor from the tail; it waited 4.2 s at the edge). By ${by4}.`, { unit: "Worker CPU ms (max)", n: all.length });
  putF("pvoOver10Count", count, `The release: appends and reads at or over 10 ms of CPU, ${count} of ${of} over ${all.length} runs: "mostly a stream's first media append or a client's first read". By ${by4}.`, { unit: "requests at or over 10 ms", n: of });
  putF("pvoOver10Of", of, `The release: appends and reads in the ${all.length} runs (42 appends and 43 reads each).`, { unit: "requests", n: all.length });
  proxyCheck = { ...(proxyCheck ?? {}), final: { count, of, appendMax, readMax, appendTyp, readTyp, runs: all.length, no1102: proxyFinal.no_1102?.verdict === "confirmed" } };
}
if (proxyVerified) {
  const CPU = isObj(proxyVerified.metrics?.["cpu.perRequestMs"]) ? proxyVerified.metrics["cpu.perRequestMs"] : {};
  proxyCheck = { ...(proxyCheck ?? {}), by: str(proxyVerified.meta?.verifier, 60), at: str(proxyVerified.meta?.at, 40), subject: str(proxyVerified.meta?.subject, 300), failures: CPU.exceededCpuOr1102 };
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
// the preview path's speeds: before the fix from its first re-check (cf-verify2); the release on 4G from cf-verify4's
// check of the final runs; on the good link, cf-verify3's live runs at the release's sizes (before the in-flight fix)
// and the implementer's local runs (not Cloudflare)
{
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const WHAT = {
    pvpublish: ["publish the preview, as a multiple of real time (higher is faster)", "x"],
    pvplay: ["fetch the whole finished preview, as a multiple of real time (higher is faster)", "x"],
    pvfirstseg: ["time to the first video segment of a finished preview, from play start", "ms"],
    pvlive: ["a live viewer's first segment, from the share's start", "ms"],
  };
  const row = (kind, net, tag, runs, status, words, verdict, note) => {
    const [what, unit] = WHAT[kind];
    const value = Math.round(median(runs) * 1000) / 1000;
    speeds.push({ id: `${kind}-${net}-${tag}`, what, network: net, storage: "r2", parties: null, sizeMB: null, metric: unit === "x" ? "realtime" : "time", p50: value, p90: null, p99: null, unit, runs: runs.length, status, note: `${words}; per run: ${runs.join(", ")}${note ? `; ${note}` : ""}`, verdict, check: { p50: value, p90: null, p99: null, runs: runs.length, note: words } });
  };
  if (proxyVerified?.metrics) {
    const PM = proxyVerified.metrics;
    const src = { pvpublish: "publish.speedXRealTime", pvplay: "play.speedXRealTime", pvfirstseg: "play.firstMediaSegmentMs", pvlive: "live.firstSegmentMsFromShareStart" };
    for (const [kind, name] of Object.entries(src))
      for (const net of ["good", "4g"]) {
        const m = PM[name]?.[net];
        if (!isObj(m) || !isNum(m.before)) continue;
        const runs = Array.isArray(m.beforeRuns) ? m.beforeRuns : [m.before];
        const ok = m.verdict === "confirmed" || m.verdict === "revised";
        row(kind, net, "before", runs, ok ? "verified" : "measured", "before the fix (part by part); the first preview re-check (cf-verify2)", ok ? m.verdict : null, "");
      }
  }
  if (proxyFinal?.runs) {
    const r = Object.values(proxyFinal.runs).filter(isObj);
    const v = (k) => r.map((x) => x[k]).filter(isNum);
    row("pvpublish", "4g", "release", v("publish_x").map((x) => Math.round(x * 1000) / 1000), "verified", "the release; checked by cf-verify4 (2 runs re-computed, 1 of its own)", "confirmed", "4G publish is now link-bound (about 4.3 Mbit/s of the 5)");
    row("pvplay", "4g", "release", v("play_x").map((x) => Math.round(x * 1000) / 1000), "verified", "the release; checked by cf-verify4", "confirmed", "");
    row("pvlive", "4g", "release", v("live_first_ms"), "verified", "the release; checked by cf-verify4", "confirmed", "");
  }
  if (proxyRelease) {
    const v3 = proxyRelease.cfVerify3?.speeds ?? {};
    const pre = "the release's sizes before the in-flight fix (its last appends went one at a time, one read in flight); cf-verify3";
    if (v3.good?.publishX) row("pvpublish", "good", "release-pretail", v3.good.publishX, "verified", pre, "confirmed", "");
    if (v3.good?.playX) row("pvplay", "good", "release-pretail", v3.good.playX, "verified", pre, "confirmed", "");
    if (v3.good?.liveFirstMs) row("pvlive", "good", "release-pretail", v3.good.liveFirstMs, "verified", pre, "confirmed", "");
    for (const net of ["good", "4g"]) if (v3[net]?.playFirstSegMs) row("pvfirstseg", net, "release-pretail", v3[net].playFirstSegMs, "verified", pre, "confirmed", "");
    const loc = proxyRelease.local ?? {};
    const lw = "the release, measured locally (local workerd with a 500 ms R2 delay, not Cloudflare; the implementer's runs, not re-checked)";
    if (loc.good?.publishX) row("pvpublish", "good", "release-local", loc.good.publishX, "measured", lw, null, "");
    if (loc.good?.playX) row("pvplay", "good", "release-local", loc.good.playX, "measured", lw, null, "");
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
if (proxyCheck?.final) {
  const f = proxyCheck.final;
  limits.unshift({
    id: "worker-cpu-10ms-preview",
    status: "verified",
    value: "10 ms of CPU per request on Workers Free (on Paid, 5 minutes: it doesn't apply in practice)",
    observed: `Appends and reads stay under 10 ms apart from a few, mostly a stream's first media append or a client's first read. ${f.count} of ${f.of} were at or over 10 ms (max ${f.readMax} ms), and none were refused${f.no1102 ? " (no 1102 on any Worker that day)" : ""}. Typical: an append ${f.appendTyp} ms, a 1 MiB read ${f.readTyp} ms (cf-verify4, ${f.runs} runs on 4G).`,
    carton: "The release keeps every preview request small: one part (1 MiB) per append and 1 MiB reads, the limits the server advertises, with 4 appends and 2 reads in flight to keep the speed. On Workers Paid the limit is 5 minutes a request.",
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
