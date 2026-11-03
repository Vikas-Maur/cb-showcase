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

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true, noun: "track" },
    items: { key: "id", noun: "clip", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (_c, r) => String(r?.name ?? "?"),
});
const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const clip = (id: string, s: number, e: number, track = "t1"): Rec => ({ id, name: id.toUpperCase(), trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, playbackSpeed: 1 });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", name: "Video 1", "#pos": "a" }, { id: "t2", name: "Text 1", "#pos": "b" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] }) as unknown as Doc;
const open = () => Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: { kind: "human", id: "me" } });
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["items", id, f], value: v });
const at = (d: Doc) => Object.fromEntries((d.items as Rec[]).map((r) => [r.id, [r.trackId, r.startTime, r.endTime]]));

test("deleted with a ripple: it comes back where it was, and the rest of its track moves back later; one undo", async () => {
  const c = await open();
  try {
    // a ripple delete of B: C moves up into its place
    await c.commit({ ops: [{ op: "remove", path: ["items", "b"] }, set("c", "startTime", 5), set("c", "endTime", 10)], intent: { kind: "ripple-delete", maps: { t1: [{ d: [[5, 10]], i: [] }] } } });
    const ch = await c.bringBackChoices(`${c.cut}@0`);
    const b = ch.deleted.find((x) => x.record === "items/b")!;
    assert.deepEqual(b.ripple, { direction: "later", by: 5, at: 5, tracks: ["t1"], moved: 1 }, "the confirmation can say: Everything after it moves 5 s later");
    assert.deepEqual(b.place, { placed: "same" });
    const r = await c.restoreClip(`${c.cut}@0`, "items/b", { expect: b.token });
    assert.equal(r.brought.how, "added");
    assert.deepEqual(r.brought.ripple, { direction: "later", by: 5, at: 5, tracks: ["t1"], moved: 1 });
    assert.deepEqual(at((await c.head()).doc), { a: ["t1", 0, 5], b: ["t1", 5, 10], c: ["t1", 10, 15] });
    await c.undo();
    assert.deepEqual(at((await c.head()).doc), { a: ["t1", 0, 5], c: ["t1", 5, 10] });
  } finally {
    await c.close();
  }
});

test("deleted, its place taken now (no ripple): it goes on a new track just above its own, at the same time; nothing else moves", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [{ op: "remove", path: ["items", "b"] }] });
    await c.commit({ ops: [set("c", "startTime", 6), set("c", "endTime", 11)] }); // C into B's old place
    const r = await c.restoreClip(`${c.cut}@0`, "items/b");
    assert.equal(r.brought.ripple, null, "nothing else moves");
    assert.equal(r.brought.place?.placed, "new-track");
    assert.deepEqual(r.brought.place?.takenBy, [{ record: "items/c", name: "C" }]);
    const d = (await c.head()).doc;
    const nt = r.brought.place!.track!;
    const tracks = [...(d.tracks as Rec[])].sort((x, y) => (String(x["#pos"]) < String(y["#pos"]) ? -1 : 1));
    assert.deepEqual(tracks.map((t) => t.id), [nt, "t1", "t2"], "just above its own track (before it in the order: the first track is the top layer)");
    assert.equal(tracks[0]!.name, "Video 1 2");
    assert.deepEqual(at(d).b, [nt, 5, 10]);
    assert.deepEqual(at(d).c, ["t1", 6, 11], "the clip in its place stays");
    // its place free: back on its own track
    const c2 = await open();
    await c2.commit({ ops: [{ op: "remove", path: ["items", "b"] }] });
    const r2 = await c2.restoreClip(`${c2.cut}@0`, "items/b");
    assert.deepEqual([r2.brought.place, r2.brought.ripple], [{ placed: "same" }, null]);
    assert.deepEqual(at((await c2.head()).doc).b, ["t1", 5, 10]);
    await c2.close();
  } finally {
    await c.close();
  }
});

test("added with a ripple, taken out: the rest moves earlier again; added without one: the rest stays", async () => {
  const c = await open();
  try {
    // D inserted at 5 with a ripple: B and C moved 3 s later
    await c.commit({ ops: [{ op: "insert", path: ["items", "d"], value: clip("d", 5, 8) }, set("b", "startTime", 8), set("b", "endTime", 13), set("c", "startTime", 13), set("c", "endTime", 18)], intent: { kind: "ripple-insert", maps: { t1: [{ d: [], i: [[5, 3]] }] } } });
    const choice = (await c.bringBackChoices(`${c.cut}@0`)).added.find((x) => x.record === "items/d")!;
    assert.deepEqual(choice.ripple, { direction: "earlier", by: 3, at: 5, tracks: ["t1"], moved: 2 });
    const r = await c.restoreClip(`${c.cut}@0`, "items/d", { remove: true });
    assert.equal(r.brought.how, "removed");
    assert.deepEqual(r.brought.ripple, { direction: "earlier", by: 3, at: 5, tracks: ["t1"], moved: 2 });
    assert.deepEqual(at((await c.head()).doc), { a: ["t1", 0, 5], b: ["t1", 5, 10], c: ["t1", 10, 15] });
    // E added in a gap at the end, no ripple: taking it out moves nothing
    await c.commit({ ops: [{ op: "insert", path: ["items", "e"], value: clip("e", 20, 22) }] });
    const r2 = await c.restoreClip(`${c.cut}@0`, "items/e", { remove: true });
    assert.equal(r2.brought.ripple, null);
    assert.deepEqual(at((await c.head()).doc), { a: ["t1", 0, 5], b: ["t1", 5, 10], c: ["t1", 10, 15] });
  } finally {
    await c.close();
  }
});

test("it changed again: a token from bringBackChoices that no longer matches refuses, nothing written; the new one works", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("b", "endTime", 9), set("b", "trimEnd", 4)] });
    const b = (await c.bringBackChoices(`${c.cut}@0`)).changed.find((x) => x.record === "items/b")!;
    assert.equal(typeof b.token, "string");
    // an agent changes B meanwhile
    await c.commit({ ops: [set("b", "name", "B2")], author: { kind: "agent", id: "director/c/t", name: "Director", turn: "t", chat: "c" } });
    const seq = (await c.head()).ref.seq;
    await assert.rejects(c.restoreClip(`${c.cut}@0`, "items/b", { expect: b.token }), (e: Error) => e instanceof ChangedSince && e.message === "“B2” just changed again. Nothing was brought back." && (e as ChangedSince).token !== b.token);
    assert.equal((await c.head()).ref.seq, seq, "nothing written");
    const again = (await c.bringBackChoices(`${c.cut}@0`)).changed.find((x) => x.record === "items/b")!;
    const r = await c.restoreClip(`${c.cut}@0`, "items/b", { expect: again.token });
    assert.equal(r.brought.how, "changed");
    assert.deepEqual(at((await c.head()).doc).b, ["t1", 5, 10]);
    // a clip not there now has a token too ("absent"), and its deletion since is checked the same way
    await c.commit({ ops: [{ op: "remove", path: ["items", "c"] }] });
    const cc = (await c.bringBackChoices(`${c.cut}@0`)).deleted.find((x) => x.record === "items/c")!;
    assert.equal(cc.token, "absent");
    assert.equal((await c.restoreClip(`${c.cut}@0`, "items/c", { expect: cc.token })).brought.how, "added");
  } finally {
    await c.close();
  }
});

test("a retried id answers with the same place and ripple (new track; ripple back)", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [{ op: "remove", path: ["items", "b"] }] });
    await c.commit({ ops: [set("c", "startTime", 6), set("c", "endTime", 11)] });
    const a = await c.restoreClip(`${c.cut}@0`, "items/b", { id: "n0b.1" });
    const b = await c.restoreClip(`${c.cut}@0`, "items/b", { id: "n0b.1" });
    assert.deepEqual(b.brought, a.brought);
    const c2 = await open();
    await c2.commit({ ops: [{ op: "remove", path: ["items", "b"] }, set("c", "startTime", 5), set("c", "endTime", 10)], intent: { kind: "ripple-delete", maps: { t1: [{ d: [[5, 10]], i: [] }] } } });
    const x = await c2.restoreClip(`${c2.cut}@0`, "items/b", { id: "n0b.2" });
    const y = await c2.restoreClip(`${c2.cut}@0`, "items/b", { id: "n0b.2" });
    assert.deepEqual(y.brought, x.brought);
    await c2.close();
  } finally {
    await c.close();
  }
});
