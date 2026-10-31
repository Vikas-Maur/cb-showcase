// A small timeline schema for the Carton tests (items on tracks, a time group with its algebra, an overlap warning).
import { defineSchema, object, timeAlgebra, POS, type Doc, type Rec, type SoftWarning } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";

export const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const overlaps = (a: Rec | undefined, b: Rec | undefined) => !!a && !!b && a.trackId === b.trackId && (a.startTime as number) < (b.endTime as number) && (b.startTime as number) < (a.endTime as number);
export const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  hard: (coll, r, doc) => {
    if (coll !== "items") return [];
    const out: string[] = [];
    if (!((r.endTime as number) > (r.startTime as number))) out.push("endTime must be greater than startTime");
    if (!((doc.tracks as Rec[] | undefined) ?? []).some((t) => t.id === r.trackId)) out.push("trackId must exist");
    return out;
  },
  soft: (doc, _touched, sides, placed) => {
    const out: SoftWarning[] = [];
    const items = (doc.items as Rec[] | undefined) ?? [];
    const get = (d: Doc, id: unknown) => ((d.items as Rec[] | undefined) ?? []).find((i) => i.id === id);
    for (const id of placed) {
      const it = get(doc, id);
      for (const x of items) if (x.id !== id && overlaps(it, x) && !sides.some((s) => overlaps(get(s, id), get(s, x.id)))) out.push({ kind: "overlap", items: [String(id), String(x.id)].sort() });
    }
    return out;
  },
});
export const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
export const clip = (id: string, s: number, e: number, track = "t1"): Rec => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
export const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }, { id: "t2", [POS]: "W" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20), clip("e", 20, 25), clip("f", 25, 30)] });
export const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
export const item = (d: Doc, id: string) => (d.items as Rec[]).find((i) => i.id === id);
