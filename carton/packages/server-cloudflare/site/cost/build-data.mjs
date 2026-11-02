// Builds site/cost/data.json, the one file the calculator page loads: the lab's measurements (measured.json, schema 1)
// and Cloudflare's prices (prices.json), checked. A structural problem (not schema 1, inputs not an object…) stops the
// build; a bad single entry is dropped with a warning, and the page shows that input as "not measured" and uses the
// model's estimate. Input keys the model doesn't use are kept and listed on the page as extra measurements.
//
//   node site/cost/build-data.mjs <measured.json> [prices.json] [--out <data.json>]      (from packages/server-cloudflare)
//
// The lab's file: `git show origin/lab/cloudflare:carton/bench/cloudflare/results/measured.json > /tmp/measured.json`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INPUT_DEFAULTS } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : join(here, "data.json");
const [measuredPath, pricesPath = join(here, "prices.json")] = args;
if (!measuredPath) {
  console.error("usage: node build-data.mjs <measured.json> [prices.json] [--out data.json]");
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

// ---- measured.json
if (!isObj(measured)) fail("measured.json is not an object");
if (measured.schema !== 1) fail(`measured.json schema is ${JSON.stringify(measured.schema)}, expected 1`);
if (!isObj(measured.inputs)) fail("measured.json has no `inputs` object");
for (const k of ["speeds", "limits"]) if (measured[k] !== undefined && !Array.isArray(measured[k])) fail(`measured.json \`${k}\` is not an array`);
if (measured.networkProfiles !== undefined && !isObj(measured.networkProfiles)) fail("measured.json `networkProfiles` is not an object");

const INPUT_STATUS = new Set(["measured", "estimated", "verified"]);
const inputs = {};
for (const [key, v] of Object.entries(measured.inputs)) {
  if (!isObj(v) || !isNum(v.value) || v.value < 0) {
    warn(`input ${key}: no usable value, dropped (the page shows it as not measured)`);
    continue;
  }
  let status = v.status;
  if (!INPUT_STATUS.has(status)) {
    warn(`input ${key}: status ${JSON.stringify(status)} is not measured|estimated|verified; shown as estimated`);
    status = "estimated";
  }
  inputs[key] = {
    value: v.value,
    unit: str(v.unit, 120),
    status,
    n: numOrNull(v.n),
    min: numOrNull(v.min),
    max: numOrNull(v.max),
    runs: strList(v.runs),
    how: str(v.how),
  };
}
const used = Object.keys(INPUT_DEFAULTS);
const missing = used.filter((k) => !(k in inputs));
const extra = Object.keys(inputs).filter((k) => !used.includes(k));
for (const k of missing) warn(`input ${k}: not in measured.json; the page uses the model's estimate (${INPUT_DEFAULTS[k]}) and shows it as not measured`);
for (const k of extra) warn(`input ${k}: not used by the model; listed on the page as an extra measurement`);

const SPEED_STATUS = new Set(["measured", "verified", "estimated"]);
const speeds = [];
for (const [i, s] of (measured.speeds ?? []).entries()) {
  if (!isObj(s) || typeof s.id !== "string" || typeof s.network !== "string") {
    warn(`speeds[${i}]: needs an id and a network, dropped`);
    continue;
  }
  speeds.push({
    id: s.id,
    what: str(s.what, 300),
    network: s.network,
    storage: ["r2", "vault", "either"].includes(s.storage) ? s.storage : "either",
    parties: numOrNull(s.parties),
    sizeMB: numOrNull(s.sizeMB),
    metric: str(s.metric, 60) || "duration",
    p50: numOrNull(s.p50),
    p90: numOrNull(s.p90),
    p99: numOrNull(s.p99),
    unit: str(s.unit, 20) || "ms",
    runs: isNum(s.runs) ? s.runs : 0,
    status: SPEED_STATUS.has(s.status) ? s.status : "measured",
    note: str(s.note, 600),
  });
}

const LIMIT_STATUS = new Set(["measured", "documented", "verified"]);
const limits = [];
for (const [i, l] of (measured.limits ?? []).entries()) {
  if (!isObj(l) || typeof l.id !== "string") {
    warn(`limits[${i}]: needs an id, dropped`);
    continue;
  }
  limits.push({
    id: l.id,
    status: LIMIT_STATUS.has(l.status) ? l.status : "documented",
    value: str(l.value, 400),
    observed: str(l.observed, 1200),
    carton: str(l.carton, 1200),
    runs: strList(l.runs),
  });
}
const networkProfiles = {};
for (const [k, v] of Object.entries(measured.networkProfiles ?? {})) if (typeof v === "string") networkProfiles[k] = v.slice(0, 300);

// ---- prices.json: every number the model reads must be there
const need = {
  paid: ["base", "wsMessagesPerRequest"],
  free: ["workersReqDay", "workersCpuMsPerRequest", "doReqDay", "doGBsDay", "doRowsReadDay", "doRowsWrittenDay", "doStorageGB"],
};
const tiers = { paid: ["workersReq", "workersCpuMs", "doReq", "doGBs", "doRowsRead", "doRowsWritten", "doStorageGBMonth"], r2: ["storageGBMonth", "classA", "classB"] };
for (const [group, keys] of Object.entries(need)) for (const k of keys) if (!isNum(prices?.[group]?.[k])) fail(`prices.json: ${group}.${k} must be a number`);
for (const [group, keys] of Object.entries(tiers))
  for (const k of keys) for (const f of ["included", "per", "perUnit"]) if (!isNum(prices?.[group]?.[k]?.[f])) fail(`prices.json: ${group}.${k}.${f} must be a number`);
if (!Array.isArray(prices.sources) || !prices.sources.every((s) => typeof s?.url === "string" && /^https:\/\//.test(s.url))) fail("prices.json: sources must list https URLs");
if (typeof prices.fetched !== "string") fail("prices.json: `fetched` (the date) is missing");

const data = {
  schema: 1,
  built: new Date().toISOString(),
  measured: { generated: str(measured.generated, 40), source: isObj(measured.source) ? measured.source : {} },
  inputs,
  missingInputs: missing,
  extraInputs: extra,
  speeds,
  limits,
  networkProfiles,
  prices,
};
writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
for (const w of warnings) console.warn(`build-data: ${w}`);
console.log(`build-data: wrote ${out}: ${Object.keys(inputs).length} inputs (${missing.length} missing, ${extra.length} extra), ${speeds.length} speeds, ${limits.length} limits; prices of ${prices.fetched}`);
