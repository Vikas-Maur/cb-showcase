// Open a project's carton.db where §6.4 says it lives: in the bundle, or in app data for bundles in cloud-synced
// folders, on network shares and on FAT/exFAT volumes (L15). When that place changed since the last open (the bundle
// moved into a synced folder, or back out), the history moves with it first (move.ts): it is never left behind for a
// new, empty database. Every process opening the project must pass the same `appDataDir`: the project's placement
// lock lives there.
import * as path from "node:path";
import { locateCartonDb, defaultAppDataDir, projectKey, type DbLocation, type LocateOptions } from "./location.ts";
import { openSqliteStore, type SqliteStore, type SqliteStoreOptions } from "./store.ts";
import { settlePlacement } from "./move.ts";

export interface ProjectStoreOptions extends LocateOptions, SqliteStoreOptions {}

export interface ProjectLocation extends DbLocation {
  /** A carton.db another machine made was found where this one goes, and moved here; offer it as their history. */
  setAside?: string;
}

export async function openProjectStore(opts: ProjectStoreOptions, hooks: { afterSettle?: () => Promise<void> } = {}): Promise<{ store: SqliteStore; location: ProjectLocation }> {
  const location: ProjectLocation = locateCartonDb(opts);
  if (opts.readOnly) return { store: await openSqliteStore(location.dbPath, opts), location };
  const projectDir = path.join(opts.appDataDir ?? defaultAppDataDir(), "projects", projectKey(opts.projectId));
  const inBundle = path.join(path.resolve(opts.bundleDir), ".carton", "carton.db");
  const inAppData = path.join(projectDir, "carton.db");
  // Settled and opened under one hold of the placement lock (`afterSettle` lets a test pause in between).
  const { opened, setAside } = await settlePlacement(location.dbPath, location.inBundle ? inAppData : inBundle, path.join(projectDir, "placement.lock"), async () => {
    await hooks.afterSettle?.();
    return openSqliteStore(location.dbPath, opts);
  });
  if (setAside) location.setAside = setAside;
  return { store: opened, location };
}
