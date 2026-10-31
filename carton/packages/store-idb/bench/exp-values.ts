// In-page A/B for store-idb's value format: structured clones against JSON strings (what IdbStore stores), on 10k
// changes. Measures writing them (batches of 1000), reading them all back with getAll, and one small commit.
import { change } from "../../store-sqlite/bench/fixture.ts";

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

export async function run(n = 10000, rounds = 7): Promise<object> {
  const name = `exp-${Date.now()}`;
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("obj"); r.result.createObjectStore("str"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rows = Array.from({ length: n }, (_, i) => change(i + 1));
  const out: Record<string, number[]> = { writeObj: [], writeStr: [], readObj: [], readStr: [], commitObj: [], commitStr: [] };
  for (let r = 0; r < rounds; r++) {
    for (const kind of r % 2 ? ["str", "obj"] : ["obj", "str"]) {
      let t = performance.now();
      for (let i = 0; i < n; i += 1000) {
        const tx = db.transaction(kind, "readwrite", { durability: "relaxed" });
        const s = tx.objectStore(kind);
        for (let j = i; j < i + 1000; j++) s.put(kind === "str" ? JSON.stringify(rows[j]) : rows[j], ["changes", "c", j + 1]);
        await done(tx);
      }
      out[kind === "str" ? "writeStr" : "writeObj"].push(performance.now() - t);
      t = performance.now();
      const tx = db.transaction(kind, "readonly");
      const vals = await req(tx.objectStore(kind).getAll(IDBKeyRange.bound(["changes", "c"], ["changes", "c", []])));
      if (kind === "str") for (let j = 0; j < vals.length; j++) vals[j] = JSON.parse(vals[j] as string);
      out[kind === "str" ? "readStr" : "readObj"].push(performance.now() - t);
      t = performance.now();
      for (let c = 0; c < 50; c++) {
        const w = db.transaction(kind, "readwrite", { durability: "relaxed" });
        const v = rows[c];
        w.objectStore(kind).put(kind === "str" ? JSON.stringify(v) : v, ["changes", "d", c]);
        await done(w);
      }
      out[kind === "str" ? "commitStr" : "commitObj"].push((performance.now() - t) / 50);
    }
  }
  db.close();
  indexedDB.deleteDatabase(name);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { median: Math.round(med(v) * 100) / 100, runs: v.map((x) => Math.round(x * 10) / 10) }]));
}
