// The helper's engine factory for the process tests (see mini-engine.ts).
import { openTestStore } from "./sqlite-store.ts";
import { MiniEngine } from "./mini-engine.ts";
import type { HelperFactoryOptions } from "../../src/helper.ts";

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const store = openTestStore(dbPath);
  const engine = new MiniEngine(store, dbPath, config as any);
  return { store, engine, log: (e: Record<string, unknown>) => engine.event({ src: "holder", ...e }) };
}
