// The engine a headless helper runs for a shared project while the app is closed (H13, PLAN §6.2): a `cb` call that
// finds no live lease holder starts @carton/local's helper with this factory, and the helper keeps the sync
// connection for 60 s after its last use. It opens carton.db with the Cardboard adapter and the project's sync (the
// same session the app uses, refreshed when it is about to expire), and serves cb's writes as the app's worker would.
// build.js copies this file to resources/carton/sync/; it loads carton-node.cjs beside it for the packages (one copy).
//   config: { projectDir, projectId, sync: { bundlePath, projectId } }  (no secret: the session is in app data)
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(process.env.CARTON_DIR || path.join(here, ".."), "carton-node.cjs"));

export async function createHolderEngine({ dbPath, config, log }) {
  const { Carton, cardboardAdapter, nodeHasher, lazySync, openSqliteStore, CartonHolderEngine, store: sync } = globalThis.__cartonSync;
  const { bundlePath, projectId } = config.sync ?? {};
  if (!bundlePath || !projectId || !sync.readConfig(bundlePath, projectId)) throw new Error("this project isn't shared from this computer");
  const store = await openSqliteStore(dbPath);
  const carton = await Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, sync: lazySync(bundlePath, projectId) });
  log?.({ type: "engine", project: projectId });
  return { store, engine: new CartonHolderEngine(carton), close: () => carton.close() };
}
