// Quickstart: collaborate with no server, through `.cbproj` files (PLAN §13).
//   node kit/quickstart/cbproj.ts export  <bundle> <file.cbproj>     write the project with its shallow history
//   node kit/quickstart/cbproj.ts open    <file.cbproj> <new bundle> a teammate opens a project they don't have
//   node kit/quickstart/cbproj.ts bring-in <bundle> <file.cbproj> [--check] [--keep mine|theirs]
//                                                                    "Bring in their changes": a fold, with cards
// In Cardboard these are File › Save As and Open Project (INTEGRATION.md, H11).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Carton } from "@carton/core";
import { cardboardAdapter, materializeProject } from "@carton/cardboard";
import { bringInTheirChanges, exportCbproj, readCbproj, ZipReader } from "@carton/cardboard/node";
import { nodeHasher, openLocal } from "@carton/local";
import { defaultAppDataDir, openProjectStore, projectKey } from "@carton/store-sqlite";

const [cmd, a, b, ...rest] = process.argv.slice(2);

if (cmd === "export" && a && b) {
  const lc = await openLocal({ projectDir: resolve(a) });
  try {
    const head = await lc.carton.head();
    const r = await exportCbproj({
      bundle: resolve(a),
      out: resolve(b),
      shallow: await lc.carton.exportShallow(),
      // the file's project.json is the head, whatever project.json on disk says
      head: { doc: head.doc, toProject: materializeProject },
    });
    console.log(`Wrote ${b}: ${r.names.length} entries (${r.names.filter((n) => n.startsWith(".carton-export/")).join(", ")})`);
  } finally {
    await lc.close();
  }
} else if (cmd === "open" && a && b) {
  const file = resolve(a);
  const bundle = resolve(b);
  // a new project goes in a new folder: never over another project's files or history
  if (existsSync(bundle) && readdirSync(bundle).length) throw new Error(`${bundle} already exists and isn't empty: pick a new folder`);
  const contents = await readCbproj(file);
  if (!contents.shallow) throw new Error("this .cbproj has no Carton history");
  const projectId = (contents.manifest.project as { id: string }).id;
  // This machine may already keep this project's history in app data (a bundle in a synced folder, L15): then it isn't
  // a project you don't have, and "Bring in their changes" is the way. Checked before anything is written, because
  // opening the store would move that history into the new folder.
  const known = join(defaultAppDataDir(), "projects", projectKey(projectId), "carton.db");
  const alreadyHere = `you already have project ${projectId} on this machine: use bring-in on it instead`;
  if (existsSync(known)) throw new Error(alreadyHere);
  // unpack into a staging folder, then move it into place (Cardboard's Open Project does the same; files it must never
  // apply are already left out)
  mkdirSync(dirname(bundle), { recursive: true });
  const staging = mkdtempSync(join(dirname(bundle), `.${basename(bundle)}.unpacking-`));
  writeFileSync(join(staging, "project.json"), JSON.stringify(contents.manifest, null, 2));
  const z = await ZipReader.open(file);
  try {
    for (const name of contents.files) {
      mkdirSync(dirname(join(staging, name)), { recursive: true });
      await z.extractEntry(name, join(staging, name));
    }
  } finally {
    await z.close();
  }
  // again: another process may have opened it meanwhile (the staging folder is ours: remove it)
  if (existsSync(known)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(alreadyHere);
  }
  if (existsSync(bundle)) rmdirSync(bundle); // the empty folder checked above
  renameSync(staging, bundle);
  const { store, location } = await openProjectStore({ bundleDir: bundle, projectId });
  // Still a window between that check and the open (closing it needs a create-only open in store-sqlite): if a history
  // arrived in it, the open moved it here. Say so, and import nothing over it.
  if ((await store.range("meta", { limit: 1 })).length) {
    await store.close();
    throw new Error(`project ${projectId} already had a history on this machine; it is now at ${location.dbPath}. Nothing was imported: use bring-in on ${bundle}`);
  }
  // their cuts arrive as read-only tracking cuts, and a cut of your own starts from their head
  const carton = await Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, init: { import: contents.shallow } });
  const mine = (await carton.cuts()).find((c) => c.id === carton.cut)!;
  console.log(`Opened ${projectId} with their history; you are on "${mine.name}"`);
  await carton.close();
  await store.close();
} else if (cmd === "bring-in" && a && b) {
  const check = rest.includes("--check");
  const keep = rest.includes("--keep") ? rest[rest.indexOf("--keep") + 1] : undefined;
  const lc = await openLocal({ projectDir: resolve(a) });
  try {
    const choices = keep === "mine" ? () => "ours" as const : keep === "theirs" ? () => "theirs" as const : undefined;
    const r = await bringInTheirChanges(lc.carton, await readCbproj(resolve(b)), { check, ...(choices ? { choices } : {}) });
    if (r.status !== "folded") console.log(r.status);
    else {
      const f = r.fold as { status: string; cards?: { path: string }[] };
      const cards = f.cards?.length ? `, ${f.cards.length} card(s): ${f.cards.map((c) => c.path).join(", ")}` : "";
      console.log(`${check ? "Would bring in" : "Brought in"} their changes: ${f.status}${cards}`);
    }
  } finally {
    await lc.close();
  }
} else {
  console.error("usage: cbproj.ts export <bundle> <file.cbproj> | open <file.cbproj> <bundle> | bring-in <bundle> <file.cbproj> [--check] [--keep mine|theirs]");
  process.exitCode = 2;
}
