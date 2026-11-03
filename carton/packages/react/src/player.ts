// Play (DESIGN §5.3, PLAN 4.2): the engine behind ▶ on a change and Play all, in the Changes view and a version's card.
// It runs outside React: every animation frame it advances the time and tells its frame listeners (the lit row's
// progress line, the change map's playhead, the host's player), while React hears only about coarse changes (which row
// is lit, play/pause). So playback costs no React render per frame, which is what keeps it at the display's frame rate.

import type { Change } from "./model.ts";

/** Animation frames and the time, injected so tests and benchmarks can step them. */
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

// ---------------------------------------------------------------- Play and Before (DESIGN §5.3, PLAN 4.2)
// Play plays the changes themselves, from their places in the edit (`Change.at` / `end`), not shots: ▶ on a change
// plays its spot with a second either side; Play all plays every spot in order. Spots that overlap play as one stretch,
// with no jump between them. A change with no place (the frame rate) is lit briefly and skipped. No counter and no
// steps: the lit row is where you are, one at a time (in a stretch of overlapping spots, the change whose spot started
// last of those under the playhead, as `after/changes-playing-384.png` shows; lighting all of them left a dense edit
// with every row lit at once). Like ChangesPlayer, it runs outside React: every frame it tells its frame listeners (the
// lit row's progress line and the change map's playhead, written to the DOM, and the host's player), and React hears
// only which row is lit and play/pause.

/** One stretch Play plays: overlapping spots, in timeline order, each with its own spot. */
export interface PlayStep {
  /** The rows it plays (indexes into the list it was made from), by when their spots start. */
  readonly rows: readonly number[];
  /** Each row's own spot [start, end), in seconds of the side shown (aligned with `rows`). Empty with no place. */
  readonly spans: readonly (readonly [number, number])[];
  /** The stretch, [start, end). Null: a change with no place in the edit, lit for `ms` and skipped. */
  readonly start: number | null;
  readonly end: number | null;
  /** How long a step with no place stays lit. */
  readonly ms?: number;
}

export interface StepOptions {
  /** Seconds played either side of a change (DESIGN §5.3: one). */
  context?: number;
  /** The edit's length (seconds of the side shown): no step plays past it. */
  length?: number;
  /**
   * The longest a single change plays (seconds, before its context): a change as long as the edit (the music's volume)
   * plays its first seconds, so it doesn't swallow every other spot into one.
   */
  maxSpan?: number;
  /** How long a change with no place stays lit (ms). */
  flashMs?: number;
}

export const PLAY_CONTEXT = 1;
export const PLAY_MAX_SPAN = 8;
export const PLAY_FLASH_MS = 700;

/** Where one change plays: [start, end) with its context, or null when it has no place in the edit. Pure. */
export function changeSpan(c: Change, o: StepOptions = {}): [number, number] | null {
  if (c.at == null || !Number.isFinite(c.at)) return null;
  const ctx = o.context ?? PLAY_CONTEXT, max = o.maxSpan ?? PLAY_MAX_SPAN;
  const at = Math.max(0, c.at);
  const to = c.end != null && Number.isFinite(c.end) ? Math.min(Math.max(at, c.end), at + max) : at;
  let s = Math.max(0, at - ctx), e = to + ctx;
  if (o.length != null && o.length > 0) {
    e = Math.min(e, o.length);
    // a change at the very end (a removal past the newer side's end): its last seconds
    if (e - s < ctx) s = Math.max(0, e - 2 * ctx);
  }
  return e > s ? [s, e] : null;
}

/** Play all: every change's spot in timeline order, overlapping ones as one stretch, then the changes with no place. Pure. */
export function playSteps(changes: readonly Change[], o: StepOptions = {}): PlayStep[] {
  const spots: { s: number; e: number; row: number }[] = [];
  const flashes: number[] = [];
  changes.forEach((c, row) => {
    const sp = changeSpan(c, o);
    if (sp) spots.push({ s: sp[0], e: sp[1], row });
    else flashes.push(row);
  });
  spots.sort((x, y) => x.s - y.s || x.e - y.e || x.row - y.row);
  const out: PlayStep[] = [];
  let cur: { start: number; end: number; rows: number[]; spans: [number, number][] } | null = null;
  for (const sp of spots) {
    // overlapping spots play as one; a spot that starts where the last ended is its own step
    if (cur && sp.s < cur.end - 1e-6) {
      cur.end = Math.max(cur.end, sp.e);
      cur.rows.push(sp.row);
      cur.spans.push([sp.s, sp.e]);
    } else {
      if (cur) out.push(cur);
      cur = { start: sp.s, end: sp.e, rows: [sp.row], spans: [[sp.s, sp.e]] };
    }
  }
  if (cur) out.push(cur);
  for (const row of flashes) out.push({ rows: [row], spans: [], start: null, end: null, ms: o.flashMs ?? PLAY_FLASH_MS });
  return out;
}

/** ▶ on one change: its own spot. Null for a row that isn't there. */
export function stepFor(changes: readonly Change[], row: number, o: StepOptions = {}): PlayStep | null {
  const c = changes[row];
  if (!c) return null;
  const sp = changeSpan(c, o);
  if (!sp) return { rows: [row], spans: [], start: null, end: null, ms: o.flashMs ?? PLAY_FLASH_MS };
  return { rows: [row], spans: [sp], start: sp[0], end: sp[1] };
}

/** Which of a step's rows is lit at `t`: of the spots under it, the one that started last (its index in the step). */
export function litAt(step: PlayStep, t: number): number {
  let best = -1;
  for (let i = 0; i < step.spans.length; i++) {
    const [s, e] = step.spans[i]!;
    if (s <= t + 1e-9 && t < e && (best < 0 || s >= step.spans[best]![0])) best = i;
  }
  if (best >= 0) return best;
  // between two spots of one stretch there is none under it (can't happen once merged), or at its very end: the last
  // spot that has started
  for (let i = step.spans.length - 1; i >= 0; i--) if (step.spans[i]![0] <= t + 1e-9) return i;
  return 0;
}

export interface SpanState {
  readonly playing: boolean;
  /** The step playing or paused in, or -1 (not started, or finished). */
  readonly step: number;
  /** The row lit (one, or none: an empty list). */
  readonly rows: readonly number[];
  /** The last step finished: Play all ran to its end. */
  readonly done: boolean;
}

const IDLE: SpanState = { playing: false, step: -1, rows: [], done: false };

/**
 * Plays a list of steps, outside React. Frame listeners get the time in the edit (null while a step with no place is
 * lit) and the lit row's progress through its own spot (0–1); state listeners get only coarse changes.
 */
export class SpanPlayer {
  #steps: readonly PlayStep[] = [];
  #state: SpanState = IDLE;
  #clock: Clock;
  #t = 0;
  #lit = 0;
  #frame = 0;
  #last = 0;
  #onFrame = new Set<(t: number | null, progress: number) => void>();
  #onState = new Set<(s: SpanState) => void>();

  constructor(opts: { clock?: Clock } = {}) {
    this.#clock = opts.clock ?? browserClock();
  }

  get state(): SpanState {
    return this.#state;
  }
  /** The time in the edit, as the last frame told it. */
  get time(): number {
    return this.#t;
  }
  get steps(): readonly PlayStep[] {
    return this.#steps;
  }

  onFrame(fn: (t: number | null, progress: number) => void): () => void {
    this.#onFrame.add(fn);
    return () => this.#onFrame.delete(fn);
  }
  onState(fn: (s: SpanState) => void): () => void {
    this.#onState.add(fn);
    return () => this.#onState.delete(fn);
  }

  /** Play these steps from the first: Play all, or one change's ▶. */
  start(steps: readonly PlayStep[]): void {
    this.#cancel();
    this.#steps = steps;
    if (!steps.length) return this.#set(IDLE);
    this.#enter(0);
    this.#run();
  }

  /** Go on from where it paused (or from the top once it finished). */
  resume(): void {
    if (this.#state.playing || !this.#steps.length) return;
    if (this.#state.step < 0) this.#enter(0);
    this.#run();
  }

  pause(): void {
    if (!this.#state.playing) return;
    this.#cancel();
    this.#set({ ...this.#state, playing: false });
  }

  /** Back to nothing lit. */
  stop(): void {
    this.#cancel();
    this.#set(IDLE);
  }

  dispose(): void {
    this.#cancel();
    this.#onFrame.clear();
    this.#onState.clear();
  }

  #run() {
    this.#set({ ...this.#state, playing: true, done: false });
    this.#last = this.#clock.now();
    this.#emit();
    this.#frame = this.#clock.request(this.#tick);
  }

  #cancel() {
    if (this.#frame) this.#clock.cancel(this.#frame);
    this.#frame = 0;
  }

  #enter(i: number) {
    const s = this.#steps[i]!;
    if (s.start != null) this.#t = s.start;
    this.#lit = 0;
    this.#set({ playing: this.#state.playing, step: i, rows: [s.rows[s.start == null ? 0 : litAt(s, this.#t)]!], done: false });
  }

  #progress(): number {
    const s = this.#steps[this.#state.step];
    if (!s) return 0;
    if (s.start == null) return Math.min(1, this.#lit / Math.max(1, s.ms ?? PLAY_FLASH_MS));
    const sp = s.spans[s.rows.indexOf(this.#state.rows[0]!)] ?? [s.start, s.end!];
    return sp[1] > sp[0] ? Math.min(1, Math.max(0, (this.#t - sp[0]) / (sp[1] - sp[0]))) : 1;
  }

  #tick = (now: number) => {
    this.#frame = 0;
    if (!this.#state.playing) return;
    // Cap a frame's step, so a tab in the background doesn't skip whole changes when it wakes.
    const dt = Math.min(0.25, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const s = this.#steps[this.#state.step];
    if (!s) return this.stop();
    let over: boolean;
    if (s.start == null) {
      this.#lit += dt * 1000;
      over = this.#lit >= (s.ms ?? PLAY_FLASH_MS);
    } else {
      this.#t = Math.min(this.#t + dt, s.end!);
      over = this.#t >= s.end!;
      // the lit row follows the playhead through a stretch of overlapping spots (a coarse change: at a spot's edge)
      const row = s.rows[litAt(s, this.#t)]!;
      if (!over && row !== this.#state.rows[0]) this.#set({ ...this.#state, rows: [row] });
    }
    if (over) {
      const i = this.#state.step + 1;
      if (i >= this.#steps.length) {
        this.#emit();
        this.#set({ playing: false, step: -1, rows: [], done: true });
        return;
      }
      this.#enter(i);
    }
    this.#emit();
    this.#frame = this.#clock.request(this.#tick);
  };

  #emit() {
    const s = this.#steps[this.#state.step];
    const t = s && s.start == null ? null : this.#t;
    const p = this.#progress();
    for (const fn of this.#onFrame) fn(t, p);
  }

  #set(next: SpanState) {
    const s = this.#state;
    if (next.playing === s.playing && next.step === s.step && next.rows === s.rows && next.done === s.done) return;
    this.#state = next;
    for (const fn of this.#onState) fn(next);
  }
}
