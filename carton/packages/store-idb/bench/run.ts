// Runs the store-idb benchmark cells round-robin (order rotated each round), one fresh headless Chromium per run on a
// persistent profile, and appends one JSON line per run to <out.jsonl>. Every run holds the box's shared CPU lock and
// waits inside it for low load and low CPU use by other processes (as store-sqlite/bench/run.ts, without the page
// cache check: IndexedDB lives in many LevelDB files).
// usage: TMPDIR=<scratch> node bench/run.ts <profile dir> <rounds> <out.jsonl> [sizes=10000,100000] [filter]
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
  break
done
echo "GATE $(( $(date +%s) - t0 )) $(cut -d' ' -f1-3 /proc/loadavg) OTHER $other UPTIME $(uptime | sed 's/.*load/load/')" >&2; exec "$@"`;

const [profile, roundsArg, out, sizesArg = "10000,100000", filter] = process.argv.slice(2);
const sizes = sizesArg.split(",").map(Number);
const cell = (args: string[]) => [process.execPath, path.join(here, "cell.ts"), profile, ...args];
const marker = (n: number) => path.join(profile, `generated-${n}-${KF_ITEMS}.json`);
const CELLS: [string, number, string[]][] = [];
for (const n of sizes) {
  if (!fs.existsSync(marker(n))) {
    const g = spawnSync(cell(["gen", String(n), String(KF_ITEMS)])[0], cell(["gen", String(n), String(KF_ITEMS)]).slice(1), { encoding: "utf8", env: { ...process.env, BENCH_ID: `bench-${n}` }, stdio: ["ignore", "pipe", "inherit"] });
    if (g.status !== 0) throw new Error(`gen ${n} failed`);
    fs.writeFileSync(marker(n), g.stdout.trim().split("\n").pop()!);
    console.log(g.stdout.trim());
  }
  CELLS.push([`open ${n}`, n, cell(["open"])]);
  CELLS.push([`commit ${n} relaxed`, n, cell(["commit", "500", "relaxed"])]);
  CELLS.push([`commit ${n} strict`, n, cell(["commit", "200", "strict"])]);
  CELLS.push([`readlog ${n}`, n, cell(["readlog"])]);
}
const cells = CELLS.filter(([id]) => !filter || new RegExp(filter).test(id));
const loadavg = () => fs.readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
for (let r = 0; r < Number(roundsArg); r++) {
  for (const [id, n, cmd] of cells.map((_, i) => cells[(i + r) % cells.length])) {
    const t0 = Date.now();
    const p = spawnSync("flock", [LOCK, "sh", "-c", GATE, "sh", ...cmd], { encoding: "utf8", env: { ...process.env, BENCH_ID: `bench-${n}` } });
    const after = loadavg();
    if (p.status !== 0) {
      console.error(id, "failed", p.stderr.slice(-2000));
      continue;
    }
    const g = /GATE (\d+) (\S+ \S+ \S+) OTHER (\S+) UPTIME (.*)/.exec(p.stderr)!;
    const j = JSON.parse(p.stdout.trim().split("\n").pop()!);
    const line = { id, ...j, round: r + 1, node: process.versions.node, loadBefore: g[2], loadAfter: after, otherCoresBefore: Number(g[3]), uptime: g[4], gateWaitS: Number(g[1]), waitedS: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
    fs.appendFileSync(out, JSON.stringify(line) + "\n");
    console.log(`r${r + 1} ${id.padEnd(22)} ${JSON.stringify(j)}  load ${g[2]} -> ${after}`);
  }
}
