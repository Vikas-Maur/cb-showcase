// The app's engine factory for cli-mcp's view tests: Carton (this package's test adapter) + cardboard-adapter's real
// Materializer (JSON timeline codec, a plain host for the test schema) on the lease holder, watching the bundle, as
// @carton/local's test factory (local/test/support/real-mz-factory.ts). config: { projectDir }.
import { Carton, merge3 } from "@carton/core";
import type { Doc, Rec } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { jsonTimelineCodec } from "@carton/cardboard";
import { Materializer } from "@carton/cardboard/node";
import type { MaterializerHost } from "@carton/cardboard/node";
import { CartonHolderEngine, CartonMaterializerEngine, nodeHasher } from "@carton/local";
import type { HelperFactoryOptions } from "@carton/local";
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
  const engine = new CartonHolderEngine(carton, { materializer: mz });
  return { store, engine, close: async () => { await engine.close(); await mz.close(); await carton.close(); } };
}
