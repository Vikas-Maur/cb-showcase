// Per-save latency with Carton on and off (H8: every project's write path changes once the worker's Materializer owns
// timeline.tsx), on Cardboard's real library worker and real bundles made by Cardboard's own cb, as support.js builds
// them. Not a test: a measurement, alternating the two modes round by round, each round in a fresh library.
//   - save: the GUI save's round trip to the worker (projects.updateScoped, as main's G2 timing measures it: the commit
//     and the project.json write);
//   - file: from the save's start until timeline.tsx shows it (Cardboard's mirror with Carton off, the Materializer's
//     rewrite with Carton on).
// Prints every save as a JSON line, then the medians per mode and size. Numbers from here are UNVERIFIED until a
// separate check confirms them (AGENTS.md rule 6). Run it alone (slot.sh), on a quiet machine:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> CARTON_TEST_DIR=<scratch> \
//     node scripts/carton/test/sync/save-bench.js [--rounds 4] [--saves 20] [--items 3,200] [--max-ratio 4]
// --max-ratio: fail (exit code 1) when a size's save median with Carton on is more than that many times its median
// with Carton off. A generous bound for a gross regression only (the medians are a busy shared machine's); the save's
// work itself is held by counts in save-cost.test.js.
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg("rounds", 4)), SAVES = Number(arg("saves", 20)), SIZES = String(arg("items", "3,200")).split(",").map(Number);
const MAX_RATIO = arg("max-ratio", null) === null ? null : Number(arg("max-ratio"));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** A timeline with a clip and `n` titles, applied with Cardboard's own cb. */
function timeline(n) {
  const titles = Array.from({ length: n }, (_, i) => `      <text name="T${i}" start={${(i * 0.5).toFixed(1)}} end={${(i * 0.5 + 0.4).toFixed(1)}} fontSize={100} textContent="Title ${i}" />`).join("\n");
  return `export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n${titles}\n    </track>\n  </timeline>\n);\n`;
}

async function round(b, mode, items, r) {
  const pc = await S.computer(`bench-${mode}-${items}-${r}`, b);
  pc.env.CARDBOARD_CARTON = mode === "on" ? "1" : "0";
  const must = (x, what) => { if (x.code !== 0) throw new Error(what + ": " + x.out + x.err); };
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(items));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  const out = [];
  try {
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    for (let i = 0; i < SAVES + 3; i++) {
      const doc = await S.projectOf(pc, id);
      const size = 101 + (i % 50); // a new value every save
      const items2 = doc.timelineItems.map((it) => (it.type === "text" && it.name === "T0" ? { ...it, fontSize: size } : it));
      const t0 = performance.now();
      await pc.call("projects.updateScoped", { ...doc, timelineItems: items2, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
      const save = performance.now() - t0;
      // the file shows it: polled every 2 ms (a read of a small file; the same for both modes)
      let fileMs = null;
      for (const end = t0 + 5000; performance.now() < end; ) {
        try { if (fs.readFileSync(tsx, "utf8").includes(`fontSize={${size}}`)) { fileMs = performance.now() - t0; break; } } catch {}
        await S.sleep(2);
      }
      if (i < 3) continue; // warm-up: the first saves open Carton and load the code
      const row = { mode, items, round: r, save: +save.toFixed(2), file: fileMs === null ? null : +fileMs.toFixed(2) };
      out.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
  return out;
}

(async () => {
  if (S.skip || S.noBuild) throw new Error("needs CARDBOARD_PRISTINE and carton/'s npm ci: " + (S.skip || S.noBuild));
  const b = await S.build();
  const all = [];
  for (const items of SIZES) {
    for (let r = 0; r < ROUNDS; r++) {
      // alternate which mode goes first, so a warming machine favours neither
      for (const mode of r % 2 ? ["on", "off"] : ["off", "on"]) all.push(...(await round(b, mode, items, r)));
    }
  }
  const summary = {};
  for (const items of SIZES) for (const mode of ["off", "on"]) {
    const rows = all.filter((x) => x.items === items && x.mode === mode);
    const files = rows.map((x) => x.file).filter((x) => x !== null);
    summary[`${mode}/${items}`] = { saves: rows.length, saveMedianMs: +median(rows.map((x) => x.save)).toFixed(2), fileMedianMs: +median(files).toFixed(2), fileMissing: rows.length - files.length };
  }
  console.log(JSON.stringify({ summary, unverified: true }));
  if (MAX_RATIO !== null) {
    for (const items of SIZES) {
      const on = summary[`on/${items}`].saveMedianMs, off = summary[`off/${items}`].saveMedianMs;
      if (!(on <= MAX_RATIO * off)) {
        console.error(`${items} items: a save with Carton on (median ${on} ms) took more than ${MAX_RATIO}x one with it off (${off} ms)`);
        process.exitCode = 1;
      }
    }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
