// A real project for engine-backed tests: a bundle folder with project.json, carton.db through store-sqlite, Carton on
// a small Cardboard-shaped schema (time group with its algebra, items on tracks). `openLocal` routes writes as in
// production: no lease holder and a local cut, so they commit in-process through carton.db's CAS.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineSchema, object, timeAlgebra, POS, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { openLocal } from "@carton/local";
import type { LocalCarton } from "@carton/local";

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
export const clip = (id: string, s: number, e: number, track = "V1"): Rec => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
export const doc0 = (): Doc => ({ name: "Demo", tracks: [{ id: "V1", [POS]: "V" }, { id: "A1", [POS]: "W" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15), clip("c3", 15, 20), clip("m1", 0, 30, "A1")] });

export function scratch(name: string): string {
  const root = process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "local-cli", "test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${name}-`));
}

export function bundle(name: string): { dir: string; projectId: string } {
  const dir = scratch(name);
  const projectId = `p-${Math.random().toString(16).slice(2, 10)}`;
  writeFileSync(join(dir, "project.json"), JSON.stringify({ id: projectId, name: "Demo" }));
  return { dir, projectId };
}

export async function realProject(name: string, actor: Actor, init = true): Promise<{ local: LocalCarton; dir: string; projectId: string; reopen: (a: Actor) => Promise<LocalCarton> }> {
  const { dir, projectId } = bundle(name);
  const local = await openLocal({ projectDir: dir, projectId, adapter, actor, init: init ? { doc: doc0() } : undefined });
  return { local, dir, projectId, reopen: (a) => openLocal({ projectDir: dir, projectId, adapter, actor: a }) };
}
