// Phase B: runs one measurement of measure.json on this runner and reports it.
//   node ci/measure.mjs --id <id>
// Writes into <results>: the raw outputs the steps produce, measure-<id>.json (the machine, every step's exit code
// and time, and each report's per-cell medians with every run), and a job summary. A hosted runner is a shared VM:
// only comparisons made inside one job mean anything; absolute numbers describe this runner, not a user's machine.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CARTON, dirs, machine, summary, testEnv } from "./env.mjs";

const args = process.argv.slice(2);
const id = args[args.indexOf("--id") + 1];
const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "measure.json"), "utf8"));
const m = config.measurements.find((x) => x.id === id);
if (!m) throw new Error(`no measurement "${id}" in measure.json`);

const tmp = path.join(dirs.root, "carton-measure-tmp");
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(dirs.results, { recursive: true });
const pw = process.env.CARTON_PLAYWRIGHT;
const vars = { node: process.execPath, electron: process.env.CARTON_CI_ELECTRON, tmp, results: dirs.results, pwModules: pw && path.dirname(pw) };
const fill = (s) =>
  s.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) return `{${k}}`;
    if (!vars[k]) throw new Error(`{${k}} is not set (did the fetch step run with the right tools?)`);
    return vars[k];
  });

const sh = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

function runOnce(step, stdoutFile) {
  const [cmd, ...a] = step.run.map(fill);
  const cwd = path.resolve(CARTON, step.cwd ?? ".");
  const env = { ...process.env, ...testEnv(), ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, fill(v)])) };
  for (const k of ["TMPDIR"]) if (env[k]) fs.mkdirSync(env[k], { recursive: true });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = stdoutFile ? fs.createWriteStream(stdoutFile, { flags: "a" }) : null;
    const child = spawn(cmd, a, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      out?.write(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => console.error(`[measure] could not start ${cmd}: ${e.message}`));
    child.on("close", (code, signal) => {
      out?.end();
      resolve({ code, signal, ms: Date.now() - t0 });
    });
  });
}

// ---- reports ----
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
function flatten(o, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
  }
  return out;
}
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()) : []);
const parseJsonLines = (f) => readLines(f).flatMap((l) => {
  try {
    const v = JSON.parse(l);
    return v && typeof v === "object" ? [v] : [];
  } catch {
    return [];
  }
});

function cellsReport(rep, rows) {
  const ignored = (k) => (rep.ignore ?? []).some((i) => k === i || k.startsWith(i + "."));
  const groups = new Map();
  for (const r of rows) {
    const g = (rep.groupBy ?? []).map((k) => (r[k] === undefined ? null : `${k}=${r[k]}`)).filter(Boolean).join(" ");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const cells = [];
  for (const [g, rs] of groups) {
    const metrics = {};
    for (const r of rs) for (const [k, v] of Object.entries(flatten(r))) if (!ignored(k) && !(rep.groupBy ?? []).includes(k)) (metrics[k] ??= []).push(v);
    cells.push({ cell: g, runs: rs.length, metrics: Object.fromEntries(Object.entries(metrics).map(([k, xs]) => [k, { median: median(xs), runs: xs }])) });
  }
  return { file: rep.file, kind: "cells", cells };
}

function report(rep) {
  const f = path.join(dirs.results, rep.file);
  if (!fs.existsSync(f)) return { file: rep.file, missing: true };
  if (rep.kind === "json") {
    const rows = parseJsonLines(f);
    let whole = null;
    try {
      whole = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {}
    return { file: rep.file, kind: "json", value: whole ?? (rows.length > 1 ? rows : (rows[0] ?? null)) };
  }
  if (rep.kind === "repeat") return { file: rep.file, kind: "repeat", ...repeats[rep.file] };
  if (rep.kind === "tap-json") return { file: rep.file, kind: "tap-json", value: readLines(f).flatMap((l) => {
    const x = /^\s*# (\{.*\})\s*$/.exec(l);
    if (!x) return [];
    try {
      return [JSON.parse(x[1])];
    } catch {
      return [];
    }
  }), passed: readLines(f).some((l) => /^# fail 0$/.test(l)) };
  return cellsReport(rep, parseJsonLines(f));
}

// ---- main ----
const info = { ...machine(), lscpu: sh("lscpu", [])?.split("\n").filter((l) => /^(Model name|CPU\(s\)|Thread|Core|Socket|L2|L3)/.test(l)).map((l) => l.replace(/\s+/g, " ")).join("; ") ?? null, uptimeBefore: sh("uptime", []) };
console.log(`measurement ${id} (${m.agent}): ${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, node ${info.node}`);
const steps = [];
const repeats = {};
for (const step of m.steps) {
  console.log(`::group::${step.label}`);
  const stdoutFile = step.stdoutTo ? fill(step.stdoutTo) : null;
  if (stdoutFile) fs.rmSync(stdoutFile, { force: true });
  const runs = [];
  for (let i = 0; i < (step.repeat ?? 1); i++) runs.push(await runOnce(step, stdoutFile));
  console.log("::endgroup::");
  const failed = runs.filter((r) => r.code !== 0).length;
  steps.push({ label: step.label, command: step.run.join(" "), runs: runs.length, failed, ms: runs.reduce((a, r) => a + r.ms, 0), ok: step.allowFail || failed === 0 });
  if (step.repeat && stdoutFile) repeats[path.basename(stdoutFile)] = { runs: runs.length, failedRuns: failed, codes: runs.map((r) => r.code) };
  console.log(`${step.allowFail || failed === 0 ? "DONE" : "FAIL"} ${step.label}: ${runs.length} run(s), ${failed} failed`);
}
info.uptimeAfter = sh("uptime", []);
const reports = (m.reports ?? []).map(report);
const result = { id, agent: m.agent, claim: m.claim, sha: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, at: new Date().toISOString(), machine: info, steps, reports };
fs.writeFileSync(path.join(dirs.results, `measure-${id}.json`), JSON.stringify(result, null, 1));

// the job summary: every cell's medians with every run
const fmt = (x) => (typeof x !== "number" ? String(x) : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));
let md = `### ${id} (${m.agent})\n\n${m.claim}\n\n${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, Node ${info.node}${info.image ? ", " + info.image : ""}. ${info.uptimeBefore ?? ""}\n\n`;
md += steps.map((s) => `- ${s.ok ? "✅" : "❌"} ${s.label}: ${s.runs} run(s), ${s.failed} failed, ${(s.ms / 1000).toFixed(0)} s`).join("\n") + "\n";
for (const r of reports) {
  md += `\n#### ${r.file}\n\n`;
  if (r.missing) md += "missing\n";
  else if (r.kind === "cells")
    for (const c of r.cells) {
      md += `<details><summary>${c.cell || "all"} (${c.runs} runs)</summary>\n\n| metric | median | every run |\n|---|---|---|\n`;
      for (const [k, v] of Object.entries(c.metrics)) md += `| ${k} | ${fmt(v.median)} | ${v.runs.map(fmt).join(", ")} |\n`;
      md += "\n</details>\n";
    }
  else md += "```json\n" + JSON.stringify(r.value ?? r, null, 1).slice(0, 20000) + "\n```\n";
}
summary(md);
console.log(`results: ${path.join(dirs.results, `measure-${id}.json`)}`);
process.exitCode = steps.every((s) => s.ok) && reports.every((r) => !r.missing) ? 0 : 1;
