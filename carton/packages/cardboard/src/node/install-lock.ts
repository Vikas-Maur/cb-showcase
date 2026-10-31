// The bundle's install lock, `.carton/install.lock/`: whoever installs a watched file (project.json, timeline.tsx)
// holds it, and the app's readers wait while it is held (the facade's `readFile` waits up to 6 s, 50 ms without it), so
// the moment between displace and link reads as a short delay, not as a missing file. The same folder and owner file
// as the app's facade (`withInstallLock` in scripts/carton/carton-node.js), so the two exclude each other:
//  - taking it: mkdir the folder, then write `owner` = {pid, me}; EEXIST means someone holds it, so wait. On Windows a
//    folder just removed is "delete pending" for a moment and mkdir fails with EPERM/EACCES: that is the lock being
//    freed, so wait too.
//  - holding it: touch `owner` every second.
//  - taking over: from a holder silent for 10 s whose pid no longer runs, or silent for 60 s (pids are reused on
//    Windows). The folder is renamed aside first, so only one taker wins.
//  - giving up: a waiter that can't take it within 30 s throws `InstallLockBusy`; the next install tries again.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { INSTALL_LOCK, isBusy, retryBusy, type BusyOptions } from "./displace.ts";

export interface InstallLockOptions extends BusyOptions {
  /** How long to wait for the lock before `InstallLockBusy` (default 30 s, as the facade). */
  waitMs?: number;
  /** How often the holder touches `owner` (default 1 s). */
  beatMs?: number;
  /** Test seams: the clock (ms) and whether a pid runs. */
  now?: () => number;
  alive?: (pid: number) => boolean;
}

export class InstallLockBusy extends Error {
  constructor(bundle: string, waitedMs: number) {
    super(`${bundle}: another process kept the install lock for ${Math.round(waitedMs)} ms`);
    this.name = "InstallLockBusy";
  }
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Moves an abandoned lock aside (one rename: one winner) so it can be taken. */
function takeOverIfAbandoned(dir: string, now: number, alive: (pid: number) => boolean): void {
  const owner = path.join(dir, "owner");
  let pid: number | null = null;
  let beat: number;
  try {
    pid = (JSON.parse(fs.readFileSync(owner, "utf8")) as { pid?: number }).pid ?? null;
    beat = fs.statSync(owner).mtimeMs;
  } catch {
    try {
      beat = fs.statSync(dir).mtimeMs; // taken, owner not written yet
    } catch {
      return; // released meanwhile
    }
  }
  const silent = now - beat;
  if (!(silent > 60_000 || (silent > 10_000 && !(pid !== null && alive(pid))))) return;
  const aside = `${dir}.abandoned.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(dir, aside);
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    // another taker won, or the holder released it
  }
}

/**
 * Runs `fn` holding the bundle's install lock. `fn` gets `mine()`, false once another process took the lock over (this
 * one stalled for a minute). The lock is released afterwards if it is still ours.
 */
export async function withInstallLock<T>(bundle: string, fn: (mine: () => boolean) => Promise<T>, o: InstallLockOptions = {}): Promise<T> {
  const dir = path.join(bundle, INSTALL_LOCK);
  const owner = path.join(dir, "owner");
  const now = o.now ?? Date.now;
  const me = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const t0 = performance.now();
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, me }));
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fs.mkdirSync(path.dirname(dir), { recursive: true }); // no .carton yet
        continue;
      }
      if (code !== "EEXIST" && !isBusy(e, o)) throw e;
      if (code === "EEXIST") takeOverIfAbandoned(dir, now(), o.alive ?? running);
      const waited = performance.now() - t0;
      if (waited > (o.waitMs ?? 30_000)) throw new InstallLockBusy(bundle, waited);
      await delay(Math.min(1 + i, 5));
    }
  }
  const mine = (): boolean => {
    try {
      return (JSON.parse(fs.readFileSync(owner, "utf8")) as { me?: string }).me === me;
    } catch {
      return false;
    }
  };
  const beat = setInterval(() => {
    try {
      const t = new Date();
      fs.utimesSync(owner, t, t);
    } catch {
      // taken over, or being released
    }
  }, o.beatMs ?? 1_000);
  beat.unref();
  try {
    return await fn(mine);
  } finally {
    clearInterval(beat);
    // best effort: a lock left behind is taken over once it has been silent long enough
    if (mine()) await retryBusy(() => fs.rmSync(dir, { recursive: true, force: true }), o).catch(() => undefined);
  }
}

/** Whether the bundle's install lock is held right now (readers wait longer while it is). */
export const installLockHeld = (bundle: string): boolean => fs.existsSync(path.join(bundle, INSTALL_LOCK));
