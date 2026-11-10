// Ctrl+Z's cost in the library worker with Carton on and off, on Cardboard's real library worker and real bundles
// (support.js builds them), on a large project: `--items` titles applied with Cardboard's own cb, then `--versions` GUI
// saves. Not a test: a measurement. Each measured cycle is a GUI save (the person's edit) and then its undo:
//   - on: the editor's Ctrl+Z as the renderer bridge sends it (carton.undo with the session's start), until the worker
//     answers (the undo committed, project.json written, the pages told: `undo`), and then the page's read of the
//     project it adopts (projects.read: `undoRead`); `pageHas`, when the page has the undone timeline: the answer when
//     it carries the project (the page adopts it), else after that read;
//   - off: Cardboard's own undo swaps snapshots in the page; its only worker cost is the save of the restored timeline
//     (projects.updateScoped: `undo`), and the page already holds the document (`undoRead` = `undo`).
// Prints every cycle as a JSON line, then the medians. Numbers from here are UNVERIFIED until a separate check confirms
// them (AGENTS.md rule 6). Run it alone (slot.sh, the CPU lock), on a quiet machine:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> CARTON_TEST_DIR=<scratch> \
//     node scripts/carton/test/sync/undo-bench.js [--rounds 3] [--undos 15] [--items 1500] [--versions 150] [--modes on,off]
// Two builds alternated round by round (each round a fresh library; the order flips every round):
//   node undo-bench.js --ab before=<checkout> after=<checkout> [--rounds 5] [...]
// runs <checkout>/scripts/carton/test/sync/undo-bench.js for each, with CARTON_TEST_DIR=<scratch>/<name>.
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");

const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const args = (name) => process.argv.flatMap((a, i) => (process.argv[i - 1] === "--" + name ? [a] : []));
const ROUNDS = Number(arg("rounds", 3)), UNDOS = Number(arg("undos", 15)), ITEMS = Number(arg("items", 1500)), VERSIONS = Number(arg("versions", 150));
const MODES = String(arg("modes", "on,off")).split(",");
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** A timeline with a clip and `n` titles (half a second apart), applied with Cardboard's own cb. */
function timeline(n) {
  const titles = Array.from({ length: n }, (_, i) => `      <text name="T${i}" start={${(i * 0.5).toFixed(1)}} end={${(i * 0.5 + 0.4).toFixed(1)}} fontSize={100} textContent="Title ${i}" />`).join("\n");
  return `export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n${titles}\n    </track>\n  </timeline>\n);\n`;
}

async function round(S, b, mode, r, build) {
  const pc = await S.computer(`undo-${build}-${mode}-${r}`, b);
  pc.env.CARDBOARD_CARTON = mode === "on" ? "1" : "0";
  const must = (x, what) => { if (x.code !== 0) throw new Error(what + ": " + x.out + x.err); };
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(ITEMS));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  const out = [];
  const title = (doc, name) => doc.timelineItems.find((i) => i.type === "text" && i.name === name);
  try {
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    // the editor's session starts once the project is open, before the person's edits (the renderer bridge's)
    const since = Date.now();
    // history: a GUI save per version, each a title's size
    for (let v = 0; v < VERSIONS; v++) await S.guiSave(pc, id, (it) => (it.type === "text" && it.name === `T${1 + (v % (ITEMS - 1))}` ? { ...it, fontSize: 101 + (v % 50) } : undefined));
    for (let k = 0; k < UNDOS + 2; k++) {
      const size = 200 + k;
      const before = title(await S.projectOf(pc, id), "T0").fontSize;
      await S.guiSave(pc, id, (it) => (it.type === "text" && it.name === "T0" ? { ...it, fontSize: size } : undefined));
      let undo, undoRead, doc, pageHas;
      const t0 = performance.now();
      if (mode === "on") {
        const res = await pc.call("carton.undo", { projectId: id, since });
        undo = performance.now() - t0;
        doc = await S.projectOf(pc, id);
        undoRead = performance.now() - t0;
        pageHas = res?.project ? undo : undoRead;
        if (res?.status !== "confirmed" && res?.status !== "pending") throw new Error("undo answered " + JSON.stringify(res).slice(0, 300));
      } else {
        await S.guiSave(pc, id, (it) => (it.type === "text" && it.name === "T0" ? { ...it, fontSize: before } : undefined));
        undo = undoRead = pageHas = performance.now() - t0;
        doc = await S.projectOf(pc, id);
      }
      if (title(doc, "T0").fontSize !== before) throw new Error(`the undo left T0 at ${title(doc, "T0").fontSize}, not ${before}`);
      if (k < 2) continue; // warm-up
      const row = { build, mode, round: r, items: ITEMS, versions: VERSIONS, undo: +undo.toFixed(2), undoRead: +undoRead.toFixed(2), pageHas: +pageHas.toFixed(2) };
      out.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
  return out;
}

const summarize = (rows) => {
  const summary = {};
  for (const key of [...new Set(rows.map((x) => `${x.build}/${x.mode}`))]) {
    const xs = rows.filter((x) => `${x.build}/${x.mode}` === key);
    summary[key] = { undos: xs.length, undoMedianMs: +median(xs.map((x) => x.undo)).toFixed(2), undoReadMedianMs: +median(xs.map((x) => x.undoRead)).toFixed(2), pageHasMedianMs: +median(xs.map((x) => x.pageHas)).toFixed(2), roundMedians: [...new Set(xs.map((x) => x.round))].map((r) => ({ round: r, undo: +median(xs.filter((x) => x.round === r).map((x) => x.undo)).toFixed(2), pageHas: +median(xs.filter((x) => x.round === r).map((x) => x.pageHas)).toFixed(2) })) };
  }
  return summary;
};

async function single() {
  const S = require("./support.js");
  if (S.skip || S.noBuild) throw new Error("needs CARDBOARD_PRISTINE and carton/'s pnpm install: " + (S.skip || S.noBuild));
  const b = await S.build();
  const build = arg("name", "this"), only = arg("round", null);
  const all = [];
  for (let r = 0; r < ROUNDS; r++) {
    const rr = only === null ? r : Number(only);
    for (const mode of rr % 2 ? [...MODES].reverse() : MODES) all.push(...(await round(S, b, mode, rr, build)));
  }
  if (only === null) console.log(JSON.stringify({ summary: summarize(all), unverified: true }));
}

/** --ab name=<checkout> ...: each round runs every checkout's own bench once, the order flipped every round. */
function ab() {
  const builds = args("ab").flatMap((x) => x.split(" ")).filter(Boolean).map((x) => { const [name, root] = x.split("="); return { name, root: path.resolve(root) }; });
  const scratch = process.env.CARTON_TEST_DIR;
  if (!scratch) throw new Error("set CARTON_TEST_DIR (each build gets <dir>/<name>)");
  const rows = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const b of r % 2 ? [...builds].reverse() : builds) {
      const bench = path.join(b.root, "scripts", "carton", "test", "sync", "undo-bench.js");
      const pass = ["undos", "items", "versions", "modes"].flatMap((k) => (arg(k, null) === null ? [] : ["--" + k, arg(k)]));
      const x = spawnSync(process.execPath, [bench, "--rounds", "1", "--round", String(r), "--name", b.name, ...pass], { env: { ...process.env, CARTON_TEST_DIR: path.join(scratch, b.name) }, encoding: "utf8", maxBuffer: 64 << 20, timeout: 3_600_000 });
      if (x.status !== 0) throw new Error(`${b.name} round ${r}: ${x.stderr.slice(-4000)}`);
      for (const l of x.stdout.split("\n")) {
        if (!l.startsWith("{")) continue;
        const row = JSON.parse(l);
        if (row.build) rows.push(row), console.log(l);
      }
    }
  }
  console.log(JSON.stringify({ summary: summarize(rows), unverified: true }));
}

(args("ab").length ? Promise.resolve().then(ab) : single()).catch((e) => { console.error(e); process.exitCode = 1; });
