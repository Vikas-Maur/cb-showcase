// CommentStore plug-ins: in memory, and in a Carton's own Store (store-memory, and a real carton.db through
// store-sqlite): the same invariants for each.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import type { Store } from "@carton/core";
import { cartonCommentStore, memoryCommentStore, CommentStreamChanged, COMMENT_TABLES, type CommentStore } from "../src/store.ts";
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
      assert.deepEqual(await store.load(), { comments: [], pending: [], head: 0, epoch: "" });
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
      assert.deepEqual(await store.pending(), []);
      assert.deepEqual((await store.read(["c", "nope"])).map((c) => c?.seq), [3, undefined]);
    } finally {
      await close();
    }
  });

  test(`${kind}: rows are kept by seq and the head only moves forward, whatever the writer had cached; a reset is its own write`, async () => {
    const { store, close } = await make();
    try {
      assert.ok(await store.write({ rows: [{ ...row("a", 5), body: "newer" }], head: 5 }));
      // a handle that read less, writing late: neither its older row nor its older head goes in
      assert.ok(await store.write({ rows: [{ ...row("a", 3), body: "older" }, row("b", 4)], head: 4 }));
      let snap = await store.load();
      assert.equal(snap.comments.find((c) => c.id === "a")?.body, "newer");
      assert.equal(snap.comments.find((c) => c.id === "b")?.seq, 4);
      assert.equal(snap.head, 5);
      // a pending put beside rows still fails alone on its own condition
      assert.ok(await store.write({ put: [{ row: pend("p", 1), prev: null }] }));
      assert.equal(await store.write({ rows: [row("z", 9)], head: 9, put: [{ row: pend("p", 2), prev: null }] }), false);
      assert.equal((await store.load()).head, 5, "a failed batch writes nothing");
      // the server's stream was reset: its old rows go (pending ones stay), the head is taken as it is
      assert.ok(await store.write({ rows: [row("n", 1)], head: 1, reset: "e2" }));
      snap = await store.load();
      assert.deepEqual(snap.comments.map((c) => c.id), ["n"]);
      assert.equal(snap.head, 1);
      assert.equal(snap.epoch, "e2");
      assert.deepEqual(snap.pending.map((p) => p.id), ["p"]);
      // rows of the generation before the reset are another stream's: refused, so their handle reloads
      await assert.rejects(store.write({ rows: [row("old", 7)], head: 7, epoch: "" }), CommentStreamChanged);
      assert.ok(await store.write({ rows: [row("m", 2)], head: 2, epoch: "e2" }));
      assert.deepEqual((await store.load()).comments.map((c) => c.id).sort(), ["m", "n"]);
    } finally {
      await close();
    }
  });
}

test("two handles on one carton.db, writing rows of one comment at once: the newest row and the furthest head stay", async () => {
  const dir = scratch("race");
  const [s1, s2] = await Promise.all([openSqliteStore(path.join(dir, "carton.db")), openSqliteStore(path.join(dir, "carton.db"))]);
  try {
    const a = cartonCommentStore(s1);
    const b = cartonCommentStore(s2);
    const seqs = Array.from({ length: 24 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    await Promise.all(seqs.map((q, i) => (i % 2 ? a : b).write({ rows: [{ ...row("x", q), body: `v${q}` }], head: q })));
    const snap = await a.load();
    assert.equal(snap.comments.find((c) => c.id === "x")?.body, "v24");
    assert.equal(snap.head, 24);
  } finally {
    await Promise.all([s1.close(), s2.close()]);
  }
});

test("a reset never keeps a row another handle wrote while it scanned; that handle's later rows are refused", async () => {
  const raw = createMemoryStore();
  let during: (() => Promise<void>) | null = null;
  // the reset's handle sees the Store through this: another handle writes right after the reset's scan of the rows
  const seen = new Proxy(raw, {
    get(t, k) {
      if (k === "range")
        return async (table: string, ...rest: unknown[]) => {
          const r = await (t.range as (...a: unknown[]) => Promise<unknown>)(table, ...rest);
          if (table === COMMENT_TABLES.comments && during) {
            const f = during;
            during = null;
            await f();
          }
          return r;
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
  const a = cartonCommentStore(seen);
  const b = cartonCommentStore(raw);
  assert.ok(await b.write({ rows: [row("x", 5)], head: 5, epoch: "" }));
  during = async () => void (await b.write({ rows: [row("late", 3)], epoch: "" })); // an old-stream row, no head move
  assert.ok(await a.write({ rows: [row("n", 1)], head: 1, reset: "e2" }));
  const snap = await a.load();
  assert.deepEqual(snap.comments.map((c) => c.id), ["n"], "the row written during the scan went too");
  assert.deepEqual([snap.head, snap.epoch], [1, "e2"]);
  await assert.rejects(b.write({ rows: [row("later", 4)], epoch: "" }), CommentStreamChanged);
});

/** A Store whose `get` of one key runs `during` once, right after it read (another handle's write lands there). */
function interleaved(raw: Store, table: string, key: string, during: () => Promise<void>): Store {
  let armed = true;
  return new Proxy(raw, {
    get(t, k) {
      if (k === "get")
        return async (tb: string, ky: unknown[]) => {
          const r = await t.get(tb, ky as never);
          if (armed && tb === table && ky[0] === key) {
            armed = false;
            await during();
          }
          return r;
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
}

test("an answer's pending drop, with its row already stored, never goes through a reset that happened meanwhile", async () => {
  const raw = createMemoryStore();
  const other = cartonCommentStore(raw);
  const p = pend("x", 1);
  assert.ok(await other.write({ rows: [row("x", 5)], head: 5, put: [{ row: p, prev: null }], epoch: "" }));
  // this handle reads the stored row; another handle resets the stream right then (its new stream has no "x" yet)
  const a = cartonCommentStore(interleaved(raw, COMMENT_TABLES.comments, "x", async () => void (await other.write({ rows: [row("n", 1)], head: 1, reset: "e2" }))));
  await assert.rejects(a.write({ rows: [row("x", 5)], head: 5, drop: [p], epoch: "" }), CommentStreamChanged);
  assert.deepEqual((await other.pending()).map((q) => q.id), ["x"], "the pending patch stays, to be sent again");
});

test("load never pairs one generation's head with another's rows", async () => {
  const raw = createMemoryStore();
  const other = cartonCommentStore(raw);
  assert.ok(await other.write({ rows: [row("x", 5)], head: 5, epoch: "" }));
  const a = cartonCommentStore(interleaved(raw, COMMENT_TABLES.meta, "head", async () => void (await other.write({ rows: [row("n", 1)], head: 1, reset: "e2" }))));
  const snap = await a.load();
  assert.deepEqual([snap.epoch, snap.head, snap.comments.map((c) => c.id)], ["e2", 1, ["n"]]);
});

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
