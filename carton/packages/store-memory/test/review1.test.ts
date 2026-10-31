// Regression tests for the GPT 6.1 Sol review round 1 findings (carton-build/reviews/foundation-core.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, History, StateUnknown, rippleDelete, remapSpan, type Actor, type Doc, type Rec, type ShallowExport, type Store } from "@carton/core";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, schema, clip, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob" };
const two = async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  return { data, a, b };
};
const edit = (d: Doc, id: string, f: string, v: unknown): Doc => ({ ...d, items: (d.items as Rec[]).map((i) => (i.id === id ? { ...i, [f]: v } : i)) });

test("R1-1 whole-doc commits from the same head in two processes: the loser's retry keeps the winner's edit", async () => {
  const { a, b } = await two();
  const ha = (await a.head()).doc,
    hb = (await b.head()).doc;
  const [ra, rb] = await Promise.all([a.commit({ doc: edit(ha, "a", "name", "A") }), b.commit({ doc: edit(hb, "b", "name", "B") })]);
  assert.equal(ra.status, "confirmed");
  assert.equal(rb.status, "confirmed");
  const head = (await a.head()).doc;
  assert.equal(item(head, "a")!.name, "A");
  assert.equal(item(head, "b")!.name, "B");
});

test("R1-2 reopening a store rebuilds intermediate keyframes from the log, not from the final head", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, keyframeEvery: 2 });
  for (const n of ["one", "two", "three"]) await c.commit({ ops: [set("a", "name", n)] });
  const again = await Carton.open({ adapter, store, keyframeEvery: 2 });
  assert.equal(item(await again.checkout(`${again.cut}@2`), "a")!.name, "two");
  assert.equal(item(await again.checkout(`${again.cut}@1`), "a")!.name, "one");
});

test("R1-3 a Store write that throws leaves no ghost change in the live model", async () => {
  const inner = createMemoryStore();
  let fail = false;
  const store: Store = { ...inner, info: inner.info, get: inner.get, range: inner.range, close: inner.close, write: async (w, c) => (fail ? Promise.reject(new Error("disk full")) : inner.write(w, c)) };
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  fail = true;
  await assert.rejects(c.commit({ ops: [set("a", "name", "lost")] }), /disk full/);
  fail = false;
  assert.equal((await c.log()).length, 1, "only the root: the failed commit is not in the model");
  const r = await c.commit({ ops: [set("b", "name", "kept")] });
  assert.ok(r.status === "confirmed" && r.seq === 1);
  const again = await Carton.open({ adapter, store });
  assert.equal(item((await again.head()).doc, "b")!.name, "kept");
});

test("R1-4 a partial fold whose inverse would be invalid commits nothing", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  // the variant moves every clip of t1 to t2 and removes t1
  const hv = (await c.head(v.id)).doc;
  const moved = { ...hv, tracks: (hv.tracks as Rec[]).filter((t) => t.id !== "t1"), items: (hv.items as Rec[]).map((i) => ({ ...i, trackId: "t2" })) };
  assert.equal((await c.commit({ cut: v.id, doc: moved })).status, "confirmed");
  const r = await c.foldSome(v.id, { reject: ["items/a"] });
  assert.equal(r.status, "rejected");
  assert.equal((await c.log()).length, 1, "Main is untouched");
  assert.equal(item((await c.head()).doc, "a")!.trackId, "t1");
});

test("R1-5 pins across processes: B resolves A's pin; B's owner and A's owner both hold it; one release keeps it alive", async () => {
  const { a, b } = await two();
  const held = edit((await a.head()).doc, "a", "name", "draft");
  const pa = await a.pin({ owner: "turn-a", doc: held });
  assert.equal(item(await b.checkout(pa.header), "a")!.name, "draft", "B sees A's pin");
  await b.pin({ owner: "view-b", doc: held });
  await a.release(pa.ref, "turn-a");
  assert.equal(item(await b.checkout(pa.header), "a")!.name, "draft", "B's owner still holds the row");
  await b.release(pa.ref, "view-b");
  await assert.rejects(a.checkout(pa.header), (e: unknown) => e instanceof StateUnknown);
});

test("R1-6 growing metadata is one key per entry: another process's commit never drops an export marker or a rid", async () => {
  const { data, a, b } = await two();
  await a.exportShallow({ to: "carol" });
  await b.commit({ ops: [set("a", "name", "B")] });
  await a.commit({ ops: [set("b", "name", "A")] });
  const meta = await createMemoryStore({ shared: data }).range("meta");
  assert.equal(meta.filter((e) => e.key[0] === "rid").length, 2, "both replica ids are recorded");
  assert.equal(meta.filter((e) => e.key[0] === "export").length, 1, "the export marker survives");
  const c = await Carton.open({ adapter, store: createMemoryStore({ shared: data }) });
  const pkg = await c.exportShallow({ to: "dave" });
  const head0 = pkg.nodes.find((n) => n.seq === 0);
  assert.ok(head0?.kinds.includes("export") || pkg.nodes.some((n) => n.kinds.includes("export")), "the first export is still a lineage node");
});

test("R1-7 a change id is confirmed once across every cut", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  const r1 = await c.commit({ ops: [set("a", "name", "x")], id: "retry.1" });
  const r2 = await c.commit({ cut: v.id, ops: [set("a", "name", "x")], id: "retry.1" });
  assert.ok(r1.status === "confirmed" && r2.status === "confirmed");
  assert.equal(r2.status === "confirmed" && r2.ref.branchId, c.cut, "acked as the change already confirmed on Main");
  assert.equal((await c.log({ cut: v.id })).length, 1, "nothing landed on the variant");
});

test("R1-8 restore and fork from a pinned held state keep its unconfirmed edits", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const held = edit((await c.head()).doc, "a", "name", "held edit");
  const p = await c.pin({ owner: "freeze", doc: held });
  await c.commit({ ops: [set("b", "name", "later")] });
  const v = await c.fork("from held", { from: p.header });
  assert.equal(item((await c.head(v.id)).doc, "a")!.name, "held edit");
  assert.equal((await c.restore(p.header)).status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(item(head, "a")!.name, "held edit");
  assert.equal(item(head, "b")!.name, "b");
  await assert.rejects(c.fold(p.header), /pinned state, not a version/);
});

test("R1-9 undo inverts a ripple as a remap: a clip placed later in its coordinates moves back with it", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const maps = { t1: rippleDelete(5, 5) };
  const ops: ReturnType<typeof set>[] = [];
  const del = { op: "remove" as const, path: ["items", "b"] };
  for (const it of doc0().items as Rec[]) {
    if (it.id === "b") continue;
    const m = remapSpan(maps.t1, it.startTime as number, it.endTime as number);
    if (m && m[0] !== it.startTime) ops.push(set(it.id as string, "startTime", m[0]), set(it.id as string, "endTime", m[1]));
  }
  assert.equal((await c.commit({ ops: [del, ...ops], intent: { kind: "ripple-delete", maps } })).status, "confirmed");
  // Bob places a clip at 30–32 on t1, in the rippled coordinates (after f, which now ends at 25)
  assert.equal((await c.commit({ ops: [{ op: "insert", path: ["items", "g"], value: clip("g", 30, 32) }], author: bob })).status, "confirmed");
  const u = await c.undo();
  assert.equal(u.status, "confirmed");
  const head = (await c.head()).doc;
  assert.deepEqual([item(head, "b")!.startTime, item(head, "f")!.startTime], [5, 25]);
  assert.deepEqual([item(head, "g")!.startTime, item(head, "g")!.endTime], [35, 37], "Bob's clip moves with the ripple's inverse");
  assert.equal(u.status === "confirmed" && u.change?.intent?.kind, "inverse");
});

test("R1-10 a confirmed local change that creates an overlap returns a warning and emits it", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const seen: unknown[] = [];
  c.on((e) => e.type === "warning" && seen.push(e.warnings));
  const r = await c.commit({ ops: [set("a", "endTime", 7), set("a", "trimEnd", 7)] });
  assert.ok(r.status === "confirmed");
  assert.deepEqual(r.status === "confirmed" && r.warnings, [{ kind: "overlap", items: ["a", "b"] }]);
  assert.equal(seen.length, 1);
  const r2 = await c.commit({ ops: [set("a", "name", "style only")] });
  assert.ok(r2.status === "confirmed" && !r2.warnings, "an overlap that was already there isn't reported again");
});

test("R1-11 a pin with no ttl stores no Infinity (JSON-safe)", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  await c.pin({ owner: "forever" });
  const rows = await store.range<{ owners: { expires: unknown }[] }>("pins");
  assert.equal(rows[0]!.value.owners[0]!.expires, null);
  assert.equal(JSON.stringify(rows[0]!.value).includes("null"), true);
});

test("R1-12 folding an imported (shallow) cut by its id folds its newest node", async () => {
  const alice2 = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });
  const pkg = await alice2.exportShallow({ to: "bob" });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { import: pkg }, actor: bob });
  await alice2.commit({ ops: [set("a", "name", "Summer")] });
  const pkg2 = await alice2.exportShallow({ to: "bob" });
  assert.equal((await b.importShallow(pkg2)).status, "imported");
  const shallow = (await b.cuts()).find((x) => x.shallow)!;
  const f = await b.fold(shallow.id);
  assert.equal(f.status, "confirmed");
  assert.equal(item((await b.head()).doc, "a")!.name, "Summer");
});

test("R1-13 a shallow export with a cyclic lineage is refused at import", () => {
  const h = History.create(schema, doc0(), { cut: "main" });
  h.commit(h.current, { ops: [set("a", "name", "x")], author: alice });
  const pkg = JSON.parse(JSON.stringify(h.exportShallow(h.current))) as ShallowExport;
  const head = pkg.nodes.find((n) => n.id === pkg.head)!;
  head.parents = [{ id: head.id, remap: {} }];
  const r = new History(schema);
  assert.throws(() => r.importShallow(pkg), /cycle/);
});

test("R1-14 fold-some rejects a record whose id contains '/' (escaped path key)", async () => {
  const d = doc0();
  (d.items as Rec[]).push(clip("x/y", 40, 45));
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: d }, actor: alice });
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("x/y", "name", "theirs"), set("a", "name", "theirs too")] });
  const r = await c.foldSome(v.id, { reject: ["items/x~1y"] });
  assert.equal(r.status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(item(head, "x/y")!.name, "x/y", "the rejected record keeps Main's value");
  assert.equal(item(head, "a")!.name, "theirs too");
});
