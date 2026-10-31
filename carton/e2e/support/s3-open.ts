// Open Project of a teammate's `.cbproj` on a machine whose library doesn't have the project (§5.3, §13, §16 H11), as
// the patched 1.4.0 importer does it, in a process of its own:
//   1. read the file (`readCbproj`): only its bundle files are unpacked, into a staging folder, with the manifest
//      written as project.json. Carton's entries and anything under `.carton/` or `.scratch/views/` are never
//      unpacked (`ignored`);
//   2. Carton opens the project from the shallow export (`init: {import}`), still in the staging folder: the sender's
//      cuts become tracking cuts and a writable cut is forked from their head;
//   3. the materializer adopts the unpacked project.json and timeline.tsx as that state (they are, not foreign saves);
//   4. only then is the folder renamed into the library. Renamed first, the library's watcher could open the new bundle
//      before its carton.db exists and migrate it as a fresh `main@1`, with no lineage shared with the sender.
//   s3-open <cbproj> <bundle>
// Prints {bundle, projectId, cut, head, cuts, files, ignored}.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Carton, type HostAdapter } from "@carton/core";
import { cardboardAdapter, cardboardFilesHost, jsonTimelineCodec } from "@carton/cardboard";
import { Materializer, readCbproj, ZipReader, safeEntryPath } from "@carton/cardboard/node";
import { CartonMaterializerEngine, nodeHasher } from "@carton/local";
import { locateCartonDb, openSqliteStore } from "@carton/store-sqlite";

const [file, bundle] = process.argv.slice(2) as [string, string];
const c = await readCbproj(file);
if (!c.shallow) throw new Error("no Carton data in this file");
const staging = `${bundle}.import-${process.pid}`;
mkdirSync(staging, { recursive: true });
const z = await ZipReader.open(file);
try {
  for (const name of c.files) {
    // 1.4.0's extraction: `\` is a separator, empty and `.` segments are dropped
    const rel = safeEntryPath(name.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".").join("/"));
    if (!rel) throw new Error(`readCbproj listed an unsafe member ${name}`);
    await z.extractEntry(name, join(staging, rel));
  }
} finally {
  await z.close();
}
writeFileSync(join(staging, "project.json"), JSON.stringify(c.manifest, null, 2));

const projectId = String((c.manifest.project as { id: string }).id);
const { dbPath, inBundle } = locateCartonDb({ bundleDir: staging, projectId });
if (!inBundle) throw new Error("s3-open: the scratch library should keep carton.db in the bundle");
const store = await openSqliteStore(dbPath);
const carton = await Carton.open({ adapter: cardboardAdapter as HostAdapter, store, hasher: nodeHasher, actor: { kind: "system", id: "engine", name: "Engine" }, init: { import: c.shallow } });
const mz = new Materializer({ bundle: staging, engine: new CartonMaterializerEngine(carton), host: cardboardFilesHost, codec: jsonTimelineCodec });
await mz.adoptCurrentFiles();
await mz.close();
const head = await carton.head();
const out = { bundle, projectId, cut: carton.cut, head: head.ref, cuts: await carton.cuts(), files: c.files, ignored: c.ignored };
await carton.close();
await store.close();
renameSync(staging, bundle);
process.stdout.write(JSON.stringify(out) + "\n");
