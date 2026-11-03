// Stand-ins for ChangeRow and ChangeMap (DESIGN §5.1), which Workstream 3 owns (feat/ux-3-history). The Changes view
// builds on these until that branch lands; then it imports theirs and this file goes. Same roles and data: one row
// per change (time in the edit · kind of clip · the sentence · who), and the edit's length as a bar with a tick per
// change. Play's per-frame marks are plain DOM hooks: `[data-carton-progress]` (the lit row's progress line) and
// `[data-carton-maphead]` (the map's playhead), which Play moves by transform, never through React.

import { createElement as h, memo, type MouseEvent } from "react";
import { actorLabel } from "../actors.ts";
import { clock, timecode } from "../format.ts";
import { useCartonUi, useLocale, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Change, ClipKind } from "../model.ts";
import { cx, tipIfCut } from "./ui.ts";

const P = (d: string) => h("path", { d });
// The kind chip's marks, in the icon set's weight: film, T, note, CC, picture, braces, layers.
const KIND_MARKS: Record<ClipKind, ReturnType<typeof P>[]> = {
  video: [h("rect", { key: "r", x: 4, y: 6, width: 16, height: 12, rx: 2 }), P("M8 6v12M16 6v12M4 10h4M4 14h4M16 10h4M16 14h4")],
  title: [P("M6 6.5h12M12 6.5V18")],
  caption: [h("rect", { key: "r", x: 3.5, y: 6, width: 17, height: 12, rx: 2 }), P("M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6")],
  audio: [P("M9 17.5V6.5l9-2v11"), h("circle", { key: "a", cx: 7, cy: 17.5, r: 2 }), h("circle", { key: "b", cx: 16, cy: 15.5, r: 2 })],
  image: [h("rect", { key: "r", x: 4, y: 5, width: 16, height: 14, rx: 2 }), P("M4 16l4.5-4.5 4 4 2.5-2.5L20 18")],
  code: [P("M9 7l-4 5 4 5M15 7l4 5-4 5")],
  project: [P("M12 4.5l7.5 3.8-7.5 3.8-7.5-3.8z"), P("M4.5 12.2l7.5 3.8 7.5-3.8")],
};

function KindChip({ change }: { change: Change }) {
  return h(
    "span",
    { className: "carton-change-kind", "data-clip": change.clip, "aria-hidden": true },
    h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ...KIND_MARKS[change.clip]),
    h("b", { className: "carton-change-badge", "data-kind": change.kind }, change.kind === "add" ? "+" : change.kind === "remove" ? "−" : ""),
  );
}

export interface ChangeRowProps {
  change: Change;
  /** The row's DOM id (a listbox's aria-activedescendant). */
  id?: string;
  /** Who made it and when, under the sentence (shown when the list mixes authors). */
  showAuthor?: boolean;
  /** Its spot is playing (or paused in): the row is lit, with its progress line. */
  lit?: boolean;
  /** Its own ▶ is the one playing: the button reads Pause. */
  playing?: boolean;
  /** The keyboard's row. */
  active?: boolean;
  /** "now" for the clock, so a whole list reads one minute. */
  now?: number;
  /** ▶ (and Pause while it plays). */
  onPlay?: () => void;
  /** A click on the row: the editor's playhead goes there, without playing. */
  onSelect?: () => void;
  /** Hovering lights its tick on the change map. */
  onHover?: (on: boolean) => void;
  className?: string;
}

/** One change: `0:12 [T+] Added lower third “Jane Smith, Founder” ▶` and, when the list mixes authors, who and when. */
export const ChangeRow = memo(function ChangeRow(p: ChangeRowProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const c = p.change;
  const who = p.showAuthor && c.author ? actorLabel(c.author, ui.actor.bind(ui), words.you) : null;
  const at = p.showAuthor && c.when != null ? clock(c.when, { ...(p.now !== undefined ? { now: p.now } : {}), ...(locale ? { locale } : {}) }) : null;
  return h(
    "div",
    {
      id: p.id,
      role: "option",
      "aria-selected": !!p.active,
      "aria-current": p.lit ? "true" : undefined,
      className: cx("carton-change", p.className),
      "data-lit": p.lit ? "" : undefined,
      "data-active": p.active ? "" : undefined,
      onClick: p.onSelect,
      onMouseEnter: p.onHover ? () => p.onHover!(true) : undefined,
      onMouseLeave: p.onHover ? () => p.onHover!(false) : undefined,
    },
    h("span", { className: "carton-change-at" }, c.at != null && Number.isFinite(c.at) ? timecode(c.at) : words.noPosition),
    h(KindChip, { change: c }),
    h(
      "span",
      { className: "carton-change-text" },
      h("span", { className: "carton-change-sentence", onMouseEnter: tipIfCut }, c.text),
      who || at ? h("span", { className: "carton-change-who" }, [who, at].filter(Boolean).join(" · ")) : null,
    ),
    p.onPlay
      ? h(
          "button",
          {
            type: "button",
            className: "carton-change-play",
            tabIndex: -1,
            "aria-label": p.playing ? words.pause : words.playThisChange,
            "data-carton-tip": p.playing ? words.pause : words.playThisChange,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              p.onPlay!();
            },
          },
          h(Icon, { name: p.playing ? "pause" : "play", size: 10 }),
        )
      : h("span", null),
    p.lit ? h("span", { className: "carton-change-progress", "aria-hidden": true }, h("i", { "data-carton-progress": "" })) : null,
  );
});

export interface ChangeMapProps {
  changes: readonly Change[];
  /** The edit's length in seconds: the bar's scale. */
  length: number;
  /** Rows lit (playing): their ticks are ringed. */
  lit?: ReadonlySet<number>;
  /** The row hovered in the list: its tick is ringed too. */
  hover?: number | null;
  /** Show the playhead (while a play session is on). */
  head?: boolean;
  className?: string;
}

/** The edit's length as a slim bar, a tick per change (its colour: what happened), and Play's playhead. aria-hidden: the list says the same. */
export const ChangeMap = memo(function ChangeMap(p: ChangeMapProps) {
  const len = p.length > 0 ? p.length : 1;
  return h(
    "div",
    { className: cx("carton-change-map", p.className), "aria-hidden": true },
    h("span", { className: "carton-change-map-track" }),
    ...p.changes.map((c, i) =>
      c.at == null || !Number.isFinite(c.at)
        ? null
        : h("span", {
            key: i,
            className: "carton-change-tick",
            "data-kind": c.kind,
            "data-on": p.lit?.has(i) || p.hover === i ? "" : undefined,
            style: { left: `${Math.min(100, Math.max(0, (c.at / len) * 100))}%` },
          }),
    ),
    p.head ? h("span", { className: "carton-change-map-head", "data-carton-maphead": "" }, h("i", null)) : null,
  );
});
