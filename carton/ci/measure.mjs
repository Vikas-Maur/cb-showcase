// Phase B: runs one measurement of measure.json on this runner and reports it.
//   node ci/measure.mjs --id <id> [--timeout-min <the job's timeout>]
// Writes into <results>: the raw outputs the steps produce, each step's stderr (<id>-step<N>.stderr.log),
// measure-<id>.json (the machine, every run's exit code, signal and time, and each report's per-cell medians with
// every run), and a job summary. measure-<id>.json is written at the start and after every run, and the steps stop at
// an internal deadline 4 minutes before the job's timeout, so a measurement that runs long still leaves its record.
// A hosted runner is a shared VM: only comparisons made inside one job mean anything; absolute numbers describe this
// runner, not a user's machine.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CARTON, OS, dirs, machine, summary, testEnv } from "./env.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const id = opt("--id");
const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "measure.json"), "utf8"));
const m = config.measurements.find((x) => x.id === id);
if (!m) throw new Error(`no measurement "${id}" in measure.json`);
const t0 = Date.now();
const deadline = t0 + Math.max(1, Number(opt("--timeout-min") ?? m.timeout ?? 60) - 4) * 60_000;

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

function killTree(child) {
  if (OS === "windows") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

// One run of a step: stdout to the console and `stdoutFile` (appended), stderr to the console and `stderrFile`.
// Resolves once the process is gone and both files are flushed. Killed at the internal deadline.
function runOnce(step, stdoutFile, stderrFile, label) {
  const [cmd, ...a] = step.run.map(fill);
  const cwd = path.resolve(CARTON, step.cwd ?? ".");
  const env = { ...process.env, ...testEnv(), ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, fill(v)])) };
  if (env.TMPDIR) fs.mkdirSync(env.TMPDIR, { recursive: true });
  const t = Date.now();
  const out = stdoutFile ? fs.createWriteStream(stdoutFile, { flags: "a" }) : null;
  const err = fs.createWriteStream(stderrFile, { flags: "a" });
  err.write(`\n=== ${label} (${new Date().toISOString()})\n`);
  const done = (s) => (s ? new Promise((r) => s.end(r)) : Promise.resolve());
  return new Promise((resolve) => {
    let text = "";
    const keep = (d) => {
      if (text.length < 4 << 20) text += d;
    };
    let error = null;
    let killed = false;
    const child = spawn(cmd, a, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: OS !== "windows" });
    // The run ends when its output closes. A process it started that escaped the kill can hold a pipe open, so after
    // its own process exits, or after the deadline kill, the run is finished within GRACE_MS whatever its pipes do.
    const GRACE_MS = 15_000;
    let exited = null;
    let finished = false;
    let grace = null;
    const finish = async (how) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      if (how) err.write(`\n[measure] ${how}\n`);
      await Promise.all([done(out), done(err)]);
      resolve({ code: exited?.code ?? null, signal: exited?.signal ?? null, ms: Date.now() - t, ...(killed ? { deadline: true } : {}), ...(error ? { error } : {}), ...(how ? { unfinishedOutput: true } : {}), text });
    };
    const timer = setTimeout(() => {
      killed = true;
      err.write(`\n[measure] killed at the internal deadline\n`);
      killTree(child);
      grace ??= setTimeout(() => finish("its processes kept their output open after the kill"), GRACE_MS);
    }, Math.max(0, deadline - Date.now()));
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      out?.write(d);
      keep(d);
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      err.write(d);
      keep(d);
    });
    child.on("error", (e) => {
      error = e.message;
      err.write(`[measure] could not start ${cmd}: ${e.message}\n`);
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      grace ??= setTimeout(() => finish("a process it started kept its output open"), GRACE_MS);
    });
    child.on("close", (code, signal) => {
      exited ??= { code, signal };
      finish(null);
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
// JSON lines; a line that doesn't parse is counted, so a report can fail on it
function parseJsonLines(f) {
  const rows = [];
  let bad = 0;
  for (const l of readLines(f)) {
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object") rows.push(v);
      else bad++;
    } catch {
      if (l.trim().startsWith("{")) bad++;
    }
  }
  return { rows, bad };
}

// `groupBy` keys may be dotted paths into a row (`link.name`); `where` keeps only rows whose fields equal its values.
const at = (o, k) => k.split(".").reduce((x, p) => (x == null ? undefined : x[p]), o);
function cellsReport(rep, allRows) {
  const ignored = (k) => (rep.ignore ?? []).some((i) => k === i || k.startsWith(i + "."));
  const rows = allRows.filter((r) => Object.entries(rep.where ?? {}).every(([k, v]) => at(r, k) === v));
  const groups = new Map();
  for (const r of rows) {
    const g = (rep.groupBy ?? []).map((k) => (at(r, k) === undefined ? null : `${k}=${at(r, k)}`)).filter(Boolean).join(" ");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const cells = [];
  for (const [g, rs] of groups) {
    const metrics = {};
    for (const r of rs) for (const [k, v] of Object.entries(flatten(r))) if (!ignored(k) && !(rep.groupBy ?? []).includes(k) && !Object.hasOwn(rep.where ?? {}, k)) (metrics[k] ??= []).push(v);
    cells.push({ cell: g, runs: rs.length, metrics: Object.fromEntries(Object.entries(metrics).map(([k, xs]) => [k, { median: median(xs), runs: xs }])) });
  }
  return { rows: rows.length, cells };
}

// A report is checked, not just read: `expect` gives the rows, cells and runs per cell the measurement must produce
// (a runner that skips a failed cell would otherwise leave valid-looking medians over fewer runs, or one side of an
// A/B), and `noErrors` names an array field that must be empty in every row (page errors).
function report(rep) {
  const f = path.join(dirs.results, rep.file);
  const problems = [];
  const e = rep.expect ?? {};
  if (rep.kind === "repeat") {
    // judged from the runs' own records (exit codes and their diagnostics), not from what they printed
    const r = repeats[rep.file];
    if (!r) return { file: rep.file, kind: "repeat", problems: ["no repeat record"] };
    if (r.unexplained) problems.push(`${r.unexplained} run(s) failed without the expected diagnostic`);
    return { file: rep.file, kind: "repeat", ...r, problems };
  }
  if (!fs.existsSync(f) || fs.statSync(f).size === 0) return { file: rep.file, problems: ["missing or empty"] };
  if (rep.kind === "text") {
    // a tool that prints lines of text: kept as it is; `mustMatch` names lines it must print (its own checks)
    const text = fs.readFileSync(f, "utf8");
    for (const re of rep.mustMatch ?? []) if (!new RegExp(re, "m").test(text)) problems.push(`no line matching /${re}/`);
    return { file: rep.file, kind: "text", value: text.slice(-20000), problems };
  }
  if (rep.kind === "json") {
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      const text = fs.readFileSync(f, "utf8");
      const { rows, bad } = parseJsonLines(f);
      if (rep.lastJson) {
        // progress lines, then one pretty-printed JSON value: the value is what starts at the last line opening a `{`
        try {
          value = JSON.parse(text.slice(text.lastIndexOf("\n{") + 1));
        } catch {
          value = null;
        }
      } else {
        if (bad) problems.push(`${bad} line(s) are not JSON`);
        value = rows.length > 1 ? rows : (rows[0] ?? null);
      }
    }
    if (value === null) problems.push("no JSON value");
    if (e.rows !== undefined && (Array.isArray(value) ? value.length : value === null ? 0 : 1) !== e.rows) problems.push(`expected ${e.rows} JSON value(s)`);
    return { file: rep.file, kind: "json", value, problems };
  }
  if (rep.kind === "tap-json") {
    const lines = readLines(f);
    const value = lines.flatMap((l) => {
      const x = /^\s*# (\{.*\})\s*$/.exec(l);
      if (!x) return [];
      try {
        return [JSON.parse(x[1])];
      } catch {
        return [];
      }
    });
    const passed = lines.some((l) => /^# fail 0$/.test(l)) && lines.some((l) => /^# pass [1-9]/.test(l));
    if (!passed) problems.push("the tests did not all pass");
    if (!value.length) problems.push("no JSON diagnostics");
    if (e.rows !== undefined && value.length !== e.rows) problems.push(`expected ${e.rows} JSON diagnostic(s), got ${value.length}`);
    return { file: rep.file, kind: "tap-json", value, passed, problems };
  }
  const { rows, bad } = parseJsonLines(f);
  if (bad) problems.push(`${bad} line(s) are not JSON`);
  const c = cellsReport(rep, rows);
  if (!c.rows) problems.push("no rows");
  if (e.rows !== undefined && c.rows !== e.rows) problems.push(`expected ${e.rows} rows, got ${c.rows}`);
  if (e.cells !== undefined && c.cells.length !== e.cells) problems.push(`expected ${e.cells} cells, got ${c.cells.length}`);
  if (e.runsPerCell !== undefined) for (const x of c.cells) if (x.runs !== e.runsPerCell) problems.push(`cell "${x.cell}" has ${x.runs} runs, expected ${e.runsPerCell}`);
  // grouping keys are required on the rows the report uses (after `where`), not on a tool's other lines
  const used = rows.filter((r) => Object.entries(rep.where ?? {}).every(([k, v]) => at(r, k) === v));
  for (const k of rep.groupBy ?? []) if (used.some((r) => at(r, k) === undefined) && !(rep.optionalKeys ?? []).includes(k)) problems.push(`some rows lack the grouping key ${k}`);
  if (rep.noErrors) {
    const n = rows.filter((r) => Array.isArray(at(r, rep.noErrors)) && at(r, rep.noErrors).length).length;
    if (n) problems.push(`${n} row(s) with ${rep.noErrors}`);
  }
  return { file: rep.file, kind: "cells", ...c, problems };
}

// ---- main ----
const info = { ...machine(), lscpu: sh("lscpu", [])?.split("\n").filter((l) => /^(Model name|CPU\(s\)|Thread|Core|Socket|L2|L3)/.test(l)).map((l) => l.replace(/\s+/g, " ")).join("; ") ?? null, uptimeBefore: sh("uptime", []) };
console.log(`measurement ${id} (${m.agent}): ${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, node ${info.node}`);
const steps = [];
const repeats = {};
const recordFile = path.join(dirs.results, `measure-${id}.json`);
const record = (status, reports = null) =>
  fs.writeFileSync(recordFile, JSON.stringify({ id, agent: m.agent, claim: m.claim, status, sha: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, at: new Date().toISOString(), machine: info, steps, reports }, null, 1));
record("running");

for (const [n, step] of m.steps.entries()) {
  const stdoutFile = step.stdoutTo ? fill(step.stdoutTo) : null;
  const stderrFile = path.join(dirs.results, `${id}-step${n + 1}.stderr.log`);
  const s = { label: step.label, command: step.run.join(" "), runs: [], ok: false, stderr: path.basename(stderrFile) };
  steps.push(s);
  if (Date.now() >= deadline) {
    s.skipped = "the internal deadline had passed";
    record("running");
    continue;
  }
  if (stdoutFile) fs.rmSync(stdoutFile, { force: true });
  console.log(`::group::${step.label}`);
  for (let i = 0; i < (step.repeat ?? 1) && Date.now() < deadline; i++) {
    const { text, ...r } = await runOnce(step, stdoutFile, stderrFile, `run ${i + 1}`);
    // `failPattern`: a failed run counts as an observation only when it shows the expected diagnostic
    if (r.code !== 0 && step.failPattern) r.explained = new RegExp(step.failPattern).test(text);
    s.runs.push(r);
    record("running");
  }
  console.log("::endgroup::");
  const failed = s.runs.filter((r) => r.code !== 0);
  const unexplained = failed.filter((r) => !r.explained).length;
  s.ok = s.runs.length === (step.repeat ?? 1) && !s.runs.some((r) => r.deadline) && (step.failPattern ? unexplained === 0 : failed.length === 0);
  if (step.failPattern && stdoutFile) repeats[path.basename(stdoutFile)] = { runs: s.runs.length, failedRuns: failed.length, observed: failed.length - unexplained, unexplained, codes: s.runs.map((r) => r.code) };
  console.log(`${s.ok ? "DONE" : "FAIL"} ${step.label}: ${s.runs.length} run(s), ${failed.length} failed${step.failPattern ? ` (${failed.length - unexplained} with the expected diagnostic)` : ""}`);
  record("running");
}
info.uptimeAfter = sh("uptime", []);
const reports = (m.reports ?? []).map(report);
const ok = steps.every((s) => s.ok) && reports.every((r) => !r.problems.length);
record(ok ? "complete" : "failed", reports);

// the job summary: every cell's medians with every run
const fmt = (x) => (typeof x !== "number" ? String(x) : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));
let md = `### ${id} (${m.agent}) ${ok ? "✅" : "❌"}\n\n${m.claim}\n\n${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, Node ${info.node}${info.image ? ", " + info.image : ""}. ${info.uptimeBefore ?? ""}\n\n`;
md += steps.map((s) => `- ${s.ok ? "✅" : "❌"} ${s.label}: ${s.skipped ?? `${s.runs.length} run(s), exit ${s.runs.map((r) => r.code ?? r.signal).join(" ")}, ${(s.runs.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0)} s`}`).join("\n") + "\n";
for (const r of reports) {
  md += `\n#### ${r.file}${r.problems.length ? " ❌ " + r.problems.join("; ") : ""}\n\n`;
  if (r.kind === "cells")
    for (const c of r.cells) {
      md += `<details><summary>${c.cell || "all"} (${c.runs} runs)</summary>\n\n| metric | median | every run |\n|---|---|---|\n`;
      for (const [k, v] of Object.entries(c.metrics)) md += `| ${k} | ${fmt(v.median)} | ${v.runs.map(fmt).join(", ")} |\n`;
      md += "\n</details>\n";
    }
  else if (r.kind === "text") md += "```\n" + r.value + "\n```\n";
  else if (r.kind) md += "```json\n" + JSON.stringify(r.value ?? r, null, 1).slice(0, 20000) + "\n```\n";
}
summary(md);
console.log(`results: ${recordFile} (${ok ? "complete" : "failed"})`);
process.exitCode = ok ? 0 : 1;
