// Open a project's carton.db where §6.4 says it lives: in the bundle, or in app data for bundles in cloud-synced
// folders, on network shares and on FAT/exFAT volumes (L15). When that place changed since the last open (the bundle
// moved into a synced folder, or back out), the history moves with it first (move.ts): it is never left behind for a
// new, empty database.
import * as path from "node:path";
import { locateCartonDb, defaultAppDataDir, projectKey, type DbLocation, type LocateOptions } from "./location.ts";
import { openSqliteStore, type SqliteStore, type SqliteStoreOptions } from "./store.ts";
import { settlePlacement } from "./move.ts";

export interface ProjectStoreOptions extends LocateOptions, SqliteStoreOptions {}

export async function openProjectStore(opts: ProjectStoreOptions): Promise<{ store: SqliteStore; location: DbLocation }> {
  const location = locateCartonDb(opts);
  const inBundle = path.join(path.resolve(opts.bundleDir), ".carton", "carton.db");
  const inAppData = path.join(opts.appDataDir ?? defaultAppDataDir(), "projects", projectKey(opts.projectId), "carton.db");
  if (!opts.readOnly) await settlePlacement(location.dbPath, location.inBundle ? inAppData : inBundle);
  const store = await openSqliteStore(location.dbPath, opts);
  return { store, location };
}
