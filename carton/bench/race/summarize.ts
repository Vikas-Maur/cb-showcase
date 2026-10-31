// Builds the P10 tables from race.ts trial lines (ported from proofs/race/summarize.mjs): node summarize.ts out.jsonl
import fs from "node:fs";
import { hist, hmax, hmerge, hq, type Hist } from "./hist.ts";

type Row = Record<string, any>;
const rs: Row[] = fs
  .readFileSync(process.argv[2]!, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const lvl = (v: unknown): number => (v === true ? 1 : Number(v) || 0);
const merge = (list: Row[], k: string): Hist => {
  const h = hist();
  for (const r of list) if (r[k]) hmerge(h, r[k] as Hist);
  return h;
};
const q = (h: Hist, p: number): string => String(hq(h, p) ?? "–");
const mx = (h: Hist): string => String(hmax(h) ?? "–");
const sum = (list: Row[], k: string): number => list.reduce((a, r) => a + (r[k] ?? 0), 0);
const md = (rows: unknown[][]): string => [rows[0]!, rows[0]!.map(() => "---"), ...rows.slice(1)].map((r) => "| " + r.join(" | ") + " |").join("\n");
const group = (list: Row[], keyOf: (r: Row) => string): Map<string, Row[]> => {
  const g = new Map<string, Row[]>();
  for (const r of list) {
    const k = keyOf(r);
    g.set(k, [...(g.get(k) ?? []), r]);
  }
  return g;
};
const n = (x: number): string => x.toLocaleString("en-US");

// A: writers using temp+rename.
const race = rs.filter((r) => r.writers > 0 && r.style === "rename");
const A: unknown[][] = [["fs", "mode", "window", "protocol", "trials", "engine rounds", "foreign writes", "superseded by a later foreign write", "**lost by the engine**", "unattributed", "EEXIST retries", "reader reads", "reader ENOENT", "torn reads", "busy retries", "oracle disagreements"]];
for (const [k, l] of group(race, (r) => [r.fs, r.mode, r.widen, r.protocol].join("|"))) {
  const [fsl, mode, widen, p] = k.split("|");
  const lost = l.some((r) => r.lostByEngine !== undefined) ? `**${n(sum(l, "lostByEngine"))}**` : "n/a (no oracle)";
  A.push([fsl, mode, widen === "0" ? "natural" : `widened ${widen} µs`, p, l.length, n(sum(l, "rounds")), n(sum(l, "landed")), n(sum(l, "superseded")), lost, n(sum(l, "unattributed")), p === "displace" ? n(sum(l, "eexist")) : "–", n(sum(l, "reads")), n(sum(l, "enoent")), n(sum(l, "torn")), n(sum(l, "busy")), l.filter((r) => r.oracleOk === false).length]);
}

// B: in-place writers (turn mode, 1 writer).
const ip = rs.filter((r) => r.style === "inplace");
const B: unknown[][] = [["fs", "protocol", "trials", "engine rounds", "foreign writes", "**lost by the engine**", "engine read a half-written file", "lost write left in a kept file", "reader torn reads / reads", "writer busy retries (Windows: the view open or being displaced; retried as an app would)"]];
for (const [k, l] of group(ip, (r) => [r.fs, r.protocol + (lvl(r.settle) ? " + settle " + lvl(r.settle) + (lvl(r.settle) === 2 ? " (shipped)" : "") : "")].join("|"))) {
  const [fsl, p] = k.split("|");
  B.push([fsl, p, l.length, n(sum(l, "rounds")), n(sum(l, "landed")), `**${n(sum(l, "lostByEngine"))}**`, n(sum(l, "tornImports")), n(sum(l, "keptNotRecorded")), `${n(sum(l, "torn"))} / ${n(sum(l, "reads"))}`, n(sum(l, "writerBusy"))]);
}

// C: the missing-path gap, paced engine (one materialization per 2 ms), no writers.
const gap = rs.filter((r) => r.writers === 0);
const C: unknown[][] = [["fs", "engine", "other process", "trials", "rounds", "engine gap µs p50 / p90 / p99 / max", "stat-probe absent streak µs p50 / p99 / max", "readFile calls", "readFile ENOENT", "ENOENT per read", "Carton's reader (retryMissing): failed / reads; wait µs p50 / p99 / max"]];
for (const [k, l] of group(gap, (r) => [r.fs, r.engine + (r.lock ? " + install lock" : ""), r.reader || "none"].join("|"))) {
  const [fsl, eng, rd] = k.split("|") as [string, string, string];
  const g = merge(l, "gap");
  const p = merge(l, "pstreak");
  const reads = rd === "read" || rd === "both";
  const probes = rd === "stat" || rd === "both";
  const w = merge(l, "rwait");
  const retry = rd === "retry" ? `${n(sum(l, "rfailed"))} / ${n(sum(l, "rreads"))}; ${q(w, 0.5)} / ${q(w, 0.99)} / ${mx(w)}` : "–";
  C.push([fsl, eng, ({ read: "readFile loop", stat: "stat probe loop", both: "both loops", retry: "retrying readFile loop", none: "none" } as Record<string, string>)[rd], l.length, n(sum(l, "rounds")), `${q(g, 0.5)} / ${q(g, 0.9)} / ${q(g, 0.99)} / ${mx(g)}`, probes ? `${q(p, 0.5)} / ${q(p, 0.99)} / ${mx(p)}` : "–", reads ? n(sum(l, "reads")) : "–", reads ? n(sum(l, "enoent")) : "–", reads && sum(l, "reads") ? ((sum(l, "enoent") / sum(l, "reads")) * 100).toFixed(2) + " %" : "–", retry]);
}

// D: the gap inside the race trials (no pacing, writers racing, 100% CPU).
const D: unknown[][] = [["fs", "mode", "trials", "rounds", "engine gap µs p50 / p90 / p99 / max"]];
for (const [k, l] of group(
  race.filter((r) => r.protocol === "displace" && r.widen === 0),
  (r) => [r.fs, r.mode].join("|"),
)) {
  const [fsl, mode] = k.split("|");
  const g = merge(l, "gap");
  D.push([fsl, mode, l.length, n(sum(l, "rounds")), `${q(g, 0.5)} / ${q(g, 0.9)} / ${q(g, 0.99)} / ${mx(g)}`]);
}

// Turn mode needs no oracle: writers never replace each other, so every unaccounted write is the engine's loss.
const lostOf = (r: Row): number => r.lostByEngine ?? (r.mode === "turn" ? r.unaccounted : 0);
console.log("## Totals (temp+rename writers)\n");
for (const p of ["naive", "replace", "hardlink", "displace"]) {
  const l = race.filter((r) => r.protocol === p);
  if (!l.length) continue;
  console.log(`- ${p}: ${l.length} trials, ${n(sum(l, "rounds"))} rounds, ${n(sum(l, "landed"))} foreign writes, **${n(l.reduce((a, r) => a + lostOf(r), 0))} lost by the engine**; trials with any loss: ${l.filter((r) => lostOf(r) > 0).length}`);
}
const oracle = rs.filter((r) => r.oracleOk !== undefined);
if (oracle.length) console.log(`- oracle disagreements in all ${oracle.length} oracle trials: ${rs.filter((r) => r.oracleOk === false).length}; queue overflows: ${rs.reduce((a, r) => a + (r.oracleBad?.overflow ?? 0), 0)}`);
console.log(`- reader ENOENT with naive/hardlink: ${sum(race.filter((r) => r.protocol !== "displace"), "enoent")} of ${n(sum(race.filter((r) => r.protocol !== "displace"), "reads"))} reads; torn reads with temp+rename writers: ${sum(race, "torn")}`);
console.log("\n## A. Temp+rename writers\n\n" + md(A));
console.log("\n## B. In-place writers\n\n" + md(B));
console.log("\n## C. Missing-path gap, paced engine\n\n" + md(C));
console.log("\n## D. Missing-path gap inside the race trials\n\n" + md(D));
