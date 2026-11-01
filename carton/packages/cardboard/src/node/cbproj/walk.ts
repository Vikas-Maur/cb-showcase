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
//   - the view files Carton writes for agents, directly in .scratch/views/: a `<view>.tsx` whose first cardboard:rev line
//     is Carton's (`<cut>@<seq>~<hash8> b:<cut8>`, as core prints it; Cardboard 1.4.0's is a bare number), and its
//     status sidecar `<view>.status`, exactly the materializer's fields. Anything else there is a person's or an agent's
//     own (stock Cardboard tells agents to keep their working files in .scratch/) and travels, as in 1.4.0. The same
//     rule as the app's (windows-sync `19c9bce`, the store bridge's `cartonView`). A file is told by its content, so a
//     caller that has it passes it; by its path alone, a name that could be one of Carton's is left out.
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

/** A view file's head that holds its header (a print's header block is at the top). */
export const VIEW_HEAD_BYTES = 64 * 1024;
/** A status sidecar larger than this is not Carton's. */
export const VIEW_STATUS_MAX_BYTES = 16 * 1024 * 1024;
const VIEW_FILE = /^[a-z0-9._-]+\.(tsx|status)$/i;
const REV_LINE = /^[ \t]*\/\/[ \t]*cardboard:rev[ \t]+([^\r\n]*?)[ \t]*\r?$/m;
const CARTON_REV = /^.+@\d+~[0-9a-f]{8} b:[0-9A-Za-z_-]+(?: p:[0-9A-Za-z]+)?(?: by .*)?$/;
const STATUS_FIELDS = new Set(["status", "ref", "seq", "conflicts", "diagnostics", "change", "at", "error"]);
const STATUS_VALUES = new Set(["confirmed", "pending", "conflicts", "rejected", "error"]);

/**
 * Whether a file named `name`, directly in .scratch/views/, with this content is one Carton wrote: a view whose first
 * cardboard:rev line is Carton's, or a status sidecar with exactly the materializer's fields. `null`: it can't be read,
 * so it isn't Carton's. For a view only its first `VIEW_HEAD_BYTES` are read.
 */
export function cartonViewFile(name: string, content: Uint8Array | string | null): boolean {
  const m = /\.(tsx|status)$/i.exec(name);
  if (!m || !VIEW_FILE.test(name) || content === null) return false;
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (m[1]!.toLowerCase() === "tsx") {
    const rev = REV_LINE.exec(bytes.toString("utf8", 0, Math.min(bytes.length, VIEW_HEAD_BYTES)));
    return !!rev && CARTON_REV.test(rev[1]!);
  }
  if (bytes.length > VIEW_STATUS_MAX_BYTES) return false;
  let o: unknown;
  try {
    o = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  return (
    Object.keys(r).every((k) => STATUS_FIELDS.has(k)) &&
    STATUS_VALUES.has(r.status as string) &&
    "ref" in r &&
    "seq" in r &&
    "change" in r &&
    Array.isArray(r.conflicts) &&
    Array.isArray(r.diagnostics) &&
    typeof r.at === "number"
  );
}

/** Cardboard's top-level names left out of every `.cbproj`. */
const CARDBOARD_SKIPPED = new Set(["cache", "converted", "proxies", ".revs"]);
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

export interface BundleFile {
  /** The member name: relative to the bundle, `/`-separated on every platform. */
  archivePath: string;
  sourcePath: string;
  size: number;
}

/** Whether `archivePath` names a file directly in .scratch/views/ that could be one Carton wrote (by its name). */
export function viewFileCandidate(archivePath: string, foldCase = FOLD_CASE): boolean {
  const p = foldCase ? archivePath.toLowerCase() : archivePath;
  if (!p.startsWith(`${VIEWS_DIR}/`)) return false;
  const name = archivePath.slice(VIEWS_DIR.length + 1);
  return !name.includes("/") && VIEW_FILE.test(name);
}

/**
 * Whether the file or folder at `archivePath` (relative to the bundle, `/`-separated and canonical, as the walk
 * builds it) is left out of an export. A file in .scratch/views/ is told by its `content` (`cartonViewFile`; `null`
 * when it can't be read: kept); without it, a name that could be Carton's view file is left out.
 */
export function excludedFromExport(archivePath: string, foldCase = FOLD_CASE, content?: Uint8Array | string | null): boolean {
  const slash = archivePath.indexOf("/");
  const top = slash < 0 ? archivePath : archivePath.slice(0, slash);
  if (CARDBOARD_SKIPPED.has(top) || top === MANIFEST) return true;
  if (top.startsWith(".") && top.endsWith(".tmp")) return true;
  const t = foldCase ? top.toLowerCase() : top;
  if (t === CARTON_DIR || t === EXPORT_DIR) return true;
  if (!viewFileCandidate(archivePath, foldCase)) return false;
  return content === undefined ? true : cartonViewFile(path.posix.basename(archivePath), content);
}

/** The part of a file at `sourcePath` that tells whether it is Carton's view file (`cartonViewFile`), or null. */
export async function readViewFileHead(sourcePath: string, name: string): Promise<Buffer | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(sourcePath, "r");
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const status = /\.status$/i.test(name);
    if (status && st.size > VIEW_STATUS_MAX_BYTES) return null;
    const want = status ? st.size : Math.min(st.size, VIEW_HEAD_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } catch {
    return null; // can't be read: not Carton's, kept
  } finally {
    await fh?.close().catch(() => undefined);
  }
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
        const sourcePath = path.join(abs, d.name);
        // a file in .scratch/views/ is told by its content below; a folder there is never Carton's
        const view = viewFileCandidate(archivePath, foldCase);
        if (!view && excludedFromExport(archivePath, foldCase)) return;
        if (d.isDirectory()) return visit(sourcePath, archivePath);
        if (!d.isFile()) return;
        if (view && cartonViewFile(d.name, await readViewFileHead(sourcePath, d.name))) return;
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
