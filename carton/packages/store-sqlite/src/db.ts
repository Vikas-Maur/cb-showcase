// One node:sqlite connection to carton.db, shared by every process on the machine (the library worker's engine
// thread, `cb`, MCP, the headless sync helper), plan §6.2.
//
// node:sqlite is synchronous, and a DatabaseSync waiting on a lock blocks its thread's event loop for the whole wait
// (P3b, verified). So SQLite's own busy handler only gets a few milliseconds (`syncBusyMs`), and any longer wait is an
// asynchronous retry with backoff, up to `busyTimeoutMs`. A write is one synchronous function run inside
// `BEGIN IMMEDIATE`: the lock is held only for the check and the inserts (target ≤ 5 ms, §6.2), and nothing else in
// this process can interleave with it, because the transaction begins and ends in one turn of the event loop.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

export interface DbOptions {
  /** How long to wait for another process's lock before failing, in ms. The wait is asynchronous. Default 5000. */
  busyTimeoutMs?: number;
  /** SQLite's own busy wait per attempt, in ms. It blocks the thread, so it stays short. Default 3. */
  syncBusyMs?: number;
  /**
   * "normal" (default): WAL with synchronous=NORMAL. An app or OS crash never corrupts the database or loses a
   * committed change; a power cut can lose the last commits (they are then missing, never half-written, and a ref to
   * them fails loudly with "state unknown: re-print", §4.4). This is no weaker than Cardboard 1.4.0, which never
   * fsyncs its project saves. "full" fsyncs every commit.
   */
  durability?: "normal" | "full";
  readOnly?: boolean;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  // Extended codes keep the primary code in the low byte (SQLITE_BUSY_SNAPSHOT = 517, SQLITE_BUSY_RECOVERY = 261).
  return typeof code === "number" && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

export class BusyError extends Error {
  readonly code = "CARTON_DB_BUSY";
  constructor(ms: number) {
    super(`carton.db stayed locked by another process for ${ms} ms`);
  }
}

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  readonly #busyTimeoutMs: number;
  readonly #stmts = new Map<string, StatementSync>();
  readonly #begin: StatementSync;
  readonly #commit: StatementSync;
  readonly #rollbackStmt: StatementSync;
  #closed = false;
  /** Busy retries so far (writes and reads), for tests and benchmarks. */
  busyRetries = 0;

  /**
   * Open a connection and set it up. Waits asynchronously if another process is creating the same file. `verify`
   * runs first, before anything is written, so a file that isn't ours is refused untouched.
   */
  static async open(path: string, opts: DbOptions = {}, verify?: (raw: DatabaseSync) => void): Promise<Db> {
    const db = new Db(path, opts);
    try {
      if (verify) await db.read(() => verify(db.raw));
      if (!opts.readOnly) {
        // Both steps read or write page 1, which another process creating the same new file holds exclusively for a
        // moment while it switches the file to WAL: retried (asynchronously) together.
        await db.read(() => {
          // A new file: choose auto_vacuum first (it can't change once WAL or a table has written page 1).
          // INCREMENTAL lets retention give freed pages back to the disk (SqliteStore.reclaim).
          if ((db.raw.prepare("PRAGMA page_count").get() as { page_count: number }).page_count === 0) db.raw.exec("PRAGMA auto_vacuum=INCREMENTAL");
          db.raw.exec("PRAGMA journal_mode=WAL");
        });
      }
      db.raw.exec(`PRAGMA synchronous=${opts.durability === "full" ? "FULL" : "NORMAL"};
        PRAGMA temp_store=MEMORY;
        PRAGMA journal_size_limit=${16 * 1024 * 1024};`);
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  }

  private constructor(path: string, opts: DbOptions) {
    this.path = path;
    this.#busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    this.raw = new DatabaseSync(path, { timeout: opts.syncBusyMs ?? 3, readOnly: opts.readOnly ?? false });
    this.#begin = this.raw.prepare("BEGIN IMMEDIATE");
    this.#commit = this.raw.prepare("COMMIT");
    this.#rollbackStmt = this.raw.prepare("ROLLBACK");
  }

  /** A cached prepared statement. */
  stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Run `fn` inside BEGIN IMMEDIATE and commit. `fn` must be synchronous: it is the compare-and-swap, and holds the
   * write lock for its whole run. If another process holds the lock, wait asynchronously and try again.
   */
  write<T>(fn: () => T): Promise<T> {
    return this.#retry(() => this.writeNow(fn));
  }

  /** One attempt of `write`: throws SQLite's busy error instead of waiting. */
  writeNow<T>(fn: () => T): T {
    this.#begin.run();
    let out: T;
    try {
      out = fn();
      this.#commit.run();
    } catch (e) {
      this.#rollback();
      throw e;
    }
    return out;
  }

  /**
   * Run `fn`, a synchronous read. Readers never wait for writers in WAL mode, but a reader can briefly see
   * SQLITE_BUSY while another connection recovers the WAL after a crash, so this retries like `write`.
   */
  read<T>(fn: () => T): Promise<T> {
    return this.#retry(fn);
  }

  async #retry<T>(fn: () => T): Promise<T> {
    let t0 = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e) || this.#closed) throw e;
        if (attempt === 0) t0 = Date.now();
        const waited = Date.now() - t0;
        if (waited >= this.#busyTimeoutMs) throw new BusyError(waited);
        this.busyRetries++;
        await sleep(backoff(attempt));
      }
    }
  }

  #rollback(): void {
    if (!this.raw.isTransaction) return; // SQLite already rolled back (some errors do)
    try {
      this.#rollbackStmt.run();
    } catch {
      // nothing left to undo
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts.clear();
    this.raw.close();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

// 1, 2, 4, 8, 16, 16… ms with ±50% jitter, so processes that collided do not retry in lockstep.
function backoff(attempt: number): number {
  const base = Math.min(16, 1 << Math.min(attempt, 4));
  return Math.max(1, Math.round(base * (0.5 + Math.random())));
}
