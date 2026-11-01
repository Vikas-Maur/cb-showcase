// A Durable Object's SQLite (`ctx.storage.sql`) as SequencerStorage (PLAN §6.3). Thin on purpose: the sequencer
// writes the SQL; this only adapts types and counts rows.
//
// - BLOB columns come back from the runtime as ArrayBuffer; the contract's SqlValue is Uint8Array.
// - BLOB bindings go in as ArrayBuffer (exactly the view's bytes), and safe-integer bigints as numbers.
// - `transaction` is `transactionSync`: everything inside commits or rolls back as one, and nothing else runs on the
//   object in between (the DO is single-threaded and the function is synchronous).
// - `stats()` sums the cursors' rowsRead/rowsWritten: the numbers Cloudflare bills (P5 measured 1 row written per
//   change, 2 for an insert or remove, on these WITHOUT ROWID tables).

import type { SequencerStorage, SqlValue } from "@carton/core/plugins";
import type { DurableObjectStorage } from "./cf.ts";

function bind(v: SqlValue): unknown {
  if (v instanceof Uint8Array) return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v.buffer : v.slice().buffer;
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`integer ${v} is outside the safe range`);
    return Number(v);
  }
  return v;
}

export function doSqlStorage(storage: DurableObjectStorage): SequencerStorage & { databaseSize(): number } {
  const sql = storage.sql;
  let rowsRead = 0, rowsWritten = 0;
  return {
    exec<R extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): R[] {
      const cursor = sql.exec<Record<string, unknown>>(query, ...params.map(bind));
      const rows = cursor.toArray();
      rowsRead += cursor.rowsRead;
      rowsWritten += cursor.rowsWritten;
      for (const r of rows) for (const k in r) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k] as ArrayBuffer);
      return rows as R[];
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
    stats() {
      return { rowsRead, rowsWritten };
    },
    databaseSize() {
      return sql.databaseSize;
    },
  };
}
