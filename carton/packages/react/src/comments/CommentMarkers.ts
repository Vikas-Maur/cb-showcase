// Comment markers over the host's timeline ruler: one per thread where it sits on the version shown (a bar for a
// range), "may be outdated" ones drawn so they read as such, markers closer than `groupPx` grouped with a count. The
// host positions the layer over its ruler and maps time to pixels; the layer is pointer-transparent except for the
// markers, so it never steals the editor's clicks. Removed, whole-version and (by default) resolved threads have no
// marker: the panel lists them.

import { createElement as h, memo, useMemo } from "react";
import type { CommentsUi, PlacementStatus, ThreadView } from "./model.ts";
import { useCommentThreads } from "./CommentsPanel.ts";
import { commentWords, type CommentWords } from "./words.ts";

export interface CommentMarkersProps {
  comments: CommentsUi;
  /** Timeline seconds to pixels in the layer's own box. */
  timeToX: (t: number) => number;
  /** Changes whenever `timeToX` does (zoom, scroll), so markers are laid out again. */
  layoutKey?: unknown;
  selected?: string | null;
  onSelect?: (threadId: string) => void;
  showResolved?: boolean;
  /** Markers closer than this many pixels are one marker with a count (default 10). */
  groupPx?: number;
  words?: Partial<CommentWords>;
  className?: string;
}

interface Group {
  key: string;
  x0: number;
  x1: number;
  ids: string[];
  status: PlacementStatus;
  range: readonly [number, number];
  resolved: boolean;
}

/** "May be outdated" wins over "moved" over "exact" in a group: the marker shows the least certain. */
const RANK: Record<PlacementStatus, number> = { exact: 0, general: 0, moved: 1, outdated: 2, removed: 3 };

export function markerGroups(threads: readonly ThreadView[], timeToX: (t: number) => number, groupPx: number, showResolved: boolean): Group[] {
  const placed: { t: ThreadView; x0: number; x1: number }[] = [];
  for (const t of threads) {
    const p = t.placement;
    if (!p?.range || p.status === "removed" || p.status === "general" || (t.resolved && !showResolved)) continue;
    const x0 = timeToX(p.range[0]),
      x1 = timeToX(p.range[1]);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    placed.push({ t, x0, x1: Math.max(x0, x1) });
  }
  placed.sort((a, b) => a.x0 - b.x0 || (a.t.id < b.t.id ? -1 : 1));
  const out: Group[] = [];
  for (const { t, x0, x1 } of placed) {
    const g = out[out.length - 1];
    const p = t.placement!;
    if (g && x0 - g.x0 < groupPx) {
      g.ids.push(t.id);
      g.x1 = Math.max(g.x1, x1);
      if (RANK[p.status] > RANK[g.status]) g.status = p.status;
      g.resolved &&= !!t.resolved;
      continue;
    }
    out.push({ key: t.id, x0, x1, ids: [t.id], status: p.status, range: p.range!, resolved: !!t.resolved });
  }
  return out;
}

const Marker = memo(function Marker({ g, selected, onSelect, w }: { g: Group; selected: string | null; onSelect: ((id: string) => void) | undefined; w: CommentWords }) {
  const at = w.at(g.range);
  const width = Math.max(0, g.x1 - g.x0);
  return h(
    "button",
    {
      type: "button",
      className: "carton-comment-marker",
      "data-status": g.status,
      "data-selected": selected ? "" : undefined,
      "data-resolved": g.resolved ? "" : undefined,
      "data-range": width >= 3 ? "" : undefined,
      "aria-label": w.marker(g.ids.length, at) + (g.status === "outdated" ? ` (${w.status.outdated})` : ""),
      "data-carton-tip": w.marker(g.ids.length, at),
      style: { transform: `translateX(${g.x0}px)`, ["--carton-marker-w" as string]: `${width}px` },
      // a group: each click selects its next thread
      onClick: onSelect ? () => onSelect(g.ids[(g.ids.indexOf(selected ?? "") + 1) % g.ids.length]!) : undefined,
    },
    g.ids.length > 1 ? h("span", { className: "carton-comment-marker-count" }, String(g.ids.length)) : null,
  );
});

export function CommentMarkers(p: CommentMarkersProps) {
  const w = useMemo(() => (p.words ? { ...commentWords, ...p.words } : commentWords), [p.words]);
  const threads = useCommentThreads(p.comments);
  const groups = useMemo(() => markerGroups(threads, p.timeToX, p.groupPx ?? 10, !!p.showResolved), [threads, p.layoutKey ?? p.timeToX, p.groupPx, p.showResolved]);
  return h(
    "div",
    { className: "carton-comment-markers" + (p.className ? ` ${p.className}` : ""), role: "group", "aria-label": w.markers },
    groups.map((g) => h(Marker, { key: g.key, g, selected: p.selected && g.ids.includes(p.selected) ? p.selected : null, onSelect: p.onSelect, w })),
  );
}
