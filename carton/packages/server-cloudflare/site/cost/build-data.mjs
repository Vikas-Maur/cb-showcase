// Builds site/cost/data.json, the one file the calculator page loads: the lab's measurements (measured.json, schema 1),
// an independent verifier's verdicts on them (verified.json, optional) and Cloudflare's prices (prices.json), checked.
//
//   node site/cost/build-data.mjs <measured.json> [prices.json] [--verified <verified.json>] [--out <data.json>]
//   (from packages/server-cloudflare)
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
