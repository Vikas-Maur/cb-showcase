// A simple timeline, enough to edit live (not Cardboard's editor): tracks, clips and captions; drag a clip to move
// it, drag an edge to trim. While a drag is in flight only this replica redraws the clip, and teammates see it as a
// presence ghost (§5.1, §12: drags are live as ghosts, committed on release, L2). Clips are memoized by record:
// the engine keeps unchanged records as the same objects, so a remote edit redraws only the clips it touched.

import { createElement as h, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Doc, HeldBase, Op, Rec } from "@carton/core";
import { GhostLayer } from "@carton/react";
import { ITEMS, TRACKS, type SampleMedia } from "./demo-doc.ts";
import { docLength, movePlacement, moveOps, trimOps, trimPlacement } from "./edit.ts";
import type { PresenceSender } from "./presence.ts";

const HEAD_W = 132;
const EDGE = 7;
const rowHeight = (tr: Rec) => (tr.type === "caption" ? 40 : 64);

type Mode = "move" | "start" | "end";
interface Drag {
  id: string;
  mode: Mode;
  x0: number;
  rec: Rec;
  moved: boolean;
  /** The state the drag began on: its ops are computed from it, so it is the commit's base. */
  base: HeldBase | undefined;
}
interface Placement {
  id: string;
  start: number;
  end: number;
}

export interface TimelineProps {
  doc: Doc;
  media: Record<string, SampleMedia>;
  time: number;
  onSeek: (t: number) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Commit an edit made on `base`; resolves once the head shows it. */
  onEdit: (ops: Op[], base?: HeldBase) => Promise<void>;
  /** The state on screen, as a base for an edit begun now. */
  base: () => HeldBase | undefined;
  presence: PresenceSender | null;
  /** A read-only preview (§9 R2-16): an edit attempt is reported, never dropped silently. */
  readOnly: boolean;
  onBlocked: () => void;
  /** An object URL for a T1 image key, once loaded (the parent re-renders when one arrives). */
  image: (key: string) => string | undefined;
  /** Drawn over the ruler (comment markers), given seconds-to-pixels and what changes it. */
  rulerOverlay?: (timeToX: (t: number) => number, layoutKey: unknown) => ReactNode;
}

export function Timeline(p: TimelineProps) {
  const lanes = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [local, setLocal] = useState<Placement | null>(null);
  const drag = useRef<Drag | null>(null);
  useLayoutEffect(() => {
    const el = lanes.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tracks = (p.doc[TRACKS] ?? []) as Rec[];
  const items = (p.doc[ITEMS] ?? []) as Rec[];
  const length = Math.max(docLength(p.doc) + 2, 10);
  const pps = Math.max(24, (width - 16) / length);
  const bands = new Map<string, { top: number; height: number }>();
  let top = 0;
  for (const tr of tracks) {
    bands.set(String(tr.id), { top, height: rowHeight(tr) });
    top += rowHeight(tr);
  }

  const sourceLength = (rec: Rec) => p.media[String(rec.mediaItemId)]?.duration;
  const stripOf = (rec: Rec) => {
    const key = p.media[String(rec.mediaItemId)]?.filmstrip;
    return key ? p.image(key) : undefined;
  };
  const placement = (d: Drag, clientX: number): Placement => {
    const dt = (clientX - d.x0) / pps;
    const r = d.rec;
    if (d.mode === "move") {
      const m = movePlacement(r, (r.startTime as number) + dt);
      return { id: d.id, ...m };
    }
    const edgeT = (d.mode === "start" ? (r.startTime as number) : (r.endTime as number)) + dt;
    const t = trimPlacement(r, d.mode, edgeT, sourceLength(r));
    return { id: d.id, start: t.start, end: t.end };
  };

  const onDown = (e: PointerEvent, rec: Rec) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    p.onSelect(String(rec.id));
    if (p.readOnly) return p.onBlocked();
    const el = e.currentTarget as HTMLElement;
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left;
    const mode: Mode = x <= EDGE ? "start" : x >= box.width - EDGE ? "end" : "move";
    drag.current = { id: String(rec.id), mode, x0: e.clientX, rec, moved: false, base: p.base() };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const pl = placement(d, e.clientX);
    setLocal(pl);
    const label = String(d.rec.name ?? d.rec.captionText ?? d.id);
    p.presence?.drag([{ item: d.id, track: String(d.rec.trackId), start: pl.start, end: pl.end, label }]);
  };
  const onUp = async (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    p.presence?.endDrag();
    if (!d.moved) return setLocal(null);
    const pl = placement(d, e.clientX);
    const ops = d.mode === "move" ? moveOps(d.rec, pl.start) : trimOps(d.rec, d.mode, d.mode === "start" ? pl.start : pl.end, sourceLength(d.rec));
    try {
      if (ops.length) await p.onEdit(ops, d.base);
    } finally {
      setLocal(null);
    }
  };
  // a cancelled pointer (the window lost it) drops the drag and its ghost
  const onCancel = () => {
    drag.current = null;
    p.presence?.endDrag();
    setLocal(null);
  };

  const seekAt = (clientX: number) => {
    const el = lanes.current;
    if (!el) return;
    p.onSeek(Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / pps));
  };

  // one function per scale, so the markers lay out again only when it changes
  const timeToX = useMemo(() => (t: number) => t * pps, [pps]);
  const ticks: number[] = [];
  const step = pps < 40 ? 2 : 1;
  for (let s = 0; s <= length; s += step) ticks.push(s);

  return h(
    "div",
    { className: "cb-timeline", "data-testid": "timeline" },
    h(
      "div",
      { className: "cb-tl-ruler" },
      h("div", { className: "cb-tl-corner", style: { width: HEAD_W } }, formatTime(p.time)),
      h(
        "div",
        { className: "cb-tl-ticks", onPointerDown: (e: PointerEvent) => seekAt(e.clientX), "data-testid": "ruler" },
        ticks.map((s) => h("span", { key: s, className: "cb-tl-tick", style: { left: s * pps } }, s % (step * 2) === 0 ? `${s}s` : "")),
        p.rulerOverlay?.(timeToX, pps),
      ),
    ),
    h(
      "div",
      { className: "cb-tl-body" },
      h(
        "div",
        { className: "cb-tl-heads", style: { width: HEAD_W } },
        tracks.map((tr) => h("div", { key: String(tr.id), className: "cb-tl-head", style: { height: rowHeight(tr) }, "data-track": String(tr.id) }, h("span", { className: "cb-tl-head-icon", "aria-hidden": true }, tr.type === "caption" ? "T" : "▶"), h("span", null, String(tr.name ?? tr.id)))),
      ),
      h(
        "div",
        { className: "cb-tl-lanes", ref: lanes, onPointerDown: (e: PointerEvent) => (e.target === lanes.current || (e.target as HTMLElement).classList.contains("cb-tl-lane") ? (p.onSelect(null), seekAt(e.clientX)) : undefined) },
        tracks.map((tr) => h("div", { key: String(tr.id), className: "cb-tl-lane", style: { height: rowHeight(tr) }, "data-track": String(tr.id) })),
        items.map((rec) => {
          const band = bands.get(String(rec.trackId));
          if (!band) return null;
          const pl = local?.id === rec.id ? local : null;
          return h(Clip, {
            key: String(rec.id),
            rec,
            start: pl ? pl.start : (rec.startTime as number),
            end: pl ? pl.end : (rec.endTime as number),
            pps,
            band,
            selected: p.selected === rec.id,
            dragging: !!pl,
            strip: rec.type === "video" ? stripOf(rec) : undefined,
            onDown,
            onMove,
            onUp,
            onCancel,
          });
        }),
        h(GhostLayer, { timeToX, trackBand: (id: string) => bands.get(id) ?? null, layoutKey: pps, className: "cb-tl-ghosts" }),
        h("div", { className: "cb-tl-playhead", style: { transform: `translateX(${p.time * pps}px)`, height: top } }),
      ),
    ),
  );
}

interface ClipProps {
  rec: Rec;
  start: number;
  end: number;
  pps: number;
  band: { top: number; height: number };
  selected: boolean;
  dragging: boolean;
  /** The filmstrip's object URL. */
  strip: string | undefined;
  onDown: (e: PointerEvent, rec: Rec) => void;
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
  onCancel: () => void;
}

// A bench (bench/burst.ts) sets this object to count clip renders under live sync; otherwise it is absent.
const renders = () => (globalThis as { __cartonRenders?: { clip?: number } }).__cartonRenders;

const Clip = memo(function Clip(c: ClipProps) {
  const count = renders();
  if (count) count.clip = (count.clip ?? 0) + 1;
  const isCaption = c.rec.type === "caption";
  const label = isCaption ? String(c.rec.captionText ?? "") : String(c.rec.name ?? c.rec.id);
  const strip = c.strip;
  return h(
    "div",
    {
      className: `cb-clip ${isCaption ? "cb-clip-caption" : "cb-clip-video"}${c.selected ? " is-selected" : ""}${c.dragging ? " is-dragging" : ""}`,
      style: {
        transform: `translate(${c.start * c.pps}px, ${c.band.top + 3}px)`,
        width: Math.max(4, (c.end - c.start) * c.pps),
        height: c.band.height - 6,
        ...(strip ? { backgroundImage: `url(${strip})` } : {}),
        opacity: isCaption ? 1 : Math.max(0.35, (c.rec.opacity as number) ?? 1),
      },
      "data-clip-id": String(c.rec.id),
      "data-start": c.start.toFixed(1),
      "data-end": c.end.toFixed(1),
      role: "button",
      "aria-label": `${isCaption ? "Caption" : "Clip"} ${label}, ${formatTime(c.start)} to ${formatTime(c.end)}`,
      onPointerDown: (e: PointerEvent) => c.onDown(e, c.rec),
      onPointerMove: c.onMove,
      onPointerUp: c.onUp,
      onPointerCancel: c.onCancel,
    },
    h("span", { className: "cb-clip-edge cb-clip-edge-start" }),
    h("span", { className: "cb-clip-label" }, label),
    h("span", { className: "cb-clip-edge cb-clip-edge-end" }),
  );
});

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
