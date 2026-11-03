// Hold a row to peek (docs/carton-ux/v2 DESIGN-V2 §2.4): press and hold a History row (300 ms, the pointer still), or
// hold V while it has focus, and the stage shows that version at the playhead's moment, paused. Release, and your edit
// is back. A click shorter than 300 ms opens the card, as before.
//
// It is viewing (DESIGN §4.2: the chip, the frame and the row's "Holding"), through `ui.view`, and back through
// `ui.view(null)`, viewing's own fast back (the editor's timeline at once, the head read after). The version is
// fetched ahead when the pointer has rested on a row for 150 ms (the host's `prefetch`: one at a time, the newest
// wins), so the hold shows at once. One listener set on the list, not one per row: rows stay as they were.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { CartonUi, Version } from "../model.ts";

/** How long a press must be held to peek (ms). */
export const PEEK_HOLD_MS = 300;
/** How long the pointer rests on a row before its version is fetched ahead (ms). */
export const PEEK_PREFETCH_MS = 150;
/** A press that moves further than this (px) is a drag or a scroll, not a hold. */
const SLOP = 5;
const TIMERS = { setTimeout: ((f: () => void, ms: number) => setTimeout(f, ms)) as typeof setTimeout, clearTimeout: ((h: ReturnType<typeof setTimeout>) => clearTimeout(h)) as typeof clearTimeout };

export interface PeekOptions {
  ui: CartonUi;
  /** The version a row element stands for, if it can be peeked (confirmed, not empty, not your edit now). */
  versionOf: (row: HTMLElement) => Version | undefined;
  /** Load a version ahead (the host's PlayHost.prefetch). */
  prefetch?: (ref: string) => void;
  /** Said once a peek shows ("Showing … Release to go back."). */
  announce?: (v: Version) => void;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

const rowOf = (t: EventTarget | null): HTMLElement | null => {
  const el = t instanceof Element ? t : null;
  if (!el || el.closest("button, input, textarea, a, [role=menu]")) return null;
  return el.closest<HTMLElement>(".carton-version[role=option]");
};

/** The list's handlers for hold-to-peek and its prefetch, and the row held (its version id), for the row's "Holding". */
export function usePeek(o: PeekOptions) {
  const opts = useRef(o);
  opts.current = o;
  const [holding, setHolding] = useState<string | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const shown = useRef<Version | null>(null);
  const swallow = useRef(false);
  const hover = useRef<{ row: HTMLElement; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const fetched = useRef<string | null>(null);
  // (the window's own timers, called as functions: through an object they throw "Illegal invocation")
  const t = () => opts.current.clock ?? TIMERS;

  const start = useCallback((v: Version) => {
    if (shown.current) return;
    shown.current = v;
    setHolding(v.id);
    opts.current.announce?.(v);
    void opts.current.ui.view({ kind: "version", versionId: v.id }).catch(() => {
      if (shown.current === v) {
        shown.current = null;
        setHolding(null);
      }
    });
  }, []);
  const end = useCallback(() => {
    if (press.current) t().clearTimeout(press.current.timer);
    press.current = null;
    const v = shown.current;
    if (!v) return false;
    shown.current = null;
    setHolding(null);
    void opts.current.ui.view(null).catch(() => {});
    return true;
  }, []);
  // a peek, and a prefetch waiting on a resting pointer, never outlive the panel
  useEffect(
    () => () => {
      if (hover.current?.timer) t().clearTimeout(hover.current.timer);
      hover.current = null;
      end();
    },
    [end],
  );

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = rowOf(e.target);
    const v = row ? opts.current.versionOf(row) : undefined;
    if (!v) return;
    if (press.current) t().clearTimeout(press.current.timer);
    press.current = { x: e.clientX, y: e.clientY, timer: t().setTimeout(() => ((press.current = null), start(v)), PEEK_HOLD_MS) };
  }, [start]);
  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) {
      t().clearTimeout(p.timer);
      press.current = null;
    }
  }, []);
  const onPointerUp = useCallback(() => {
    // the click that follows a peek's release opens nothing
    if (end()) swallow.current = true;
  }, [end]);
  // a cancelled press (the system took the pointer) ends a peek too, but no click follows it to swallow
  const onPointerCancel = useCallback(() => void end(), [end]);
  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!swallow.current) return;
    swallow.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);
  // the version a resting pointer is on, fetched ahead (one at a time: a new row replaces the wait)
  const onPointerOver = useCallback((e: PointerEvent<HTMLElement>) => {
    const row = rowOf(e.target);
    if (!row || hover.current?.row === row) return;
    if (hover.current?.timer) t().clearTimeout(hover.current.timer);
    const h = { row, timer: null as ReturnType<typeof setTimeout> | null };
    h.timer = t().setTimeout(() => {
      h.timer = null;
      const v = opts.current.versionOf(row);
      if (v && fetched.current !== v.ref) {
        fetched.current = v.ref;
        opts.current.prefetch?.(v.ref);
      }
    }, PEEK_PREFETCH_MS);
    hover.current = h;
  }, []);
  const onPointerLeave = useCallback(() => {
    if (hover.current?.timer) t().clearTimeout(hover.current.timer);
    hover.current = null;
    end();
  }, [end]);
  // V held on a focused row (the list's own keydown gives the row); its release, anywhere in the panel
  const keyDown = useCallback((e: KeyboardEvent<HTMLElement>, v: Version | undefined): boolean => {
    if ((e.key !== "v" && e.key !== "V") || e.ctrlKey || e.metaKey || e.altKey || !v) return false;
    if (!e.repeat) start(v);
    return true;
  }, [start]);
  const keyUp = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === "v" || e.key === "V") && shown.current) end();
  }, [end]);

  return {
    holding,
    peeking: () => !!shown.current,
    end,
    keyDown,
    keyUp,
    list: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerOver, onPointerLeave, onClickCapture },
  };
}
