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
// is missing; Cardboard's readers (which we hook) and agents' file tools retry on ENOENT.
//
// All calls are synchronous on purpose: the engine runs on its own thread, and P10 measured the missing-path gap at
// 10–16 µs median with sync calls against 61–68 µs through fs.promises (the gap spans one libuv round trip each).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Windows reports a file that another process holds open as busy: rename, link and unlink fail with EPERM, EBUSY or
// EACCES until the holder closes it. The app's rename-retry helper retries those; so do we. These never fire on Linux
// or macOS for the calls below.
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

export interface BusyCounter {
  busy?: number;
}

/** Runs `fn`, retrying while the OS reports the file busy (Windows), with a short growing backoff (≈ 5 s in all). */
export function retryBusy<T>(fn: () => T, counter?: BusyCounter, attempts = 400): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !BUSY.has(code) || i >= attempts) throw e;
      if (counter) counter.busy = (counter.busy ?? 0) + 1;
      sleepMs(Math.min(1 + i, 25));
    }
  }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

/** `ino:size:mtimeNs`, the stamp 1.4.0 itself uses for project.json (`Qo`). */
export function stampOf(s: fs.BigIntStats): string {
  return `${s.ino}:${s.size}:${s.mtimeNs}`;
}

export function statStamp(file: string): string | null {
  try {
    return stampOf(fs.statSync(file, { bigint: true }));
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

export interface InstallOptions {
  counter?: BusyCounter;
  /** Test hook, called between the displace and the install: P10 widens this step to make rare races common. */
  between?: () => void;
  /** No hard links on this volume (FAT, exFAT): fall back to stat-then-rename (L13). */
  noLinks?: boolean;
  /** The stamp Carton's last install left at the target, for the no-links fallback. */
  lastStamp?: string | null;
}

const now = (): bigint => process.hrtime.bigint();

/**
 * Installs the file at `tmp` as `target`, displacing whatever is there to paths from `nextSlot()`. `tmp` must be on
 * the same volume as `target` and is removed on success.
 */
export function displaceThenInstall(target: string, tmp: string, nextSlot: () => string, opts: InstallOptions = {}): InstallResult {
  if (opts.noLinks) return installWithoutLinks(target, tmp, nextSlot, opts);
  const displaced: string[] = [];
  let eexist = 0;
  let first: bigint | null = null;
  for (;;) {
    const slot = nextSlot();
    const t0 = now();
    first ??= t0;
    try {
      retryBusy(() => fs.renameSync(target, slot), opts.counter);
      displaced.push(slot);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    const t1 = now();
    opts.between?.();
    try {
      retryBusy(() => fs.linkSync(tmp, target), opts.counter);
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      eexist++;
      continue;
    }
    const t2 = now();
    retryBusy(() => fs.unlinkSync(tmp), opts.counter);
    return { displaced, eexist, gapNs: Number(t2 - t1), gapTotalNs: Number(t2 - first) };
  }
}

// FAT and exFAT have no hard links. There the best available is: if the target isn't what Carton last installed,
// displace it first; then rename the temp over the target. A foreign write that lands between the check and the
// rename is overwritten: a window of microseconds, stated as L13.
function installWithoutLinks(target: string, tmp: string, nextSlot: () => string, opts: InstallOptions): InstallResult {
  const displaced: string[] = [];
  const t0 = now();
  const stamp = statStamp(target);
  if (stamp !== null && stamp !== opts.lastStamp) {
    const slot = nextSlot();
    try {
      retryBusy(() => fs.renameSync(target, slot), opts.counter);
      displaced.push(slot);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
  }
  const t1 = now();
  opts.between?.();
  retryBusy(() => fs.renameSync(tmp, target), opts.counter);
  const t2 = now();
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
