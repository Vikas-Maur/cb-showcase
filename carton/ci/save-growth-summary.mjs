// Summarise save-ab.cjs's rows.jsonl for the save-growth measurement: per cell and size, the medians of the save round
// trip, the worker's CPU per save and the file (timeline.tsx shows it) for each block of BLOCK saves (default 50), the
// first -> last block, and the slope of the CPU series (least squares over every save, ms per 100 saves).
//   node ci/save-growth-summary.mjs <rows.jsonl> [BLOCK]
import fs from "node:fs";
const [file, blockArg] = process.argv.slice(2);
const BLOCK = Number(blockArg ?? 50);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const med = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!s.length) return null;
  return Math.round((s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100;
};
const groups = new Map();
for (const r of rows) {
  const k = `${r.cell} items=${r.items}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, rs] of groups) {
  rs.sort((a, b) => a.i - b.i);
  const blocks = [];
  for (let i = 0; i < rs.length; i += BLOCK) blocks.push(rs.slice(i, i + BLOCK));
  const line = (f) => blocks.map((b) => med(b.map((r) => r[f]))).join(" ");
  const n = rs.length, xs = rs.map((_, i) => i), ys = rs.map((r) => r.cpu);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const nulls = rs.filter((r) => r.file == null).length;
  console.log(`${k}: ${n} saves, blocks of ${BLOCK}`);
  console.log(`  save ms      ${line("save")}`);
  console.log(`  cpu ms       ${line("cpu")}`);
  console.log(`  file ms      ${line("file")}${nulls ? `  (${nulls} saves never showed in timeline.tsx within 5 s)` : ""}`);
  console.log(`  cpu slope    ${Math.round(slope * 100 * 100) / 100} ms per 100 saves; save first->last block ${med(blocks[0].map((r) => r.save))} -> ${med(blocks.at(-1).map((r) => r.save))}; cpu ${med(blocks[0].map((r) => r.cpu))} -> ${med(blocks.at(-1).map((r) => r.cpu))}`);
}
