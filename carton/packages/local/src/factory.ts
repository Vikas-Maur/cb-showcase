// The default engine factory for a helper or the engine thread: carton.db through store-sqlite, Carton with the
// Cardboard adapter, and (for shared cuts) its sync client, which the holder starts only once it owns the lease.
//   config: { projectDir, projectId?, dataDir?, sync?: { url, tokenFile } }
// The token is read from a file (app data), never passed on a command line.
import { readFileSync } from "node:fs";
import { Carton } from "@carton/core";
import type { HostAdapter, Transport } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { nodeHasher } from "./hasher.ts";
import { CartonHolderEngine } from "./open.ts";
import type { HelperFactoryOptions } from "./helper.ts";

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const store = await openSqliteStore(dbPath);
  const adapter = ((await import("@carton/cardboard")).cardboardAdapter) as HostAdapter;
  const syncCfg = config.sync as { url: string; tokenFile: string; transport?: string } | undefined;
  let sync: { transport: Transport; url: string; token: () => Promise<string>; autoConnect: false } | undefined;
  if (syncCfg?.url) {
    const mod = await import(syncCfg.transport ?? "@carton/server-node");
    // server-node exports a factory, `webSocketTransport(opts)`; a module may also export a ready transport
    const made = typeof mod.webSocketTransport === "function" ? mod.webSocketTransport() : mod.transport;
    if (!made || typeof (made as Transport).connect !== "function") throw new Error(`${syncCfg.transport ?? "@carton/server-node"} gave no Transport`);
    const transport = made as Transport;
    sync = { transport, url: syncCfg.url, token: async () => readFileSync(syncCfg.tokenFile, "utf8").trim(), autoConnect: false };
  }
  const carton = await Carton.open({ adapter, store, hasher: nodeHasher, sync: sync as any });
  return { store, engine: new CartonHolderEngine(carton), close: () => carton.close() };
}
