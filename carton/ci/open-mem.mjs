// verify-ci's check of route 40 (F4): memory a closed Carton handle keeps, per open/close cycle, on one 100k project.
//
//   node ci/open-mem.mjs make <sqlite carton dir> <carton dir> <file>          build the project into <file>
//   node --expose-gc ci/open-mem.mjs cycles <sqlite carton dir> <name>=<carton dir> <file>
//
// make: the same project as bench/core/open-ab.ts (P4 generator, 1,000 items, N Cardboard-shaped edits on one main
// cut, through <carton dir>'s Carton in memory, copied into a store-sqlite file), so the numbers line up with F4.
// cycles: CYCLES times (default 11), with the process's default heap: open the file with store-sqlite, Carton.open +
// head() (timed), then, with MODE=whole (default), log({limit: 1}) (timed: waits for the whole history), then close the
// handle and the store, then two full GCs and record heapUsed and rss. MODE=head skips log(). One line per cycle, then
// medians and the heap growth from cycle 1 to the last. env: N (100000), CYCLES (11), MODE (whole|head), OUT (JSON).
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [cmd, sqliteRoot, spec, file] = process.argv.slice(2);
if (!["make", "cycles"].includes(cmd) || !sqliteRoot || !spec || !file) throw new Error("usage: open-mem.mjs make|cycles <sqlite carton dir> [<name>=]<carton dir> <file>");
const [name, root] = spec.includes("=") ? [spec.slice(0, spec.indexOf("=")), resolve(spec.slice(spec.indexOf("=") + 1))] : ["build", resolve(spec)];
const u = (r, p) => pathToFileURL(`${r}/${p}`).href;
const sqlite = await import(u(resolve(sqliteRoot), "packages/store-sqlite/src/index.ts"));
const core = await import(u(root, "packages/core/src/index.ts"));
const N = Number(process.env.N ?? 100000);
const ms = (t) => Math.round(t * 100) / 100;
const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

if (cmd === "make") {
  const mem = await import(u(root, "packages/store-memory/src/index.ts"));
  const fx = await import(u(root, "packages/conformance/src/engine/fixtures/cardboard-schema.ts"));
  const gen = await import(u(root, "packages/conformance/src/engine/gen.ts"));
  const adapter = { name: "bench", schema: fx.cardboard, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
  const store = mem.createMemoryStore();
  const doc = fx.withKeys(gen.genDoc(1000, 7));
  const c = await core.Carton.open({ adapter, store, init: { doc }, actor: { kind: "human", id: "bench" } });
  const r = gen.rng(11);
  const ids = doc.timelineItems.map((x) => x.id);
  // the edits of open-ab.ts's build(), unchanged
  for (let i = 1; i <= N; i++) {
    const head = (await c.head()).doc;
    const target = gen.pick(r, ids);
    const it = head.timelineItems.find((x) => x.id === target);
    const k = i % 4;
    const ts = it.trimStart ?? 0,
      te = it.trimEnd ?? it.endTime - it.startTime;
    const tin = ts >= 0.1 && it.startTime >= 0.1 ? -0.1 : it.endTime - it.startTime > 0.2 && te - ts > 0.2 ? 0.1 : 0;
    const P = (f, v) => ({ op: "set", path: ["timelineItems", it.id, f], value: v });
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
  const db = await sqlite.openSqliteStore(file);
  for (const t of store.data.tables.keys()) {
    const rows = await store.range(t);
    for (let i = 0; i < rows.length; i += 2000) await db.write(rows.slice(i, i + 2000).map((e) => ({ table: t, key: e.key, value: e.value })));
  }
  await db.close?.();
  console.log(`made ${file}: N=${N} through ${root}`);
  process.exit(0);
}

if (typeof globalThis.gc !== "function") throw new Error("run with --expose-gc");
const fx = await import(u(root, "packages/conformance/src/engine/fixtures/cardboard-schema.ts"));
const adapter = { name: "bench", schema: fx.cardboard, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const CYCLES = Number(process.env.CYCLES ?? 11);
const MODE = process.env.MODE ?? "whole";
const gc2 = () => (globalThis.gc(), globalThis.gc());
// each cycle opens its own copy of the file, so no cycle reads a WAL another left behind
const rows = [];
gc2();
const base = process.memoryUsage();
for (let i = 1; i <= CYCLES; i++) {
  const f = `${file}.${name}.${i}.db`;
  copyFileSync(file, f);
  const store = await sqlite.openSqliteStore(f);
  const t0 = performance.now();
  const c = await core.Carton.open({ adapter, store });
  await c.head();
  const t1 = performance.now();
  if (MODE === "whole") await c.log({ limit: 1 });
  const t2 = performance.now();
  await c.close();
  await store.close?.();
  for (const x of ["", "-wal", "-shm"]) rmSync(f + x, { force: true });
  gc2();
  const m = process.memoryUsage();
  rows.push({ cycle: i, open: ms(t1 - t0), whole: MODE === "whole" ? ms(t2 - t0) : null, heapMB: mb(m.heapUsed), rssMB: mb(m.rss) });
  const r = rows.at(-1);
  console.log(`${name} ${MODE} cycle ${i}: open+head ${r.open} ms${r.whole != null ? ` | +log(1) ${r.whole} ms` : ""} | after close+gc heapUsed ${r.heapMB} MB rss ${r.rssMB} MB`);
}
const sum = {
  name, mode: MODE, n: N, cycles: CYCLES, baseHeapMB: mb(base.heapUsed),
  open: median(rows.map((r) => r.open)), whole: MODE === "whole" ? median(rows.map((r) => r.whole)) : null,
  heapFirstMB: rows[0].heapMB, heapLastMB: rows.at(-1).heapMB, heapMaxMB: Math.max(...rows.map((r) => r.heapMB)),
};
console.log(`${name} ${MODE} N=${N}: open+head median ${sum.open} ms${sum.whole != null ? ` | +log(1) median ${sum.whole} ms` : ""} | heap after close+gc: before cycles ${sum.baseHeapMB} MB, cycle 1 ${sum.heapFirstMB} MB, cycle ${CYCLES} ${sum.heapLastMB} MB (max ${sum.heapMaxMB}), growth ${Math.round((sum.heapLastMB - sum.heapFirstMB) * 10) / 10} MB`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ ...sum, rows }, null, 1));
