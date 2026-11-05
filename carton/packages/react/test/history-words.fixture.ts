// Fixtures for the History words tests (history-words.test.ts, history-words.dom.test.ts): a schema as Cardboard's for
// a code graphic (its source its own media entry, part of it and program code) and a hidden composed-prompt name.
import { POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";

export const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const NOUNS: Record<string, string> = { text: "title", code: "code graphic" };
// as Cardboard's: a code graphic's source is its own media entry (part of it, `partOf`), program code (`code`)
export const schema = defineSchema({
  labels: { frameRate: "frame rate" },
  collections: {
    tracks: { seq: true, noun: "track" },
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", nounOf: (r) => NOUNS[r.type as string], groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
    media: { noun: "media", nounOf: (r) => (r.kind === "code" || r.kind === "text" ? null : undefined), partOf: { collection: "items", field: "mediaItemId" }, labels: { source: "code" }, code: ["source"] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
  shownName: (n) => (/^\[(?:Earlier messages in this|The user is switching to|This is a fresh agent)\b/.test(n) ? undefined : n),
});
export const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
export const SOURCE = `export default function Graphic({ time }) {\n${Array.from({ length: 12 }, (_, i) => `  const a${i} = ${i};`).join("\n")}\n}`;
export const doc0 = (): Doc => ({
  name: "Film",
  tracks: [{ id: "t1", [POS]: "V" }],
  items: [
    { id: "c1", type: "video", trackId: "t1", startTime: 0, endTime: 4, trimStart: 0, trimEnd: 4, name: "clip.mp4" },
    { id: "g1", type: "code", trackId: "t1", startTime: 4, endTime: 9, trimStart: 0, trimEnd: 5, name: "Cardboard on Windows", mediaItemId: "m1" },
  ],
  media: [{ id: "m1", kind: "code", name: "Cardboard on Windows", source: SOURCE }],
});
export const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
// the person's own Claude Code in the app: no turn id; its turns are told apart by the name each one's end gives
export const claude: Actor = { kind: "agent", id: "claude-code/787d66ff", name: "Claude Code", group: "alice@laptop" };
export const codeEdit = (from: string, to: string) => ({ op: "set" as const, path: ["media", "m1", "source"], value: SOURCE.replace(from, to) });

