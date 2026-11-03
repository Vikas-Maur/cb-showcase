// N0b (DESIGN-V2 §3.2): where a brought-back clip goes, and what else moves. A clip deleted with a ripple comes back
// with the rest of its track moved back (later); one added with a ripple, taken out, moves the rest earlier; otherwise
// nothing else moves (ripple null). A clip never lands on top of another: its place taken now, it goes on a new track
// just above its own, at the same time. And the "it changed again" check: bringBackChoices' token, passed back as
// `expect`, refuses a bring-back of a clip that changed since (ChangedSince), nothing written.
import test from "node:test";
import assert from "node:assert/strict";
import { Carton, ChangedSince, defineSchema, timeAlgebra } from "../src/index.ts";
import type { Doc, Op, Rec } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

export const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true, noun: "track" },
    items: { key: "id", noun: "clip", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (_c, r) => String(r?.name ?? "?"),
});
export const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
export const clip = (id: string, s: number, e: number, track = "t1"): Rec => ({ id, name: id.toUpperCase(), trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, playbackSpeed: 1 });
export const doc0 = (): Doc => ({ tracks: [{ id: "t1", name: "Video 1", "#pos": "a" }, { id: "t2", name: "Text 1", "#pos": "b" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] }) as unknown as Doc;
export const open = () => Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: { kind: "human", id: "me" } });
export const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["items", id, f], value: v });
export const at = (d: Doc) => Object.fromEntries((d.items as Rec[]).map((r) => [r.id, [r.trackId, r.startTime, r.endTime]]));

