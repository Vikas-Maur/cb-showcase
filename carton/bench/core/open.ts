// Open-time scaling (Stage F4, PLAN §5.4): how long `Carton.open` + the first `head()` take for a project whose main
// cut holds N changes, opening from its newest keyframe ("keyframes") against the same store with every keyframe after
// the root removed, so every row is replayed ("replay"). The two are alternated per run; every run and the medians go to
// the JSON. Cardboard-shaped docs (the P4 generator, 1,000 items), edits like an editing session (renames, moves,
// trims, style), on store-sqlite (carton.db) when it is available, else store-memory (`store` in the output says).
//
// node carton/bench/core/open.ts [N...]      default 1000 10000 30000; RUNS=n (default 5); OUT=<file>
// For the verification phase (verify-ci on GitHub Actions); holds the box's CPU lock locally (GFV_LOCK).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Carton, hashDoc, type Doc, type Op } from "@carton/core";
import type { HostAdapter, Store } from "@carton/core/plugins";
import { createMemoryStore } from "../../packages/store-memory/src/index.ts";
import { cardboard as S, withKeys } from "../../packages/conformance/src/engine/fixtures/cardboard-schema.ts";
import { genDoc, rng, pick } from "../../packages/conformance/src/engine/gen.ts";
import { holdCpuLock, loadGate, machine, median, SCRATCH } from "./util.ts";

holdCpuLock();

const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = SIZES.length ? SIZES : [1000, 10000, 30000];
const RUNS = Number(process.env.RUNS ?? 5);
const adapter: HostAdapter<Doc> = { name: "bench", schema: S, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const ms = (t: number) => Math.round(t * 100) / 100;

/** A store-sqlite file if the package is implemented here, else null (the bench then runs on store-memory). */
async function sqlite(path: string): Promise<Store | null> {
  try {
    const m = (await import("../../packages/store-sqlite/src/index.ts")) as { openSqliteStore(p: string): Promise<Store> };
    return await m.openSqliteStore(path);
  } catch {
    return null;
  }
}

/** The project: one main cut with `n` changes, built in memory through Carton (keyframes as Carton writes them). */
async function build(n: number): Promise<Store> {
  const store = createMemoryStore();
  const doc = withKeys(genDoc(1000, 7));
  const c = await Carton.open({ adapter, store, init: { doc }, actor: { kind: "human", id: "bench" } });
  const r = rng(11);
  const ids = (doc.timelineItems as { id: string; startTime: number; endTime: number }[]).map((x) => x.id);
  for (let i = 1; i <= n; i++) {
    const head = (await c.head()).doc as { timelineItems: { id: string; startTime: number; endTime: number; trimStart?: number }[] };
    const target = pick(r, ids);
    const it = head.timelineItems.find((x) => x.id === target)!;
    const k = i % 4;
    // a trim-in and its way back, so a clip never runs out of source
    const tin = (it.trimStart ?? 0) < 0.05 ? 0.1 : -0.1;
    const ops: Op[] =
      k === 0 ? [{ op: "set", path: ["timelineItems", it.id, "name"], value: `take ${i}` }]
      : k === 1 ? [{ op: "set", path: ["timelineItems", it.id, "startTime"], value: it.startTime + 0.5 }, { op: "set", path: ["timelineItems", it.id, "endTime"], value: it.endTime + 0.5 }]
      : k === 2 ? [{ op: "set", path: ["timelineItems", it.id, "trimStart"], value: (it.trimStart ?? 0) + tin }, { op: "set", path: ["timelineItems", it.id, "startTime"], value: it.startTime + tin }]
      : [{ op: "set", path: ["timelineItems", it.id, "opacity"], value: (i % 10) / 10 }];
    const res = await c.commit({ ops });
    if (res.status !== "confirmed") throw new Error(`change ${i}: ${res.status}`);
  }
  await c.close();
  return store;
}

async function copyInto(from: Store, to: Store, dropKeyframes: boolean): Promise<void> {
  const data = (from as unknown as { data: { tables: Map<string, unknown> } }).data;
  for (const t of data.tables.keys()) {
    let rows = await from.range(t);
    if (dropKeyframes && t === "keyframes") rows = rows.filter((e) => (e.key[1] as number) === 0);
    for (let i = 0; i < rows.length; i += 2000) await to.write(rows.slice(i, i + 2000).map((e) => ({ table: t, key: e.key, value: e.value })));
  }
}

const cells: unknown[] = [];
const loads: unknown[] = [];
const out = { machine: machine(), runs: RUNS, started: new Date().toISOString(), cells, loads };
const dir = mkdtempSync(join(tmpdir(), "carton-open-"));
try {
  for (const n of sizes) {
    const built = await build(n);
    const files = { keyframes: join(dir, `kf-${n}.db`), replay: join(dir, `replay-${n}.db`) };
    const probe = await sqlite(files.keyframes);
    const kind = probe ? "store-sqlite" : "store-memory";
    const stores: Record<"keyframes" | "replay", () => Promise<Store>> = { keyframes: async () => createMemoryStore(), replay: async () => createMemoryStore() };
    if (probe) {
      await copyInto(built, probe, false);
      const r = (await sqlite(files.replay))!;
      await copyInto(built, r, true);
      stores.keyframes = async () => (await sqlite(files.keyframes))!;
      stores.replay = async () => (await sqlite(files.replay))!;
    } else {
      // in memory, a fresh copy per run (opening must not find another handle's caches)
      stores.keyframes = async () => {
        const s = createMemoryStore();
        await copyInto(built, s, false);
        return s;
      };
      stores.replay = async () => {
        const s = createMemoryStore();
        await copyInto(built, s, true);
        return s;
      };
    }
    const runs: Record<string, number[]> = { keyframes: [], replay: [] };
    const heads = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      for (const which of (i % 2 ? ["replay", "keyframes"] : ["keyframes", "replay"]) as ("keyframes" | "replay")[]) {
        const store = await stores[which]();
        const load = loadGate();
        const t0 = performance.now();
        const c = await Carton.open({ adapter, store });
        const head = await c.head();
        runs[which]!.push(ms(performance.now() - t0));
        heads.add(hashDoc(head.doc, S));
        await c.close();
        loads.push({ n, which, ...load });
      }
    }
    if (heads.size !== 1) throw new Error(`n=${n}: the two opens disagree on the head`);
    const cell = { n, store: kind, keyframes: { runs: runs.keyframes, median: median(runs.keyframes!) }, replay: { runs: runs.replay, median: median(runs.replay!) } };
    cells.push(cell);
    console.log(`n=${n} (${kind})  keyframes: ${cell.keyframes.runs.join(" ")}  median ${cell.keyframes.median} ms | replay: ${cell.replay.runs.join(" ")}  median ${cell.replay.median} ms`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const file = process.env.OUT || join(SCRATCH, "raw", `open-${sizes.join("-")}.json`);
mkdirSync(join(file, ".."), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}`);
