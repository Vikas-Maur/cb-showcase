// Verifier's A/B for store-sqlite (VERIFIED.md S3c): runs stores' own bench/run.ts for several sides (each a
// store-sqlite package folder: its src and its bench harness), one round of every cell per side per turn, the side order
// rotated each round, all in this one job. Each side keeps its own databases and its own JSON lines (ab-<side>.jsonl).
//   node ci/xcheck/ab-sqlite.mjs --rounds 7 --cells '^(open|commit)' --tmp <dir> --results <dir> A=<pkg dir> B=<pkg dir> …
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const rounds = Number(opt("--rounds", "7"));
const cells = opt("--cells", "^(open|commit)");
const tmp = opt("--tmp");
const results = opt("--results");
const sides = args.filter((a) => /^\w+=/.test(a)).map((a) => {
  const [name, dir] = a.split("=");
  return { name, dir: path.resolve(dir) };
});
if (!tmp || !results || sides.length < 2 || !(rounds > 0)) throw new Error("usage: ab-sqlite.mjs --rounds N --cells RE --tmp DIR --results DIR A=<dir> B=<dir> …");
for (const s of sides) if (!fs.existsSync(path.join(s.dir, "bench", "run.ts"))) throw new Error(`no bench/run.ts in ${s.dir}`);

for (let r = 0; r < rounds; r++) {
  const order = sides.map((_, i) => sides[(i + r) % sides.length]);
  for (const s of order) {
    console.log(`round ${r + 1}: ${s.name} (${s.dir})`);
    const p = spawnSync(process.execPath, ["bench/run.ts", path.join(tmp, `ab-${s.name}`), "1", path.join(results, `ab-${s.name}.jsonl`), "10000,100000", cells], { cwd: s.dir, stdio: "inherit", env: process.env });
    if (p.status !== 0) throw new Error(`side ${s.name} round ${r + 1} exited ${p.status ?? p.signal}`);
  }
}
