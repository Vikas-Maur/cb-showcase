// The app follows carton.db, whoever writes to it (B11). A `cb` write served by the app's lease holder tells the app's
// materializer itself (runWrite → onHeadChange), but other processes write carton.db too: a helper that took the
// lease over while the app's engine thread was busy, a `cb` that committed in its own process because no holder was
// alive, a `cb cut switch` served by a helper. Without this, project.json, the shared timeline.tsx and the editor keep
// showing the old head until some other write goes through the app.
//
// How it notices: SQLite's `PRAGMA data_version` changes on a connection whenever another connection (another process,
// or another handle in this one) has committed to the file, and never for this connection's own commits. It is read
// from the WAL index in shared memory, so a poll every 250 ms costs a few microseconds on the engine thread. Only when
// it moved does the follower look further:
//   - this machine's current cut (core's meta ["current"]): switched by another process, the handle adopts it;
//   - the change rows of every cut past what it last saw. A row this handle made or applied itself (it emitted a
//     `change` event for it) is the app's own; any other row on the current cut is another process's write, and the
//     listener is told. Rows on other cuts only move the baseline, so a later switch to such a cut (by the app itself)
//     reports only what comes after it.
// A `cb` that wrote without the holder also nudges it over the control socket (`carton.nudge`), so the app looks at
// once; the poll is what guarantees it.
import type { Carton, CartonEvent } from "@carton/core";
import type { Store } from "@carton/core/plugins";

/** How often the app looks for writes by other processes (ms). */
export const FOLLOW_MS = 250;
/** Change ids this handle made or applied, kept until a scan sees their rows (bounded). */
const KNOWN_MAX = 8192;

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
  /**
   * Another connection committed, but no change row of another process on the current cut says so (its write was on
   * another cut, a pending change or a notice, or the app's own sync): told when nothing else was.
   */
  onMoved?(cut: string): void | Promise<void>;
  /** Poll interval (ms). 0: no polling, only `check()` (a nudge). Default FOLLOW_MS. */
  intervalMs?: number;
  /**
   * Runs the follower's adoption of a cut switch exclusively with the holder's own served switches (CartonHolderEngine
   * passes its lock), so a switch served meanwhile is never undone by an older observation.
   */
  exclusive?: <T>(f: () => Promise<T>) => Promise<T>;
  /** Something failed while looking (a listener threw). The follower keeps going unless the store closed. */
  onError?: (e: unknown) => void;
}

export interface Follower {
  /** Look now (a nudge): resolves once the store has been compared and any listener called. */
  check(): Promise<void>;
  /** Stop: nothing is switched or told after this; resolves once a look in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Follow the store's current cut and its head for `carton`, telling `o` about moves made by other processes. Null
 * when the store has no other writers to follow (not SQLite).
 */
export function followStore(carton: Carton, store: Store, o: FollowOptions): Follower | null {
  const stamp = externalStamp(store);
  if (!stamp) return null;
  const exclusive = o.exclusive ?? (<T,>(f: () => Promise<T>) => f());
  let stopped = false;
  let lastStamp: number | null = null;
  /** Per cut: the highest change row seq already looked at. */
  const baseline = new Map<string, number>();
  let started = false;
  const known = new Set<string>();
  const off = carton.on((e: CartonEvent) => {
    if (e.type !== "change" || !e.change.id) return;
    known.add(e.change.id);
    if (known.size > KNOWN_MAX) known.delete(known.values().next().value!);
  });
  let running: Promise<void> | null = null;
  /**
   * A notification whose listener failed: the stamp and the baselines have moved past what it reports, so it is kept
   * and tried again at the next look (poll or nudge) until it goes through; a newer one replaces it.
   */
  let owed: (() => Promise<void>) | null = null;
  const tell = async (f: () => void | Promise<void>): Promise<void> => {
    owed = null;
    try { await f(); } catch (e) { if (!stopped) owed = async () => { await f(); }; throw e; }
  };
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  /** Rows past the baseline on `cut` (the baseline moves past them). */
  const newRows = async (cut: string): Promise<{ id: string }[]> => {
    const from = baseline.get(cut);
    const rows = await store.range<{ id: string; seq: number }>("changes", from === undefined ? { prefix: [cut] } : { prefix: [cut], gt: [cut, from] });
    if (rows.length) baseline.set(cut, Math.max(from ?? 0, ...rows.map((r) => Number(r.key[1]))));
    else if (from === undefined) baseline.set(cut, 0);
    return rows.map((r) => r.value);
  };
  /** Where every cut is now: the starting point (nothing before it is reported). */
  const start = async () => {
    for (const c of await carton.cuts()) {
      const [last] = await store.range("changes", { prefix: [c.id], reverse: true, limit: 1 });
      baseline.set(c.id, last ? Number(last.key[1]) : 0);
    }
    started = true;
  };

  /** Another process switched this machine's current cut: adopt it, unless a switch made here since says otherwise. */
  const adoptCut = async (): Promise<string | null> => {
    const mine = carton.cut;
    const stored = await store.get<string>("meta", ["current"]);
    if (!stored || stored === mine || !(await carton.cuts()).some((c) => c.id === stored)) return null;
    return exclusive(async () => {
      // under the lock, read again: a switch served (or made by the app) since the first read wins, and a stop asked
      // for during that read stops it
      const now = await store.get<string>("meta", ["current"]);
      if (stopped || carton.cut !== mine || now !== stored) return null;
      await carton.switchTo(stored);
      return stored;
    });
  };

  const look = async (): Promise<void> => {
    if (!started) await start();
    if (owed && !stopped) await tell(owed);
    const s = await stamp();
    if (s === lastStamp) return;
    // the first look only records where the store is
    const first = lastStamp === null;
    lastStamp = s;
    const switched = await adoptCut();
    if (stopped) return;
    // every cut's rows move its baseline; only the current cut's rows from elsewhere are news
    const cut = carton.cut;
    let mine: string[] = [];
    for (const c of await carton.cuts()) {
      const ids = (await newRows(c.id)).map((r) => r.id);
      if (c.id === cut) mine = ids;
      else for (const id of ids) known.delete(id);
    }
    let foreign = mine.filter((id) => !known.has(id));
    // a commit of this handle emits its event right after its write: one turn later it is known if it is ours
    if (foreign.length) { await new Promise((r) => setImmediate(r)); foreign = foreign.filter((id) => !known.has(id)); }
    for (const id of mine) known.delete(id);
    if (stopped) return;
    if (switched) await tell(() => o.onCut(switched));
    else if (foreign.length) await tell(() => o.onHead(cut));
    else if (!first && o.onMoved) await tell(() => o.onMoved!(cut));
  };
  // one look at a time; a check asked for during one runs once more after it (it may have missed that write)
  const check = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await look(); } while (again && !stopped);
      } catch (e) {
        if (isClosed(e)) void stop();
        o.onError?.(e);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
    timer = null;
    await running?.catch(() => {});
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
