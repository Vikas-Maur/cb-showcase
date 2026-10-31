// Runs one test group of groups.json on this machine and reports it.
//   node ci/run-tests.mjs --group <name> [--timeout-min <per step, default 20>]
// Each step is a package's `npm test` or a command (see groups.json). Every `node --test` is run with the TAP reporter,
// which is read to count passes, failures and skips. Writes:
// - the job summary ($GITHUB_STEP_SUMMARY): a row per step, every skip reason, every failure;
// - an ::error:: annotation per failed test, so failures show on the run's page;
// - <results>/<group>-<os>.json and a raw log per step (uploaded as the run's artifact: results only).
// A skip whose reason matches the group's forbidSkip fails the group: CI installed what that test asks for, so the
// skip means the setup broke and the test silently didn't run.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CARTON, OS, dirs, machine, summary, testEnv } from "./env.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const groupName = opt("--group");
const stepTimeoutMin = Number(opt("--timeout-min", "20"));
const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "groups.json"), "utf8"));
const group = config.groups.find((g) => g.name === groupName);
if (!group) throw new Error(`no group "${groupName}" in groups.json`);
const forOs = (v) => (Array.isArray(v) || v === undefined ? (v ?? []) : (v[OS] ?? []));
const forbidden = forOs(group.forbidSkip).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
const steps = group.steps.filter((s) => !s.os || s.os.includes(OS));

fs.mkdirSync(dirs.results, { recursive: true });
const baseEnv = { ...process.env, ...testEnv(), NO_COLOR: "1", FORCE_COLOR: "0" };
const fill = (a) =>
  a.replace(/\{(node|electron)\}/g, (_, k) => {
    const v = k === "node" ? process.execPath : process.env.CARTON_CI_ELECTRON;
    if (!v) throw new Error(`{${k}} is not set (did the fetch step run with "${k}"?)`);
    return v;
  });

// ---- TAP ----
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const names = [];
  const fails = [];
  const skips = [];
  const todos = [];
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let sawSummary = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^( *)# Subtest: (.*)$/.exec(line);
    if (m) {
      const depth = m[1].length >> 2;
      names.length = depth;
      names[depth] = m[2];
      continue;
    }
    m = /^( *)(not ok|ok) \d+ - (.*)$/.exec(line);
    if (m) {
      const depth = m[1].length >> 2;
      let name = m[3];
      let directive = null;
      let reason = "";
      const d = /(?<!\\) # (SKIP|TODO)\b ?(.*)$/i.exec(name);
      if (d) {
        directive = d[1].toUpperCase();
        reason = d[2].trim();
        name = name.slice(0, d.index);
      }
      const full = [...names.slice(0, depth), name].join(" › ").replace(/\\#/g, "#");
      if (directive === "SKIP") skips.push({ name: full, reason });
      else if (directive === "TODO") todos.push({ name: full, reason });
      else if (m[2] === "not ok") fails.push({ name: full, detail: yaml(lines, i + 1) });
      continue;
    }
    m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (m) {
      totals[m[1]] += Number(m[2]);
      sawSummary = true;
    }
  }
  // a failed subtest fails its parents too: report the innermost ones
  const failures = fails.filter((f) => !fails.some((g) => g !== f && g.name.startsWith(f.name + " › ")));
  return { totals, sawSummary, failures, skips, todos };
}

// The YAML diagnostics block after a result line, trimmed to what helps: the error, its location and stack head.
function yaml(lines, from) {
  if (!/^\s*---$/.test(lines[from] ?? "")) return "";
  const out = [];
  for (let i = from + 1; i < lines.length && !/^\s*\.\.\.$/.test(lines[i]); i++) out.push(lines[i].trim());
  return out.filter((l) => !/^(duration_ms|type|failureType|code):/.test(l)).slice(0, 40).join("\n");
}

// ---- running a step ----
function killTree(child) {
  if (OS === "windows") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

// node:test prints its spec reporter even into a pipe; ask every `node --test` for TAP instead.
const TAP = "--test-reporter=tap";
const tapArgs = (a) => (a.includes("--test") && !a.some((x) => x.startsWith("--test-reporter")) ? a.flatMap((x) => (x === "--test" ? [x, TAP] : [x])) : a);

function runStep(step, index) {
  const label = step.label ?? `${step.pkg}: npm test`;
  const cwd = path.resolve(CARTON, step.pkg ? path.join("packages", step.pkg) : (step.cwd ?? "."));
  // A package step runs its `test` script's commands as npm would (they are plain `node --test …` lines joined by
  // &&), each with the TAP reporter added.
  const script = step.pkg && JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts.test;
  const [cmd, ...cmdArgs] = step.pkg ? [script.replace(/(^|\s)--test(?=\s|$)/g, `$1--test ${TAP}`)] : tapArgs(step.run.map(fill));
  const shell = Boolean(step.pkg || (OS === "windows" && step.shell));
  const logFile = path.join(dirs.results, `${groupName}-${OS}-${String(index + 1).padStart(2, "0")}.log`);
  const log = fs.createWriteStream(logFile);
  const t0 = Date.now();
  console.log(`::group::${label}`);
  console.log(`$ (${path.relative(CARTON, cwd) || "."}) ${[cmd, ...cmdArgs].join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(shell ? [cmd, ...cmdArgs].join(" ") : cmd, shell ? [] : cmdArgs, {
      cwd,
      env: { ...baseEnv, ...(step.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      detached: OS !== "windows",
    });
    let text = "";
    const onData = (d) => {
      process.stdout.write(d);
      log.write(d);
      text += d;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onData(`\n[ci] step timed out after ${step.timeoutMin ?? stepTimeoutMin} min; killing it\n`);
      killTree(child);
    }, (step.timeoutMin ?? stepTimeoutMin) * 60_000);
    child.on("error", (e) => onData(`\n[ci] could not start: ${e.message}\n`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      log.end();
      console.log("::endgroup::");
      const ms = Date.now() - t0;
      const tap = step.kind === "plain" ? null : parseTap(text);
      const problems = [];
      if (timedOut) problems.push("timed out");
      if (code !== 0) problems.push(`exit ${code ?? signal}`);
      if (tap && !tap.sawSummary) problems.push("no node:test summary in the output");
      if (tap && tap.totals.fail + tap.totals.cancelled > 0) problems.push(`${tap.totals.fail + tap.totals.cancelled} failed`);
      const badSkips = tap ? tap.skips.filter((s) => forbidden.some((re) => re.test(s.reason))) : [];
      if (badSkips.length) problems.push(`${badSkips.length} skipped for a missing tool CI installed`);
      resolve({ label, cwd: path.relative(CARTON, cwd) || ".", command: [cmd, ...cmdArgs].join(" "), exit: code, signal, timedOut, ms, ok: problems.length === 0, problems, ...(tap ?? {}), badSkips, log: path.basename(logFile) });
    });
  });
}

// ---- main ----
const info = machine();
console.log(`group ${groupName} on ${info.os}: ${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, node ${info.node}`);
const results = [];
for (const [i, step] of steps.entries()) results.push(await runStep(step, i));

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const fmtMs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
let md = `### ${group.name} on ${OS}\n\n${info.cpu}, ${info.cores} cores, ${info.memGiB} GiB, Node ${info.node}${info.image ? ", " + info.image : ""}\n\n`;
md += "| step | result | tests | pass | fail | skipped | todo | time |\n|---|---|---|---|---|---|---|---|\n";
for (const r of results) {
  const t = r.totals;
  md += `| ${esc(r.label)} | ${r.ok ? "✅" : "❌ " + esc(r.problems.join(", "))} | ${t?.tests ?? "–"} | ${t?.pass ?? "–"} | ${t ? t.fail + t.cancelled : "–"} | ${t?.skipped ?? "–"} | ${t?.todo ?? "–"} | ${fmtMs(r.ms)} |\n`;
}
for (const r of results) {
  if (r.failures?.length) {
    md += `\n<details open><summary>❌ ${esc(r.label)}: ${r.failures.length} failed</summary>\n\n`;
    for (const f of r.failures.slice(0, 30)) md += `- **${esc(f.name)}**\n\n  \`\`\`\n  ${f.detail.split("\n").join("\n  ")}\n  \`\`\`\n`;
    md += "\n</details>\n";
  }
  if (r.badSkips?.length) md += `\n❌ **${esc(r.label)}: skipped although CI installed what they need**\n${r.badSkips.map((s) => `- ${esc(s.name)}: ${esc(s.reason)}`).join("\n")}\n`;
  if (r.skips?.length || r.todos?.length) {
    const reasons = new Map();
    for (const s of [...r.skips, ...r.todos.map((x) => ({ ...x, reason: "TODO " + x.reason }))]) reasons.set(s.reason, [...(reasons.get(s.reason) ?? []), s.name]);
    md += `\n<details><summary>${esc(r.label)}: ${r.skips.length} skipped, ${r.todos.length} todo</summary>\n\n`;
    for (const [reason, names] of reasons) md += `- ${esc(reason || "(no reason)")}: ${names.length} (${esc(names.slice(0, 3).join("; "))}${names.length > 3 ? "; …" : ""})\n`;
    md += "\n</details>\n";
  }
}
summary(md);
for (const r of results) for (const f of (r.failures ?? []).slice(0, 10)) console.log(`::error title=${esc(group.name)} (${OS}): ${esc(r.label)}::${esc(f.name)}`);
fs.writeFileSync(path.join(dirs.results, `${groupName}-${OS}.json`), JSON.stringify({ group: groupName, machine: info, at: new Date().toISOString(), sha: process.env.GITHUB_SHA ?? null, results }, null, 1));

console.log("\n" + results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.label} (${fmtMs(r.ms)})${r.ok ? "" : ": " + r.problems.join(", ")}`).join("\n"));
for (const r of results)
  for (const f of r.failures ?? []) console.log(`\n--- failed: ${r.label} › ${f.name}\n${f.detail}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
