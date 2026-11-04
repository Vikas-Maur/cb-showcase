// Stable ids beyond commit (local-cli, R4-04): fold, fold-some, restore, revert, undo and fork retried with the same id
// return the first confirmation and never make a second change, in the same process or another one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CommitResult } from "@carton/core";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob" };
const seqOf = (r: { status: string; seq?: number }) => (r.status === "confirmed" ? (r as { seq: number }).seq : -1);

test("fold, fold-some, restore, revert and undo retried with their id make one change each", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v1 = await c.fork("v1");
  await c.commit({ cut: v1.id, ops: [set("a", "name", "v1")], author: bob });
  const f1 = await c.fold(v1.id, { id: "cb.fold.1" });
  const f2 = await c.fold(v1.id, { id: "cb.fold.1" });
  assert.equal(seqOf(f1), 1);
  assert.equal(seqOf(f2), 1, "the retry returns the first fold");
  const v2 = await c.fork("v2");
  await c.commit({ cut: v2.id, ops: [set("b", "name", "v2"), set("c", "name", "v2")], author: bob });
  const s1 = await c.foldSome(v2.id, { reject: ["items/c"], id: "cb.some.1" });
  const s2 = await c.foldSome(v2.id, { reject: ["items/c"], id: "cb.some.1" });
  assert.equal(seqOf(s1), 3, "the fold and its inverse");
  assert.equal(seqOf(s2), 3);
  const r1 = await c.restore(`${c.cut}@0`, { id: "cb.restore.1" });
  const r2 = await c.restore(`${c.cut}@0`, { id: "cb.restore.1" });
  assert.equal(seqOf(r1), 4);
  assert.equal(seqOf(r2), 4);
  const changeId = (r1 as CommitResult & { status: "confirmed" }).change!.id;
  const x1 = await c.revert(changeId, { id: "cb.revert.1" });
  const x2 = await c.revert(changeId, { id: "cb.revert.1" });
  assert.equal(seqOf(x1), 5);
  assert.equal(seqOf(x2), 5);
  await c.commit({ ops: [set("d", "name", "mine")] });
  const u1 = await c.undo(undefined, { id: "cb.undo.1" });
  const u2 = await c.undo(undefined, { id: "cb.undo.1" });
  assert.equal(seqOf(u1), 7);
  assert.equal(seqOf(u2), 7, "a retried undo doesn't undo the next entry");
  assert.equal((await c.head()).ref.seq, 7, "7 changes, none twice");
  // a fold-some's fold and its inverse are one version (UI audit P1-3): root + 6 versions
  assert.equal((await c.log()).length, 7, "root + 6 versions");
});

test("a retry from another process (the next lease holder) returns the first process's confirmation", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  await a.commit({ ops: [set("a", "name", "x")] });
  const u1 = await a.undo(undefined, { id: "helper.undo.7" });
  const u2 = await b.undo(undefined, { id: "helper.undo.7" });
  assert.equal(seqOf(u1), 2);
  assert.equal(seqOf(u2), 2);
  assert.equal((await b.log()).length, 3);
  const f1 = await a.fork("variant", { id: "cut-from-cb-1" });
  const f2 = await b.fork("variant", { id: "cut-from-cb-1" });
  assert.equal(f2.id, f1.id);
  assert.equal((await b.cuts()).filter((x) => x.name === "variant").length, 1, "one cut");
  assert.equal(item((await b.head()).doc, "a")!.name, "a");
});
