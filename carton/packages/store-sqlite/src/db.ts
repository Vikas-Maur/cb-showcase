// One node:sqlite connection to carton.db, shared by every process on the machine (the library worker's engine
// thread, `cb`, MCP, the headless sync helper), plan §6.2.
//
// node:sqlite is synchronous, and a DatabaseSync waiting on a lock blocks its thread's event loop for the whole wait
// (P3b, verified). So SQLite's own busy handler only gets a few milliseconds (`syncBusyMs`), and any longer wait is an
// asynchronous retry with backoff, up to `busyTimeoutMs`. A write is one synchronous function run inside
// `BEGIN IMMEDIATE`: the lock is held only for the check and the inserts (target ≤ 5 ms, §6.2), and nothing else in
// this process can interleave with it, because the transaction begins and ends in one turn of the event loop.

import * as fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

export interface DbOptions {
  /** How long to wait for another process's lock before failing, in ms. The wait is asynchronous. Default 5000. */
  busyTimeoutMs?: number;
  /** SQLite's own busy wait per attempt, in ms. It blocks the thread, so it stays short. Default 3. */
  syncBusyMs?: number;
  /**
   * "normal" (default): WAL with synchronous=NORMAL. A crash of the app never loses a committed change; a crash of
   * the OS or a power cut can lose the last commits (SQLite's contract: they are then missing, never half-written,
   * the database never corrupt, and a ref to them fails loudly with "state unknown: re-print", §4.4). This is no
   * weaker than Cardboard 1.4.0, which never fsyncs its project saves.
   *
   * "full" fsyncs every commit, and SQLite does that inside COMMIT while it still holds the write lock, so how long
   * the lock is held depends on the disk, and other processes' writes wait that long. On a GitHub runner a commit
   * took over 5 ms in 5 of 14 benchmark runs (verify-ci, VERIFIED.md S3). It can't be otherwise: a commit has to be
   * on disk before the lock is let go. "full" also keeps SQLite's automatic WAL checkpoint in COMMIT (see
   * #watchWal; the default moves it out, which for "full" only made every commit slower).
   */
  durability?: "normal" | "full";
  readOnly?: boolean;
  /**
   * Windows only: how long an open retries a file another program holds for a moment (an antivirus scan, the
   * indexer, a backup tool), in ms, before DatabaseHeldError. Default 250; must be finite and >= 0. SQLite's own
   * synchronous waits inside an attempt come on top (see openRetrying).
   */
  openRetryMs?: number;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  // Extended codes keep the primary code in the low byte (SQLITE_BUSY_SNAPSHOT = 517, SQLITE_BUSY_RECOVERY = 261).
  return typeof code === "number" && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

const SQLITE_IOERR = 10;
const SQLITE_CANTOPEN = 14;
/** Default for `openRetryMs`: how long an open on Windows retries a held file before DatabaseHeldError. */
export const OPEN_RETRY_MS = 250;

/**
 * carton.db couldn't be opened on Windows within `openRetryMs`: most likely something still held it or its -wal/-shm
 * (an antivirus scan, the indexer, a backup tool, a process being terminated); a lasting cause (permissions, a
 * network share going away) can look the same to SQLite, so the message says both. `.cause` is SQLite's error.
 */
export class DatabaseHeldError extends Error {
  readonly code = "CARTON_DB_HELD";
  readonly path: string;
  constructor(path: string, cause: unknown, ms: number) {
    const c = cause as { message?: string; errcode?: number };
    super(`${path} couldn't be opened within ${ms} ms: another process or program (an antivirus scan, the indexer, a backup tool) may still be holding it or its -wal/-shm, so try again; if it keeps failing, check its permissions (SQLite: ${c?.message ?? cause}${typeof c?.errcode === "number" ? `, errcode ${c.errcode}` : ""})`, { cause });
    this.path = path;
  }
}

/** Test seam: the platform openRetrying behaves as (the Windows path is tested on every OS). */
export const openPlatform: { override?: NodeJS.Platform } = {};

// What a file held by another program can produce in SQLite's Windows VFS (os_win.c), by extended code. SQLite's own
// error codes name the operation, not the cause, so this is an allowlist of operations a holder can make fail:
// opening (CANTOPEN: the main file, -wal or -shm; plain only, not ISDIR/FULLPATH/CONVPATH/SYMLINK...), checking or
// deleting a file (IOERR_ACCESS, IOERR_DELETE), byte-range locks (IOERR_LOCK, RDLOCK, UNLOCK, CHECKRESERVEDLOCK), and
// shared memory (IOERR_SHMOPEN, SHMSIZE, SHMLOCK, SHMMAP). Never retried: a plain I/O error or a failed read, write,
// fsync or truncate (a failing disk looks just like that), a short read, out of memory, a corrupt file system, and
// SQLITE_CORRUPT/NOTADB (other primary codes). "Unable to open" counts only for a file that exists: a missing file or
// folder is lasting.
const HELD_IOERR = new Set([3338 /* ACCESS */, 2570 /* DELETE */, 3850 /* LOCK */, 2314 /* RDLOCK */, 2058 /* UNLOCK */, 3594 /* CHECKRESERVEDLOCK */, 4618 /* SHMOPEN */, 4874 /* SHMSIZE */, 5130 /* SHMLOCK */, 5386 /* SHMMAP */]);
function isHeldOnWindows(e: unknown, path: string): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  if (typeof code !== "number") return false;
  return HELD_IOERR.has(code) || (code === SQLITE_CANTOPEN && fs.existsSync(path));
}

/**
 * Run an open (`attempt`): a fresh connection each time, closed by the attempt when it fails, whose steps are all safe
 * to repeat (setup pragmas, and marks written in one transaction only when missing).
 *
 * Defence in depth for real Windows machines: an antivirus, the search indexer or a backup tool can hold a file (or
 * its -wal/-shm) for a moment, as can a process being terminated whose handles aren't closed yet. SQLite then fails
 * with "unable to open" or an I/O error. (verify-ci #22 looked like this, but its cause was a test reopening while a
 * killed helper's handle was still open, fixed in that test.) Such failures (isHeldOnWindows) are retried there,
 * asynchronously with backoff, until `retryMs` after the first attempt started (a monotonic deadline: every attempt
 * and sleep counts, and no attempt starts past it), then reported as DatabaseHeldError. Elsewhere nothing is retried;
 * an I/O error gets SQLite's extended code (its message is the same for every I/O step).
 *
 * The bound is on this loop, not on SQLite: inside one attempt, SQLite's Windows VFS itself waits synchronously on a
 * sharing violation (winRetryIoerr: by its source, up to 25 ms x (1 + ... + 10) = 1,375 ms per failing call; not
 * measured), which no JavaScript deadline can cut short. A thread that must stay responsive (answering lease pings)
 * should open carton.db elsewhere.
 */
export async function openRetrying<T>(path: string, attempt: () => Promise<T>, platform: NodeJS.Platform = openPlatform.override ?? process.platform, retryMs = OPEN_RETRY_MS): Promise<T> {
  // A bad value (NaN from a parsed setting, Infinity, a negative) would turn the deadline off: refused, on every OS.
  if (!Number.isFinite(retryMs) || retryMs < 0) throw new TypeError(`openRetryMs must be a finite number of ms >= 0, not ${retryMs}`);
  const deadline = performance.now() + retryMs;
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (platform !== "win32" || !isHeldOnWindows(e, path)) throw withCode(e);
      const left = deadline - performance.now();
      if (left <= 0) throw new DatabaseHeldError(path, e, retryMs);
      await sleep(Math.max(1, Math.min(left, 100, 10 << Math.min(n, 4)))); // 10, 20, 40, 80, 100… ms, never past the deadline
      if (performance.now() >= deadline) throw new DatabaseHeldError(path, e, retryMs);
    }
  }
}

function withCode(e: unknown): unknown {
  const err = e as Error & { errcode?: number };
  if (err instanceof Error && typeof err.errcode === "number" && (err.errcode & 0xff) === SQLITE_IOERR && !err.message.includes("errcode")) err.message += ` (SQLite errcode ${err.errcode})`;
  return err;
}

/** A checkpoint after this many of a connection's own writes (each adds at least one WAL frame; SQLite's own
 *  automatic checkpoint runs at 1,000 frames). */
export const CHECKPOINT_EVERY_WRITES = 1000;
/** And every this many ms on an idle timer, for the frames other processes add. */
export const CHECKPOINT_EVERY_MS = 30_000;

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
   * The last write's time from BEGIN IMMEDIATE to COMMIT's return, in ms (§6.2's lock target is ≤ 5). The write lock
   * is held for all of it except, where SQLite's automatic checkpoint is on ("full"), that checkpoint: SQLite runs it
   * inside COMMIT but after releasing the lock.
   */
  lastLockMs = 0;
  /** WAL checkpoints this connection ran, and the longest (ms; it holds this thread, never the write lock). */
  checkpoints = 0;
  checkpointMaxMs = 0;
  #writesSinceCheckpoint = 0;
  #checkpointQueued = false;
  #deferCheckpoints = false;
  #walTimer: ReturnType<typeof setInterval> | null = null;

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
      const full = opts.durability === "full";
      db.raw.exec(`PRAGMA synchronous=${full ? "FULL" : "NORMAL"};
        PRAGMA temp_store=MEMORY;
        PRAGMA journal_size_limit=${16 * 1024 * 1024};`);
      // Checkpoints out of the write lock for the default only (see #watchWal). With "full" every commit already
      // fsyncs under the lock, which dominates its worst case, so moving the checkpoint out bought nothing there and
      // cost every commit (verify-ci S3c: +23% p50, +33% mean per commit, worst hold unchanged): SQLite's automatic
      // checkpoint stays on for "full".
      if (!opts.readOnly && !full) {
        db.raw.exec("PRAGMA wal_autocheckpoint=0");
        db.#deferCheckpoints = true;
        db.#watchWal();
      }
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
    try {
      this.#begin = this.raw.prepare("BEGIN IMMEDIATE");
      this.#commit = this.raw.prepare("COMMIT");
      this.#rollbackStmt = this.raw.prepare("ROLLBACK");
    } catch (e) {
      this.raw.close(); // a failed construction must not leave the file open (on Windows it blocks renames)
      throw e;
    }
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
    // A caller that never yields (a tight loop of awaited writes: each resolves without a macrotask) never lets the
    // deferred checkpoint run. Past twice the budget it runs here, before the write lock is taken, so the WAL stays
    // bounded through the Store API alone.
    if (this.#deferCheckpoints && this.#writesSinceCheckpoint >= 2 * CHECKPOINT_EVERY_WRITES) this.checkpoint();
    this.#begin.run();
    const t0 = performance.now();
    let out: T;
    try {
      out = fn();
      this.#commit.run();
    } catch (e) {
      this.#rollback();
      throw e;
    } finally {
      this.lastLockMs = performance.now() - t0;
    }
    if (this.#deferCheckpoints && ++this.#writesSinceCheckpoint >= CHECKPOINT_EVERY_WRITES) this.#queueCheckpoint();
    return out;
  }

  // With the default durability, checkpoints never run inside a commit. SQLite's automatic one runs inside COMMIT
  // (from its WAL hook, once the WAL passes 1,000 frames): after the write lock is released, so other writers don't
  // wait for it, but the committing call does: about once per 1,000 commits a commit took ~30 ms to return (verified,
  // VERIFIED.md S3; S3c: p99 -14%, worst -80% with this change). It is off (wal_autocheckpoint=0), and a PASSIVE
  // checkpoint (what the automatic one is too) runs on its own turn of the event loop: after CHECKPOINT_EVERY_WRITES
  // of this connection's writes, every CHECKPOINT_EVERY_MS on an idle timer (for frames that short `cb` processes
  // add), and once at open (for a WAL a crash left behind); a caller that never yields gets it inline before its next
  // write past twice the budget (writeNow). A PASSIVE checkpoint with nothing new to copy does no I/O, so the timer is
  // cheap. While any store has the file open the WAL is bounded by those, except that a reader keeping an old
  // snapshot open stops the WAL from being reused until it lets go (true of SQLite's own checkpoint too). (The WAL
  // file's size is no guide: after a checkpoint SQLite reuses it from the start without shrinking it.)
  #watchWal(): void {
    this.#queueCheckpoint();
    this.#walTimer = setInterval(() => this.#queueCheckpoint(), CHECKPOINT_EVERY_MS);
    this.#walTimer.unref?.();
  }

  #queueCheckpoint(): void {
    if (this.#checkpointQueued || this.#closed) return;
    this.#checkpointQueued = true;
    setImmediate(() => {
      this.#checkpointQueued = false;
      this.checkpoint();
    });
  }

  /** A PASSIVE checkpoint: copies what it can without waiting for readers or blocking writers. */
  checkpoint(): void {
    if (this.#closed) return;
    this.#writesSinceCheckpoint = 0;
    const t0 = performance.now();
    try {
      this.raw.prepare("PRAGMA wal_checkpoint(PASSIVE)").all();
      this.checkpoints++;
      this.checkpointMaxMs = Math.max(this.checkpointMaxMs, performance.now() - t0);
    } catch {
      // another process is checkpointing (busy), or the disk refused: the next check tries again
    }
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
    if (this.#walTimer) clearInterval(this.#walTimer);
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
