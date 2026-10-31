// node:sqlite as SequencerStorage (PLAN §6.3): one database file per project, the same §6.3 DDL the Durable Object
// runs. Synchronous, like the DO's `ctx.storage.sql`, and the sequencer's check-then-append relies on that.
//
// - WAL, and `synchronous = FULL` by default: an ack tells a client its change is confirmed, so the commit must
//   reach the disk before the ack leaves (NORMAL can lose the last commits on power loss; it is an option for
//   tests and throwaway servers).
// - Statements are prepared once and cached per SQL string; whether one returns rows is decided once, from its
//   column list.
// - `transaction` is BEGIN IMMEDIATE … COMMIT, re-entrant (an inner call joins the outer transaction), and rolls back
//   everything on a throw.
// - Counts: rows written are SQLite's `changes`; rows read are rows returned (node:sqlite has no rows-read counter,
//   so this undercounts scans, unlike the DO's billed `rowsRead`).
// - One process owns a file (server-node keeps one handle per project). `busy_timeout` covers an outside reader,
//   such as a backup tool, holding a lock briefly.

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import type { SequencerStorage, SqlValue } from "@carton/core/plugins";

export interface NodeSqliteOptions {
  durability?: "full" | "normal";
}

export type NodeSqliteStorage = SequencerStorage & { stats(): { rowsRead: number; rowsWritten: number }; close(): void; readonly db: DatabaseSync };

export function nodeSqliteStorage(path: string, opts: NodeSqliteOptions = {}): NodeSqliteStorage {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${opts.durability === "normal" ? "NORMAL" : "FULL"}`);
  }
  db.exec("PRAGMA busy_timeout = 2000");
  const cache = new Map<string, { st: StatementSync; rows: boolean }>();
  let rowsRead = 0, rowsWritten = 0, depth = 0;

  const prepared = (sql: string) => {
    let p = cache.get(sql);
    if (!p) {
      const st = db.prepare(sql);
      p = { st, rows: st.columns().length > 0 };
      cache.set(sql, p);
    }
    return p;
  };

  return {
    db,
    exec<R extends Record<string, SqlValue> = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): R[] {
      const p = prepared(sql);
      const args = params as SQLInputValue[];
      if (p.rows) {
        const rows = p.st.all(...args) as R[];
        rowsRead += rows.length;
        return rows;
      }
      rowsWritten += Number(p.st.run(...args).changes);
      return [];
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw e;
      } finally {
        depth = 0;
      }
    },
    stats() {
      return { rowsRead, rowsWritten };
    },
    close() {
      cache.clear();
      if (db.isOpen) db.close();
    },
  };
}
