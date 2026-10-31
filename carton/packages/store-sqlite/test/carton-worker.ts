// One process committing through Carton on carton.db (the Carton-on-sqlite race test).
// argv: <bundle dir> <app data dir> <writer> <commits>
import { importProject } from "../src/index.ts";
import { adapter, projectDoc } from "./import-fixture.ts";

const [bundleDir, appDataDir, writer, n] = process.argv.slice(2);
const { carton, store } = await importProject({ bundleDir, appDataDir, projectId: "proj-carton", adapter, host: projectDoc(), actor: { kind: "agent", id: writer } });
const statuses: string[] = [];
let coreRetries = 0;
// Paced like agents and a GUI (a few ms apart), not a tight loop. Core's Carton still gives up after 4 lost append
// races in a row on a loaded machine ("the store changed under this write", reported to foundation-core; TIGHT=1
// reproduces it). The documented recovery is what a `cb` call does: retry with the same change id, which core
// confirms once. So every commit has a stable id, and the test still proves each change lands exactly once.
const pace = process.env.TIGHT ? 0 : 1;
for (let i = 0; i < Number(n); i++) {
  if (pace) await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
  // Each writer edits its own field of clip "a": no overlap, so every commit must confirm.
  const input = { id: `${writer}-${process.pid}.${i}`, ops: [{ op: "set" as const, path: ["items", "a", `note_${writer}`], value: i }] };
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await carton.commit(input);
      statuses.push(r.status);
      break;
    } catch (e) {
      if (process.env.TIGHT || attempt >= 20 || !/store changed under this write/.test(String(e))) throw e;
      coreRetries++;
    }
  }
}
await carton.close();
await store.close();
process.stdout.write(JSON.stringify({ writer, statuses: [...new Set(statuses)], busyRetries: store.db.busyRetries, coreRetries }) + "\n");
