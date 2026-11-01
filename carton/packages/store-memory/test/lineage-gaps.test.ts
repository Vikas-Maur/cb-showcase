// kit-docs' lineage gaps (notes/kit-docs.md; their LIMITS.md), against PLAN §7: "Edits to split items follow their
// lineage", and "raise a card rather than guess: a retime of a clip the other side split".
// 1. A fold used each side's recorded maps only, not their split lineage: an edit of a clip the other side split
//    reached one piece. It composes maps and lineage along each side's path now, and records the lineage it brings in
//    on the merge's edges, so a later fold through that merge (or a .cbproj edge) still has it.
// 2. A shared cut's commit made on an older version followed neither the head's ripples nor its splits (SF4-4 fixed
//    it; here in both orders).
// 3. A track change of a split clip moved one piece; a retime of it moved or trimmed one piece. The track change
//    follows the lineage; a real retime is a card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, rippleDelete, remapSpan, type Doc, type Op, type Rec } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, clip, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

// c (10–15) split at 12.5 into c (10–12.5) and c-b (12.5–15): a split records lineage only, no remap
const split = [
  set("c", "endTime", 12.5),
  set("c", "trimEnd", 2.5),
  { op: "insert" as const, path: ["items", "c-b"], value: { ...clip("c-b", 12.5, 15), trimStart: 2.5, trimEnd: 5, name: "c" } },
];
const splitIntent = { kind: "split", lineage: { c: ["c", "c-b"] } };
const EDITS = {
  color: { ops: [set("c", "color", "red")], field: "color", want: "red" },
  track: { ops: [set("c", "trackId", "t2")], field: "trackId", want: "t2" },
} as const;
const pieces = (d: Doc, field: string) => ["c", "c-b"].map((id) => (item(d, id) as Rec | undefined)?.[field]);

for (const edit of ["color", "track"] as const)
  for (const splitOn of ["into", "from"] as const)
    test(`fold: a ${edit} edit of a clip the other cut split reaches both pieces (split on the cut folded ${splitOn === "into" ? "into" : "in"})`, async () => {
      const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
      const main = c.cut;
      const v = (await c.fork("v", { from: `${main}@0` })).id;
      const e = EDITS[edit];
      assert.equal((await c.commit({ cut: splitOn === "into" ? main : v, ops: split, intent: splitIntent })).status, "confirmed");
      assert.equal((await c.commit({ cut: splitOn === "into" ? v : main, ops: [...e.ops] })).status, "confirmed");
      const f = await c.fold(v, { into: main });
      assert.equal(f.status, "confirmed", JSON.stringify(f).slice(0, 300));
      assert.deepEqual(pieces((await c.head(main)).doc, e.field), [e.want, e.want]);
      await c.close();
    });

test("fold: a split a cut took in by an earlier fold still reaches every piece (lineage on the merge's edges)", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const main = c.cut;
  const v = (await c.fork("v", { from: `${main}@0` })).id;
  const w = (await c.fork("w", { from: `${main}@0` })).id;
  await c.commit({ cut: main, ops: split, intent: splitIntent });
  await c.commit({ cut: v, ops: [set("a", "name", "v's a")] });
  assert.equal((await c.fold(main, { into: v })).status, "confirmed");
  await c.commit({ cut: w, ops: [set("c", "color", "red")] });
  // w's base is main@0; v's path from it crosses the merge that brought the split in
  const f = await c.fold(w, { into: v });
  assert.equal(f.status, "confirmed", JSON.stringify(f).slice(0, 300));
  assert.deepEqual(pieces((await c.head(v)).doc, "color"), ["red", "red"]);
  await c.close();
});

for (const first of ["split", "retime"] as const)
  test(`a retime of a clip the other side split is a card, not one piece moved (rebase, ${first} first)`, async () => {
    const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
    const base = `${c.cut}@0`;
    const doSplit = () => c.commit({ base, ops: split, intent: splitIntent });
    const doMove = () => c.commit({ base, ops: [set("c", "startTime", 12), set("c", "endTime", 17)] });
    const [a, b] = first === "split" ? [doSplit, doMove] : [doMove, doSplit];
    assert.equal((await a()).status, "confirmed");
    const r = await b();
    assert.equal(r.status, "conflicts", JSON.stringify(r).slice(0, 300));
    assert.ok(r.status === "conflicts" && r.cards.some((k) => k.path === "items/c/#time"), JSON.stringify(r.status === "conflicts" ? r.cards.map((k) => k.path) : r));
    await c.close();
  });

test("a retime of a clip the other cut split is a card in a fold too", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const main = c.cut;
  const v = (await c.fork("v", { from: `${main}@0` })).id;
  await c.commit({ cut: main, ops: split, intent: splitIntent });
  await c.commit({ cut: v, ops: [set("c", "startTime", 11), set("c", "trimStart", 1)] });
  const f = await c.fold(v, { into: main });
  assert.equal(f.status, "conflicts", JSON.stringify(f).slice(0, 300));
  assert.ok(f.status === "conflicts" && f.cards.some((k) => k.path === "items/c/#time"));
  await c.close();
});

for (const first of ["split", "edit"] as const)
  test(`shared cut: a commit made on an older version follows a split confirmed since, and a split made on one follows the edit (${first} first)`, async () => {
    const w = world();
    const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, sync: w.sync("alice") });
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    const base = `${a.cut}@0`;
    const doSplit = () => a.commit({ base, ops: split, intent: splitIntent, wait: 5000 });
    const doEdit = () => a.commit({ base, ops: [set("c", "color", "red"), set("c", "trackId", "t2")], wait: 5000 });
    for (const step of first === "split" ? [doSplit, doEdit] : [doEdit, doSplit]) assert.equal((await step()).status, "confirmed");
    const d = (await a.head()).doc;
    assert.deepEqual([pieces(d, "color"), pieces(d, "trackId")], [["red", "red"], ["t2", "t2"]]);
    await a.close();
    w.host.close();
  });

for (const dir of ["split sent", "edit sent"] as const)
  test(`.cbproj: a split in one copy and an edit of the clip in the other reach both pieces when folded (${dir})`, async () => {
    const sa = createMemoryStore();
    const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: { kind: "human", id: "alice" } });
    // bob's folder is a copy of alice's, carton.db included
    const b = await Carton.open({ adapter, store: await copyStore(sa), actor: { kind: "human", id: "bob" } });
    const [sender, receiver] = dir === "split sent" ? [a, b] : [b, a];
    await sender.commit({ ops: split, intent: splitIntent });
    await receiver.commit({ ops: [set("c", "color", "red")] });
    const r = await receiver.importShallow(await sender.exportShallow({ to: "them" }));
    assert.equal(r.status, "imported");
    const f = await receiver.fold(r.status === "imported" ? r.head : "", {});
    assert.equal(f.status, "confirmed", JSON.stringify(f).slice(0, 300));
    assert.deepEqual(pieces((await receiver.head()).doc, "color"), ["red", "red"]);
    for (const x of [a, b]) await x.close();
  });

// a ripple delete of b (5–10) on t1 on one side, the split on the other: both pieces shift left by 5, in every path
const ripple = () => {
  const maps = { t1: rippleDelete(5, 5) };
  const ops: Op[] = [{ op: "remove", path: ["items", "b"] }];
  for (const it of doc0().items as Rec[]) {
    if (it.id === "b") continue;
    const m = remapSpan(maps.t1, it.startTime as number, it.endTime as number);
    if (m && m[0] !== it.startTime) ops.push(set(it.id as string, "startTime", m[0]), set(it.id as string, "endTime", m[1]));
  }
  return { ops, intent: { kind: "ripple-delete", maps } };
};
for (const mode of ["rebase, split first", "rebase, ripple first", "fold, split on the cut folded into", "fold, split on the cut folded in"] as const)
  test(`a ripple on one side and a split on the other: both pieces move (${mode})`, async () => {
    const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
    const main = c.cut;
    const base = `${main}@0`;
    if (mode.startsWith("rebase")) {
      const s = () => c.commit({ base, ops: split, intent: splitIntent }),
        r = () => c.commit({ base, ...ripple() });
      for (const step of mode === "rebase, split first" ? [s, r] : [r, s]) assert.equal((await step()).status, "confirmed");
    } else {
      const v = (await c.fork("v", { from: base })).id;
      const into = mode === "fold, split on the cut folded into";
      await c.commit({ cut: into ? main : v, ops: split, intent: splitIntent });
      await c.commit({ cut: into ? v : main, ...ripple() });
      assert.equal((await c.fold(v, { into: main })).status, "confirmed");
    }
    const d = (await c.head(main)).doc;
    assert.deepEqual(["c", "c-b", "d"].map((id) => [item(d, id)!.startTime, item(d, id)!.endTime]), [[5, 7.5], [7.5, 10], [10, 15]]);
    await c.close();
  });
