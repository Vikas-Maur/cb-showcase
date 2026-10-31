// One timed measurement, in a fresh process; prints one JSON line.
//   open <file>                     open carton.db and read what opening a project needs: meta, cuts, the cut's head,
//                                   its newest keyframe at or below head, and the changes after that keyframe
//   commit <file> <n> <durability>  n local-sequencer commits: read head, then the conditional append of
//                                   [changes, ids]; per-commit latency and write-lock hold (then the rows are removed)
//   readlog <file>                  the whole log of the cut in one range, and the newest 1000 changes
import { openSqliteStore } from "../src/index.ts";
import { change } from "./fixture.ts";

const [mode, file, ...rest] = process.argv.slice(2);
const cut = "c0ffee00c0ffee00";
const ms = (t0: number) => performance.now() - t0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

if (mode === "open") {
  const t0 = performance.now();
  const s = await openSqliteStore(file);
  const tOpen = ms(t0);
  const t1 = performance.now();
  await s.get("meta", ["projectId"]);
  await s.range("cuts");
  const top = await s.range("changes", { prefix: [cut], reverse: true, limit: 1 });
  const head = top[0].key[1] as number;
  const kf = await s.range<object>("keyframes", { prefix: [cut], lte: [cut, head], reverse: true, limit: 1 });
  const kfSeq = kf[0].key[1] as number;
  const tail = await s.range("changes", { prefix: [cut], gt: [cut, kfSeq] });
  const tRead = ms(t1);
  await s.close();
  console.log(JSON.stringify({ mode, head, keyframeSeq: kfSeq, tail: tail.length, openMs: r3(tOpen), readMs: r3(tRead), totalMs: r3(tOpen + tRead) }));
} else if (mode === "commit") {
  const n = Number(rest[0]);
  const s = await openSqliteStore(file, { durability: rest[1] === "full" ? "full" : "normal" });
  const start = (await s.range("changes", { prefix: [cut], reverse: true, limit: 1 }))[0].key[1] as number;
  const lat: number[] = [], lock: number[] = [];
  const WARM = 100;
  for (let i = 0; i < WARM + n; i++) {
    const t0 = performance.now();
    const top = await s.range("changes", { prefix: [cut], reverse: true, limit: 1 });
    const seq = (top[0].key[1] as number) + 1;
    const c = change(seq, cut);
    const ok = await s.write([{ table: "changes", key: [cut, seq], value: c }, { table: "ids", key: [c.id + ".b"], value: [cut, seq] }], [{ table: "changes", key: [cut, seq], expect: "absent" }]);
    const t = ms(t0);
    if (!ok) throw new Error("lost a race in a single-writer benchmark");
    if (i >= WARM) {
      lat.push(t);
      lock.push(s.db.lastLockMs);
    }
  }
  // Put the file back as it was, untimed, so every run starts from the same size.
  const added = (await s.range("changes", { prefix: [cut], gt: [cut, start] })) as { key: (string | number)[]; value: { id: string } }[];
  await s.write(added.flatMap((r) => [{ table: "changes", key: r.key, value: undefined }, { table: "ids", key: [r.value.id + ".b"], value: undefined }]));
  await s.close();
  console.log(JSON.stringify({ mode, durability: rest[1], startHead: start, n, p50: r3(pct(lat, 0.5)), p90: r3(pct(lat, 0.9)), p99: r3(pct(lat, 0.99)), max: r3(Math.max(...lat)), lockP50: r3(pct(lock, 0.5)), lockP99: r3(pct(lock, 0.99)), lockMax: r3(Math.max(...lock)), mean: r3(lat.reduce((a, b) => a + b, 0) / lat.length) }));
} else if (mode === "readlog") {
  const s = await openSqliteStore(file);
  const t0 = performance.now();
  const all = await s.range("changes", { prefix: [cut] });
  const tAll = ms(t0);
  const t1 = performance.now();
  const last = await s.range("changes", { prefix: [cut], reverse: true, limit: 1000 });
  const tLast = ms(t1);
  await s.close();
  console.log(JSON.stringify({ mode, rows: all.length, allMs: r3(tAll), rowsPerS: Math.round(all.length / (tAll / 1000)), last1000Ms: r3(tLast), lastRows: last.length }));
} else throw new Error(`unknown mode ${mode}`);
