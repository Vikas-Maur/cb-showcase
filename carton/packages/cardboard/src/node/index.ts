// @carton/cardboard/node: the parts of the Cardboard adapter that touch the file system (Node and Electron only).
// PLAN §6.4 (displace, then install; quiescence; per-agent views; the shared timeline.tsx) and §13 (.cbproj).
export * from "./displace.ts";
export * from "./displaced.ts";
export * from "./install-lock.ts";
export * from "./materializer.ts";
export * from "./migrate.ts";
export * from "./carton-engine.ts";
export { exportCbproj, readCbproj, extractFullHistory, importFullHistory, bringInTheirChanges } from "./cbproj/cbproj.ts";
export type { CbprojExportOptions, CbprojExportResult, CbprojContents, CbprojTarget, BringInResult, HistoryTarget, FullHistoryOptions, FullHistoryResult } from "./cbproj/cbproj.ts";
export { ZipWriter, ZipReader, sanitizeEntryName, safeEntryPath } from "./cbproj/zip.ts";
export { walkBundle, excludedFromExport, SHALLOW_ENTRY, FULL_ENTRY, EXPORT_DIR } from "./cbproj/walk.ts";
