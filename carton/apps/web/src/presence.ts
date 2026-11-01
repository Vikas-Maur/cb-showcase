// Presence at the rates of PLAN §12: 10–20 Hz only while dragging (the drag's ghost), 1 Hz while active, nothing after
// 30 s idle. Never stored. The state is what @carton/react's fromCarton reads: {activity, ghosts: [{item, track, start,
// end, label}]}. Sending is throttled here, before the sync client's own throttle and the server's cap.
// Going idle sends "Idle" once and then nothing (teammates show us dimmed); leaving (closing, offline) sends null.
// Presence isn't stored, so someone who connects later hasn't heard us: `announce` answers once when a new peer
// shows up and when we (re)connect.

export interface GhostState {
  item: string;
  track: string;
  start: number;
  end: number;
  label?: string;
}
export interface PresenceState {
  [key: string]: unknown;
  activity?: string;
  ghosts?: GhostState[];
}
export interface PresenceTimers {
  now(): number;
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
const realTimers: PresenceTimers = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export const DRAG_MS = 50; // 20 Hz
export const ACTIVE_MS = 1000; // 1 Hz
export const IDLE_MS = 30_000;

export class PresenceSender {
  #send: (s: PresenceState | null) => void;
  #t: PresenceTimers;
  #activity = "Editing";
  #ghosts: GhostState[] = [];
  #last = -Infinity;
  #lastSent = "";
  #pending: unknown = null;
  #idle: unknown = null;
  #active = false;
  /** Left (stop): nothing goes out until the next activity. */
  #gone = false;

  constructor(send: (s: PresenceState | null) => void, timers: PresenceTimers = realTimers) {
    this.#send = send;
    this.#t = timers;
  }

  /** Something happened (an edit, a click, playback): say so at most once a second, and restart the idle clock. */
  active(activity = this.#activity): void {
    const changed = activity !== this.#activity || !this.#active;
    this.#activity = activity;
    this.#active = true;
    this.#gone = false;
    this.#armIdle();
    if (changed) this.#flush(true);
    else this.#schedule(ACTIVE_MS);
  }
  /** A drag moved: its ghost goes out at up to 20 Hz, the newest position always last. */
  drag(ghosts: GhostState[]): void {
    this.#ghosts = ghosts;
    this.#active = true;
    this.#gone = false;
    this.#armIdle();
    this.#schedule(DRAG_MS);
  }
  /** The drag ended (committed or cancelled): the ghost goes at once. */
  endDrag(): void {
    if (!this.#ghosts.length) return;
    this.#ghosts = [];
    this.#flush(true);
  }
  /** Say where we are once, now (we connected, or a teammate who hasn't heard us appeared). */
  announce(): void {
    if (this.#gone) return;
    this.#flush(true);
  }
  /** Leaving (offline, closing): others stop showing us until the next activity. */
  stop(): void {
    this.#clear();
    if (this.#idle !== null) this.#t.clearTimeout(this.#idle);
    this.#idle = null;
    this.#ghosts = [];
    this.#send(null);
    this.#active = false;
    this.#gone = true;
    this.#lastSent = "";
  }

  #state(): PresenceState {
    const activity = this.#active ? this.#activity : "Idle";
    return this.#ghosts.length ? { activity, ghosts: this.#ghosts } : { activity };
  }
  #schedule(every: number): void {
    const wait = this.#last + every - this.#t.now();
    if (wait <= 0) return this.#flush(false);
    if (this.#pending === null) this.#pending = this.#t.setTimeout(() => {
      this.#pending = null;
      this.#flush(false);
    }, wait);
  }
  #flush(force: boolean): void {
    this.#clear();
    const s = this.#state();
    const key = JSON.stringify(s);
    // an unchanged state goes again only as the 1 Hz heartbeat
    if (!force && key === this.#lastSent && this.#t.now() - this.#last < ACTIVE_MS) return;
    this.#last = this.#t.now();
    this.#lastSent = key;
    this.#send(s);
  }
  #clear(): void {
    if (this.#pending !== null) this.#t.clearTimeout(this.#pending);
    this.#pending = null;
  }
  #armIdle(): void {
    if (this.#idle !== null) this.#t.clearTimeout(this.#idle);
    this.#idle = this.#t.setTimeout(() => {
      this.#idle = null;
      this.#active = false;
      this.#ghosts = [];
      this.#flush(true); // "Idle", once
    }, IDLE_MS);
  }
}
