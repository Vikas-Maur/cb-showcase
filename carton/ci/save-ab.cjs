// verify-ci's copy of windows-sync's rule-6 verifier's tool (gfv-scratch/carton/windows-sync/verify-perf/tools/verify-ab.js,
// unchanged below this header), used by the save-growth measurement (measure.json) to re-measure per-save cost over
// hundreds of saves on the final merge against 06684af. Read by Node as CommonJS (.cjs).
// verify-perf (independent check of helper-perf's A/B): the same GUI save workload as save-bench.js / helper-perf's
// ab.js (real library worker, real bundles, a timeline of 1 clip + N titles, one fontSize edit per save), but
//   - cells are interleaved SAVE BY SAVE: every cell has its own library and its own live worker for the round, and
//     the saves go round-robin over the cells (order reversed every pass), so load drift on the shared box hits every
//     build alike;
//   - --gap: a pause after timeline.tsx shows the save (the editor's 300 ms debounce), so the Materializer's rewrite and
//     any bookkeeping after it finishes before the next save (no overlap into the next save's timing);
//   - cpu: the worker process's CPU time (all its threads, /proc/<pid>/task/*/schedstat, ns) from just before the
//     save to just before the next save's read: the save, the rewrite of timeline.tsx and whatever else the save
//     caused, wherever it ran. Independent of when the 20 ms rewrite timer fires.
// Usage: CARDBOARD_PRISTINE=… CARTON_TEST_DIR=… node verify-ab.js --trees a=<repo>,b=<repo> --cells a:off,a:on,b:on
//          --out <dir> [--items 3,200] [--saves 20] [--rounds 4] [--gap 300]
const fs = require("fs"), path = require("path"), os = require("os");
const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const TREES = Object.fromEntries(String(arg("trees", "")).split(",").map((x) => x.split("=")));
const CELLS = String(arg("cells", "")).split(",").map((c) => { const [tree, mode] = c.split(":"); return { tree, mode, name: c }; });
// the harness (computer(), call(), projectOf) from the last tree given; it is the same for timing in every tree
const S = require(path.join(Object.values(TREES).at(-1), "scripts/carton/test/sync/support.js"));
const OUT = path.resolve(arg("out", "out"));
const SIZES = String(arg("items", "3,200")).split(",").map(Number);
const SAVES = Number(arg("saves", 20)), ROUNDS = Number(arg("rounds", 4)), GAP = Number(arg("gap", 300)), WARM = Number(arg("warm", 3));
const nowE = () => performance.timeOrigin + performance.now();
const r2 = (x) => Math.round(x * 100) / 100;
const load1 = () => r2(os.loadavg()[0]);

/** CPU time of a process, all threads, in ms (schedstat: ns on CPU). */
function cpuMs(pid) {
  let ns = 0;
  for (const t of fs.readdirSync(`/proc/${pid}/task`)) {
    try { ns += Number(fs.readFileSync(`/proc/${pid}/task/${t}/schedstat`, "utf8").split(" ")[0]); } catch {}
  }
  return ns / 1e6;
}
/** utime+stime of the process in ms (ticks; includes threads that exited). */
function ticksMs(pid) {
  const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
  return (Number(rest[11]) + Number(rest[12])) * (1000 / 100);
}

function timeline(n) {
  const titles = Array.from({ length: n }, (_, i) => `      <text name="T${i}" start={${(i * 0.5).toFixed(1)}} end={${(i * 0.5 + 0.4).toFixed(1)}} fontSize={100} textContent="Title ${i}" />`).join("\n");
  return `export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n${titles}\n    </track>\n  </timeline>\n);\n`;
}

async function build(name, wt) {
  const TMP = path.join(process.env.CARTON_TEST_DIR, "build-" + name);
  fs.mkdirSync(TMP, { recursive: true });
  const { stage } = require(path.join(wt, "scripts/carton/test/stage.js"));
  const s = stage(process.env.CARDBOARD_PRISTINE, path.join(TMP, "stage"), { carton: true });
  const bundle = path.join(TMP, "bundle");
  fs.rmSync(bundle, { recursive: true, force: true });
  await require(path.join(wt, "scripts/carton/build.js")).build(bundle, s.assets, {});
  const clip = path.join(process.env.CARTON_TEST_DIR, "clip.mp4");
  if (!fs.existsSync(clip)) require("child_process").execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  return { ...s, carton: path.join(bundle, "carton"), clip };
}

async function open(b, cell, items, r) {
  const pc = await S.computer(`v-${cell.tree}-${cell.mode}-${items}-${r}`, b);
  pc.env.CARDBOARD_CARTON = cell.mode === "on" ? "1" : "0";
  const must = (x, what) => { if (x.code !== 0) throw new Error(cell.name + " " + what + ": " + x.out + x.err); };
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(items));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  await pc.startWorker();
  const id = (await pc.call("projects.list"))[0].id;
  return { pc, cell, id, tsx: path.join(pc.root, "Demo.cardboard", "timeline.tsx"), pid: pc.worker().p.pid, n: 0 };
}

/** One GUI save on a cell; returns its row. */
async function saveOn(c, items, r, pass) {
  const i = c.n++;
  const doc = await S.projectOf(c.pc, c.id);
  const size = 101 + (i % 50);
  const items2 = doc.timelineItems.map((it) => (it.type === "text" && it.name === "T0" ? { ...it, fontSize: size } : it));
  const body = { ...doc, timelineItems: items2, stateUpdatedAt: Date.now() };
  const c0 = cpuMs(c.pid), k0 = ticksMs(c.pid);
  const t0 = nowE();
  await c.pc.call("projects.updateScoped", body, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  const save = nowE() - t0;
  let fileMs = null;
  for (const end = t0 + 5000; nowE() < end; ) {
    try { if (fs.readFileSync(c.tsx, "utf8").includes(`fontSize={${size}}`)) { fileMs = nowE() - t0; break; } } catch {}
    await S.sleep(2);
  }
  if (GAP) await S.sleep(GAP);
  const cpu = cpuMs(c.pid) - c0, ticks = ticksMs(c.pid) - k0;
  return { cell: c.cell.name, items, round: r, pass, i, save: r2(save), file: fileMs === null ? null : r2(fileMs), cpu: r2(cpu), ticks, load1: load1(), at: Math.round(t0) };
}

(async () => {
  if (S.skip || S.noBuild) throw new Error("needs CARDBOARD_PRISTINE and carton/'s npm ci: " + (S.skip || S.noBuild));
  fs.mkdirSync(OUT, { recursive: true });
  const builds = {};
  for (const [name, wt] of Object.entries(TREES)) builds[name] = await build(name, wt);
  const rowsFile = path.join(OUT, "rows.jsonl");
  fs.writeFileSync(rowsFile, "");
  const rounds = [];
  for (const items of SIZES) {
    for (let r = 0; r < ROUNDS; r++) {
      const cells = [];
      try {
        for (const cell of CELLS) cells.push(await open(builds[cell.tree], cell, items, r));
        const info = { items, round: r, loadStart: os.loadavg().map(r2), at: new Date().toISOString() };
        for (let p = 0; p < WARM + SAVES; p++) {
          const order = (p + r) % 2 ? [...cells].reverse() : cells;
          for (const c of order) {
            const row = await saveOn(c, items, r, p);
            if (p < WARM) continue;
            fs.appendFileSync(rowsFile, JSON.stringify(row) + "\n");
          }
        }
        info.loadEnd = os.loadavg().map(r2);
        rounds.push(info);
        console.log(JSON.stringify(info));
      } finally {
        for (const c of cells) await c.pc.stopWorker().catch(() => {});
        S.killHelpers();
      }
    }
  }
  fs.writeFileSync(path.join(OUT, "rounds.json"), JSON.stringify(rounds, null, 1));
  console.log("done", OUT);
})().catch((e) => { console.error(e); process.exitCode = 1; });
