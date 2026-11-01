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

/** One atomic write. */
export interface CommentWrite {
  /** Comments as the server (or, never shared, this machine) now has them. */
  rows?: readonly Comment[];
  /** Comments to forget (the server's stream was reset: its old rows are another stream's). */
  forget?: readonly string[];
  head?: number;
  /** Pending rows to put, each only if the stored one is still at version `prev` (null: none stored). */
  put?: readonly { row: PendingPatch; prev: PendingPatch | null }[];
  /** Pending rows to remove, each only if the stored one is still exactly `row` (answered, and not edited since). */
  drop?: readonly PendingPatch[];
}

/**
 * Invariants (what the tests check):
 * - `write` is atomic: when a `put` or `drop` condition fails nothing is written and it resolves false (another
 *   process edited that comment meanwhile: reload and try again);
 * - `load` sees every write that resolved before it, including another process's on a shared carton.db.
 */
export interface CommentStore {
  load(): Promise<CommentSnapshot>;
  write(w: CommentWrite): Promise<boolean>;
  /** Pending rows only (cheap: what to send, after another process may have added some). */
  pending(): Promise<PendingPatch[]>;
}

/** Comments in a Carton's own Store (`carton.store`). */
export function cartonCommentStore(store: Store): CommentStore {
  const T = COMMENT_TABLES;
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
    async write(w) {
      const writes: StoreWrite[] = [];
      const conds: StoreCondition[] = [];
      for (const id of w.forget ?? []) writes.push({ table: T.comments, key: [id], value: undefined });
      for (const r of w.rows ?? []) writes.push({ table: T.comments, key: [r.id], value: r });
      if (w.head !== undefined) writes.push({ table: T.meta, key: ["head"], value: w.head });
      for (const p of w.put ?? []) {
        conds.push({ table: T.pending, key: [p.row.id], expect: p.prev ? { equals: p.prev } : "absent" });
        writes.push({ table: T.pending, key: [p.row.id], value: p.row });
      }
      for (const d of w.drop ?? []) {
        conds.push({ table: T.pending, key: [d.id], expect: { equals: d } });
        writes.push({ table: T.pending, key: [d.id], value: undefined });
      }
      if (!writes.length) return true;
      return store.write(writes, conds);
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
    async write(w) {
      for (const p of w.put ?? []) {
        const cur = pending.get(p.row.id) ?? null;
        if (p.prev ? !cur || !same(cur, p.prev) : cur) return false;
      }
      for (const d of w.drop ?? []) {
        const cur = pending.get(d.id);
        if (!cur || !same(cur, d)) return false;
      }
      for (const id of w.forget ?? []) rows.delete(id);
      for (const r of w.rows ?? []) rows.set(r.id, r);
      if (w.head !== undefined) head = w.head;
      for (const p of w.put ?? []) pending.set(p.row.id, p.row);
      for (const d of w.drop ?? []) pending.delete(d.id);
      return true;
    },
  };
}
