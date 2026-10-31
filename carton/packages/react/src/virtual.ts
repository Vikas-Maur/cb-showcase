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
  /** New rows arrive at the top (History is newest first): keep the reader's place when they do. */
  newestFirst?: boolean;
  className?: string;
  label: string;
  /** Viewport height before it can be measured (server render, tests). */
  initialHeight?: number;
  activeId?: (index: number) => string;
}

export function VirtualList(p: VirtualListProps) {
  const overscan = p.overscan ?? 6;
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(p.initialHeight ?? 400);
  const [range, setRange] = useState<[number, number]>(() => windowRange(0, p.initialHeight ?? 400, p.rowHeight, p.count, overscan));
  const top = useRef(0);

  const recompute = useCallback(() => {
    const el = ref.current;
    const st = el ? el.scrollTop : top.current;
    top.current = st;
    const next = windowRange(st, el?.clientHeight || viewport, p.rowHeight, p.count, overscan);
    setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
  }, [viewport, p.rowHeight, p.count, overscan]);

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
    const y = p.active * p.rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + p.rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + p.rowHeight - el.clientHeight;
  }, [p.active, p.rowHeight]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
          style: { position: "absolute", top: 0, left: 0, right: 0, height: p.rowHeight, transform: `translateY(${i * p.rowHeight}px)` },
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
      onScroll: recompute,
      onKeyDown,
      // Layout and paint containment: row changes never relayout the panel around the list.
      style: { position: "relative", overflowY: "auto", contain: "content" },
    },
    h("div", { style: { position: "relative", height: p.count * p.rowHeight, width: "100%" } }, rows),
  );
}
