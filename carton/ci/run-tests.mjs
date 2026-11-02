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
  // Each `node --test` prints one TAP document: its header, results, then a summary block with one `# tests` count
  // and `# duration_ms` last. A document without that end (the runner crashed or was killed), with no count or two, or
  // a summary outside any document, makes the report malformed.
  const documents = []; // { tests: number | null, ended: boolean }
  let malformed = 0;
  const current = () => {
    const d = documents.at(-1);
    return d && !d.ended ? d : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^TAP version \d+$/.test(line)) {
      if (current()) malformed++;
      documents.push({ tests: null, ended: false });
      continue;
    }
    if (/^# duration_ms [\d.]+$/.test(line)) {
      const d = current();
      if (d) d.ended = true;
      else malformed++;
      continue;
    }
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
      const d = current();
      if (!d) malformed++;
      else if (m[1] === "tests") {
        if (d.tests !== null) malformed++;
        d.tests = Number(m[2]);
      }
      totals[m[1]] += Number(m[2]);
    }
  }
  // a failed subtest fails its parents too: report the innermost ones
  const failures = fails.filter((f) => !fails.some((g) => g !== f && g.name.startsWith(f.name + " › ")));
  return { totals, documents: documents.length, complete: documents.filter((d) => d.ended && d.tests !== null).length, testsPerDocument: documents.map((d) => d.tests), malformed, failures, skips, todos };
}

// The YAML diagnostics block after a result line, trimmed to what helps: the error, its location and stack head.
// In a group that runs Cardboard's code, any error text can quote it (a code frame, a minified source line), so
// there only the location and the error's class and code are kept; the message stays in the job's own log.
function yaml(lines, from) {
  const open = /^( *)---$/.exec(lines[from] ?? "");
  if (!open) return "";
  const raw = [];
  for (let i = from + 1; i < lines.length && !/^\s*\.\.\.$/.test(lines[i]); i++) raw.push(lines[i]);
  if (group.proprietary) {
    // only the block's own keys (lines at its indentation, never the inside of a multi-line value), and only values
    // shaped like a path or an identifier
    const own = raw.filter((l) => l.startsWith(open[1]) && l[open[1].length] !== " ").map((l) => l.slice(open[1].length));
    const allowed = [/^location: '[^'\r\n]{1,300}'$/, /^name: '?[A-Za-z_$][\w$]{0,60}'?$/, /^code: '?[A-Z][A-Z0-9_]{0,60}'?$/, /^failureType: '?[A-Za-z]{1,40}'?$/];
    return own.filter((l) => allowed.some((re) => re.test(l))).join("\n");
  }
  return raw.map((l) => l.trim()).filter((l) => !/^(duration_ms|type|failureType|code):/.test(l)).slice(0, 40).join("\n");
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
  // On one agent's branch (carton-agent.yml sets CARTON_CI_AGENT) a group may name a package or folder that branch
  // doesn't have: that step is reported as not run, not as a crash. On ci/carton every one must exist.
  const missing = step.pkg ? !fs.existsSync(path.join(cwd, "package.json")) : !fs.existsSync(cwd);
  if (missing && process.env.CARTON_CI_AGENT) {
    const why = `not in this checkout (${path.relative(CARTON, cwd)}): not run`;
    console.log(`::notice::${label}: ${why}`);
    return Promise.resolve({ label, cwd: path.relative(CARTON, cwd), command: "", exit: null, signal: null, timedOut: false, ms: 0, ok: true, notRun: why, problems: [] });
  }
  // A package step runs its `test` script's commands as npm would (they are plain `node --test …` lines joined by
  // &&), each with the TAP reporter added.
  const script = step.pkg && JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts.test;
  const [cmd, ...cmdArgs] = step.pkg ? [script.replace(/(^|\s)--test(?=\s|$)/g, `$1--test ${TAP}`)] : tapArgs(step.run.map(fill));
  // how many TAP documents the step must print: one per `node --test` it runs
  const expectedDocs = step.kind === "plain" ? 0 : step.pkg ? (script.match(/(^|\s)--test(?=\s|$)/g) ?? []).length : step.run.includes("--test") ? 1 : 0;
  const shell = Boolean(step.pkg || (OS === "windows" && step.shell));
  // A group that runs Cardboard's code keeps its raw logs out of the uploaded results (they may quote that code).
  const logDir = group.proprietary ? path.join(dirs.root, "carton-logs-private") : dirs.results;
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${groupName}-${OS}-${String(index + 1).padStart(2, "0")}.log`);
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
    // The step ends when its output closes. A descendant that outlives the step's process can keep a pipe open (and
    // on Windows taskkill /T can't reach it once its parent is gone), so after the process exits, or after a timeout
    // kill, the step is finished within GRACE_MS whatever its pipes do.
    const GRACE_MS = 15_000;
    let timedOut = false;
    let exited = null;
    let finished = false;
    const finish = (how) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      log.end();
      console.log("::endgroup::");
      const code = exited?.code ?? null;
      const signal = exited?.signal ?? null;
      const ms = Date.now() - t0;
      const tap = step.kind === "plain" ? null : parseTap(text);
      const problems = [];
      if (timedOut) problems.push("timed out");
      if (how) problems.push(how);
      if (code !== 0) problems.push(`exit ${code ?? signal ?? "unknown"}`);
      if (tap) {
        if (expectedDocs === 0) problems.push("the step runs no node --test");
        if (tap.documents !== expectedDocs || tap.complete !== tap.documents || tap.malformed) problems.push(`expected ${expectedDocs} complete node:test report(s), got ${tap.documents} started, ${tap.complete} complete${tap.malformed ? `, ${tap.malformed} malformed` : ""}`);
        // per report: one `node --test` whose glob matched nothing must not hide behind another that ran tests
        if (!step.allowEmpty && (tap.totals.tests === 0 || tap.testsPerDocument.some((n) => n === 0))) problems.push("a node:test run had no tests");
        const failed = Math.max(tap.totals.fail + tap.totals.cancelled, tap.failures.length);
        if (failed > 0) problems.push(`${failed} failed`);
      }
      const badSkips = tap ? tap.skips.filter((s) => forbidden.some((re) => re.test(s.reason))) : [];
      if (badSkips.length) problems.push(`${badSkips.length} skipped for a missing tool CI installed`);
      // what leaves the job (summary, JSON): in a Cardboard group a skip reason keeps only its head, before any
      // quoted detail (a path, an error message)
      const out = (list) => (group.proprietary ? list.map((x) => ({ ...x, reason: x.reason.split(/[:(\n]/)[0].slice(0, 80) })) : list);
      resolve({ label, cwd: path.relative(CARTON, cwd) || ".", command: [cmd, ...cmdArgs].join(" "), exit: code, signal, timedOut, ms, ok: problems.length === 0, problems, ...(tap ?? {}), ...(tap ? { skips: out(tap.skips), todos: out(tap.todos) } : {}), badSkips: out(badSkips), log: group.proprietary ? null : path.basename(logFile) });
    };
    let grace;
    const timer = setTimeout(() => {
      timedOut = true;
      onData(`\n[ci] step timed out after ${step.timeoutMin ?? stepTimeoutMin} min; killing it\n`);
      killTree(child);
      grace = setTimeout(() => finish("its processes didn't end after the kill"), GRACE_MS);
    }, (step.timeoutMin ?? stepTimeoutMin) * 60_000);
    child.on("error", (e) => {
      onData(`\n[ci] could not start: ${e.message}\n`);
      exited ??= { code: null, signal: null };
      finish("could not start");
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
  md += `| ${esc(r.label)} | ${r.notRun ? "➖ " + esc(r.notRun) : r.ok ? "✅" : "❌ " + esc(r.problems.join(", "))} | ${t?.tests ?? "–"} | ${t?.pass ?? "–"} | ${t ? t.fail + t.cancelled : "–"} | ${t?.skipped ?? "–"} | ${t?.todo ?? "–"} | ${fmtMs(r.ms)} |\n`;
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

console.log("\n" + results.map((r) => `${r.notRun ? "NOT RUN" : r.ok ? "PASS" : "FAIL"} ${r.label} (${fmtMs(r.ms)})${r.ok ? "" : ": " + r.problems.join(", ")}`).join("\n"));
for (const r of results)
  for (const f of r.failures ?? []) console.log(`\n--- failed: ${r.label} › ${f.name}\n${f.detail}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
