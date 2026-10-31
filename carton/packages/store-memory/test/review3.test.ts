// Regression tests for the GPT 6.1 Sol review round 3 findings (carton-build/reviews/foundation-core.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, History, type Actor, type Doc, type Rec } from "@carton/core";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob" };

test("R3-1 an id-carrying write that changed nothing stays a no-op on retry, here and in another process", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  const u = await a.undo(undefined, { id: "cb.undo.empty" });
  assert.ok(u.status === "confirmed" && u.empty);
  await a.commit({ ops: [set("a", "name", "keep me")] });
  const again = await a.undo(undefined, { id: "cb.undo.empty" });
  assert.ok(again.status === "confirmed" && again.empty, "the retry doesn't undo the new edit");
  const other = await b.undo(undefined, { id: "cb.undo.empty" });
  assert.ok(other.status === "confirmed" && other.empty, "nor does a retry from another process");
  const r = await a.restore(`${a.cut}@1`, { id: "cb.restore.same" });
  assert.ok(r.status === "confirmed" && r.empty, "restoring the head is a no-op");
  await b.commit({ ops: [set("b", "name", "later")] });
  assert.ok((await b.restore(`${a.cut}@1`, { id: "cb.restore.same" })).status === "confirmed");
  const head = (await a.head()).doc;
  assert.equal(item(head, "a")!.name, "keep me");
  assert.equal(item(head, "b")!.name, "later", "the retried restore didn't revert the later edit");
  // a cb save of the file as it already is (an unchanged doc) changes nothing; its retry, after another edit, neither
  const same = (await a.head()).doc;
  const c1 = await a.commit({ doc: same, id: "cb.commit.same" });
  assert.ok(c1.status === "confirmed" && c1.empty);
  await a.commit({ ops: [set("a", "name", "changed")] });
  const c2 = await b.commit({ doc: same, id: "cb.commit.same" });
  assert.ok(c2.status === "confirmed" && c2.empty);
  assert.equal(item((await a.head()).doc, "a")!.name, "changed");
});

test("R3-2 a Published cut refuses restore and fold as well as commit (History guards every write)", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  await c.commit({ ops: [set("a", "name", "v1")] });
  const pub = await c.publish();
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("b", "name", "v")] });
  await assert.rejects(c.restore(`${c.cut}@0`, { cut: pub.id }), /Published cut/);
  await assert.rejects(c.fold(v.id, { into: pub.id }), /Published cut/);
  await assert.rejects(c.commit({ cut: pub.id, ops: [set("a", "name", "x")] }), /Published cut/);
  assert.equal((await c.log({ cut: pub.id })).length, 1, "nothing landed on it");
  // publishing a held state is still allowed: that is the one change a Published cut takes
  const held = { ...(await c.head()).doc, name: "Held title" } as Doc;
  const p = await c.pin({ owner: "freeze", doc: held });
  const pub2 = await c.publish({ from: p.header });
  assert.equal((await c.head(pub2.id)).doc.name, "Held title");
});

test("R3-3/4 all-cards: values and prefer are honoured, and fold-some can complete a decided all-cards fold", () => {
  // two lineages that share nothing: Alice's main and Bob's import of an unrelated copy, joined by a 2-way compare
  const alice2 = History.create(schema, doc0(), { cut: "main" });
  const bobCopy = History.create(schema, { ...doc0(), name: "Bob's film" }, { cut: "main", projectId: alice2.projectId! });
  bobCopy.commit(bobCopy.current, { ops: [set("a", "name", "bob a"), set("b", "name", "bob b")], author: bob });
  const pkg = JSON.parse(JSON.stringify(bobCopy.exportShallow(bobCopy.current)));
  // make it known lineage-wise without a shared node: rename its project, import into a fresh history that shares
  // the project but holds alice's main too
  const r = History.create(schema, doc0(), { cut: "main", projectId: alice2.projectId! });
  pkg.nodes.push({ id: `${r.current}@0`, branchId: r.current, seq: 0, hash: r.hashOf(`${r.current}@0`), kinds: ["root"], parents: [] });
  assert.equal(r.importShallow(pkg).status, "imported");
  const head = pkg.head as string;
  const cmp = r.fold(r.current, head, { author: alice, missingBase: "all-cards" });
  assert.equal(cmp.status, "compare");
  const cards = cmp.status === "compare" ? cmp.cards : [];
  const byPath = Object.fromEntries(cards.map((c) => [c.path, c]));
  assert.ok(byPath["items/a"] && byPath["items/b"] && byPath["name"]);
  const custom = { ...(byPath["items/a"]!.ours as Rec), name: "custom a" };
  const done = r.fold(r.current, head, { author: alice, missingBase: "all-cards", choices: { "items/a": { value: custom } }, unchosen: "prefer", prefer: "theirs" });
  assert.equal(done.status, "confirmed");
  const s = r.stateOf(r.head(r.current))!;
  assert.equal(item(s, "a")!.name, "custom a", "a {value} choice is applied");
  assert.equal(item(s, "b")!.name, "bob b", "undecided cards take prefer (theirs)");
  assert.equal(s.name, "Bob's film");
  // fold-some through a decided all-cards fold
  const r2 = History.create(schema, doc0(), { cut: "main", projectId: alice2.projectId! });
  const pkg2 = JSON.parse(JSON.stringify(bobCopy.exportShallow(bobCopy.current)));
  pkg2.nodes.push({ id: `${r2.current}@0`, branchId: r2.current, seq: 0, hash: r2.hashOf(`${r2.current}@0`), kinds: ["root"], parents: [] });
  r2.importShallow(pkg2);
  const some = r2.foldSome(r2.current, pkg2.head, { author: alice, missingBase: "all-cards", choices: () => "theirs", reject: ["items/b"] });
  assert.equal(some.status, "confirmed");
  const s2 = r2.stateOf(r2.head(r2.current))!;
  assert.equal(item(s2, "a")!.name, "bob a");
  assert.equal(item(s2, "b")!.name, "b", "the rejected record keeps Main's value");
});

test("R3-5 publishing an unedited variant names the variant as its source; its later edits are 'newer'", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("30s cut");
  const pub = await c.publish({ from: v.id });
  let list = (await c.publications()).find((p) => p.cut.id === pub.id)!;
  assert.equal(list.source, v.id);
  assert.equal(list.newer, false);
  await c.commit({ cut: v.id, ops: [set("a", "name", "trimmed")] });
  list = (await c.publications()).find((p) => p.cut.id === pub.id)!;
  assert.equal(list.newer, true);
});

test("R3-6 a rename shows in another open handle", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  const v = await a.fork("variant");
  assert.ok((await b.cuts()).some((x) => x.id === v.id));
  await a.renameCut(v.id, "Director's cut");
  assert.equal((await b.cuts()).find((x) => x.id === v.id)?.name, "Director's cut");
});
