// A fixed-row-height virtual list. History can hold 10k+ versions (every save batch and every Director turn is one,
// §0.1), so only the rows on screen plus a small overscan exist in the DOM, and scrolling re-renders only when the
// first visible row changes, not on every scroll event.

import {
  createElement as h,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  /** One row opened to `extra` px more than the others (a version's list of changes, UI audit P1-5). */
  expanded?: { index: number; extra: number } | null;
}

export function VirtualList(p: VirtualListProps) {
  const overscan = p.overscan ?? 6;
  // The rows after an expanded one move down by its extra height; everything else is the fixed-height layout.
  const ex = p.expanded && p.expanded.index >= 0 && p.expanded.index < p.count && p.expanded.extra > 0 ? p.expanded : null;
  const topOf = (i: number) => i * p.rowHeight + (ex && i > ex.index ? ex.extra : 0);
  const heightOf = (i: number) => p.rowHeight + (ex && i === ex.index ? ex.extra : 0);
  // a scroll position in the fixed layout: past the expanded row, its extra height is taken off
  const fixedTop = (st: number) => (!ex || st < (ex.index + 1) * p.rowHeight ? st : Math.max(ex.index * p.rowHeight, st - ex.extra));
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(p.initialHeight ?? 400);
  const [range, setRange] = useState<[number, number]>(() => windowRange(0, p.initialHeight ?? 400, p.rowHeight, p.count, overscan));
  const top = useRef(0);

  const recompute = useCallback(() => {
    const el = ref.current;
    const st = el ? el.scrollTop : top.current;
    top.current = st;
    const next = windowRange(fixedTop(st), el?.clientHeight || viewport, p.rowHeight, p.count, overscan);
    setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
  }, [viewport, p.rowHeight, p.count, overscan, ex?.index, ex?.extra]);

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
    if (el && p.newestFirst && added > 0 && el.scrollTop > 0) el.scrollTop += added * p.rowHeight;
  }, [p.count, p.newestFirst, p.rowHeight]);

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

  // Scroll the active row into view (keyboard navigation).
  useEffect(() => {
    const el = ref.current;
    if (!el || p.active == null || p.active < 0) return;
    const y = topOf(p.active), hh = heightOf(p.active);
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + hh > el.scrollTop + el.clientHeight) el.scrollTop = Math.min(y, y + hh - el.clientHeight);
  }, [p.active, p.rowHeight, ex?.index, ex?.extra]);

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
          style: { position: "absolute", top: 0, left: 0, right: 0, height: heightOf(i), transform: `translateY(${topOf(i)}px)` },
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
    h("div", { style: { position: "relative", height: p.count * p.rowHeight + (ex?.extra ?? 0), width: "100%" } }, rows),
  );
}
