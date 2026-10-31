// Runs the store-sqlite benchmark cells round-robin (order rotated each round), one fresh process per run, and appends
// one JSON line per run to <out.jsonl>. Every run holds the box's shared CPU lock (flock), and inside it waits until
// the 1-minute load is below LOAD_MAX, other processes use less than OTHER_MAX cores over a 3 s /proc/stat sample, and
// the database file is fully in the page cache (the template is proofs/media-p6/run-tp.js).
// usage: node bench/run.ts <dir> <rounds> <out.jsonl> [sizes=10000,100000] [cell filter regex]
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK = process.env.GFV_LOCK || "/tmp/gfv-race/cpu.lock";
const LOAD_MAX = Number(process.env.LOAD_MAX || 1.5);
const OTHER_MAX = Number(process.env.OTHER_MAX || 0.5);
const KF_ITEMS = Number(process.env.KF_ITEMS || 1000);
const GATE = `t0=$(date +%s)
busy() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9}' /proc/stat; }
while :; do
  while awk -v m=${LOAD_MAX} '{exit !($1 >= m)}' /proc/loadavg; do sleep 5; done
  b0=$(busy); sleep 3; other=$(awk -v a="$b0" -v b="$(busy)" 'BEGIN{printf "%.2f", (b-a)/300}')
  if awk -v o="$other" -v m=${OTHER_MAX} 'BEGIN{exit !(o >= m)}'; then continue; fi
  res=$(fincore --bytes --noheadings --output RES "$GFV_FILE" | awk '{print $1}')
  if [ "$res" -lt "$GFV_SIZE" ]; then cat "$GFV_FILE" > /dev/null; continue; fi
  break
done
echo "GATE $(( $(date +%s) - t0 )) $(cut -d' ' -f1-3 /proc/loadavg) OTHER $other RES $res UPTIME $(uptime | sed 's/.*load/load/')" >&2; exec "$@"`;

const [dir, roundsArg, out, sizesArg = "10000,100000", filter] = process.argv.slice(2);
const sizes = sizesArg.split(",").map(Number);
fs.mkdirSync(dir, { recursive: true });
const cell = (args: string[]) => [process.execPath, path.join(here, "cell.ts"), ...args];
const CELLS: [string, string, string[]][] = [];
for (const n of sizes) {
  const db = path.join(dir, `bench-${n}`, ".carton", "carton.db");
  if (!fs.existsSync(db)) {
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const g = spawnSync(process.execPath, [path.join(here, "gen.ts"), db, String(n), String(KF_ITEMS)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (g.status !== 0) throw new Error(`gen ${n} failed`);
    console.log(g.stdout.trim());
  }
  CELLS.push([`open ${n}`, db, cell(["open", db])]);
  CELLS.push([`commit ${n} normal`, db, cell(["commit", db, "1000", "normal"])]);
  CELLS.push([`commit ${n} full`, db, cell(["commit", db, "300", "full"])]);
  CELLS.push([`readlog ${n}`, db, cell(["readlog", db])]);
}
const cells = CELLS.filter(([id]) => !filter || new RegExp(filter).test(id));
const loadavg = () => fs.readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
for (let r = 0; r < Number(roundsArg); r++) {
  for (const [id, db, cmd] of cells.map((_, i) => cells[(i + r) % cells.length])) {
    const t0 = Date.now();
    const p = spawnSync("flock", [LOCK, "sh", "-c", GATE, "sh", ...cmd], { encoding: "utf8", env: { ...process.env, GFV_FILE: db, GFV_SIZE: String(fs.statSync(db).size) } });
    const after = loadavg();
    if (p.status !== 0) {
      console.error(id, "failed", p.stderr);
      continue;
    }
    const g = /GATE (\d+) (\S+ \S+ \S+) OTHER (\S+) RES (\d+) UPTIME (.*)/.exec(p.stderr)!;
    const j = JSON.parse(p.stdout.trim().split("\n").pop()!);
    const line = { id, ...j, round: r + 1, node: process.versions.node, loadBefore: g[2], loadAfter: after, otherCoresBefore: Number(g[3]), uptime: g[5], gateWaitS: Number(g[1]), waitedS: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
    fs.appendFileSync(out, JSON.stringify(line) + "\n");
    console.log(`r${r + 1} ${id.padEnd(22)} ${JSON.stringify(j)}  load ${g[2]} -> ${after}`);
  }
}
