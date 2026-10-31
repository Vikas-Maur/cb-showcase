// Which files of a `.cardboard` bundle go into a `.cbproj` (PLAN §13, §16 H11).
//
// The walk mirrors Cardboard 1.4.0's own (`iS`). That takes every regular file in the bundle except:
//   - the top-level names in its set `nS`: cache/, converted/, proxies/ and .revs/, bytes that can be regenerated;
//   - top-level `.*.tmp`, its atomic-write temp files;
//   - top-level project.json, which it writes separately as the archive's manifest.
// Carton leaves out more (R5-03, R6-02):
//   - .carton/: the history database, displaced files and other local state. An export carries history only as its
//     own entry, the shallow export or the opt-in full copy;
//   - .carton-export/: where Cardboard's importer extracts a received copy's history entry. Each export writes a
//     fresh one, so an old one is never passed along;
//   - .scratch/views/: the per-agent view files. This one is nested, and `nS` is compared only with top-level names,
//     so it is a path-prefix check.
// Carton's own names are compared case-insensitively on Windows and macOS, whose file systems are: there `.Carton/`
// is the same folder as `.carton/`. Cardboard's names stay exact, as Cardboard compares them, so the walk keeps exactly
// what Cardboard's keeps, less what Carton excludes.
import fsp from "node:fs/promises";
import path from "node:path";

export const CARTON_DIR = ".carton";
export const EXPORT_DIR = ".carton-export";
export const SHALLOW_ENTRY = `${EXPORT_DIR}/shallow.json`;
export const FULL_ENTRY = `${EXPORT_DIR}/history.db`;
export const VIEWS_DIR = ".scratch/views";
export const MANIFEST = "project.json";
/** Cardboard refuses a `.cbproj` whose manifest is larger than this. */
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

/** Cardboard's top-level names left out of every `.cbproj`. */
const CARDBOARD_SKIPPED = new Set(["cache", "converted", "proxies", ".revs"]);
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

export interface BundleFile {
  /** The member name: relative to the bundle, `/`-separated on every platform. */
  archivePath: string;
  sourcePath: string;
  size: number;
}

/**
 * Whether the file or folder at `archivePath` (relative to the bundle, `/`-separated and canonical, as the walk
 * builds it) is left out of an export. The Windows patch calls this inside Cardboard's own walk.
 */
export function excludedFromExport(archivePath: string, foldCase = FOLD_CASE): boolean {
  const slash = archivePath.indexOf("/");
  const top = slash < 0 ? archivePath : archivePath.slice(0, slash);
  if (CARDBOARD_SKIPPED.has(top) || top === MANIFEST) return true;
  if (top.startsWith(".") && top.endsWith(".tmp")) return true;
  const p = foldCase ? archivePath.toLowerCase() : archivePath;
  const t = foldCase ? top.toLowerCase() : top;
  if (t === CARTON_DIR || t === EXPORT_DIR) return true;
  return p === VIEWS_DIR || p.startsWith(`${VIEWS_DIR}/`);
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

/**
 * The bundle's files that go into a `.cbproj`, sorted by archive path. An excluded folder is not descended into.
 * Only regular files are listed: `Dirent` types come from lstat, so a symlink is skipped, never followed, as in
 * Cardboard's walk.
 */
export async function walkBundle(dir: string, foldCase = FOLD_CASE): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const visit = async (abs: string, rel: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (rel !== "" && errCode(e) === "ENOENT") return; // removed since its parent was listed
      throw e;
    }
    await Promise.all(
      dirents.map(async (d) => {
        const archivePath = rel === "" ? d.name : `${rel}/${d.name}`;
        if (excludedFromExport(archivePath, foldCase)) return;
        const sourcePath = path.join(abs, d.name);
        if (d.isDirectory()) return visit(sourcePath, archivePath);
        if (!d.isFile()) return;
        try {
          files.push({ archivePath, sourcePath, size: (await fsp.stat(sourcePath)).size });
        } catch (e) {
          if (errCode(e) !== "ENOENT") throw e; // removed since the listing: an agent's temp file, say
        }
      }),
    );
  };
  await visit(dir, "");
  // Code-unit order, not localeCompare: the same on every machine.
  return files.sort((a, b) => (a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0));
}
