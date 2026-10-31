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
// and without `.carton/` or the view files Carton writes in `.scratch/views/` (H11: never ship Carton's database, its
// displaced files, or agents' view files, whose headers name pins the recipient doesn't have). A person's or an agent's
// own files in `.scratch/views/` travel, as in 1.4.0 (walk.ts, the app's rule too).
//
// Import. Reading a teammate's file gives the manifest, the shallow export and (if present) the full history. "Bring
// in their changes" imports their lineage as tracking knowledge and folds their head into the current cut, with cards;
// a missing merge base is said plainly, never replaced by an older one (core's fold). A file with history also brings
// the sender's versions (S3-2): `importFullHistory` opens its copy and hands it to core's `Carton.importHistory`, which
// fills their cuts in as read-only cuts with every version, author and name (Open Project: after `Carton.open` with
// `init: {import}`; Bring in: before the shallow import when the file extends a cut held here, else after it, and
// before the fold).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hashDoc } from "@carton/core";
import type { Choices, Doc, Schema, ShallowExport } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { ZipReader, ZipWriter, sanitizeEntryName, type ZipWriteResult } from "./zip.ts";
import { retryMissing } from "../displace.ts";
import { walkBundle, excludedFromExport, viewFileCandidate, readViewFileHead, VIEW_STATUS_MAX_BYTES, CARTON_DIR, EXPORT_DIR, FULL_ENTRY, MANIFEST, MANIFEST_MAX_BYTES, SHALLOW_ENTRY, VIEWS_DIR } from "./walk.ts";

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
  /**
   * The engine's head when the file is written, with the host's conversion: the manifest's project is then that head
   * (unversioned fields kept from the manifest), so Cardboard opening the file sees the same timeline the shallow export
   * carries, even if project.json on disk hasn't caught up yet.
   */
  head?: { doc: Doc; toProject: (doc: Doc, current: Record<string, unknown> | null) => Record<string, unknown> };
  /** "Include history": writes a copy of carton.db without local tables to the given path (store-sqlite's `exportCopy`). */
  fullHistory?: (toPath: string) => Promise<void>;
}

export interface CbprojExportResult extends ZipWriteResult {
  /** The archive paths written, in order. */
  names: string[];
}

// The shared file Carton re-installs while the app runs: a Save As during an install can find it missing for a moment.
const SHARED_FILE = "timeline.tsx";

export async function exportCbproj(o: CbprojExportOptions): Promise<CbprojExportResult> {
  const files = await walkBundle(o.bundle);
  // a listing made while Carton installed the shared file misses it: look once more, through the install's window
  if (!files.some((f) => f.archivePath === SHARED_FILE)) {
    const sourcePath = path.join(o.bundle, SHARED_FILE);
    // lstat, as the walk: a symlink is never followed out of the bundle
    const st = await retryMissing(() => fs.promises.lstat(sourcePath), { bundle: o.bundle }).catch(() => null);
    if (st?.isFile()) files.push({ archivePath: SHARED_FILE, sourcePath, size: st.size });
  }
  let manifest = o.manifest ?? (JSON.parse(await retryMissing(() => fs.promises.readFile(path.join(o.bundle, MANIFEST), "utf8"), { bundle: o.bundle })) as Record<string, unknown>);
  if (o.head) manifest = { ...manifest, project: o.head.toProject(o.head.doc, (manifest.project as Record<string, unknown> | undefined) ?? null) };
  const zip = await ZipWriter.create(o.out);
  const entries: string[] = [];
  let tmpDb: string | null = null;
  try {
    await zip.addBuffer(MANIFEST, Buffer.from(JSON.stringify(manifest), "utf8"));
    entries.push(MANIFEST);
    for (const f of files) {
      await retryMissing(() => zip.addFile(f.archivePath, f.sourcePath), { bundle: o.bundle }); // fails before writing anything if absent
      entries.push(f.archivePath);
    }
    for (const f of o.extraFiles ?? []) {
      const view = viewFileCandidate(f.archivePath) ? await readViewFileHead(f.sourcePath, path.posix.basename(f.archivePath)) : undefined;
      if (excludedFromExport(f.archivePath, undefined, view)) continue;
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
// Two names that differ only in case land on one file on Windows and macOS.
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

/** A member's content, to tell a Carton view file (`cartonViewFile`), or null when it can't be read (then it isn't). */
async function memberContent(z: ZipReader, entry: ZipReader["entries"][number], name: string): Promise<Buffer | null> {
  try {
    return await z.readMember(entry, /\.status$/i.test(name) ? VIEW_STATUS_MAX_BYTES : MANIFEST_MAX_BYTES);
  } catch {
    return null;
  }
}

/** Reads a `.cbproj`: the manifest, Carton's entries, and which bundle files it holds. */
export async function readCbproj(file: string): Promise<CbprojContents> {
  const z = await ZipReader.open(file);
  try {
    if (!z.has(MANIFEST)) throw new Error("Project file has no project.json");
    const manifest = JSON.parse((await z.readEntry(MANIFEST, MANIFEST_MAX_BYTES)).toString("utf8")) as Record<string, unknown>;
    const shallow = z.has(SHALLOW_ENTRY) ? (JSON.parse((await z.readEntry(SHALLOW_ENTRY, SHALLOW_MAX_BYTES)).toString("utf8")) as ShallowExport) : null;
    const files: string[] = [];
    const ignored: string[] = [];
    const taken = new Set<string>([MANIFEST]);
    for (const e of z.entries) {
      if (e.name === MANIFEST || e.name === SHALLOW_ENTRY || e.name === FULL_ENTRY) continue;
      // Judge every name the way 1.4.0's importer will extract it: yauzl (strictFileNames off) turns `\` into `/`, and
      // the extraction drops empty and `.` segments, so `.scratch\views\x.tsx` and `./.carton/carton.db` land in the
      // excluded folders. Unsafe names, and a second member that lands on the same path, are ignored too.
      const n = sanitizeEntryName(e.name.replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".").join("/"));
      const key = n !== null && FOLD_CASE ? n.toLowerCase() : n;
      // a member that lands directly in .scratch/views/ is told by its content: only Carton's view files are left out
      const view = n !== null && viewFileCandidate(n) ? await memberContent(z, e, n) : undefined;
      if (n === null || key === null || taken.has(key) || n === EXPORT_DIR || n.startsWith(`${EXPORT_DIR}/`) || excludedFromExport(n, undefined, view)) {
        ignored.push(e.name);
        continue;
      }
      taken.add(key);
      files.push(e.name);
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

/** The part of the Carton handle that takes a full-history copy (`Carton.importHistory`). */
export interface HistoryTarget {
  importHistory(from: Store): Promise<{ cuts: string[] }>;
}

export interface FullHistoryOptions {
  /**
   * Opens the extracted copy as a Store: in the app, store-sqlite's `openSqliteStore(path, { readOnly: true })`. It is
   * closed (if it has `close`) and the copy removed afterwards.
   */
  openStore: (path: string) => Promise<Store>;
  /** A folder for the extracted copy (default: the OS temp folder). */
  tmpDir?: string;
}

export type FullHistoryResult =
  | { status: "no-history" }
  | { status: "imported"; cuts: string[] }
  /** core refused it: another project's history, another document schema, or a copy it can't read. */
  | { status: "refused"; reason: string };

/**
 * "Include history so they can see every version" (§13, L17; S3-2): the file's full-history copy is extracted, opened
 * (`openStore`) and taken by core's `importHistory`: the sender's cuts this replica doesn't hold in full become read-only
 * cuts with their versions, authors and names (a cut held as shallow lineage from the same file is filled in). Open
 * Project calls it after its `init: {import}`; `bringInTheirChanges` (with `history`) calls it before the shallow import
 * when the file extends lineage held here, after it otherwise. Taking the same file twice takes nothing new.
 */
export async function importFullHistory(target: HistoryTarget, file: string, o: FullHistoryOptions): Promise<FullHistoryResult> {
  const dir = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), "cbproj-history-"));
  try {
    const db = path.join(dir, "history.db");
    try {
      if (!(await extractFullHistory(file, db))) return { status: "no-history" };
    } catch (e) {
      // a damaged entry (bad CRC, truncated): the history is optional, the rest of the file still comes in
      return { status: "refused", reason: `the file's history can't be read: ${e instanceof Error ? e.message : String(e)}` };
    }
    let store: Store;
    try {
      store = await o.openStore(db);
    } catch (e) {
      return { status: "refused", reason: `the history copy can't be opened: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      const r = await target.importHistory(store);
      return { status: "imported", cuts: r.cuts };
    } catch (e) {
      return { status: "refused", reason: e instanceof Error ? e.message : String(e) };
    } finally {
      await (store as { close?: () => Promise<void> | void }).close?.();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // the copy and any -wal/-shm beside it
  }
}

/** The part of the Carton handle "Bring in their changes" needs. */
export interface CbprojTarget {
  importShallow(pkg: ShallowExport): Promise<{ status: string; cut?: string; head?: string; newProjectId?: string }>;
  fold(from: string, opts?: { choices?: Choices; check?: boolean; missingBase?: "dialog" | "all-cards" }): Promise<{ status: string; [k: string]: unknown }>;
  importHistory?(from: Store): Promise<{ cuts: string[] }>;
  /** For the copied-project check (S3-4); `Carton` has them all. */
  cuts?(): Promise<{ id: string; name: string; tracking?: boolean; shallow?: boolean; sequencer?: { kind: string } }[]>;
  head?(cut?: string): Promise<{ ref: { seq: number } }>;
  resolve?(ref: { branchId: string; seq: number }): Promise<{ doc: Doc }>;
  readonly schema?: Schema;
}

/**
 * The file names states on a cut this replica holds as its own (same cut id) that it doesn't have: on a shared cut,
 * this replica is behind its server (`behind`: asked to sync first, before anything is imported); on a local cut, the
 * sender's project is a copy of this one (the bundle folder copied with its `.carton`, so both hold "Main cut" under
 * one id) that went its own way (S3-4). Core takes such a copy's cut in as a cut of its own and folds it; this is only
 * the reason given if core refuses or fails there. Returns the cut and which case, or null when every node checks out.
 */
async function sameCutConflict(target: CbprojTarget, pkg: ShallowExport): Promise<{ cut: string; behind: boolean } | null> {
  if (!target.cuts || !target.head || !target.resolve || !target.schema) return null;
  const own = new Map((await target.cuts()).filter((c) => !c.tracking && !c.shallow).map((c) => [c.id, c]));
  const heads = new Map<string, number>();
  for (const n of pkg.nodes) {
    const c = own.get(n.branchId);
    if (!c) continue;
    if (!heads.has(c.id)) heads.set(c.id, (await target.head(c.id)).ref.seq);
    const shared = !!c.sequencer && c.sequencer.kind !== "local";
    if (n.seq > heads.get(c.id)!) return { cut: c.name, behind: shared };
    const doc = (await target.resolve({ branchId: c.id, seq: n.seq })).doc;
    if (hashDoc(doc, target.schema) !== n.hash) return { cut: c.name, behind: false };
  }
  return null;
}

/**
 * Whether the file names a version on a cut this replica holds (its own, read-only, or shallow lineage): its history
 * then extends what is here. Not for a fresh replica, or a project of the same id with no shared lineage: there its
 * history would come in unrelated before core answers "no-shared-lineage", and the fold would merge it.
 */
async function extendsHeldLineage(target: CbprojTarget, pkg: ShallowExport): Promise<boolean> {
  if (!target.cuts) return false;
  const held = new Set((await target.cuts()).map((c) => c.id));
  return pkg.nodes.some((n) => held.has(n.branchId));
}

export type BringInResult = (
  | { status: "no-carton-data" }
  | { status: "other-project" }
  /**
   * S3-4 fallback: the file comes from a copy of this project that went its own way on the same cut, and core refused
   * or failed to bring it in (core takes such a cut in as one of its own); nothing was folded.
   */
  | { status: "diverged-copy"; cut: string; reason: string }
  /** The file names newer states of a shared cut than this replica has: sync, then bring it in again. */
  | { status: "behind"; cut: string; reason: string }
  | { status: "no-shared-lineage"; newProjectId?: string }
  | { status: "forked"; cut?: string }
  | { status: "folded"; fold: { status: string; [k: string]: unknown } }
) & { history?: FullHistoryResult };

/**
 * "Bring in their changes" (§13): their lineage becomes tracking knowledge, then their head is folded into the current
 * cut with cards. Opening a project you don't have forks a writable cut from theirs instead (§5.3). With `check`, the
 * fold is a dry run (`cb fold --check`).
 */
export async function bringInTheirChanges(
  target: CbprojTarget,
  contents: Pick<CbprojContents, "shallow">,
  opts: { choices?: Choices; check?: boolean; missingBase?: "dialog" | "all-cards"; history?: FullHistoryOptions & { file: string } } = {},
): Promise<BringInResult> {
  if (!contents.shallow) return { status: "no-carton-data" };
  // checked before anything is imported (afterwards a same-id cut's lineage may read as ours)
  const clash = await sameCutConflict(target, contents.shallow);
  if (clash?.behind) return { status: "behind", cut: clash.cut, reason: `This file has newer versions of "${clash.cut}" than this computer has yet. Sync, then bring it in again.` };
  // a diverged copy (S3-4) is core's to bring in, as a cut of its own; only if core refuses or fails is the reason ours.
  // Its answers otherwise stand, "up-to-date" too (the same file brought in a second time)
  const diverged = (detail: string): BringInResult => ({
    status: "diverged-copy",
    cut: clash!.cut,
    reason: `This file comes from a copy of this project that has its own changes on "${clash!.cut}", and Carton couldn't bring them in (${detail}). Open the file as a new project instead.`,
  });
  // their versions too, when the file has them (S3-2); a refused history never stops the fold (it is said). First when
  // the file extends a cut held here (windows-sync's request): its versions, authors and names land in order, and the
  // shallow step then finds them known, instead of core's `#unclash` setting a later file's newer versions of a cut
  // held read-only apart as `<cut>.<hash8>`, a separate starting point. A diverged copy (S3-4) too: core's
  // `importHistory` never touches this replica's own cuts, and the shallow step then takes the copy's cut in as before
  const wantHistory = !!opts.history && !!target.importHistory && !opts.check;
  const first = wantHistory && (await extendsHeldLineage(target, contents.shallow)) ? await importFullHistory(target as HistoryTarget, opts.history!.file, opts.history!) : undefined;
  try {
    const imp = await target.importShallow(contents.shallow);
    const early = first ? { history: first } : {};
    if (imp.status === "other-project") return { status: "other-project", ...early };
    if (imp.status === "no-shared-lineage") return { status: "no-shared-lineage", ...(imp.newProjectId ? { newProjectId: imp.newProjectId } : {}), ...early };
    if (clash && imp.status !== "imported" && imp.status !== "forked") return diverged(`it answered "${imp.status}"`);
    const history = first ?? (wantHistory ? await importFullHistory(target as HistoryTarget, opts.history!.file, opts.history!) : undefined);
    const h = history ? { history } : {};
    if (imp.status === "forked") return { status: "forked", ...(imp.cut ? { cut: imp.cut } : {}), ...h };
    const { choices, check, missingBase } = opts;
    const fold = await target.fold(imp.head ?? contents.shallow.head, { ...(choices ? { choices } : {}), ...(check !== undefined ? { check } : {}), ...(missingBase ? { missingBase } : {}) });
    return { status: "folded", fold, ...h };
  } catch (e) {
    if (clash) return diverged(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export { VIEWS_DIR as CBPROJ_VIEWS_DIR };
