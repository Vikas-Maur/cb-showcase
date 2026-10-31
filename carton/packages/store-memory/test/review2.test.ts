// Regression tests for the GPT 6.1 Sol review round 2 findings (carton-build/reviews/foundation-core.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, History, rippleDelete, remapSpan, type Actor, type Doc, type Rec, type ShallowExport } from "@carton/core";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, schema, clip, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob" };

test("R2-1 fold-some with a repeated or nested reject path of a removed record commits nothing", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [{ op: "remove", path: ["items", "a"] }, set("b", "name", "theirs")] });
  const twice = await c.foldSome(v.id, { reject: ["items/a", "items/a"] });
  assert.equal(twice.status, "confirmed", "a repeated path is one path: the record comes back once");
  assert.ok(item((await c.head()).doc, "a"));
  assert.equal(item((await c.head()).doc, "b")!.name, "theirs");
  const c2 = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v2 = await c2.fork("variant");
  await c2.commit({ cut: v2.id, ops: [{ op: "remove", path: ["items", "a"] }] });
  const field = await c2.foldSome(v2.id, { reject: ["items/a/name"] });
  assert.equal(field.status, "rejected", "a field of a record the fold removed can't be left out on its own");
  assert.equal((await c2.log()).length, 1, "nothing committed");
  assert.ok(item((await c2.head()).doc, "a"));
});

test("R2-2 undo of a fold that brought in a ripple moves a later clip back with it", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  const maps = { t1: rippleDelete(5, 5) };
  const ops: unknown[] = [{ op: "remove", path: ["items", "b"] }];
  for (const it of doc0().items as Rec[]) {
    if (it.id === "b") continue;
    const m = remapSpan(maps.t1, it.startTime as number, it.endTime as number);
    if (m && m[0] !== it.startTime) ops.push(set(it.id as string, "startTime", m[0]), set(it.id as string, "endTime", m[1]));
  }
  assert.equal((await c.commit({ cut: v.id, ops: ops as never, intent: { kind: "ripple-delete", maps }, author: bob })).status, "confirmed");
  assert.equal((await c.fold(v.id)).status, "confirmed");
  assert.equal(item((await c.head()).doc, "f")!.startTime, 20);
  await c.commit({ ops: [{ op: "insert", path: ["items", "g"], value: clip("g", 30, 32) }], author: bob });
  const u = await c.undo();
  assert.equal(u.status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(item(head, "b")!.startTime, 5);
  assert.equal(item(head, "f")!.startTime, 25);
  assert.deepEqual([item(head, "g")!.startTime, item(head, "g")!.endTime], [35, 37], "the later clip moves back with the fold's ripple");
});

test("R2-3 a re-import can't rewrite a known lineage node's parents into a cycle through local history", () => {
  const a = History.create(schema, doc0(), { cut: "main" });
  a.commit(a.current, { ops: [set("a", "name", "x")], author: alice });
  const pkg = a.exportShallow(a.current);
  const b = new History(schema);
  b.importShallow(JSON.parse(JSON.stringify(pkg)) as ShallowExport);
  b.commit(b.current, { ops: [set("b", "name", "y")], author: bob });
  const local = b.head(b.current);
  const tampered = JSON.parse(JSON.stringify(pkg)) as ShallowExport;
  tampered.nodes.find((n) => n.id === tampered.head)!.parents = [{ id: local, remap: {} }];
  b.importShallow(tampered);
  assert.equal(b.parents(pkg.head).includes(local), false, "the known node keeps its parents");
  assert.doesNotThrow(() => b.mergeBase(local, pkg.head));
  // a brand-new node pointing at itself is still refused
  const self = JSON.parse(JSON.stringify(pkg)) as ShallowExport;
  const fresh = { ...self.nodes.find((n) => n.id === self.head)!, id: `${self.nodes[0]!.branchId}@99`, seq: 99 };
  fresh.parents = [{ id: fresh.id, remap: {} }];
  self.nodes.push(fresh);
  assert.throws(() => b.importShallow(self), /cycle/);
});

test("R2-5 restore(cut id) restores that cut's head as of now, not a stale cached one", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  await a.head();
  await b.commit({ ops: [set("c", "name", "from b")] });
  const r = await a.restore(a.cut);
  assert.equal(r.status, "confirmed");
  assert.equal(item((await a.head()).doc, "c")!.name, "from b", "the other process's edit is kept");
});

test("R2-6 a dry-run fold with choices previews the resolved state", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("a", "name", "theirs")], author: bob });
  await c.commit({ ops: [set("a", "name", "ours")] });
  const dry = await c.fold(v.id, { check: true, choices: ["theirs"] });
  assert.equal(dry.status, "confirmed");
  assert.deepEqual(dry.preview?.ops, [{ op: "set", path: ["items", "a", "name"], value: "theirs" }]);
  assert.equal((await c.log()).length, 2, "nothing committed");
});
