// CommentStore plug-ins: in memory, and in a Carton's own Store (store-memory, and a real carton.db through
// store-sqlite): the same invariants for each.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import { cartonCommentStore, memoryCommentStore, COMMENT_TABLES, type CommentStore } from "../src/store.ts";
import type { Comment, PendingPatch } from "../src/types.ts";
import { ME, scratch } from "./helpers.ts";

const row = (id: string, seq?: number): Comment => ({ id, author: ME, body: `text ${id}`, cut: "main", at: 1, ...(seq !== undefined ? { seq } : {}) });
const pend = (id: string, v: number, body = "x"): PendingPatch => ({ id, v, patch: { body, at: v, author: ME } });

const kinds: [string, () => Promise<{ store: CommentStore; close(): Promise<void> }>][] = [
  ["memory", async () => ({ store: memoryCommentStore(), close: async () => {} })],
  ["store-memory", async () => ({ store: cartonCommentStore(createMemoryStore()), close: async () => {} })],
  [
    "store-sqlite (carton.db)",
    async () => {
      const s = await openSqliteStore(path.join(scratch("store"), "carton.db"));
      return { store: cartonCommentStore(s), close: () => s.close() };
    },
  ],
];

for (const [kind, make] of kinds) {
  test(`${kind}: rows, the read position and pending rows round-trip; pending puts and drops are compare-and-set`, async () => {
    const { store, close } = await make();
    try {
      assert.deepEqual(await store.load(), { comments: [], pending: [], head: 0 });
      assert.ok(await store.write({ rows: [row("a", 1), row("b", 2)], head: 2, put: [{ row: pend("c", 1), prev: null }] }));
      // a second "new" pending row for c fails: another writer has one
      assert.equal(await store.write({ rows: [row("z", 9)], put: [{ row: pend("c", 1, "other"), prev: null }] }), false);
      let snap = await store.load();
      assert.deepEqual(snap.comments.map((c) => c.id).sort(), ["a", "b"], "a failed batch writes nothing");
      assert.equal(snap.head, 2);
      // update on the right version, refuse on a stale one
      assert.ok(await store.write({ put: [{ row: pend("c", 2, "y"), prev: pend("c", 1) }] }));
      assert.equal(await store.write({ put: [{ row: pend("c", 3), prev: pend("c", 1) }] }), false);
      // a drop only while the row is exactly what was answered
      assert.equal(await store.write({ drop: [pend("c", 1)] }), false);
      assert.ok(await store.write({ rows: [row("c", 3)], head: 3, drop: [pend("c", 2, "y")] }));
      snap = await store.load();
      assert.deepEqual(snap.pending, []);
      assert.deepEqual(snap.comments.map((c) => c.id).sort(), ["a", "b", "c"]);
      assert.ok(await store.write({ forget: ["a"] }));
      assert.deepEqual((await store.load()).comments.map((c) => c.id).sort(), ["b", "c"]);
      assert.deepEqual(await store.pending(), []);
    } finally {
      await close();
    }
  });
}

test("in carton.db the comments are tables of their own beside the history, never document changes", async () => {
  const s = await openSqliteStore(path.join(scratch("tables"), "carton.db"));
  try {
    const store = cartonCommentStore(s);
    await store.write({ rows: [row("a", 1)], head: 1, put: [{ row: pend("b", 1), prev: null }] });
    assert.equal((await s.range(COMMENT_TABLES.comments)).length, 1);
    assert.equal((await s.range(COMMENT_TABLES.pending)).length, 1);
    assert.equal(await s.get(COMMENT_TABLES.meta, ["head"]), 1);
    assert.equal((await s.range("changes")).length, 0);
  } finally {
    await s.close();
  }
});
