// Tables from the run records: per (host, profile, chaos, parties, tag), the median across reps of each run's figures,
// with every run listed. Markdown on stdout.
//   node bench/cloudflare/summarize.ts [filter]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.ts";

const filter = process.argv[2] ?? "sync-";
const med = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const r0 = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "–");
const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const runs = readdirSync(RUNS_DIR)
  .filter((f) => f.startsWith(filter) && f.endsWith(".json") && !f.endsWith(".cost.json"))
  .map((f) => {
    const run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8"));
    const cf = join(RUNS_DIR, f.replace(/\.json$/, ".cost.json"));
    run.cost = existsSync(cf) ? JSON.parse(readFileSync(cf, "utf8")).per : null;
    return run;
  })
  .filter((r) => r.convergenceMs && !/smoke/.test(r.runId));
const tagOf = (r: any) => (/\d+p-r\d+-(.+)-[a-z0-9]{8}$/.exec(r.runId)?.[1] ?? "");
const groups = new Map<string, any[]>();
for (const r of runs) {
  const k = [r.host, r.profile, r.chaos ?? "", String(r.parties).padStart(2, "0"), tagOf(r)].join("|");
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
console.log("| host | profile | chaos | parties | tag | runs | edits | lost | dupes | order | same state | conv p50 | conv p90 | conv p99 | conv max | confirm p50 | cards | rejects | reconnects | settle ms | DO req/edit | rows w/edit | DO CPU ms/edit | GB-s/run | loop lag p99 ms |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [k, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  const [host, profile, chaos, n, tag] = k.split("|");
  const m = (f: (r: any) => number) => med(rs.map(f));
  const sum = (f: (r: any) => number) => rs.reduce((s, r) => s + f(r), 0);
  const reconn = (r: any) => r.clientStats.reduce((s: number, c: any) => s + c.reconnects, 0) - r.parties;
  console.log(`| ${host} | ${profile} | ${chaos || "–"} | ${Number(n)} | ${tag || "–"} | ${rs.length} | ${sum((r) => r.commits)} | ${sum((r) => r.lost)} | ${sum((r) => r.duplicates)} | ${sum((r) => r.orderMismatches)} | ${rs.every((r) => r.sameState) ? "yes" : "NO"} | ${r0(m((r) => r.convergenceMs.p50))} | ${r0(m((r) => r.convergenceMs.p90))} | ${r0(m((r) => r.convergenceMs.p99))} | ${r0(m((r) => r.convergenceMs.max))} | ${r0(m((r) => r.confirmMs.p50))} | ${sum((r) => r.conflictCards)} | ${sum((r) => r.rejects)} | ${sum(reconn)} | ${r0(m((r) => r.timing.settleMs))} | ${r2(m((r) => r.cost?.doRequestsPerEdit))} | ${r2(m((r) => r.cost?.rowsWrittenPerEdit))} | ${r2(m((r) => r.cost?.cpuMsPerEdit))} | ${r2(m((r) => r.cost?.gbSeconds))} | ${r0(m((r) => r.loopLagMs?.p99max))} |`);
}
console.log("\nEvery run (convergence p50 / p99 ms):\n");
for (const [k, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
  console.log(`- ${k.replace(/\|/g, " ")}: ${rs.map((r) => `${r0(r.convergenceMs.p50)}/${r0(r.convergenceMs.p99)}${r.lost ? ` LOST ${r.lost}` : ""}`).join(", ")}`);
