// Open time, builds against each other (verify-ci F1; PLAN §5.4): Carton.open + the first head() on one store-sqlite
// file per size, each build's Carton loaded from its own checkout, the builds alternated and their order reversed every
// other run. Also timed: open + head() + log({limit: 1}), which waits until the whole history is in memory (a build
// that reads the older rows after open pays them there).
//
//   node carton/bench/core/open-ab.ts <sqlite carton dir> <name>=<carton dir> [<name>=<carton dir> ...]
//
// <sqlite carton dir>: a checkout whose packages/store-sqlite is implemented (one store for every build, so only
// core differs). Each <carton dir> is a checkout's `carton/` with its node_modules. The project: one main cut with N
// changes, Cardboard-shaped (the P4 generator, 1,000 items), edits like an editing session, built through the first
// build's Carton in memory and copied into the file. env: N (default "1000,10000,30000,100000"), RUNS (5), OUT (JSON).
// Holds the box's CPU lock for the whole run (GFV_LOCK).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { holdCpuLock, loadGate, machine, median } from "./util.ts";

holdCpuLock();
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const [sqliteRoot, ...specs] = process.argv.slice(2);
if (!sqliteRoot || !specs.length) throw new Error("usage: open-ab.ts <sqlite carton dir> <name>=<carton dir> ...");
const builds = specs.map((a) => ({ name: a.slice(0, a.indexOf("=")), root: resolve(a.slice(a.indexOf("=") + 1)) }));
const SIZES = (process.env.N ?? "1000,10000,30000,100000").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 5);
const u = (root: string, p: string) => pathToFileURL(`${root}/${p}`).href;
const sqlite: Any = await import(u(resolve(sqliteRoot), "packages/store-sqlite/src/index.ts"));
const mods: Any[] = await Promise.all(builds.map(async (b) => ({ core: await import(u(b.root, "packages/core/src/index.ts")) })));
const first = builds[0]!.root;
const mem: Any = await import(u(first, "packages/store-memory/src/index.ts"));
const fx: Any = await import(u(first, "packages/conformance/src/engine/fixtures/cardboard-schema.ts"));
const gen: Any = await import(u(first, "packages/conformance/src/engine/gen.ts"));
const S = fx.cardboard;
const adapter = { name: "bench", schema: S, schemaVersion: 1, fromHost: (h: unknown) => h, toHost: (d: unknown) => d };
const ms = (t: number) => Math.round(t * 100) / 100;

async function build(n: number): Promise<Any> {
  const store = mem.createMemoryStore();
  const doc = fx.withKeys(gen.genDoc(1000, 7));
  const c = await mods[0].core.Carton.open({ adapter, store, init: { doc }, actor: { kind: "human", id: "bench" } });
  const r = gen.rng(11);
  const ids = (doc.timelineItems as { id: string }[]).map((x) => x.id);
  for (let i = 1; i <= n; i++) {
    const head = (await c.head()).doc as { timelineItems: { id: string; startTime: number; endTime: number; trimStart?: number; trimEnd?: number }[] };
    const target = gen.pick(r, ids);
    const it = head.timelineItems.find((x) => x.id === target)!;
    const k = i % 4;
    const ts = it.trimStart ?? 0,
      te = it.trimEnd ?? it.endTime - it.startTime;
    const tin = ts >= 0.1 && it.startTime >= 0.1 ? -0.1 : it.endTime - it.startTime > 0.2 && te - ts > 0.2 ? 0.1 : 0;
    const P = (f: string, v: unknown) => ({ op: "set", path: ["timelineItems", it.id, f], value: v });
    const ops =
      k === 0 ? [P("name", `take ${i}`)]
      : k === 1 ? [P("startTime", it.startTime + 0.5), P("endTime", it.endTime + 0.5)]
      : k === 2 && tin ? [P("trimStart", ts + tin), P("startTime", it.startTime + tin)]
      : k === 2 ? [P("name", `take ${i}`)]
      : [P("opacity", (i % 10) / 10)];
    const res = await c.commit({ ops });
    if (res.status !== "confirmed") throw new Error(`change ${i}: ${res.status}`);
  }
  await c.close();
  return store;
}

const out: Any = { machine: machine(), runs: RUNS, builds, started: new Date().toISOString(), cells: [] as Any[] };
const dir = mkdtempSync(join(tmpdir(), "carton-open-ab-"));
try {
  for (const n of SIZES) {
    const built = await build(n);
    const file = join(dir, `p-${n}.db`);
    const db = await sqlite.openSqliteStore(file);
    for (const t of built.data.tables.keys()) {
      const rows = await built.range(t);
      for (let i = 0; i < rows.length; i += 2000) await db.write(rows.slice(i, i + 2000).map((e: Any) => ({ table: t, key: e.key, value: e.value })));
    }
    await db.close?.();
    const cell: Any = { n, open: {}, whole: {}, loads: [] };
    for (const b of builds) (cell.open[b.name] = []), (cell.whole[b.name] = []);
    const heads = new Set<string>();
    for (let run = 0; run < RUNS; run++) {
      const order = run % 2 ? [...builds.keys()].reverse() : [...builds.keys()];
      for (const bi of order) {
        const store = await sqlite.openSqliteStore(file);
        const load = loadGate();
        const t0 = performance.now();
        const c = await mods[bi].core.Carton.open({ adapter, store });
        const h = await c.head();
        const t1 = performance.now();
        await c.log({ limit: 1 });
        const t2 = performance.now();
        cell.open[builds[bi]!.name].push(ms(t1 - t0));
        cell.whole[builds[bi]!.name].push(ms(t2 - t0));
        cell.loads.push({ build: builds[bi]!.name, ...load });
        heads.add(mods[bi].core.hashDoc(h.doc, S));
        await c.close();
        await store.close?.();
      }
    }
    if (heads.size !== 1) throw new Error(`n=${n}: the builds disagree on the head`);
    for (const b of builds) (cell.open[b.name] = { runs: cell.open[b.name], median: median(cell.open[b.name]) }), (cell.whole[b.name] = { runs: cell.whole[b.name], median: median(cell.whole[b.name]) });
    out.cells.push(cell);
    for (const b of builds) console.log(`n=${n} ${b.name.padEnd(8)} open+head ${cell.open[b.name].runs.join(" ")}  median ${cell.open[b.name].median} ms | +log(1) ${cell.whole[b.name].runs.join(" ")}  median ${cell.whole[b.name].median} ms`);
    console.log(`  load: ${cell.loads.map((l: Any) => `${l.before}->${l.after}`).join(" ")}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const file = process.env.OUT || join(process.cwd(), `open-ab-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}`);
