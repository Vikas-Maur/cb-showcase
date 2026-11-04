// Agents editing one project at once through `cb source apply`, as Claude Code or Codex does from a terminal: the
// writers in gates G1 and G2 (PLAN §16, §6.2), and a check for the lost update (B1).
//   node scripts/carton/writers.js setup <cb> <root> [clip.mp4]       makes the project "Carton gates" in <root>
//   node scripts/carton/writers.js run <cb> <root> [--writers 4] [--rate 1] [--seconds 60] [--out writers.json]
// <cb> is resources\cli\cardboard.mjs (run with this Node) or Cardboard.exe's cb shim. Writer k sets the font size of
// its own title, "W<k>", and nothing else, at --rate edits a second, each from a fresh print of the timeline (so each
// edit's base is the version it read). At the end it reads the timeline back: every writer's last applied size must
// be there. A size that isn't, though cb reported it applied, is a lost update. It prints each writer's applies,
// failures and apply time (p50, p90, p99), and the lost count; then, when any failed, why: each failure's step, exit
// code and message in brief (also `failures` in --out), so a rare one can be diagnosed (a 4-writer run had 1 in 155).
// --out also keeps every timed edit raw (`samples`, per writer: its edit number, start as epoch ms, duration in ms from
// the print to the apply's answer, as the table's p50/p90/p99 take it, and outcome, "applied" or "failed"), so a timing
// claim can be recomputed later from the run itself. The printed table is unchanged. perf/apply-tail: each sample also
// has the print's and the apply's own times (`print`, `apply`: each cb process from spawn to exit; `ms` is their sum
// plus writing the edited file) and the apply's `carton.timeline` answer (`timeline`: "shown", "held", "elsewhere",
// "later" when the app's timeline.tsx didn't show the write within cb's 2 s wait; null with Carton off or the app
// closed), so a slow round trip says which process held it, and whether it was that wait.
const fs = require("fs"), os = require("os"), path = require("path"), { spawn, spawnSync } = require("child_process");

const [cmd, cbPath, root, ...rest] = process.argv.slice(2);
const opt = (name, def) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : def; };
const PROJECT = "Carton gates";
const cbArgs = (args) => (cbPath.endsWith(".mjs") ? [process.execPath, [cbPath, "--root", root, ...args]] : [cbPath, ["--root", root, ...args]]);
const cbSync = (...args) => {
  const [exe, a] = cbArgs(args);
  const r = spawnSync(exe, a, { encoding: "utf8", shell: process.platform === "win32" && !exe.endsWith(".exe") && exe !== process.execPath });
  if (r.status !== 0) throw new Error(`cb ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const cb = (...args) => new Promise((resolve) => {
  const [exe, a] = cbArgs(args);
  const p = spawn(exe, a, { shell: process.platform === "win32" && !exe.endsWith(".exe") && exe !== process.execPath });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => ((out += d), (err += d)));
  p.on("error", (e) => resolve({ code: null, out, err: err + String(e?.message ?? e) }));
  p.on("close", (code) => resolve({ code, out, err }));
});
/** Why a cb call failed, briefly: its stderr and what its JSON said, else its output; one line, at most 300 chars. */
const reasonOf = (r, json) => {
  const { applied: _a, ...told } = json && typeof json === "object" ? json : {};
  const said = Object.keys(told).length ? JSON.stringify(told) : "";
  const t = ([String(r.err ?? "").trim(), said].filter(Boolean).join(" | ") || String(r.out || "no output")).replace(/\s+/g, " ").trim();
  return t.length > 300 ? t.slice(0, 299) + "…" : t;
};
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

const bundle = () => JSON.parse(cbSync("project", "list", "--json")).find((p) => p.name === PROJECT)?.bundlePath;

if (cmd === "setup") {
  const n = 6;
  cbSync("project", "create", PROJECT);
  const clip = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
  if (clip) cbSync("media", "add", PROJECT, clip);
  const titles = Array.from({ length: n }, (_, k) => `      <text name="W${k + 1}" start={${k}} end={${k + 1}} fontSize={100} textContent="W${k + 1}" />`).join("\n");
  const tsx = path.join(os.tmpdir(), `carton-gates-${process.pid}.tsx`);
  fs.writeFileSync(tsx, `export default (\n  <timeline aspect="16:9">\n${clip ? `    <track name="Mine">\n      <clip src="${path.basename(clip)}" start={0} end={3} />\n    </track>\n` : ""}    <track name="Agents">\n${titles}\n    </track>\n  </timeline>\n);\n`);
  cbSync("source", "apply", PROJECT, tsx);
  fs.rmSync(tsx, { force: true });
  console.log(`made "${PROJECT}" in ${bundle()}`);
} else if (cmd === "run") {
  const writers = Number(opt("writers", "4")), rate = Number(opt("rate", "1")), seconds = Number(opt("seconds", "60"));
  const dir = bundle();
  if (!dir) throw new Error(`no project "${PROJECT}" in ${root}: run setup first`);
  const end = Date.now() + seconds * 1000;
  const stats = Array.from({ length: writers }, () => ({ applied: 0, failed: 0, ms: [], last: null, samples: [] }));
  // each failure: which writer, its edit number, the step (print, the title not found, apply), exit code and why
  const failures = [];
  const fail = (k, i, step, r, json) => { stats[k].failed++; failures.push({ writer: `W${k + 1}`, edit: i, step, code: r.code, reason: reasonOf(r, json) }); };
  const one = async (k) => {
    const s = stats[k], name = `W${k + 1}`;
    for (let i = 1; Date.now() < end; i++) {
      const started = Date.now();
      // A fresh print each time: the header names the version this edit is made on.
      const printed = await cb("source", "print", PROJECT);
      const printMs = Date.now() - started;
      const size = 100 + k * 1000 + i;
      const re = new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`);
      if (printed.code !== 0) { fail(k, i, "print", printed); continue; }
      if (!re.test(printed.out)) { fail(k, i, "print", { ...printed, err: `no title ${name} with a font size in the print` }); continue; }
      const tsx = path.join(os.tmpdir(), `carton-w${k}-${process.pid}.tsx`);
      fs.writeFileSync(tsx, printed.out.replace(re, `$1${size}$2`));
      const a0 = Date.now();
      const r = await cb("source", "apply", PROJECT, tsx, "--json");
      const applyMs = Date.now() - a0;
      s.ms.push(Date.now() - started);
      let applied = false, json = null;
      try { json = JSON.parse(r.out.slice(r.out.indexOf("{"))); applied = json.applied === true; } catch {}
      if (applied) s.applied++, (s.last = size); else fail(k, i, "apply", r, json);
      const timeline = typeof json?.carton?.timeline === "string" ? json.carton.timeline : null;
      s.samples.push({ edit: i, start: started, ms: s.ms[s.ms.length - 1], print: printMs, apply: applyMs, timeline, outcome: applied ? "applied" : "failed" });
      const wait = started + 1000 / rate - Date.now();
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
  };
  (async () => {
    await Promise.all(stats.map((_, k) => one(k)));
    const now = fs.readFileSync(path.join(dir, "timeline.tsx"), "utf8");
    let lost = 0;
    const rows = stats.map((s, k) => {
      const m = now.match(new RegExp(`<text[^>]*name="W${k + 1}"[^>]*fontSize=\\{(\\d+)\\}`));
      const kept = s.last === null || (m && Number(m[1]) === s.last);
      if (!kept) lost++;
      return { writer: `W${k + 1}`, applied: s.applied, failed: s.failed, last: s.last, onDisk: m ? Number(m[1]) : null, kept, p50: pct(s.ms, 50), p90: pct(s.ms, 90), p99: pct(s.ms, 99) };
    });
    const samples = Object.fromEntries(stats.map((s, k) => [`W${k + 1}`, s.samples]));
    const result = { project: dir, writers, rate, seconds, lost, rows, failures, samples };
    console.table(rows);
    console.log(lost ? `LOST: ${lost} writer(s) lost their last applied edit` : "no lost updates");
    for (const f of failures) console.log(`failed: ${f.writer} edit ${f.edit} ${f.step}, exit ${f.code}: ${f.reason}`);
    if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify(result, null, 2));
    process.exitCode = lost ? 1 : 0;
  })();
} else {
  throw new Error("usage: node writers.js setup <cb> <root> [clip] | run <cb> <root> [--writers 4] [--rate 1] [--seconds 60] [--out file]");
}
