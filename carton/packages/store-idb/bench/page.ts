// Runs inside the benchmark page (headless Chromium): the same cells as store-sqlite's bench, on IndexedDB.
import { openIdbStore } from "../src/index.ts";
import { change, doc } from "../../store-sqlite/bench/fixture.ts";

const CUT = "c0ffee00c0ffee00";
const KF = 64;
const ms = (t0: number) => performance.now() - t0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function gen(id: string, n: number, kfItems: number): Promise<object> {
  const s = await openIdbStore(id);
  const kf = doc(kfItems);
  await s.write([
    { table: "meta", key: ["projectId"], value: "bench-project" },
    { table: "cuts", key: [CUT], value: { id: CUT, name: "Main cut", forkOf: null, owner: "ana", kind: "main", protected: false } },
    { table: "keyframes", key: [CUT, 0], value: kf },
  ]);
  for (let seq = 1; seq <= n; seq += 1000) {
    const ws = [];
    for (let i = seq; i < Math.min(seq + 1000, n + 1); i++) {
      const c = change(i, CUT);
      ws.push({ table: "changes", key: [CUT, i], value: c }, { table: "ids", key: [c.id], value: [CUT, i] });
      if (i % KF === 0) ws.push({ table: "keyframes", key: [CUT, i], value: kf });
    }
    await s.write(ws);
  }
  await s.close();
  const est = await navigator.storage.estimate();
  return { id, changes: n, keyframeItems: kfItems, usageBytes: est.usage };
}

export async function open(id: string): Promise<object> {
  const t0 = performance.now();
  const s = await openIdbStore(id);
  const tOpen = ms(t0);
  const t1 = performance.now();
  await s.get("meta", ["projectId"]);
  await s.range("cuts");
  const top = await s.range("changes", { prefix: [CUT], reverse: true, limit: 1 });
  const head = top[0].key[1] as number;
  const kf = await s.range("keyframes", { prefix: [CUT], lte: [CUT, head], reverse: true, limit: 1 });
  const kfSeq = kf[0].key[1] as number;
  const tail = await s.range("changes", { prefix: [CUT], gt: [CUT, kfSeq] });
  const tRead = ms(t1);
  await s.close();
  return { mode: "open", head, keyframeSeq: kfSeq, tail: tail.length, openMs: r3(tOpen), readMs: r3(tRead), totalMs: r3(tOpen + tRead) };
}

export async function commit(id: string, n: number, durability: "relaxed" | "strict"): Promise<object> {
  const s = await openIdbStore(id, { durability });
  const start = (await s.range("changes", { prefix: [CUT], reverse: true, limit: 1 }))[0].key[1] as number;
  const lat: number[] = [];
  const WARM = 50;
  for (let i = 0; i < WARM + n; i++) {
    const t0 = performance.now();
    const top = await s.range("changes", { prefix: [CUT], reverse: true, limit: 1 });
    const seq = (top[0].key[1] as number) + 1;
    const c = change(seq, CUT);
    const ok = await s.write([{ table: "changes", key: [CUT, seq], value: c }, { table: "ids", key: [c.id + ".b"], value: [CUT, seq] }], [{ table: "changes", key: [CUT, seq], expect: "absent" }]);
    if (!ok) throw new Error("lost a race in a single-writer benchmark");
    if (i >= WARM) lat.push(ms(t0));
  }
  const added = (await s.range<{ id: string }>("changes", { prefix: [CUT], gt: [CUT, start] }));
  await s.write(added.flatMap((r) => [{ table: "changes", key: r.key, value: undefined }, { table: "ids", key: [r.value.id + ".b"], value: undefined }]));
  await s.close();
  return { mode: "commit", durability, startHead: start, n, p50: r3(pct(lat, 0.5)), p90: r3(pct(lat, 0.9)), p99: r3(pct(lat, 0.99)), max: r3(Math.max(...lat)), mean: r3(lat.reduce((a, b) => a + b, 0) / lat.length) };
}

export async function readlog(id: string): Promise<object> {
  const s = await openIdbStore(id);
  const t0 = performance.now();
  const all = await s.range("changes", { prefix: [CUT] });
  const tAll = ms(t0);
  const t1 = performance.now();
  const last = await s.range("changes", { prefix: [CUT], reverse: true, limit: 1000 });
  const tLast = ms(t1);
  await s.close();
  return { mode: "readlog", rows: all.length, allMs: r3(tAll), rowsPerS: Math.round(all.length / (tAll / 1000)), last1000Ms: r3(tLast), lastRows: last.length };
}
