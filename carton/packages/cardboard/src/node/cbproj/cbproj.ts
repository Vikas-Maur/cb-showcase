// `.cbproj` collaboration (PLAN §13, §16 H11): what Carton adds to Cardboard's "Save As" file, and how a teammate's file
// comes back in.
//
// Export. Cardboard 1.4.0 writes a stored zip of the bundle (walk `iS`, minus cache/, converted/, proxies/, .revs/)
// with `project.json` as the manifest. Carton's export is the same file plus:
//   .carton-export/shallow.json   the shallow export (default): the current state, its lineage graph (fork, merge and
//                                 export nodes), those nodes' states delta-encoded against the head, a composed remap
//                                 per lineage edge, and the last author per record. No micro-changes, no scrapped cuts.
//   .carton-export/history.db     opt-in "Include history so they can see every version": a copy of carton.db with the
//                                 local tables dropped (path map, pins, notices, views, ephemeral data, sync lease)
// and without `.carton/` or `.scratch/views/` (H11: never ship Carton's database, its displaced files, or agents'
// view files, whose headers name pins the recipient doesn't have).
//
// Import. Reading a teammate's file gives the manifest, the shallow export and (if present) the full history. "Bring
// in their changes" imports their lineage as tracking knowledge and folds their head into the current cut, with cards;
// a missing merge base is said plainly, never replaced by an older one (core's fold).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Choices, ShallowExport } from "@carton/core";
import { ZipReader, ZipWriter, type ZipWriteResult } from "./zip.ts";
import { walkBundle, excludedFromExport, CARTON_DIR, EXPORT_DIR, FULL_ENTRY, MANIFEST, MANIFEST_MAX_BYTES, SHALLOW_ENTRY, VIEWS_DIR } from "./walk.ts";

export interface CbprojExportOptions {
  /** The project bundle (`<Name>.cardboard/`). */
  bundle: string;
  /** Where to write the `.cbproj`. Written as `<out>.part`, then renamed. */
  out: string;
  /** The manifest: 1.4.0's envelope `{format, version, project, media}`. Default: the bundle's project.json. In the app,
   *  Cardboard's own save-as builds it (media paths re-rooted into the bundle). */
  manifest?: Record<string, unknown>;
  /** Extra files, e.g. media Cardboard copies in from outside the bundle (`--no-copy` items). */
  extraFiles?: { archivePath: string; sourcePath: string }[];
  /** `carton.exportShallow({ to })`. */
  shallow: ShallowExport | null;
  /** "Include history": writes a copy of carton.db without local tables to the given path (store-sqlite's `exportCopy`). */
  fullHistory?: (toPath: string) => Promise<void>;
}

export interface CbprojExportResult extends ZipWriteResult {
  /** The archive paths written, in order. */
  names: string[];
}

export async function exportCbproj(o: CbprojExportOptions): Promise<CbprojExportResult> {
  const files = await walkBundle(o.bundle);
  const manifest = o.manifest ?? (JSON.parse(await fs.promises.readFile(path.join(o.bundle, MANIFEST), "utf8")) as Record<string, unknown>);
  const zip = await ZipWriter.create(o.out);
  const entries: string[] = [];
  let tmpDb: string | null = null;
  try {
    await zip.addBuffer(MANIFEST, Buffer.from(JSON.stringify(manifest), "utf8"));
    entries.push(MANIFEST);
    for (const f of files) {
      await zip.addFile(f.archivePath, f.sourcePath);
      entries.push(f.archivePath);
    }
    for (const f of o.extraFiles ?? []) {
      if (excludedFromExport(f.archivePath)) continue;
      await zip.addFile(f.archivePath, f.sourcePath);
      entries.push(f.archivePath);
    }
    if (o.shallow) {
      await zip.addBuffer(SHALLOW_ENTRY, Buffer.from(JSON.stringify(o.shallow), "utf8"));
      entries.push(SHALLOW_ENTRY);
    }
    if (o.fullHistory) {
      const dir = path.join(o.bundle, CARTON_DIR, "tmp");
      await fs.promises.mkdir(dir, { recursive: true });
      tmpDb = path.join(dir, `history-${randomBytes(6).toString("hex")}.db`);
      await o.fullHistory(tmpDb);
      await zip.addFile(FULL_ENTRY, tmpDb);
      entries.push(FULL_ENTRY);
    }
    const r = await zip.close();
    return { ...r, names: entries };
  } catch (e) {
    await zip.abort();
    throw e;
  } finally {
    if (tmpDb) await fs.promises.rm(tmpDb, { force: true });
  }
}

export interface CbprojContents {
  manifest: Record<string, unknown>;
  shallow: ShallowExport | null;
  /** Whether the file carries the full history (`.carton-export/history.db`). */
  hasFullHistory: boolean;
  /** Bundle files to unpack (everything except the manifest and Carton's entries). */
  files: string[];
  /** View files and Carton files a sender's file should never have had: never applied, never unpacked. */
  ignored: string[];
}

const SHALLOW_MAX_BYTES = 256 * 1024 * 1024;

/** Reads a `.cbproj`: the manifest, Carton's entries, and which bundle files it holds. */
export async function readCbproj(file: string): Promise<CbprojContents> {
  const z = await ZipReader.open(file);
  try {
    if (!z.has(MANIFEST)) throw new Error("Project file has no project.json");
    const manifest = JSON.parse((await z.readEntry(MANIFEST, MANIFEST_MAX_BYTES)).toString("utf8")) as Record<string, unknown>;
    const shallow = z.has(SHALLOW_ENTRY) ? (JSON.parse((await z.readEntry(SHALLOW_ENTRY, SHALLOW_MAX_BYTES)).toString("utf8")) as ShallowExport) : null;
    const files: string[] = [];
    const ignored: string[] = [];
    for (const e of z.entries) {
      if (e.name === MANIFEST || e.name === SHALLOW_ENTRY || e.name === FULL_ENTRY) continue;
      // 1.4.0's importer (yauzl, strictFileNames off) turns `\` into `/` before its own name check, so a member named
      // `.scratch\views\x.tsx` would land in `.scratch/views/`: judge names the way it will extract them
      const n = e.name.replace(/\\/g, "/");
      if (n === EXPORT_DIR || n.startsWith(`${EXPORT_DIR}/`) || excludedFromExport(n)) ignored.push(e.name);
      else files.push(e.name);
    }
    return { manifest, shallow, hasFullHistory: z.has(FULL_ENTRY), files, ignored };
  } finally {
    await z.close();
  }
}

/** Extracts the full-history copy to `toPath` (to be opened read-only and imported as tracking cuts). */
export async function extractFullHistory(file: string, toPath: string): Promise<boolean> {
  const z = await ZipReader.open(file);
  try {
    if (!z.has(FULL_ENTRY)) return false;
    await z.extractEntry(FULL_ENTRY, toPath);
    return true;
  } finally {
    await z.close();
  }
}

/** The part of the Carton handle "Bring in their changes" needs. */
export interface CbprojTarget {
  importShallow(pkg: ShallowExport): Promise<{ status: string; cut?: string; head?: string; newProjectId?: string }>;
  fold(from: string, opts?: { choices?: Choices; check?: boolean; missingBase?: "dialog" | "all-cards" }): Promise<{ status: string; [k: string]: unknown }>;
}

export type BringInResult =
  | { status: "no-carton-data" }
  | { status: "other-project" }
  | { status: "no-shared-lineage"; newProjectId?: string }
  | { status: "forked"; cut?: string }
  | { status: "folded"; fold: { status: string; [k: string]: unknown } };

/**
 * "Bring in their changes" (§13): their lineage becomes tracking knowledge, then their head is folded into the current
 * cut with cards. Opening a project you don't have forks a writable cut from theirs instead (§5.3). With `check`, the
 * fold is a dry run (`cb fold --check`).
 */
export async function bringInTheirChanges(target: CbprojTarget, contents: Pick<CbprojContents, "shallow">, opts: { choices?: Choices; check?: boolean; missingBase?: "dialog" | "all-cards" } = {}): Promise<BringInResult> {
  if (!contents.shallow) return { status: "no-carton-data" };
  const imp = await target.importShallow(contents.shallow);
  if (imp.status === "other-project") return { status: "other-project" };
  if (imp.status === "no-shared-lineage") return { status: "no-shared-lineage", ...(imp.newProjectId ? { newProjectId: imp.newProjectId } : {}) };
  if (imp.status === "forked") return { status: "forked", ...(imp.cut ? { cut: imp.cut } : {}) };
  const fold = await target.fold(imp.head ?? contents.shallow.head, opts);
  return { status: "folded", fold };
}

export { VIEWS_DIR as CBPROJ_VIEWS_DIR };
