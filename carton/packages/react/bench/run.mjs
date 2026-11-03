// Run the @carton/react benchmarks in headless Chromium, on React and preact/compat, alternating runtimes, each cell
// inside the box's shared CPU lock (flock), with the load average recorded per cell (the box is shared: read the
// numbers with it). Results: one JSON line per cell in $CARTON_BENCH_OUT (default bench/dist/results.jsonl).
//   CARTON_PLAYWRIGHT=<dir> CARTON_CHROMIUM=<chrome> node bench/run.mjs [--runs 3] [--only list,live,play]
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOCK = process.env.GFV_LOCK || "/tmp/gfv-race/cpu.lock";
const out = process.env.CARTON_BENCH_OUT || join(here, "dist", "results.jsonl");
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

// ------------------------------------------------------------ one cell (inside the lock)
if (process.argv.includes("--cell")) {
  const cell = JSON.parse(arg("--cell"));
  const require = createRequire(import.meta.url);
  const { chromium } = require(join(process.env.CARTON_PLAYWRIGHT ?? "", process.env.CARTON_PLAYWRIGHT ? "playwright" : "playwright"));
  const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(join(here, "dist", cell.runtime === "react" ? "index.html" : "preact.html")).href);
    await page.waitForFunction(() => window.__benchReady);
    const load = loadavg()[0];
    const result = await page.evaluate(async (c) => {
      const b = window.__bench;
      if (c.kind === "list") return b.list(c.n, c.full);
      if (c.kind === "live") return b.live(c.seconds, c.vps, c.burst);
      if (c.kind === "idle") return b.idle(c.seconds);
      return b.play(c.changes, c.seconds);
    }, cell);
    console.log(JSON.stringify({ ...cell, load1: load, uptime: spawnSync("uptime").stdout.toString().trim(), result, errors }));
  } finally {
    await browser.close();
  }
  process.exit(0);
}

// ------------------------------------------------------------ the runner
const runs = Number(arg("--runs", "3"));
const only = (arg("--only", "idle,list,live,play") ?? "").split(",");
const cells = [];
if (only.includes("idle")) cells.push({ kind: "idle", seconds: 5 });
if (only.includes("list"))
  for (const [n, full] of [[10_000, false], [100_000, false], [10_000, true]]) cells.push({ kind: "list", n, full });
if (only.includes("live")) cells.push({ kind: "live", seconds: 8, vps: 10, burst: 5 });
if (only.includes("play")) for (const changes of [26, 2000]) cells.push({ kind: "play", changes, seconds: 8 });

mkdirSync(dirname(out), { recursive: true });
for (let r = 0; r < runs; r++)
  for (const c of cells)
    for (const runtime of r % 2 ? ["preact", "react"] : ["react", "preact"]) {
      const cell = { ...c, runtime, run: r };
      // The wait for the shared lock can be long (other agents' benchmarks): only the cell itself has a time limit.
      const p = spawnSync("flock", [LOCK, "timeout", "300", process.execPath, fileURLToPath(import.meta.url), "--cell", JSON.stringify(cell)], { env: process.env, encoding: "utf8" });
      const line = (p.stdout ?? "").trim().split("\n").pop();
      if (!line || p.status !== 0) {
        console.error(`cell failed: ${JSON.stringify(cell)}\n${p.stderr}`);
        continue;
      }
      appendFileSync(out, line + "\n");
      const j = JSON.parse(line);
      const s = j.result;
      const brief =
        c.kind === "idle"
          ? `empty page: frames p50 ${s.frames.stats.p50.toFixed(1)} p99 ${s.frames.stats.p99.toFixed(1)} ms, ${s.frames.stats.frames} frames in ${s.seconds} s`
          : c.kind === "list"
          ? `mount ${s.mountMs.toFixed(1)} ms, ${s.rowsInDom} rows in DOM, scroll p50 ${s.scroll.stats.p50.toFixed(1)} p99 ${s.scroll.stats.p99.toFixed(1)} ms`
          : c.kind === "live"
            ? `+${s.versionsAdded} versions, frames p99 ${s.frames.stats.p99.toFixed(1)} ms, renders ${JSON.stringify(s.renders)}`
            : `${s.frameCalls} frames drawn, p50 ${s.frames.stats.p50.toFixed(1)} p99 ${s.frames.stats.p99.toFixed(1)} ms, >20ms ${s.frames.stats.over20}, our work p99 ${s.frames.work.p99.toFixed(2)} ms`;
      console.log(`${runtime.padEnd(6)} ${c.kind} ${JSON.stringify(c).slice(0, 60)} load ${j.load1.toFixed(1)}  ${brief}`);
    }
console.log(`results: ${out}`);
void readFileSync;
