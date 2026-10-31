// P9 load harness (PLAN §6.1, §20 P9): 5 editors on one track through the real sync client and the real sequencer
// core, in virtual time (port of system-v11 `p9.mjs`; the model is `@carton/conformance` src/system/p9.ts).
// Results are deterministic per seed: CPU load changes the wall time only, never a number in the tables. Run it inside
// the box's CPU lock anyway, so its minutes of CPU don't disturb other agents' timed benchmarks:
//
//   flock /tmp/gfv-race/cpu.lock node carton/bench/p9/run.ts --seeds 30 --out carton/bench/p9/results/main
//   ... --sensitivity --only none     (v10's rule, jitter, one push in flight)
//   ... --seed0 31 --seeds 30          (a second seed set)
//
// Writes <out>-runs.jsonl (one line per run, with its latency list), <out>-summary.json and <out>-summary.md (the
// pooled table, the v3/per-item p99 ratios, S2), and records node, uptime and wall time per cell.
// `--keying v3-spans --rtt 300` runs one configuration (so a driver can take the CPU lock per configuration, letting
// other agents' benchmarks in between); `--merge a-runs.jsonl,b-runs.jsonl --out x` summarizes runs already made.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runOnce, s2, summarize, table, type P9Config, type P9Run } from "../../packages/conformance/src/system/p9.ts";
import type { Keying } from "../../packages/conformance/src/system/rule-variants.ts";

const argv = process.argv.slice(2);
const arg = (k: string): string | true | undefined => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const SEEDS = Number(arg("seeds") ?? 30);
const SEED0 = Number(arg("seed0") ?? 1);
const OUT = typeof arg("out") === "string" ? (arg("out") as string) : "carton/bench/p9/results/p9";
const only = arg("only");
const keyings = (typeof only === "string" ? only.split(",").filter((k) => k !== "none") : ["v2-layout", "v3-spans", "per-item"]) as Keying[];

const configs: Omit<P9Config, "seed">[] = [];
const oneKeying = arg("keying"), oneRtt = arg("rtt");
if (typeof oneKeying === "string") {
  const c: Omit<P9Config, "seed"> = { keying: oneKeying as Keying, rtt: Number(oneRtt ?? 300) };
  if (typeof arg("jitter") === "string") c.jitter = Number(arg("jitter"));
  if (arg("one-push")) c.pipeline = false;
  configs.push(c);
} else if (!arg("merge")) for (const rtt of [300, 50]) for (const keying of keyings) configs.push({ keying, rtt });
if (arg("sensitivity") && typeof oneKeying !== "string")
  for (const rtt of [300, 50]) {
    configs.push({ keying: "v3-spans-v10", rtt });
    configs.push({ keying: "v3-spans-v10", rtt, jitter: rtt / 5 });
    for (const keying of ["v2-layout", "v3-spans", "per-item"] as const) configs.push({ keying, rtt, pipeline: false });
    for (const keying of ["v2-layout", "v3-spans", "per-item"] as const) configs.push({ keying, rtt, jitter: rtt / 5 });
  }

const merge = arg("merge");
mkdirSync(dirname(OUT), { recursive: true });
if (typeof merge !== "string") writeFileSync(`${OUT}-runs.jsonl`, "");
const uptime = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const runs: P9Run[] = [];
const t0 = Date.now();
if (typeof merge === "string") for (const f of merge.split(",")) for (const line of readFileSync(f, "utf8").split("\n")) if (line.trim()) runs.push(JSON.parse(line) as P9Run);
for (const c of configs)
  for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
    const w0 = Date.now(), load = uptime();
    const r = await runOnce({ ...c, seed });
    runs.push(r);
    appendFileSync(`${OUT}-runs.jsonl`, JSON.stringify({ ...r, wallMs: Date.now() - w0, loadavg: load, node: process.version }) + "\n");
    process.stderr.write(`${c.keying}${c.pipeline === false ? "/1-in-flight" : ""}${c.jitter ? "/jitter" : ""} rtt=${c.rtt} seed=${seed} p99=${Math.round(r.p99)} rejects=${r.rejects} ok=${r.converged} ${Date.now() - w0}ms\n`);
  }
const s2rows = [];
if (!arg("no-s2")) for (const keying of ["v2-layout", "v3-spans", "per-item", "v3-spans-v10"] as const) for (const first of ["ripple", "append"] as const) s2rows.push(await s2({ keying, first }));
const sum = summarize(runs);
const ratio = (rtt: number) => {
  const v3 = sum.find((r) => r.name === "v3-spans" && r.rtt === rtt), pi = sum.find((r) => r.name === "per-item" && r.rtt === rtt);
  return v3 && pi ? { pooled: v3.p99 / pi.p99, medianOfSeeds: v3.medSeedP99 / pi.medSeedP99 } : null;
};
const out = { engine: "@carton/core + @carton/server", node: process.version, seeds: [SEED0, SEED0 + SEEDS - 1], wallMs: Date.now() - t0, summary: sum, ratioV3overPerItem: { 300: ratio(300), 50: ratio(50) }, s2: s2rows };
writeFileSync(`${OUT}-summary.json`, JSON.stringify(out, null, 1));
const md = [
  `UNVERIFIED (AGENTS.md rule 6). @carton/core + @carton/server; seeds ${SEED0}..${SEED0 + SEEDS - 1}; latency ms (virtual time); node ${process.version}`,
  "",
  table(sum),
  "",
  ...(ratio(300) ? [`p99 ratio v3 spans / per-item: RTT 300 → pooled ${ratio(300)!.pooled.toFixed(2)}, median of per-seed p99 ${ratio(300)!.medianOfSeeds.toFixed(2)}; RTT 50 → pooled ${ratio(50)?.pooled.toFixed(2)}, median of per-seed p99 ${ratio(50)?.medianOfSeeds.toFixed(2)}`, ""] : []),
  "| S2 keying | arrives first | rejects | forced through merge3 | i3 | i4 | gap i3→i4 (s) |",
  "|---|---|---:|---|---|---|---:|",
  ...s2rows.map((r) => `| ${r.keying} | ${r.first} | ${r.rejects} | ${r.forcedThroughMerge3 ? "yes" : "no"} | [${r.i3}] | [${r.i4}] | ${r.gap} |`),
].join("\n");
writeFileSync(`${OUT}-summary.md`, md + "\n");
console.log(md);
