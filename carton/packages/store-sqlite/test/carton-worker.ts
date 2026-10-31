// One process committing through Carton on carton.db (the Carton-on-sqlite race test).
// argv: <bundle dir> <app data dir> <writer> <commits>
import { importProject } from "../src/index.ts";
import { adapter, projectDoc } from "./import-fixture.ts";

const [bundleDir, appDataDir, writer, n] = process.argv.slice(2);
const { carton, store } = await importProject({ bundleDir, appDataDir, projectId: "proj-carton", adapter, host: projectDoc(), actor: { kind: "agent", id: writer } });
const statuses: string[] = [];
for (let i = 0; i < Number(n); i++) {
  // Each writer edits its own field of clip "a": no overlap, so every commit must confirm.
  const r = await carton.commit({ ops: [{ op: "set", path: ["items", "a", `note_${writer}`], value: i }] });
  statuses.push(r.status);
}
await carton.close();
await store.close();
process.stdout.write(JSON.stringify({ writer, statuses: [...new Set(statuses)], busyRetries: store.db.busyRetries }) + "\n");
