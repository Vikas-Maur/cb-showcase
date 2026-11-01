// `ctx.storage` as a Durable Object gives it, emulated on node:sqlite, so suites that need a fresh database
// synchronously (the system suite builds one per simulated world) can run doSqlStorage outside workerd. It keeps
// what matters to the adapter: BLOBs come back as ArrayBuffer, BLOB bindings arrive as ArrayBuffer, cursors count
// rowsRead/rowsWritten, explicit BEGIN/COMMIT is refused (a DO only has transactionSync), and transactionSync nests.
// The real runtime is checked by the storage checks, host suites and live sync inside wrangler dev.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DurableObjectStorage, SqlStorageCursor } from "../src/cf.ts";

export function emulatedDoStorage(): DurableObjectStorage {
  const db = new DatabaseSync(":memory:");
  const cache = new Map<string, { st: ReturnType<DatabaseSync["prepare"]>; rows: boolean }>();
  let depth = 0;
  const toNode = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v) as SQLInputValue;
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) throw new Error("use ctx.storage.transactionSync() instead of SQL transaction statements");
      for (const b of bindings) if (b instanceof Uint8Array) throw new Error("emulation: the adapter should bind BLOBs as ArrayBuffer");
      let p = cache.get(query);
      if (!p) {
        const st = db.prepare(query);
        p = { st, rows: st.columns().length > 0 };
        cache.set(query, p);
      }
      let rows: T[] = [], rowsRead = 0, rowsWritten = 0;
      if (p.rows) {
        rows = (p.st.all(...bindings.map(toNode)) as Record<string, unknown>[]).map((r) => {
          const o: Record<string, unknown> = {};
          for (const k in r) o[k] = r[k] instanceof Uint8Array ? (r[k] as Uint8Array).slice().buffer : r[k];
          return o as T;
        });
        rowsRead = rows.length;
      } else rowsWritten = Number(p.st.run(...bindings.map(toNode)).changes);
      return { toArray: () => rows, rowsRead, rowsWritten, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
    get databaseSize() {
      return 0;
    },
  };
  return {
    sql,
    transactionSync<T>(fn: () => T): T {
      const name = `t${depth}`;
      db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
      depth++;
      try {
        const v = fn();
        depth--;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
        return v;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}
