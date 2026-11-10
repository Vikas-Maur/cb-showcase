// Read-your-writes cost and effect (apply-ryw): an agent's `cb source apply` on Cardboard 1.4.0's real (patched) cb,
// timed from the agent's side (the cb process, start to exit, as an agent's Bash tool waits for it), and timeline.tsx
// read the moment cb returns: does it show the write, and if not, how long after cb returned it does (polled every
// 2 ms, up to 3 s). With the app open (Cardboard's real library worker holding the project) and closed. Not a test: a
// measurement. Two builds alternate round by round, each built from its own tree (its own carton/node_modules), so the
// "before" and "after" bundles are each their own code. Prints every apply as a JSON line, then medians per build and
// mode. Numbers from here are UNVERIFIED until a separate check confirms them (AGENTS.md rule 6). Run it alone
// (slot.sh), on a quiet machine:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> CARTON_TEST_DIR=<scratch> node scripts/carton/test/sync/ryw-bench.js \
//     --build before=<tree> --build after=<tree> [--rounds 6] [--applies 10] [--modes open,closed]
// A tree is a checkout's root (its scripts/carton/test/sync/ryw-bench.js runs the rounds, with `--serve`).
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn, spawnSync } = require("child_process");
const { createInterface } = require("readline");

const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const load1 = () => Number(os.loadavg()[0].toFixed(2));

if (args.includes("--serve")) serve();
else drive().catch((e) => { console.error(e); process.exitCode = 1; });

// ---------------------------------------------------------------- one build's rounds (a child of the driver)
function serve() {
  const S = require("./support.js");
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
  const APPLIES = Number(arg("applies", 10));
  let b = null, n = 0;
  (async () => {
    if (S.skip || S.noBuild) throw new Error("needs CARDBOARD_PRISTINE and carton/'s pnpm install: " + (S.skip || S.noBuild));
    b = await S.build();
    out({ ready: true });
    for await (const line of createInterface({ input: process.stdin })) {
      const { round, mode } = JSON.parse(line);
      out({ done: true, rows: await oneRound(round, mode) });
    }
  })().catch((e) => { out({ fatal: String(e?.stack ?? e) }); process.exit(1); });

  async function oneRound(round, mode) {
    const pc = await S.computer(`ryw-bench-${process.pid}-${++n}`, b);
    const rows = [];
    try {
      S.seed(pc, b);
      const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
      if (mode === "open") {
        await pc.startWorker();
        const [{ id }] = await pc.call("projects.list");
        await S.projectOf(pc, id); // the worker opens the project's history (its Materializer starts)
        await S.until(() => { try { return /cardboard:rev .+@\d+~[0-9a-f]{8} b:/.test(fs.readFileSync(tsx, "utf8")); } catch { return false; } }, 30_000, "the worker's Materializer printing timeline.tsx");
      }
      let size = 300;
      for (let i = 0; i < APPLIES + 2; i++) {
        const n2 = ++size;
        const edit = path.join(pc.home, "bench-edit.tsx");
        fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, `fontSize={${n2}}`));
        const env = { ...pc.env, CARDBOARD_ACTOR: "claude-code/sessBench" };
        const t0 = performance.now();
        const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, "--json", "source", "apply", "Demo", edit], { env, encoding: "utf8", timeout: 120_000 });
        const applyMs = performance.now() - t0;
        const read = fs.readFileSync(tsx, "utf8");
        if (r.status !== 0) throw new Error("apply: " + r.stdout + r.stderr);
        const shown = read.includes(`fontSize={${n2}}`);
        let lagMs = 0;
        if (!shown) {
          lagMs = null;
          const t1 = performance.now();
          for (const end = t1 + 3000; performance.now() < end; ) {
            try { if (fs.readFileSync(tsx, "utf8").includes(`fontSize={${n2}}`)) { lagMs = performance.now() - t1; break; } } catch {}
            await S.sleep(2);
          }
        }
        let timeline = null;
        try { timeline = JSON.parse(r.stdout.replace(/^\[carton\][^\n]*\n/gm, "")).carton?.timeline ?? null; } catch {}
        if (i < 2) continue; // warm-up: the first applies open Carton and load the code
        rows.push({ round, mode, i: i - 2, applyMs: +applyMs.toFixed(1), shown, lagMs: lagMs === null ? null : +lagMs.toFixed(1), timeline, load1: load1() });
      }
    } finally {
      await pc.stopWorker();
      S.killHelpers();
    }
    return rows;
  }
}

// ---------------------------------------------------------------- the driver: alternate the builds
async function drive() {
  const builds = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--build") { const [name, tree] = args[i + 1].split("="); builds.push({ name, tree: path.resolve(tree) }); }
  if (builds.length < 1) throw new Error("--build name=<tree> (one or more)");
  const ROUNDS = Number(arg("rounds", 6)), MODES = String(arg("modes", "open,closed")).split(",");
  const base = process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "ryw-bench");
  // one child per build, each building from its own tree into its own scratch folder
  for (const bld of builds) {
    const file = path.join(bld.tree, "scripts", "carton", "test", "sync", "ryw-bench.js");
    if (!fs.existsSync(file)) fs.copyFileSync(__filename, file); // a tree from before the bench existed
    const p = spawn(process.execPath, [file, "--serve", "--applies", String(arg("applies", 10))], { env: { ...process.env, CARTON_TEST_DIR: path.join(base, bld.name) }, stdio: ["pipe", "pipe", "inherit"] });
    const lines = [], waiters = [];
    createInterface({ input: p.stdout }).on("line", (l) => { let x; try { x = JSON.parse(l); } catch { return; } if (x.fatal) console.error(bld.name, x.fatal); const w = waiters.shift(); if (w) w(x); else lines.push(x); });
    bld.next = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));
    bld.p = p;
    const ready = await bld.next();
    if (!ready.ready) throw new Error(bld.name + " didn't start: " + JSON.stringify(ready));
    const head = spawnSync("git", ["-C", bld.tree, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
    console.log(JSON.stringify({ build: bld.name, tree: bld.tree, head, dirty: spawnSync("git", ["-C", bld.tree, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length }));
  }
  const all = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const mode of MODES) {
      // alternate which build goes first, so a warming (or busier) machine favours neither
      const order = r % 2 ? [...builds].reverse() : builds;
      for (const bld of order) {
        bld.p.stdin.write(JSON.stringify({ round: r, mode }) + "\n");
        const res = await bld.next();
        if (!res.done) throw new Error(bld.name + ": " + JSON.stringify(res));
        for (const row of res.rows) { const x = { build: bld.name, ...row }; all.push(x); console.log(JSON.stringify(x)); }
      }
    }
  }
  for (const bld of builds) bld.p.stdin.end();
  const summary = {};
  for (const bld of builds) for (const mode of MODES) {
    const rows = all.filter((x) => x.build === bld.name && x.mode === mode);
    const lags = rows.filter((x) => !x.shown).map((x) => x.lagMs);
    summary[`${bld.name}/${mode}`] = {
      applies: rows.length,
      applyMedianMs: +median(rows.map((x) => x.applyMs)).toFixed(1),
      roundMediansMs: [...new Set(rows.map((x) => x.round))].map((rr) => +median(rows.filter((x) => x.round === rr).map((x) => x.applyMs)).toFixed(1)),
      missedImmediateRead: rows.filter((x) => !x.shown).length,
      missLagMedianMs: lags.length ? +median(lags.filter((x) => x !== null)).toFixed(1) : null,
      missNeverIn3s: lags.filter((x) => x === null).length,
      timeline: Object.fromEntries([...new Set(rows.map((x) => String(x.timeline)))].map((k) => [k, rows.filter((x) => String(x.timeline) === k).length])),
      load1Median: +median(rows.map((x) => x.load1)).toFixed(2),
    };
  }
  console.log(JSON.stringify({ summary, unverified: true }));
}
