// The Play changes engine. It runs outside React: every animation frame it advances the time and tells the frame
// listeners (the playhead, the timecode, the host's preview), while React hears only about coarse changes (which
// change is playing, play/pause, Before/After). So playback costs no React render per frame, which is what keeps it
// at the display's frame rate (task: 60 fps during playback).

import type { ShotDiff } from "./model.ts";
import { alignRows, mapTime, playlist, rowRange, segmentAt, type Row, type Segment } from "./shots.ts";

export type Side = "a" | "b";

export interface PlayerState {
  readonly side: Side;
  readonly playing: boolean;
  /** Index into the side's segments of the change playing or last played, or -1 before the first. */
  readonly segment: number;
  /** Which change (index among change rows) that is, or -1. */
  readonly change: number;
}

export interface Clock {
  now(): number;
  request(fn: (t: number) => void): number;
  cancel(id: number): void;
}

const browserClock = (): Clock => ({
  now: () => performance.now(),
  request: (fn) => requestAnimationFrame(fn),
  cancel: (id) => cancelAnimationFrame(id),
});

export class ChangesPlayer {
  readonly diff: ShotDiff;
  readonly rows: Row[];
  /** Row index of every change, in order: "Change i of n". */
  readonly changeRows: number[];
  #segs: Record<Side, Segment[]>;
  /** Per side, when each change's lead-in starts: "Change i of n" follows the time, also inside merged segments. */
  #starts: Record<Side, number[]>;
  #t = 0;
  #state: PlayerState;
  #clock: Clock;
  #frame = 0;
  #last = 0;
  #rate = 1;
  #onFrame = new Set<(side: Side, t: number) => void>();
  #onState = new Set<(s: PlayerState) => void>();

  constructor(diff: ShotDiff, opts: { context?: number; side?: Side; clock?: Clock } = {}) {
    this.diff = diff;
    this.rows = alignRows(diff);
    this.changeRows = this.rows.flatMap((r, i) => (r.kind === "change" ? [i] : []));
    const ctx = opts.context ?? 1;
    this.#segs = { a: playlist(diff, this.rows, "a", ctx), b: playlist(diff, this.rows, "b", ctx) };
    const starts = (side: Side) => this.changeRows.map((r) => rowRange(diff, this.rows[r]!, side)[0] - ctx);
    this.#starts = { a: starts("a"), b: starts("b") };
    this.#clock = opts.clock ?? browserClock();
    const side = opts.side ?? "b";
    this.#t = this.#segs[side][0]?.start ?? 0;
    this.#state = { side, playing: false, segment: this.#segs[side].length ? 0 : -1, change: this.changeRows.length ? 0 : -1 };
  }

  get time(): number {
    return this.#t;
  }
  get state(): PlayerState {
    return this.#state;
  }
  segments(side: Side = this.#state.side): readonly Segment[] {
    return this.#segs[side];
  }

  onFrame(fn: (side: Side, t: number) => void): () => void {
    this.#onFrame.add(fn);
    return () => this.#onFrame.delete(fn);
  }
  onState(fn: (s: PlayerState) => void): () => void {
    this.#onState.add(fn);
    return () => this.#onState.delete(fn);
  }

  play(): void {
    if (this.#state.playing) return;
    const segs = this.#segs[this.#state.side];
    if (!segs.length) return;
    let i = segmentAt(segs, this.#t);
    // Past the last change, or between changes: start from the next change (or from the top after the end).
    if (i < 0) i = 0;
    if (this.#t < segs[i]!.start || this.#t >= segs[i]!.end) this.#t = segs[i]!.start;
    this.#set({ playing: true, segment: i, change: this.#changeAt(this.#state.side, this.#t) });
    this.#last = this.#clock.now();
    this.#emit();
    this.#frame = this.#clock.request(this.#tick);
  }

  pause(): void {
    if (!this.#state.playing) return;
    this.#clock.cancel(this.#frame);
    this.#frame = 0;
    this.#set({ playing: false });
  }

  toggle(): void {
    if (this.#state.playing) this.pause();
    else this.play();
  }

  /** Jump to a change (index among changes) and show its start. */
  goToChange(n: number): void {
    const row = this.changeRows[n];
    if (row == null) return;
    const side = this.#state.side;
    const segs = this.#segs[side];
    const i = segs.findIndex((s, k) => s.row <= row && (k === segs.length - 1 || segs[k + 1]!.row > row));
    if (i < 0) return;
    // A merged segment can hold several changes: start at this change's own lead-in.
    this.#t = Math.max(segs[i]!.start, this.#starts[side][n]!);
    this.#last = this.#clock.now();
    this.#set({ segment: i, change: n });
    this.#emit();
  }

  next(): void {
    this.goToChange(Math.min(this.changeRows.length - 1, this.#state.change + 1));
  }
  previous(): void {
    this.goToChange(Math.max(0, this.#state.change - 1));
  }

  /** Show a time on the current side (a click on the strip). */
  seek(t: number, side: Side = this.#state.side): void {
    if (side !== this.#state.side) this.#set({ side });
    this.#t = t;
    this.#last = this.#clock.now();
    const segs = this.#segs[side];
    this.#set({ segment: segmentAt(segs, t), change: this.#changeAt(side, t) });
    this.#emit();
  }

  /** The aligned A/B toggle (§9): the other side, at the same moment. */
  setSide(side: Side): void {
    if (side === this.#state.side) return;
    const t = mapTime(this.diff, this.rows, this.#state.side, this.#t);
    const segs = this.#segs[side];
    this.#t = t;
    this.#last = this.#clock.now();
    this.#set({ side, segment: segmentAt(segs, t), change: this.#changeAt(side, t) });
    this.#emit();
  }

  dispose(): void {
    if (this.#frame) this.#clock.cancel(this.#frame);
    this.#frame = 0;
    this.#onFrame.clear();
    this.#onState.clear();
  }

  #tick = (now: number) => {
    this.#frame = 0;
    if (!this.#state.playing) return;
    // Cap a frame's step, so a tab in the background doesn't skip whole changes when it wakes.
    const dt = Math.min(0.25, Math.max(0, (now - this.#last) / 1000)) * this.#rate;
    this.#last = now;
    const side = this.#state.side;
    const segs = this.#segs[side];
    let i = this.#state.segment;
    let t = this.#t + dt;
    if (i < 0 || i >= segs.length) {
      this.pause();
      return;
    }
    if (t >= segs[i]!.end) {
      i++;
      if (i >= segs.length) {
        this.#t = segs[segs.length - 1]!.end;
        this.#emit();
        this.pause();
        return;
      }
      t = segs[i]!.start;
      this.#set({ segment: i });
    }
    this.#t = t;
    this.#set({ change: this.#changeAt(side, t) });
    this.#emit();
    this.#frame = this.#clock.request(this.#tick);
  };

  /** The last change whose lead-in has started at `t` (binary search), or the first one. */
  #changeAt(side: Side, t: number): number {
    const st = this.#starts[side];
    if (!st.length) return -1;
    let lo = 0, hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid]! <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  #emit() {
    for (const fn of this.#onFrame) fn(this.#state.side, this.#t);
  }

  #set(patch: Partial<PlayerState>) {
    const s = this.#state;
    const next = { ...s, ...patch };
    if (next.side === s.side && next.playing === s.playing && next.segment === s.segment && next.change === s.change) return;
    this.#state = next;
    for (const fn of this.#onState) fn(next);
  }
}
