// Entry of the detached helper process. See helper.ts.
//   helper-main --db <carton.db> --seen <nonce|-> --factory <module> [--config <json>] [--idle-ms <ms>]
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Holder, holderSocketPath } from "./holder.ts";
import { Lease, recordHelperRecipe } from "./lease.ts";
import { factoryUrl, helperLog } from "./helper.ts";
import type { HelperFactoryOptions } from "./helper.ts";
import type { HolderEngine } from "./holder.ts";
import type { Store } from "@carton/core/plugins";

const { values: a } = parseArgs({
  options: { db: { type: "string" }, seen: { type: "string" }, factory: { type: "string" }, config: { type: "string" }, "idle-ms": { type: "string" } },
  strict: true,
});
if (!a.db || !a.factory) {
  process.stderr.write("usage: helper-main --db <carton.db> --seen <nonce|-> --factory <module>\n");
  process.exit(2);
}
const dbPath = a.db;
const log = helperLog(dbPath);
const seen = !a.seen || a.seen === "-" ? null : a.seen;

try {
  const mod = (await import(factoryUrl(a.factory))) as { createHolderEngine(o: HelperFactoryOptions): Promise<{ store: Store; engine: HolderEngine; close?: () => Promise<void>; log?: (e: Record<string, unknown>) => void }> };
  const config = a.config ? JSON.parse(a.config) : {};
  const made = await mod.createHolderEngine({ dbPath, config, log });
  // a helper its caller set up (its own factory, or local's with a sync server) leaves that setup for helpers started
  // without one, unless the app recorded its own (B7)
  const self = fileURLToPath(import.meta.url);
  const isDefault = resolve(a.factory) === join(dirname(self), `factory${self.endsWith(".ts") ? ".ts" : ".js"}`);
  if (!isDefault || config.sync) await recordHelperRecipe(made.store, { factory: a.factory, config }, "helper").catch(() => {});
  const { store, engine, close } = made;
  const holderLog = made.log ? (e: Record<string, unknown>) => { log(e); made.log!(e); } : log;
  const idleMs = a["idle-ms"] ? Number(a["idle-ms"]) : 60000;
  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    try { await close?.(); await store.close(); } catch { /* exiting anyway */ }
    process.exit(code);
  };
  const holder = new Holder({
    lease: new Lease(store),
    engine,
    kind: "helper",
    socketPath: holderSocketPath(dirname(dbPath), "helper"),
    seen,
    idleMs,
    log: holderLog,
    onStop: (why) => void exit(why.startsWith("fenced") ? 3 : 0),
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void holder.retire(`signal ${sig}`));
  if (!(await holder.start())) {
    log({ type: "lost-race", seen });
    await exit(0);
  }
} catch (e: any) {
  log({ type: "error", error: String(e?.stack ?? e) });
  process.exit(1);
}
