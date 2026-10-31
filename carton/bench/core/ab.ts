// Prototype vs Carton on the prototype's own benchmarks: runs core-v5's `bench.mjs` (unchanged) and the port
// `bench.ts` alternately, one process per (build, size), ROUNDS rounds, and reports per-cell medians with every run.
// Then the correctness side (compare.mjs's Cardboard rn comparison): the prototype's `compare.mjs` unchanged, and
// `compare.ts` on both engines, checking the tables match.
//
// node carton/bench/core/ab.ts [--rounds 5] [--sizes 1000,10000] [--no-compare] [--resume <runDir>] [--summarize <runDir>]
//
// - The prototype runs from a byte-identical copy under $CARTON_BENCH_SCRATCH/proto (sha256 checked against
//   CARTON_PROTO_DIR), laid out so its relative `../../../cardboard-1.4.0` reaches CARTON_CARDBOARD_DIR: its scripts
//   write results/ next to themselves, and the inspection copy must never be written.
// - Every process holds the box's shared CPU lock (GFV_LOCK, default /tmp/gfv-race/cpu.lock) for its whole run only,
//   so other benchmarks interleave between processes, and logs `uptime` when it gets the lock and when it ends. Both
//   builds get the same env: RUNS (default 7) and LOAD_WAIT (default 0 here: the lock replaces the prototype's
//   30 s wait for load < 2, which never passes on this shared box; each row still records its load).
// - Order alternates every round (prototype first in odd rounds). Each completed job is appended to
//   <runDir>/jobs.jsonl, so --resume picks up an interrupted run.
// - Writes <runDir>/summary.{md,json}, and copies the summary and the compare tables to carton/bench/core/results/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, symlinkSync, lstatSync, openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { median, fmtMs, SCRATCH, CARDBOARD_DIR } from "./util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_SRC = process.env.CARTON_PROTO_DIR || "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/git-for-video/proofs/core-v5";
const PROTO = join(SCRATCH, "proto", "i", "g", "core-v5"); // ../../../cardboard-1.4.0 from here = SCRATCH/proto/cardboard-1.4.0
const LOCK = process.env.GFV_LOCK || "/tmp/gfv-race/cpu.lock";
const RUNS = process.env.RUNS ?? "7";
const LOAD_WAIT = process.env.LOAD_WAIT ?? "0";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const ROUNDS = Number(arg("--rounds") ?? 5);
const SIZES = (arg("--sizes") ?? "1000,10000").split(",").map(Number);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = arg("--summarize") ?? arg("--resume") ?? join(SCRATCH, `ab-${stamp}`);
mkdirSync(RUN_DIR, { recursive: true });
const JOBS = join(RUN_DIR, "jobs.jsonl");

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

// ------------------------------------------------------------------ the prototype's copy

function prepareProto(): Record<string, string> {
  mkdirSync(PROTO, { recursive: true });
  const link = join(SCRATCH, "proto", "cardboard-1.4.0");
  if (!existsSync(link) && !(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ?? false)) symlinkSync(CARDBOARD_DIR, link);
  const hashes: Record<string, string> = {};
  for (const f of readdirSync(PROTO_SRC).filter((f) => f.endsWith(".mjs"))) {
    const src = join(PROTO_SRC, f),
      dst = join(PROTO, f);
    if (!existsSync(dst) || sha(dst) !== sha(src)) copyFileSync(src, dst);
    hashes[f] = sha(src);
    if (sha(dst) !== hashes[f]) throw new Error(`prototype copy of ${f} differs from ${src}`);
  }
  return hashes;
}

// ------------------------------------------------------------------ one job inside the lock

interface Job {
  round: number;
  impl: "proto" | "carton";
  size: number;
  json: string;
  txt: string;
  exit: number | null;
  lockedAt: string;
  loadAtLock: string;
  uptimeAtLock: string;
  loadAfter: string;
  runS: number;
  waitS: number;
}
// stderr gets "LOCKED <epoch> <load1 load5 load15>" + uptime when the lock is held, "DONE <epoch> <loads>" at the end
const WRAP = `echo "LOCKED $(date +%s.%N) $(cut -d' ' -f1-3 /proc/loadavg)" >&2; echo "UPTIME $(uptime)" >&2; "$@"; s=$?; echo "DONE $(date +%s.%N) $(cut -d' ' -f1-3 /proc/loadavg)" >&2; exit $s`;

function runLocked(cmd: string[], cwd: string, env: Record<string, string>, txt: string) {
  const t0 = Date.now() / 1000;
  const fd = openSync(txt, "w");
  const p = spawnSync("flock", [LOCK, "sh", "-c", WRAP, "sh", ...cmd], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, "pipe"], encoding: "utf8", maxBuffer: 1 << 26 });
  closeSync(fd);
  const err = p.stderr ?? "";
  writeFileSync(txt.replace(/\.txt$/, ".err"), err);
  const locked = /LOCKED (\S+) (\S+ \S+ \S+)/.exec(err),
    done = /DONE (\S+) (\S+ \S+ \S+)/.exec(err),
    up = /UPTIME (.*)/.exec(err);
  const tl = locked ? Number(locked[1]) : NaN,
    td = done ? Number(done[1]) : NaN;
  return { exit: p.status, lockedAt: new Date(tl * 1000).toISOString(), loadAtLock: locked?.[2] ?? "?", uptimeAtLock: up?.[1]?.trim() ?? "?", loadAfter: done?.[2] ?? loadavg(), runS: +(td - tl).toFixed(1), waitS: +(tl - t0).toFixed(1), stderr: err };
}

function runBench(round: number, impl: "proto" | "carton", size: number): Job {
  const tag = `ab-${stamp}-r${round}`;
  const txt = join(RUN_DIR, `r${round}-${impl}-${size}.txt`);
  const env = { RUNS, LOAD_WAIT, TAG: tag };
  let json: string, r;
  if (impl === "proto") {
    json = join(PROTO, "results", `bench-v5-${size}-${tag}.json`);
    r = runLocked(["node", "--expose-gc", "bench.mjs", String(size)], PROTO, env, txt);
  } else {
    json = join(RUN_DIR, `r${round}-carton-${size}.json`);
    r = runLocked(["node", "--expose-gc", join(HERE, "bench.ts"), String(size)], HERE, { ...env, OUT: json }, txt);
  }
  const { stderr, ...rest } = r;
  if (r.exit !== 0) console.error(`  ${impl} ${size} exited ${r.exit}:\n${stderr.slice(-2000)}`);
  return { round, impl, size, json, txt, ...rest };
}

// ------------------------------------------------------------------ correctness: compare

function runCompare() {
  const out: Record<string, unknown> = {};
  const jobs: [string, string[], string, Record<string, string>][] = [
    ["proto-compare.mjs", ["node", "compare.mjs"], PROTO, {}],
    ["carton-compare-engine-carton", ["node", join(HERE, "compare.ts"), "--engine", "carton"], HERE, { OUT: join(RUN_DIR, "compare-carton.json") }],
    ["carton-compare-engine-proto", ["node", join(HERE, "compare.ts"), "--engine", "proto"], HERE, { OUT: join(RUN_DIR, "compare-proto.json"), CARTON_PROTO_DIR: PROTO }],
  ];
  for (const [name, cmd, cwd, env] of jobs) {
    const txt = join(RUN_DIR, `${name}.txt`);
    const r = runLocked(cmd, cwd, env, txt);
    const errTail = r.stderr.split("\n").filter((l) => !/^(LOCKED|UPTIME|DONE) /.test(l)).join("\n").trim();
    out[name] = { exit: r.exit, loadAtLock: r.loadAtLock, uptimeAtLock: r.uptimeAtLock, runS: r.runS, error: errTail.split("\n").find((l) => /Error/.test(l)) ?? null };
    console.log(`compare ${name}: exit ${r.exit} (${r.runS} s, load ${r.loadAtLock})`);
  }
  // scenario tables: the body rows (header names the engine) must match line for line
  const table = (f: string) => readFileSync(join(RUN_DIR, f), "utf8").split("\n").filter((l) => /^\| \d/.test(l));
  const fuzzTable = (f: string) => readFileSync(join(RUN_DIR, f), "utf8").split("\n").filter((l) => /^\| (cardboard|carton|proto) /.test(l)).map((l) => l.replace(/^\| (carton|proto) /, "| engine "));
  const tp = table("proto-compare.mjs.txt"),
    tc = table("carton-compare-engine-carton.txt"),
    tq = table("carton-compare-engine-proto.txt");
  out.scenarioRows = tp.length;
  out.scenariosEqual_protoCompareMjs_vs_cartonEngine = tp.length > 0 && JSON.stringify(tp) === JSON.stringify(tc);
  out.scenariosEqual_protoEngine_vs_cartonEngine = tq.length > 0 && JSON.stringify(tq) === JSON.stringify(tc);
  const fc = fuzzTable("carton-compare-engine-carton.txt"),
    fq = fuzzTable("carton-compare-engine-proto.txt");
  out.fuzzEqual_protoEngine_vs_cartonEngine = fc.length === 2 && JSON.stringify(fc) === JSON.stringify(fq);
  const jc = JSON.parse(readFileSync(join(RUN_DIR, "compare-carton.json"), "utf8")),
    jq = JSON.parse(readFileSync(join(RUN_DIR, "compare-proto.json"), "utf8"));
  out.compareJsonEqual = JSON.stringify({ ...jc, engine: null }) === JSON.stringify({ ...jq, engine: null });
  out.fuzzTable = fc;
  return out;
}

// ------------------------------------------------------------------ summary

interface Row {
  n: number;
  label: string;
  runs: number[];
  median: number;
  reps: number;
  load: { before: number; after: number; waitedS: number };
  extra: string;
}
const RN_OF: Record<string, string> = {
  "merge3, 1 edit per side (shared)": "Cardboard rn, 1 edit per side (shared)",
  "merge3, 1 edit per side (parsed)": "Cardboard rn, 1 edit per side (parsed)",
  "merge3, 10% edited per side (shared)": "Cardboard rn, 10% per side (shared)",
  "merge3, 10% per side (parsed)": "Cardboard rn, 10% per side (parsed)",
};
const isRn = (label: string) => label.startsWith("Cardboard rn");
const f2 = (x: number) => x.toFixed(2);

function summarize(meta: Record<string, unknown>) {
  const jobs: Job[] = existsSync(JOBS) ? readFileSync(JOBS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ok = jobs.filter((j) => j.exit === 0 && existsSync(j.json));
  type Sample = { round: number; size: number; median: number; runs: number[]; reps: number; rowLoad: number; lockLoad: string; extra: string };
  const cells = new Map<string, { n: number; label: string; proto: Sample[]; carton: Sample[] }>();
  const sanity: Record<string, Record<string, unknown>[]> = { proto: [], carton: [] };
  const sizes: Record<string, unknown> = {};
  const bytesOf: Record<string, Record<string, any>> = {};
  for (const j of ok) {
    const o = JSON.parse(readFileSync(j.json, "utf8"));
    sanity[j.impl]!.push({ round: j.round, size: j.size, ...o.sizes });
    sizes[j.impl] ??= o.engineSize;
    for (const [n, s] of Object.entries(o.sizesOnly)) (bytesOf[n] ??= {})[j.impl] ??= s;
    for (const r of o.rows as Row[]) {
      const key = `${r.n}|${r.label}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { n: r.n, label: r.label, proto: [], carton: [] }));
      c[j.impl].push({ round: j.round, size: j.size, median: r.median, runs: r.runs, reps: r.reps, rowLoad: r.load.before, lockLoad: j.loadAtLock, extra: r.extra });
    }
  }
  const out: Record<string, unknown>[] = [];
  const md: string[] = [];
  md.push(`# Prototype (core-v5 bench.mjs) vs Carton (bench/core/bench.ts) — UNVERIFIED`);
  md.push(``);
  md.push(`UNVERIFIED: not yet re-run by an independent verifier; do not quote these numbers as fact.`);
  md.push(``);
  md.push(`Run dir: \`${RUN_DIR}\`. Jobs completed: ${ok.length}/${jobs.length}. Rounds: ${[...new Set(ok.map((j) => j.round))].length}. RUNS=${RUNS}, LOAD_WAIT=${LOAD_WAIT}. Lock: \`${LOCK}\`.`);
  md.push(`Meta: \`${JSON.stringify(meta)}\``);
  md.push(``);
  // Same-code control: Cardboard's rn is identical code in both builds' processes, so its carton/proto ratio in a
  // round is what the load did to that pair of processes. Per (round, size): the median over the four rn cells.
  const pairKey = (s: { round: number; size: number }) => `${s.round}|${s.size}`;
  const paired = (c: { proto: Sample[]; carton: Sample[] }) => {
    const pm = new Map(c.proto.map((s) => [pairKey(s), s]));
    return c.carton.flatMap((s) => (pm.has(pairKey(s)) ? [{ key: pairKey(s), round: s.round, size: s.size, ratio: s.median / pm.get(pairKey(s))!.median }] : []));
  };
  const control = new Map<string, number>();
  for (const size of [...new Set(ok.map((j) => j.size))])
    for (const round of [...new Set(ok.map((j) => j.round))]) {
      const rs = Object.values(RN_OF).flatMap((l) => {
        const c = cells.get(`${size}|${l}`);
        return c ? paired(c).filter((x) => x.round === round).map((x) => x.ratio) : [];
      });
      if (rs.length) control.set(`${round}|${size}`, median(rs));
    }
  md.push(`## Same-code control: Cardboard rn, carton process / prototype process, per round (median of the 4 rn cells)`);
  md.push(``);
  md.push(`Cardboard's rn is the same code in both processes, so any ratio away from 1.00 here is the load difference between the two processes of that round, not the engine.`);
  md.push(``);
  md.push(`| size | ${[...new Set(ok.map((j) => j.round))].sort((a, b) => a - b).map((r) => `round ${r}`).join(" | ")} | median |`);
  md.push(`|---|${[...new Set(ok.map((j) => j.round))].map(() => "---").join("|")}|---|`);
  for (const size of [...new Set(ok.map((j) => j.size))].sort((a, b) => a - b)) {
    const rounds = [...new Set(ok.map((j) => j.round))].sort((a, b) => a - b);
    const xs = rounds.map((r) => control.get(`${r}|${size}`));
    md.push(`| ${size} | ${xs.map((x) => (x === undefined ? "-" : f2(x))).join(" | ")} | ${f2(median(xs.filter((x): x is number => x !== undefined)))} |`);
  }
  md.push(``);
  md.push(`## Cells`);
  md.push(``);
  md.push(`Per cell: median over rounds of each process's median (ms per call). carton/proto = ratio of those medians (< 1: Carton faster); paired = median over rounds of that round's carton/proto ratio; adjusted = median over rounds of (that round's ratio / that round's rn control). rn: Cardboard's rn on the same inputs, measured in the Carton processes; rn ÷ merge3 = how many times faster merge3 is than rn (P4: > 1 in every row), from the medians of the same build's processes. Loads: 1-minute load average recorded before the row, per job.`);
  md.push(``);
  md.push(`| items | cell | prototype median | carton median | carton/proto | paired | adjusted | rn median (carton procs) | rn ÷ merge3 (carton) | rn ÷ merge3 (proto) | loads proto | loads carton | prototype per-round medians | carton per-round medians |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  const sorted = [...cells.values()].sort((a, b) => a.n - b.n);
  for (const c of sorted) {
    const pr = paired(c);
    const pairedRatio = median(pr.map((x) => x.ratio)),
      adjusted = median(pr.filter((x) => control.has(x.key)).map((x) => x.ratio / control.get(x.key)!));
    const pm = median(c.proto.map((s) => s.median)),
      cm = median(c.carton.map((s) => s.median));
    const rnC = RN_OF[c.label] ? cells.get(`${c.n}|${RN_OF[c.label]}`) : undefined;
    const rnCm = rnC ? median(rnC.carton.map((s) => s.median)) : NaN,
      rnPm = rnC ? median(rnC.proto.map((s) => s.median)) : NaN;
    const notesDiffer = c.proto.length && c.carton.length && c.proto[0]!.extra.replace(/accepted.*$/, "") !== c.carton[0]!.extra.replace(/(; )?accepted.*$/, "");
    const rec = {
      n: c.n,
      label: c.label,
      prototype: { median: pm, perRound: c.proto.map((s) => ({ round: s.round, median: s.median, runs: s.runs, reps: s.reps, rowLoad: s.rowLoad, lockLoad: s.lockLoad })) },
      carton: { median: cm, perRound: c.carton.map((s) => ({ round: s.round, median: s.median, runs: s.runs, reps: s.reps, rowLoad: s.rowLoad, lockLoad: s.lockLoad })) },
      ratio: cm / pm,
      paired: { median: pairedRatio, perRound: pr },
      adjusted,
      rn: rnC ? { cartonProcs: rnCm, protoProcs: rnPm, rnOverMerge3Carton: rnCm / cm, rnOverMerge3Proto: rnPm / pm } : null,
      notes: { prototype: c.proto[0]?.extra ?? null, carton: c.carton[0]?.extra ?? null, differ: !!notesDiffer },
    };
    out.push(rec);
    md.push(
      `| ${c.n} | ${c.label}${notesDiffer ? ` (notes differ: "${c.proto[0]!.extra}" vs "${c.carton[0]!.extra}")` : ""} | ${fmtMs(pm)} | ${fmtMs(cm)} | ${isFinite(rec.ratio) ? f2(rec.ratio) : "-"} | ${isFinite(pairedRatio) ? f2(pairedRatio) : "-"} | ${isFinite(adjusted) ? f2(adjusted) : "-"} | ${rnC ? fmtMs(rnCm) : isRn(c.label) ? "(this is rn)" : ""} | ${rnC ? (rnCm / cm).toFixed(1) : ""} | ${rnC ? (rnPm / pm).toFixed(1) : ""} | ${c.proto.map((s) => s.rowLoad).join(" ")} | ${c.carton.map((s) => s.rowLoad).join(" ")} | ${c.proto.map((s) => fmtMs(s.median)).join(" ")} | ${c.carton.map((s) => fmtMs(s.median)).join(" ")} |`,
    );
  }
  md.push(``);
  md.push(`## Jobs (lock-held processes)`);
  md.push(``);
  md.push(`| round | build | size | exit | waited for lock s | ran s | load at lock (1/5/15) | load after | uptime at lock |`);
  md.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const j of jobs) md.push(`| ${j.round} | ${j.impl} | ${j.size} | ${j.exit} | ${j.waitS} | ${j.runS} | ${j.loadAtLock} | ${j.loadAfter} | ${j.uptimeAtLock} |`);
  md.push(``);
  md.push(`## Sanity (merge results per size; must match between builds)`);
  md.push(``);
  const san = (impl: string) => JSON.stringify(Object.fromEntries((sanity[impl] ?? []).map((s) => [s.size, s[String(s.size)]])));
  md.push(`- prototype: \`${san("proto")}\``);
  md.push(`- carton: \`${san("carton")}\``);
  md.push(`- equal: ${san("proto") === san("carton")}`);
  md.push(``);
  md.push(`## Module sizes (the prototype's method: esbuild --minify, ESM, platform node; gzip level 6)`);
  md.push(``);
  md.push(`| build | module | source | minified | minified + gzip |`);
  md.push(`|---|---|---|---|---|`);
  for (const [impl, s] of Object.entries(sizes) as [string, Record<string, any>][])
    for (const [k, v] of Object.entries(s)) if (typeof v === "object") md.push(`| ${impl} | ${k} | ${v.source} B | ${v.minified} B | ${v.minifiedGzip} B |`);
  md.push(``);
  md.push(`prototype: engine = engine.mjs alone; core = history.mjs bundled (engine + history); cbproj = cbproj.mjs. carton: engine = core/src/engine bundled; core = engine + history exports bundled (scripts/size.mjs's P4 entry); cbproj = conformance's cbproj.ts.`);
  md.push(``);
  md.push(`## Bytes per stored change row and per snapshot (JSON / gzip level 6)`);
  md.push(``);
  md.push(`| items | what | prototype | carton |`);
  md.push(`|---|---|---|---|`);
  for (const [n, b] of Object.entries(bytesOf)) {
    const p = b.proto ?? {},
      c = b.carton ?? {};
    const fmt = (v: { json: number; gzip: number } | undefined) => (v ? `${v.json} / ${v.gzip}` : "-");
    for (const k of new Set([...Object.keys(p.change ?? {}), ...Object.keys(c.change ?? {})])) md.push(`| ${n} | change row: ${k} | ${fmt(p.change?.[k])} | ${fmt(c.change?.[k])} |`);
    md.push(`| ${n} | canonical snapshot | ${fmt(p.snapshotCanonical)} | ${fmt(c.snapshotCanonical)} |`);
    md.push(`| ${n} | Cardboard .revs entry per write | ${fmt(p.cardboardRevsPerWrite)} | ${fmt(c.cardboardRevsPerWrite)} |`);
  }
  md.push(``);
  md.push(`Carton's change rows carry what its declare() adds (the \`#time\` group path, span \`item\` and \`structural\`), which the redesigned sequencer checks.`);
  if (meta.compare) {
    md.push(``);
    md.push(`## Correctness (compare)`);
    md.push(``);
    md.push("```json");
    md.push(JSON.stringify(meta.compare, null, 1));
    md.push("```");
  }
  const summary = { meta, runDir: RUN_DIR, runs: RUNS, loadWait: LOAD_WAIT, jobs, control: Object.fromEntries(control), cells: out, sanity, sizes, bytes: bytesOf };
  writeFileSync(join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(join(RUN_DIR, "summary.md"), md.join("\n") + "\n");
  console.log(`\nsummary: ${join(RUN_DIR, "summary.md")}`);
  if (process.argv.includes("--no-copy")) return;
  const res = join(HERE, "results");
  mkdirSync(res, { recursive: true });
  const base = `ab-${RUN_DIR.split("/").pop()!.replace(/^ab-/, "")}`;
  copyFileSync(join(RUN_DIR, "summary.md"), join(res, `${base}.md`));
  copyFileSync(join(RUN_DIR, "summary.json"), join(res, `${base}.json`));
  for (const f of ["proto-compare.mjs.txt", "carton-compare-engine-carton.txt", "carton-compare-engine-proto.txt"]) if (existsSync(join(RUN_DIR, f))) copyFileSync(join(RUN_DIR, f), join(res, `${base}-${f}`));
  console.log(`copied to ${res}/${base}.{md,json}`);
}

// ------------------------------------------------------------------ main

const metaFile = join(RUN_DIR, "meta.json");
if (arg("--summarize")) summarize(existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {});
else {
  const hashes = prepareProto();
  const meta: Record<string, unknown> = existsSync(metaFile)
    ? JSON.parse(readFileSync(metaFile, "utf8"))
    : { started: new Date().toISOString(), node: process.version, rounds: ROUNDS, sizes: SIZES, runs: RUNS, loadWait: LOAD_WAIT, lock: LOCK, protoSource: PROTO_SRC, protoCopy: PROTO, protoSha256: hashes, cardboardDir: CARDBOARD_DIR, git: spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).stdout.trim() };
  writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  const done = new Set(existsSync(JOBS) ? readFileSync(JOBS, "utf8").trim().split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return j.exit === 0 ? `${j.round}|${j.impl}|${j.size}` : ""; }) : []);
  console.log(`run dir ${RUN_DIR}; ${ROUNDS} rounds × sizes ${SIZES.join(",")} × [proto, carton]; RUNS=${RUNS} LOAD_WAIT=${LOAD_WAIT}; lock ${LOCK}`);
  for (let round = 1; round <= ROUNDS; round++)
    for (const size of SIZES)
      for (const impl of (round % 2 ? ["proto", "carton"] : ["carton", "proto"]) as ("proto" | "carton")[]) {
        if (done.has(`${round}|${impl}|${size}`)) continue;
        const j = runBench(round, impl, size);
        appendFileSync(JOBS, JSON.stringify(j) + "\n");
        console.log(`r${round} ${impl.padEnd(6)} ${String(size).padStart(5)}: exit ${j.exit}, waited ${j.waitS} s for the lock, ran ${j.runS} s, load ${j.loadAtLock} -> ${j.loadAfter}`);
      }
  if (!process.argv.includes("--no-compare") && !meta.compare) {
    meta.compare = runCompare();
    writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  }
  meta.finished = new Date().toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  summarize(meta);
}
