// Moving carton.db when a project's placement changes (§6.4, L15): the bundle went into a synced folder (bundle →
// app data), or came back out (app data → bundle). History follows the project; it is never left behind for an empty
// database, and a stale copy is never reopened as if it were current.
//
// The protocol, all under the old file's write lock (BEGIN IMMEDIATE, held from the decision to the end):
//   1. copy every table into a temporary file, recording `copyOf: {path, token}` in the copy;
//   2. rename the copy to its new path;
//   3. write `movedTo: {path, token}` into the old file and commit, which releases the lock.
// No change can land in the old file during the move, and another process deciding at the same time waits for the
// lock, so it sees either nothing done or the whole move. Every later write to a moved file is refused (SqliteStore
// checks the mark inside each write), so a process that still had it open fails loudly instead of writing into
// abandoned history. A crash between 2 and 3 leaves a copy whose token the old file never confirmed: the next open
// sees that, deletes the unconfirmed copy and moves again from the old file, which is still the history.
//
// After a move the old file is deleted as soon as no process has it open (now, or at a later open), so a bundle that
// went into a synced folder doesn't keep a database there for the sync client to upload. And a carton.db made on
// another machine (it arrived through a sync client) is never adopted: L15 says such bundles come in as external
// changes, not as a copy of someone else's replica.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

export const META = "_carton";
export const MOVED_TO = "movedTo";
export const COPY_OF = "copyOf";
export const MACHINE = "machine";

/** This machine and OS user, as written into every carton.db it creates. */
export const machineId: string = (() => {
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    // no user database entry (some containers): the host and home folder still tell machines apart
  }
  return createHash("sha256").update([os.hostname(), user, os.homedir()].join("\0")).digest("hex").slice(0, 16);
})();
const APPLICATION_ID = 0x4352544e;

interface Mark {
  path: string;
  token: string;
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
  constructor(a: string, b: string) {
    super(`This project has two separate histories, ${a} and ${b}. Carton won't pick one: keep one and move the other away.`);
    this.paths = [a, b];
  }
}

/** The mark `key` in an open connection's `_carton` table, or undefined. */
export function readMark(raw: DatabaseSync, key: string, schema = "main"): Mark | undefined {
  if (raw.prepare(`SELECT 1 AS x FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(META) === undefined) return undefined;
  const row = raw.prepare(`SELECT v FROM ${schema}."${META}" WHERE k = ?`).get(key) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as Mark) : undefined;
}

const same = (a: string, b: string) => {
  const fold = process.platform === "win32" || process.platform === "darwin" ? (x: string) => x.toLowerCase() : (x: string) => x;
  return fold(path.resolve(a)) === fold(path.resolve(b));
};

/**
 * Make `target` the project's carton.db, given that `other` is where it may have lived before (the other placement).
 * Called by openProjectStore before it opens `target`. Waits (asynchronously) up to `waitMs` for the old file's lock.
 */
export async function settlePlacement(target: string, other: string, waitMs = 10_000): Promise<void> {
  if (same(target, other) || !fs.existsSync(other)) return;
  if (!writable(other)) {
    // A read-only folder: its file can't change, so it needs no lock and no mark. Copy it once if the target is new.
    if (!fs.existsSync(target)) await copyReadOnly(other, target);
    return;
  }
  const src = new DatabaseSync(other, { timeout: 3 });
  let cleanUp = false;
  try {
    await lock(src, other, waitMs);
    const machine = readMeta(src, MACHINE);
    if (machine !== undefined && machine !== machineId) return; // another machine's file, synced here: not ours
    const moved = readMark(src, MOVED_TO);
    if (moved && !same(moved.path, target)) return; // moved somewhere else (another app-data folder): not ours to finish
    const t = fs.existsSync(target) ? inspect(target) : null;
    if (moved) {
      // Done before. If the copy has since vanished (deleted by hand), the history is still here: copy again.
      if (!t) await copyAndMark(src, other, target);
      cleanUp = true;
      return;
    }
    if (t) {
      // `other` carries no mark here, so a copy of it at the target is a move that never got confirmed.
      const interrupted = t.copyOf !== undefined && same(t.copyOf.path, other);
      const stale = t.movedTo && same(t.movedTo.path, other);
      if (!interrupted && !stale) throw new PlacementConflictError(target, other);
      removeUnused(target); // an unconfirmed copy, or the old copy we're moving back over
    }
    await copyAndMark(src, other, target);
    cleanUp = true;
  } finally {
    if (src.isTransaction) src.exec("ROLLBACK");
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

function readMeta(raw: DatabaseSync, key: string): unknown {
  if (raw.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = ?").get(META) === undefined) return undefined;
  const row = raw.prepare(`SELECT v FROM "${META}" WHERE k = ?`).get(key) as { v: string } | undefined;
  return row ? JSON.parse(row.v) : undefined;
}

// BEGIN IMMEDIATE with SQLite's busy wait kept to a few ms and the rest of the wait asynchronous (P3b).
async function lock(src: DatabaseSync, file: string, waitMs: number): Promise<void> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      src.exec("BEGIN IMMEDIATE");
      return;
    } catch (e) {
      const code = (e as { errcode?: number }).errcode ?? 0;
      if ((code & 0xff) !== 5 && (code & 0xff) !== 6) throw e;
      if (Date.now() - t0 > waitMs) throw new Error(`${file} stayed locked by another process; can't move this project's history now`);
      await sleep(Math.min(50, 2 << Math.min(attempt, 4)));
    }
  }
}

// Steps 1-3 of the protocol; `src` holds the write lock on `from`, so the copy (made on a second connection, which
// reads the last committed state) is exactly what the mark will vouch for.
async function copyAndMark(src: DatabaseSync, from: string, to: string): Promise<void> {
  const token = randomBytes(8).toString("hex");
  await copyInto(from, to, { path: path.resolve(from), token });
  src.exec(`CREATE TABLE IF NOT EXISTS main."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
  src.prepare(`INSERT INTO main."${META}"(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(MOVED_TO, JSON.stringify({ path: path.resolve(to), token }));
  src.exec("COMMIT");
}

// Copy every table of `from` (one snapshot, on its own connection) into a new file at `to`, appearing there only when
// complete. The copy never carries the source's own marks; it records `copyOf` when given.
async function copyInto(from: string, to: string, copyOf: Mark | null): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
  const tmp = `${to}.part-${process.pid}-${randomBytes(4).toString("hex")}`;
  const src = new DatabaseSync(from, { timeout: 2000 });
  try {
    src.prepare("ATTACH DATABASE ? AS x").run(tmp);
    src.exec(`PRAGMA x.auto_vacuum=INCREMENTAL; PRAGMA x.application_id=${APPLICATION_ID}`);
    src.exec("BEGIN");
    const version = (src.prepare("SELECT user_version AS v FROM pragma_user_version").get() as { v: number }).v;
    src.exec(`PRAGMA x.user_version=${version}`);
    const tables = (src.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    src.exec(`CREATE TABLE x."${META}" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
    for (const t of tables) {
      if (t === META) src.prepare(`INSERT INTO x."${META}" SELECT k, v FROM main."${META}" WHERE k NOT IN (?, ?)`).run(MOVED_TO, COPY_OF);
      else src.exec(`CREATE TABLE x."${t}" (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID; INSERT INTO x."${t}" SELECT k, v FROM main."${t}"`);
    }
    if (copyOf) src.prepare(`INSERT INTO x."${META}"(k, v) VALUES (?, ?)`).run(COPY_OF, JSON.stringify(copyOf));
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
  await renameRetry(tmp, to);
}

// A source nobody can write: copy its file and WAL as they are, fold the WAL into the copy, then put it in place.
async function copyReadOnly(from: string, to: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
  const tmp = `${to}.part-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.copyFileSync(from, tmp);
    if (fs.existsSync(`${from}-wal`)) fs.copyFileSync(`${from}-wal`, `${tmp}-wal`);
    const db = new DatabaseSync(tmp);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    db.close();
  } catch (e) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    throw e;
  }
  await renameRetry(tmp, to);
}

function writable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function inspect(file: string): { copyOf?: Mark; movedTo?: Mark } {
  const raw = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  try {
    return { copyOf: readMark(raw, COPY_OF), movedTo: readMark(raw, MOVED_TO) };
  } finally {
    raw.close();
  }
}

// Delete a carton.db that is an unconfirmed or superseded copy, after making sure no process has it open: an exclusive
// lock is only granted when nobody else holds the file. Its WAL is folded in first, so no -wal is left behind to be
// replayed into whatever later takes the path.
function removeUnused(file: string): void {
  const raw = new DatabaseSync(file, { timeout: 0 });
  try {
    raw.exec("PRAGMA locking_mode=EXCLUSIVE");
    raw.exec("BEGIN EXCLUSIVE");
    raw.exec("COMMIT");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    raw.close();
    throw new Error(`${file} holds an old copy of this project's history and is still open in another program; close it and open the project again (${(e as Error).message})`);
  }
  raw.close();
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
