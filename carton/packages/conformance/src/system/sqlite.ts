// node:sqlite behind the SequencerStorage contract: the default storage for the system suite in Node (`server-node`
// uses the same engine). Statements are cached; rows read and written are counted for the P5 accounting.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SequencerStorage, SqlValue } from "@carton/core/plugins";

export function sqliteStorage(path = ":memory:"): SequencerStorage & { db: DatabaseSync; close(): void } {
  const db = new DatabaseSync(path);
  const stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  let read = 0, written = 0, depth = 0;
  return {
    db,
    exec<R>(sql: string, ...params: SqlValue[]): R[] {
      let st = stmts.get(sql);
      if (!st) stmts.set(sql, (st = db.prepare(sql)));
      if (/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(sql)) {
        const r = st.run(...(params as SQLInputValue[]));
        written += Number(r.changes);
        return [];
      }
      const rows = st.all(...(params as SQLInputValue[])) as R[];
      read += rows.length;
      return rows;
    },
    transaction<T>(fn: () => T): T {
      if (depth++ > 0) {
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    stats: () => ({ rowsRead: read, rowsWritten: written }),
    close: () => db.close(),
  };
}
