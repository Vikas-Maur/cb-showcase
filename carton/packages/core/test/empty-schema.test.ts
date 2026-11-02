// A schema's own rule for a state its host can't open as a project (`Schema.empty`; laptop, final candidate P2-1 and
// P3-2). An earlier build's Restore of the empty root left a version with nothing in it, which the app named again when
// its library listed the project: a name with no aspect ratio, tracks, clips or media. Restoring an older version
// brought the project back; Ctrl+Z (or `cb undo`) right after undid that restore into the named-but-empty state, and the
// editor tab that showed it crashed. Restoring that state directly was refused already, but its words said "the history
// starts there", which only a cut's start is.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { EmptyVersion, History, groupOf, nodeId } from "../src/history/index.ts";
import { isBlank } from "../src/engine/index.ts";
import type { Doc } from "../src/types.ts";

const none = (v: unknown) => !Array.isArray(v) || !v.length;
const rule = (d: Doc) => !d.aspectRatio && none(d.tracks) && none(d.items) && none(d.media);
const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, items: { key: "id" }, media: { key: "id" } }, empty: rule });
const generic = defineSchema({ collections: { tracks: { key: "id", seq: true }, items: { key: "id" }, media: { key: "id" } } });
const root = (): Doc => ({ tracks: [], items: [], media: [] });
const film = (): Doc => ({ name: "Film", aspectRatio: "16:9", tracks: [{ id: "t1", "#pos": "V" }], items: [{ id: "a", name: "a" }], media: [{ id: "m", kind: "video" }] }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };
const ME = groupOf(me);
const refusedAs = (re: RegExp) => (e: unknown) => e instanceof EmptyVersion && e.code === "EMPTY_VERSION" && re.test(e.message);

/** The laptop's history: root, import, the old bug's empty restore, the name the app gave it, then a good restore. */
function recovered() {
  const h = History.create(schema, root());
  const main = h.current;
  h.commit(main, { doc: film(), author: { kind: "system", id: "import" }, kind: "import", id: "import.p" }); // @1
  h.commit(main, { doc: root(), author: me, kind: "restore", allowEmpty: true }); // @2: the old bug
  h.commit(main, { doc: { ...root(), name: "Film" }, author: { kind: "human", id: "person" } }); // @3: named again
  const r = h.restore(main, nodeId(main, 1), { author: me }); // @4: Restore in History
  assert.equal(r.status, "confirmed");
  return { h, main };
}

test("isBlank takes the schema's rule beside core's own", () => {
  assert.equal(isBlank({ ...root(), name: "Film" } as Doc, schema), true);
  assert.equal(isBlank({ ...root(), name: "Film" } as Doc, generic), false, "a schema without a rule: a name is something");
  assert.equal(isBlank(root(), generic), true);
  assert.equal(isBlank(film(), schema), false);
});

test("P3-2: a later empty version is refused in words that say what it is; a cut's start keeps its own", () => {
  const { h, main } = recovered();
  const head = h.headSeq(main);
  for (const seq of [2, 3]) assert.throws(() => h.restore(main, nodeId(main, seq), { author: me }), refusedAs(/^Nothing to restore: that version is empty \(nothing of the project is in it\)$/), `@${seq}`);
  assert.throws(() => h.restore(main, nodeId(main, 0), { author: me }), refusedAs(/^Nothing to restore: that version is empty \(the history starts there, before the project was in it\)$/));
  // a header or a StateRef names the same version, and reads the same
  assert.throws(() => h.restore(main, { branchId: main, seq: 3 }, { author: me }), refusedAs(/nothing of the project is in it/));
  assert.equal(h.headSeq(main), head, "nothing was written");
});

test("P2-1: undo of the restore that brought the project back is refused before anything is written; so is a revert of it", () => {
  const { h, main } = recovered();
  const head = h.headSeq(main), state = h.stateOf(h.head(main));
  assert.throws(() => h.undo(main, ME, { author: me }), refusedAs(/^Can't undo that: the project would be left empty$/));
  assert.equal(h.undoStack(main, ME).length > 0, true, "there is something to undo: it is refused, not missing");
  assert.throws(() => h.planUndo(main, ME, { author: me }), refusedAs(/Can't undo that/), "a shared cut plans it the same way");
  const restoreId = h.log(main)[0]!.change!;
  assert.throws(() => h.revert(main, restoreId, { author: me }), refusedAs(/^Can't revert that: the project would be left empty$/));
  assert.equal(h.headSeq(main), head, "no version made");
  assert.deepEqual(h.stateOf(h.head(main)), state, "the project as it was");
});

test("P2-1: redo that would empty the project is refused; one that doesn't, and undo, still work", () => {
  const h = History.create(schema, root());
  const main = h.current;
  h.commit(main, { doc: film(), author: me }); // @1
  h.commit(main, { doc: root(), author: me, allowEmpty: true }); // @2: everything cleared, the aspect ratio too
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed", "undoing the clear brings the project back");
  assert.equal((h.stateOf(h.head(main)) as { name?: string }).name, "Film");
  const head = h.headSeq(main);
  assert.throws(() => h.redo(main, ME, { author: me }), refusedAs(/^Can't redo that: the project would be left empty$/));
  assert.equal(h.headSeq(main), head);
  // an edit that leaves something: undo and redo as ever
  h.commit(main, { ops: [{ op: "set", path: ["items", "a", "name"], value: "A" }], author: me });
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  assert.equal(h.redo(main, ME, { author: me }).status, "confirmed");
});

test("P2-1: only a project's head that holds something is protected; a schema without a rule undoes to an empty state as before", () => {
  // the head empty already (the broken state): an undo between two empty states changes nothing worth guarding
  const h = History.create(schema, root());
  const main = h.current;
  h.commit(main, { doc: { ...root(), name: "Film" }, author: me });
  assert.equal(h.undo(main, ME, { author: me }).status, "confirmed");
  // a generic schema: undoing its only record leaves no field and no record, and that is an ordinary undo
  const g = History.create(generic, root());
  const gm = g.current;
  g.commit(gm, { ops: [{ op: "insert", path: ["items", "a"], value: { id: "a", name: "a" } }], author: me });
  assert.equal(g.undo(gm, ME, { author: me }).status, "confirmed");
  assert.deepEqual((g.stateOf(g.head(gm)) as { items: unknown[] }).items, []);
});
