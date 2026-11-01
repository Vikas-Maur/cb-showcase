// The engine factory for the shared-cut process tests: Carton (test adapter) on carton.db with a real sync client
// (server-node's WebSocket transport), served by CartonHolderEngine; the holder connects it under its lease nonce.
//   config: { url, tokenFile }
import { readFileSync } from "node:fs";
import { Carton } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { webSocketTransport } from "@carton/server-node";
import { CartonHolderEngine } from "../../src/open.ts";
import { nodeHasher } from "../../src/hasher.ts";
import type { HelperFactoryOptions } from "../../src/helper.ts";
import { adapter } from "./real.ts";

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const store = await openSqliteStore(dbPath);
  const tokenFile = String(config.tokenFile);
  const carton = await Carton.open({
    adapter, store, hasher: nodeHasher, actor: { kind: "system", id: "engine", name: "Engine" },
    sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: String(config.url), token: async () => readFileSync(tokenFile, "utf8").trim(), autoConnect: false },
  });
  return { store, engine: new CartonHolderEngine(carton), close: () => carton.close() };
}
