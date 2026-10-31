// The engine factory for the engine-backed process tests: store-sqlite + Carton with the test adapter, served by
// @carton/local's CartonHolderEngine (what a helper or the app's engine thread runs).
import { Carton } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { CartonHolderEngine } from "../../src/open.ts";
import { nodeHasher } from "../../src/hasher.ts";
import type { HelperFactoryOptions } from "../../src/helper.ts";
import { adapter } from "./real.ts";

export async function createHolderEngine({ dbPath }: HelperFactoryOptions) {
  const store = await openSqliteStore(dbPath);
  const carton = await Carton.open({ adapter, store, hasher: nodeHasher, actor: { kind: "system", id: "engine", name: "Engine" } });
  return { store, engine: new CartonHolderEngine(carton), close: () => carton.close() };
}
