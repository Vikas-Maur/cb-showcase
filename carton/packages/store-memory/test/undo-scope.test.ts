// The app's Ctrl+Z and redo (laptop report 90c4127, bugs 3 and 4): undo by actor group narrowed to what was made from
// the app (`Actor.app`: the person at the editor, an agent turn started there) in the editor's session (`since`), never
// a terminal's `cb`, never before the session; redo re-applies exactly what the last undo took back, as a new change,
// and clears on a new edit. Unscoped, `cb undo` and History's Undo still see the whole group.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, defineSchema, object, timeAlgebra, POS, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
const GROUP = "local:me@laptop";
// the person at the editor and an agent turn they started there (app); a terminal's cb on the same machine (same group)
const person: Actor = { kind: "human", id: "person", group: GROUP, app: true };
const director = (turn: string): Actor => ({ kind: "agent", id: `director/chat1/${turn}`, name: "Director", chat: "chat1", turn, group: GROUP, app: true });
const terminal: Actor = { kind: "agent", id: "claude-code@laptop", name: "Claude Code", provider: "claude-code", group: GROUP };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const names = async (c: Carton) => Object.fromEntries(((await c.head()).doc.items as Rec[]).map((i) => [i.id, i.name]));

/** A clock the test moves: the session starts between two edits, whatever the machine's speed. */
function clock() {
  let now = 1_000_000;
  return { now: () => now, tick: (ms = 10) => (now += ms) };
}

test("Ctrl+Z's scope: the person's own edits and the app's agent turns, in this session; never a terminal's cb, never before the session", async () => {
  const t = clock();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [] } }, clock: t.now });
  // before the session: a terminal cb builds the timeline, and the person edits it
  await c.commit({ ops: [{ op: "insert", path: ["items", "a"], value: clip("a", 0, 5) }, { op: "insert", path: ["items", "b"], value: clip("b", 5, 10) }, { op: "insert", path: ["items", "c"], value: clip("c", 10, 15) }], author: terminal });
  t.tick();
  await c.commit({ ops: [set("a", "name", "before the session")], author: person });
  t.tick();
  const since = t.now();
  // the session: the person, the terminal, a Director turn of two edits, the terminal again
  t.tick();
  await c.commit({ ops: [set("b", "name", "mine")], author: person });
  t.tick();
  await c.commit({ ops: [set("c", "name", "terminal 1")], author: terminal });
  t.tick();
  await c.commit({ ops: [set("a", "name", "director 1")], author: director("turn1") });
  t.tick();
  await c.commit({ ops: [set("c", "name", "director 2")], author: director("turn1") });
  t.tick();
  await c.commit({ ops: [set("b", "trimStart", 1)], author: terminal });
  const scope = { since, app: true };

  // unscoped (cb undo, History's Undo): the terminal's newest edit is on top, as before
  assert.equal((await c.undoStack(GROUP))[0]!.author.id, terminal.id);
  // scoped: the turn, then the person's own edit, and nothing older than the session
  assert.deepEqual((await c.undoStack(GROUP, scope)).map((e) => e.author.id), [director("turn1").id, director("turn1").id, "person"]);
  assert.equal((await c.undoStack(GROUP, { ...scope, limit: 1 })).length, 1, "limit: only the newest");

  const z1 = await c.undo(GROUP, { ...scope, author: person });
  assert.equal(z1.status, "confirmed");
  assert.deepEqual(await names(c), { a: "before the session", b: "mine", c: "terminal 1" }, "the Director's turn undone as one; the terminal's edit before it stays");
  const z2 = await c.undo(GROUP, { ...scope, author: person });
  assert.equal(z2.status === "confirmed" && !z2.empty, true);
  assert.equal((await names(c)).b, "b", "then the person's own edit");
  const z3 = await c.undo(GROUP, { ...scope, author: person });
  assert.equal(z3.status === "confirmed" && z3.empty, true, "then nothing: the session began after the person's earlier edit");
  const after = await names(c);
  assert.deepEqual(after, { a: "before the session", b: "b", c: "terminal 1" }, "never the terminal's edits, never the edit before the session, never the timeline the terminal built");
  assert.equal(((await c.head()).doc.items as Rec[]).find((i) => i.id === "b")!.trimStart, 1, "the terminal's later edit stays too");
  assert.deepEqual(await c.undoStack(GROUP, scope), []);
  await c.close();
});

test("redo re-applies exactly what the last undo took back, as a new change; Ctrl+Z takes it back again; a new edit clears it", async () => {
  const t = clock();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10)] } }, clock: t.now });
  const since = t.now();
  const scope = { since, app: true };
  const z = () => c.undo(GROUP, { ...scope, author: person });
  const y = () => c.redo(GROUP, { ...scope, author: person });
  t.tick();
  await c.commit({ ops: [set("a", "name", "A1")], author: person });
  t.tick();
  await c.commit({ ops: [set("b", "name", "B1"), set("b", "startTime", 6)], author: person });
  const full = (await c.head()).doc;
  assert.deepEqual(await c.redoStack(GROUP, scope), [], "nothing to redo before an undo");
  const r0 = await y();
  assert.equal(r0.status === "confirmed" && r0.empty, true);
  assert.deepEqual((await c.head()).doc, full, "a redo with nothing to redo changes nothing");

  t.tick();
  await z();
  t.tick();
  await z();
  assert.deepEqual(await names(c), { a: "a", b: "b" });
  assert.deepEqual((await c.redoStack(GROUP, scope)).map((e) => e.label), ["Redo edit", "Redo edit"]);
  // a terminal's edit meanwhile is not the person's: redo is still there (made on head, around it)
  t.tick();
  await c.commit({ ops: [{ op: "insert", path: ["items", "x"], value: clip("x", 20, 25) }], author: terminal });
  t.tick();
  const r1 = await y();
  assert.equal(r1.status === "confirmed" && r1.change?.kind, "revert", "a new change: the undo reverted");
  assert.deepEqual(await names(c), { a: "A1", b: "b", x: "x" }, "the first redo brings back what the last undo took back");
  t.tick();
  await y();
  const back = (await c.head()).doc as Doc;
  assert.deepEqual((back.items as Rec[]).filter((i) => i.id !== "x"), full.items, "both redone: exactly the state before the undos");
  assert.deepEqual(await c.redoStack(GROUP, scope), [], "nothing more to redo");

  // Ctrl+Z after a redo takes the redo back; redo then brings it again
  t.tick();
  await z();
  assert.deepEqual(await names(c), { a: "A1", b: "b", x: "x" });
  assert.equal((await c.redoStack(GROUP, scope)).length, 1);
  t.tick();
  await y();
  assert.deepEqual((((await c.head()).doc as Doc).items as Rec[]).filter((i) => i.id !== "x"), full.items);

  // a new edit by the person clears redo
  t.tick();
  await z();
  assert.equal((await c.redoStack(GROUP, scope)).length, 1);
  t.tick();
  await c.commit({ ops: [set("a", "name", "new")], author: person });
  assert.deepEqual(await c.redoStack(GROUP, scope), [], "a new edit clears redo, as the editor's does");
  const before = (await c.head()).doc;
  t.tick();
  const none = await y();
  assert.equal(none.status === "confirmed" && none.empty, true);
  assert.deepEqual((await c.head()).doc, before);
  await c.close();
});

test("redo never re-applies an undo from before the session, nor a terminal's", async () => {
  const t = clock();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5)] } }, clock: t.now });
  t.tick();
  await c.commit({ ops: [set("a", "name", "earlier")], author: person });
  t.tick();
  await c.undo(GROUP, { author: person, app: true });
  t.tick();
  const since = t.now();
  assert.deepEqual(await c.redoStack(GROUP, { since, app: true }), [], "the undo was made before this session");
  assert.equal((await c.redoStack(GROUP, { app: true })).length, 1, "without the session bound it would be redone");
  // a terminal's own undo (cb undo) is the terminal's to redo
  t.tick();
  await c.commit({ ops: [set("a", "name", "terminal")], author: terminal });
  t.tick();
  await c.undo(GROUP, { author: terminal });
  assert.deepEqual(await c.redoStack(GROUP, { since, app: true }), []);
  await c.close();
});
