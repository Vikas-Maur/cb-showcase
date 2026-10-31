// A real project for the local runtime's engine-backed process tests: a bundle with project.json, carton.db through
// store-sqlite, and Carton on a small Cardboard-shaped schema (time group with its algebra, items on tracks).
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, object, timeAlgebra, POS, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { scratch } from "./scratch.ts";

export const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    timelineItems: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  hard: (coll, r) => (coll === "timelineItems" && !((r.endTime as number) > (r.startTime as number)) ? [`${r.id} ends at or before it starts`] : []),
});
export const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
export const clip = (id: string, s: number, e: number, track = "V1"): Rec => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id, opacity: 1 });
export const doc0 = (): Doc => ({ name: "Demo", tracks: [{ id: "V1", [POS]: "V" }, { id: "T2", [POS]: "W" }], timelineItems: Array.from({ length: 8 }, (_, i) => clip(`c${i}`, i * 5, i * 5 + 5)) });

export function bundle(name: string): { dir: string; projectId: string } {
  const dir = mkdtempSync(join(scratch(), `${name}-`));
  const projectId = `p-${Math.random().toString(16).slice(2, 10)}`;
  writeFileSync(join(dir, "project.json"), JSON.stringify({ id: projectId, name: "Demo" }));
  return { dir, projectId };
}
