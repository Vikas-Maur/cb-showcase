// The files `displaceThenInstall` moved off a watched path, held in `.carton/displaced/` until Carton knows what each
// one is (PLAN §6.4, "Quiescence before import", P10 settle-2):
//  - Carton's own last install: deleted only once its bytes **and** its install-time stamp are still unchanged after
//    a hold. An in-place writer (open, truncate, write) can resolve the path just before it is displaced and write
//    into that inode just after Carton read it; the hold and the stamp check catch that write (L19 is what's left).
//  - a foreign write that parses completely: imported at once (the atomic temp+rename writer).
//  - a foreign write that doesn't parse yet (an in-place writer mid-write, which on POSIX keeps writing into the
//    displaced inode): re-read until it parses, or until it has been quiet (stable size and mtime) for `quietMs`, at
//    which point it is reported to its writer and kept. It is never dropped, and it is still imported if it later
//    completes.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { retryBusy, stampOf, type BusyOptions } from "./displace.ts";

// Separates a slot's unique name from the tag it carries (URI-encoded, so it holds no path separators).
const TAG = "@@";

export interface OwnInstall {
  bytes: Uint8Array;
  /** The stamp right after the install (`ino:size:mtimeNs`). */
  stamp: string;
}

interface Held {
  path: string;
  own: OwnInstall | null;
  round: number;
  heldAt: number;
  stamp: string | null;
  changedAt: number;
  reported: boolean;
}

export interface Displaced {
  path: string;
  bytes: Buffer;
  /** Whether `complete(bytes)` accepted the content. */
  complete: boolean;
}

export interface Review {
  /** Foreign writes to import now. The caller removes each with `release()` once its change is stored, or puts it back
   *  with `holdForeign()` if importing it failed. */
  foreign: Displaced[];
  /** Foreign writes that stayed incomplete through a quiet window: report them to their writer. Kept on disk. */
  partial: Displaced[];
  /** Carton's own displaced installs, confirmed unchanged and deleted. */
  own: number;
  /** The paths of those deleted installs. */
  retired: string[];
}

/** Busy files (Windows) are waited out on timers, as `retryBusy` does. */
export interface DisplacedOptions extends BusyOptions {
  now?: () => number;
  /** How long an incomplete file must be quiet before it is reported (1.4.0's watch debounce is 150 ms). */
  quietMs?: number;
  /** How long Carton's own displaced installs are held before the ownership check. */
  holdMs?: number;
}

export class DisplacedFiles {
  readonly dir: string;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly holdMs: number;
  private readonly busy: BusyOptions;
  private readonly prefix: string;
  private seq = 0;
  private round = 0;
  private held: Held[] = [];
  private reviewing: Promise<unknown> = Promise.resolve();

  constructor(dir: string, opts: DisplacedOptions = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    this.quietMs = opts.quietMs ?? 150;
    this.holdMs = opts.holdMs ?? 150;
    this.busy = { counter: opts.counter, budgetMs: opts.budgetMs, windows: opts.windows };
    // Slot names never collide across processes or restarts: time, a random tag, a counter.
    this.prefix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}-`;
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * A fresh path for `displaceThenInstall`'s `nextSlot`. `tag` (e.g. the watched path it came from) is kept in the
   * name, so a restart can tell where a held file belongs (`tagOf`).
   */
  next = (tag?: string): string => path.join(this.dir, this.prefix + String(this.seq++) + (tag ? TAG + encodeURIComponent(tag) : ""));

  /** The tag a slot path was made with, or null. */
  static tagOf(file: string): string | null {
    const b = path.basename(file);
    const i = b.indexOf(TAG);
    if (i < 0) return null;
    try {
      return decodeURIComponent(b.slice(i + TAG.length));
    } catch {
      return null;
    }
  }

  /** Whether `file` is held (waiting for its review). */
  holds(file: string): boolean {
    return this.held.some((h) => h.path === file);
  }

  /** Holds a file as a foreign write: one found in the folder after a restart, or one whose import failed. */
  holdForeign(file: string): void {
    if (this.holds(file)) return;
    const t = this.now();
    this.held.push({ path: file, own: null, round: this.round, heldAt: t, stamp: null, changedAt: t, reported: false });
  }

  /** How many files are held (own installs waiting for their check, and foreign files not yet imported). */
  get size(): number {
    return this.held.length;
  }

  /** Holds the paths one install displaced. `own` is Carton's previous install at that target, if it made one. */
  hold(paths: readonly string[], own: OwnInstall | null): void {
    const t = this.now();
    for (const p of paths) this.held.push({ path: p, own, round: this.round, heldAt: t, stamp: null, changedAt: t, reported: false });
  }

  /** Marks the end of an install round: files held in earlier rounds become eligible for the ownership check. */
  endRound(): void {
    this.round++;
  }

  /**
   * Reviews every held file. `complete(bytes)` says whether content parses. With `final`, nothing more will be
   * written (tests, shutdown): every foreign file is returned for import, complete or not. Reviews run one at a time;
   * files held while one waits on a busy file stay held for the next.
   */
  review(complete: (b: Buffer) => boolean, o: { final?: boolean } = {}): Promise<Review> {
    const run = this.reviewing.then(() => this.reviewNow(complete, o.final ?? false));
    this.reviewing = run.catch(() => undefined);
    return run;
  }

  private async reviewNow(complete: (b: Buffer) => boolean, final: boolean): Promise<Review> {
    const out: Review = { foreign: [], partial: [], own: 0, retired: [] };
    const t = this.now();
    const settled = new Set<Held>();
    for (const h of [...this.held]) {
      if (h.own && !final && (h.round === this.round || t - h.heldAt < this.holdMs)) continue;
      let bytes: Buffer;
      let stamp: string;
      try {
        bytes = await retryBusy(() => fs.readFileSync(h.path), this.busy);
        stamp = stampOf(await retryBusy(() => fs.statSync(h.path, { bigint: true }), this.busy));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        settled.add(h); // released by another review
        continue;
      }
      if (h.own && stamp === h.own.stamp && Buffer.compare(bytes, h.own.bytes) === 0) {
        await retryBusy(() => fs.unlinkSync(h.path), this.busy);
        out.own++;
        out.retired.push(h.path);
        settled.add(h);
        continue;
      }
      if (stamp !== h.stamp) {
        h.stamp = stamp;
        h.changedAt = t;
      }
      const ok = complete(bytes);
      if (ok || final) {
        out.foreign.push({ path: h.path, bytes, complete: ok });
        settled.add(h);
        continue;
      }
      if (!h.reported && t - h.changedAt >= this.quietMs) {
        h.reported = true;
        out.partial.push({ path: h.path, bytes, complete: false });
      }
    }
    this.held = this.held.filter((h) => !settled.has(h));
    return out;
  }

  /** Deletes an imported foreign file. */
  async release(file: string): Promise<void> {
    try {
      await retryBusy(() => fs.unlinkSync(file), this.busy);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
