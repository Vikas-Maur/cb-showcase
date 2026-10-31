// What makes a file a carton.db, and the rows store-sqlite keeps for itself in its `_carton` table.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { defaultAppDataDir } from "./location.ts";

/** "CRTN": marks carton.db files, so Carton never mistakes another SQLite file for its own. */
export const APPLICATION_ID = 0x4352544e;
/** On-disk format. A newer format is refused, never misread or rewritten. */
export const FORMAT_VERSION = 1;
/** store-sqlite's own table: one row per key below, JSON values. */
export const META = "_carton";

/** A random id per database file, made when it is created (a moved copy gets its own). */
export const DB_ID = "dbId";
/** The machine and OS user that created the file (`MachineMark`). */
export const MACHINE = "machine";
/** On a file whose history moved: `{path, token}` of where it went (move.ts). */
export const MOVED_TO = "movedTo";
/** On a moved copy: `{path, token, dbId}` of the file it was copied from (move.ts). */
export const COPY_OF = "copyOf";
/** Set once importProject has brought the project in (main@1, or nothing to import). */
export const IMPORTED = "imported";

/**
 * Which machine made a carton.db. `id` is random, kept in the per-user app-data folder, so renaming the computer
 * doesn't change it; `host` hashes the computer name, user and home folder, so wiping app data doesn't either. A file
 * is this machine's when either matches.
 */
export interface MachineMark {
  id: string;
  host: string;
}

let mine: MachineMark | null = null;
export function machineMark(): MachineMark {
  if (mine) return mine;
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    // no user database entry (some containers): the host and home folder still tell machines apart
  }
  const host = createHash("sha256").update([os.hostname(), user, os.homedir()].join("\0")).digest("hex").slice(0, 16);
  return (mine = { id: installId() ?? host, host });
}

// The random installation id, created once with an exclusive create so two processes starting together agree.
function installId(): string | null {
  const file = path.join(defaultAppDataDir(), "machine-id");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = fs.readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(id)) return id;
    } catch {
      // not made yet
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, randomBytes(16).toString("hex"), { flag: "wx" });
    } catch {
      // another process made it first (read it next turn), or app data can't be written (fall back to the host hash)
    }
  }
  return null;
}

/** Whether a file's machine mark is this machine's. Unknown (no mark) counts as this machine's. */
export function isThisMachine(mark: unknown, me: MachineMark = machineMark()): boolean {
  if (mark === undefined || mark === null) return true;
  const m = mark as Partial<MachineMark>;
  return m.id === me.id || m.host === me.host;
}

/** A row of `_carton`, or undefined (also when the table doesn't exist). */
export function readMeta<T = unknown>(raw: DatabaseSync, key: string, schema = "main"): T | undefined {
  if (raw.prepare(`SELECT 1 AS x FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(META) === undefined) return undefined;
  const row = raw.prepare(`SELECT v FROM ${schema}."${META}" WHERE k = ?`).get(key) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : undefined;
}

export function writeMeta(raw: DatabaseSync, key: string, value: unknown, schema = "main"): void {
  raw.prepare(`INSERT INTO ${schema}."${META}"(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(key, JSON.stringify(value));
}

/** SQLite reserves table names starting with "sqlite_" (any case); every other table is Carton's. */
export const USER_TABLES = "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND lower(substr(name, 1, 7)) <> 'sqlite_'";

export const newDbId = () => randomBytes(8).toString("hex");
