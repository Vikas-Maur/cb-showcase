// One process importing a project (the import race test). argv: <bundle dir> <app data dir>
import { importProject } from "../src/index.ts";
import { adapter, projectDoc } from "./import-fixture.ts";

const [bundleDir, appDataDir] = process.argv.slice(2);
const r = await importProject({ bundleDir, appDataDir, projectId: "proj-race", adapter, host: projectDoc() });
const head = await r.carton.head();
await r.carton.close();
await r.store.close();
process.stdout.write(JSON.stringify({ imported: r.imported, seq: head.ref.seq }) + "\n");
