// Inside the engine thread (see engine-thread.ts).
import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import { holderSocketPath, keepLease } from "./holder.ts";
import { Lease, recordHelperRecipe } from "./lease.ts";
import { factoryUrl } from "./helper.ts";
import type { HolderEngine } from "./holder.ts";
import type { Store } from "@carton/core/plugins";

const { dbPath, factory, config, helperFactory, helperConfig, reacquireMs } = workerData as { dbPath: string; factory: string; config: Record<string, unknown>; helperFactory?: string; helperConfig?: Record<string, unknown>; reacquireMs: number };
const port = parentPort!;
const emit = (event: Record<string, unknown>) => port.postMessage({ event: { t: Date.now(), ...event } });
const mod = (await import(factoryUrl(factory))) as { createHolderEngine(o: object): Promise<{ store: Store; engine: HolderEngine; close?: () => Promise<void>; log?: (e: Record<string, unknown>) => void }> };
const made = await mod.createHolderEngine({ dbPath, config, log: emit });
const log = (e: Record<string, unknown>) => { emit(e); made.log?.(e); };
// how a helper should run for this project, for `cb` calls that bring no setup of their own (B3, B7)
await recordHelperRecipe(made.store, { factory: helperFactory ?? factory, config: helperConfig ?? config }, "worker").catch((e) => log({ type: "recipe-error", error: String(e?.message ?? e) }));
const lease = keepLease(() => ({ lease: new Lease(made.store), engine: made.engine, kind: "worker", socketPath: holderSocketPath(dirname(dbPath), "worker"), log }), { reacquireMs });
const ready = lease.start();

port.on("message", async (m: { id: number; method: string; params: any }) => {
  try {
    let result: unknown = null;
    if (m.method === "ready") { const h = await ready; result = { nonce: h.nonce }; }
    else if (m.method === "serve") { const h = lease.current ?? (await ready); result = await made.engine.serve(m.params, { holder: h }); }
    else if (m.method === "stop") { await lease.stop(); await made.close?.(); await made.store.close(); }
    else throw Object.assign(new Error(`unknown method ${m.method}`), { code: -32601 });
    port.postMessage({ id: m.id, result });
  } catch (e: any) {
    port.postMessage({ id: m.id, error: { message: String(e?.message ?? e), code: e?.code } });
  }
});
