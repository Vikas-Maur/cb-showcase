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
import { retryBusy, stampOf, type BusyCounter } from "./displace.ts";

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
  /** Foreign writes to import now. The caller removes each with `release()` once its change is stored. */
  foreign: Displaced[];
  /** Foreign writes that stayed incomplete through a quiet window: report them to their writer. Kept on disk. */
  partial: Displaced[];
  /** Carton's own displaced installs, confirmed unchanged and deleted. */
  own: number;
}

export interface DisplacedOptions {
  now?: () => number;
  /** How long an incomplete file must be quiet before it is reported (1.4.0's watch debounce is 150 ms). */
  quietMs?: number;
  /** How long Carton's own displaced installs are held before the ownership check. */
  holdMs?: number;
  counter?: BusyCounter;
}

export class DisplacedFiles {
  readonly dir: string;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly holdMs: number;
  private readonly counter: BusyCounter | undefined;
  private readonly prefix: string;
  private seq = 0;
  private round = 0;
  private held: Held[] = [];

  constructor(dir: string, opts: DisplacedOptions = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    this.quietMs = opts.quietMs ?? 150;
    this.holdMs = opts.holdMs ?? 150;
    this.counter = opts.counter;
    // Slot names never collide across processes or restarts: time, a random tag, a counter.
    this.prefix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}-`;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** A fresh path for `displaceThenInstall`'s `nextSlot`. */
  next = (): string => path.join(this.dir, this.prefix + String(this.seq++));

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
   * written (tests, shutdown): every foreign file is returned for import, complete or not.
   */
  review(complete: (b: Buffer) => boolean, { final = false }: { final?: boolean } = {}): Review {
    const out: Review = { foreign: [], partial: [], own: 0 };
    const t = this.now();
    const keep: Held[] = [];
    for (const h of this.held) {
      if (h.own && !final && (h.round === this.round || t - h.heldAt < this.holdMs)) {
        keep.push(h);
        continue;
      }
      let bytes: Buffer;
      let stamp: string;
      try {
        bytes = retryBusy(() => fs.readFileSync(h.path), this.counter);
        stamp = stampOf(fs.statSync(h.path, { bigint: true }));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released by another review
        throw e;
      }
      if (h.own && stamp === h.own.stamp && Buffer.compare(bytes, h.own.bytes) === 0) {
        retryBusy(() => fs.unlinkSync(h.path), this.counter);
        out.own++;
        continue;
      }
      if (stamp !== h.stamp) {
        h.stamp = stamp;
        h.changedAt = t;
      }
      const ok = complete(bytes);
      if (ok || final) {
        out.foreign.push({ path: h.path, bytes, complete: ok });
        continue;
      }
      if (!h.reported && t - h.changedAt >= this.quietMs) {
        h.reported = true;
        out.partial.push({ path: h.path, bytes, complete: false });
      }
      keep.push(h);
    }
    this.held = keep;
    return out;
  }

  /** Deletes an imported foreign file. */
  release(file: string): void {
    try {
      retryBusy(() => fs.unlinkSync(file), this.counter);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
