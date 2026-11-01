// Where comments are kept on this machine (a plug-in, PLAN §3.1): `cartonCommentStore` keeps them in the project's
// own Store (carton.db on desktop, IndexedDB in a browser) beside its history, in three tables of their own:
//   comments          [id]       -> Comment       the comments as the server last said
//   comments_pending  [id]       -> PendingPatch  what this machine did that the server hasn't answered yet
//   comments_meta     ["head"]   -> number        how far into the server's comment stream this machine has read
//                     ["epoch"]  -> string        the stream's generation here (new at each reset)
//                     ["rev"]    -> number        bumped by every write of rows or the head
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
  /** The stream's generation here ("" before the first reset): rows of another generation are another stream's. */
  epoch: string;
}

/**
 * One atomic write. Several handles may share one store (a worker and `cb` on one carton.db, two windows), each with
 * its own cache, so what reaches the store is decided against what is stored, never against a cache:
 * - a row is kept only if it is newer (by `seq`) than the stored one: a late handle never puts an older row back;
 * - the read position only moves forward;
 * - each such write is conditioned on the store's revision, so another handle's write in between makes it decide again;
 * - a stream reset is its own write (`reset`): it forgets every stored server row not in `rows`, sets `head` exactly,
 *   and starts a new generation; rows sent with the generation before it are refused (`CommentStreamChanged`).
 */
export interface CommentWrite {
  /** Comments as the server has them; each is stored only if newer than the stored one (by `seq`). */
  rows?: readonly Comment[];
  /** The read position; kept only if past the stored one (or exactly, with `reset`). */
  head?: number;
  /**
   * The generation `rows` and `head` belong to (the snapshot's `epoch`, or the last reset's): if the store's is
   * another, another handle reset the stream since, and the write throws `CommentStreamChanged`.
   */
  epoch?: string;
  /** The server's stream was reset: forget its old rows, take `rows` and `head` as they are, as generation `reset`. */
  reset?: string;
  /** Pending rows to put, each only if the stored one is still at version `prev` (null: none stored). */
  put?: readonly { row: PendingPatch; prev: PendingPatch | null }[];
  /** Pending rows to remove, each only if the stored one is still exactly `row` (answered, and not edited since). */
  drop?: readonly PendingPatch[];
}

/** The stream was reset by another handle since these rows' generation: reload, and ask the server again. */
export class CommentStreamChanged extends Error {
  constructor() {
    super("the comment stream was reset by another process: reload");
    this.name = "CommentStreamChanged";
  }
}

/**
 * Invariants (what the tests check):
 * - `write` is atomic: when a `put` or `drop` condition fails nothing is written and it resolves false (another
 *   process edited that comment meanwhile: reload and try again); rows and the head never make it fail;
 * - `load` reads the head, then the pending rows, then the rows: a comment answered meanwhile is in one or the other,
 *   and every row up to the head is there; all of one generation (a reset meanwhile: it reads again);
 * - `load`, `read` and `pending` see every write that resolved before them, including another process's.
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
      // the head first, the rows last: every row the head claims is there (a row written meanwhile comes with a
      // later head); the pending rows before the rows: a comment answered meanwhile is in one or the other. Only a
      // reset removes rows: the generation read before and after tells if one came in between (then read again;
      // resets are rare, so this never starves)
      for (let attempt = 0; ; attempt++) {
        const epoch = await store.get<string>(T.meta, ["epoch"]);
        const head = await store.get<number>(T.meta, ["head"]);
        const pending = await store.range<PendingPatch>(T.pending);
        const rows = await store.range<Comment>(T.comments);
        if ((await store.get<string>(T.meta, ["epoch"])) === epoch)
          return { comments: rows.map((r) => r.value), pending: pending.map((r) => r.value), head: head ?? 0, epoch: epoch ?? "" };
        if (attempt >= 32) throw new Error("comments: carton.db's comment stream kept being reset while it was read");
      }
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
      if (!rows.length && w.head === undefined && w.reset === undefined) return base.length ? store.write(base, baseConds) : true;
      // decided on what is stored now: the revision first, then what it covers; any write of rows or the head in
      // between bumps it and fails this batch, which is then decided again on what that write left
      for (let attempt = 0; ; attempt++) {
        const rev = await store.get<number>(T.meta, ["rev"]);
        const [epoch, head] = await Promise.all([store.get<string>(T.meta, ["epoch"]), store.get<number>(T.meta, ["head"])]);
        if (w.reset === undefined && w.epoch !== undefined && (epoch ?? "") !== w.epoch) throw new CommentStreamChanged();
        const stored = await Promise.all(rows.map((r) => store.get<Comment>(T.comments, [r.id])));
        const writes = [...base];
        const conds: StoreCondition[] = [...baseConds, { table: T.meta, key: ["rev"], expect: rev === undefined ? "absent" : { equals: rev } }];
        rows.forEach((r, i) => {
          const s = stored[i];
          if (s && w.reset === undefined && !older(s, r)) return; // what is stored is as new
          writes.push({ table: T.comments, key: [r.id], value: r });
        });
        if (w.reset !== undefined) {
          const keep = new Set(rows.map((r) => r.id));
          for (const { value: c } of await store.range<Comment>(T.comments)) if (c.seq !== undefined && !keep.has(c.id)) writes.push({ table: T.comments, key: [c.id], value: undefined });
          writes.push({ table: T.meta, key: ["epoch"], value: w.reset });
        }
        const nextHead = w.reset !== undefined ? (w.head ?? 0) : w.head !== undefined && w.head > (head ?? 0) ? w.head : undefined;
        if (nextHead !== undefined && nextHead !== head) writes.push({ table: T.meta, key: ["head"], value: nextHead });
        // nothing of the stream to write (all stored already): the pending rows' writes still hold only if nothing
        // changed since the reads above (a reset in between would leave neither the row nor the pending patch)
        if (writes.length === base.length) {
          if (!base.length) return true;
        } else writes.push({ table: T.meta, key: ["rev"], value: (rev ?? 0) + 1 });
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
  let epoch = "";
  return {
    async load() {
      return { comments: [...rows.values()], pending: [...pending.values()], head, epoch };
    },
    async pending() {
      return [...pending.values()];
    },
    async read(ids) {
      return ids.map((id) => rows.get(id));
    },
    async write(w) {
      if (w.reset === undefined && w.epoch !== undefined && (w.rows?.length || w.head !== undefined) && epoch !== w.epoch) throw new CommentStreamChanged();
      for (const p of w.put ?? []) {
        const cur = pending.get(p.row.id) ?? null;
        if (p.prev ? !cur || !same(cur, p.prev) : cur) return false;
      }
      for (const d of w.drop ?? []) {
        const cur = pending.get(d.id);
        if (!cur || !same(cur, d)) return false;
      }
      const keep = newest(w.rows ?? []);
      const reset = w.reset !== undefined;
      if (reset) {
        const ids = new Set(keep.map((r) => r.id));
        for (const [id, c] of rows) if (c.seq !== undefined && !ids.has(id)) rows.delete(id);
        epoch = w.reset!;
      }
      for (const r of keep) {
        const s = rows.get(r.id);
        if (!s || reset || older(s, r)) rows.set(r.id, r);
      }
      if (reset) head = w.head ?? 0;
      else if (w.head !== undefined && w.head > head) head = w.head;
      for (const p of w.put ?? []) pending.set(p.row.id, p.row);
      for (const d of w.drop ?? []) pending.delete(d.id);
      return true;
    },
  };
}
