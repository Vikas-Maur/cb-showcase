// A test stand-in for `@carton/store-sqlite` until the stores package lands: the Store contract on node:sqlite, shared
// by real processes (WAL, BEGIN IMMEDIATE for conditional batches, a busy timeout). Values are JSON text; ranges are
// filtered and ordered in JS, which is fine for the small tables these tests use.
import { DatabaseSync } from "node:sqlite";
import type { Store, StoreCondition, StoreKey, StoreRange, StoreWrite } from "@carton/core/plugins";

export function compareKeys(a: StoreKey, b: StoreKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

export interface TestSqliteStore extends Store {
  readonly path: string;
  readonly db: DatabaseSync;
}

export function openTestStore(path: string): TestSqliteStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  db.exec("CREATE TABLE IF NOT EXISTS kv (tbl TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tbl, k)) WITHOUT ROWID");
  const qGet = db.prepare("SELECT v FROM kv WHERE tbl = ? AND k = ?");
  const qAll = db.prepare("SELECT k, v FROM kv WHERE tbl = ?");
  const qPut = db.prepare("INSERT OR REPLACE INTO kv (tbl, k, v) VALUES (?, ?, ?)");
  const qDel = db.prepare("DELETE FROM kv WHERE tbl = ? AND k = ?");
  const get = (table: string, key: StoreKey): unknown => {
    const r = qGet.get(table, JSON.stringify(key)) as { v: string } | undefined;
    return r ? JSON.parse(r.v) : undefined;
  };
  let closed = false;
  return {
    path,
    db,
    info: { kind: "sqlite-test", persistent: true, multiProcess: true },
    async get<T>(table: string, key: StoreKey) { return get(table, key) as T | undefined; },
    async range<T>(table: string, r: StoreRange = {}) {
      const rows = (qAll.all(table) as { k: string; v: string }[]).map((x) => ({ key: JSON.parse(x.k) as StoreKey, value: JSON.parse(x.v) as T }));
      const p = r.prefix ?? [];
      let out = rows.filter((x) => p.every((e, i) => x.key[i] === e));
      if (r.gt) out = out.filter((x) => compareKeys(x.key, r.gt!) > 0);
      if (r.gte) out = out.filter((x) => compareKeys(x.key, r.gte!) >= 0);
      if (r.lt) out = out.filter((x) => compareKeys(x.key, r.lt!) < 0);
      if (r.lte) out = out.filter((x) => compareKeys(x.key, r.lte!) <= 0);
      out.sort((x, y) => compareKeys(x.key, y.key));
      if (r.reverse) out.reverse();
      return r.limit !== undefined ? out.slice(0, r.limit) : out;
    },
    async write(writes: readonly StoreWrite[], conditions: readonly StoreCondition[] = []) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const c of conditions) {
          const cur = get(c.table, c.key);
          const ok = c.expect === "absent" ? cur === undefined : c.expect === "present" ? cur !== undefined : cur !== undefined && canonical(cur) === canonical(c.expect.equals);
          if (!ok) { db.exec("ROLLBACK"); return false; }
        }
        for (const w of writes) {
          if (w.value === undefined) qDel.run(w.table, JSON.stringify(w.key));
          else qPut.run(w.table, JSON.stringify(w.key), JSON.stringify(w.value));
        }
        db.exec("COMMIT");
        return true;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      }
    },
    async close() { if (!closed) { closed = true; db.close(); } },
  };
}
