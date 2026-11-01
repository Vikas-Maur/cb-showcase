// Quickstart step 1: give an existing Cardboard project a history (INTEGRATION.md, "Migration").
//   node kit/quickstart/import.ts <bundle>
// The project's current document becomes `main@1`, one change by "Import". History is kept in
// `<bundle>/.carton/carton.db`. Running it again changes nothing.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cardboardAdapter } from "@carton/cardboard";
import { nodeHasher, readProjectId } from "@carton/local";
import { importProject } from "@carton/store-sqlite";

const bundle = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node kit/quickstart/import.ts <bundle>");

const { carton, store, location, imported } = await importProject({
  bundleDir: bundle,
  projectId: readProjectId(bundle),
  adapter: cardboardAdapter,
  hasher: nodeHasher,
  // project.json is {format, version, project, media}; Carton versions the `project` part
  host: () => JSON.parse(readFileSync(join(bundle, "project.json"), "utf8")).project,
});
const head = await carton.head();
console.log(imported ? "Imported as main@1" : "Already has a history", `(head @${head.ref.seq}, history in ${location.dbPath})`);
await carton.close();
await store.close();
