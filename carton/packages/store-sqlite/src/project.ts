// Open a project's carton.db where §6.4 says it lives: in the bundle, or in app data for bundles in cloud-synced
// folders, on network shares and on FAT/exFAT volumes (L15).
import { locateCartonDb, type DbLocation, type LocateOptions } from "./location.ts";
import { openSqliteStore, type SqliteStore, type SqliteStoreOptions } from "./store.ts";

export interface ProjectStoreOptions extends LocateOptions, SqliteStoreOptions {}

export async function openProjectStore(opts: ProjectStoreOptions): Promise<{ store: SqliteStore; location: DbLocation }> {
  const location = locateCartonDb(opts);
  const store = await openSqliteStore(location.dbPath, opts);
  return { store, location };
}
