// The change row: the one way a change is shown (docs/carton-ux DESIGN §5.1, rule 4). History's version card, the
// Changes view, the Fold dialog, conflict sides and toasts all use it:
//
//   0:12  [T+]  Added lower third “Jane Smith, Founder”        ▶
//               Claude Code · 12:48 pm
//
// - time in the edit (`timecode`), or "—" for a change with no place on the timeline (frame rate, aspect ratio);
// - the kind of clip, in Cardboard's own timeline colours, with a corner mark for what happened (+ added, − removed,
//   a dot changed);
// - the sentence (core's describe, through the view model), verb first, the clip by its name in curly quotes;
// - who and when, only when the list mixes authors;
// - ▶ on hover and on the row being played; a click on the row moves the editor's playhead there.
//
// Play runs outside React (PLAN 4.2): the row being played gets `playing`, and its progress line is moved by the
// player directly (`setChangeProgress`), never by a render per frame. Workstreams 4 (Changes view, Play) and 6 (Fold)
// import ChangeRow, ChangeList and ChangeMap; their props are the contract below.

import { createElement as h, memo, useCallback, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { actorLabel } from "../actors.ts";
import { clockOfDay, timecode } from "../format.ts";
import { useCartonUi, useLocale, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { Change, ClipKind } from "../model.ts";
import { cx } from "./ui.ts";

/** Each kind of clip's glyph in its chip (the colour comes from the skin, by `data-clip`). */
export const CLIP_ICON: Record<ClipKind, IconName> = {
  video: "film",
  title: "text",
  caption: "cc",
  audio: "music",
  image: "image",
  code: "code",
  project: "layers",
};

export interface ChangeRowProps {
  change: Change;
  /** Who and when under the sentence (DESIGN §5.1: when the list mixes authors). */
  showAuthor?: boolean;
  /** The change being played: lit, its ▶ shows ⏸, with a progress line the player moves (`setChangeProgress`). */
  playing?: boolean;
  /** Lit without playing: its tick hovered on the map, or the row the keyboard is on. */
  active?: boolean;
  /** ▶: play this change's spot (±1 s). Absent: no ▶. */
  onPlay?: (change: Change) => void;
  /** The playing row's ⏸. */
  onPause?: () => void;
  /** A click on the row: move the editor's playhead there, without playing (DESIGN §5.1). */
  onSelect?: (change: Change) => void;
  /** The pointer came onto the row (its key) or left it (null): its tick lights on the map. */
  onHover?: (key: string | null) => void;
  /** A control before the time: the Fold dialog's tick box, or its lock for a change that can't be left out. */
  lead?: ReactNode;
  /** A short tag after the sentence: the Fold dialog's "Left out on Oct 30". */
  tag?: ReactNode;
  /** Shown dimmed: a change the Fold dialog leaves out. */
  muted?: boolean;
  /** Rows the keyboard reaches (ChangeList moves between them): -1 (default) or 0 for the first. */
  tabIndex?: number;
  id?: string;
  className?: string;
}

/**
 * One change. A row the keyboard is on plays with Enter (DESIGN §7: "Card / Changes view: ↓ into the rows, Enter: play
 * that change"); ChangeList moves between rows with ↑↓. Memoized: a list re-renders only the rows whose change or
 * state changed.
 */
export const ChangeRow = memo(function ChangeRow(p: ChangeRowProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const c = p.change;
  const chip = words.changeChip(words.clipKinds[c.clip] ?? c.clip, words.changeKinds[c.kind] ?? c.kind);
  const who = p.showAuthor && (c.author || c.when !== undefined)
    ? words.changeWho(c.author ? actorLabel(c.author, ui.actor.bind(ui), words.you) : "", c.when !== undefined ? clockOfDay(c.when, locale) : "")
    : null;
  const play = p.onPlay, pause = p.onPause, select = p.onSelect, hover = p.onHover;
  const at = c.at !== undefined ? timecode(c.at) : null;
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      if (p.playing && pause) pause();
      else if (play) play(c);
      else select?.(c);
    },
    [c, p.playing, play, pause, select],
  );
  return h(
    "div",
    {
      id: p.id,
      role: "listitem",
      tabIndex: p.tabIndex ?? -1,
      className: cx("carton-change", p.className),
      "data-change-key": c.key,
      "data-kind": c.kind,
      "data-clip": c.clip,
      "data-playing": p.playing ? "" : undefined,
      "data-active": p.active ? "" : undefined,
      "data-muted": p.muted ? "" : undefined,
      "data-selectable": select ? "" : undefined,
      "aria-current": p.playing ? "true" : undefined,
      onClick: select ? (e: MouseEvent) => (e.defaultPrevented ? undefined : select(c)) : undefined,
      onKeyDown,
      onMouseEnter: hover ? () => hover(c.key) : undefined,
      onMouseLeave: hover ? () => hover(null) : undefined,
    },
    p.lead != null ? h("span", { className: "carton-change-lead" }, p.lead) : null,
    h("span", { className: "carton-change-time" }, at ?? words.noPosition),
    h(
      "span",
      { className: "carton-change-chip", "data-clip": c.clip, "data-kind": c.kind, role: "img", "aria-label": chip },
      h(Icon, { name: CLIP_ICON[c.clip] ?? "layers", size: 11 }),
      h("b", { className: "carton-change-badge", "aria-hidden": true }, c.kind === "add" ? "+" : c.kind === "remove" ? "−" : ""),
    ),
    h(
      "span",
      { className: "carton-change-text" },
      h("span", { className: "carton-change-words" }, at ? withoutSameTime(c.text, at) : c.text),
      p.tag != null ? h("span", { className: "carton-change-tag" }, p.tag) : null,
      who ? h("span", { className: "carton-change-who" }, who) : null,
    ),
    play || (p.playing && pause)
      ? h(
          "button",
          {
            type: "button",
            className: "carton-change-play",
            tabIndex: -1,
            "aria-label": p.playing ? words.pause : words.playThisChange,
            "data-carton-tip": p.playing ? words.pause : words.playThisChange,
            onClick: (e: MouseEvent) => {
              // the row's own click moves the playhead: ▶ plays, and only plays
              e.preventDefault();
              e.stopPropagation();
              if (p.playing && pause) pause();
              else play?.(c);
            },
          },
          h(Icon, { name: p.playing ? "pause" : "play", size: 10 }),
        )
      : h("span", { className: "carton-change-play-space", "aria-hidden": true }),
    p.playing ? h("span", { className: "carton-change-progress", "aria-hidden": true }, h("i", { className: "carton-change-progress-fill" })) : null,
  );
});

/**
 * A sentence's place in the edit at its end: "(now starts at 0:05)" after a move, ", now ends at 0:05" after a trim.
 * `head` is the sentence before it, `tail` the place (with its comma or bracket), or "" when it has none.
 */
const TAIL = /^(.+?)((?:, | \()now (?:starts|ends) at (\d+(?::\d{2}){1,2})\)?)$/;
export function sentenceTail(text: string): { head: string; tail: string; at: string | null } {
  const m = TAIL.exec(text);
  return m ? { head: m[1]!, tail: m[2]!, at: m[3]! } : { head: text, tail: "", at: null };
}
/**
 * A change row's sentence beside its time: a move's "(now starts at 0:05)" says the row's own time again, so it goes
 * when it is the same (design QA G14: "0:05 · Moved “Summer launch” 1 s earlier"). A different place stays, as does
 * every sentence where no time column is beside it (toasts, tooltips).
 */
export function withoutSameTime(text: string, at: string): string {
  const t = sentenceTail(text);
  return t.at === at && t.tail.startsWith(" (") ? t.head : text;
}

/**
 * Move the playing row's progress line (0–1), outside React (PLAN 4.2: no render per animation frame). `row` is the
 * row's element (`[data-change-key="…"]`), or a list holding it with `key`.
 */
export function setChangeProgress(row: Element | null, p: number, key?: string): void {
  const el = key !== undefined ? row?.querySelector(`[data-change-key="${cssEscape(key)}"]`) : row;
  const fill = el?.querySelector<HTMLElement>(".carton-change-progress-fill");
  if (fill) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))})`;
}

const cssEscape = (s: string) => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

export interface ChangeListProps {
  /** The list's name for screen readers ("Changes in Director's “Add captions…”"). */
  label: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Change rows as a list the keyboard walks (DESIGN §7): ↓ from the list (or Tab into it) reaches the first row, ↑↓
 * Home End move between rows, Enter on a row plays it. Its keys are its own: a list around it (History) leaves them be
 * (`data-own-keys`).
 */
export function ChangeList(p: ChangeListProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".carton-change[data-change-key]")];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const n =
      e.key === "Home" ? 0
      : e.key === "End" ? rows.length - 1
      : e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1)
      : i <= 0 ? -1
      : i - 1;
    // ↑ from the first row leaves the list: the key goes on to whatever holds it (the card's own keys)
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation();
    rows[n]!.focus({ preventScroll: false });
  };
  return h("div", { role: "list", "aria-label": p.label, className: cx("carton-changes", p.className), "data-own-keys": "", onKeyDown }, p.children);
}
