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
// - Open Project, a project you don't have: Cardboard imports it as 1.4.0 does. Before the staged bundle is first
//   read, its history starts from the sender's shallow export (`init: {import}`), a writable cut forked from theirs,
//   so the two copies share a lineage and later exchanges fold in with the right base. `.carton-export/` is removed.
// - Open Project, a project you have with history: in place of "This project ID already exists in your library",
//   "Bring in their changes" — their lineage is imported as tracking knowledge and their head is folded into your
//   current cut. A clash keeps your value; theirs goes on a conflict card (cb conflicts, the History panel). A missing
//   merge base says so plainly (never an older base); no shared lineage says so too. Head then goes into
//   project.json, and the import answers with your project.
// - A file without Carton's entry, a project without history, or Carton off: 1.4.0's import and its error.
// View files and Carton's database never come in: the .cbproj walk leaves them out (skipInArchive), readCbproj ignores
// them, and nothing here applies them.
import fs from "node:fs";
import path from "node:path";
import { extend, cardboard14 } from "../carton-node.js";
import { Carton } from "@carton/core";
import { cardboardAdapter } from "@carton/cardboard";
import { readCbproj, bringInTheirChanges, SHALLOW_ENTRY, EXPORT_DIR } from "@carton/cardboard/node";
import { openLocal, identify, nodeHasher } from "@carton/local";
import { openProjectStore } from "@carton/store-sqlite";
import { headScope } from "./scope.js";

const errText = (e) => (e && e.message) || String(e);
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn("[carton] " + msg); } };

// In the library worker the facade's api (its own handles, materialize, the person); null in cb.
let api = null;
extend({ name: "cbproj", worker(a) { api = a; return {}; } });

// As the facade decides it: a project has history when its carton.db is in the bundle.
const hasHistory = (bundle) => fs.existsSync(path.join(bundle, ".carton", "carton.db"));
const readProject = (bundle) => { try { return JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project ?? null; } catch { return null; } };
// Carton's own names compare case-insensitively where the file system does (as the adapter's walk does).
const FOLD = process.platform === "win32" || process.platform === "darwin";
const inExportDir = (archivePath) => {
  const top = String(archivePath).split("/")[0];
  return (FOLD ? top.toLowerCase() : top) === EXPORT_DIR;
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

// ---------------------------------------------------------------- Save As
/**
 * Cardboard's list of entries for a .cbproj of `bundle` ({archivePath, sourcePath | bytes, size}), with Carton's: no
 * old `.carton-export/`, and the shallow export as its own entry when the project has history. A failure leaves the
 * file without it (said once in the log): the Save As still happens, as a 1.4.0 file.
 */
async function exportEntries(bundle, entries) {
  const out = entries.filter((e) => !inExportDir(e.archivePath));
  if (!hasHistory(bundle)) return out;
  try {
    const projectId = readProject(bundle)?.id;
    const pkg = await withCarton(bundle, projectId, (lc) => lc.carton.exportShallow({}));
    const bytes = Buffer.from(JSON.stringify(pkg), "utf8");
    out.push({ archivePath: SHALLOW_ENTRY, bytes, size: bytes.byteLength });
  } catch (e) {
    warnOnce("export:" + bundle, `the .cbproj of ${path.basename(bundle)} was saved without its history (a teammate can open it, but not bring its changes back in): ${errText(e)}`);
  }
  return out;
}

// ---------------------------------------------------------------- Open Project, a project you don't have
/**
 * A staged bundle Cardboard has just extracted from a .cbproj, before it is first read: its history starts from the
 * sender's shallow export, a writable cut forked from theirs. `.carton-export/` never stays in a bundle. Without the
 * entry, or if it can't be used, the facade starts the history from project.json as for any project (main@1).
 */
async function seed(bundle) {
  const file = path.join(bundle, ...SHALLOW_ENTRY.split("/"));
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  try { await removeDir(path.join(bundle, EXPORT_DIR)); } catch (e) { warnOnce("rm:" + bundle, `couldn't remove ${EXPORT_DIR} from ${path.basename(bundle)}: ${errText(e)}`); }
  if (!pkg || hasHistory(bundle)) return;
  const projectId = readProject(bundle)?.id;
  if (!projectId || pkg.projectId !== projectId) return warnOnce("seed:" + bundle, `the history in ${path.basename(bundle)}'s file is another project's; it starts from its project.json`);
  let store = null;
  try {
    ({ store } = await openProjectStore({ bundleDir: bundle, projectId }));
    const c = await Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, actor: actorHere(), init: { import: pkg } });
    await c.close();
  } catch (e) {
    warnOnce("seed:" + bundle, `the history in ${path.basename(bundle)}'s file couldn't be used; it starts from its project.json: ${errText(e)}`);
    await store?.close().catch(() => {});
    store = null;
    try { await removeDir(path.join(bundle, ".carton")); } catch {}
  } finally {
    await store?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- Open Project, a project you have
// Who brings the changes in: the person at the app, else whoever runs cb (as `cb conflicts` names them).
const actorHere = () => (api ? api.actorOf("person") : identify());
// A notice's key, as core's actorKey makes it (and the facade's keyOf).
const keyOf = (a) => [a.kind, a.id, a.agentId].filter(Boolean).join("/");

// The cards a bring-in raised, kept as a notice for whoever brought it in, where `cb conflicts`, the History panel and
// the Stop hook read them (the facade's late-conflict notice). A card's `ours` is your value, kept in place; its
// `theirs` is theirs, which `cb resolve <n> --keep mine` (or the panel) puts in instead.
async function keepCards(lc, actor, cards) {
  const to = keyOf(actor), at = Date.now();
  const text = `${cards.length} of their changes clashed with yours; yours were kept. Choose with cb conflicts / cb resolve, or in History.`;
  await lc.store.write([{ table: "notices", key: [to, at, 0, Math.random().toString(16).slice(2, 10)], value: { to, kind: "late-conflict", text, cards, at } }]);
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
  const r = await withCarton(bundle, id, async (lc) => {
    // A cut shared live takes changes only through its sync lease holder: anything else writing on it is lost at the
    // holder's next settle (notes/windows-sync.md, "Design"). The app's worker holds it while the project is open.
    const cut = (await lc.carton.cuts()).find((c) => c.id === lc.carton.cut);
    if (cut && cut.sequencer.kind !== "local" && !globalThis.__cartonSync?.holds?.(lc)) {
      throw new Error(`"${name}" is shared live, so their changes can only come in through the app with the project open. Open the file in Cardboard.`);
    }
    return bringInTheirChanges({
    importShallow: (pkg) => lc.carton.importShallow(pkg),
    // A clash keeps your value; every card it was decided on is kept for you to choose (core asks once per card, and
    // again if the fold is retried after a race, so they are collected by path).
    fold: async (from, opts) => {
      const f = await lc.carton.fold(from, { ...opts, author: actor, missingBase: "dialog", choices: (card) => (cards.set(card.path, card), "ours") });
      if ((f.status === "confirmed" || f.status === "pending") && cards.size) await keepCards(lc, actor, [...cards.values()]);
      return f;
    },
  }, contents);
  });
  if (r.status === "other-project") return null;
  if (r.status === "no-shared-lineage") throw new Error(`This file holds a project with the same ID as "${name}" in your library, but its history has nothing in common with yours, so its changes can't be brought in.`);
  if (r.status !== "folded") throw new Error(`Their changes couldn't be brought into "${name}" (${r.status}).`);
  const f = r.fold;
  // "This copy builds on a version from Bob that you don't have. Ask Bob for their copy, or …" (core's words).
  if (f.status === "missing-base" || f.status === "compare") throw new Error(f.dialog?.text ?? "This copy builds on a version you don't have.");
  if (f.status === "rejected") throw new Error(`Their changes couldn't be brought into "${name}": ${f.reason ?? "rejected"}`);
  if (f.status !== "up-to-date") await materialize(store, id, bundle);
  return store.read(id);
}

globalThis.__cartonCbproj = { exportEntries, seed, bringIn, readCbproj };
