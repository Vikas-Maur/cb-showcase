// Shared runner for the media benchmarks, after proofs/media-p6/run-tp.js: every run is a fresh process that holds
// the box's shared CPU lock (flock), methods run round-robin with the order rotated each round, and each run records
// the 1-minute load and how busy other processes kept the CPUs just before it started. One JSON line per run.
// The box is shared by about 10 agents: the gate waits (up to GATE_WAIT_S) for a quiet moment, then runs anyway and
// marks the run `gateTimedOut`, so a busy box shows up in the data instead of stalling the benchmark.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const LOCK = process.env.GFV_LOCK ?? "/tmp/gfv-race/cpu.lock";
const LOAD_MAX = Number(process.env.LOAD_MAX ?? 2.0);
const OTHER_MAX = Number(process.env.OTHER_MAX ?? 0.75);
const GATE_WAIT_S = Number(process.env.GATE_WAIT_S ?? 90);

// Inside the lock: wait for load < LOAD_MAX and other processes using < OTHER_MAX cores over 2 s, then exec the run.
const GATE = `t0=$(date +%s); timedout=0
busy() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9}' /proc/stat; }
while :; do
  b0=$(busy); sleep 2; other=$(awk -v a="$b0" -v b="$(busy)" 'BEGIN{printf "%.2f", (b-a)/200}')
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" -v o="$other" 'BEGIN{exit !(l < ${LOAD_MAX} && o < ${OTHER_MAX})}'; then break; fi
  if [ $(( $(date +%s) - t0 )) -ge ${GATE_WAIT_S} ]; then timedout=1; break; fi
done
echo "GATE $(( $(date +%s) - t0 )) $(cut -d' ' -f1-3 /proc/loadavg) OTHER $other TIMEDOUT $timedout" >&2; exec "$@"`;

export interface Method {
  id: string;
  cmd: string[];
}

export function loadavg(): string {
  return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
}

/** Runs every method `rounds` times, appending one JSON line per run to `out`. Returns the parsed runs. */
export function runRounds(methods: Method[], rounds: number, out: string): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < methods.length; i++) {
      const m = methods[(i + r) % methods.length];
      const t0 = Date.now();
      const p = spawnSync("flock", [LOCK, "sh", "-c", GATE, "sh", ...m.cmd], { encoding: "utf8", maxBuffer: 1 << 24 });
      const after = loadavg();
      if (p.status !== 0) {
        console.error(`${m.id} failed:`, p.stderr.slice(-2000));
        continue;
      }
      const g = /GATE (\d+) (\S+ \S+ \S+) OTHER (\S+) TIMEDOUT (\d)/.exec(p.stderr);
      const j = JSON.parse(p.stdout.trim().split("\n").pop()!);
      const line = {
        id: m.id,
        round: r + 1,
        ...j,
        loadBefore: g?.[2],
        otherCoresBefore: Number(g?.[3]),
        gateTimedOut: g?.[4] === "1",
        gateWaitS: Number(g?.[1]),
        loadAfter: after,
        wallS: Math.round((Date.now() - t0) / 1000),
        at: new Date().toISOString(),
      };
      appendFileSync(out, JSON.stringify(line) + "\n");
      runs.push(line);
      console.log(`r${r + 1} ${m.id.padEnd(34)} ${JSON.stringify(j).slice(0, 120)}  load ${line.loadBefore} -> ${after}${line.gateTimedOut ? " (busy box)" : ""}`);
    }
  }
  return runs;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Median, min, max and every run of `field`, per method id. */
export function summarize(runs: Record<string, unknown>[], field: string): Record<string, { median: number; min: number; max: number; runs: number[] }> {
  const by: Record<string, number[]> = {};
  for (const r of runs) (by[r.id as string] ??= []).push(r[field] as number);
  const out: Record<string, { median: number; min: number; max: number; runs: number[] }> = {};
  for (const [id, xs] of Object.entries(by)) out[id] = { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), runs: xs };
  return out;
}
