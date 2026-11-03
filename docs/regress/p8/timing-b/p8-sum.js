// node p8-sum.js: Update 8's diagnostic timing B (results/p8/lat-b8-<on|off>-w<1|4>-r<1..6>.json + -activity.jsonl).
// Per run: edits, applied, failures, lost, the median / p90 / p95 (nearest rank) / max of every applied edit's print+apply,
// trips ≥ 3 s and ≥ 5 s. Per side and writer count: the median of run medians, pooled median / p90 / p95, per-run p95s.
// Then every trip ≥ 3 s: which part held the time (print vs apply, ms each), the apply's `timeline` answer, and the
// worker's "[carton] a cb write waited N ms …" activity-log lines whose time falls inside that trip (start to
// start + ms + 1 s), with the step fields the line carries.
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "results", "p8");
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const runs = fs.readdirSync(dir).filter((f) => /^lat-b8-(on|off)-w\d-r\d\.json$/.test(f)).sort();
const S = {}, slow = [];
console.log("run                 edits applied failed lost | median   p90   p95    max | >=3s >=5s | worker lines (any / 'waited')");
for (const f of runs) {
  const [, side, W, rep] = f.match(/^lat-b8-(on|off)-w(\d)-r(\d)\.json$/);
  const label = f.replace(".json", "");
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const all = Object.entries(j.samples).flatMap(([w, s]) => s.map((x) => ({ w, ...x })));
  const ok = all.filter((x) => x.outcome === "applied");
  const ms = ok.map((x) => x.ms);
  const act = path.join(dir, label + "-activity.jsonl");
  const lines = fs.existsSync(act) ? fs.readFileSync(act, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const worker = lines.filter((l) => l.ev === "worker");
  const waited = worker.filter((l) => /a cb write waited/.test(l.msg ?? "")).map((l) => ({ at: Date.parse(l.t), msg: l.msg }));
  const ge3 = ms.filter((x) => x >= 3000).length, ge5 = ms.filter((x) => x >= 5000).length;
  console.log(`${label.padEnd(19)} ${String(all.length).padStart(5)} ${String(ok.length).padStart(7)} ${String(j.failures.length).padStart(6)} ${String(j.lost).padStart(4)} | ${String(med(ms)).padStart(6)} ${String(q(ms, 90)).padStart(5)} ${String(q(ms, 95)).padStart(5)} ${String(Math.max(...ms)).padStart(6)} | ${String(ge3).padStart(4)} ${String(ge5).padStart(4)} | ${worker.length} / ${waited.length}`);
  const k = `w${W} ${side}`; (S[k] ??= { meds: [], all: [], p95: [], applied: [], ge3: 0, ge5: 0, n: 0 });
  S[k].meds.push(med(ms)); S[k].all.push(...ms); S[k].p95.push(q(ms, 95)); S[k].applied.push(ok.length); S[k].ge3 += ge3; S[k].ge5 += ge5; S[k].n += ms.length;
  for (const x of ok.filter((x) => x.ms >= 3000)) {
    const hits = waited.filter((l) => l.at >= x.start - 200 && l.at <= x.start + x.ms + 1000);
    slow.push({ label, ...x, held: x.apply >= x.print ? "apply" : "print", lines: hits.map((h) => h.msg.slice(0, 600)) });
  }
}
console.log("\nside      runs  run medians                               median of run medians  pooled median  pooled p90  pooled p95  per-run p95                     >=3s (of n)  >=5s  applies per run");
for (const k of Object.keys(S).sort()) { const s = S[k]; console.log(`${k.padEnd(9)} ${String(s.meds.length).padStart(4)}  ${s.meds.join(", ").padEnd(41)} ${String(med(s.meds)).padStart(21)}  ${String(med(s.all)).padStart(13)}  ${String(q(s.all, 90)).padStart(10)}  ${String(q(s.all, 95)).padStart(10)}  ${s.p95.join(", ").padEnd(31)} ${String(s.ge3).padStart(4)} (of ${s.n})  ${String(s.ge5).padStart(4)}  ${s.applied.join(", ")}`); }
console.log(`\n== every trip >= 3 s (${slow.length})`);
const tl = {}, held = {};
for (const x of slow) { tl[x.timeline] = (tl[x.timeline] ?? 0) + 1; held[x.held] = (held[x.held] ?? 0) + 1; }
console.log("held by:", JSON.stringify(held), "| timeline answers:", JSON.stringify(tl), "| with a matching worker line:", slow.filter((x) => x.lines.length).length);
for (const x of slow) console.log(`${x.label} ${x.w} edit ${x.edit}: ${x.ms} ms = print ${x.print} + apply ${x.apply} (held: ${x.held}), timeline ${x.timeline}${x.lines.length ? "\n    " + x.lines.join("\n    ") : " | no worker line"}`);
