// UX redesign PLAN 5.3 (review of workstream 5 #1): a toast's Undo takes back what its action made, or nothing. The
// host checked the undo stack and then wrote: an edit that landed in between was the one taken back, and the answer
// said "confirmed". `expect` is checked inside the write, where the step is planned (a retry checks again): another
// entry on top means StackMoved, and nothing changes. History shows the stack's newest entry to a check (TopCheck),
// Carton's `expect` is one. Undo and redo on a local cut here; on a shared cut (its pending tail included) in
// packages/local/test/undo-expect-shared.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { History, STORE_TABLES, groupOf, type TopCheck } from "../src/history/index.ts";
import { Carton, type CommitResult } from "../src/index.ts";
import type { Doc, Op } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const schema = defineSchema({ collections: { items: { key: "id" } } });
const film = (): Doc => ({ name: "Film", items: ["a", "b"].map((id) => ({ id, name: id })) }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };
const ME = groupOf(me);
const set = (id: string, name: string): Op => ({ op: "set", path: ["items", id, "name"], value: name });
const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const open = () => Carton.open({ adapter, store: createMemoryStore(), init: { doc: film(), cutName: "Main cut" }, actor: me });
const moved = (e: Error & { code?: string }) => e.code === "STACK_MOVED";
const idOf = (r: CommitResult): string => (r.status === "confirmed" && r.change ? r.change.id : assert.fail(`no change: ${JSON.stringify(r)}`));
// what a confirmed step answered: its seq and change, and whether it was a remembered no-op
const answer = (r: CommitResult) => (r.status === "confirmed" ? { seq: r.seq, change: idOf(r), empty: !!r.empty } : assert.fail(JSON.stringify(r)));
const names = async (c: Carton | History, cut?: string) => {
  const doc = c instanceof History ? c.stateOf(c.head(cut!)) : (await c.head()).doc;
  return Object.fromEntries((doc as unknown as { items: { id: string; name: string }[] }).items.map((r) => [r.id, r.name]));
};

test("PLAN 5.3: undo with `expect` takes back that entry, or, with another on top, nothing (StackMoved)", async () => {
  const c = await open();
  try {
    const action = idOf(await c.commit({ ops: [set("a", "A")] }));
    // an edit lands after the action (an agent turn the person started, a GUI save): it is on top now
    const newer = idOf(await c.commit({ ops: [set("b", "B")] }));
    const before = (await c.log()).length;
    await assert.rejects(c.undo(ME, { expect: action }), moved, "the toast's Undo would take back the newer edit: refused");
    assert.equal((await c.log()).length, before, "nothing written");
    assert.deepEqual(await names(c), { a: "A", b: "B" });
    // the newer edit's own id: taken back, as Ctrl+Z would
    const undoOfNewer = idOf(await c.undo(ME, { expect: newer }));
    assert.deepEqual(await names(c), { a: "A", b: "b" });
    // now the action is on top: its Undo works
    const undoOfAction = idOf(await c.undo(ME, { expect: action }));
    assert.deepEqual(await names(c), { a: "a", b: "b" });
    // redo: the newest undo only
    const undone = (await c.log()).length;
    await assert.rejects(c.redo(ME, { expect: undoOfNewer }), moved);
    assert.equal((await c.log()).length, undone, "nothing written");
    assert.equal((await c.redo(ME, { expect: undoOfAction })).status, "confirmed");
    assert.deepEqual(await names(c), { a: "A", b: "b" });
  } finally {
    await c.close();
  }
  // an empty stack is no entry either
  const c2 = await open();
  try {
    await assert.rejects(c2.undo(ME, { expect: "nope" }), moved);
    await assert.rejects(c2.redo(ME, { expect: "nope" }), moved);
  } finally {
    await c2.close();
  }
});

test("PLAN 5.3: Carton.undo/redo pass `expect` through, and a refusal leaves the handle as it was (no rebuild needed)", async () => {
  // a rebuild reads the store's lineage table again: count those reads
  const store = createMemoryStore();
  let builds = 0;
  const spied = new Proxy(store, {
    get: (o, k) => (k === "range" ? (t: string, r?: object) => (t === STORE_TABLES.lineage && builds++, o.range(t, r)) : typeof Reflect.get(o, k) === "function" ? Reflect.get(o, k).bind(o) : Reflect.get(o, k)),
  });
  const c = await Carton.open({ adapter, store: spied, init: { doc: film(), cutName: "Main cut" }, actor: me });
  try {
    const a = await c.commit({ ops: [set("a", "A")] });
    assert.equal(a.status, "confirmed");
    const action = a.status === "confirmed" ? a.change!.id : "";
    await c.commit({ ops: [set("b", "B")] });
    const before = (await c.log()).length;
    const built = builds;
    await assert.rejects(c.undo(ME, { expect: action }), moved);
    await assert.rejects(c.redo(ME, { expect: action }), moved);
    assert.equal(builds, built, "no rebuild");
    assert.equal((await c.log()).length, before, "nothing written");
    const top = (await c.undoStack(ME, { limit: 1 }))[0]!;
    assert.equal((await c.undo(ME, { expect: top.changeId })).status, "confirmed", "the handle goes on as before");
    assert.equal((await c.undo(ME, { expect: action })).status, "confirmed");
    const doc = (await c.head()).doc as unknown as { items: { id: string; name: string }[] };
    assert.deepEqual(doc.items.map((i) => i.name), ["a", "b"]);
  } finally {
    await c.close();
  }
});

test("PLAN 5.3: a retried step (its id already confirmed) answers the first try, though that step moved the stack; a refused one keeps no answer", async () => {
  const c = await open();
  try {
    const action = idOf(await c.commit({ ops: [set("a", "A")] }));
    const newer = idOf(await c.commit({ ops: [set("b", "B")] }));
    // refused under an id: nothing is kept for it, so the same id steps once its entry is on top
    await assert.rejects(c.undo(ME, { expect: action, id: "toast.1" }), moved);
    await c.undo(ME, { expect: newer });
    const first = await c.undo(ME, { expect: action, id: "toast.1" });
    assert.equal(answer(first).change, "toast.1");
    assert.equal(answer(first).empty, false, "a change, not a remembered no-op");
    assert.deepEqual(await names(c), { a: "a", b: "b" });
    // the retry: `action` is no longer on top (its own undo moved the stack), and the id is answered first
    const before = (await c.log()).length;
    const again = await c.undo(ME, { expect: action, id: "toast.1" });
    assert.deepEqual(answer(again), answer(first));
    assert.equal((await c.log()).length, before, "no second change");
    // redo the same way
    const redo = await c.redo(ME, { expect: "toast.1", id: "toast.2" });
    assert.equal(answer(redo).change, "toast.2");
    const redoAgain = await c.redo(ME, { expect: "toast.1", id: "toast.2" });
    assert.deepEqual(answer(redoAgain), answer(redo));
    assert.deepEqual(await names(c), { a: "A", b: "b" });
  } finally {
    await c.close();
  }
});

test("History's TopCheck: shown the stack's newest entry before the step is planned; a throw refuses it and nothing changes; a retried id is answered first", async () => {
  const h = History.create(schema, film(), { cut: "Main cut" });
  const main = h.current;
  const seen: (string | undefined)[] = [];
  const look: TopCheck = (top) => void seen.push(top?.changeId);
  const no: TopCheck = () => {
    throw new Error("refused");
  };
  // empty stacks: shown nothing
  const emptyStep = (r: CommitResult) => r.status === "confirmed" && r.empty === true;
  assert.ok(emptyStep(h.undo(main, ME, { author: me, check: look })), "nothing to undo");
  assert.ok(emptyStep(h.redo(main, ME, { author: me, check: look })), "nothing to redo");
  assert.deepEqual(seen.splice(0), [undefined, undefined]);
  h.commit(main, { ops: [set("a", "A")], author: me });
  const edit = h.changes(main).at(-1)!.id;
  const seq = h.headSeq(main);
  assert.throws(() => h.undo(main, ME, { author: me, check: no, id: "u.1" }), /refused/);
  assert.throws(() => h.planUndo(main, ME, { author: me, check: no }), /refused/);
  assert.equal(h.headSeq(main), seq, "nothing written");
  assert.equal(h.confirmedById("u.1"), null, "nothing kept for the refused id");
  const first = h.undo(main, ME, { author: me, check: look, id: "u.1" });
  assert.deepEqual(seen.splice(0), [edit]);
  // the retry: answered before any check (its own step moved the stack)
  assert.deepEqual(answer(h.undo(main, ME, { author: me, check: no, id: "u.1" })), answer(first));
  assert.throws(() => h.redo(main, ME, { author: me, check: no }), /refused/);
  assert.throws(() => h.planRedo(main, ME, { author: me, check: no }), /refused/);
  assert.equal(h.headSeq(main), seq + 1, "nothing written");
  assert.equal(h.redo(main, ME, { author: me, check: look }).status, "confirmed");
  assert.deepEqual(seen.splice(0), ["u.1"]);
  assert.deepEqual(await names(h, main), { a: "A", b: "b" });
});

test("PLAN 5.3: an edit still on its way to the store when the toast's Undo (or Redo) starts lands first, and is the one on top: StackMoved, both edits kept", async () => {
  // review of fix/ux-size: the check must be made inside the Undo's own write, after the writes queued before it.
  // The newer edit is held at its first store call (its refresh, before it plans anything); the Undo starts while it
  // waits. A check made when the Undo is called (the model still has the action on top) would take back the newer edit.
  const store = createMemoryStore();
  let gate: Promise<void> | null = null;
  let entered: () => void = () => {};
  const held = new Proxy(store, {
    get: (o, k) => {
      const v = Reflect.get(o, k);
      if (typeof v !== "function") return v;
      if (k === "watch" || k === "close") return v.bind(o);
      return async (...a: unknown[]) => {
        if (gate) {
          const g = gate;
          gate = null;
          entered();
          await g;
        }
        return v.apply(o, a);
      };
    },
  });
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (entered = r));
    return { reached, release };
  };
  const c = await Carton.open({ adapter, store: held, init: { doc: film(), cutName: "Main cut" }, actor: me });
  try {
    const action = idOf(await c.commit({ ops: [set("a", "A")] }));
    let h = hold();
    const newer = c.commit({ ops: [set("b", "B")] });
    await h.reached;
    const undo = c.undo(ME, { expect: action });
    h.release();
    assert.equal((await newer).status, "confirmed");
    await assert.rejects(undo, moved, "the newer edit landed first: the toast's Undo would take it back, so it's refused");
    assert.deepEqual(await names(c), { a: "A", b: "B" }, "both edits kept");

    // redo: an edit on its way clears the redo stack before the toast's Redo runs
    const undoOfNewer = idOf(await c.undo(ME));
    assert.deepEqual(await names(c), { a: "A", b: "b" });
    h = hold();
    const another = c.commit({ ops: [set("a", "A2")] });
    await h.reached;
    const redo = c.redo(ME, { expect: undoOfNewer });
    h.release();
    assert.equal((await another).status, "confirmed");
    await assert.rejects(redo, moved, "the edit that landed first cleared the redo: refused");
    assert.deepEqual(await names(c), { a: "A2", b: "b" }, "nothing redone");
  } finally {
    await c.close();
  }
});
