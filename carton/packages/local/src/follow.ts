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
  /**
   * The handle was switched in this process and its listeners know (CartonHolderEngine calls it for a switch it served
   * and printed). Whoever switches a followed handle in-process says so here: a cut never announced is told at the
   * next look as a cut switch, however the handle got there (a switch made here that nobody announced, one whose
   * printing failed, or core moving the handle while it reloads), so a missing call costs a repeated notice, never a
   * lost one.
   */
  served(cut: string): void;
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
   * The cut the listeners were last told the handle is on: by this follower (a cut notice that went through) or by the
   * holder (`served`). The handle can be on another one with nothing found in the store to say so: a switch served
   * here whose printing failed, or core moving the handle while it reloads (another process made a cut and switched to
   * it: any call that refreshes, this follower's own scan too, rebuilds the handle on the stored current cut). Every
   * look ends by telling such a cut.
   */
  let announced = carton.cut;
  /**
   * A notification whose listener failed: the stamp and the baselines have moved past what it reports, so it is kept
   * and told again at the next look (poll or nudge), after that look has read the store (a listener that keeps failing
   * never holds up adopting a newer cut). It is what to tell, not a call to repeat, and only for the cut the handle is
   * on: merged with what that look found (the larger of the two), dropped once the handle has left its cut (the cut it
   * is on then is told as unannounced, or was announced).
   */
  let owed: Notice | null = null;
  const owe = (n: Notice): void => {
    if (stopped || n.cut !== carton.cut) return;
    if (!owed || owed.cut !== n.cut || RANK[n.kind] > RANK[owed.kind]) owed = n;
  };
  const tell = async (n: Notice): Promise<void> => {
    try {
      if (n.kind === "cut") await o.onCut(n.cut);
      else if (n.kind === "head") await o.onHead(n.cut);
      else await o.onMoved?.(n.cut);
    } catch (e) {
      owe(n);
      throw e;
    }
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
      // the handle only: the stored row is already this cut, and writing it again would undo a switch a third process
      // stored after the read (request 6, foundation `fb7f4e9`)
      await carton.switchTo(stored, { persist: false });
      return stored;
    });
  };

  /** What the store says changed since the last look (null: nothing another connection committed). */
  const scan = async (): Promise<Notice | null> => {
    const s = await stamp();
    if (s === lastStamp) return null;
    // the first look only records where the store is
    const first = lastStamp === null;
    lastStamp = s;
    const switched = await adoptCut();
    if (stopped) return null;
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
    if (switched) return { kind: "cut", cut: switched };
    if (foreign.length) return { kind: "head", cut };
    return !first && o.onMoved ? { kind: "moved", cut } : null;
  };
  const look = async (): Promise<void> => {
    if (!started) await start();
    let n = await scan();
    // the handle moved while this look read the store: what it found is about a cut the handle has left
    if (n && n.cut !== carton.cut) n = null;
    // on a cut the listeners weren't told of, however it got there: the whole cut
    if (carton.cut !== announced) n = { kind: "cut", cut: carton.cut };
    const left = owed;
    owed = null;
    if (left && left.cut === carton.cut && (!n || RANK[left.kind] > RANK[n.kind])) n = left;
    if (!n || stopped) return;
    await tell(n);
    // told; unless the handle moved on meanwhile (and that move announced itself or is told next)
    if (n.kind === "cut" && carton.cut === n.cut) announced = n.cut;
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
  const served = (cut: string): void => {
    if (carton.cut !== cut) return;
    announced = cut;
    if (owed && owed.cut !== cut) owed = null;
  };
  tick();
  return { check, stop, served };
}

/** What a look tells: a cut switch (the whole cut to show), the head moved, or some other write. */
export type Notice = { kind: "cut" | "head" | "moved"; cut: string };
/** A switch shows the whole cut, head included; a head move tells all a write elsewhere would. */
const RANK: Record<Notice["kind"], number> = { moved: 0, head: 1, cut: 2 };

/** The store (or Carton on it) was closed under the follower: nothing more to follow. */
function isClosed(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e);
  return /not open|closed|finalized/i.test(m);
}
