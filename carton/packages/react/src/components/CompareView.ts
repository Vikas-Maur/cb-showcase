// Compare in the editor (docs/carton-ux v2 DESIGN-V2 §1, N1): the parts a host puts on the stage, the timeline and the
// History panel while comparing. Presentational: the host (scripts/carton/compare.js in the app, the capture rig in
// the gallery) owns the comparison, the players and the editor.
// - CompareStageView: the compare bar (modes, count, Done comparing), the players in the chosen mode (Side by side,
//   Wipe, Flip), their labels, and Play both. The right side is the editor's own preview: this view leaves a hole
//   (`holeRef`) where it goes, and the host moves Cardboard's picture there. The left side is `player` (the second
//   player), or a slate.
// - CompareList: the History panel's change list (the range in words, the count, every change row, the footer).
// - CompareMarks, CompareStrip: the marks on Cardboard's own timeline clips and the other side's strip, placed from
//   the timeline's geometry (seconds × pixels per second, each track's row).

import { createElement as h, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { timecode } from "../format.ts";
import { useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Change } from "../model.ts";
import type { MarkKind, StripBar, TimelineMark } from "../compare.ts";
import type { CompareMode } from "../model.ts";
import { ChangeList, ChangeRow } from "./ChangeRow.ts";
import { Button, cx } from "./ui.ts";

/** One side as its label says it: "Sent to client · yesterday at 4:10 pm", "Your edit now", "30s Instagram cut · now · Leo". */
export interface CompareSideInfo {
  /** The bold part: "Sent to client", "Your edit now", "30s Instagram cut". */
  readonly title: string;
  /** After it: "yesterday at 4:10 pm", "now · Leo". */
  readonly detail?: string;
  /** The cut's mark before the title, across cuts: "main" (scissors) or a colour dot. */
  readonly cut?: { readonly main: boolean; readonly dot?: string | null };
  /** Where this side's player is, in its own time. */
  readonly at?: number;
  /** In step: "same shot" while matched; "waiting" while it holds for the other side. */
  readonly step?: "same" | "waiting" | null;
  /** A shot only the other side has: the slate's words. */
  readonly slate?: { readonly title: string; readonly body: string } | null;
}

// Stage widths (DESIGN-V2 §1.9): Side by side needs 682 px; under 600 the modes keep their icons only; under 360, Flip only.
export const SIDE_MIN = 682, COMPACT_UNDER = 600, FLIP_ONLY_UNDER = 360;

/** The modes the stage offers at a width, with a second player (`player`) or without (Flip only, §1.10). */
export function compareModesFor(width: number, player: boolean): { modes: readonly CompareMode[]; sideOff: boolean; compact: boolean } {
  if (!player || (width > 0 && width < FLIP_ONLY_UNDER)) return { modes: ["flip"], sideOff: false, compact: width > 0 && width < COMPACT_UNDER };
  return { modes: ["side", "wipe", "flip"], sideOff: width > 0 && width < SIDE_MIN, compact: width > 0 && width < COMPACT_UNDER };
}

/** The mode shown: the one picked, unless the width or the player rules it out (Side by side → Flip when narrow). */
export function compareModeShown(picked: CompareMode, o: { modes: readonly CompareMode[]; sideOff: boolean }): CompareMode {
  if (!o.modes.includes(picked)) return "flip";
  if (picked === "side" && o.sideOff) return "flip";
  return picked;
}

// small glyphs of the bar (24-px grid, stroked like the rest)
const GLYPH: Record<CompareMode | "compare", string[]> = {
  side: ["M3 6h7.5v12H3z", "M13.5 6H21v12h-7.5z"],
  wipe: ["M4 5h16v14H4z", "M12 3v18"],
  flip: ["M4 7h11v10H4z", "M9 4h11v10", "M17 17.5l2 2 2-2"],
  compare: ["M4 8h13", "M14 5l3 3-3 3", "M20 16H7", "M10 13l-3 3 3 3"],
};
export function Glyph({ name, size = 14 }: { name: keyof typeof GLYPH; size?: number }) {
  return h(
    "svg",
    { className: "carton-icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: "false", "data-icon": name },
    ...GLYPH[name].map((d, i) => h("path", { key: i, d })),
  );
}

export interface CompareBarProps {
  mode: CompareMode;
  modes: readonly CompareMode[];
  /** Side by side greyed (the stage is too narrow), with its reason as the tooltip. */
  sideOff?: boolean;
  /** That reason as the host words it from what is open (what to close); else "Close the chat or widen the window". */
  sideTip?: string | null;
  /** A click on the greyed Side by side when the host can make the room itself (it closes History): not disabled then. */
  onSideOff?: (() => void) | null;
  /** The second picture didn't start (§1.10): Side by side and Wipe greyed with these words; picking one tries again. */
  retry?: string | null;
  /** Under 600 px: icons only (Flip keeps its word), no count, "Done". */
  compact?: boolean;
  onMode: (m: CompareMode) => void;
  /** "7 changes", "7 differences". */
  count?: string | null;
  onDone: () => void;
}

/** The compare bar: the modes (a radio group: Tab, then ← →), the count, Done comparing. */
export function CompareBar(p: CompareBarProps) {
  const words = useWords();
  const list = p.modes;
  const narrow = (m: CompareMode) => m === "side" && !!p.sideOff;
  const pick = (m: CompareMode) => {
    if (narrow(m)) return void p.onSideOff?.();
    if (m !== p.mode) p.onMode(m);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // a greyed Side by side the host can make the room for takes the focus too, from where the focus is: Enter or Space
    // is its click (it closes History), never an arrow passing over it
    const open = list.filter((m) => !narrow(m) || !!p.onSideOff);
    const at = (e.target as HTMLElement | null)?.getAttribute?.("data-mode") as CompareMode | null;
    const i = open.indexOf(at && open.includes(at) ? at : p.mode);
    const next = open[(i + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length];
    e.preventDefault();
    e.stopPropagation();
    if (next) {
      if (!narrow(next)) pick(next);
      (e.currentTarget.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus();
    }
  };
  return h(
    "div",
    { className: "carton-compare-bar" },
    h(
      "div",
      { className: "carton-compare-modes", role: "radiogroup", "aria-label": words.compareModesLabel, onKeyDown },
      ...list.map((m) => {
        // greyed: Side by side for the width (a click makes the room when the host can), Side by side and Wipe after a
        // failed start (a click tries again)
        const off = narrow(m) || (!!p.retry && m !== "flip");
        const dead = narrow(m) && !p.onSideOff;
        const on = m === p.mode;
        const iconOnly = !!p.compact && m !== "flip";
        const tip = narrow(m) ? p.sideTip || words.sideBySideNeedsRoom : off ? p.retry : iconOnly ? words.compareModes[m] : undefined;
        return h(
          "button",
          {
            key: m,
            type: "button",
            role: "radio",
            "aria-checked": on,
            "aria-disabled": dead || undefined,
            "aria-label": iconOnly ? words.compareModes[m] : undefined,
            "aria-description": off ? tip : undefined,
            "data-mode": m,
            "data-off": off ? "" : undefined,
            "data-carton-tip": tip,
            tabIndex: on ? 0 : -1,
            className: "carton-compare-mode",
            onClick: () => pick(m),
          },
          h(Glyph, { name: m }),
          iconOnly ? null : h("span", null, words.compareModes[m]),
        );
      }),
    ),
    h("span", { className: "carton-compare-spacer" }),
    p.count && !p.compact ? h("span", { className: "carton-compare-count" }, p.count) : null,
    h(Button, { className: "carton-compare-done", keys: "Escape", title: words.doneComparingKey, onClick: p.onDone }, p.compact ? words.done : words.doneComparing),
  );
}

/** A side's label under its picture (Side by side), or in a corner (Wipe): name · when, its timecode, in step. */
function SideLabel({ side, className }: { side: CompareSideInfo; className?: string }) {
  const words = useWords();
  const step = side.step === "same" ? words.sameShot : side.step === "waiting" ? words.waiting : null;
  return h(
    "div",
    { className: cx("carton-compare-label", className) },
    side.cut ? (side.cut.main ? h(Icon, { name: "cut", size: 12 }) : h("span", { className: "carton-compare-dot", style: { background: side.cut.dot ?? "#f59e0b" } })) : null,
    h("b", null, side.title),
    side.detail ? h("span", { className: "carton-compare-when" }, ` · ${side.detail}`) : null,
    h("span", { className: "carton-compare-tc" }, side.at != null ? timecode(side.at) : "", step ? ` · ${step}` : ""),
  );
}

function Slate({ slate }: { slate: { title: string; body: string } }) {
  return h("div", { className: "carton-compare-slate" }, h("b", null, slate.title), h("span", null, slate.body));
}

export interface CompareStageViewProps {
  left: CompareSideInfo;
  right: CompareSideInfo;
  /** The stage region's name: "Comparing “Sent to client” with your edit". */
  label: string;
  mode: CompareMode;
  modes: readonly CompareMode[];
  sideOff?: boolean;
  compact?: boolean;
  onMode: (m: CompareMode) => void;
  count?: string | null;
  onDone: () => void;
  /** The left side's player (Side by side, Wipe): the second player's canvas. Null: its slate, or nothing yet. */
  player?: ReactNode;
  /** The project's aspect ratio (width / height): the pictures' shape. */
  ratio: number;
  /** Where the editor's own picture goes (the right side): the host lays Cardboard's preview into this box. */
  holeRef?: (el: HTMLElement | null) => void;
  /** Flip: the side shown, and a press or a click on the pill (latch). */
  flipped?: boolean;
  onFlip?: (show: "left" | "right", latch: boolean) => void;
  /** Wipe: where the line is (0–100, % of the picture from the left), and its moves. */
  wipe?: number;
  onWipe?: (pct: number) => void;
  playing?: boolean;
  onPlayBoth?: () => void;
  /** Play both's progress, 0–1, on the right side's time. */
  progress?: number;
  /** The frame's own label, when the change list isn't on screen (History closed, the drawer hidden): ⇆ label · count ✕. */
  frameLabel?: string | null;
  /** A click on the frame label's words: History again, on the change list. */
  onFrameLabel?: (() => void) | null;
  /** The compare bar's greyed modes: Side by side's reason, its click (makes the room), a failed start (CompareBarProps). */
  sideTip?: string | null;
  onSideOff?: (() => void) | null;
  retry?: string | null;
  pulse?: number;
  className?: string;
}

/** The stage while comparing (DESIGN-V2 §1.3–1.4). Nothing sits over the pictures but Wipe's line and Flip's tag. */
export function CompareStageView(p: CompareStageViewProps) {
  const words = useWords();
  // One picture and what goes under it (its label, Wipe's hint, Flip's pill), as wide as the area allows for the
  // project's shape: the picture's box is exact, so the editor's own picture laid into it (the hole) fits it exactly.
  // (Side by side: Play both sits right under the two pictures, as one block in the middle of the stage, not at the
  // stage's foot 170 px below them at the mockups' size: design QA v2. Its 40 px row is in the pictures' height there)
  const below = p.mode === "flip" ? 32 : p.mode === "side" ? 26 + 40 : 26;
  const unit = (box: ReactNode, under: ReactNode) =>
    h("div", { className: "carton-compare-unit", style: { width: `min(100%, calc((100cqh - ${below}px) * ${p.ratio.toFixed(5)}))` } }, box, under);
  const boxStyle = { aspectRatio: String(p.ratio) };
  const transport = h("div", { className: "carton-compare-transport" },
    h(Button, { icon: p.playing ? "pause" : "play", keys: "Space", onClick: p.onPlayBoth }, p.playing ? words.pause : words.playBoth),
    h("div", { className: "carton-compare-progress", "aria-hidden": true }, h("i", { style: { width: `${Math.round(Math.max(0, Math.min(1, p.progress ?? 0)) * 1000) / 10}%` } })),
    h("span", { className: "carton-compare-step", "data-carton-tip": words.inStepByShotHint, tabIndex: 0, "aria-description": words.inStepByShotHint }, words.inStepByShot, h(Icon, { name: "info", size: 12 })));
  let area: ReactNode;
  if (p.mode === "side") {
    area = h("div", { className: "carton-compare-area", "data-mode": "side" },
      h("div", { className: "carton-compare-sides" },
      h("figure", { className: "carton-compare-col", "data-side": "left", "aria-label": `${p.left.title}${p.left.detail ? ` · ${p.left.detail}` : ""}` },
        unit(h("div", { className: "carton-compare-box carton-compare-pic", style: boxStyle }, p.left.slate ? h(Slate, { slate: p.left.slate }) : p.player ?? null), h(SideLabel, { side: p.left }))),
      h("figure", { className: "carton-compare-col", "data-side": "right", "aria-label": `${p.right.title}${p.right.detail ? ` · ${p.right.detail}` : ""}` },
        unit(h("div", { className: "carton-compare-box", "data-hole": "", ref: p.holeRef ?? undefined, style: boxStyle }, p.right.slate ? h(Slate, { slate: p.right.slate }) : null), h(SideLabel, { side: p.right })))),
      transport);
  } else if (p.mode === "wipe") {
    area = h("div", { className: "carton-compare-area", "data-mode": "wipe" },
      h("div", { className: "carton-compare-col" },
        unit(h(WipePic, { holeRef: p.holeRef, ratio: p.ratio, pct: p.wipe ?? 50, onWipe: p.onWipe, left: p.left, right: p.right, player: p.left.slate ? h(Slate, { slate: p.left.slate }) : p.player ?? null }),
          h("div", { className: "carton-compare-hint" }, words.wipeHint))));
  } else {
    const showing = p.flipped ? p.left : p.right;
    area = h("div", { className: "carton-compare-area", "data-mode": "flip" },
      h("div", { className: "carton-compare-col" },
        unit(h("div", { className: "carton-compare-box", "data-hole": "", ref: p.holeRef ?? undefined, style: boxStyle },
            // the side shown has no shot here (Play both): its slate over the picture
            showing.slate ? h(Slate, { slate: showing.slate }) : null),
          // which side shows is said under the picture, never over it (laptop: the tag covered its top-left corner)
          h(FlipPill, { left: p.left, right: p.right, flipped: !!p.flipped, onFlip: p.onFlip, at: showing.at }))));
  }
  return h(
    "section",
    { className: cx("carton-compare", p.className), "aria-label": p.label, "data-mode": p.mode, "data-label": p.frameLabel ? "" : undefined, "data-pulse": p.pulse ? (p.pulse % 2 ? "a" : "b") : undefined },
    h(CompareBar, { mode: p.mode, modes: p.modes, sideOff: !!p.sideOff, sideTip: p.sideTip ?? null, onSideOff: p.onSideOff ?? null, retry: p.retry ?? null, compact: !!p.compact, onMode: p.onMode, count: p.count ?? null, onDone: p.onDone }),
    area,
    p.mode === "side" ? null : transport,
    p.frameLabel ? h("div", { className: "carton-compare-frame-label" }, h(Glyph, { name: "compare", size: 13 }),
      p.onFrameLabel ? h("button", { type: "button", className: "carton-compare-frame-open", title: words.frameLabelOpen, onClick: p.onFrameLabel }, p.frameLabel) : h("span", null, p.frameLabel),
      h("button", { type: "button", className: "carton-frame-back", "aria-label": words.doneComparingKey, title: words.doneComparingKey, onClick: p.onDone }, h(Icon, { name: "x", size: 12 }))) : null,
  );
}

/** Wipe's picture: the left side over the right, cut at the line; the line is a slider (← →, Shift fine, Home End, double-click: middle). */
function WipePic(p: { holeRef?: ((el: HTMLElement | null) => void) | undefined; ratio: number; pct: number; onWipe?: ((pct: number) => void) | undefined; left: CompareSideInfo; right: CompareSideInfo; player: ReactNode }) {
  const words = useWords();
  const box = useRef<HTMLDivElement>(null);
  const set = (x: number) => p.onWipe?.(Math.max(0, Math.min(100, Math.round(x * 10) / 10)));
  const drag = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const at = (x: number) => (r.width > 0 ? ((x - r.left) / r.width) * 100 : 50);
    set(at(e.clientX));
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch {}
    const move = (m: globalThis.PointerEvent) => set(at(m.clientX));
    const up = () => { target.removeEventListener("pointermove", move as never); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up); };
    target.addEventListener("pointermove", move as never);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 1 : 5;
    const next = e.key === "ArrowLeft" ? p.pct - step : e.key === "ArrowRight" ? p.pct + step : e.key === "Home" ? 0 : e.key === "End" ? 100 : null;
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  const pct = Math.max(0, Math.min(100, p.pct));
  const ref = (el: HTMLDivElement | null) => { box.current = el; p.holeRef?.(el); };
  return h("div", { ref, className: "carton-compare-box", "data-hole": "", style: { aspectRatio: String(p.ratio) } },
    // the right side has no shot here (Play both): its slate under the line's left part
    p.right.slate ? h(Slate, { slate: p.right.slate }) : null,
    h("div", { className: "carton-compare-wipe-left", style: { clipPath: `inset(0 ${(100 - pct).toFixed(2)}% 0 0)` } }, p.player),
    h("div", { className: "carton-compare-corner", "data-side": "left" }, h(SideLabel, { side: p.left })),
    h("div", { className: "carton-compare-corner", "data-side": "right" }, h(SideLabel, { side: p.right })),
    h("div", {
      className: "carton-compare-wipe-line",
      role: "slider",
      tabIndex: 0,
      "aria-label": words.wipeLabel(p.left.title, p.right.title),
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": Math.round(100 - pct),
      "aria-valuetext": words.wipeValue(Math.round(100 - pct), p.right.title),
      style: { left: `${pct}%` },
      onPointerDown: drag,
      onKeyDown,
      onDoubleClick: () => set(50),
    }, h("span", { className: "carton-compare-wipe-knob", "aria-hidden": true }, "‹ ›")));
}

/** Flip's pill under the picture: [left | right], held (B or the pointer) shows the left, a click latches it. */
function FlipPill(p: { left: CompareSideInfo; right: CompareSideInfo; flipped: boolean; onFlip?: (show: "left" | "right", latch: boolean) => void; at?: number }) {
  const words = useWords();
  const pressed = useRef<number | null>(null);
  const down = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    pressed.current = Date.now();
    p.onFlip?.("left", false);
  };
  const up = () => {
    const t = pressed.current;
    pressed.current = null;
    if (t == null) return;
    // a click (short press) latches the left side; a hold comes back on release
    if (Date.now() - t < 250) p.onFlip?.("left", true);
    else p.onFlip?.("right", false);
  };
  const shown = p.flipped ? p.left : p.right;
  const whole = (side: CompareSideInfo) => (side.detail ? `${side.title} · ${side.detail}` : side.title);
  return h("div", { className: "carton-compare-flipbar" },
    // "Showing" and the side shown, pressed (blue while it's the left side): the tag that sat over the picture's corner
    h("span", { className: "carton-compare-showing", "aria-hidden": true }, words.showing),
    h("span", { className: "carton-sr", role: "status" }, `${words.showing} ${whole(shown)}`),
    h("div", { className: "carton-compare-modes carton-compare-flippill", role: "group", "aria-label": words.showing, "data-left": p.flipped ? "" : undefined },
      h("button", { type: "button", className: "carton-compare-mode", title: whole(p.left), "aria-pressed": p.flipped, onPointerDown: down, onPointerUp: up, onPointerLeave: () => { if (pressed.current != null) { pressed.current = null; p.onFlip?.("right", false); } }, onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onFlip?.(p.flipped ? "right" : "left", true); } } }, p.left.title),
      h("button", { type: "button", className: "carton-compare-mode", title: whole(p.right), "aria-pressed": !p.flipped, onClick: () => p.onFlip?.("right", true) }, p.right.title)),
    h("span", { className: "carton-compare-hint" }, words.holdBToFlip),
    h("span", { className: "carton-compare-tc" }, p.at != null ? timecode(p.at) : ""));
}

export interface CompareListProps {
  /** The range line: "From “Sent to client” · yesterday at 4:10 pm" / "to your edit now". */
  range: readonly [ReactNode, ReactNode];
  /** "7 changes · 0:36". */
  count?: string | null;
  changes: readonly Change[] | null;
  status: "loading" | "ready" | "error";
  onReload?: () => void;
  /** The change selected (both players and the timeline are there). */
  selected?: string | null;
  onSelect: (c: Change) => void;
  onPlay?: (c: Change) => void;
  onBack: () => void;
  /** The selected row's detail (Bring back), and the footer (Restore…, Fold in…, Back to Fold in…). */
  detail?: (c: Change) => ReactNode;
  footer?: ReactNode;
  /** No changes: the line said in place of the list. */
  empty?: string;
  className?: string;
}

/** The History panel during Compare (DESIGN-V2 §1.2): ← History, the range, the count, every change in timeline order. */
export function CompareList(p: CompareListProps) {
  const words = useWords();
  // in timeline order, as the marks read left to right (a change with no place, the frame rate, last); the engine's
  // order is by clip, so a removal at 0:12 came before a caption at 0:07 (design QA v2). Stable: same spot, same order
  const changes = useMemo(() => [...(p.changes ?? [])].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)), [p.changes]);
  const authors = new Set(changes.map((c) => c.author?.key ?? "")).size > 1;
  const body = useRef<HTMLDivElement>(null);
  // focus comes in when the list is ready (as Cardboard's panels do), on the selected row or the first: that focus
  // picks nothing (the players stay where Compare opened)
  const quiet = useRef(false);
  useEffect(() => {
    if (p.status !== "ready") return;
    const el = body.current;
    quiet.current = true;
    (el?.querySelector<HTMLElement>(".carton-change-selected, .carton-change[data-change-key]") ?? el)?.focus({ preventScroll: true });
    quiet.current = false;
  }, [p.status]);
  const onSelect = useCallback((c: Change) => p.onSelect(c), [p.onSelect]);
  // ↑↓ walk the rows (ChangeList moves the focus): the row the keyboard lands on is selected, both players follow
  const onFocus = (e: { target: EventTarget | null }) => {
    const key = (e.target as HTMLElement | null)?.getAttribute?.("data-change-key");
    if (quiet.current || !key || key === p.selected) return;
    const c = changes.find((x) => x.key === key);
    if (c) p.onSelect(c);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Backspace" && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      p.onBack();
    }
  };
  let list: ReactNode = null;
  if (p.status === "loading") list = h("div", { className: "carton-changes-skeleton", "aria-hidden": true }, h("span", null), h("span", null), h("span", null));
  else if (p.status === "error")
    list = h("div", { className: "carton-changes-failed", role: "alert" }, h("p", { className: "carton-error" }, words.compareFailed), p.onReload ? h(Button, { onClick: p.onReload }, words.tryAgain) : null);
  else if (!changes.length) list = h("p", { className: "carton-compare-empty" }, p.empty ?? "");
  else
    list = h(ChangeList, { label: words.history, className: "carton-changes-list" },
      ...changes.map((c, i) => {
        const sel = c.key === p.selected;
        return h(Fragment, { key: `${c.key}#${i}` },
          h(ChangeRow, { change: c, showAuthor: authors, active: sel, tabIndex: sel || (!p.selected && i === 0) ? 0 : -1, onSelect, ...(p.onPlay ? { onPlay: p.onPlay } : {}), className: sel ? "carton-change-selected" : undefined }),
          sel && p.detail ? p.detail(c) : null);
      }));
  return h("section", { className: cx("carton-compare-list", p.className), "aria-label": words.history, onKeyDown },
    h("div", { className: "carton-changes-nav" }, h(Button, { variant: "ghost", icon: "arrowLeft", onClick: p.onBack, title: words.backToHistoryKey }, words.backToHistory)),
    h("header", { className: "carton-compare-head" },
      h("p", { className: "carton-compare-range" }, p.range[0], h("br", null), p.range[1]),
      p.count ? h("p", { className: "carton-compare-n" }, p.count) : null),
    h("div", { ref: body, className: "carton-compare-body", tabIndex: -1, onFocus }, list),
    p.footer ? h("footer", { className: "carton-compare-foot" }, p.footer) : null);
}

/**
 * A picked row's detail in Compare's list (DESIGN-V2 §1.5): Then / Now in words, and the one-clip action (Bring back, or
 * Take out a clip that wasn't there then) with what it will do (where it goes, what else moves, that Ctrl+Z takes it
 * back). `note`: what happened when it couldn't (the clip changed again since, a failure).
 */
export function CompareRowDetail(p: { then: string; now: string; action?: string | null; line?: string | null; busy?: boolean; note?: string | null; onAction?: () => void }) {
  const words = useWords();
  return h("div", { className: "carton-compare-detail", role: "group" },
    h("div", { className: "carton-compare-thennow" },
      h("span", null, words.compareThen), h("span", null, p.then),
      h("span", null, words.compareNow), h("span", null, p.now)),
    p.action ? h(Button, { icon: "restore", busy: !!p.busy, onClick: p.onAction }, p.action) : null,
    p.note ? h("p", { className: "carton-error", role: "alert" }, p.note) : p.line ? h("p", { className: "carton-compare-detail-line" }, p.line) : null);
}

/** Where a track's row is on the tracks surface (px from its top), as the host reads it from the timeline. */
export interface TrackRow { readonly top: number; readonly height: number }

const TAG_MIN = 36;
/** A removed clip's ghost names it from this wide (the tag's 36 px is for tags; design QA v2 G17). */
const GHOST_NAME_MIN = 24;
const MARK_CLASS: Record<MarkKind, string> = { added: "add", removed: "rem", moved: "chg", trimmed: "chg", changed: "chg" };

/**
 * The marks over Cardboard's own clips (DESIGN-V2 §1.6), on the tracks surface: each clip's rect is start × pps on its
 * track's row. Added: green outline and +. Changed, moved, trimmed: amber outline and a tag (•, ←4 s, 2 s→, the count).
 * Removed: a ghost (dashed, hatched) where it was, or a seam (a dashed line and a − knob) when the rest moved up.
 * aria-hidden: the list says the same. A click on a mark picks its row.
 */
// (memo: Play both's playhead ticks re-render the stage four times a second; the marks don't change with it)
export const CompareMarks = memo(function CompareMarks(p: { marks: readonly TimelineMark[]; pps: number; rows: ReadonlyMap<string, TrackRow>; selected?: string | null; counts?: ReadonlyMap<string, number>; onPick?: (key: string) => void }) {
  const words = useWords();
  const out: ReactNode[] = [];
  for (const m of p.marks) {
    const row = m.trackId ? p.rows.get(m.trackId) : undefined;
    if (!row) continue;
    const left = m.start * p.pps, width = Math.max(2, (m.end - m.start) * p.pps);
    const sel = p.selected === m.key;
    const n = p.counts?.get(m.itemId) ?? 1;
    const seam = m.kind === "removed" && m.end - m.start <= 0.05;
    const tag = m.kind === "added" ? "+" : m.kind === "removed" ? null : n > 1 ? String(n) : m.kind === "moved" ? (m.delta == null ? words.newTrack : m.delta < 0 ? `←${Math.abs(m.delta)} s` : `${m.delta} s→`) : "•";
    out.push(
      seam
        ? h("div", { key: m.key, className: "carton-tl-seam", "data-selected": sel ? "" : undefined, title: m.text, style: { left, top: row.top, height: row.height }, onClick: () => p.onPick?.(m.key) }, h("span", null, "−"))
        : h("div", {
            key: m.key,
            className: `carton-tl-mark carton-tl-${MARK_CLASS[m.kind]}`,
            "data-kind": m.kind,
            "data-selected": sel ? "" : undefined,
            title: m.text,
            style: { left, width, top: row.top + 1, height: Math.max(4, row.height - 2) },
            onClick: () => p.onPick?.(m.key),
          }, tag && width >= TAG_MIN ? h("span", { className: "carton-tl-tag" }, tag) : m.kind === "removed" && m.name && width >= GHOST_NAME_MIN ? h("span", { className: "carton-tl-ghost-name" }, m.name) : null),
    );
  }
  return h("div", { className: "carton-tl-marks", "aria-hidden": true }, ...out);
});

/** The left side's strip over the tracks: its shots on its own time, a red outline where it differs; its playhead. */
export function CompareStrip(p: { bars: readonly StripBar[]; pps: number; label: string; playhead?: number | null; height?: number }) {
  // the bars as the same elements while only the playhead moves (Play both's ticks): React skips them
  const bars = useMemo(() => p.bars.map((b, i) =>
    h("span", { key: i, className: "carton-tl-strip-bar", "data-kind": b.kind, title: b.label, style: { left: b.start * p.pps, width: Math.max(2, (b.end - b.start) * p.pps - 2) } })), [p.bars, p.pps]);
  return h("div", { className: "carton-tl-strip", "aria-hidden": true, style: { height: p.height ?? 26 } },
    ...bars,
    p.playhead != null ? h("span", { key: "ph", className: "carton-tl-strip-ph", style: { left: p.playhead * p.pps } }) : null);
}

/** The strip's label in the timeline's track-name column. */
export function CompareStripLabel({ label, height = 26 }: { label: string; height?: number }) {
  return h("div", { className: "carton-tl-strip-name", "aria-hidden": true, style: { height } }, label);
}

/** The timeline toolbar's legend: added · removed · changed or moved (hidden under 900 px). */
export function CompareLegend() {
  const words = useWords();
  return h("span", { className: "carton-tl-legend", "aria-hidden": true },
    h("span", null, h("i", { "data-kind": "add" }), words.legendAdded),
    h("span", null, h("i", { "data-kind": "rem" }), words.legendRemoved),
    h("span", null, h("i", { "data-kind": "chg" }), words.legendChanged));
}

/** Compare's stylesheet: the stage view and the list in the skin's scope; the timeline's marks outside it. */
const SK = '[data-carton-skin="cardboard"]';
export const COMPARE_CSS = `
${SK} .carton-compare{position:absolute;inset:0;display:flex;flex-direction:column;pointer-events:none;color:var(--cb-fg-2);font:12.5px/1.35 var(--cb-font);box-shadow:inset 0 0 0 2px #8ab4ffb3;border-radius:2px}
${SK} .carton-compare[data-pulse=a]{animation:carton-frame-pulse-a .7s ease-out}
${SK} .carton-compare[data-pulse=b]{animation:carton-frame-pulse-b .7s ease-out}
${SK} .carton-compare>*{pointer-events:auto}
${SK} .carton-compare-bar{flex:none;height:44px;display:flex;align-items:center;gap:8px;padding:0 12px}
${SK} .carton-compare-spacer{flex:1}
${SK} .carton-compare[data-label]>.carton-compare-bar{margin-top:20px}
${SK} .carton-compare-modes{display:inline-flex;align-items:center;height:28px;padding:2px;border-radius:8px;background:#ffffff0a;box-shadow:inset 0 0 0 1px #ffffff12}
${SK} .carton-compare-mode{height:24px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--cb-fg-3);font:500 12.5px var(--cb-font);white-space:nowrap;cursor:pointer}
${SK} .carton-compare-mode:hover{color:var(--cb-fg-1)}
${SK} .carton-compare-mode[aria-checked=true],${SK} .carton-compare-mode[aria-pressed=true]{background:#ffffff1f;color:var(--cb-fg-1)}
${SK} .carton-compare-mode[data-off]{color:#ffffff40}
${SK} .carton-compare-mode[data-off]:not([aria-disabled=true]):hover{color:#ffffff99}
${SK} .carton-compare-mode[aria-disabled=true]{cursor:default}
${SK} .carton-compare-modes>.carton-compare-mode:first-child[data-carton-tip]:hover::after{left:0;transform:none;animation-name:carton-tip-l}
@keyframes carton-tip-l{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
${SK} .carton-compare-mode:focus-visible{outline:2px solid color-mix(in srgb,var(--cb-ring) 60%,transparent);outline-offset:1px}
${SK} .carton-compare-count{color:var(--cb-fg-3);white-space:nowrap}
${SK} .carton-compare-area{flex:1;min-height:0;display:flex;gap:12px;padding:4px 12px 0;pointer-events:none;container-type:size}
${SK} .carton-compare-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin:0}
${SK} .carton-compare-area[data-mode=side]{flex-direction:column;justify-content:center;gap:4px;padding-bottom:4px}
${SK} .carton-compare-sides{display:flex;gap:12px;min-height:0}
${SK} .carton-compare-area[data-mode=side]>.carton-compare-transport{padding:0;pointer-events:auto}
${SK} .carton-compare-unit{display:flex;flex-direction:column;max-width:100%}
${SK} .carton-compare-box{position:relative;width:100%;border-radius:6px;overflow:hidden}
${SK} .carton-compare-pic{background:#111}
${SK} .carton-compare-pic>canvas,${SK} .carton-compare-wipe-left>canvas{display:block;width:100%;height:100%}
${SK} .carton-compare-label{display:flex;align-items:center;gap:6px;height:26px;min-width:0;font-size:12px;color:var(--cb-fg-2);white-space:nowrap;pointer-events:auto}
${SK} .carton-compare-label b{font-weight:600;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis}
${SK} .carton-compare-when{color:var(--cb-fg-3);overflow:hidden;text-overflow:ellipsis}
${SK} .carton-compare-tc{margin-left:auto;color:var(--cb-fg-3);font-variant-numeric:tabular-nums;flex:none}
${SK} .carton-compare-dot{width:8px;height:8px;border-radius:99px;flex:none}
${SK} .carton-compare-slate{position:absolute;inset:0;background:#141414;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--cb-fg-3);font-size:12.5px;text-align:center;padding:0 16px}
${SK} .carton-compare-slate b{color:var(--cb-fg-1);font-weight:600}
${SK} .carton-compare-wipe-left{position:absolute;inset:0;background:#111}
${SK} .carton-compare-wipe-line{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 6px #000a;cursor:ew-resize;pointer-events:auto;touch-action:none}
${SK} .carton-compare-wipe-line:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}
${SK} .carton-compare-wipe-knob{position:absolute;top:50%;left:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:99px;background:#fff;color:#141414;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;box-shadow:0 2px 8px #000a}
${SK} .carton-compare-corner{position:absolute;top:8px;max-width:calc(50% - 16px);padding:0 8px;border-radius:6px;background:#121212d9;pointer-events:none}
${SK} .carton-compare-corner[data-side=left]{left:8px}
${SK} .carton-compare-corner[data-side=right]{right:8px}
${SK} .carton-compare-corner .carton-compare-label{height:22px}
${SK} .carton-compare-flipbar{display:flex;align-items:center;gap:10px;height:32px;min-width:0;pointer-events:auto}
${SK} .carton-compare-showing{color:var(--cb-fg-3);font-size:12px;white-space:nowrap;margin-right:-4px}
${SK} .carton-compare-flippill{min-width:0;flex:none;max-width:70%}
${SK} .carton-compare-flippill>.carton-compare-mode{min-width:0;overflow:hidden;text-overflow:ellipsis;display:block;line-height:24px}
${SK} .carton-compare-flippill[data-left]>.carton-compare-mode[aria-pressed=true]{background:#8ab4ff;color:#0b1730}
${SK} .carton-compare-hint{color:var(--cb-fg-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${SK} .carton-compare-area[data-mode=wipe] .carton-compare-hint{height:26px;line-height:26px;text-align:center;pointer-events:auto}
${SK} .carton-compare-transport{flex:none;display:flex;align-items:center;gap:10px;height:40px;padding:0 12px 4px;font-size:12px;color:var(--cb-fg-3)}
${SK} .carton-compare-progress{flex:1;height:4px;border-radius:4px;background:#ffffff1a;position:relative}
${SK} .carton-compare-progress i{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--cb-fg-2)}
${SK} .carton-compare-step{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
${SK} .carton-compare-frame-label{position:absolute;left:0;top:0;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 3px 0 8px;border-radius:0 0 7px 0;background:#8ab4ff;color:#0b1730;font-size:12px;font-weight:500;max-width:calc(100% - 24px)}
${SK} .carton-compare-frame-label>span,${SK} .carton-compare-frame-open{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${SK} .carton-compare-frame-open{min-width:0;padding:0;border:0;border-radius:3px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
${SK} .carton-compare-frame-open:hover{text-decoration:underline}
${SK} .carton-compare-frame-open:focus-visible{outline:2px solid #0b1730;outline-offset:1px}
${SK} .carton-cut-row{position:relative}
${SK} .carton-cut-compare{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:6px;background:var(--cb-secondary);color:var(--cb-fg-1);font:500 12px var(--cb-font);opacity:0;cursor:pointer}
${SK} .carton-cut-row:hover .carton-cut-compare,${SK} .carton-cut-compare:focus,${SK} .carton-cut-row:focus-within .carton-cut-compare{opacity:1}
${SK} .carton-compare-list{display:flex;flex-direction:column;min-height:0;flex:1}
${SK} .carton-compare-head{padding:2px 12px 10px;border-bottom:1px solid var(--cb-line)}
${SK} .carton-compare-range{margin:6px 0 0;font-size:13px;line-height:18px;color:var(--cb-fg-2)}
${SK} .carton-compare-range b{color:var(--cb-fg-1);font-weight:600}
${SK} .carton-compare-n{margin:4px 0 0;font-size:12px;color:var(--cb-fg-3)}
${SK} .carton-compare-body{flex:1;min-height:0;overflow:auto;padding:6px 8px;outline:none}
${SK} .carton-compare-empty{margin:12px 4px;color:var(--cb-fg-3)}
${SK} .carton-change-selected{background:#8ab4ff14;box-shadow:inset 2px 0 0 #8ab4ff}
${SK} .carton-compare-detail{margin:2px 0 8px 40px;padding:8px 10px;border-radius:8px;background:var(--cb-card);box-shadow:var(--cb-shadow-near);font-size:12px;line-height:17px;color:var(--cb-fg-2);display:flex;flex-direction:column;align-items:flex-start;gap:6px}
${SK} .carton-compare-thennow{display:grid;grid-template-columns:42px 1fr;row-gap:2px}
${SK} .carton-compare-thennow>span:nth-child(odd){color:var(--cb-fg-4)}
${SK} .carton-compare-thennow>span:nth-child(even){color:var(--cb-fg-1)}
${SK} .carton-compare-detail-line{margin:0;color:var(--cb-fg-3)}
${SK} .carton-compare-foot{border-top:1px solid var(--cb-line);padding:10px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.carton-tl-marks{position:absolute;inset:0;pointer-events:none;z-index:4}
.carton-tl-mark{position:absolute;box-sizing:border-box;border-radius:5px;pointer-events:auto;cursor:pointer}
.carton-tl-add{box-shadow:inset 0 0 0 2px #4ade80}
.carton-tl-chg{box-shadow:inset 0 0 0 2px #fbbd23}
.carton-tl-rem{border:1.5px dashed #e37878;background:repeating-linear-gradient(135deg,#e3787826 0 4px,transparent 4px 9px);z-index:-1}
.carton-tl-mark[data-selected]{outline:2px solid #fff;outline-offset:1px}
.carton-tl-tag{position:absolute;right:3px;top:3px;height:15px;padding:0 4px;border-radius:4px;font:700 10.5px/15px var(--font-sans,system-ui);color:#1d1400;background:#fbbd23;white-space:nowrap}
.carton-tl-add .carton-tl-tag{background:#4ade80;color:#06240f}
.carton-tl-ghost-name{position:absolute;left:4px;right:3px;top:50%;transform:translateY(-50%);overflow:hidden;text-overflow:clip;white-space:nowrap;font:500 11px/14px var(--font-sans,system-ui);color:#f19a9a}
.carton-tl-seam{position:absolute;width:0;border-left:2px dashed #e37878;pointer-events:auto;cursor:pointer}
.carton-tl-seam>span{position:absolute;top:-1px;left:-9px;width:16px;height:16px;border-radius:9px;background:#e37878;color:#2a0b0b;font:800 12px/16px system-ui;text-align:center}
.carton-tl-seam[data-selected]>span{box-shadow:0 0 0 2px #fff}
.carton-tl-strip{position:absolute;left:0;right:0;top:0;border-bottom:1px solid #ffffff0d;background:#ffffff05;pointer-events:none;z-index:4}
.carton-tl-strip-bar{position:absolute;top:7px;height:12px;border-radius:3px;background:#4b6487}
.carton-tl-strip-bar[data-kind=changed]{box-shadow:inset 0 0 0 1.5px #fbbd23}
.carton-tl-strip-bar[data-kind=removed]{box-sizing:border-box;border:1.5px dashed #e37878;background:repeating-linear-gradient(135deg,#e3787826 0 3px,transparent 3px 7px)}
.carton-tl-strip-bar[data-kind=gap]{background:transparent;box-shadow:inset 0 0 0 1px #ffffff1f}
.carton-tl-strip-ph{position:absolute;top:2px;bottom:2px;width:0;border-left:2px dotted #ffffffb3}
.carton-tl-strip-name{position:absolute;left:0;right:0;top:0;padding:5px 12px 0;font:11.5px var(--font-sans,system-ui);color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #ffffff0d;pointer-events:none;z-index:4}
.carton-tl-legend{display:inline-flex;align-items:center;gap:12px;margin-right:12px;font:11.5px var(--font-sans,system-ui);color:#999;white-space:nowrap}
.carton-tl-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;box-sizing:border-box}
.carton-tl-legend i[data-kind=add]{box-shadow:inset 0 0 0 2px #4ade80}
.carton-tl-legend i[data-kind=rem]{border:1.5px dashed #e37878}
.carton-tl-legend i[data-kind=chg]{box-shadow:inset 0 0 0 2px #fbbd23}
@media (max-width:900px){.carton-tl-legend{display:none}}
@media (prefers-reduced-motion:reduce){${SK} .carton-compare[data-pulse]{animation:none}}
`;
