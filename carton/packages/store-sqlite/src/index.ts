// Store plug-in on node:sqlite (PLAN §3.1, §6.2): `.carton/carton.db` in WAL mode, shared by the library worker's
// engine thread, `cb`/MCP processes and the headless helper. Conditional batches run under BEGIN IMMEDIATE, so they are
// the cross-process CAS the local sequencer and the sync lease rely on (P3). Windows: the db lives outside cloud-sync
// folders and FAT volumes (§6.4, L15); paths may be non-ASCII. Owner: stores.
import type { Store } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface SqliteStoreOptions {
  /** ms to wait for another process's write lock (default 5000). */
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

export interface SqliteStore extends Store {
  readonly path: string;
  /**
   * `VACUUM INTO` a copy for a full-history `.cbproj`, with the local tables dropped (path map, pins, notices,
   * ephemeral data, sync lease: `LOCAL_TABLES` in @carton/core).
   */
  exportCopy(toPath: string, dropTables: readonly string[]): Promise<void>;
}

export async function openSqliteStore(path: string, opts: SqliteStoreOptions = {}): Promise<SqliteStore> {
  return todo("openSqliteStore");
}
