// The Store plug-in on node:sqlite (PLAN §3.1, §6.2): `.carton/carton.db`, shared by every process on the machine.
//
// Each Carton table (core's STORE_TABLES: changes, cuts, keyframes, pins, lease…) is one SQLite table
// `(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`: the key encoded so that SQLite's text order is the contract's key
// order (key.ts), the value as JSON text, or compressed when it is large (value.ts). Every `range` is then one primary-key range read, and a row costs one B-tree
// entry (no rowid index, as in the DO's DDL, §6.3).
//
// `write` is the cross-process compare-and-swap: conditions are checked and writes applied inside one
// BEGIN IMMEDIATE, which also serializes it against every other process (P3). Waiting for another process's lock is
// asynchronous (db.ts), so it never blocks the event loop for more than a few milliseconds (P3b).

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { canonical } from "@carton/core";
import type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite } from "@carton/core/plugins";
import { Db, type DbOptions } from "./db.ts";
import { encodeKey, decodeKey, prefixEnd } from "./key.ts";
import { encodeValue, decodeValue } from "./value.ts";
import { MovedError } from "./move.ts";
import { APPLICATION_ID, FORMAT_VERSION, META, MOVED_TO, DB_ID, MACHINE, USER_TABLES, machineMark, isThisMachine, readMeta, writeMeta, newDbId } from "./format.ts";


export interface SqliteStoreOptions extends DbOptions {}

type Row = [string, string | Uint8Array];

export class SqliteStore implements Store {
  readonly info: StoreInfo = { kind: "sqlite", persistent: true, multiProcess: true };
  readonly path: string;
  readonly db: Db;
  /** Tables known to exist. Absence is never cached: another process may create a table at any time. */
  readonly #tables = new Set<string>();
  /** Tables the write transaction in progress created: they exist only if it commits, so they join #tables after. */
  #creating: Set<string> | null = null;
  readonly #listeners = new Set<(tables: readonly string[]) => void>();

  private constructor(db: Db) {
    this.db = db;
    this.path = db.path;
  }

  /** Open (creating if needed) the store at a carton.db path. */
  static async open(file: string, opts: SqliteStoreOptions = {}): Promise<SqliteStore> {
    if (!opts.readOnly) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = await Db.open(file, opts, (raw) => identify(raw, file));
    try {
      await init(db, !!opts.readOnly);
      // History that moved to another placement (§6.4) is read there; this file only says where.
      const moved = opts.readOnly ? undefined : await db.read(() => readMeta<{ path: string }>(db.raw, MOVED_TO));
      if (moved) throw new MovedError(file, moved.path);
      return new SqliteStore(db);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  get<T = unknown>(table: string, key: StoreKey): Promise<T | undefined> {
    const t = tableName(table);
    const k = encodeKey(key);
    return this.db.read(() => {
      if (!this.#exists(t)) return undefined;
      const row = this.db.stmt(`SELECT v FROM "${t}" WHERE k = ?`).get(k) as { v: string | Uint8Array } | undefined;
      return row === undefined ? undefined : (decodeValue(row.v) as T);
    });
  }

  range<T = unknown>(table: string, r: StoreRange = {}): Promise<{ key: StoreKey; value: T }[]> {
    const t = tableName(table);
    // A limit counts whole rows: 2.7 reads 2, and anything below 1 reads none (as in every store).
    const limit = r.limit === undefined ? undefined : Math.floor(r.limit);
    if (limit !== undefined && !(limit >= 1)) return Promise.resolve([]);
    // The SQL text says which bounds are present, so each shape of query is prepared once and cached.
    const args: (string | number)[] = [];
    let where = "";
    const bound = (op: string, v: string) => {
      where += (where ? " AND " : " WHERE ") + `k ${op} ?`;
      args.push(v);
    };
    if (r.prefix) {
      bound(">=", encodeKey(r.prefix));
      bound("<", prefixEnd(r.prefix));
    }
    if (r.gt) bound(">", encodeKey(r.gt));
    if (r.gte) bound(">=", encodeKey(r.gte));
    if (r.lt) bound("<", encodeKey(r.lt));
    if (r.lte) bound("<=", encodeKey(r.lte));
    let sql = `SELECT k, v FROM "${t}"${where} ORDER BY k${r.reverse ? " DESC" : ""}`;
    if (limit !== undefined) {
      sql += " LIMIT ?";
      args.push(limit);
    }
    return this.db.read(() => {
      if (!this.#exists(t)) return [];
      const stmt = this.db.stmt(sql);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...args) as unknown as Row[];
      const out = new Array<{ key: StoreKey; value: T }>(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][1];
        out[i] = { key: decodeKey(rows[i][0]), value: (typeof v === "string" ? JSON.parse(v) : decodeValue(v)) as T };
      }
      return out;
    });
  }

  async write(writes: readonly StoreWrite[], conditions: readonly StoreCondition[] = []): Promise<boolean> {
    // Encode and serialize before taking the lock: it is held only for the checks and the inserts (§6.2).
    const conds = conditions.map((c) => ({ t: tableName(c.table), k: encodeKey(c.key), expect: c.expect }));
    const ops: { t: string; k: string; v: string | Uint8Array | undefined }[] = [];
    for (const w of writes) ops.push({ t: tableName(w.table), k: encodeKey(w.key), v: w.value === undefined ? undefined : await encodeValue(w.value) });
    const created = new Set<string>();
    let ok: boolean;
    try {
      ok = await this.db.write(() => {
        created.clear(); // a retried attempt starts from a rolled-back state
        this.#creating = created;
        // Another process moved this history (the project changed placement): never write into the abandoned copy.
        const moved = this.db.stmt(`SELECT v FROM "${META}" WHERE k = ?`).get(MOVED_TO) as { v: string } | undefined;
        if (moved) throw new MovedError(this.path, (JSON.parse(moved.v) as { path: string }).path);
        for (const c of conds) if (!this.#holds(c.t, c.k, c.expect)) return false;
        for (const w of ops) {
          if (w.v === undefined) {
            if (this.#exists(w.t)) this.db.stmt(`DELETE FROM "${w.t}" WHERE k = ?`).run(w.k);
          } else {
            this.#create(w.t);
            this.db.stmt(`INSERT INTO "${w.t}"(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(w.k, w.v);
          }
        }
        return true;
      });
    } finally {
      this.#creating = null;
    }
    // Committed: the tables it created exist for everyone now.
    for (const t of created) this.#tables.add(t);
    if (ok && this.#listeners.size) notify(this.#listeners, [...new Set(writes.map((w) => w.table))]);
    return ok;
  }

  watch(listener: (tables: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
    this.db.close();
  }

  /**
   * Copy the store to `toPath` for a full-history `.cbproj` (§13), without the tables in `dropTables` (core's
   * LOCAL_TABLES: path map, pins, notices, ephemeral data, sync lease). Those tables are never written into the copy
   * at all, so no absolute path or user name can survive in its free pages. The copy is one consistent snapshot, made
   * through a separate connection in batches, so the event loop keeps running and other writers are never blocked.
   * It appears at `toPath` only when complete. `toPath` must not exist yet: the copy is published with a call that
   * refuses to replace anything (a hard link, or an exclusive copy where there are none), because replacing a file
   * that a process has open leaves its -wal behind, which SQLite would replay into the copy (bringing dropped tables
   * back), and checking first then renaming would race with that process.
   */
  async exportCopy(toPath: string, dropTables: readonly string[]): Promise<void> {
    if (sameFile(toPath, this.path)) throw new Error(`exportCopy: ${toPath} is this store's own database`);
    const busy = () => [toPath, `${toPath}-wal`, `${toPath}-shm`, `${toPath}-journal`].find((f) => fs.existsSync(f));
    if (busy()) throw new Error(`exportCopy: ${busy()} already exists; remove it first`);
    const drop = new Set(dropTables.map(tableName));
    const tmp = `${toPath}.part-${process.pid}-${Date.now().toString(36)}`;
    fs.mkdirSync(path.dirname(path.resolve(toPath)), { recursive: true });
    fs.rmSync(tmp, { force: true });
    // Read-write: an attached database opens with its connection's flags, and the copy is written.
    const src = new DatabaseSync(this.path, { timeout: 3 });
    try {
      src.prepare("ATTACH DATABASE ? AS x").run(tmp);
      src.exec(`PRAGMA x.auto_vacuum=INCREMENTAL; PRAGMA x.application_id=${APPLICATION_ID}; PRAGMA x.user_version=${FORMAT_VERSION}`);
      src.exec("BEGIN"); // the snapshot: every table is copied as of this transaction's first read
      const tables = (src.prepare(USER_TABLES).all() as { name: string }[]).map((r) => r.name).filter((n) => !drop.has(n));
      for (const t of tables) {
        // A shared copy carries none of this file's own rows: no machine id, file id or placement marks.
        if (t === META) src.exec(`CREATE TABLE x."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
        else {
          src.exec(`CREATE TABLE x."${t}" (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
          const first = src.prepare(`INSERT INTO x."${t}" SELECT k, v FROM main."${t}" ORDER BY k LIMIT ?`);
          const next = src.prepare(`INSERT INTO x."${t}" SELECT k, v FROM main."${t}" WHERE k > (SELECT max(k) FROM x."${t}") ORDER BY k LIMIT ?`);
          for (let batch = first; ; batch = next) {
            if (batch.run(EXPORT_BATCH).changes < EXPORT_BATCH) break;
            await nextTurn();
          }
        }
      }
      src.exec("COMMIT");
      src.exec("DETACH DATABASE x");
    } catch (e) {
      try { if (src.isTransaction) src.exec("ROLLBACK"); } catch { /* finished */ }
      try { src.exec("DETACH DATABASE x"); } catch { /* not attached */ }
      src.close();
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-journal`, { force: true });
      throw e;
    }
    src.close();
    try {
      await publish(tmp, toPath);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /**
   * store-sqlite's own rows (`_carton`), outside the Store contract and never exported: what importProject records
   * about the import. Keys are the constants in format.ts.
   */
  async getOwn<T = unknown>(key: string): Promise<T | undefined> {
    return this.db.read(() => readMeta<T>(this.db.raw, key));
  }
  async setOwn(key: string, value: unknown): Promise<void> {
    await this.db.write(() => writeMeta(this.db.raw, key, value));
  }

  /** Give the pages freed by deletes (pruned keyframes, released pins) back to the file system. */
  async reclaim(maxPages = 0): Promise<void> {
    // incremental_vacuum steps through rows; reading them all to the end is what runs it.
    await this.db.write(() => this.db.raw.prepare(`PRAGMA incremental_vacuum${maxPages > 0 ? `(${Math.floor(maxPages)})` : ""}`).all());
  }

  #holds(t: string, k: string, expect: StoreCondition["expect"]): boolean {
    const row = this.#exists(t) ? (this.db.stmt(`SELECT v FROM "${t}" WHERE k = ?`).get(k) as { v: string | Uint8Array } | undefined) : undefined;
    if (expect === "absent") return row === undefined;
    if (expect === "present") return row !== undefined;
    return row !== undefined && canonical(decodeValue(row.v)) === canonical(expect.equals);
  }

  #exists(t: string): boolean {
    if (this.#tables.has(t) || this.#creating?.has(t)) return true;
    const found = this.db.stmt("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = ?").get(t) !== undefined;
    // A table seen here was committed by someone (tables are never dropped), unless this very transaction made it.
    if (found && !this.#creating?.has(t)) this.#tables.add(t);
    return found;
  }

  #create(t: string): void {
    if (this.#tables.has(t) || this.#creating?.has(t)) return;
    this.db.raw.exec(`CREATE TABLE IF NOT EXISTS "${t}" (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
    this.#creating?.add(t);
  }
}

const EXPORT_BATCH = 2000;

// The batch is committed whatever a listener does: a throwing listener is reported, never turned into a failed write.
function notify(listeners: Set<(tables: readonly string[]) => void>, tables: string[]): void {
  for (const l of listeners) {
    try {
      l(tables);
    } catch (e) {
      console.error("carton store: a watch listener threw", e);
    }
  }
}

// Put a finished file at `to` without ever replacing one: a hard link fails if `to` exists (EEXIST). On file systems
// without hard links (FAT, exFAT) an exclusive copy does the same, at the cost of the copy being visible while it is
// written. A SQLite opener creates the main file before any -wal, so once `to` is ours no stale WAL can be beside it.
async function publish(tmp: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.linkSync(tmp, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(`exportCopy: ${to} appeared while the copy was being made; nothing was replaced`);
      if (process.platform === "win32" && attempt < 40 && (code === "EBUSY" || code === "EACCES")) {
        await new Promise((r) => setTimeout(r, Math.min(250, 10 * (attempt + 1))));
        continue;
      }
      // No hard links here: an exclusive copy refuses an existing `to` just the same.
      fs.copyFileSync(tmp, to, fs.constants.COPYFILE_EXCL);
      return;
    }
  }
}

// Whether two paths name one file: the same path (case-insensitively where the file system usually is), a symlink or
// junction to it, or a hard link (same device and inode; Windows reports the file index as ino).
function sameFile(a: string, b: string): boolean {
  const fold = process.platform === "win32" || process.platform === "darwin" ? (x: string) => x.toLowerCase() : (x: string) => x;
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (fold(real(a)) === fold(real(b))) return true;
  try {
    const sa = fs.statSync(a, { bigint: true }), sb = fs.statSync(b, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
  } catch {
    return false;
  }
}

/** Open (creating if needed) the store at a carton.db path. */
export function openSqliteStore(file: string, opts: SqliteStoreOptions = {}): Promise<SqliteStore> {
  return SqliteStore.open(file, opts);
}

// Whether a file is a carton.db of a format this code reads: "ours", "new" (empty, or being created by another
// process), or an error. A file with tables but no Carton mark belongs to another program. The marks and the table
// count are read by one statement, so they come from one snapshot even while another process creates the file.
function identify(raw: DatabaseSync, file: string): "ours" | "new" {
  const { a: appId, v: version, n: tables } = raw
    .prepare("SELECT (SELECT application_id FROM pragma_application_id) AS a, (SELECT user_version FROM pragma_user_version) AS v, (SELECT count(*) FROM sqlite_schema) AS n")
    .get() as { a: number; v: number; n: number };
  if (appId !== 0 && appId !== APPLICATION_ID) throw new Error(`${file} is not a carton.db (application_id ${appId})`);
  if (version > FORMAT_VERSION) throw new Error(`${file} was written by a newer Carton (format ${version}; this one reads up to ${FORMAT_VERSION})`);
  if (appId === APPLICATION_ID && version === FORMAT_VERSION) return "ours";
  if (appId === 0 && tables > 0) throw new Error(`${file} is not a carton.db (it holds another program's tables)`);
  return "new";
}

async function init(db: Db, readOnly: boolean): Promise<void> {
  if (readOnly) return;
  if ((await db.read(() => identify(db.raw, db.path))) === "ours") {
    // A file from an export or an older build has no id or machine mark yet, or the earlier form of the mark (the
    // host hash alone): give it this machine's, once.
    const stale = () => readMeta(db.raw, DB_ID) === undefined || typeof readMeta(db.raw, MACHINE) !== "object";
    if (await db.read(stale)) {
      await db.write(() => {
        if (!stale()) return;
        db.raw.exec(`CREATE TABLE IF NOT EXISTS "${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
        if (readMeta(db.raw, DB_ID) === undefined) writeMeta(db.raw, DB_ID, newDbId());
        const m = readMeta(db.raw, MACHINE);
        if (m === undefined || (typeof m === "string" && isThisMachine(m))) writeMeta(db.raw, MACHINE, machineMark());
      });
    }
    return;
  }
  // A new file, or one another process is creating right now: mark it in one write transaction. The mark and the
  // first table appear together, so no other process ever sees a table without the mark.
  await db.write(() => {
    if (identify(db.raw, db.path) === "ours") return; // the other process finished first
    db.raw.exec(`CREATE TABLE IF NOT EXISTS "${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
    // Which file and which machine: a copy that a sync client brings to another machine is never adopted there, and
    // an interrupted move is recognised by its source's id (move.ts).
    writeMeta(db.raw, DB_ID, newDbId());
    writeMeta(db.raw, MACHINE, machineMark());
    db.raw.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT_VERSION}`);
  });
}

// Carton table names map to readable SQLite names: `changes` stays `changes`, so carton.db reads naturally in any
// SQLite browser. SQLite compares table names case-insensitively, so an upper-case letter X becomes `$x` (`pathMap`
// is `path$map`); any other name, or one SQLite reserves (`sqlite_…`), becomes `_t_` plus its UTF-16 code units in
// hex (four digits each: lossless even for lone surrogates, which UTF-8 can't carry). Plain names never contain `$`
// or start with `_`, so the mapping is one-to-one, and never collides with `_carton`.
const sqlNames = new Map<string, string>();
function tableName(table: string): string {
  let n = sqlNames.get(table);
  if (n !== undefined) return n;
  if (typeof table !== "string" || table.length === 0) throw new TypeError("store: a table name is a non-empty string");
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(table) && !/^sqlite_/i.test(table)) n = table.replace(/[A-Z]/g, (c) => "$" + c.toLowerCase());
  else {
    n = "_t_";
    for (let i = 0; i < table.length; i++) n += table.charCodeAt(i).toString(16).padStart(4, "0");
  }
  if (sqlNames.size < 1024) sqlNames.set(table, n);
  return n;
}

