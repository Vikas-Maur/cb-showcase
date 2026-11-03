// Play and Before (DESIGN §5.3, PLAN 4.2–4.3): the one way a list of changes is played, for the Changes view and a
// version's card.
// - ▶ on a change plays its spot (a second either side); Play all plays every spot in order. The lit row is where you
//   are: no counter, no step buttons.
// - On the cut's newest version (the newer side is your edit), Play runs on your edit: nothing is viewed. On an older
//   one it views the newer side first: a spinner after 300 ms (CSS), and "Couldn't load this version. Try again." if it
//   can't, with the editor left on your edit.
// - Before: hold the button (or B while the list has focus) to view the older side at the same moment; release to
//   come back. A click latches it (keyboards, screen readers). The older side is loaded ahead when playing starts
//   (`host.prefetch`), so the flip doesn't wait for it.
// - Per frame, nothing goes through React: the player moves the lit row's progress line (ChangeRow's
//   setChangeProgress) and the change map's playhead (ChangeMap's moveMapPlayhead) by transform, and calls the host's
//   `onFrame` (Cardboard: the editor's playhead, ≤ 10 seeks a second). React hears
//   only which spot is lit and play/pause.
// - Play never selects a clip (Cardboard's own Esc would clear the selection first and swallow the person's Esc).

import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type MouseEvent } from "react";
import { useCartonUi, useTopic, useWords } from "../hooks.ts";
import type { Change, Viewing, ViewTarget } from "../model.ts";
import { SpanPlayer, playSteps, stepFor, type Clock, type SpanState, type StepOptions } from "../player.ts";
import { Button, cx } from "./ui.ts";
import { setChangeProgress } from "./ChangeRow.ts";
import { moveMapPlayhead } from "./ChangeMap.ts";

/** What a host gives Play: its player's playhead, a way to load a version ahead, and the edit's length. */
export interface PlayHost {
  /** Every frame while a spot plays: the time in the edit. Cardboard's editor playhead follows it (throttled there). */
  onFrame?: (t: number) => void;
  /** A click on a change row: the editor's playhead goes to its place, without playing. */
  seek?: (t: number) => void;
  /** Load a version's state ahead (Cardboard: the bridge keeps the checked-out document), so viewing it doesn't wait. */
  prefetch?: (ref: string) => void;
  /** Your edit's length in seconds, when the host knows it (the change map's scale, "7 changes · 0:38"). */
  length?: () => number | undefined;
  /** A clock for tests and benchmarks. */
  clock?: Clock;
}

/** A History version (or how it was before one) with the ref it shows, so Play can tell its own view from one somebody else opened. */
export type PlayTarget = Extract<ViewTarget, { kind: "version" | "before" }> & { readonly ref: string };

export interface PlayOptions {
  /** The rows, in the order shown. Null while they load. */
  changes: readonly Change[] | null;
  /** What Play shows: null is your edit (the newer side is the cut's newest version: nothing is viewed). */
  newer: PlayTarget | null;
  /** What Before shows (the older side), or null when there is none. */
  older: PlayTarget | null;
  /** The length of the side played, when known: no spot plays past its end. */
  length?: number;
  host?: PlayHost;
  steps?: StepOptions;
}

export type PlayStatus = "idle" | "loading" | "playing" | "paused" | "failed";

export interface Playback {
  readonly status: PlayStatus;
  /** Rows lit now (the spot playing or paused in). */
  readonly lit: ReadonlySet<number>;
  /** The row whose own ▶ started this play, or null (Play all). */
  readonly one: number | null;
  /** Why it couldn't play, in words ("Couldn't load this version. Try again."). */
  readonly error: string | null;
  /** A play session is on (playing, or paused partway): the map shows its playhead, the transport shows Before. */
  readonly active: boolean;
  playAll(): void;
  /** ▶ on a row: its spot; again while it plays: pause. */
  playRow(row: number): void;
  /** Play all / Pause / go on (Space). */
  toggle(): void;
  stop(): void;
  readonly before: BeforeControl;
  /** Put on the element holding the rows and the map: the per-frame writes look for them inside it. */
  readonly rootRef: (el: HTMLElement | null) => void;
}

export interface BeforeControl {
  /** The older side is on the stage. */
  readonly on: boolean;
  /** It stays on after the button is let go (a click). */
  readonly latched: boolean;
  /** The button is offered: while a session is on (or Before is still on). */
  readonly available: boolean;
  /** Hold (pointer or B key) starts; let go ends, unless it was a pointer click (shorter than HOLD_MS), which latches. */
  press(): void;
  /** `hold`: the B key, which only holds (a quick tap of it comes back, never latches). */
  release(opts?: { hold?: boolean }): void;
  /** A keyboard click (Enter or Space on the button): latch on or off. */
  toggle(): void;
  /** Focus left while held (a key up that never came): back. */
  cancel(): void;
}

/** A press shorter than this is a click: it latches Before instead of holding it. */
export const HOLD_MS = 250;

const matches = (v: Viewing | null, t: PlayTarget | null) =>
  t === null ? v === null : !!v && (v.ref === t.ref || (!!t.versionId && v.versionId === t.versionId && v.kind === t.kind));

/** Play and Before over a list of changes. See the file's head. */
export function usePlayChanges(o: PlayOptions): Playback {
  const ui = useCartonUi();
  const words = useWords();
  const host = useRef(o.host);
  host.current = o.host;
  const player = useMemo(() => new SpanPlayer(o.host?.clock ? { clock: o.host.clock } : {}), [o.host?.clock]);
  const [st, setSt] = useState<SpanState>(player.state);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [one, setOne] = useState<number | null>(null);
  const [bOn, setBOn] = useState(false);
  const [latched, setLatched] = useState(false);
  const opts = useRef(o);
  opts.current = o;
  const lengthRef = useRef(o.length ?? 0);
  lengthRef.current = o.length ?? 0;
  // A session's own id: an answer from a session given up meanwhile (stopped, or another Play) does nothing.
  const run = useRef(0);

  // ---------------------------------------------------------------- views, one at a time, the latest one wins
  // What Play last asked the stage to show; a viewing that matches none of Play's targets came from elsewhere (Esc,
  // a row's ✕, a conflict's See it).
  const wanted = useRef<{ target: PlayTarget | null } | null>(null);
  const queue = useRef<{ busy: boolean; next: { target: PlayTarget | null; done: (e?: unknown) => void } | null }>({ busy: false, next: null });
  const show = useCallback(
    (target: PlayTarget | null): Promise<void> =>
      new Promise((resolve, reject) => {
        wanted.current = { target };
        const q = queue.current;
        // A newer ask replaces one still waiting (a quick B, B, B flips once, to where it ends).
        q.next?.done();
        q.next = { target, done: (e?: unknown) => (e ? reject(e) : resolve()) };
        const pump = () => {
          if (q.busy || !q.next) return;
          const { target: t, done } = q.next;
          q.next = null;
          q.busy = true;
          (matches(ui.viewing(), t) ? Promise.resolve() : ui.view(t)).then(
            () => ((q.busy = false), done(), pump()),
            (e) => ((q.busy = false), done(e), pump()),
          );
        };
        pump();
      }),
    [ui],
  );

  // ---------------------------------------------------------------- the player's coarse state, and its frames
  useEffect(() => {
    const off = player.onState(setSt);
    return () => {
      off();
      player.dispose();
    };
  }, [player]);

  const lastTime = useRef<number | null>(null);
  const lastProgress = useRef(0);
  const root = useRef<HTMLElement | null>(null);
  // The rows being played (ChangeRow's data-playing) and the change map, found after each render, never per frame.
  const marks = useRef<{ rows: HTMLElement[]; map: HTMLElement | null }>({ rows: [], map: null });
  const rootRef = useCallback((el: HTMLElement | null) => {
    root.current = el;
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    marks.current = el ? { rows: [...el.querySelectorAll<HTMLElement>(".carton-change[data-playing]")], map: el.querySelector<HTMLElement>(".carton-map") } : { rows: [], map: null };
    const on = player.state.step >= 0;
    for (const r of marks.current.rows) setChangeProgress(r, on ? lastProgress.current : 0);
    moveMapPlayhead(marks.current.map, on ? lastTime.current : null);
  });
  useEffect(
    () =>
      player.onFrame((t, p) => {
        lastProgress.current = p;
        const m = marks.current;
        for (const r of m.rows) setChangeProgress(r, p);
        if (t === null) return;
        lastTime.current = t;
        moveMapPlayhead(m.map, t);
        host.current?.onFrame?.(t);
      }),
    [player],
  );

  // ---------------------------------------------------------------- Before
  const bOnRef = useRef(false);
  const latchedRef = useRef(false);
  const downAt = useRef(0);
  const unlatchOnUp = useRef(false);
  const setBefore = useCallback(
    (on: boolean, latch: boolean) => {
      latchedRef.current = on && latch;
      setLatched(on && latch);
      if (bOnRef.current === on) return;
      bOnRef.current = on;
      setBOn(on);
      const { older, newer } = opts.current;
      if (on && !older) return;
      show(on ? older : newer).catch(() => {
        // the older side couldn't be shown: say so, and the stage stays (or goes back) where Play had it
        if (!on) return;
        bOnRef.current = false;
        latchedRef.current = false;
        setBOn(false);
        setLatched(false);
        setError(words.loadFailed);
        void show(opts.current.newer).catch(() => {});
      });
    },
    [show, words],
  );
  const sessionOn = st.step >= 0 || loading;
  const available = !!o.older && (sessionOn || bOn);
  const availableRef = useRef(available);
  availableRef.current = available;
  const before: BeforeControl = useMemo(
    () => ({
      on: bOn,
      latched,
      available,
      press() {
        if (!availableRef.current) return;
        if (latchedRef.current) {
          unlatchOnUp.current = true;
          return;
        }
        unlatchOnUp.current = false;
        downAt.current = Date.now();
        setBefore(true, false);
      },
      release(opts) {
        if (unlatchOnUp.current) {
          unlatchOnUp.current = false;
          setBefore(false, false);
          return;
        }
        if (!bOnRef.current || latchedRef.current) return;
        if (!opts?.hold && Date.now() - downAt.current < HOLD_MS) setBefore(true, true);
        else setBefore(false, false);
      },
      toggle() {
        if (!availableRef.current && !bOnRef.current) return;
        setBefore(!latchedRef.current, true);
      },
      cancel() {
        unlatchOnUp.current = false;
        if (bOnRef.current && !latchedRef.current) setBefore(false, false);
      },
    }),
    [bOn, latched, available, setBefore],
  );

  // ---------------------------------------------------------------- Play
  const begin = useCallback(
    async (row: number | null) => {
      const { changes, newer, older, steps: so } = opts.current;
      if (!changes?.length) return;
      const steps = row == null ? playSteps(changes, { ...so, length: lengthRef.current || undefined }) : [stepFor(changes, row, { ...so, length: lengthRef.current || undefined })].filter((x) => x != null);
      const id = ++run.current;
      setError(null);
      setOne(row);
      // Before's side, loaded now, so holding Before later doesn't wait for it
      if (older) host.current?.prefetch?.(older.ref);
      if (bOnRef.current) setBefore(false, false);
      wanted.current = { target: newer };
      if (!matches(ui.viewing(), newer)) {
        setLoading(true);
        try {
          await show(newer);
        } catch {
          if (id !== run.current) return;
          setLoading(false);
          setError(words.loadFailed);
          return;
        }
        if (id !== run.current) return;
        setLoading(false);
      }
      player.start(steps);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ui, player, show, words],
  );

  const stop = useCallback(() => {
    run.current++;
    setLoading(false);
    player.stop();
  }, [player]);

  const playAll = useCallback(() => void begin(null), [begin]);
  const playRow = useCallback(
    (row: number) => {
      // the lit row's own button is the transport's: Pause, and on again
      const s = player.state;
      if (s.step >= 0 && (one === row || s.rows.includes(row))) return s.playing ? player.pause() : player.resume();
      void begin(row);
    },
    [player, begin, one],
  );
  const toggle = useCallback(() => {
    const s = player.state;
    if (loading) return;
    if (s.playing) player.pause();
    else if (s.step >= 0) player.resume();
    else void begin(null);
  }, [player, begin, loading]);

  // ---------------------------------------------------------------- somebody else changed the stage
  // Esc, a row's ✕, closing the panel or a conflict's See it while Play has the stage: what Play asked for no longer
  // shows. Back on the side Play plays (Esc while Before was on, on your edit), Before lets go and Play goes on;
  // anything else stops Play, so it never moves the playhead of something it didn't open.
  const viewing = useTopic("viewing", (u) => u.viewing());
  useEffect(() => {
    const w = wanted.current;
    if (!w || queue.current.busy || queue.current.next) return;
    if (matches(viewing, w.target)) return;
    const { newer } = opts.current;
    if (matches(viewing, newer)) {
      wanted.current = { target: newer };
      bOnRef.current = false;
      latchedRef.current = false;
      setBOn(false);
      setLatched(false);
      return;
    }
    wanted.current = null;
    bOnRef.current = false;
    latchedRef.current = false;
    setBOn(false);
    setLatched(false);
    stop();
  }, [viewing, stop]);

  // A session that ended with Before still held: the button stays until it is let go, then goes.
  // Leaving (the view closed, the card folded): Play stops, and Before, if on, lets go.
  useEffect(
    () => () => {
      run.current++;
      if (bOnRef.current) void show(opts.current.newer).catch(() => {});
    },
    [show],
  );

  const status: PlayStatus = error ? "failed" : loading ? "loading" : st.playing ? "playing" : st.step >= 0 ? "paused" : "idle";
  const lit = useMemo(() => new Set(st.rows), [st.rows]);
  return { status, lit, one: st.step >= 0 ? one : null, error, active: sessionOn, playAll, playRow, toggle, stop, before, rootRef };
}

/** Play all / Pause, with the spinner a load past 300 ms shows (CSS). */
export function PlayAllButton({ play, className }: { play: Playback; className?: string }) {
  const words = useWords();
  const playing = play.status === "playing";
  return h(
    "span",
    { className: cx("carton-play-all", className), "data-loading": play.status === "loading" ? "" : undefined },
    h(Button, { icon: playing ? "pause" : "play", onClick: play.toggle, keys: "Space", busy: play.status === "loading" }, playing ? words.pause : words.playAll),
    play.status === "loading" ? h("span", { className: "carton-spinner", role: "progressbar", "aria-label": words.loading }) : null,
  );
}

/**
 * Before: hold to see how it was, release to come back; a click latches it. The pointer is captured while held, so a
 * release anywhere counts; a lost capture or focus lets go.
 */
export function BeforeButton({ play, className }: { play: Playback; className?: string }) {
  const words = useWords();
  const b = play.before;
  if (!b.available) return null;
  return h(
    "button",
    {
      type: "button",
      className: cx("carton-before", className),
      "aria-pressed": b.on,
      "aria-keyshortcuts": "B",
      "data-carton-tip": words.beforeHint,
      "aria-description": words.beforeHint,
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        b.press();
      },
      onPointerUp: () => b.release(),
      onPointerCancel: () => b.cancel(),
      onLostPointerCapture: () => b.cancel(),
      onBlur: () => b.cancel(),
      // A click from the keyboard (Enter, Space) has no pointer: it latches. A pointer's click was handled above.
      onClick: (e: MouseEvent<HTMLButtonElement>) => {
        if (e.detail === 0) b.toggle();
      },
    },
    words.before,
  );
}

/**
 * The keys Play takes while its list has focus: Space plays or pauses, B (held) is Before. Returns true when it took
 * the key (stopped there: Cardboard's own Space and B never see it).
 */
export function playKeys(play: Playback, e: KeyboardEvent<HTMLElement>, up = false): boolean {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "b" || e.key === "B") {
    e.preventDefault();
    e.stopPropagation();
    if (up) play.before.release({ hold: true });
    else if (!e.repeat) play.before.press();
    return true;
  }
  if (up) return false;
  // a button's own Space presses it
  if (e.key === " " && t.tagName !== "BUTTON") {
    e.preventDefault();
    e.stopPropagation();
    play.toggle();
    return true;
  }
  return false;
}
