// Store plug-in on node:sqlite (PLAN §3.1, §6.2): `.carton/carton.db` in WAL mode, shared by the library worker's
// engine thread, `cb`/MCP processes and the headless helper. Conditional batches run under BEGIN IMMEDIATE, so they are
// the cross-process CAS the local sequencer and the sync lease rely on (P3); waiting for another process's lock is
// asynchronous (P3b). Windows: the db lives outside cloud-sync folders, network shares and FAT volumes (§6.4, L15);
// paths may be non-ASCII. Owner: stores.
export { SqliteStore, openSqliteStore, type SqliteStoreOptions } from "./store.ts";
export { FORMAT_VERSION, machineMark, isThisMachine, type MachineMark } from "./format.ts";
export { BusyError } from "./db.ts";
export { MovedError, PlacementConflictError, UnwritableHistoryError, settlePlacement } from "./move.ts";
export {
  locateCartonDb,
  detectCloudSync,
  defaultAppDataDir,
  projectKey,
  nodeProbe,
  parseSyncRootManager,
  type DbLocation,
  type DbPlacement,
  type LocateOptions,
  type LocationProbe,
} from "./location.ts";
export { openProjectStore, type ProjectStoreOptions, type ProjectLocation } from "./project.ts";
export { importProject, importChangeId, IMPORT_AUTHOR, type ImportProjectOptions, type ImportedProject } from "./import.ts";
