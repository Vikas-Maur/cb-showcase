// A virtual list. History can hold 10k+ versions (every save batch and every Director turn is one, §0.1), so only the
// rows on screen plus a small overscan exist in the DOM, and scrolling re-renders only when the first visible row
// changes, not on every scroll event. Rows are one height, or (`heightOf`) each its own: History's day headers are
// shorter than its versions (UI audit P2-17). Then each row's top is a prefix sum, built once per layout, and the
// window is found by binary search.

import {
  createElement as h,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** The half-open range of rows to render for a scroll position. Pure, for tests. */
export function windowRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan: number): [number, number] {
  if (count <= 0 || rowHeight <= 0) return [0, 0];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visible = Math.ceil(Math.max(viewport, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return [Math.min(start, end), end];
}

/** Each row's top (and, at [count], the total height), for rows of their own heights. */
export function rowTops(count: number, heightOf: (i: number) => number): Float64Array {
  const tops = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) tops[i + 1] = tops[i]! + heightOf(i);
  return tops;
}
/** The row at a height: the last whose top is at or above it. */
export function rowAt(tops: Float64Array, count: number, y: number): number {
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}
/** windowRange for rows of their own heights. Pure, for tests. */
export function windowRangeOf(scrollTop: number, viewport: number, tops: Float64Array, count: number, overscan: number): [number, number] {
  if (count <= 0) return [0, 0];
  const first = rowAt(tops, count, scrollTop);
  const last = rowAt(tops, count, scrollTop + Math.max(1, viewport));
  return [Math.max(0, first - overscan), Math.min(count, last + 1 + overscan)];
}

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  /** Rows rendered above and below the viewport. */
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  /** Stable key per row, so rows keep their state when versions arrive above them. */
  rowKey: (index: number) => string;
  /** Index of the active row (keyboard), kept in view. */
  active?: number;
  onActiveChange?: (index: number) => void;
  /** Enter on the active row. */
  onActivate?: (index: number) => void;
  /** The context-menu key or Shift+F10 on the active row: its actions, for keyboard users. */
  onMenu?: (index: number) => void;
  /** New rows arrive at the top (History is newest first): keep the reader's place when they do. */
  newestFirst?: boolean;
  className?: string;
  label: string;
  /** Viewport height before it can be measured (server render, tests). */
  initialHeight?: number;
  activeId?: (index: number) => string;
  /** Rows of their own heights (default: all `rowHeight`). Read once per `layoutKey`, so keep it cheap. */
  heightOf?: (index: number) => number;
  /** Changes when any row's height or place changes (a day collapsed): the tops are rebuilt then, and only then. */
  layoutKey?: unknown;
  /** The list scrolled away from its top, or back to it (a divider under the header: UI audit P3-9). */
  onScrolledChange?: (scrolled: boolean) => void;
  /** One row opened to `extra` px more than the others (a version's list of changes, UI audit P1-5). */
  expanded?: { index: number; extra: number } | null;
}

export function VirtualList(p: VirtualListProps) {
  const overscan = p.overscan ?? 6;
  // The rows after an expanded one move down by its extra height; everything else is the fixed-height layout.
  // One row opened taller (a version's changes, P1-5) is one more row of its own height: rows of their own heights
  // (P2-17's day headers) and the opened row share one layout, the tops below.
  const ex = p.expanded && p.expanded.index >= 0 && p.expanded.index < p.count && p.expanded.extra > 0 ? p.expanded : null;
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(p.initialHeight ?? 400);
  const variable = !!p.heightOf || !!ex;
  const heightOfRef = useRef(p.heightOf);
  heightOfRef.current = p.heightOf;
  const tops = useMemo(
    () => (variable ? rowTops(p.count, (i) => (heightOfRef.current ? heightOfRef.current(i) : p.rowHeight) + (ex && i === ex.index ? ex.extra : 0)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variable, p.count, p.layoutKey, p.rowHeight, ex?.index, ex?.extra],
  );
  const topOf = (i: number) => (tops ? tops[i]! : i * p.rowHeight);
  const heightAt = (i: number) => (tops ? tops[i + 1]! - tops[i]! : p.rowHeight);
  const total = tops ? tops[p.count]! : p.count * p.rowHeight;
  const rangeOf = (st: number, vp: number) => (tops ? windowRangeOf(st, vp, tops, p.count, overscan) : windowRange(st, vp, p.rowHeight, p.count, overscan));
  const [range, setRange] = useState<[number, number]>(() => rangeOf(0, p.initialHeight ?? 400));
  const top = useRef(0);
  // The row at the top of the view and how far into it: kept through a layout change (a day collapsed, versions
  // arriving above), so the reader stays where they are.
  const anchor = useRef<{ key: string; into: number } | null>(null);
  const rowKeyRef = useRef(p.rowKey);
  rowKeyRef.current = p.rowKey;
  const scrolled = useRef(false);
  const onScrolledChange = useRef(p.onScrolledChange);
  onScrolledChange.current = p.onScrolledChange;

  const recompute = useCallback(() => {
    const el = ref.current;
    const st = el ? el.scrollTop : top.current;
    top.current = st;
    const next = rangeOf(st, el?.clientHeight || viewport);
    if (tops && p.count > 0) {
      const i = rowAt(tops, p.count, st);
      anchor.current = st > 0 ? { key: rowKeyRef.current(i), into: st - tops[i]! } : null;
    }
    if (st > 0 !== scrolled.current) {
      scrolled.current = st > 0;
      onScrolledChange.current?.(scrolled.current);
    }
    setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, p.rowHeight, p.count, overscan, tops]);

  // A scroll's new rows are rendered in a task after the frame (as React's scheduler does for scroll), never inside
  // it: preact/compat renders state set in a scroll handler at once, which put a whole window of row mounts on the
  // frame's critical path (U3). A MessageChannel task isn't clamped like setTimeout (Windows: ~15.6 ms). Scrolls in one
  // frame coalesce into one update; the overscan rows cover the frame in between.
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;
  const scrollTask = useRef<{ port: MessagePort; queued: boolean } | null>(null);
  useEffect(() => {
    if (typeof MessageChannel === "undefined") return;
    const ch = new MessageChannel();
    const task = { port: ch.port2, queued: false };
    ch.port1.onmessage = () => {
      task.queued = false;
      recomputeRef.current();
    };
    scrollTask.current = task;
    return () => {
      scrollTask.current = null;
      ch.port1.onmessage = null;
      ch.port1.close();
      ch.port2.close();
    };
  }, []);
  const onScroll = useCallback(() => {
    const task = scrollTask.current;
    if (!task) return recomputeRef.current();
    if (task.queued) return;
    task.queued = true;
    task.port.postMessage(0);
  }, []);

  // Keep the reader's place when newer versions arrive above: shift the scroll by the rows added, unless the reader
  // is at the very top (then they see the new row arrive, as in a chat).
  const lastCount = useRef(p.count);
  useLayoutEffect(() => {
    const el = ref.current;
    const added = p.count - lastCount.current;
    lastCount.current = p.count;
    if (tops) {
      // Rows of their own heights: find the row that was at the top, wherever the change put it.
      const a = anchor.current;
      if (!el || !a || el.scrollTop <= 0) return;
      for (let i = 0; i < p.count; i++) {
        if (rowKeyRef.current(i) !== a.key) continue;
        const y = tops[i]! + a.into;
        if (Math.abs(y - el.scrollTop) >= 1) el.scrollTop = y;
        break;
      }
      return;
    }
    if (el && p.newestFirst && added > 0 && el.scrollTop > 0) el.scrollTop += added * p.rowHeight;
  }, [p.count, p.newestFirst, p.rowHeight, tops]);

  useLayoutEffect(recompute, [recompute]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport((v) => (el.clientHeight && el.clientHeight !== v ? el.clientHeight : v));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll the active row into view when it becomes the active one (keyboard navigation), never because rows arrived or
  // moved around it (regress 2026-11-02: a version arriving shifts the active row's index and the layout, and a reader
  // who had picked a row and scrolled away from it, into an older day, was pulled back to it). Told by its key: a row
  // hidden meanwhile (its day folded) and shown again is the same row, and doesn't pull either.
  const shownActive = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || p.active == null || p.active < 0 || p.active >= p.count) return;
    const key = rowKeyRef.current(p.active);
    if (key === shownActive.current) return;
    shownActive.current = key;
    const y = topOf(p.active), rh = heightAt(p.active);
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rh > el.scrollTop + el.clientHeight) el.scrollTop = Math.min(y, y + rh - el.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.active, p.rowHeight, tops]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a field inside a row (naming a version) belong to the field, not to the list.
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "BUTTON" || t.isContentEditable)) return;
    if (!p.onActiveChange || !p.count) return;
    const page = Math.max(1, Math.floor(viewport / p.rowHeight) - 1);
    const cur = p.active ?? -1;
    let next = cur;
    if (e.key === "ArrowDown") next = Math.min(p.count - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = p.count - 1;
    else if (e.key === "PageDown") next = Math.min(p.count - 1, cur + page);
    else if (e.key === "PageUp") next = Math.max(0, cur - page);
    else if (e.key === "Enter" && cur >= 0) {
      e.preventDefault();
      p.onActivate?.(cur);
      return;
    } else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && cur >= 0 && p.onMenu) {
      e.preventDefault();
      p.onMenu(cur);
      return;
    } else return;
    e.preventDefault();
    p.onActiveChange(next);
  };

  const rows: ReactNode[] = [];
  const [start, end] = [range[0], Math.min(range[1], p.count)];
  for (let i = start; i < end; i++) {
    rows.push(
      h(
        "div",
        {
          key: p.rowKey(i),
          className: "carton-vrow",
          style: { position: "absolute", top: 0, left: 0, right: 0, height: heightAt(i), transform: `translateY(${topOf(i)}px)` },
        },
        p.renderRow(i),
      ),
    );
  }
  return h(
    "div",
    {
      ref,
      className: p.className ? `carton-vlist ${p.className}` : "carton-vlist",
      role: "listbox",
      "aria-label": p.label,
      "aria-activedescendant": p.active != null && p.active >= 0 && p.activeId ? p.activeId(p.active) : undefined,
      tabIndex: 0,
      onScroll,
      onKeyDown,
      // Layout and paint containment: row changes never relayout the panel around the list.
      style: { position: "relative", overflowY: "auto", contain: "content" },
    },
    h("div", { style: { position: "relative", height: total, width: "100%" } }, rows),
  );
}
