// Agents editing one project at once through `cb source apply`, as Claude Code or Codex does from a terminal: the
// writers in gates G1 and G2 (PLAN §16, §6.2), and a check for the lost update (B1).
//   node scripts/carton/writers.js setup <cb> <root> [clip.mp4]       makes the project "Carton gates" in <root>
//   node scripts/carton/writers.js run <cb> <root> [--writers 4] [--rate 1] [--seconds 60] [--out writers.json]
// <cb> is resources\cli\cardboard.mjs (run with this Node) or Cardboard.exe's cb shim. Writer k sets the font size of
// its own title, "W<k>", and nothing else, at --rate edits a second, each from a fresh print of the timeline (so each
// edit's base is the version it read). At the end it reads the timeline back: every writer's last applied size must
// be there. A size that isn't, though cb reported it applied, is a lost update. It prints each writer's applies,
// failures and apply time (p50, p90, p99), and the lost count.
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
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
});
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
  const stats = Array.from({ length: writers }, () => ({ applied: 0, failed: 0, ms: [], last: null }));
  const one = async (k) => {
    const s = stats[k], name = `W${k + 1}`;
    for (let i = 1; Date.now() < end; i++) {
      const started = Date.now();
      // A fresh print each time: the header names the version this edit is made on.
      const printed = await cb("source", "print", PROJECT);
      const size = 100 + k * 1000 + i;
      const re = new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`);
      if (printed.code !== 0 || !re.test(printed.out)) { s.failed++; continue; }
      const tsx = path.join(os.tmpdir(), `carton-w${k}-${process.pid}.tsx`);
      fs.writeFileSync(tsx, printed.out.replace(re, `$1${size}$2`));
      const r = await cb("source", "apply", PROJECT, tsx, "--json");
      s.ms.push(Date.now() - started);
      let applied = false;
      try { applied = JSON.parse(r.out.slice(r.out.indexOf("{"))).applied === true; } catch {}
      if (applied) s.applied++, (s.last = size); else s.failed++;
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
    const result = { project: dir, writers, rate, seconds, lost, rows };
    console.table(rows);
    console.log(lost ? `LOST: ${lost} writer(s) lost their last applied edit` : "no lost updates");
    if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify(result, null, 2));
    process.exitCode = lost ? 1 : 0;
  })();
} else {
  throw new Error("usage: node writers.js setup <cb> <root> [clip] | run <cb> <root> [--writers 4] [--rate 1] [--seconds 60] [--out file]");
}
