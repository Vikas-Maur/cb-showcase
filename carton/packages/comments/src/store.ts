// Where comments are kept on this machine (a plug-in, PLAN §3.1): `cartonCommentStore` keeps them in the project's
// own Store (carton.db on desktop, IndexedDB in a browser) beside its history, in three tables of their own:
//   comments          [id]      -> Comment       the comments as the server last said (or, never shared, as written)
//   comments_pending  [id]      -> PendingPatch  what this machine did that the server hasn't answered yet
//   comments_meta     ["head"]  -> number        how far into the server's comment stream this machine has read
// They are never document changes: nothing here touches the `changes` table or History.
// `memoryCommentStore` is the same in memory (tests, a page without storage).

import { canonical, type Store, type StoreCondition, type StoreWrite } from "@carton/core";
import type { Comment, PendingPatch } from "./types.ts";

export const COMMENT_TABLES = { comments: "comments", pending: "comments_pending", meta: "comments_meta" } as const;

export interface CommentSnapshot {
  comments: Comment[];
  pending: PendingPatch[];
  /** The server stream's read position (0: nothing read). */
  head: number;
}

/**
 * One atomic write. Several handles may share one store (a worker and `cb` on one carton.db, two windows), each with
 * its own cache, so what reaches the store is decided against what is stored, never against a cache:
 * - a row is kept only if it is newer (by `seq`) than the stored one: a late handle never puts an older row back;
 * - the read position only moves forward;
 * - a stream reset is its own write (`reset`): it forgets every stored server row not in `rows` and sets `head` exactly.
 */
export interface CommentWrite {
  /** Comments as the server has them; each is stored only if newer than the stored one (by `seq`). */
  rows?: readonly Comment[];
  /** The read position; kept only if past the stored one (or exactly, with `reset`). */
  head?: number;
  /** The server's stream was reset (its rows held here are another stream's): forget them, take `rows` and `head` as they are. */
  reset?: true;
  /** Pending rows to put, each only if the stored one is still at version `prev` (null: none stored). */
  put?: readonly { row: PendingPatch; prev: PendingPatch | null }[];
  /** Pending rows to remove, each only if the stored one is still exactly `row` (answered, and not edited since). */
  drop?: readonly PendingPatch[];
}

/**
 * Invariants (what the tests check):
 * - `write` is atomic: when a `put` or `drop` condition fails nothing is written and it resolves false (another
 *   process edited that comment meanwhile: reload and try again); rows and the head never make it fail;
 * - `load` and `read` see every write that resolved before them, including another process's on a shared carton.db.
 */
export interface CommentStore {
  load(): Promise<CommentSnapshot>;
  write(w: CommentWrite): Promise<boolean>;
  /** Pending rows only (cheap: what to send, after another process may have added some). */
  pending(): Promise<PendingPatch[]>;
  /** Some comments' stored rows (cheap: one comment after another process changed it). */
  read(ids: readonly string[]): Promise<(Comment | undefined)[]>;
}

/** The newest row of each id in `rows` (a page never repeats an id; a caller's batch might). */
function newest(rows: readonly Comment[]): Comment[] {
  const m = new Map<string, Comment>();
  for (const r of rows) {
    const o = m.get(r.id);
    if (!o || (o.seq ?? -1) < (r.seq ?? -1)) m.set(r.id, r);
  }
  return [...m.values()];
}
const older = (stored: Comment, r: Comment) => (stored.seq ?? -1) < (r.seq ?? -1);

/** Comments in a Carton's own Store (`carton.store`). */
export function cartonCommentStore(store: Store): CommentStore {
  const T = COMMENT_TABLES;
  // do the pending rows still hold what `put` and `drop` expect?
  const pendingHolds = async (w: CommentWrite): Promise<boolean> => {
    for (const p of w.put ?? []) {
      const cur = await store.get<PendingPatch>(T.pending, [p.row.id]);
      if (p.prev ? cur === undefined || !same(cur, p.prev) : cur !== undefined) return false;
    }
    for (const d of w.drop ?? []) {
      const cur = await store.get<PendingPatch>(T.pending, [d.id]);
      if (cur === undefined || !same(cur, d)) return false;
    }
    return true;
  };
  return {
    async load() {
      const [rows, pending, head] = await Promise.all([
        store.range<Comment>(T.comments),
        store.range<PendingPatch>(T.pending),
        store.get<number>(T.meta, ["head"]),
      ]);
      return { comments: rows.map((r) => r.value), pending: pending.map((r) => r.value), head: head ?? 0 };
    },
    async pending() {
      return (await store.range<PendingPatch>(T.pending)).map((r) => r.value);
    },
    read(ids) {
      return Promise.all(ids.map((id) => store.get<Comment>(T.comments, [id])));
    },
    async write(w) {
      const base: StoreWrite[] = [];
      const baseConds: StoreCondition[] = [];
      for (const p of w.put ?? []) {
        baseConds.push({ table: T.pending, key: [p.row.id], expect: p.prev ? { equals: p.prev } : "absent" });
        base.push({ table: T.pending, key: [p.row.id], value: p.row });
      }
      for (const d of w.drop ?? []) {
        baseConds.push({ table: T.pending, key: [d.id], expect: { equals: d } });
        base.push({ table: T.pending, key: [d.id], value: undefined });
      }
      const rows = newest(w.rows ?? []);
      if (!rows.length && w.head === undefined && !w.reset) return base.length ? store.write(base, baseConds) : true;
      // rows and the head are written against what is stored now; another handle's write in between fails the
      // batch, and it is decided again on what that handle left
      for (let attempt = 0; ; attempt++) {
        const writes = [...base];
        const conds = [...baseConds];
        const [stored, head] = await Promise.all([Promise.all(rows.map((r) => store.get<Comment>(T.comments, [r.id]))), store.get<number>(T.meta, ["head"])]);
        rows.forEach((r, i) => {
          const s = stored[i];
          if (s && !w.reset && !older(s, r)) return; // what is stored is as new
          conds.push({ table: T.comments, key: [r.id], expect: s ? { equals: s } : "absent" });
          writes.push({ table: T.comments, key: [r.id], value: r });
        });
        if (w.reset) {
          const keep = new Set(rows.map((r) => r.id));
          for (const { value: c } of await store.range<Comment>(T.comments))
            if (c.seq !== undefined && !keep.has(c.id)) {
              conds.push({ table: T.comments, key: [c.id], expect: { equals: c } });
              writes.push({ table: T.comments, key: [c.id], value: undefined });
            }
        }
        const nextHead = w.reset ? (w.head ?? 0) : w.head !== undefined && w.head > (head ?? 0) ? w.head : undefined;
        if (nextHead !== undefined && nextHead !== head) {
          conds.push({ table: T.meta, key: ["head"], expect: head === undefined ? "absent" : { equals: head } });
          writes.push({ table: T.meta, key: ["head"], value: nextHead });
        }
        if (!writes.length) return true;
        if (await store.write(writes, conds)) return true;
        if (!(await pendingHolds(w))) return false;
        if (attempt >= 32) throw new Error("comments: carton.db kept changing under this write");
      }
    },
  };
}

// equal as the Store compares an `equals` condition: canonical JSON
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Comments in memory. */
export function memoryCommentStore(): CommentStore {
  const rows = new Map<string, Comment>();
  const pending = new Map<string, PendingPatch>();
  let head = 0;
  return {
    async load() {
      return { comments: [...rows.values()], pending: [...pending.values()], head };
    },
    async pending() {
      return [...pending.values()];
    },
    async read(ids) {
      return ids.map((id) => rows.get(id));
    },
    async write(w) {
      for (const p of w.put ?? []) {
        const cur = pending.get(p.row.id) ?? null;
        if (p.prev ? !cur || !same(cur, p.prev) : cur) return false;
      }
      for (const d of w.drop ?? []) {
        const cur = pending.get(d.id);
        if (!cur || !same(cur, d)) return false;
      }
      const keep = newest(w.rows ?? []);
      if (w.reset) {
        const ids = new Set(keep.map((r) => r.id));
        for (const [id, c] of rows) if (c.seq !== undefined && !ids.has(id)) rows.delete(id);
      }
      for (const r of keep) {
        const s = rows.get(r.id);
        if (!s || w.reset || older(s, r)) rows.set(r.id, r);
      }
      if (w.reset) head = w.head ?? 0;
      else if (w.head !== undefined && w.head > head) head = w.head;
      for (const p of w.put ?? []) pending.set(p.row.id, p.row);
      for (const d of w.drop ?? []) pending.delete(d.id);
      return true;
    },
  };
}
