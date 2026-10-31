// H11 "Bring in their changes" (PLAN §13, §16 H11; carton/docs/INTEGRATION-1.4.0.md §4.5): what Carton adds to
// Cardboard's own .cbproj Save As and Open Project, in both copies of them (the CLI's and the library worker's).
// build.js bundles this file into carton-node.cjs (worker.js imports it), so it shares the facade's one copy of
// @carton/*. The patches (patches/cbproj.js) reach it through globalThis.__cartonCbproj, set below, and only with
// Carton on.
//
// - Save As: Cardboard's own zip writer, its own walk. The entry list gains `.carton-export/shallow.json`, the shallow
//   export of the project's current cut (`Carton.exportShallow`, which records an export node: the lineage a later
//   bring-in finds its merge base in). An old `.carton-export/` in the bundle (a received copy's, extracted with Carton
//   off) is left out: only a fresh export is ever passed along.
//   "Include history" (PLAN §13, "so they can see every version"; Cardboard's dialog has no switch for it): with
//   CARTON_CBPROJ_HISTORY=1 in the environment of the app or of cb, the file also carries `.carton-export/history.db`,
//   store-sqlite's copy of carton.db without core's LOCAL_TABLES (path map, pins, notices, views, ephemeral data, sync
//   lease, pending rows), as the adapter's exportCbproj is given it.
//   On a cut shared live with edits still waiting to sync (offline), the file gets neither: core exports confirmed
//   versions only, so its history would lack edits its project.json shows, and a teammate bringing it in would silently
//   miss them. The file is then a 1.4.0 file (it still holds everything you see), and the log says why.
// - Open Project, a project you don't have: Cardboard imports it as 1.4.0 does. The patch's preamble first removes any
//   `.carton/` and `.scratch/views/` the file planted in the staged bundle (Carton on or off: a crafted file's
//   carton.db could name a sync lease or a helper recipe a later cb run would load). Then, before the bundle is first
//   read, its history starts from the sender's shallow export (`init: {import}`), a writable cut forked from theirs,
//   so the two copies share a lineage and later exchanges fold in with the right base; with the file's history, the
//   sender's cuts come in as read-only cuts with every version, author and name. `.carton-export/` is then removed.
// - Open Project, a project you have with history: in place of "This project ID already exists in your library",
//   "Bring in their changes" — their lineage (and history, if the file has it) is imported as tracking knowledge and
//   their head is folded into your current cut. Where you both changed the same thing, theirs goes in and yours is
//   kept on a conflict card (`cb conflicts`; `cb resolve <n> --keep mine` puts yours back; the History panel). Clips
//   they added come with their files. A missing merge base, a file newer than this computer's copy of a shared cut, a
//   copy of the project that went its own way, or no shared lineage is said plainly. Head then goes into
//   project.json, and the import answers with your project.
// - A file without Carton's entry, a project without history, or Carton off: 1.4.0's import and its error.
// View files and Carton's database never come in: the .cbproj walk leaves them out (skipInArchive), readCbproj ignores
// them, the preamble removes them from a staged bundle, and nothing here applies them.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { extend, cardboard14 } from "../carton-node.js";
import { Carton, LOCAL_TABLES } from "@carton/core";
import { cardboardAdapter, materializeProject } from "@carton/cardboard";
import { readCbproj, bringInTheirChanges, importFullHistory, ZipReader, SHALLOW_ENTRY, FULL_ENTRY, EXPORT_DIR } from "@carton/cardboard/node";
import { openLocal, identify, nodeHasher } from "@carton/local";
import { openProjectStore, openSqliteStore } from "@carton/store-sqlite";
import { headScope } from "./scope.js";

const errText = (e) => (e && e.message) || String(e);
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn("[carton] " + msg); } };

// In the library worker the facade's api (its own handles, materialize, the person); null in cb.
let api = null;
extend({ name: "cbproj", worker(a) { api = a; return {}; } });

const CARTON_DIR = ".carton";
// "Include history" is opt-in, by environment (read at each Save As).
const includeHistory = () => /^(1|true|yes|on)$/i.test(process.env.CARTON_CBPROJ_HISTORY ?? "");

// As the facade decides it: a project has history when its carton.db is in the bundle.
const hasHistory = (bundle) => fs.existsSync(path.join(bundle, CARTON_DIR, "carton.db"));
const readProject = (bundle) => { try { return JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project ?? null; } catch { return null; } };
// Carton's own names compare case-insensitively where the file system does (as the adapter's walk does).
const FOLD = process.platform === "win32" || process.platform === "darwin";
const sameName = (name, want) => (FOLD ? name.toLowerCase() : name) === want;
const inExportDir = (archivePath) => sameName(String(archivePath).split("/")[0], EXPORT_DIR);
// The bundle's child named `want` as Carton compares names (`.Carton-Export` on Windows), or null.
const childDir = (dir, want) => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  const n = names.find((x) => sameName(x, want));
  return n === undefined ? null : path.join(dir, n);
};

// Windows refuses to remove a folder while something (an indexer, an antivirus scan) has a file in it open: try again
// for a few seconds, on timers (the library worker's loop keeps answering meanwhile).
async function removeDir(dir) {
  for (let i = 0; ; i++) {
    try { return fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {
      if (i >= 50 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * The project's Carton for one call. In the worker it is the facade's handle (the one its saves, the History panel and
 * live sync use). In cb, a handle of its own, closed after the call; the facade's, if it has one open too, reads the
 * same carton.db and refreshes from it before every read and write.
 */
async function withCarton(bundle, projectId, fn) {
  if (api) {
    const lc = await api.open(bundle);
    if (!lc) throw new Error("History isn't available for this project");
    return fn(lc);
  }
  const lc = await openLocal({ projectDir: bundle, projectId });
  try { return await fn(lc); } finally { await lc.close().catch(() => {}); }
}

// A folder inside the bundle's `.carton/` for history copies on their way into or out of a file: never the OS temp
// folder (a small shared tmpfs on some machines, another volume on others), and never part of a .cbproj (the walk
// leaves `.carton/` out).
const tmpDirOf = (bundle) => {
  const dir = path.join(bundle, CARTON_DIR, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const HISTORY_TMP = /^history-[0-9a-f]+\.db$/;
// A Save As that failed between making its history copy and writing the file leaves the copy behind: copies older
// than an hour go at the next Save As of that project.
function sweepHistoryCopies(bundle) {
  const dir = path.join(bundle, CARTON_DIR, "tmp");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!HISTORY_TMP.test(n)) continue;
    try { const p = path.join(dir, n); if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) fs.rmSync(p, { force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- Save As
/**
 * Cardboard's list of entries for a .cbproj of `bundle` ({archivePath, sourcePath | bytes, size}), with Carton's: no
 * old `.carton-export/`, the shallow export as its own entry when the project has history, and with "Include history"
 * the history copy (a file in `.carton/tmp/`, marked `cartonTmp`: `saved(entries)` removes it once the zip is
 * written). A failure leaves the file without them (said in the log): the Save As still happens, as a 1.4.0 file.
 */
async function exportEntries(bundle, entries) {
  const out = entries.filter((e) => !inExportDir(e.archivePath));
  if (!hasHistory(bundle)) return out;
  sweepHistoryCopies(bundle);
  const name = path.basename(bundle);
  try {
    const projectId = readProject(bundle)?.id;
    await withCarton(bundle, projectId, async (lc) => {
      const c = lc.carton;
      // Round 2 #4: a shared cut's head is its optimistic state (confirmed versions plus this computer's edits still
      // waiting for the server), but exportShallow exports confirmed versions only. Rather than a file whose history
      // lacks edits its project.json shows (a teammate's bring-in would miss them without a word), no history at all.
      const waiting = (await c.head()).ref.pending?.length ?? 0;
      if (waiting) {
        console.warn(`[carton] the .cbproj of ${name} was saved without its history: ${waiting} edit${waiting === 1 ? " is" : "s are"} still waiting to sync, and a file's history can only hold synced versions. The file has everything you see; save it again once you are back online so a teammate can bring its changes in.`);
        return;
      }
      const pkg = await c.exportShallow({});
      const bytes = Buffer.from(JSON.stringify(pkg), "utf8");
      out.push({ archivePath: SHALLOW_ENTRY, bytes, size: bytes.byteLength });
      if (!includeHistory()) return;
      const tmp = path.join(tmpDirOf(bundle), `history-${randomBytes(6).toString("hex")}.db`);
      try {
        // the same local tables the adapter's exportCbproj leaves out (core's LOCAL_TABLES)
        await lc.store.exportCopy(tmp, [...LOCAL_TABLES]);
        out.push({ archivePath: FULL_ENTRY, sourcePath: tmp, size: fs.statSync(tmp).size, cartonTmp: true });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        console.warn(`[carton] the .cbproj of ${name} was saved without its full history (its current state and lineage are in it): ${errText(e)}`);
      }
    });
  } catch (e) {
    warnOnce("export:" + bundle, `the .cbproj of ${name} was saved without its history (a teammate can open it, but not bring its changes back in): ${errText(e)}`);
  }
  return out;
}

/** After Cardboard wrote (or failed to write) the zip: the history copy made for it goes. */
async function saved(entries) {
  for (const e of entries ?? []) {
    if (!e?.cartonTmp) continue;
    try { await removeDir(e.sourcePath); } catch (err) { warnOnce("tmp:" + e.sourcePath, `couldn't remove ${e.sourcePath}: ${errText(err)}`); }
  }
}

// ---------------------------------------------------------------- Open Project, a project you don't have
/**
 * The file's history copy (`history.db`, extracted next to the shallow export, or by importFullHistory) into `c`: the
 * sender's cuts become read-only cuts with their versions, authors and names. Optional: a copy that can't be opened or
 * that core refuses (another project's, another schema's) is logged once and the rest goes on. Opened read-only and
 * closed before its folder is removed.
 */
async function takeHistory(c, file, label) {
  let hs = null;
  try {
    hs = await openSqliteStore(file, { readOnly: true });
    await c.importHistory(hs);
  } catch (e) {
    warnOnce("history:" + label, `the versions in ${label}'s file weren't brought in (its current state was): ${errText(e)}`);
  } finally {
    await hs?.close().catch(() => {});
  }
}

/**
 * A staged bundle Cardboard has just extracted from a .cbproj, before it is first read: its history starts from the
 * sender's shallow export, a writable cut forked from theirs, then takes the file's history if it has one.
 * `.carton-export/` never stays in a bundle. Without the entry, or if it can't be used, the facade starts the history
 * from project.json as for any project (main@1). The preamble has already removed a planted `.carton/` and
 * `.scratch/views/`; a bundle that still has a carton.db is refused rather than opened.
 */
async function seed(bundle) {
  const name = path.basename(bundle);
  if (hasHistory(bundle)) throw new Error(`The project file's ${CARTON_DIR} folder couldn't be removed, so it isn't opened.`);
  const exportDir = childDir(bundle, EXPORT_DIR);
  if (!exportDir) return;
  try {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(exportDir, "shallow.json"), "utf8")); } catch {}
    if (!pkg) return;
    const projectId = readProject(bundle)?.id;
    if (!projectId || pkg.projectId !== projectId) return warnOnce("seed:" + bundle, `the history in ${name}'s file is another project's; it starts from its project.json`);
    let store = null, c = null;
    try {
      ({ store } = await openProjectStore({ bundleDir: bundle, projectId }));
      c = await Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, actor: actorHere(), init: { import: pkg } });
      const history = childDir(exportDir, "history.db");
      if (history) await takeHistory(c, history, name);
      await c.close();
      c = null;
    } catch (e) {
      warnOnce("seed:" + bundle, `the history in ${name}'s file couldn't be used; it starts from its project.json: ${errText(e)}`);
      await c?.close().catch(() => {});
      await store?.close().catch(() => {});
      store = null;
      try { await removeDir(path.join(bundle, CARTON_DIR)); } catch {}
    } finally {
      await store?.close().catch(() => {});
    }
  } finally {
    try { await removeDir(exportDir); } catch (e) { warnOnce("rm:" + bundle, `couldn't remove ${EXPORT_DIR} from ${name}: ${errText(e)}`); }
  }
}

// ---------------------------------------------------------------- Open Project, a project you have
// Who brings the changes in: the person at the app, else whoever runs cb (as `cb conflicts` names them).
const actorHere = () => (api ? api.actorOf("person") : identify());
// A notice's key, as core's actorKey makes it (and the facade's keyOf).
const keyOf = (a) => [a.kind, a.id, a.agentId].filter(Boolean).join("/");

/**
 * The cards a bring-in raised, kept as a notice for whoever brought it in, where `cb conflicts`, the History panel and
 * the Stop hook read them (the facade's late-conflict notice).
 * Round 2 #3: those readers take a notice card the way the facade's own keepCards stores a rebase card: `ours` is the
 * value in place, `theirs` is the reader's own value that didn't go in. `cb resolve <n> --keep mine` writes `theirs`;
 * `--keep theirs` writes nothing (keeps what is in place); the panel shows `theirs` as "mine". A fold's card is the other
 * way round (`ours` = your cut's value, `theirs` = the file's). So the fold puts their value in (choices: "theirs") and
 * the card is stored with its sides swapped: `ours` = their value, now in place; `theirs` = yours, one `--keep mine`
 * away. Keeping your value in place would need the readers to tell a fold's card from a rebase card; with these
 * readers, `--keep mine` would then put theirs in and `--keep theirs` would leave yours. A card's text hunks and
 * compare ops are relative to its sides, so they don't come along.
 */
const asNoticeCard = ({ ops: _ops, hunks: _hunks, ...card }) => ({ ...card, ours: card.theirs, theirs: card.ours });
async function keepCards(lc, actor, cards) {
  const to = keyOf(actor), at = Date.now();
  const n = cards.length;
  const text = `${n} of your changes clashed with theirs; theirs ${n === 1 ? "is" : "are"} in now, and yours ${n === 1 ? "is" : "are"} kept: cb conflicts, then cb resolve <n> --keep mine to put yours back, or choose in History.`;
  await lc.store.write([{ table: "notices", key: [to, at, 0, Math.random().toString(16).slice(2, 10)], value: { to, kind: "late-conflict", text, cards: cards.map(asNoticeCard), at } }]);
}

// Head into project.json: in the worker through its api (the pages adopt it), in cb through the store as cb's own
// Carton writes do (the store bridge writes it without committing a second change).
async function materialize(store, id, bundle) {
  if (api) return api.materialize(id);
  const current = await store.read(id);
  const next = await cardboard14.headProject(bundle, current);
  // Their new clips' records too (media goes through 1.4.0's media scope, not ownedFields: scope.js).
  if (next) await store.updateScoped(next, headScope(current, next));
}

// A media id as a file name (Cardboard names a bundle's own media `media/<id><ext>`).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_EXT = /^\.[A-Za-z0-9]{1,12}$/;

/**
 * Round 2 #5: the clips their copy added come with their files, as Cardboard's own .cbproj import brings them. Its
 * Save As stores each clip the bundle owns as `media/<id><ext>`, with a manifest entry {mediaId, nativePath:
 * "media/…", ownedByBundle: true}; its import extracts the members into the bundle's `media/` and the library indexes
 * the entries (the media registry, from which every project write builds project.json's `media` list). Here, for each
 * clip head now uses that this library has no file for (not in the registry, not another project's), the member goes to
 * `<bundle>/media/<id><ext>` (never over an existing file) and is registered as the bundle's own, before head is
 * materialized: that write lists it in project.json, and the clip plays. A member that can't be copied leaves the clip
 * offline (logged), as before. `store` is Cardboard's project store (the library worker's, or cb's).
 */
async function adoptMedia(file, contents, store, bundle, projectId, wanted) {
  const registry = store.options?.registry;
  const entries = contents.manifest?.media;
  if (typeof registry?.register !== "function" || typeof registry.get !== "function" || !Array.isArray(entries)) return [];
  const members = new Set(contents.files);
  const todo = entries.filter((m) => {
    if (!m || typeof m.mediaId !== "string" || !SAFE_ID.test(m.mediaId) || !wanted.has(m.mediaId) || m.ownedByBundle !== true) return false;
    if (typeof m.nativePath !== "string" || !/^media\/[^/\\]+$/.test(m.nativePath) || !members.has(m.nativePath)) return false;
    const owner = store.idForMedia?.(m.mediaId);
    return !registry.get(m.mediaId) && (owner === undefined || owner === projectId);
  });
  if (!todo.length) return [];
  const adopted = [];
  const z = await ZipReader.open(file);
  try {
    for (const m of todo) {
      const ext = SAFE_EXT.test(path.extname(m.nativePath)) ? path.extname(m.nativePath) : "";
      let dest = path.join(bundle, "media", m.mediaId + ext);
      if (fs.existsSync(dest)) dest = path.join(bundle, "media", `${m.mediaId}-${randomBytes(4).toString("hex")}${ext}`);
      try {
        await z.extractEntry(m.nativePath, dest);
        registry.register([{ mediaId: m.mediaId, nativePath: dest, ownedByBundle: true }]);
        adopted.push(m.mediaId);
      } catch (e) {
        warnOnce("media:" + m.mediaId, `a clip they added (${m.mediaId}) came in without its file, so it shows offline: ${errText(e)}`);
      }
    }
  } finally {
    await z.close().catch(() => {});
  }
  return adopted;
}

/**
 * Open Project for `file` (a .cbproj) in the library whose project store is `store`. When the library already has its
 * project, with history, and the file carries Carton's entry: "Bring in their changes", then the project as it is now.
 * Otherwise null, and Cardboard imports it (or refuses it) as 1.4.0 does.
 */
async function bringIn(file, store) {
  let contents;
  try { contents = await readCbproj(file); } catch { return null; } // Cardboard says what's wrong with the file
  const id = contents.manifest?.project?.id;
  if (!contents.shallow || typeof id !== "string") return null;
  await store.list();
  const bundle = store.bundlePathFor(id);
  if (!bundle || !hasHistory(bundle)) return null;
  const name = (await store.read(id))?.name ?? path.basename(bundle, ".cardboard");
  const actor = actorHere();
  const cards = new Map();
  let wanted = new Set();
  const r = await withCarton(bundle, id, async (lc) => {
    const c = lc.carton;
    // A cut shared live takes changes only through its sync lease holder: anything else writing on it is lost at the
    // holder's next settle (notes/windows-sync.md, "Design"). The app's worker holds it while the project is open.
    const cut = (await c.cuts()).find((x) => x.id === c.cut);
    if (cut && cut.sequencer.kind !== "local" && !globalThis.__cartonSync?.holds?.(lc)) {
      throw new Error(`"${name}" is shared live, so their changes can only come in through the app with the project open. Open the file in Cardboard.`);
    }
    // "Include history": their versions are taken here, around the shallow import, rather than by the adapter (which
    // takes them after it). Core's importShallow takes a node past the end of a cut this copy holds in full for one of
    // a copy of the project that went its own way, and renames it (History.#unclash), even when that cut is the
    // sender's own, held read-only from their earlier file's history: their newer versions then sit on a renamed cut,
    // the fold merges that, and the next file's fold finds an older base (their old values clash again). Taking the
    // history first grows their read-only cut to the file's versions, so the shallow import finds them as known. Only
    // when the file names a cut this copy has already: a file of the same project id with no shared lineage must still
    // be told apart (its cuts would otherwise come in first and look shared). A refused history never stops the rest.
    let history;
    const historyOpts = { openStore: (p) => openSqliteStore(p, { readOnly: true }), tmpDir: tmpDirOf(bundle) };
    const takeFileHistory = async () => (history ??= await importFullHistory({ importHistory: (from) => c.importHistory(from) }, file, historyOpts));
    const res = await bringInTheirChanges({
      importShallow: async (pkg) => {
        if (!contents.hasFullHistory) return c.importShallow(pkg);
        const known = new Set((await c.cuts()).map((x) => x.id));
        if (pkg.nodes.some((n) => known.has(n.branchId))) await takeFileHistory();
        const imp = await c.importShallow(pkg);
        if (imp.status === "imported" || imp.status === "forked") await takeFileHistory();
        return imp;
      },
      // the adapter's checks for a copy of this project that went its own way, or a file newer than a shared cut here
      cuts: () => c.cuts(),
      head: (cutId) => c.head(cutId),
      resolve: (ref) => c.resolve(ref),
      schema: c.schema,
      // A clash puts their value in; every card it was decided on is kept for you to choose (keepCards says why this
      // way round). Core asks once per card, and again if the fold is retried after a race: collected by path.
      fold: async (from, opts) => {
        const f = await c.fold(from, { ...opts, author: actor, missingBase: "dialog", choices: (card) => (cards.set(card.path, card), "theirs") });
        if ((f.status === "confirmed" || f.status === "pending") && cards.size) await keepCards(lc, actor, [...cards.values()]);
        return f;
      },
    }, contents);
    // the clips head uses now, for their files (adoptMedia)
    if (res.status === "forked" || (res.status === "folded" && (res.fold.status === "confirmed" || res.fold.status === "pending"))) {
      wanted = new Set((materializeProject((await c.head()).doc, await store.read(id))?.media ?? []).map((m) => m.id));
    }
    return history ? { ...res, history } : res;
  });
  if (r.history?.status === "refused") warnOnce("history:" + file, `the versions in ${path.basename(file)} weren't brought in (their changes were): ${r.history.reason}`);
  switch (r.status) {
    case "other-project":
    case "no-carton-data":
      return null;
    case "no-shared-lineage":
      throw new Error(`This file holds a project with the same ID as "${name}" in your library, but its history has nothing in common with yours, so its changes can't be brought in.`);
    case "behind":
    case "diverged-copy":
      throw new Error(r.reason);
    case "forked":
      // this copy had no cut of its own yet: it now has one forked from theirs, which is head
      await adoptMedia(file, contents, store, bundle, id, wanted);
      await materialize(store, id, bundle);
      return store.read(id);
    case "folded":
      break;
    default:
      throw new Error(`Their changes couldn't be brought into "${name}" (${r.status}).`);
  }
  const f = r.fold;
  // "This copy builds on a version from Bob that you don't have. Ask Bob for their copy, or …" (core's words).
  if (f.status === "missing-base" || f.status === "compare") throw new Error(f.dialog?.text ?? "This copy builds on a version you don't have.");
  if (f.status === "rejected") throw new Error(`Their changes couldn't be brought into "${name}": ${f.reason ?? "rejected"}`);
  if (f.status !== "up-to-date") {
    await adoptMedia(file, contents, store, bundle, id, wanted);
    await materialize(store, id, bundle);
  }
  return store.read(id);
}

globalThis.__cartonCbproj = { exportEntries, saved, seed, bringIn, readCbproj };
