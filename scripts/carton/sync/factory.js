// The engine a headless helper runs for a shared project while the app is closed (H13, PLAN §6.2): a `cb` call that
// finds no live lease holder starts @carton/local's helper with this factory, and the helper keeps the sync
// connection for 60 s after its last use. It opens carton.db with the Cardboard adapter and the project's sync (the
// same session the app uses, refreshed when it is about to expire), and serves cb's writes as the app's worker would.
// "Before any print, the lease holder pulls" (§6.2): the first call waits, up to 3 s, for the connection to catch up,
// so an agent never edits a state older than the host's; offline it goes on at once and answers `pending`.
// build.js copies this file to resources/carton/sync/; it loads carton-node.cjs beside it for the packages (one copy).
//   config: { projectDir, projectId, cardboardSync: { bundlePath, projectId } }  (no secret: the session is in app data)
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(process.env.CARTON_DIR || path.join(here, ".."), "carton-node.cjs"));
const CATCH_UP_MS = 3000;

export async function createHolderEngine({ dbPath, config, log }) {
  const { Carton, cardboardAdapter, nodeHasher, lazySync, openSqliteStore, CartonHolderEngine, caughtUp, store: syncStore } = globalThis.__cartonSync;
  // `cardboardSync`, not `sync`: local's own factory reads `sync` as {url, tokenFile} (local-cli's `carton --server`).
  const { bundlePath, projectId } = config.cardboardSync ?? {};
  const cfg = bundlePath && projectId ? syncStore.readConfig(bundlePath, projectId) : null;
  if (!cfg) throw new Error("this project isn't shared from this computer");
  const store = await openSqliteStore(dbPath);
  const carton = await Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, sync: lazySync(bundlePath, projectId), name: cfg.name ?? cfg.account });
  const engine = new CartonHolderEngine(carton);
  // The spawner sends its call as soon as the lease row names this helper's socket, which is before the holder has
  // started sync: so the wait starts now, and ends when the connection has caught up (or after CATCH_UP_MS).
  let started;
  const ready = new Promise((r) => {
    started = r;
    setTimeout(r, CATCH_UP_MS).unref?.();
  });
  // Status changes, and why sync fails (core's sync-error: one event per change of reason), go to helper.log beside
  // carton.db, for a post-mortem of a session nobody watched.
  let last = null;
  carton.on((e) => {
    if (e.type === "sync-error") return log?.({ type: "sync-error", ...(e.error ? { code: e.error.code, message: e.error.message } : { cleared: true }) });
    if (e.type !== "sync") return;
    const s = carton.sync?.state();
    if (s && s.status !== last) log?.({ type: "sync", status: (last = s.status), pending: s.pending });
  });
  const start = engine.startSync.bind(engine);
  engine.startSync = async (...a) => {
    const t0 = Date.now();
    try {
      await start(...a);
    } catch (e) {
      log?.({ type: "sync-failed", error: String(e?.message ?? e) });
      started();
      throw e;
    }
    const end = t0 + CATCH_UP_MS;
    void (async () => {
      while (Date.now() < end) {
        const s = carton.sync?.state().status;
        if (s === "up-to-date" || s === "stopped") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      log?.({ type: "caught-up", status: carton.sync?.state().status, ms: Date.now() - t0 });
      started();
    })();
  };
  const serve = engine.serve.bind(engine);
  engine.serve = async (req, ctx) => {
    await ready;
    // And before every later call: after a reconnect, the connection catches up first (as the worker's holder does).
    await caughtUp(carton);
    return serve(req, ctx);
  };
  log?.({ type: "engine", project: projectId });
  return { store, engine, close: () => carton.close() };
}
