// Moving carton.db when a project's placement changes (§6.4, L15): the bundle went into a synced folder (bundle →
// app data), or came back out (app data → bundle). History follows the project; it is never left behind for an empty
// database, and a stale copy is never reopened as if it were current.
//
// Every decision is made under the project's placement lock (a small SQLite file in app data, held with
// BEGIN IMMEDIATE), so processes opening the project at once see either nothing done or a whole move, and a cleanup
// never runs between another process's look and its act. A move, under the old file's own write lock as well:
//   1. checks the old file is a carton.db of this format, made on this machine;
//   2. copies every table into a temporary file, recording `copyOf: {path, token, dbId}` (dbId: the old file's id);
//   3. renames the copy to its new path;
//   4. writes `movedTo: {path, token}` into the old file and commits.
// No change can land in the old file during the move. Every later write to a moved file is refused (SqliteStore checks
// the mark inside each write), so a process that still had it open fails loudly instead of writing into abandoned
// history. A crash between 3 and 4 leaves a copy of a file that never confirmed it; the next open recognises it by the
// old file's dbId (a different or recreated file never matches), deletes the copy and moves again.
//
// After a move the old file is deleted as soon as no process has it open (now, or at a later open), so a bundle that
// went into a synced folder doesn't keep a database there for the sync client to upload. A carton.db another machine
// made (it arrived through a sync client or a copied folder) is never adopted as this machine's replica (L15): at the
// other placement it is left alone, and at the chosen one it is set aside under a new name for the host to offer as
// someone else's history.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { APPLICATION_ID, FORMAT_VERSION, META, DB_ID, MACHINE, MOVED_TO, COPY_OF, USER_TABLES, isThisMachine, machineMark, readMeta, writeMeta, newDbId, type MachineMark } from "./format.ts";

interface Mark {
  path: string;
  token: string;
  dbId?: string;
}

export class MovedError extends Error {
  readonly code = "CARTON_DB_MOVED";
  readonly to: string;
  constructor(from: string, to: string) {
    super(`carton.db moved from ${from} to ${to}: reopen the project`);
    this.to = to;
  }
}

export class PlacementConflictError extends Error {
  readonly code = "CARTON_DB_PLACEMENT_CONFLICT";
  readonly paths: [string, string];
  constructor(a: string, b: string, why = "This project has two separate histories") {
    super(`${why}: ${a} and ${b}. Carton won't pick one: keep one and move the other away.`);
    this.paths = [a, b];
  }
}

/** The project's history is in a carton.db Carton can't write (read-only file or attribute, folder, ACL): it can't
 *  be fenced, so it is never moved. Nothing was copied anywhere. */
export class UnwritableHistoryError extends Error {
  readonly code = "CARTON_DB_UNWRITABLE";
  readonly path: string;
  constructor(file: string, cause: unknown) {
    super(`This project's history (${file}) can't be written, so Carton can't move it to where it belongs now. Make it, its -wal and -shm files and its folder writable (on Windows, clear the read-only attribute), then open the project again. (${(cause as Error)?.message ?? cause})`);
    this.path = file;
    this.cause = cause;
  }
}

// SQLite's answers that mean "this file can't be written here": READONLY, PERM, CANTOPEN, AUTH (primary codes).
const UNWRITABLE_CODES = new Set([8, 3, 14, 23]);
const isUnwritable = (e: unknown) => UNWRITABLE_CODES.has(((e as { errcode?: number }).errcode ?? -1) & 0xff);

const same = (a: string, b: string) => {
  const fold = process.platform === "win32" || process.platform === "darwin" ? (x: string) => x.toLowerCase() : (x: string) => x;
  return fold(path.resolve(a)) === fold(path.resolve(b));
};

/** Test-only points to stop or fail at (a crash test exits the process there). */
export interface MoveHooks {
  /** The source's write lock is held; the raw connection is the one the move writes the mark with. */
  afterSourceLock?: (raw: DatabaseSync) => void;
  /** The copy is complete under its temporary name; publishing it comes next. */
  beforePublish?: (to: string) => void;
  afterPublish?: () => void | Promise<void>;
}

/**
 * Make `target` the project's carton.db, given that `other` is where it may have lived before (the other placement),
 * then run `open` (which opens `target`), all while holding the project's placement lock (`lockFile`): an opener
 * that settled must not be overtaken by a move before it has the file open. Returns `open`'s result, and the path a
 * foreign carton.db found at `target` was moved aside to, if any.
 */
export async function settlePlacement<T>(target: string, other: string, lockFile: string, open: () => Promise<T>, waitMs = 10_000, hooks: MoveHooks = {}): Promise<{ opened: T; setAside?: string }> {
  return withLock(lockFile, waitMs, async () => {
    const setAside = setAsideIfForeign(target);
    if (!same(target, other) && fs.existsSync(other)) await settle(target, other, waitMs, hooks);
    return { opened: await open(), ...(setAside ? { setAside } : {}) };
  });
}

async function settle(target: string, other: string, waitMs: number, hooks: MoveHooks): Promise<void> {
  // Nothing can fence a history Carton can't write (another process may still have it open and writing), so it is
  // never copied as if it were frozen.
  const unwritable = (e: unknown) => new UnwritableHistoryError(other, e);
  // Asked of the file system first, before SQLite opens it for writing: a read-only file (mode, or the read-only
  // attribute on Windows) is never opened that way, so SQLite never makes read-only -wal/-shm files beside it (it
  // gives them the database's own permissions) and nothing beside it is ever deleted. Such a file is then looked at
  // without changing anything (an immutable read: no lock, no -shm, no -wal), and left alone if it plainly isn't this
  // machine's history to move (another program's file, an empty one, another machine's synced in: L15), or if it
  // already moved here. Anything else (this machine's history, or a -wal that might hold what the immutable read
  // can't see) needs fencing it can't have, so it is refused. A write-denying ACL (which access() doesn't see on
  // Windows) is caught by the write probe before any copy.
  for (const f of [other, `${other}-wal`, `${other}-shm`]) {
    if (f !== other && !fs.existsSync(f)) continue;
    try {
      fs.accessSync(f, fs.constants.W_OK);
    } catch (e) {
      if (notOursToMove(other, target)) return;
      throw unwritable(e);
    }
  }
  let src: DatabaseSync | undefined;
  try {
    src = new DatabaseSync(other, { timeout: 3 });
    src.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
  } catch (e) {
    src?.close(); // opened but unreadable: never left open (on Windows it would block the next rename or delete)
    throw unwritable(e);
  }
  let cleanUp = false;
  try {
    try {
      await begin(src, other, waitMs);
    } catch (e) {
      if (isUnwritable(e)) throw unwritable(e);
      throw e;
    }
    hooks.afterSourceLock?.(src);
    const id = src.prepare("SELECT (SELECT application_id FROM pragma_application_id) AS a, (SELECT user_version FROM pragma_user_version) AS v, (SELECT count(*) FROM sqlite_schema) AS n").get() as { a: number; v: number; n: number };
    if (id.a !== APPLICATION_ID) return; // empty (a stray opener made it) or another program's file: not a history
    if (id.v > FORMAT_VERSION) throw new Error(`${other} was written by a newer Carton (format ${id.v}); this one can't move it`);
    if (!isThisMachine(readMeta(src, MACHINE))) return; // another machine's file, synced here: not ours
    const moved = readMeta<Mark>(src, MOVED_TO);
    if (moved && !same(moved.path, target)) return; // moved somewhere else (another app-data folder): not ours to finish
    const t = fs.existsSync(target) ? inspect(target) : null;
    if (moved) {
      // Done before. If the copy has since vanished (deleted by hand), the history is still here: copy again.
      if (!t) {
        // Under the mark's own token: a crash after this copy is published (before the mark is rewritten) then
        // leaves a copy that the mark already vouches for, not one that conflicts with it forever.
        await copyAndMark(src, other, target, hooks, moved.token);
        cleanUp = true;
        return;
      }
      // Only the very copy this mark vouches for makes the old file deletable: something else at the target (an
      // empty file, another history) means the history is still only here, so it is kept and the open refused.
      if (!isCopyOf(t, other, moved.token)) throw new PlacementConflictError(target, other, "This project's history moved, but what is at its new place isn't that copy");
      cleanUp = true;
      return;
    }
    // A file from an export or an older build has no id yet. It gets one, committed before anything is copied, so a
    // copy published by an interrupted move always names the file it came from.
    if (readMeta<string>(src, DB_ID) === undefined) {
      try {
        src.exec(`CREATE TABLE IF NOT EXISTS main."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
        writeMeta(src, DB_ID, newDbId());
        if (readMeta(src, MACHINE) === undefined) writeMeta(src, MACHINE, machineMark());
        src.exec("COMMIT");
      } catch (e) {
        throw isUnwritable(e) ? unwritable(e) : e;
      }
      await begin(src, other, waitMs);
    }
    if (t) {
      const sourceId = readMeta<string>(src, DB_ID);
      // `other` has no mark, so a copy of this very file at the target is a move that never got confirmed. Such a
      // copy never moved on itself: one that did (it has its own movedTo) became the history, and a file at `other`
      // with the same id is an older state of it (a backup put back), never a reason to delete it.
      const interrupted = t.movedTo === undefined && t.copyOf !== undefined && same(t.copyOf.path, other) && sourceId !== undefined && t.copyOf.dbId === sourceId;
      // `target` is an old copy whose history moved here, to `other`: only if `other` is the very copy its mark
      // vouches for. Anything else now at `other` (an unrelated history put there) leaves `target` the history.
      const stale = t.movedTo !== undefined && same(t.movedTo.path, other) && isCopyOf({ copyOf: readMeta<Mark>(src, COPY_OF) }, target, t.movedTo.token);
      if (!interrupted && !stale) throw new PlacementConflictError(target, other);
      removeUnused(target); // an unconfirmed copy, or the old copy we're moving back over
    }
    await copyAndMark(src, other, target, hooks);
    cleanUp = true;
  } finally {
    // A failed write can have rolled the transaction back already; the connection is closed whatever happens.
    try {
      if (src.isTransaction) src.exec("ROLLBACK");
    } catch {
      // nothing left to undo
    }
    src.close();
    if (cleanUp) {
      try {
        removeUnused(other);
      } catch {
        // still open somewhere (that process's writes fail with MovedError); a later open deletes it
      }
    }
  }
}

// Whether a file Carton can't write is safe to leave where it is: read without changing anything beside it.
function notOursToMove(file: string, target: string): boolean {
  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${file}-wal`).size;
  } catch {
    // no -wal
  }
  if (walBytes > 0) return false; // committed pages the immutable read wouldn't see: can't tell
  const url = pathToFileURL(path.resolve(file));
  url.searchParams.set("immutable", "1");
  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(url, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const id = raw.prepare("SELECT (SELECT application_id FROM pragma_application_id) AS a, (SELECT count(*) FROM sqlite_schema) AS n").get() as { a: number; n: number };
    if (id.a !== APPLICATION_ID) return true; // empty, or another program's file: not a history
    if (!isThisMachine(readMeta(raw, MACHINE))) return true; // another machine's, synced here
    const moved = readMeta<Mark>(raw, MOVED_TO);
    // Its history already lives at the target, provided the target is that very copy.
    return !!moved && same(moved.path, target) && fs.existsSync(target) && isCopyOf(inspect(target), file, moved.token);
  } catch {
    return false;
  } finally {
    raw.close();
  }
}

// The project's placement lock: BEGIN IMMEDIATE on a small SQLite file, waited for asynchronously (P3b).
async function withLock<T>(lockFile: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(path.resolve(lockFile)), { recursive: true });
  const db = new DatabaseSync(lockFile, { timeout: 3 });
  try {
    await begin(db, lockFile, waitMs);
    return await fn();
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

// BEGIN IMMEDIATE with SQLite's busy wait kept to a few ms and the rest of the wait asynchronous (P3b).
async function begin(db: DatabaseSync, file: string, waitMs: number): Promise<void> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (e) {
      const code = (e as { errcode?: number }).errcode ?? 0;
      if ((code & 0xff) !== 5 && (code & 0xff) !== 6) throw e;
      if (Date.now() - t0 > waitMs) throw new Error(`${file} stayed locked by another process; can't settle where this project's history lives now`);
      await sleep(Math.min(50, 2 << Math.min(attempt, 4)));
    }
  }
}

// Steps 2-4 of the protocol; `src` holds the write lock on `from`, so the copy (made on a second connection, which
// reads the last committed state) is exactly what the mark will vouch for.
async function copyAndMark(src: DatabaseSync, from: string, to: string, hooks: MoveHooks, token = randomBytes(8).toString("hex")): Promise<void> {
  // Step 4 must be possible before step 2 starts: a source that can't take the mark can't be fenced.
  assertWritable(src, from);
  // copyInto leaves nothing behind when it fails, publication included.
  await copyInto(from, to, { path: path.resolve(from), token, ...(readMeta<string>(src, DB_ID) ? { dbId: readMeta<string>(src, DB_ID) } : {}) }, hooks);
  try {
    await hooks.afterPublish?.(); // between steps 3 and 4: where a crash leaves an unconfirmed copy
    src.exec(`CREATE TABLE IF NOT EXISTS main."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
    writeMeta(src, MOVED_TO, { path: path.resolve(to), token });
    src.exec("COMMIT");
  } catch (e) {
    // The mark didn't land, so the copy vouches for nothing: take it back (the source is still the history). A
    // crash here instead leaves it for the next open to recognise and redo.
    try {
      removeUnused(to);
    } catch {
      // somebody opened it already (outside openProjectStore); the next open recognises it as unconfirmed
    }
    throw isUnwritable(e) ? new UnwritableHistoryError(from, e) : e;
  }
}

// Ask SQLite itself whether this connection may write the file: one write, undone at once. On Windows BEGIN IMMEDIATE
// succeeds on a file with the read-only attribute (or a write-denying ACL, where SQLite quietly opened it read-only),
// and only the first real write is refused; this makes that refusal come before anything is copied.
function assertWritable(src: DatabaseSync, file: string): void {
  src.exec("SAVEPOINT carton_probe");
  let failure: unknown = null;
  try {
    src.exec(`CREATE TABLE IF NOT EXISTS main."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
    // A page's worth, so the file must also be able to grow: a full disk or quota shows here, before the copy.
    writeMeta(src, "writeProbe", "x".repeat(4096));
  } catch (e) {
    failure = e;
  }
  // Some failures (SQLITE_FULL, I/O errors) roll the whole transaction back, savepoint and write lock with it: then
  // there is nothing to undo, and the move must not go on without its lock.
  if (src.isTransaction) {
    try {
      src.exec("ROLLBACK TO carton_probe");
      src.exec("RELEASE carton_probe");
    } catch (e) {
      failure ??= e;
    }
  } else failure ??= new Error("the source's transaction ended during the write probe");
  if (failure) throw isUnwritable(failure) ? new UnwritableHistoryError(file, failure) : failure;
}

// Copy every table of `from` (one snapshot, on its own connection) into a new file at `to`, appearing there only when
// complete. The copy gets its own dbId and never carries the source's placement marks.
async function copyInto(from: string, to: string, copyOf: Mark, hooks: MoveHooks = {}): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
  const tmp = `${to}.part-${process.pid}-${randomBytes(4).toString("hex")}`;
  const src = new DatabaseSync(from, { timeout: 2000 });
  try {
    src.prepare("ATTACH DATABASE ? AS x").run(tmp);
    src.exec(`PRAGMA x.auto_vacuum=INCREMENTAL; PRAGMA x.application_id=${APPLICATION_ID}; PRAGMA x.user_version=${FORMAT_VERSION}`);
    src.exec("BEGIN");
    const tables = (src.prepare(USER_TABLES).all() as { name: string }[]).map((r) => r.name);
    src.exec(`CREATE TABLE x."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
    for (const t of tables) {
      if (t === META) src.prepare(`INSERT INTO x."${META}" SELECT k, v FROM main."${META}" WHERE k NOT IN (?, ?, ?)`).run(MOVED_TO, COPY_OF, DB_ID);
      else src.exec(`CREATE TABLE x."${t}" (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID; INSERT INTO x."${t}" SELECT k, v FROM main."${t}"`);
    }
    writeMeta(src, COPY_OF, copyOf, "x");
    writeMeta(src, DB_ID, newDbId(), "x");
    src.exec("COMMIT");
    src.exec("DETACH DATABASE x");
  } catch (e) {
    try { if (src.isTransaction) src.exec("ROLLBACK"); } catch { /* finished */ }
    try { src.exec("DETACH DATABASE x"); } catch { /* not attached */ }
    for (const f of [tmp, `${tmp}-journal`]) fs.rmSync(f, { force: true });
    throw new Error(`moving this project's history from ${from} to ${to} failed: ${(e as Error).message}`);
  } finally {
    src.close();
  }
  try {
    hooks.beforePublish?.(to);
    await renameRetry(tmp, to);
  } catch (e) {
    // Never published: nothing may stay behind under the temporary name.
    for (const f of [tmp, `${tmp}-journal`]) fs.rmSync(f, { force: true });
    throw e;
  }
}

// A carton.db's own marks. A file that can't be read as one (empty, damaged, not SQLite) has none.
function inspect(file: string): { copyOf?: Mark; movedTo?: Mark; machine?: MachineMark } {
  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  } catch {
    return {};
  }
  try {
    return { copyOf: readMeta<Mark>(raw, COPY_OF), movedTo: readMeta<Mark>(raw, MOVED_TO), machine: readMeta<MachineMark>(raw, MACHINE) };
  } catch {
    return {};
  } finally {
    raw.close();
  }
}

// Whether `t` is the copy a move of `source` with this token published.
const isCopyOf = (t: { copyOf?: Mark }, source: string, token: string) => t.copyOf !== undefined && same(t.copyOf.path, source) && t.copyOf.token === token;

// A carton.db at the chosen placement that another machine made is not this machine's replica: move it aside (with
// its WAL) under a name that says whose it was, so the project opens with its own history and the host can offer the
// other one as someone else's (a full-history import).
function setAsideIfForeign(target: string): string | undefined {
  if (!fs.existsSync(target)) return undefined;
  let machine: MachineMark | undefined;
  try {
    machine = inspect(target).machine;
  } catch {
    return undefined; // not readable as a database: openSqliteStore will say what it is
  }
  if (isThisMachine(machine)) return undefined;
  assertUnused(target);
  const aside = path.join(path.dirname(target), `carton.from-${(machine?.host ?? "unknown").slice(0, 8)}-${Date.now().toString(36)}.db`);
  if (fs.existsSync(`${target}-wal`)) fs.renameSync(`${target}-wal`, `${aside}-wal`);
  fs.rmSync(`${target}-shm`, { force: true });
  fs.renameSync(target, aside);
  return aside;
}

// Throws unless no other process has `file` open: an exclusive lock is only granted when nobody else holds it. Its
// WAL is folded in on the way, so no -wal is left behind to be replayed into whatever later takes the path.
function assertUnused(file: string): void {
  const raw = new DatabaseSync(file, { timeout: 0 });
  try {
    raw.exec("PRAGMA locking_mode=EXCLUSIVE");
    raw.exec("BEGIN EXCLUSIVE");
    raw.exec("COMMIT");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    throw new Error(`${file} holds a copy of this project's history and is still open in another program; close it and open the project again (${(e as Error).message})`);
  } finally {
    raw.close();
  }
}

// Delete a carton.db that is an unconfirmed or superseded copy, once no process has it open.
function removeUnused(file: string): void {
  assertUnused(file);
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

// On Windows a file that was just written is often held for a moment by an antivirus scanner or the search indexer,
// and renaming it fails with EPERM, EBUSY or EACCES until they let go (the build's rename-retry helper does the same).
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 40 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await sleep(Math.min(250, 10 * (attempt + 1)));
    }
  }
}

export { machineMark };
