// carton.lineage(from, to) and the comment tables in LOCAL_TABLES (comments' REQ-C2): the split lineage between two
// versions, composed along History's DAG path, for comments that re-anchor across a split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, LOCAL_TABLES } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, clip, doc0, set } from "./fixture.ts";

const split = [
  set("c", "endTime", 12.5),
  set("c", "trimEnd", 2.5),
  { op: "insert" as const, path: ["items", "c-b"], value: { ...clip("c-b", 12.5, 15), trimStart: 2.5, trimEnd: 5, name: "c" } },
];
const splitIntent = { kind: "split", lineage: { c: ["c", "c-b"] } };

test("lineage: a split between two versions of a cut, and none outside it", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const cut = c.cut;
  await c.commit({ ops: [set("a", "name", "a 1")] });
  assert.equal((await c.commit({ ops: split, intent: splitIntent })).status, "confirmed");
  await c.commit({ ops: [set("a", "name", "a 3")] });
  assert.deepEqual(await c.lineage({ cut, seq: 0 }, { cut, seq: 3 }), { c: ["c", "c-b"] });
  assert.deepEqual(await c.lineage({ cut, seq: 1 }, { cut, seq: 2 }), { c: ["c", "c-b"] });
  assert.equal(await c.lineage({ cut, seq: 2 }, { cut, seq: 3 }), null, "no split after it");
  assert.equal(await c.lineage({ cut, seq: 3 }, { cut, seq: 0 }), null, "`from` after `to`: no path");
  await c.close();
});

test("lineage: a split made on a variant reaches a version through the fold that took it in, and through the fork", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const main = c.cut;
  const v = (await c.fork("v", { from: `${main}@0` })).id;
  assert.equal((await c.commit({ cut: v, ops: split, intent: splitIntent })).status, "confirmed");
  await c.commit({ cut: main, ops: [set("a", "name", "main's a")] });
  assert.equal((await c.fold(v, { into: main })).status, "confirmed");
  assert.deepEqual(await c.lineage({ cut: main, seq: 0 }, { cut: main, seq: 2 }), { c: ["c", "c-b"] }, "through the fold");
  assert.deepEqual(await c.lineage({ cut: main, seq: 0 }, { cut: v, seq: 1 }), { c: ["c", "c-b"] }, "across the fork");
  await c.close();
});

test("LOCAL_TABLES: comments' outbox and read position stay on this machine (not in a full-history .cbproj)", () => {
  assert.ok(LOCAL_TABLES.has("comments_pending"));
  assert.ok(LOCAL_TABLES.has("comments_meta"));
  assert.ok(!LOCAL_TABLES.has("comments"), "the comments themselves travel");
});
