// head() cost, builds against each other: one process, each build its own module instance loaded from its own checkout,
// the builds interleaved and their order reversed every other run.
//
//   node --expose-gc carton/bench/core/head.ts <name>=<carton dir> [<name>=<carton dir> ...]
//
// Each <carton dir> is the `carton/` folder of a checkout with its dependencies installed (`npm ci` there): the bench
// imports that checkout's packages/core, store-memory and the conformance generator from it, and `@carton/core` inside
// it resolves through its own node_modules. Run it from any checkout. The builds compared for the freeze of documents
// handed out (a2d2f04, CONTRACTS "Documents are values"):
//
//   git worktree add /tmp/a fd07cc8 && git worktree add /tmp/c <commit>   # before the freeze; the commit under test
//   (cd /tmp/a/carton && npm ci) && (cd /tmp/c/carton && npm ci)
//   node --expose-gc /tmp/c/carton/bench/core/head.ts A=/tmp/a/carton C=/tmp/c/carton
//
// env: N (items, default "1000,10000"), RUNS (7), CALLS (200), OUT (the JSON, default ./head-bench-<ms>.json). On the
// shared dev box, hold the CPU lock for the whole run: `flock /tmp/gfv-race/cpu.lock node --expose-gc …`.
//
// Per size and build: a local cut opened on genDoc(N, 42) (the P4 bench's Cardboard-shaped generator, engine keys), 20
// commits made (so the live head is the sequencer's), 30 warm-up rounds, then per run:
//   "repeat": CALLS head() calls in a row, no commit between: the materializer's and the UI's hot path;
//   "after-commit": CALLS times (commit one rename, untimed; one head(), timed): the first call on a new state.
// It prints ms per call for every run and the median, with the 1-minute load before and after each size; the JSON has
// the same plus node, the CPU model and count, and the build dirs.
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc");
const builds = process.argv.slice(2).map((a) => {
  const i = a.indexOf("=");
  if (i < 1) throw new Error(`a build is <name>=<carton dir>, not ${a}`);
  return { name: a.slice(0, i), root: resolve(a.slice(i + 1)) };
});
if (!builds.length) throw new Error("usage: node --expose-gc head.ts <name>=<carton dir> [<name>=<carton dir> ...]");
const SIZES = (process.env.N ?? "1000,10000").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 7);
const CALLS = Number(process.env.CALLS ?? 200);
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function load(root: string) {
  const u = (p: string) => pathToFileURL(`${root}/${p}`).href;
  const core: Any = await import(u("packages/core/src/index.ts"));
  const mem: Any = await import(u("packages/store-memory/src/index.ts"));
  const fx: Any = await import(u("packages/conformance/src/engine/fixtures/cardboard-schema.ts"));
  const gen: Any = await import(u("packages/conformance/src/engine/gen.ts"));
  return { core, mem, fx, gen };
}

const mods = await Promise.all(builds.map((b) => load(b.root)));
const out: Any = { when: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, ncpu: cpus().length, RUNS, CALLS, builds, rows: [] };

for (const N of SIZES) {
  const cartons: Any[] = [];
  const ids: string[][] = [];
  for (const m of mods) {
    const S = m.fx.cardboard;
    const adapter = { name: "bench", schema: S, schemaVersion: 1, fromHost: (h: unknown) => h, toHost: (d: unknown) => d };
    const doc = m.fx.withKeys(m.gen.genDoc(N, 42));
    const c = await m.core.Carton.open({ adapter, store: m.mem.createMemoryStore(), init: { doc }, actor: { kind: "human", id: "bench" } });
    const list = (doc.timelineItems as { id: string }[]).map((x) => x.id);
    for (let i = 0; i < 20; i++) await c.commit({ ops: [{ op: "set", path: ["timelineItems", list[i % list.length], "name"], value: `warm ${i}` }] });
    cartons.push(c);
    ids.push(list);
  }
  let k = 0;
  const rename = (bi: number) => cartons[bi].commit({ ops: [{ op: "set", path: ["timelineItems", ids[bi]![k++ % ids[bi]!.length], "name"], value: `edit ${k}` }] });
  for (let bi = 0; bi < builds.length; bi++)
    for (let i = 0; i < 30; i++) {
      await cartons[bi].head();
      await rename(bi);
    }
  const runs: Record<string, { repeat: number[]; afterCommit: number[] }> = {};
  for (const b of builds) runs[b.name] = { repeat: [], afterCommit: [] };
  const load0 = loadavg()[0]!;
  for (let r = 0; r < RUNS; r++) {
    const order = builds.map((_, i) => i);
    if (r % 2) order.reverse();
    for (const bi of order) {
      const c = cartons[bi];
      gc();
      let t = performance.now();
      for (let i = 0; i < CALLS; i++) await c.head();
      runs[builds[bi]!.name]!.repeat.push((performance.now() - t) / CALLS);
      gc();
      let sum = 0;
      for (let i = 0; i < CALLS; i++) {
        await rename(bi);
        t = performance.now();
        await c.head();
        sum += performance.now() - t;
      }
      runs[builds[bi]!.name]!.afterCommit.push(sum / CALLS);
    }
  }
  const load1 = loadavg()[0]!;
  const row: Any = { N, load: [load0, load1], builds: {} };
  console.log(`\nN=${N} items  load ${load0.toFixed(2)} -> ${load1.toFixed(2)}  (ms per head() call, ${RUNS} runs x ${CALLS} calls)`);
  for (const b of builds) {
    const x = runs[b.name]!;
    row.builds[b.name] = { repeat: { runs: x.repeat, median: med(x.repeat) }, afterCommit: { runs: x.afterCommit, median: med(x.afterCommit) } };
    const f = (xs: number[]) => xs.map((v) => v.toFixed(4)).join(" ");
    console.log(`  ${b.name.padEnd(12)} repeat       median ${med(x.repeat).toFixed(4)}   runs ${f(x.repeat)}`);
    console.log(`  ${"".padEnd(12)} after-commit median ${med(x.afterCommit).toFixed(4)}   runs ${f(x.afterCommit)}`);
  }
  out.rows.push(row);
  for (const c of cartons) await c.close();
}
const file = process.env.OUT ?? `head-bench-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nraw: ${file}`);
