// "Displace, then install" (PLAN §6.4, R2-04, proof P10): how Carton replaces a file that other processes may also
// write (project.json, timeline.tsx, per-agent views) without ever destroying a write it hasn't seen.
//
//   1. rename(target → .carton/displaced/<n>)   moves away whatever is there, atomically (ENOENT is fine)
//   2. link(tmp → target)                       creates the name only if it is absent; EEXIST means a foreign write
//                                               landed between 1 and 2, so go back to 1 and displace that too
//   3. unlink(tmp)
//
// Every displaced file is then reviewed by the caller (`DisplacedFiles`): one that isn't Carton's own last install is
// a foreign write and is imported. Carton never replaces a name, so the only cost is a short window in which the path
// is missing, on every OS: tens of microseconds on ext4 (P10), longer on NTFS (bench/race measures it on each file
// system). It matters beyond Windows: stock 1.4.0 takes an unreadable project.json for a removed project (dropped from
// the index and the rescan, the watcher says `removed`). So:
//   - the caller holds the bundle's install lock (`.carton/install.lock/`, `withInstallLock`, shared with the app's
//     facade) around the whole install, from step 1 to step 3, and passes its `mine()`: a holder that stalled long
//     enough to be taken over stops before step 1 instead of installing its older file over the successor's;
//   - readers wait on ENOENT while the lock is held: the app's store bridge up to 6 s (50 ms without the lock), Carton's
//     own through `retryMissing` (6 s, 100 ms without); agents' file tools see a transient error;
//   - an install that fails between 1 and 2 (a link error other than EEXIST, or a busy file past its budget) puts the
//     file it displaced back before returning, still under the lock, so a failure never leaves the path missing.
//
// Windows has no atomic "replace only if unchanged" (nor an exchange), so an install that never leaves the path missing
// (check the stamp, then rename over it; MoveFileEx replaces atomically) destroys a foreign save that lands after the
// check: a temp+rename save, or an in-place writer that opens, writes and closes in between. A busy error catches only
// a writer that still has the file open. Displacing is the only way to keep every write, so it is used on Windows too
// (test: "the stamp-checked replace … destroys"; bench/race's `replace` protocol measures it on NTFS).
//
// The protocol's own calls are synchronous on purpose: P10 measured the missing-path gap at 10–16 µs median with sync
// calls against 61–68 µs through fs.promises (the gap spans one libuv round trip each). Only waiting is asynchronous:
// a busy file (below) is retried on timers, so the engine's thread keeps serving everything else meanwhile.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Windows reports a file that another process holds open as busy: rename, link and unlink fail with EPERM, EBUSY or
// EACCES until the holder closes it. A name that was just deleted while something (Defender, the indexer) still had it
// open is "delete pending" for a moment, and every call on it, stat and mkdir too, fails with EPERM or EACCES until
// then. The app's rename-retry helper retries those; so do we, on Windows only: on Linux and macOS these codes are real
// permission errors and fail at once. The budget is time, not tries (as blob-fs's): 5 s by default.
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const WINDOWS = process.platform === "win32";
export const BUSY_BUDGET_MS = 5_000;

export interface BusyCounter {
  busy?: number;
  /** ENOENT retries (`retryMissing`). */
  missing?: number;
}

export interface BusyOptions {
  /** Counts the retries. */
  counter?: BusyCounter;
  /** How long a busy file is retried in all, in ms (default `BUSY_BUDGET_MS`). */
  budgetMs?: number;
  /** Whether busy errors are retried (default: on Windows). Tests set it to act out Windows on another OS. */
  windows?: boolean;
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

/** Whether `e` is a busy file that `retryBusy` would wait out. */
export function isBusy(e: unknown, o: BusyOptions = {}): boolean {
  return (o.windows ?? WINDOWS) && BUSY.has(errCode(e) ?? "");
}

/**
 * Runs `fn`; while the OS reports the file busy (Windows), waits on a timer and runs it again, with a growing backoff
 * (1, 2, … 25 ms), until it succeeds, fails another way, or the budget would be passed (then the last error). The
 * thread is never blocked: the event loop keeps running while it waits.
 */
export function retryBusy<T>(fn: () => T | Promise<T>, o: BusyOptions = {}): Promise<T> {
  return retrying(fn, o, performance.now(), 0);
}

async function retrying<T>(fn: () => T | Promise<T>, o: BusyOptions, start: number, i: number): Promise<T> {
  for (; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const wait = Math.min(1 + i, 25);
      if (!isBusy(e, o) || performance.now() - start + wait > (o.budgetMs ?? BUSY_BUDGET_MS)) throw e;
      if (o.counter) o.counter.busy = (o.counter.busy ?? 0) + 1;
      await delay(wait);
    }
  }
}

/**
 * The install's steps: `fn` runs at once, synchronously, and only a busy file turns it into a promise that `retryBusy`
 * finishes. The fast path never yields, so the path stays missing for microseconds, not a trip around the event loop.
 */
function atOnce(fn: () => void, o: BusyOptions): Promise<void> | undefined {
  const start = performance.now();
  try {
    fn();
    return undefined;
  } catch (e) {
    if (!isBusy(e, o)) throw e;
    if (o.counter) o.counter.busy = (o.counter.busy ?? 0) + 1;
    return retrying(fn, o, start, 0);
  }
}

export const MISSING_RETRY_MS = 100;
/** While the bundle's install lock is held (install-lock.ts), readers wait this long, as the app's facade does. */
export const LOCKED_RETRY_MS = 6_000;
/** The bundle's install lock folder (install-lock.ts), relative to the bundle. */
export const INSTALL_LOCK = path.join(".carton", "install.lock");

export interface MissingOptions extends BusyOptions {
  /** How long a missing file is waited for (default `MISSING_RETRY_MS`). */
  missingMs?: number;
  /** The project bundle: while its install lock is held, a missing file is waited for up to `lockedMs`. */
  bundle?: string;
  lockedMs?: number;
}

/**
 * For readers of a path Carton installs (project.json, timeline.tsx, a view): runs `fn`, and while it fails with ENOENT
 * waits on a timer and runs it again (1, 2, 4 … 16 ms) for up to `missingMs` (100 ms; up to `lockedMs`, 6 s, while
 * the bundle's install lock is held), so the moment between displace and install reads as a short delay, not as a
 * missing file. A file that stays missing fails as before. Busy errors (Windows) are retried as `retryBusy` does.
 */
export async function retryMissing<T>(fn: () => T | Promise<T>, o: MissingOptions = {}): Promise<T> {
  const start = performance.now();
  for (let wait = 1; ; wait = Math.min(wait * 2, 16)) {
    try {
      return await retryBusy(fn, o);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
      const locked = o.bundle !== undefined && fs.existsSync(path.join(o.bundle, INSTALL_LOCK));
      if (performance.now() - start + wait > (locked ? (o.lockedMs ?? LOCKED_RETRY_MS) : (o.missingMs ?? MISSING_RETRY_MS))) throw e;
      if (o.counter) o.counter.missing = (o.counter.missing ?? 0) + 1;
      await delay(wait);
    }
  }
}

/** `ino:size:mtimeNs`, the stamp 1.4.0 itself uses for project.json (`Qo`). */
export function stampOf(s: fs.BigIntStats): string {
  return `${s.ino}:${s.size}:${s.mtimeNs}`;
}

/** The file's stamp, or null if it is absent. */
export async function statStamp(file: string, o: BusyOptions = {}): Promise<string | null> {
  try {
    return stampOf(await retryBusy(() => fs.statSync(file, { bigint: true }), o));
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

export interface InstallResult {
  /** Paths the target was moved to, in order. Each one must be reviewed: it may hold a foreign write. */
  displaced: string[];
  /** Foreign writes that landed between a displace and the install (each was displaced and kept too). */
  eexist: number;
  /** ns from the last rename to the successful link: how long the path was missing. */
  gapNs: number;
  /** ns from the first rename to the successful link (includes EEXIST retries). */
  gapTotalNs: number;
}

export interface InstallOptions extends BusyOptions {
  /** Test hook, called between the displace and the install: P10 widens this step to make rare races common. */
  between?: () => void;
  /** No hard links on this volume (FAT, exFAT): fall back to stat-then-rename (L13). */
  noLinks?: boolean;
  /** The stamp Carton's last install left at the target, for the no-links fallback. */
  lastStamp?: string | null;
  /** How many foreign files one install displaces before it gives up (`InstallGaveUp`), default 50. */
  maxDisplaced?: number;
  /**
   * The install lock's `mine()`: checked before each displacing rename. False means another process took the lock over
   * (this one stalled for a minute) and may have installed newer state since: this install stops (`InstallLockLost`)
   * instead of putting its older file in place.
   */
  mine?: () => boolean;
}

/**
 * A writer kept re-creating the target faster than Carton could install (a runaway tool): the install stops instead of
 * filling `.carton/displaced/`. The writer's last file stays at the target, nothing was lost, and every file this
 * install moved aside is in `displaced`, to be reviewed as usual. The next install tries again.
 */
export class InstallGaveUp extends Error {
  readonly displaced: string[];
  constructor(target: string, displaced: string[]) {
    super(`${target}: another process kept re-creating it; Carton's install gave up after ${displaced.length} displaced files`);
    this.name = "InstallGaveUp";
    this.displaced = displaced;
  }
}

/** The install lock was taken over while this install waited: it installed nothing (`displaced`: what it moved aside). */
export class InstallLockLost extends Error {
  readonly displaced: string[];
  constructor(target: string, displaced: string[]) {
    super(`${target}: another process took the install lock over; this install stopped (its content may be older)`);
    this.name = "InstallLockLost";
    this.displaced = displaced;
  }
}

const hr = (): bigint => process.hrtime.bigint();

/**
 * Installs the file at `tmp` as `target`, displacing whatever is there to paths from `nextSlot()`. `tmp` must be on
 * the same volume as `target` and is removed on success. Runs synchronously unless a file is busy (Windows).
 */
export async function displaceThenInstall(target: string, tmp: string, nextSlot: () => string, opts: InstallOptions = {}): Promise<InstallResult> {
  if (opts.noLinks) return installWithoutLinks(target, tmp, nextSlot, opts);
  const displaced: string[] = [];
  let eexist = 0;
  let first: bigint | null = null;
  for (;;) {
    if (opts.mine && !opts.mine()) throw new InstallLockLost(target, displaced);
    const slot = nextSlot();
    const t0 = hr();
    first ??= t0;
    try {
      const busy = atOnce(() => fs.renameSync(target, slot), opts);
      if (busy) await busy;
      displaced.push(slot);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    const t1 = hr();
    opts.between?.();
    try {
      const busy = atOnce(() => fs.linkSync(tmp, target), opts);
      if (busy) await busy;
    } catch (e) {
      if (errCode(e) !== "EEXIST") {
        if (displaced.at(-1) === slot && (await putBack(slot, target, opts))) displaced.pop();
        throw e;
      }
      eexist++;
      if (displaced.length >= (opts.maxDisplaced ?? 50)) throw new InstallGaveUp(target, displaced);
      continue;
    }
    const t2 = hr();
    const busy = atOnce(() => fs.unlinkSync(tmp), opts);
    if (busy) await busy;
    return { displaced, eexist, gapNs: Number(t2 - t1), gapTotalNs: Number(t2 - first) };
  }
}

/**
 * After a failed install: the file displaced last goes back to `target` if the name is still free (link: never over a
 * foreign write that landed meanwhile; that one keeps the path, and the displaced file stays held). True if it went back.
 */
async function putBack(slot: string, target: string, opts: BusyOptions): Promise<boolean> {
  try {
    await retryBusy(() => fs.linkSync(slot, target), opts);
  } catch {
    return false; // EEXIST: a foreign write holds the path; or links fail too: the caller holds the file
  }
  try {
    await retryBusy(() => fs.unlinkSync(slot), opts);
  } catch {
    // the slot stays as a second name of the file now at the target: reviewed as Carton's own or a foreign write
    return false;
  }
  return true;
}

// FAT and exFAT have no hard links. There the best available is: if the target isn't what Carton last installed,
// displace it first; then rename the temp over the target. A foreign write that lands between the check and the
// rename is overwritten: a window of microseconds, stated as L13.
async function installWithoutLinks(target: string, tmp: string, nextSlot: () => string, opts: InstallOptions): Promise<InstallResult> {
  const displaced: string[] = [];
  const t0 = hr();
  const stamp = await statStamp(target, opts);
  if (opts.mine && !opts.mine()) throw new InstallLockLost(target, displaced);
  if (stamp !== null && stamp !== opts.lastStamp) {
    const slot = nextSlot();
    try {
      await retryBusy(() => fs.renameSync(target, slot), opts);
      displaced.push(slot);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
  }
  const t1 = hr();
  opts.between?.();
  try {
    await retryBusy(() => fs.renameSync(tmp, target), opts);
  } catch (e) {
    // put the displaced file back (rename: no links here; the same L13 window as the install itself)
    const slot = displaced.at(-1);
    if (slot && (await statStamp(target, opts).catch(() => "?")) === null) await retryBusy(() => fs.renameSync(slot, target), opts).catch(() => undefined);
    throw e;
  }
  const t2 = hr();
  return { displaced, eexist: 0, gapNs: Number(t2 - t1), gapTotalNs: Number(t2 - t0) };
}

const linkSupport = new Map<string, boolean>();

/**
 * Whether `dir`'s volume supports hard links, probed once per directory. On Windows a FAT volume fails CreateHardLinkW
 * with ERROR_INVALID_FUNCTION, which libuv reports as EISDIR, so any failure other than a busy file counts as "no".
 */
export function hardLinksWork(dir: string): boolean {
  const known = linkSupport.get(dir);
  if (known !== undefined) return known;
  const tag = randomBytes(6).toString("hex");
  const a = path.join(dir, `.carton-link-probe-${tag}-a`);
  const b = path.join(dir, `.carton-link-probe-${tag}-b`);
  let ok = false;
  try {
    fs.writeFileSync(a, "x", { flag: "wx" });
    try {
      fs.linkSync(a, b);
      ok = true;
    } catch {
      ok = false;
    }
  } finally {
    for (const p of [a, b]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // the probe files may not exist
      }
    }
  }
  linkSupport.set(dir, ok);
  return ok;
}
