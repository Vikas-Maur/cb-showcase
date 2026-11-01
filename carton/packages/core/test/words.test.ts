// How core words what happened for people (ui-words): change descriptions never print "none", a label can look names
// up in the doc, conflict cards say what each side did differently without ids, and undo labels name agents only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import type { ConfirmedChange, ConflictCard, Doc, Rec } from "../src/index.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
// A clip with no name of its own is named after its media's file name, found in the doc (as Cardboard's schema does).
const schema = core.defineSchema({
  labels: { name: "project name", aspectRatio: "aspect ratio" },
  collections: {
    tracks: { seq: true, noun: "track", labels: { name: "name" } },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      noun: "clip",
      labels: { trackId: "track", startTime: "start", endTime: "end", opacity: "opacity", volume: "volume", "transform.x": "position x" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: core.timeAlgebra(TL) }],
      fields: { transform: core.object() },
    },
    media: { noun: "media", labels: { "data.fileName": "file name" }, fields: { data: core.object() } },
  },
  timeline: TL,
  label: (coll, r, doc) => {
    if (!r) return "?";
    if (coll === "media") return String((r.data as Rec | undefined)?.fileName ?? "media");
    if (typeof r.name === "string") return r.name;
    const m = doc && r.mediaItemId ? (core.getIn(doc, ["media", r.mediaItemId as string], schema) as Rec | undefined) : undefined;
    return m ? String((m.data as Rec).fileName) : `clip ${String(r.id).slice(0, 4)}`;
  },
});
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", mediaItemId: "m1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...more });
const base = (): Doc => ({
  tracks: [{ id: "t1", name: "Mine", [core.POS]: "a" }, { id: "t2", name: "B-roll", [core.POS]: "b" }],
  items: [clip("c1", 1.5, 4.5)],
  media: [{ id: "m1", data: { fileName: "Dragon-take2.mp4" } }],
});

test("describe(): a field set for the first time is named or set, never 'none →'", () => {
  const empty: Doc = { tracks: [], items: [], media: [] };
  assert.deepEqual(core.describe([{ op: "set", path: ["name"], value: "Dragon short" }], empty, schema), ["Named the project 'Dragon short'"]);
  assert.deepEqual(core.describe([{ op: "set", path: ["aspectRatio"], value: "16:9" }], empty, schema), ['Set the aspect ratio to "16:9"']);
  assert.deepEqual(core.describe([{ op: "set", path: ["items", "c1", "opacity"], value: 0.5 }], base(), schema), ["Set 'Dragon-take2.mp4' opacity to 0.5"]);
  // a value that was there is still told from → to
  const named = { ...base(), name: "Old" };
  assert.deepEqual(core.describe([{ op: "set", path: ["name"], value: "New" }], named, schema), ['Changed the project name "Old" → "New"']);
});

test("describe(): a record's label gets the doc, so a clip is named after its media, also when added with it", () => {
  const b = base();
  assert.deepEqual(core.describe([{ op: "set", path: ["items", "c1", "startTime"], value: 3 }, { op: "set", path: ["items", "c1", "endTime"], value: 6 }], b, schema), ["Moved 'Dragon-take2.mp4' 1.5 s → 3.0 s"]);
  const ops: core.Op[] = [
    { op: "insert", path: ["media", "m2"], value: { id: "m2", data: { fileName: "Beach.mov" } } },
    { op: "insert", path: ["items", "c2"], value: clip("c2", 5, 8, { mediaItemId: "m2" }) },
  ];
  assert.deepEqual(core.describe(ops, b, schema), ["Added media 'Beach.mov'", "Added video 'Beach.mov' on 'Mine' at 5.0 s"]);
});

test("describeCard(): the user's card (a clip added, then moved, both saves inserting it) says where each side put it, with no ids", () => {
  const card: ConflictCard = { kind: "record", path: "items/c9", base: undefined, ours: clip("c9", 10, 12), theirs: clip("c9", 11, 13) };
  const w = core.describeCard(card, schema, base());
  assert.deepEqual(w, { title: "'Dragon-take2.mp4'", ours: "Added at 10.0 s–12.0 s", theirs: "Added at 11.0 s–13.0 s" });
  for (const s of [w.title, w.ours, w.theirs]) assert.doesNotMatch(s, /c9|m1|t1|id|undefined/);
});

test("describeCard(): a time card words each side's move or trim as History does; the engine's reason is not shown", () => {
  const card: ConflictCard = { kind: "group", path: "items/c1/#time", reason: "same kind or incompatible", base: { startTime: 1.5, endTime: 4.5, trimStart: 0, trimEnd: 3 }, ours: { startTime: 3, endTime: 6, trimStart: 0, trimEnd: 3 }, theirs: { startTime: 1.5, endTime: 6, trimStart: 0, trimEnd: 4.5 } };
  assert.deepEqual(core.describeCard(card, schema, base()), { title: "'Dragon-take2.mp4' timing", ours: "Moved 1.5 s → 3.0 s", theirs: "Trimmed end 4.5 s → 6.0 s" });
  // without the doc there is no record to name: the collection's noun
  assert.equal(core.describeCard(card, schema).title, "Clip timing");
  // a reason in words for people stays
  assert.equal(core.describeCard({ ...card, reason: "a retime of a clip the other side split" }, schema).reason, "a retime of a clip the other side split");
});

test("describeCard(): only the fields that differ, with labels; a removed side; a lane by its name; a field card's value", () => {
  const b = clip("c1", 1.5, 4.5, { opacity: 1, volume: 1 });
  const ours = { ...b, opacity: 0.5, volume: 0.8 };
  const theirs = { ...b, opacity: 0.5, volume: 0.2, trackId: "t2" };
  const w = core.describeCard({ kind: "record", path: "items/c1", base: b, ours, theirs }, schema, base());
  assert.deepEqual([w.ours, w.theirs], ["On track 'Mine', volume 0.8", "Moved to track 'B-roll', volume 0.2"]);
  const del = core.describeCard({ kind: "record", path: "items/c1", base: b, ours: { ...b, opacity: 0.4 }, theirs: undefined }, schema, base());
  assert.deepEqual([del.ours, del.theirs], ["Opacity 0.4", "Removed"]);
  assert.deepEqual(core.describeCard({ kind: "field", path: "items/c1/opacity", base: 1, ours: 0.9, theirs: 0.5 }, schema, base()), { title: "'Dragon-take2.mp4' opacity", ours: "0.9", theirs: "0.5" });
  // a host words its own values (and may word an id field, which is otherwise never shown)
  const pct = core.describeCard({ kind: "field", path: "items/c1/opacity", base: 1, ours: 0.9, theirs: 0.5 }, schema, base(), { value: (k, v) => (k === "opacity" ? `${Math.round((v as number) * 100)}%` : undefined) });
  assert.deepEqual([pct.ours, pct.theirs], ["90%", "50%"]);
  const root = core.describeCard({ kind: "field", path: "name", base: "A", ours: "B", theirs: "C" }, schema);
  assert.deepEqual(root, { title: "Project name", ours: '"B"', theirs: '"C"' });
});

test("undoLabel(): agents by their name, a subagent by its agent's; the person's edits, a terminal's included, by no one", () => {
  const change = (author: core.Actor): ConfirmedChange => ({ id: "r.1", author, branchId: "b", base: { seq: 0, pending: [] }, ops: [], intent: null, kinds: null, policy: "merge", at: 0, hash: "", seq: 1, name: "tighter intro" }) as unknown as ConfirmedChange;
  assert.equal(core.undoLabel(change({ kind: "agent", id: "director/c/t1", name: "Director" })), "Undo Director: tighter intro");
  assert.equal(core.undoLabel(change({ kind: "subagent", id: "director/c/t1/sub-Explore-ab", name: "Director › Explore", agentType: "Explore" })), "Undo Director: tighter intro");
  assert.equal(core.undoLabel(change({ kind: "agent", id: "claude-code@box", name: "Claude Code (terminal)", provider: "claude-code" })), "Undo Claude Code: tighter intro");
  assert.equal(core.undoLabel(change({ kind: "external", id: "terminal:me@box", name: "Terminal" })), "Undo tighter intro");
  assert.equal(core.undoLabel(change({ kind: "human", id: "person" })), "Undo tighter intro");
  assert.equal(core.undoLabel(change({ kind: "system", id: "carton" })), "Undo tighter intro");
});
