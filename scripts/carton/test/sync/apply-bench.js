// Apply latency (perf/apply-latency): agents' `cb source print` + `cb source apply` round trips on Cardboard 1.4.0's
// real (patched) cb, with the app open (its real library worker holds the project) and nobody editing, as
// scripts/carton/writers.js runs them on the laptop: writer k sets the font size of its own title "W<k>", each edit from
// a fresh print. Carton on and off. Not a test: a measurement. Numbers from here are UNVERIFIED until a separate check
// confirms them (AGENTS.md rule 6).
//
// Trees alternate cell by cell, each built from its own checkout (its own carton/node_modules), so each side bundles
// its own code. Every cell holds the shared CPU lock and starts only once the box is quiet (under --quiet cores of other
// CPU over 3 s, from /proc/stat); `uptime` is recorded before and after it. Each round trip is checked: the apply
// applied, the app's timeline.tsx shows the writer's size the moment cb returns (read-your-writes), and at the end of a
// cell every writer's last applied size is in timeline.tsx and in a fresh print (no writer's edit lost: G1).
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node scripts/carton/test/sync/apply-bench.js --out <dir> \
//     --build before=<tree> --build after=<tree> [--rounds 6] [--trips 10] [--writers 1,4] [--modes on,off] \
//     [--lock /tmp/gfv-race/cpu.lock] [--quiet 0.5] [--cb-env KEY=VALUE ({build} and {mode} are replaced)]
// Writes <dir>/rows.jsonl (every round trip), <dir>/cells.jsonl (every cell: uptime, gate, checks) and prints medians.
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn, spawnSync } = require("child_process");

const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const r1 = (x) => Math.round(x * 10) / 10;
const uptime = () => spawnSync("uptime", { encoding: "utf8" }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROJECT = "Carton gates";

// ---------------------------------------------------------------- a tree's build (its stage and bundle), once
async function prepare() {
  const tree = args[1];
  const S = require(path.join(tree, "scripts", "carton", "test", "sync", "support.js"));
  if (S.skip || S.noBuild) throw new Error(S.skip || S.noBuild);
  await S.build();
}
// The build prepare() made in CARTON_TEST_DIR, as support.js's build() returns it.
const builtIn = (dir) => ({ cli: path.join(dir, "stage", "res", "cli"), worker: path.join(dir, "stage", "work", "asar-src", "dist", "library-worker.js"), carton: path.join(dir, "bundle", "carton"), clip: path.join(dir, "clip.mp4") });

// ---------------------------------------------------------------- /proc/stat: other CPU, in cores, over ms
function busyCores(ms) {
  const read = () => {
    const l = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = l[3] + (l[4] ?? 0), total = l.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const a = read();
  spawnSync("sleep", [String(ms / 1000)]);
  const b = read(), n = os.cpus().length;
  return ((b.total - b.idle - (a.total - a.idle)) / (b.total - a.total)) * n;
}

// ---------------------------------------------------------------- one cell (runs inside the CPU lock)
async function cell({ tree, build, mode, writers, trips, round, quiet, tmpdir, cbEnv = {} }) {
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
  // the gate: the box quiet before anything starts (attempts of 3 s each, inside the lock)
  let busy = null, attempts = 0;
  for (; attempts < 20; attempts++) { busy = busyCores(3000); if (busy < quiet) break; }
  if (!(busy < quiet)) { out({ busy: true, cores: r1(busy) }); process.exit(75); }
  const up0 = uptime();
  const S = require(path.join(tree, "scripts", "carton", "test", "sync", "support.js"));
  const b = builtIn(S.TMP);
  const pc = await S.computer(`c${round}-${mode}-w${writers}-${process.pid}`, b);
  if (mode === "off") pc.env.CARDBOARD_CARTON = "";
  // cb's temp folder (Node's compile cache defaults to <os temp>/node-compile-cache): one per build, kept across cells,
  // as %TEMP% is on the laptop. Never the shared /tmp.
  pc.env.TMPDIR = tmpdir;
  const cli = path.join(b.cli, "cardboard.mjs");
  // every cb this cell starts, so a failure stops them all before the cell's files go (review #3); a call past
  // CALL_MS is killed and fails, and a whole cell past CELL_MS stops everything and fails
  const CALL_MS = 120_000, CELL_MS = 20 * 60_000;
  const children = new Set();
  const killAll = () => { for (const c of children) try { c.kill("SIGKILL"); } catch {} };
  const allGone = () => Promise.all([...children].map((c) => new Promise((ok) => (c.exitCode !== null || c.signalCode !== null ? ok() : c.once("close", ok)))));
  const cellTimer = setTimeout(() => { killAll(); pc.kill(); S.killHelpers(); out({ fatal: "the cell ran past " + CELL_MS + " ms" }); process.exit(1); }, CELL_MS);
  cellTimer.unref();
  const run = (argv, env = {}) => new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, [cli, "--root", pc.root, ...argv], { env: { ...pc.env, ...env } });
    children.add(p);
    let so = "", se = "", done = false;
    const end = (code) => { if (done) return; done = true; clearTimeout(t); children.delete(p); resolve({ code, out: so, err: se, ms: performance.now() - t0 }); };
    const t = setTimeout(() => { se += "\n(killed after " + CALL_MS + " ms)"; try { p.kill("SIGKILL"); } catch {} }, CALL_MS);
    p.stdout.on("data", (d) => (so += d));
    p.stderr.on("data", (d) => (se += d));
    p.on("error", (e) => { se += String(e?.message ?? e); end(null); });
    p.on("close", (code) => end(code));
  });
  const must = async (argv, what) => { const r = await run(argv); if (r.code !== 0) throw new Error(what + ": " + r.out + r.err); return r; };
  const rows = [];
  let checks = null;
  try {
    // the project writers.js setup makes: a clip and six titles W1..W6, each writer's own
    await must(["project", "create", PROJECT], "create");
    await must(["media", "add", PROJECT, b.clip], "media add");
    const titles = Array.from({ length: 6 }, (_, k) => `      <text name="W${k + 1}" start={${k}} end={${k + 1}} fontSize={100} textContent="W${k + 1}" />`).join("\n");
    const setup = path.join(pc.home, "setup.tsx");
    fs.writeFileSync(setup, `export default (\n  <timeline aspect="16:9">\n    <track name="Mine">\n      <clip src="${path.basename(b.clip)}" start={0} end={3} />\n    </track>\n    <track name="Agents">\n${titles}\n    </track>\n  </timeline>\n);\n`);
    await must(["source", "apply", PROJECT, setup], "setup apply");
    const bundle = path.join(pc.root, PROJECT + ".cardboard"), tsx = path.join(bundle, "timeline.tsx");
    await pc.startWorker();
    const [{ id }] = await pc.call("projects.list");
    await S.projectOf(pc, id);
    if (mode === "on") await S.until(() => { try { return /cardboard:rev .+@\d+~[0-9a-f]{8} b:/.test(fs.readFileSync(tsx, "utf8")); } catch { return false; } }, 30_000, "the worker's Materializer printing timeline.tsx");
    else await sleep(500);
    const last = Array(writers).fill(null);
    let stop = false; // one writer failed: the others stop at their next step
    const one = async (k) => {
      const name = `W${k + 1}`, re = new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`);
      const edit = path.join(pc.home, `w${k}.tsx`);
      // one warm-up round trip each (not measured), then `trips` measured
      for (let i = 0; i <= trips && !stop; i++) {
        const size = 100 + k * 1000 + round * 100 + i + 1;
        const t0 = performance.now();
        // (--cb-env: more environment for the measured cb calls only, e.g. a NODE_OPTIONS preload that records spans)
        const env = { ...Object.fromEntries(Object.entries(cbEnv).map(([key, v]) => [key, String(v).replaceAll("{build}", build).replaceAll("{mode}", mode)])), CARDBOARD_ACTOR: `claude-code/sess${k}` };
        const pr = await run(["source", "print", PROJECT], env);
        if (pr.code !== 0 || !re.test(pr.out)) throw new Error("print: " + pr.out.slice(0, 400) + pr.err);
        fs.writeFileSync(edit, pr.out.replace(re, `$1${size}$2`));
        const ap = await run(["--json", "source", "apply", PROJECT, edit], env);
        const roundMs = performance.now() - t0;
        // read-your-writes: the app's timeline.tsx, read the moment cb returns
        let shown = false;
        try { shown = new RegExp(`<text[^>]*name="${name}"[^>]*fontSize=\\{${size}\\}`).test(fs.readFileSync(tsx, "utf8")); } catch {}
        let res = null;
        try { res = JSON.parse(ap.out.slice(ap.out.indexOf("{"))); } catch {}
        const applied = ap.code === 0 && res?.applied === true;
        if (applied) last[k] = size;
        if (i === 0) continue;
        rows.push({ build, mode, writers, round, writer: k, i, printMs: r1(pr.ms), applyMs: r1(ap.ms), roundMs: r1(roundMs), applied, shown, timeline: res?.carton?.timeline ?? null, load1: os.loadavg()[0] });
      }
    };
    const t0 = performance.now();
    const settled = await Promise.allSettled(Array.from({ length: writers }, (_, k) => one(k).catch((e) => { stop = true; throw e; })));
    const wallMs = performance.now() - t0;
    const failed = settled.find((x) => x.status === "rejected");
    if (failed) throw failed.reason;
    // no writer's edit lost (G1): every writer's last applied size in timeline.tsx and in a fresh print
    const now = fs.readFileSync(tsx, "utf8"), printed = (await must(["source", "print", PROJECT], "final print")).out;
    const has = (text, k) => new RegExp(`<text[^>]*name="W${k + 1}"[^>]*fontSize=\\{${last[k]}\\}`).test(text);
    checks = { lostInFile: last.filter((v, k) => v === null || !has(now, k)).length, lostInPrint: last.filter((v, k) => v === null || !has(printed, k)).length, wallMs: r1(wallMs) };
  } finally {
    // nothing of this cell outlives it: its cb calls, then the worker and helpers, then its files
    killAll();
    await allGone();
    await pc.stopWorker();
    S.killHelpers();
    try { fs.rmSync(pc.home, { recursive: true, force: true }); } catch {}
  }
  clearTimeout(cellTimer);
  for (const r of rows) out({ row: r });
  out({ cell: { tree, build, mode, writers, round, trips, gate: { cores: r1(busy), attempts: attempts + 1 }, uptimeBefore: up0, uptimeAfter: uptime(), ...checks } });
}

// ---------------------------------------------------------------- the driver
async function drive() {
  const OUT = path.resolve(arg("out", path.join(os.homedir(), "gfv-scratch", "carton", "apply-bench")));
  const builds = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--build") { const [name, tree] = args[i + 1].split("="); builds.push({ name, tree: path.resolve(tree) }); }
  if (!builds.length) throw new Error("--build name=<tree> (one or more)");
  const ROUNDS = Number(arg("rounds", 6)), TRIPS = Number(arg("trips", 10)), LOCK = arg("lock", "/tmp/gfv-race/cpu.lock"), QUIET = Number(arg("quiet", 0.5));
  const WRITERS = String(arg("writers", "1")).split(",").map(Number), MODES = String(arg("modes", "on,off")).split(",");
  const cbEnv = {};
  for (let i = 0; i < args.length; i++) if (args[i] === "--cb-env") { const at = args[i + 1].indexOf("="); cbEnv[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1); }
  fs.mkdirSync(OUT, { recursive: true });
  const me = __filename;
  for (const bld of builds) {
    bld.dir = path.join(OUT, bld.name, "build");
    bld.tmp = path.join("/dev/shm", `apply-bench-${path.basename(OUT)}-${bld.name}-tmp`);
    fs.mkdirSync(bld.tmp, { recursive: true });
    // A tree is a checkout (its HEAD; uncommitted changes are refused) or an export with its commit in .commit
    // (`git archive <c>` with `git rev-parse --short <c> > .commit`).
    const git = spawnSync("git", ["-C", bld.tree, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const head = git.status === 0 ? git.stdout.trim() : fs.readFileSync(path.join(bld.tree, ".commit"), "utf8").trim();
    if (git.status === 0 && spawnSync("git", ["-C", bld.tree, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim()) throw new Error(bld.name + ": " + bld.tree + " has uncommitted changes; measure a commit");
    bld.head = head;
    // A build is reused only if it was made from this commit and is whole; else made again.
    const stamp = path.join(bld.dir, "built-from.json"), facade = path.join(bld.dir, "bundle", "carton", "carton-node.cjs");
    let made = null;
    try { made = JSON.parse(fs.readFileSync(stamp, "utf8")); } catch {}
    if (!(made?.head === head && made?.tree === bld.tree && fs.existsSync(facade) && fs.existsSync(path.join(bld.dir, "clip.mp4")))) {
      fs.rmSync(bld.dir, { recursive: true, force: true });
      const r = spawnSync(process.execPath, [me, "--prepare", bld.tree], { env: { ...process.env, CARTON_TEST_DIR: bld.dir }, stdio: ["ignore", "ignore", "inherit"] });
      if (r.status !== 0) throw new Error(bld.name + " didn't build");
      fs.writeFileSync(stamp, JSON.stringify({ tree: bld.tree, head, at: new Date().toISOString() }));
    }
    // what actually runs: the facade and cb's two patched bundles, by hash
    const sha = (f) => require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
    const b = builtIn(bld.dir);
    bld.artifacts = { facade: sha(facade), cb: sha(path.join(b.cli, "cardboard.mjs")), cbChunk: sha(path.join(b.cli, "chunks", "chunk-LL26E55H.mjs")), worker: sha(b.worker) };
    console.log(JSON.stringify({ build: bld.name, tree: bld.tree, head, artifacts: bld.artifacts }));
  }
  const rowsFile = path.join(OUT, "rows.jsonl"), cellsFile = path.join(OUT, "cells.jsonl");
  const RUN = new Date().toISOString(); // this invocation's rows, told apart from an earlier run's in the same files
  const rows = [], cells = [];
  for (let r = 0; r < ROUNDS; r++) for (const w of WRITERS) for (const mode of MODES) {
    // alternate which build goes first, so a warming (or busier) box favours neither
    const order = (r + MODES.indexOf(mode)) % 2 ? [...builds].reverse() : builds;
    for (const bld of order) {
      const spec = { tree: bld.tree, build: bld.name, mode, writers: w, trips: TRIPS, round: r, quiet: QUIET, tmpdir: bld.tmp, cbEnv };
      for (let attempt = 0; ; attempt++) {
        const p = spawnSync("flock", [LOCK, process.execPath, me, "--cell", JSON.stringify(spec)], { env: { ...process.env, CARTON_TEST_DIR: bld.dir }, encoding: "utf8", maxBuffer: 64 << 20, timeout: 7_200_000 });
        const lines = p.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (p.status === 75) { console.log(JSON.stringify({ busy: lines[0]?.cores, cell: spec.build + "/" + mode + "/w" + w + "/r" + r, retryIn: 60 })); await sleep(60_000); continue; }
        const fatal = lines.find((x) => x.fatal);
        if (p.status !== 0 || fatal) { console.error(bld.name, mode, "w" + w, "round", r, "failed:", fatal?.fatal ?? p.stderr.slice(-3000)); if (attempt < 1) continue; throw new Error("cell failed twice"); }
        for (const x of lines) {
          if (x.row) { rows.push(x.row); fs.appendFileSync(rowsFile, JSON.stringify({ run: RUN, head: bld.head, facade: bld.artifacts.facade, ...x.row }) + "\n"); }
          if (x.cell) {
            cells.push({ build: bld.name, ...x.cell });
            fs.appendFileSync(cellsFile, JSON.stringify({ run: RUN, head: bld.head, artifacts: bld.artifacts, ...x.cell }) + "\n");
            const mine = rows.filter((y) => y.build === bld.name && y.mode === mode && y.writers === w && y.round === r);
            console.log(JSON.stringify({ build: bld.name, mode, writers: w, round: r, roundMedianMs: r1(median(mine.map((y) => y.roundMs))), applyMedianMs: r1(median(mine.map((y) => y.applyMs))), printMedianMs: r1(median(mine.map((y) => y.printMs))), notShown: mine.filter((y) => !y.shown).length, notApplied: mine.filter((y) => !y.applied).length, lostInFile: x.cell.lostInFile, lostInPrint: x.cell.lostInPrint, gate: x.cell.gate, uptime: x.cell.uptimeBefore }));
          }
        }
        break;
      }
    }
  }
  const summary = {};
  for (const w of WRITERS) for (const mode of MODES) for (const bld of builds) {
    const all = rows.filter((y) => y.build === bld.name && y.mode === mode && y.writers === w), mine = all.filter((y) => y.applied);
    const rounds = [...new Set(mine.map((y) => y.round))];
    const myCells = cells.filter((c) => c.build === bld.name && c.mode === mode && c.writers === w);
    summary[`${bld.name}/${mode}/w${w}`] = {
      head: bld.head, artifacts: bld.artifacts, trips: all.length, applied: mine.length,
      roundMedianMs: r1(median(mine.map((y) => y.roundMs))), applyMedianMs: r1(median(mine.map((y) => y.applyMs))), printMedianMs: r1(median(mine.map((y) => y.printMs))),
      cellRoundMediansMs: rounds.map((rr) => r1(median(mine.filter((y) => y.round === rr).map((y) => y.roundMs)))),
      notShown: all.filter((y) => !y.shown).length, notApplied: all.length - mine.length,
      lostInFile: myCells.reduce((a, c) => a + (c.lostInFile ?? 0), 0), lostInPrint: myCells.reduce((a, c) => a + (c.lostInPrint ?? 0), 0),
    };
  }
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  const bad = Object.values(summary).some((x) => x.notShown || x.notApplied || x.lostInFile || x.lostInPrint);
  console.log(JSON.stringify({ summary, checks: bad ? "FAILED: see notShown / notApplied / lost" : "all applied, all shown, none lost", unverified: true }, null, 1));
  if (bad) process.exitCode = 2;
}

if (args[0] === "--prepare") prepare().catch((e) => { console.error(e); process.exit(1); });
else if (args[0] === "--cell") cell(JSON.parse(args[1])).catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
else drive().catch((e) => { console.error(e); process.exitCode = 1; });
