// Timing helpers shared by the benchmarks (port of core-v5 `bench-util.mjs`; the timing loop, its warm-up and the
// load gate are the prototype's, so the numbers compare). Every measurement reports all runs and the median.
// A "run" times `reps` calls (reps calibrated so a run lasts >= minMs) and reports ms per call;
// with `setup`, each call gets fresh untimed input and only fn(input) is timed.
//
// Env: RUNS (default 7), LOAD_MAX (default 2), LOAD_WAIT (seconds, default 30), CARTON_CARDBOARD_DIR (an unpacked
// Cardboard 1.4.0 holding `cli/chunks/`), CARTON_BENCH_SCRATCH (where Cardboard's chunks are copied and outputs go).

import { performance } from "node:perf_hooks";
import { cpus, totalmem, loadavg } from "node:os";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, cpSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const RUNS = Number(process.env.RUNS ?? 7);
const WARM = 3;
const gc: () => void = (globalThis as { gc?: () => void }).gc ?? (() => {});

export const SCRATCH = process.env.CARTON_BENCH_SCRATCH || "/home/ubuntu/gfv-scratch/carton/foundation-core/bench";
export const CARDBOARD_DIR = process.env.CARTON_CARDBOARD_DIR || "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0";

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export interface Measured {
  runs: number[];
  median: number;
  reps: number;
}
export interface MeasureOpts<T> {
  setup?: (() => T) | null;
  minMs?: number;
  maxReps?: number;
  runs?: number;
}

/** Calls made by one measure(): WARM + 1 probe + reps per run (the sequencer rows count their accepts with it). */
export const callsOf = (m: Measured): number => WARM + 1 + m.reps * m.runs.length;

export function measure<T>(fn: (x: T) => unknown, { setup = null, minMs = 25, maxReps = 20000, runs = RUNS }: MeasureOpts<T> = {}): Measured {
  const once = () => {
    if (!setup) {
      const t = performance.now();
      (fn as () => unknown)();
      return performance.now() - t;
    }
    const x = setup();
    const t = performance.now();
    fn(x);
    return performance.now() - t;
  };
  for (let i = 0; i < WARM; i++) once();
  const probe = Math.max(once(), 1e-4);
  const reps = Math.max(1, Math.min(maxReps, Math.ceil(minMs / probe)));
  const out: number[] = [];
  for (let r = 0; r < runs; r++) {
    gc();
    let total = 0;
    if (setup) for (let i = 0; i < reps; i++) total += once();
    else {
      const t = performance.now();
      for (let i = 0; i < reps; i++) (fn as () => unknown)();
      total = performance.now() - t;
    }
    out.push(total / reps);
  }
  return { runs: out, median: median(out), reps };
}

// Load gate (the prototype's): before each timed row, log the 1-minute load average and wait (polling every 5 s, up to
// LOAD_WAIT seconds, default 30) for it to drop below LOAD_MAX (default 2). Returns {before, after, waitedS}; rows
// record it so every result carries the load it ran under. ab.ts runs each process inside the shared CPU lock instead
// and sets LOAD_WAIT=0 for both builds, so the gate only records.
const LOAD_MAX = Number(process.env.LOAD_MAX ?? 2),
  LOAD_WAIT = Number(process.env.LOAD_WAIT ?? 30);
export interface Load {
  before: number;
  after: number;
  waitedS: number;
}
export function loadGate(): Load {
  const before = loadavg()[0]!;
  const t0 = Date.now();
  while (loadavg()[0]! >= LOAD_MAX && Date.now() - t0 < LOAD_WAIT * 1000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  return { before: +before.toFixed(2), after: +loadavg()[0]!.toFixed(2), waitedS: Math.round((Date.now() - t0) / 1000) };
}

export const gz = (s: string | Uint8Array): number => gzipSync(typeof s === "string" ? Buffer.from(s) : s, { level: 6 }).length;
export const bytes = (s: string): number => Buffer.byteLength(s);

export const fmtMs = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x >= 0.01 ? x.toFixed(3) : x.toFixed(4));
export const fmtB = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

export function machine() {
  const c = cpus();
  return { cpu: c[0]?.model ?? "?", cores: c.length, arch: process.arch, node: process.version, memGB: +(totalmem() / 2 ** 30).toFixed(1), gcExposed: !!(globalThis as { gc?: unknown }).gc };
}

// Cardboard 1.4.0's own merge (rn) and diff (fr), sliced out of the pristine CLI chunks at run time (never copied into
// this repo): the chunks are copied to the scratch dir and the one holding rn/fr gets an export line appended.
export type HostSlice = { tracks: unknown; timelineItems: unknown; aspectRatio: unknown };
export interface RnConflict {
  kind: string;
  id: string;
}
export type Rn = (base: HostSlice, editor: HostSlice, incoming: HostSlice, opts: { prefer: string }) => { doc: Record<string, any>; conflicts: RnConflict[] };
const RN_CHUNK = "chunk-LL26E55H.mjs";
export async function loadCardboard(): Promise<{ rn: Rn; fr: unknown; source: string }> {
  const src = join(CARDBOARD_DIR, "cli", "chunks");
  const pristine = join(src, RN_CHUNK);
  if (!existsSync(pristine)) throw new Error(`Cardboard 1.4.0's CLI chunks not found at ${src}: set CARTON_CARDBOARD_DIR to an unpacked Cardboard 1.4.0`);
  // keyed by the pristine chunk's hash, so a different Cardboard dir never reuses a stale copy
  const dir = join(SCRATCH, `cbchunks-${createHash("sha256").update(readFileSync(pristine)).digest("hex").slice(0, 12)}`);
  const f = join(dir, RN_CHUNK);
  if (!existsSync(f)) {
    mkdirSync(SCRATCH, { recursive: true });
    cpSync(src, dir, { recursive: true });
  }
  if (!readFileSync(f, "utf8").includes("__rn")) appendFileSync(f, "\nexport { rn as __rn, fr as __fr };\n");
  const m = (await import(pathToFileURL(f).href)) as { __rn: Rn; __fr: unknown };
  return { rn: m.__rn, fr: m.__fr, source: pristine };
}
// the slice rn works on (code.md §2: Ke -> {tracks, timelineItems, aspectRatio})
export const slice = (d: Record<string, any>): HostSlice => ({ tracks: d.tracks, timelineItems: d.timelineItems, aspectRatio: d.aspectRatio });

/**
 * Hold the box's shared CPU lock (GFV_LOCK) for this whole process: a direct run re-executes itself under `flock`;
 * a child of ab.ts is already locked (GFV_LOCKED=1). On Windows there is no flock and nothing to share the lock with.
 */
export function holdCpuLock(): void {
  if (process.env.GFV_LOCKED === "1" || process.platform === "win32") return;
  const lock = process.env.GFV_LOCK || "/tmp/gfv-race/cpu.lock";
  mkdirSync(dirname(lock), { recursive: true });
  const r = spawnSync("flock", [lock, process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, GFV_LOCKED: "1" } });
  if (r.error) throw new Error(`can't take the CPU lock ${lock} with flock: ${r.error.message}`);
  process.exit(r.status ?? 1);
}
