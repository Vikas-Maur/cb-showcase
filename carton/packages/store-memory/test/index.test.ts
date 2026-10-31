import { test } from "node:test";
import assert from "node:assert/strict";
import { compareKeys, createMemoryData, createMemoryStore } from "../src/index.ts";

test("key order: element-wise, numbers before strings, numbers numerically, prefixes first", () => {
  const keys = [["b"], ["a", 10], ["a", 9], ["a"], [3], ["a", "x"], [10], ["a", 9, "z"]];
  keys.sort(compareKeys);
  assert.deepEqual(keys, [[3], [10], ["a"], ["a", 9], ["a", 9, "z"], ["a", 10], ["a", "x"], ["b"]]);
});

test("range: prefix, bounds, limit and reverse", async () => {
  const s = createMemoryStore();
  const w = [];
  for (const c of ["x", "y"]) for (let i = 1; i <= 20; i++) w.push({ table: "changes", key: [c, i], value: { c, i } });
  w.push({ table: "changes", key: ["y"], value: "bare" });
  assert.equal(await s.write(w.reverse()), true);
  const xs = await s.range<{ i: number }>("changes", { prefix: ["x"] });
  assert.deepEqual(xs.map((e) => e.value.i), Array.from({ length: 20 }, (_, i) => i + 1));
  const tail = await s.range<{ i: number }>("changes", { prefix: ["x"], gt: ["x", 17] });
  assert.deepEqual(tail.map((e) => e.value.i), [18, 19, 20]);
  const last = await s.range<{ i: number }>("changes", { prefix: ["x"], reverse: true, limit: 2 });
  assert.deepEqual(last.map((e) => e.value.i), [20, 19]);
  const ys = await s.range("changes", { prefix: ["y"] });
  assert.equal(ys.length, 21, "the bare prefix key is inside its own prefix");
  assert.deepEqual(ys[0]!.key, ["y"]);
  const between = await s.range<{ i: number }>("changes", { gte: ["x", 5], lt: ["x", 8] });
  assert.deepEqual(between.map((e) => e.value.i), [5, 6, 7]);
});

test("write: conditions are atomic; a failed condition writes nothing", async () => {
  const s = createMemoryStore();
  assert.equal(await s.write([{ table: "t", key: ["a", 1], value: 1 }], [{ table: "t", key: ["a", 1], expect: "absent" }]), true);
  assert.equal(await s.write([{ table: "t", key: ["a", 2], value: 2 }, { table: "t", key: ["a", 1], value: 9 }], [{ table: "t", key: ["a", 1], expect: "absent" }]), false);
  assert.equal(await s.get("t", ["a", 2]), undefined);
  assert.equal(await s.get("t", ["a", 1]), 1);
  assert.equal(await s.write([{ table: "lease", key: ["sync"], value: { nonce: "n2" } }], [{ table: "lease", key: ["sync"], expect: "absent" }]), true);
  assert.equal(await s.write([{ table: "lease", key: ["sync"], value: { nonce: "n3" } }], [{ table: "lease", key: ["sync"], expect: { equals: { nonce: "n1" } } }]), false);
  assert.equal(await s.write([{ table: "lease", key: ["sync"], value: { nonce: "n3" } }], [{ table: "lease", key: ["sync"], expect: { equals: { nonce: "n2" } } }]), true);
  assert.equal(await s.write([{ table: "t", key: ["a", 1], value: undefined }], [{ table: "t", key: ["a", 1], expect: "present" }]), true);
  assert.equal(await s.get("t", ["a", 1]), undefined);
  assert.deepEqual(await s.range("t"), []);
});

test("two handles on shared data act like two processes: only one CAS append wins", async () => {
  const data = createMemoryData();
  const a = createMemoryStore({ shared: data }),
    b = createMemoryStore({ shared: data });
  const seen: string[][] = [];
  b.watch!((t) => seen.push([...t]));
  const cond = [{ table: "changes", key: ["main", 1], expect: "absent" as const }];
  const [ra, rb] = await Promise.all([a.write([{ table: "changes", key: ["main", 1], value: "a" }], cond), b.write([{ table: "changes", key: ["main", 1], value: "b" }], cond)]);
  assert.deepEqual([ra, rb].sort(), [false, true]);
  assert.equal(await b.get("changes", ["main", 1]), ra ? "a" : "b");
  assert.deepEqual(seen, [["changes"]]);
});
