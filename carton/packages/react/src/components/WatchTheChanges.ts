// Watch the changes (§9 layer 3): the shot diff, aligned like a side-by-side text diff. Two strips, Before and After;
// matched shots sit in the same column, changed runs are marked on each side, and long unchanged runs fold into a
// chip. Play changes plays only the changes, with a second of context; the A/B toggle swaps Before and After at the
// same moment. What is shown is a read-only preview (R2-16), with "Return to current to edit".

import { createElement as h, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { duration } from "../format.ts";
import { useAsync, useCartonUi, useCurrentCut, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Shot, ShotDiff } from "../model.ts";
import { ChangesPlayer, type PlayerState, type Side } from "../player.ts";
import { columns, diffSummary, type Column } from "../shots.ts";
import { Button, cx } from "./ui.ts";
import { PreviewBanner } from "./status.ts";

export interface WatchTheChangesProps {
  /** Before and After refs. */
  a: string;
  b: string;
  /** Use this diff instead of asking the view model. */
  diff?: ShotDiff;
  /**
   * Draw the frame at `time` of `side` (the host's preview, rendering the read-only doc). Called on every animation
   * frame while playing, and on every seek, so keep it cheap.
   */
  onFrame?: (side: Side, time: number) => void;
  /** The host's preview element. Without one, a plain card names the shot on screen. */
  preview?: ReactNode;
  /** Seconds of context played before and after each change. */
  context?: number;
  /** Pixels per second in the strips. */
  scale?: number;
  onClose?: () => void;
  className?: string;
}

/** A column of the strip with its pixel box and the time each side covers there. */
export interface Box {
  readonly col: Column;
  readonly x: number;
  readonly w: number;
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
}

const MIN_SHOT = 22, MIN_CHANGE = 44, FOLD = 72;

function sideRange(shots: readonly Shot[], i0: number, i1: number): [number, number] {
  if (i0 < i1) return [shots[i0]!.start, shots[i1 - 1]!.end];
  const t = i0 < shots.length ? shots[i0]!.start : shots.length ? shots[shots.length - 1]!.end : 0;
  return [t, t];
}

/** Lay the columns out left to right. Pure, for tests and for the playhead's time → x mapping. */
export function stripLayout(d: ShotDiff, cols: readonly Column[], scale: number): { boxes: Box[]; width: number } {
  const boxes: Box[] = [];
  let x = 0;
  for (const col of cols) {
    let a: [number, number], b: [number, number], w: number;
    if (col.kind === "same") {
      a = [d.a[col.a]!.start, d.a[col.a]!.end];
      b = [d.b[col.b]!.start, d.b[col.b]!.end];
      w = Math.max(MIN_SHOT, (a[1] - a[0]) * scale);
    } else if (col.kind === "fold") {
      a = sideRange(d.a, col.a0, col.a1);
      b = sideRange(d.b, col.b0, col.b1);
      w = FOLD;
    } else {
      a = sideRange(d.a, col.a0, col.a1);
      b = sideRange(d.b, col.b0, col.b1);
      w = Math.max(MIN_CHANGE, Math.max(a[1] - a[0], b[1] - b[0]) * scale);
    }
    boxes.push({ col, x, w, a, b });
    x += w;
  }
  return { boxes, width: x };
}

/** Where a time on one side sits on the strip (binary search over the boxes). */
export function xAt(boxes: readonly Box[], side: Side, t: number): number {
  if (!boxes.length) return 0;
  let lo = 0, hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boxes[mid]![side][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  // Skip zero-length boxes on this side (the empty half of a change) unless t sits exactly at their join.
  let b = boxes[lo]!;
  const [s, e] = b[side];
  if (e - s <= 0) return b.x;
  if (t > e && lo < boxes.length - 1) b = boxes[lo + 1]!;
  const [s2, e2] = b[side];
  const k = e2 - s2 > 0 ? Math.min(1, Math.max(0, (t - s2) / (e2 - s2))) : 0;
  // In a change column the shorter side's shots fill only part of the width (like blank lines in a text diff).
  const used = b.col.kind === "change" ? Math.max(1e-9, (e2 - s2) / Math.max(b.a[1] - b.a[0], b.b[1] - b.b[0])) : 1;
  return b.x + k * b.w * used;
}

function ShotCells({ shots, i0, i1, from, span, w }: { shots: readonly Shot[]; i0: number; i1: number; from: number; span: number; w: number }) {
  const out: ReactNode[] = [];
  for (let i = i0; i < i1; i++) {
    const s = shots[i]!;
    const left = span > 0 ? ((s.start - from) / span) * w : 0;
    const width = span > 0 ? ((s.end - s.start) / span) * w : w;
    out.push(
      h(
        "span",
        {
          key: i,
          className: "carton-shot",
          style: { left, width, ["--carton-shot-hue" as string]: (s.sig * 47) % 360, backgroundImage: s.thumb ? `url(${s.thumb})` : undefined },
          title: s.label ? `${s.label} · ${duration(s.end - s.start)}` : duration(s.end - s.start),
        },
        s.label && width > 54 ? h("span", { className: "carton-shot-label" }, s.label) : null,
      ),
    );
  }
  return out;
}

function Strip({ d, boxes, side, onSeek, onExpand, label }: { d: ShotDiff; boxes: readonly Box[]; side: Side; onSeek: (side: Side, t: number) => void; onExpand: (a0: number) => void; label: string }) {
  const words = useWords();
  const shots = side === "a" ? d.a : d.b;
  return h(
    "div",
    { className: "carton-strip", "data-side": side, role: "group", "aria-label": label },
    ...boxes.map((bx, k) => {
      const c = bx.col;
      const [t0, t1] = bx[side];
      if (c.kind === "fold")
        return h(
          "button",
          { key: k, type: "button", className: "carton-strip-col", "data-kind": "fold", style: { width: bx.w }, onClick: () => onExpand(c.row), "aria-label": words.unchangedShots(c.a1 - c.a0) },
          side === "a" ? h("span", { className: "carton-fold-chip" }, words.unchangedShots(c.a1 - c.a0)) : h("span", { className: "carton-fold-chip", "aria-hidden": true }, "⋯"),
        );
      const i0 = c.kind === "same" ? (side === "a" ? c.a : c.b) : side === "a" ? c.a0 : c.b0;
      const i1 = c.kind === "same" ? i0 + 1 : side === "a" ? c.a1 : c.b1;
      const span = c.kind === "change" ? Math.max(bx.a[1] - bx.a[0], bx.b[1] - bx.b[0]) : t1 - t0;
      const empty = c.kind === "change" && i1 === i0;
      const otherEmpty = c.kind === "change" && (side === "a" ? c.b1 === c.b0 : c.a1 === c.a0);
      const tone = c.kind !== "change" ? undefined : empty ? "empty" : otherEmpty ? (side === "a" ? "removed" : "added") : "changed";
      return h(
        "div",
        {
          key: k,
          className: "carton-strip-col",
          "data-kind": c.kind,
          "data-tone": tone,
          style: { width: bx.w },
          onClick: (e: MouseEvent<HTMLDivElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            const k2 = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
            onSeek(side, t0 + Math.min(1, Math.max(0, k2)) * Math.max(0, span));
          },
        },
        empty
          ? h("span", { className: "carton-strip-empty" }, side === "a" ? words.added : words.removed)
          : ShotCells({ shots, i0, i1, from: t0, span, w: bx.w }),
      );
    }),
  );
}

function Player({ diff, props }: { diff: ShotDiff; props: WatchTheChangesProps }) {
  const ui = useCartonUi();
  const words = useWords();
  const current = useCurrentCut();
  const scale = props.scale ?? 24;
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const player = useMemo(() => new ChangesPlayer(diff, { context: props.context }), [diff, props.context]);
  const [st, setSt] = useState<PlayerState>(player.state);
  const head = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const onFrame = useRef(props.onFrame);
  onFrame.current = props.onFrame;

  const cols = useMemo(() => columns(player.rows, 1, expanded), [player, expanded]);
  const layout = useMemo(() => stripLayout(diff, cols, scale), [diff, cols, scale]);
  const summary = useMemo(() => diffSummary(diff, player.rows), [diff, player]);
  const boxesRef = useRef(layout.boxes);
  boxesRef.current = layout.boxes;

  // Per frame: move the playhead and the timecode by hand, call the host. No React state is touched here.
  useEffect(() => {
    const draw = (side: Side, t: number) => {
      const x = xAt(boxesRef.current, side, t);
      if (head.current) head.current.style.transform = `translateX(${x}px)`;
      if (clock.current) clock.current.textContent = duration(t);
      onFrame.current?.(side, t);
    };
    const offFrame = player.onFrame(draw);
    const offState = player.onState(setSt);
    draw(player.state.side, player.time);
    return () => {
      offFrame();
      offState();
      player.dispose();
    };
  }, [player]);

  // Redraw the playhead when the layout changes (a fold opened).
  useEffect(() => {
    const x = xAt(layout.boxes, player.state.side, player.time);
    if (head.current) head.current.style.transform = `translateX(${x}px)`;
  }, [layout, player]);

  // The side on screen is a read-only preview, unless it is the current head (§9, R2-16).
  const shownRef = st.side === "a" ? props.a : props.b;
  const shownLabel = st.side === "a" ? diff.aLabel : diff.bLabel;
  useEffect(() => {
    if (current && shownRef === current.head) return;
    ui.openPreview(shownRef, shownLabel);
  }, [ui, shownRef, shownLabel, current?.head]);
  useEffect(() => () => ui.openPreview(null), [ui]);

  const n = player.changeRows.length;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    if (e.key === " ") {
      e.preventDefault();
      player.toggle();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      player.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      player.previous();
    }
  };

  return h(
    "section",
    { className: cx("carton-watch", props.className), "aria-label": words.watchTheChanges, onKeyDown, tabIndex: -1 },
    h(PreviewBanner, null),
    h(
      "header",
      { className: "carton-watch-head" },
      h("h3", { className: "carton-card-title" }, words.watchTheChanges),
      h("span", { className: "carton-watch-summary" }, words.differ(summary.shots, summary.seconds, summary.total)),
      props.onClose ? h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: props.onClose }) : null,
    ),
    h(
      "div",
      { className: "carton-watch-stage" },
      props.preview ?? h(StagePlaceholder, { diff, side: st.side, player }),
    ),
    n === 0
      ? h("p", { className: "carton-empty" }, words.noChanges)
      : h(
          "div",
          { className: "carton-watch-controls" },
          h(Button, { variant: "ghost", icon: "previous", label: words.previousChange, title: words.previousChange, disabled: st.change <= 0, onClick: () => player.previous() }),
          h(Button, { variant: "primary", icon: st.playing ? "pause" : "play", onClick: () => player.toggle(), className: "carton-watch-play" }, st.playing ? words.pause : words.playChanges),
          h(Button, { variant: "ghost", icon: "next", label: words.nextChange, title: words.nextChange, disabled: st.change >= n - 1, onClick: () => player.next() }),
          h("span", { className: "carton-watch-count", "aria-live": "polite" }, words.changeOf(Math.max(1, st.change + 1), n)),
          h("span", { ref: clock, className: "carton-watch-clock" }, duration(player.time)),
          h(
            "div",
            { className: "carton-segmented carton-ab", role: "radiogroup", "aria-label": `${words.before} / ${words.after}` },
            ...(["a", "b"] as const).map((s) =>
              h("button", { key: s, type: "button", role: "radio", "aria-checked": st.side === s, className: "carton-segment", onClick: () => player.setSide(s) }, s === "a" ? words.before : words.after),
            ),
          ),
        ),
    h(
      "div",
      { className: "carton-strips" },
      h(
        "div",
        { className: "carton-strip-labels", "aria-hidden": true },
        h("span", { "data-active": st.side === "a" ? "" : undefined }, words.before),
        h("span", { "data-active": st.side === "b" ? "" : undefined }, words.after),
      ),
      h(
        "div",
        { className: "carton-strip-scroll" },
        h(
          "div",
          { className: "carton-strip-track", style: { width: layout.width } },
          h(Strip, { d: diff, boxes: layout.boxes, side: "a", label: words.before, onSeek: (s, t) => player.seek(t, s), onExpand: (row) => setExpanded((e) => new Set(e).add(row)) }),
          h(Strip, { d: diff, boxes: layout.boxes, side: "b", label: words.after, onSeek: (s, t) => player.seek(t, s), onExpand: (row) => setExpanded((e) => new Set(e).add(row)) }),
          h("div", { ref: head, className: "carton-playhead", "data-side": st.side, "aria-hidden": true }),
        ),
      ),
    ),
  );
}

/** Without a host preview: the shot on screen by name, its side, and its colour. Re-renders per shot, not per frame. */
function StagePlaceholder({ diff, side, player }: { diff: ShotDiff; side: Side; player: ChangesPlayer }) {
  const words = useWords();
  const [shot, setShot] = useState<Shot | null>(null);
  useEffect(() => {
    let last: Shot | null = null;
    const find = (s: Side, t: number) => {
      const list = s === "a" ? diff.a : diff.b;
      let lo = 0, hi = list.length - 1, hit: Shot | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const x = list[mid]!;
        if (t < x.start) hi = mid - 1;
        else if (t >= x.end) lo = mid + 1;
        else {
          hit = x;
          break;
        }
      }
      if (hit !== last) setShot((last = hit));
    };
    find(player.state.side, player.time);
    return player.onFrame(find);
  }, [diff, player]);
  return h(
    "div",
    { className: "carton-stage", "data-side": side, style: { ["--carton-shot-hue" as string]: shot ? (shot.sig * 47) % 360 : 0 } },
    h("span", { className: "carton-stage-side" }, side === "a" ? words.before : words.after),
    h("span", { className: "carton-stage-shot" }, shot?.label ?? "—"),
  );
}

export function WatchTheChanges(props: WatchTheChangesProps) {
  const ui = useCartonUi();
  const words = useWords();
  const loaded = useAsync(() => (props.diff ? Promise.resolve(props.diff) : ui.shotDiff(props.a, props.b)), [ui, props.a, props.b, props.diff]);
  if (loaded.status === "loading") return h("section", { className: cx("carton-watch", props.className) }, h("p", { className: "carton-muted" }, words.loading));
  if (loaded.status === "error") return h("section", { className: cx("carton-watch", props.className) }, h("p", { className: "carton-error", role: "alert" }, words.failed));
  return h(Player, { diff: loaded.value, props });
}
