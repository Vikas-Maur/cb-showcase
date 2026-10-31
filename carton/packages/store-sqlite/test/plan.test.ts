// Every read is an index seek plus a walk over just the rows it returns (verify-ci S1: open time grew with history
// because a prefix plus `gt` made SQLite seek on the prefix start and filter `k > ?` row by row). SQLite's query plan
// text is the same for both (`SEARCH … (k>? AND k<?)`), so the test checks both: the plan is a primary-key SEARCH
// with no SCAN and no sorting B-tree, and the statement gives SQLite at most one lower and one upper bound on k.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { openSqliteStore } from "../src/index.ts";
import { rangeBounds } from "../src/store.ts";
import { encodeKey, prefixEnd } from "../src/key.ts";
import { scratch } from "./scratch.ts";

test("the reads opening a project needs are index seeks with one bound per side", async () => {
  const s = await openSqliteStore(path.join(scratch("plan"), "carton.db"));
  for (const cut of ["a0", "b1"]) {
    for (let i = 1; i <= 2000; i += 500) await s.write(Array.from({ length: 500 }, (_, j) => ({ table: "changes", key: [cut, i + j], value: { seq: i + j } })));
    await s.write([0, 640, 1280, 1920].map((seq) => ({ table: "keyframes", key: [cut, seq], value: { at: seq } })));
  }
  const seen: string[] = [];
  const orig = s.db.stmt.bind(s.db);
  (s.db as { stmt: typeof s.db.stmt }).stmt = (sql: string) => {
    if (/^SELECT k, v|^SELECT v/.test(sql)) seen.push(sql);
    return orig(sql);
  };
  // What opening a project reads: the head, the newest keyframe at or below it, the tail after that keyframe; and
  // the other shapes core uses (a window of the log, one key).
  const head = (await s.range("changes", { prefix: ["a0"], reverse: true, limit: 1 }))[0].key[1] as number;
  const kf = (await s.range("keyframes", { prefix: ["a0"], lte: ["a0", head], reverse: true, limit: 1 }))[0].key[1] as number;
  assert.equal((await s.range("changes", { prefix: ["a0"], gt: ["a0", kf] })).length, head - kf);
  assert.equal((await s.range("changes", { prefix: ["b1"], gte: ["b1", 100], lt: ["b1", 200] })).length, 100);
  assert.equal((await s.range("keyframes", { prefix: ["b1"], gt: ["b1", 0], lte: ["b1", 1280], reverse: true })).length, 2);
  assert.deepEqual(await s.get("changes", ["a0", 7]), { seq: 7 });
  assert.ok(seen.length >= 6, `saw ${seen.length} statements`);
  for (const sql of new Set(seen)) {
    const lower = sql.match(/k >=? \?/g) ?? [];
    const upper = sql.match(/k <=? \?/g) ?? [];
    assert.ok(lower.length <= 1 && upper.length <= 1, `one bound per side: ${sql}`);
    const plan = (s.db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
    for (const d of plan) {
      assert.match(d, /^SEARCH \S+ USING PRIMARY KEY \(k[<>=]{1,2}\?( AND k[<>=]{1,2}\?)?\)$/, `${d}  <=  ${sql}`);
      assert.doesNotMatch(d, /SCAN|TEMP B-TREE/);
    }
  }
  await s.close();
});

test("range bounds: the tightest on each side wins, an exclusive bound wins a tie, and empty ranges are found", () => {
  const k = (...x: (string | number)[]) => encodeKey(x);
  assert.deepEqual(rangeBounds({ prefix: ["c"], gt: ["c", 5] }), { lo: { k: k("c", 5), open: true }, hi: { k: prefixEnd(["c"]), open: true } });
  assert.deepEqual(rangeBounds({ prefix: ["c"], lte: ["c", 9] }), { lo: { k: k("c"), open: false }, hi: { k: k("c", 9), open: false } });
  assert.deepEqual(rangeBounds({ prefix: ["c"], gte: ["b"] }), { lo: { k: k("c"), open: false }, hi: { k: prefixEnd(["c"]), open: true } }, "a bound outside the prefix never widens it");
  assert.deepEqual(rangeBounds({ gt: ["c", 5], gte: ["c", 5] })!.lo, { k: k("c", 5), open: true });
  assert.deepEqual(rangeBounds({ lt: ["c", 5], lte: ["c", 5] })!.hi, { k: k("c", 5), open: true });
  assert.equal(rangeBounds({ gt: ["c", 5], lt: ["c", 5] }), null);
  assert.equal(rangeBounds({ gte: ["c", 6], lte: ["c", 5] }), null);
  assert.deepEqual(rangeBounds({ gte: ["c", 5], lte: ["c", 5] }), { lo: { k: k("c", 5), open: false }, hi: { k: k("c", 5), open: false } });
  assert.deepEqual(rangeBounds({}), { lo: null, hi: null });
});
