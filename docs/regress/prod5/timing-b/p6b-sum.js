// node p6b-sum.js: timing B on carton-prod5 (results/p6b/lat-b6-*.json, writers.js --out with raw `samples`).
// Per run: applies, failures, non-applied outcomes, and from every applied edit's ms: median, p90, p95 (nearest rank),
// max, stalls ≥ 5 s. Per side and writer count: the median of run medians, and the pooled median / p90 / p95.
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "results", "p6b");
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const S = {};
for (const f of fs.readdirSync(dir).filter((f) => /^lat-b6-.*\.json$/.test(f)).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const [, side, W, rep] = f.match(/^lat-b6-(on|off)-w(\d)-r(\d)\.json$/);
  const all = Object.values(j.samples ?? {}).flat();
  const ok = all.filter((x) => x.outcome === "applied").map((x) => x.ms);
  const other = all.filter((x) => x.outcome !== "applied");
  const stalls = ok.filter((x) => x >= 5000).length;
  console.log(`${f.replace(".json", "").padEnd(18)} edits ${String(all.length).padStart(3)} applied ${String(ok.length).padStart(3)} other ${other.length} failures ${(j.failures ?? []).length} | median ${med(ok)} p90 ${q(ok, 90)} p95 ${q(ok, 95)} max ${Math.max(...ok)} stalls≥5s ${stalls} | lost ${j.lost}`);
  const k = `w${W} ${side}`; (S[k] ??= { meds: [], all: [], applied: [] }); S[k].meds.push(med(ok)); S[k].all.push(...ok); S[k].applied.push(ok.length);
}
console.log("\nside      runs  run medians            median of run medians  pooled median  pooled p90  pooled p95  applies per run");
for (const k of Object.keys(S).sort()) { const s = S[k]; console.log(`${k.padEnd(9)} ${String(s.meds.length).padStart(4)}  ${s.meds.join(", ").padEnd(22)} ${String(med(s.meds)).padStart(21)}  ${String(med(s.all)).padStart(13)}  ${String(q(s.all, 90)).padStart(10)}  ${String(q(s.all, 95)).padStart(10)}  ${s.applied.join(", ")}`); }
