// A small Cardboard-like schema and an identity adapter for the import tests.
import { defineSchema, timeAlgebra, POS, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
export const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => structuredClone(h), toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
export const projectDoc = (): Doc => ({ name: "Promo", aspectRatio: "16:9", tracks: [{ id: "t1", [POS]: "V", name: "Video" }], items: [clip("a", 0, 5), clip("b", 5, 9)] });
