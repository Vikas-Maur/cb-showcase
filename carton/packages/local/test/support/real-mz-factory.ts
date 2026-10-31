// The engine factory for R5-04: Carton (test adapter) + the cardboard materializer (JSON timeline codec, a plain host
// for the test schema) on the lease holder, watching the bundle; CartonHolderEngine serves `cb` calls, including
// `cb source print --view`. config: { projectDir, followMs? }.
import { Carton, merge3 } from "@carton/core";
import type { Doc, Rec } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { jsonTimelineCodec } from "@carton/cardboard";
import { Materializer } from "@carton/cardboard/node";
import type { MaterializerHost } from "@carton/cardboard/node";
import { CartonHolderEngine } from "../../src/open.ts";
import { CartonMaterializerEngine } from "../../src/materializer-engine.ts";
import { nodeHasher } from "../../src/hasher.ts";
import type { HelperFactoryOptions } from "../../src/helper.ts";
import { adapter, schema } from "./real.ts";

const host: MaterializerHost = {
  fromProject: (p) => ({ name: p.name, tracks: p.tracks, timelineItems: p.timelineItems }) as Doc,
  toProject: (d, cur) => ({ ...(cur ?? {}), name: d.name, tracks: d.tracks, timelineItems: d.timelineItems }),
  merge3: (b, o, t) => merge3(b, o, t, schema).doc,
  diagnose: (saved, head) => {
    const out = new Set<string>();
    for (const d of [saved, head]) for (const r of (d.timelineItems as Rec[]) ?? []) for (const m of schema.hard?.("timelineItems", r, d) ?? []) out.add(m);
    return [...out];
  },
};

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const store = await openSqliteStore(dbPath);
  const carton = await Carton.open({ adapter, store, hasher: nodeHasher, actor: { kind: "system", id: "engine", name: "Engine" } });
  const mz = new Materializer({ bundle: String(config.projectDir), engine: new CartonMaterializerEngine(carton), host, codec: jsonTimelineCodec });
  await mz.start();
  mz.watch();
  // config.followMs: how often the app looks for other processes' writes (B11); 0: only when nudged
  const engine = new CartonHolderEngine(carton, { materializer: mz, ...(config.followMs !== undefined ? { follow: { intervalMs: Number(config.followMs) } } : {}) });
  return { store, engine, close: async () => { engine.close(); await mz.close(); await carton.close(); } };
}
