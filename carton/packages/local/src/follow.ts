// The app follows carton.db, whoever writes to it (B11). A `cb` write served by the app's lease holder tells the app's
// materializer itself (runWrite → onHeadChange), but other processes write carton.db too: a helper that took the
// lease over while the app's engine thread was busy, a `cb` that committed in its own process because no holder was
// alive, a `cb cut switch` served by a helper. Without this, project.json, the shared timeline.tsx and the editor keep
// showing the old head until some other write goes through the app.
//
// How it notices: SQLite's `PRAGMA data_version` changes on a connection whenever another connection (another process,
// or another handle in this one) has committed to the file, and never for this connection's own commits. It is read
// from the WAL index in shared memory, so a poll every 250 ms costs a few microseconds on the engine thread. Only when
// it moved is head read (Carton refreshes from the store on every read), and the listener told only when the current
// cut or its head is not what it was. A `cb` that wrote without the holder also nudges it over the control socket
// (`carton.nudge`), so the app looks at once; the poll is what guarantees it.
import type { Carton } from "@carton/core";
import type { Store } from "@carton/core/plugins";

/** How often the app looks for writes by other processes (ms). */
export const FOLLOW_MS = 250;

/**
 * A stamp that changes whenever another connection has committed to the store, or null when the store can't tell
 * (an in-memory store: nothing else writes to it). store-sqlite's `db` is a public member; the stamp is its
 * `PRAGMA data_version`, read through `db.read` (which waits out a WAL recovery like any read).
 */
export function externalStamp(store: Store): (() => Promise<number>) | null {
  type Db = { read<T>(fn: () => T): Promise<T>; stmt(sql: string): { get(): unknown } };
  const db = (store as unknown as { db?: Partial<Db> }).db;
  if (typeof db?.read !== "function" || typeof db.stmt !== "function") return null;
  const d = db as Db;
  return () => d.read(() => Number((d.stmt("PRAGMA data_version").get() as { data_version: number }).data_version));
}

export interface FollowOptions {
  /** The current cut's head moved under this handle (another process wrote it). */
  onHead(cut: string): void | Promise<void>;
  /** This machine's current cut is another one now (another process switched it); this handle has switched too. */
  onCut(cut: string): void | Promise<void>;
  /** Poll interval (ms). 0: no polling, only `check()` (a nudge). Default FOLLOW_MS. */
  intervalMs?: number;
  /** Something failed while looking (the store closed, a listener threw). The follower keeps going unless it closed. */
  onError?: (e: unknown) => void;
}

export interface Follower {
  /** Look now (a nudge): resolves once the store has been compared and any listener called. */
  check(): Promise<void>;
  stop(): void;
}

const refKey = (ref: unknown): string => JSON.stringify(ref);

/**
 * Follow the store's current cut and its head for `carton`, telling `o` about moves made by other processes. Null
 * when the store has no other writers to follow (not SQLite).
 */
export function followStore(carton: Carton, store: Store, o: FollowOptions): Follower | null {
  const stamp = externalStamp(store);
  if (!stamp) return null;
  let stopped = false;
  let lastStamp: number | null = null;
  let seen: { cut: string; ref: string } | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  const look = async (): Promise<void> => {
    const s = await stamp();
    if (s === lastStamp && seen) return;
    lastStamp = s;
    // this machine's current cut (last writer wins, core's meta ["current"]): another process may have switched it
    const stored = await store.get<string>("meta", ["current"]);
    if (stored && stored !== carton.cut && (await carton.cuts()).some((c) => c.id === stored)) {
      await carton.switchTo(stored);
      seen = { cut: stored, ref: refKey((await carton.head(stored)).ref) };
      await o.onCut(stored);
      return;
    }
    const cut = carton.cut;
    const ref = refKey((await carton.head(cut)).ref);
    const moved = seen !== null && seen.cut === cut && seen.ref !== ref;
    seen = { cut, ref };
    if (moved) await o.onHead(cut);
  };
  // one look at a time; a check asked for during one runs once more after it (it may have missed that write)
  const check = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await look(); } while (again && !stopped);
      } catch (e) {
        if (isClosed(e)) stop();
        o.onError?.(e);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const ms = o.intervalMs ?? FOLLOW_MS;
  const tick = () => {
    timer = null;
    void check().finally(() => {
      if (!stopped && ms > 0) { timer = setTimeout(tick, ms); timer.unref?.(); }
    });
  };
  // the first look records where the store is; moves are what changes after it
  tick();
  return { check, stop };
}

/** The store (or Carton on it) was closed under the follower: nothing more to follow. */
function isClosed(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e);
  return /not open|closed|finalized/i.test(m);
}
