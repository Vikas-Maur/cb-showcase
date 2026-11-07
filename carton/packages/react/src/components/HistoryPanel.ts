// History (§0.1: the list of versions), redesigned (docs/carton-ux DESIGN §6.1, PLAN workstream 3). Newest first,
// virtualized for 10k+ versions, grouped by day:
// - the cut bar: the cut (the cuts menu) and a filter (All versions, Named versions, Agent turns, Your changes, and
//   Only “clip” when one clip is selected), an active filter shown as a removable chip, with the clip's credits on top;
// - rows of 56 px: who (an avatar, or each agent's own mark), what (an agent's prompt in quotes, a name in bold, or the
//   sentence of what changed), when (always with am/pm; the newest reads "Now"), then who · how many changes;
// - a person's run of changes as one row ("You · 6 changes ›"), the history's start as one row at the bottom;
// - an agent working as a live row on top, with the one line that explains turn holds;
// - a version's card, inline under its row (VersionCard): what it did, and how far your edit has moved on since.
// A click or Enter on a row opens its card and never changes what the editor shows: only Play does (DESIGN §4.2).
// A version still waiting for the server says "Not sent yet"; Play and Restore wait for it.

import { createElement as h, Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { clock, clockOfDay, curlyQuotes, exactTime, shortDate, timecode, versionLabel } from "../format.ts";
import { useAsync, useCartonUi, useCurrentCut, useCurrentCutId, useHistoryCount, useLocale, useNow, useTopic, useTopicSelector, useViewing, useWords, useWorking } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Actor, CartonUi, FindHit, HistoryFilter, Landmark, Version, Viewing, Working } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { COLLAPSE_OVER, DAY_ROW_HEIGHT, dayLabel, dayNumber, groupHistory, type HistoryRow } from "../history-groups.ts";
import { ActorName, Avatar, Button, HoverMore, InlineName, MenuItem, MenuLabel, MenuList, MenuSeparator, cx, tipIfCut } from "./ui.ts";
import { actorColor, actorLabel } from "../actors.ts";
import { nextArrivals, type ArrivalState } from "../arrivals.ts";
import { clipCredits, type ClipCreditsView } from "../credits.ts";
import { CLIP_ICON } from "./ChangeRow.ts";
import { ChangesView } from "./ChangesView.ts";
import { sentenceTail } from "./ChangeRow.ts";
import { BeforeButton, usePlayChanges, type PlayHost } from "./Play.ts";
import { CutDot, CutsMenu } from "./CutsMenu.ts";
import { cutRef } from "../cuts.ts";
import { VersionCard, stopViewing, type CardMode, type PlayRequest, type PlayState, type VersionCardProps } from "./VersionCard.ts";
// Carton UX v2 (N2: DESIGN-V2 §2–§4): landmarks, search, hold to peek, Compare with… and the Compare button
import { LandmarkTag, LandmarkTile, landmarkTitle, useLandmarks, useStagePictures } from "./LandmarkRow.ts";
import { SearchBox, highlight, searchable, snippetOf, useFind, type SearchBoxHandle } from "./SearchBox.ts";
import { CompareButton, PickLine, openCompareVia, type Picking } from "./CompareMenu.ts";
import { usePeek } from "./peek.ts";
import { CutPicker } from "./CutPicker.ts";
import type { ClipChoice } from "./GoBack.ts";

/** A version's row (DESIGN §6.1: 56 px). */
export const VERSION_ROW_HEIGHT = 56;
/** One of an open group's versions, listed under it (32 px, indented). */
export const CHILD_ROW_HEIGHT = 32;
/** The live row of an agent working, with its line (two lines at the panel's narrowest). */
export const WORKING_ROW_HEIGHT = 92;
/** Kept for hosts that imported it: a line of the old expanded list of changes. */
export const VERSION_DETAIL_HEIGHT = 18;
/** About the height of a row's actions menu: with less room than this below a row, it opens above it. */
const MENU_ROOM = 300;
/** The card's height before it has laid out once (it reports its own then). */
const CARD_ESTIMATE = 220;
/** The space under an open card, before the next row. */
const CARD_GAP = 8;

export interface HistoryPanelProps {
  /**
   * The cut bar's left side: the cut and its menu. Default: `<CutsMenu />` (no Fold in); a host passes its own (with
   * `onFoldIn`), or null for none.
   */
  cuts?: ReactNode;
  /**
   * Under the cut bar, above the list: what the cut on screen offers (Workstream 6's TeammateCutActions on a teammate's
   * cut: "Fold into Main cut…", "New cut from it"). A host's element; it renders nothing on your own cuts.
   */
  actions?: ReactNode;
  /**
   * The clip selected on the timeline, when exactly one is: the filter menu offers "Only “clip”" (PLAN 0.8). Read when
   * the menu opens, so the list never re-renders for a selection.
   */
  selectedClip?: () => { readonly id: string; readonly name: string } | null;
  /**
   * Everything between two refs: "See them" and "See the 4" on a card, "Compare with your edit" in a row's menu,
   * Shift+click or Shift+↑↓ on a second version. Default: the Changes view (Workstream 4) in place of the list; a host
   * gives its own to show them elsewhere.
   */
  onCompare?: (a: string, b: string) => void;
  /**
   * Play a card's changes (PLAN 4.2). Default: Play (usePlayChanges) on `play`, the host's player: on the cut's newest
   * version on your edit, on an older one viewing it first; the card's Before (hold, or B) shows how it was before it.
   * A host that plays them itself gives `onPlay`, `onPause` and `playing`.
   */
  onPlay?: (req: PlayRequest) => void;
  onPause?: () => void;
  /** What plays now (the host's player): its row in the open card is lit. */
  playing?: PlayState | null;
  /** A change row's click: the editor's playhead there (on your edit). Default: `play.seek`. */
  onSeek?: (at: number) => void;
  /**
   * The host's player for Play and Before (DESIGN §5.3), the card's and the Changes view's: the editor's playhead
   * (`onFrame`, `seek`), loading a version ahead (`prefetch`), your edit's length.
   */
  play?: PlayHost;
  /** Ref of the current state. Deprecated: History finds your edit itself. */
  currentRef?: string;
  className?: string;
  /**
   * A small JPEG (`data:image/jpeg`, 88 × 50, at most 64 KB) of what the stage shows now, or null when it can't make one
   * (no picture yet, a black frame): landmarks' pictures (DESIGN-V2 §2.2) are made from it when the stage shows one's
   * version. Absent: landmarks show their icons.
   */
  capturePicture?: () => Promise<string | null>;
  /** Viewport height used before the list can measure itself. */
  initialHeight?: number;
  filter?: HistoryFilter;
}

type Row = HistoryRow | { readonly kind: "working"; readonly key: "working" };
type DayHistoryRow = Extract<HistoryRow, { kind: "day" }>;
type RunHistoryRow = Extract<HistoryRow, { kind: "run" }>;
/** A card's play: the card it came from (`key`), its row's versions then (`ids`, newest first), its oldest's `base`. */
type PlayReq = { req: PlayRequest; key: string | null; ids: readonly string[]; base?: string; n: number };
/** A past day's run of changes between two landmarks: one quiet line, a day header's height (DESIGN-V2 §2.5). */
export const RUN_ROW_HEIGHT = 32;
/**
 * A landmark row whose tag and title don't fit on one line in a narrow panel: its title takes two (DESIGN-V2 §2.1:
 * "Below 340 px a landmark's title wraps to two lines rather than losing its words to the tag"; design QA v2 G9).
 * Only those rows are taller: each measures its own line.
 */
export const LANDMARK_WRAP_ROW_HEIGHT = VERSION_ROW_HEIGHT + 18;
export const LANDMARK_WRAP_UNDER = 340;
const NO_WRAPS: ReadonlySet<string> = new Set();
// a line's width, by the title's own font, once per (column, tag, title): a canvas's measureText, no layout
let measureCtx: CanvasRenderingContext2D | null | undefined;
const lineFits = new Map<string, boolean>();
/** Whether a landmark's tag and title overflow its title column on one line (whatever the row shows now). */
function titleOverflows(title: HTMLElement): boolean {
  const col = title.clientWidth;
  if (col <= 0) return false;
  const tag = title.querySelector<HTMLElement>(".carton-landmark-tag");
  const text = title.querySelector<HTMLElement>(".carton-landmark-title") ?? title;
  const id = `${col}|${tag?.textContent ?? ""}|${text.textContent ?? ""}`;
  let over = lineFits.get(id);
  if (over !== undefined) return over;
  if (!measureCtx) measureCtx = typeof document === "undefined" ? null : (document.createElement("canvas").getContext?.("2d") ?? null);
  if (!measureCtx) return false;
  const cs = getComputedStyle(text);
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  // (the tag is an inline box with its own margin: its width as laid out)
  const tagW = tag ? tag.getBoundingClientRect().width + (parseFloat(getComputedStyle(tag).marginRight) || 0) : 0;
  over = tagW + measureCtx.measureText(text.textContent ?? "").width > col + 0.5;
  if (lineFits.size > 4000) lineFits.clear();
  lineFits.set(id, over);
  return over;
}

const isAgent = (a: Actor) => a.kind === "agent" || a.kind === "subagent";
/** An agent's prompt, when the version is its turn (as versionLabel reads it), its quotes curly as the panel's own. */
const promptOf = (v: Version) => { const p = v.turn?.label || (isAgent(v.author) ? v.name : undefined); return p ? curlyQuotes(p) : undefined; };
const filterKey = (f: HistoryFilter) => (typeof f === "object" ? `item:${f.item}` : f);

// ------------------------------------------------------------------------------------------------- the rows' parts

/** A row's mark: a person's avatar or an agent's own mark; a named version's bookmark, a fold's or a restore's sign. */
function RowMark({ v, live }: { v: Version; live?: boolean }) {
  const named = !!v.name && !promptOf(v);
  const sign = named ? "bookmarkFill" : v.kind === "fold" ? "foldIn" : v.kind === "restore" ? "restoreArc" : v.kind === "undo" ? "undo" : null;
  if (sign) return h("span", { className: "carton-version-mark carton-mark-sign", "data-sign": named ? "named" : v.kind, "aria-hidden": true }, h(Icon, { name: sign, size: named ? 11 : 12 }));
  return h("span", { className: "carton-version-mark", "data-live": live ? "" : undefined, "aria-hidden": true }, h(Avatar, { actor: v.author, size: 20, named: true }));
}

/** How long a row that just arrived glows (its ring, a soft glow) before it settles into a faint edge of its colour. */
export const ARRIVAL_GLOW_MS = 5000;
/** A person announced as having made a change isn't announced again until they've been quiet this long. */
const ARRIVAL_QUIET_MS = 60_000;

/**
 * Someone else's row that arrived while History is open (arrivals.ts): a ring in their colour (their avatar's, an
 * agent's person's) with a soft glow, which settles after ARRIVAL_GLOW_MS into a faint edge that stays while History
 * is open. Drawn on mount from when it arrived, so a row scrolled back into view takes up where its glow is; a new
 * arrival in the same row (a teammate's edit joining their group, their agent's turn going on) is a new ring, keyed by
 * its time. Without motion (prefers-reduced-motion) the skin drops the fade-in and the settling: the ring shows, then
 * the edge.
 */
const ArrivalRing = memo(function ArrivalRing({ actor, at }: { actor: Actor; at: number }) {
  const ui = useCartonUi();
  const [glow, setGlow] = useState(() => Date.now() - at < ARRIVAL_GLOW_MS);
  // (fades in only as it arrives: never on a row scrolled back into view)
  const [pop] = useState(() => Date.now() - at < 300);
  useEffect(() => {
    if (!glow) return;
    const t = setTimeout(() => setGlow(false), Math.max(0, at + ARRIVAL_GLOW_MS - Date.now()));
    return () => clearTimeout(t);
  }, [glow, at]);
  return h("span", { className: "carton-arrival", "data-glow": glow ? "" : undefined, "data-pop": pop ? "" : undefined, style: { ["--carton-actor" as string]: actorColor(actor, ui.actor.bind(ui)) }, "aria-hidden": true });
});

/** Who did it, and how many changes: "Claude Code · 4 changes", "Named by You · 1 change", "You · 2 of 3 changes". */
function Meta({ v, count, ui }: { v: Version; count?: number; ui: CartonUi }) {
  const words = useWords();
  const named = !!v.name && !promptOf(v);
  const n = count ?? v.changes;
  return h(
    Fragment,
    null,
    v.author.kind === "system" ? null : named ? h("span", { className: "carton-actor-name" }, words.namedBy(actorLabel(v.author, ui.actor.bind(ui), words.you))) : h(ActorName, { actor: v.author }),
    n !== undefined ? h("span", { className: "carton-version-count" }, v.leftOut ? words.changesOf(n, n + v.leftOut) : words.changes(n)) : null,
  );
}

/** How many of the newest day's changes stay rows above its runs, when that day isn't today (DESIGN-V2 §2.5). */
const NEWEST_KEPT = 3;
/**
 * Groups' words per view model (a project), by `<base>|<newest>` (confirmed versions never change): at most 200 each.
 * A failed ask is never kept: the group reads "Several edits" until one succeeds (the next time its row is shown).
 */
const netKept = new WeakMap<CartonUi, Map<string, string>>();
/**
 * What a person's group of edits came to, in one line (the view model's `netWords`: the changes from before its oldest
 * to its newest, said as a turn's are), or "No change in the end"; undefined without a base or the call (its newest's
 * sentence then). Asked once per group and newest, only for the rows on screen.
 */
function useNetWords(from: string | undefined, to: string): string | undefined {
  const ui = useCartonUi();
  const words = useWords();
  const key = from && /@\d+$/.test(from) && /@\d+$/.test(to) && typeof ui.netWords === "function" ? `${from}|${to}` : null;
  let kept = netKept.get(ui);
  if (!kept) netKept.set(ui, (kept = new Map()));
  const [got, setGot] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (!key || kept.has(key)) return;
    let live = true;
    ui.netWords!(from!, to).then(
      (w) => {
        const text = w.changes && w.summary ? w.summary : words.groupNoNet;
        if (kept.size >= 200) kept.delete(kept.keys().next().value!);
        kept.set(key, text);
        if (live) setGot({ key, text });
      },
      // (never its newest's sentence instead: that is the one step a group may have undone, review of fix/ux2-open #7)
      () => {},
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kept]);
  if (!key) return undefined;
  return kept.get(key) ?? (got?.key === key ? got.text : words.groupLoading);
}

/**
 * A landmark's meta line (DESIGN-V2 §2.1): what the version itself changed (its title is the landmark's: "EXPORTED
 * 480p" over "Moved “B2” to 0:03 · You"), who ("Named by You"), "Kept for you" on a safety point, "only you see this"
 * on the personal ones (a day's start, a safety point), and a second landmark's tag ("also exported").
 */
function MarkMeta({ mark, v, also, changed }: { mark: Landmark; v: Version; also?: string | undefined; changed?: string | undefined }) {
  const ui = useCartonUi();
  const words = useWords();
  const by = mark.by ?? v.author;
  const who = actorLabel(by, ui.actor.bind(ui), words.you);
  return h(
    Fragment,
    null,
    // (the change gives way first in a narrow panel: who and the tags stay)
    changed ? h("span", { className: "carton-landmark-change", title: changed }, changed) : null,
    // (a teammate's Before, if core's SHARE_BEFORE shows them, names its person: "Kept for you" is for yours)
    mark.kind === "before" && mark.personal ? h("span", { className: "carton-actor-name" }, words.keptForYou) : mark.kind === "named" ? h("span", { className: "carton-actor-name" }, words.namedBy(who)) : by.kind === "system" ? null : h(ActorName, { actor: by }),
    // only Start and Before are a person's own: Exported and Sent are everyone's (DESIGN-V2 §2.1), and on a shared cut
    // reach teammates through the sync server (Windows check of b14f8a4e: Exported read "only you see this")
    mark.personal ? h("span", { className: "carton-version-count" }, words.onlyYouSee) : null,
    also ? h("span", { className: "carton-version-count" }, words.alsoLandmark(also)) : null,
  );
}

/**
 * Why a search found a version (DESIGN-V2 §2.3): "Prompt · 4 changes", "Caption text · “in half” · Leo", "Clip name ·
 * You"; a clip with its place then: "“Intro” was 0:00–0:06 here".
 */
function HitMeta({ hit, v }: { hit: FindHit; v: Version }) {
  const words = useWords();
  if (hit.field === "clip" && hit.clipName && hit.span) return h("span", { className: "carton-find-snippet" }, words.wasHere(hit.clipName, `${timecode(hit.span.start)}–${timecode(hit.span.end)}`));
  const shows = hit.field === "clip" || hit.field === "text";
  return h(
    Fragment,
    null,
    h("span", { className: "carton-find-why" }, words.findFields[hit.field]),
    shows && hit.snippet ? h("span", { className: "carton-find-snippet" }, snippetOf(hit)) : null,
    hit.field === "prompt" && v.changes !== undefined ? h("span", { className: "carton-version-count" }, words.changes(v.changes)) : v.author.kind === "system" ? null : h(ActorName, { actor: v.author }),
  );
}

interface RowProps {
  v: Version;
  rowKey: string;
  domId: string;
  height: number;
  active: boolean;
  /** Its actions menu is open: it looks picked while the menu is, and only then (UI audit P2-2). */
  menuOpen: boolean;
  /** Its card is open. */
  open: boolean;
  /** The newest version (and no agent working above it): its time reads "Now". */
  now: boolean;
  /** The editor shows this version (DESIGN §4.2): "👁 Viewing ✕" in its time column. */
  viewing: boolean;
  /** The version the Compare card compares (until the Changes view replaces it). */
  compared?: boolean;
  naming: boolean;
  /** One of an open group's versions, listed under it. */
  child?: boolean;
  /** Shown in a folded day (a named version, a turn): set in under the header, quieter (design QA G31). */
  folded?: boolean;
  /** A person's run of changes (a group row): its versions' total changes, and whether its versions are listed. */
  group?: boolean;
  groupCount?: number;
  /** A group's base: the version before its oldest (its title says what the group came to from there). */
  groupBase?: string | undefined;
  groupOpen?: boolean;
  onPick: (key: string, e: MouseEvent) => void;
  onMenu: (key: string, el: HTMLElement) => void;
  onName: (id: string, name: string | null) => void;
  onGroup: (key: string) => void;
  onBack: () => void;
  /** Its landmark (DESIGN-V2 §2.1), the best of them, and the next one's tag for its meta line ("also exported"). */
  mark?: Landmark;
  /** A Before landmark's next row, in words ("Restored the 11:02 am version"), for its title. */
  markAfter?: string | undefined;
  alsoMark?: string;
  /** A search's hit on it, and the query (its words are marked in the title). */
  hit?: FindHit;
  query?: string;
  /** Pick mode (DESIGN-V2 §4.1): every row offers ⇆ Compare; the one compared from wears the From pill. */
  picking?: boolean;
  pickFrom?: boolean;
  /** Held to peek: its time column says "Holding". */
  holding?: boolean;
  /** The panel is narrow (DESIGN-V2 §2.1, under 340 px): a landmark measures whether its title needs two lines. */
  narrow?: number;
  /** Its title takes two lines (design QA v2 G9), and how it says when that changes. */
  wrap?: boolean;
  onWrap?: (key: string, wrap: boolean) => void;
  /** Someone else's version, arrived while History is open: when (its ArrivalRing). A group's or a turn's: its newest's. */
  arrived?: number | undefined;
}

/**
 * A row's title, cut off at the panel's width with the whole of it on hover (P2-16). A sentence that ends in its place
 * in the edit ("Trimmed “Product close-up”, now ends at 0:05") is cut before that place, never inside its timecode:
 * the place goes onto a line of its own, which isn't shown, when the whole doesn't fit (design QA G14).
 */
function titleOf(title: string, sentence: boolean): ReactNode {
  const t = sentence ? sentenceTail(title) : null;
  if (!t?.tail) return h("span", { className: "carton-version-title", onMouseEnter: tipIfCut }, title);
  return h("span", { className: "carton-version-title", "data-tail": "", onMouseEnter: tipIfCut }, h("span", { className: "carton-version-head" }, t.head), h("span", { className: "carton-version-tail" }, t.tail));
}

// memo: a row re-renders only when its own version object or its own state changes. A new version arriving above it,
// the minute ticking, or a sync status change does not touch it (its time is a clock time, never "4 min ago").
const VersionRow = memo(function VersionRow(p: RowProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const v = p.v;
  const prompt = promptOf(v);
  const named = !!v.name && !prompt;
  const plain = prompt ? `“${prompt}”` : named ? v.name! : v.summary || versionLabel(v, { locale, actor: ui.actor.bind(ui), start: true });
  // a landmark reads as one phrase, its tag then its title ("EXPORTED 1080p for the client"); a turn keeps its prompt
  const mark = p.mark && p.mark.kind !== "turn" ? p.mark : undefined;
  // a closed group of a person's edits says what they came to (from before its oldest to its newest), never one step
  // the rest undid ("Removed track “Top”… · 19 changes" with Top there at the end: Windows check of b14f8a4e)
  const net = useNetWords(p.group && !p.groupOpen && !mark && !prompt && !named ? p.groupBase : undefined, v.ref);
  const title = mark ? landmarkTitle(mark, words, plain, p.markAfter) : net ?? plain;
  // what the version itself changed, under a landmark's title: a landmark is its title, never all it says (Windows
  // check of b14f8a4e: "Moved “B2”…" read only "EXPORTED 480p")
  const own = prompt ? `“${prompt}”` : v.summary || versionLabel(v, { locale, actor: ui.actor.bind(ui), start: true });
  const changed = mark && own !== title ? own : undefined;
  // a landmark's time is when it happened (exported, sent, named, the restore after a safety point), as `cb history
  // --landmarks` says it; on another day than its version's, that day
  const at = mark ? mark.at : v.at;
  const short = mark && dayNumber(mark.at) !== dayNumber(v.at) ? shortDate(mark.at, locale) : clockOfDay(at, locale);
  // a narrow panel: does this landmark's line overflow? (measured by its own font, the same whether it wraps or not)
  const titleRef = useRef<HTMLSpanElement>(null);
  const measures = !!mark && !!p.narrow && !p.naming && !p.child;
  const { onWrap, rowKey } = p;
  useLayoutEffect(() => {
    // (a row that is no landmark now, or being named, takes one line again: review of fix/ux2-last #1)
    if (!measures || !titleRef.current) {
      if (p.wrap) onWrap?.(rowKey, false);
      return;
    }
    const over = titleOverflows(titleRef.current);
    if (over !== !!p.wrap) onWrap?.(rowKey, over);
  }, [measures, title, mark?.kind, p.narrow, p.wrap, onWrap, rowKey]);
  const when = p.holding
    ? h("span", { className: "carton-version-when", "data-viewing": "" }, h(Icon, { name: "eye", size: 12 }), words.holding)
    : p.viewing
    ? h(
        "span",
        { className: "carton-version-when", "data-viewing": "" },
        h(Icon, { name: "eye", size: 12 }),
        words.viewingMark,
        h(
          "button",
          {
            type: "button",
            className: "carton-version-back",
            tabIndex: -1,
            "aria-label": words.backToMyEditKey,
            "data-carton-tip": words.backToMyEditKey,
            "data-carton-tip-end": "",
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              p.onBack();
            },
          },
          h(Icon, { name: "x", size: 11 }),
        ),
      )
    : p.now && !mark
      ? h("span", { className: "carton-version-when", "data-now": "" }, words.nowRow)
      : h(HoverMore, { as: "time", className: "carton-version-when", dateTime: new Date(at).toISOString(), short, more: exactTime(at, locale) });
  return h(
    "div",
    {
      id: p.domId,
      role: "option",
      "aria-selected": p.active,
      "aria-expanded": p.child ? undefined : p.open,
      className: "carton-version",
      style: { height: p.height },
      "data-kind": v.kind,
      "data-named": named ? "" : undefined,
      "data-prompt": prompt ? "" : undefined,
      "data-provisional": v.provisional ? "" : undefined,
      "data-active": p.active ? "" : undefined,
      "data-menu": p.menuOpen ? "" : undefined,
      "data-open": p.open ? "" : undefined,
      "data-now": p.now ? "" : undefined,
      "data-viewing": p.viewing ? "" : undefined,
      "data-compared": p.compared ? "" : undefined,
      "data-group": p.group ? "" : undefined,
      "data-child": p.child ? "" : undefined,
      "data-landmark": mark ? mark.kind : undefined,
      "data-pick-from": p.pickFrom ? "" : undefined,
      "data-hold": p.holding ? "" : undefined,
      "data-folded": p.folded ? "" : undefined,
      "data-wrap": p.wrap && measures ? "" : undefined,
      "data-arrived": p.arrived !== undefined ? "" : undefined,
      onClick: (e: MouseEvent) => p.onPick(p.rowKey, e),
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        p.onMenu(p.rowKey, e.currentTarget as HTMLElement);
      },
    },
    // (first: drawn under the row's ⋯; a new arrival in the row is a new ring)
    p.arrived !== undefined ? h(ArrivalRing, { key: `arrival:${p.arrived}`, actor: v.author, at: p.arrived }) : null,
    p.child ? h("span", { className: "carton-version-mark", "aria-hidden": true }) : mark ? h(LandmarkTile, { kind: mark.kind, picture: mark.picture }) : h(RowMark, { v }),
    p.naming
      ? h(
          "div",
          { className: "carton-version-main" },
          h(InlineName, {
            initial: v.name ?? "",
            placeholder: words.nameVersionPlaceholder,
            label: words.nameVersion,
            saveLabel: words.save,
            onSave: (name) => p.onName(v.id, name),
            onCancel: () => p.onName(v.id, null),
          }),
        )
      : h(
          Fragment,
          null,
          // cut off at the panel's width: the whole text on hover (P2-16)
          // (a landmark: its tag, then its title; a search's row: the words marked; else A's title, its place kept whole)
          mark || p.query
            ? h("span", { ref: titleRef, className: "carton-version-title", onMouseEnter: tipIfCut }, mark ? h(LandmarkTag, { kind: mark.kind }) : null, mark ? h("span", { className: "carton-landmark-title", "data-named": mark.kind === "named" ? "" : undefined }, p.query ? highlight(title, p.query) : title) : highlight(title, p.query!))
            : titleOf(title, !prompt && !named),
          p.picking && !p.pickFrom ? h("span", { className: "carton-version-pick", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare) : null,
          when,
          p.child
            ? null
            : h(
                "span",
                { className: "carton-version-meta" },
                p.pickFrom ? h("span", { className: "carton-pill carton-pick-from", "data-tone": "info" }, h(Icon, { name: "compare", size: 11 }), words.fromPill) : null,
                p.hit ? h(HitMeta, { hit: p.hit, v }) : mark ? h(MarkMeta, { mark, v, also: p.alsoMark, changed }) : h(Meta, { v, count: p.group ? p.groupCount : undefined, ui }),
                p.group
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "carton-version-group",
                        tabIndex: -1,
                        "aria-expanded": !!p.groupOpen,
                        "aria-label": p.groupOpen ? words.groupClose(p.groupCount ?? 0) : words.groupOpen(p.groupCount ?? 0),
                        onClick: (e: MouseEvent) => {
                          e.stopPropagation();
                          p.onGroup(p.rowKey);
                        },
                      },
                      h(Icon, { name: p.groupOpen ? "caretDown" : "caretRight", size: 10 }),
                    )
                  : null,
                v.provisional ? h("span", { className: "carton-pill", "data-tone": "wait", "aria-description": words.notSentHint }, h(Icon, { name: "cloudSlash", size: 11 }), words.notSentYet) : null,
                v.published ? h("span", { className: "carton-pill", "data-tone": "info" }, words.published) : null,
              ),
        ),
    p.naming || p.child
      ? null
      : h(
          "button",
          {
            type: "button",
            className: "carton-version-more",
            "aria-label": words.versionActions(title),
            tabIndex: -1,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              p.onMenu(p.rowKey, e.currentTarget as HTMLElement);
            },
          },
          h(Icon, { name: "dots" }),
        ),
  );
});

/**
 * History's start, one row (PLAN 0.4): "Project created", or "History starts here" for an imported project. No menu, no
 * card. It is always under its own day's header, so it doesn't say the date again (design QA G16).
 */
const StartRow = memo(function StartRow({ row, domId, active }: { row: Extract<HistoryRow, { kind: "start" }>; domId: string; active: boolean }) {
  const words = useWords();
  const locale = useLocale();
  return h(
    "div",
    { id: domId, role: "option", "aria-selected": active, className: "carton-version carton-start", style: { height: VERSION_ROW_HEIGHT }, "data-start": "", "data-active": active ? "" : undefined },
    h("span", { className: "carton-version-mark carton-mark-sign", "data-sign": "start", "aria-hidden": true }, h(Icon, { name: "flag", size: 12 })),
    h("span", { className: "carton-version-title" }, row.imported ? words.historyStartsHere : words.projectCreated),
    h(HoverMore, { as: "time", className: "carton-version-when", dateTime: new Date(row.at).toISOString(), short: clockOfDay(row.at, locale), more: exactTime(row.at, locale) }),
  );
});

/** An agent working (PLAN 0.7, DESIGN §6.1): its prompt, "Working", how far it got, and the line on turn holds. */
const WorkingRow = memo(function WorkingRow({ w, domId, active }: { w: Working; domId: string; active: boolean }) {
  const ui = useCartonUi();
  const words = useWords();
  const who = actorLabel(w.actor, ui.actor.bind(ui), words.you);
  return h(
    "div",
    { id: domId, role: "option", "aria-selected": active, className: "carton-version carton-working", style: { height: WORKING_ROW_HEIGHT }, "data-working": "", "data-active": active ? "" : undefined, "aria-label": `${words.agentWorking(who)}: ${w.label}` },
    h("span", { className: "carton-version-mark", "data-live": "", "aria-hidden": true }, h(Avatar, { actor: w.actor, size: 20, named: true })),
    h("span", { className: "carton-version-title", onMouseEnter: tipIfCut }, `“${w.label}”`),
    h("span", { className: "carton-version-when", "data-now": "" }, words.nowRow),
    h(
      "span",
      { className: "carton-version-meta" },
      h("span", { className: "carton-pill", "data-tone": "live" }, words.working),
      h(ActorName, { actor: w.actor }),
      h("span", { className: "carton-version-count" }, words.changesSoFar(w.edits)),
    ),
    h("span", { className: "carton-working-line" }, words.keepEditing(who)),
  );
});

/** A day's header (UI audit P2-17): which day; folded, how many versions (its named versions stay). */
const DayRow = memo(function DayRow({ row, label, domId, active, onToggle, marked }: { row: DayHistoryRow; label: string; domId: string; active: boolean; onToggle: (day: number) => void; marked?: boolean }) {
  const words = useWords();
  return h(
    "div",
    {
      id: domId,
      role: "option",
      "aria-selected": active,
      "aria-expanded": !row.collapsed,
      className: "carton-day",
      "data-active": active ? "" : undefined,
      "data-collapsed": row.collapsed ? "" : undefined,
      onClick: () => onToggle(row.day),
    },
    h("span", { className: "carton-day-mark", "aria-hidden": true }, h(Icon, { name: row.collapsed ? "caretRight" : "caretDown", size: 12 })),
    h("span", { className: "carton-day-label" }, label),
    // an open day shows no count; a folded one says what it holds (DESIGN §6.1)
    // (with landmarks, what a folded day keeps is its landmarks: "41 versions · 4 landmarks", DESIGN-V2 §2.5)
    row.collapsed && row.count ? h("span", { className: "carton-day-count" }, marked && row.count - row.hidden ? words.dayVersionsMarks(row.count, row.count - row.hidden) : words.dayVersions(row.count, row.count - row.hidden)) : null,
  );
});

/** A past day's changes between two landmarks (DESIGN-V2 §2.5): "› 18 changes by You and Claude Code"; a click opens them in place. */
const RunRow = memo(function RunRow({ row, domId, active, onToggle }: { row: RunHistoryRow; domId: string; active: boolean; onToggle: (key: string) => void }) {
  const words = useWords();
  const ui = useCartonUi();
  const names = [...new Set(row.authors.map((a) => actorLabel(a, ui.actor.bind(ui), words.you)).filter(Boolean))];
  return h(
    "div",
    { id: domId, role: "option", "aria-selected": active, "aria-expanded": row.open, className: "carton-day carton-run", "data-active": active ? "" : undefined, "data-open": row.open ? "" : undefined, onClick: () => onToggle(row.key) },
    h("span", { className: "carton-day-mark", "aria-hidden": true }, h(Icon, { name: row.open ? "caretDown" : "caretRight", size: 12 })),
    h("span", { className: "carton-day-label" }, words.runOf(row.count, names)),
  );
});

/** "Search every cut" (DESIGN-V2 §2.3): what it found, the other cuts' versions. */
interface EveryCut {
  readonly q: string;
  readonly cutId: string | undefined;
  readonly status: "loading" | "ready" | "error";
  readonly hits: readonly FindHit[];
}
/**
 * The other cuts' versions a search found once "Search every cut" was asked (DESIGN-V2 §2.3; design QA v2 G13): each
 * says which cut it is on (its dot and name) in its meta line; a click compares it with your edit, across cuts.
 */
function EveryCutHits({ found, here, onOpen }: { found: EveryCut; here: boolean; onOpen: (hit: FindHit) => void }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  // the keyboard stays here: the link it was on goes once asked (review of fix/ux2-last #5)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const a = document.activeElement;
    // (the link that went: focus fell to the body, still names the removed button, or is on "Searching every cut…")
    if (el && (!a || a === document.body || !a.isConnected || el.contains(a))) (el.querySelector<HTMLElement>(".carton-find-every-row") ?? el.querySelector<HTMLElement>("[tabindex]"))?.focus();
  }, [found.status]);
  if (found.status !== "ready" || !found.hits.length)
    return h("div", { ref: box, className: "carton-find-every" }, h("p", { className: "carton-find-empty-body carton-find-every-status", role: "status", tabIndex: -1 }, found.status === "loading" ? words.findingEveryCut : found.status === "error" ? words.findFailed : words.findNoneAnywhere(found.q.trim(), !here)));
  const cuts = ui.cuts();
  return h(
    "div",
    { ref: box, className: "carton-find-every" },
    h("p", { className: "carton-find-every-head", role: "status", tabIndex: -1 }, words.findOnOtherCuts(found.hits.length)),
    h(
      "ul",
      { className: "carton-find-every-list" },
      ...found.hits.map((x) => {
        const cut = cuts.find((c) => c.id === x.cutId);
        const where = cut ? cutRef(cut) : words.anotherCut;
        const who = actorLabel(x.author, ui.actor.bind(ui), words.you);
        return h(
          "li",
          { key: `${x.cutId}:${x.ref}` },
          h(
            "button",
            { type: "button", className: "carton-find-every-row", title: words.seeOnItsCut, onClick: () => onOpen(x) },
            h("span", { className: "carton-find-every-title" }, highlight(x.snippet, found.q)),
            // (a long cut name gives way, never who or when: "“Director's cut: punch…” · Director · 1:39 pm")
            h(
              "span",
              { className: "carton-find-every-meta" },
              cut ? h(CutDot, { cut }) : null,
              h("span", { className: "carton-find-every-cut" }, where),
              h("span", { className: "carton-find-every-when" }, [who, clock(x.at, { now, locale })].filter(Boolean).map((t) => `· ${t}`).join(" ")),
            ),
          ),
        );
      }),
    ),
  );
}

/**
 * The clip History is filtered to: its kind chip and name, then its credits, oldest first ("Added by You on Oct 30 ·
 * trimmed by Director · moved by You at 12:41 pm"; the verbs from what each change did: credits.ts, design QA G7).
 */
function ClipCredits({ item, name, title }: { item: string; name: string; title?: string }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const credits = useAsync<ClipCreditsView>(() => clipCredits(ui, item, words), [ui, item, words]);
  if (credits.status !== "ready" || !credits.value.parts.length) return null;
  const today = dayNumber(now);
  const text = credits.value.parts
    .map((l, i) => {
      const who = actorLabel(l.author, ui.actor.bind(ui), words.you);
      const when = l.at === undefined ? "" : dayNumber(l.at) === today ? words.creditAt(clockOfDay(l.at, locale)) : dayNumber(l.at) === today - 1 ? clock(l.at, { now, locale }) : words.creditOn(shortDate(l.at, locale));
      const s = words.creditPart(l.verb, who, when);
      return i === 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
    })
    .join(" · ");
  const kind = credits.value.kind;
  return h(
    "div",
    { className: "carton-clip-credits" },
    h(
      "div",
      { className: "carton-clip-credits-name" },
      kind ? h("span", { className: "carton-change-chip", "data-clip": kind, role: "img", "aria-label": words.clipKinds[kind] ?? kind }, h(Icon, { name: CLIP_ICON[kind] ?? "layers", size: 11 })) : null,
      // the clip as the timeline names it (the engine's answer may be its id)
      h("span", null, title ?? `“${name || credits.value.clip}”`),
    ),
    h("p", { title: text }, text),
  );
}

// ------------------------------------------------------------------------------------------------- the panel

export function HistoryPanel(props: HistoryPanelProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const listId = useId();
  const [filter, setFilterState] = useState<HistoryFilter>(props.filter ?? "all");
  // the clip a "Only “clip”" filter shows, by name (the selection is read when the menu opens)
  const [clipName, setClipName] = useState<string>("");
  const count = useHistoryCount(filter);
  const allCount = useHistoryCount("all");
  // The list re-renders when History changes at all (a provisional version confirmed); rows skip by identity.
  const revision = useTopic("history", (u) => u.history().revision());
  const hist = ui.history();
  const status = hist.status?.(filter) ?? { loading: false };
  const working = useWorking();
  const cutId = useCurrentCutId();
  // A teammate's cut on screen (PLAN 6.2, Workstream 6): it stays as its owner left it, so its versions offer no
  // Restore and no Undo this turn (fold it in or copy it as a new cut instead: TeammateCutActions above the list). Read
  // so a head moving doesn't re-render the list.
  const theirCut = useTopicSelector("cuts", (u) => !!u.cuts().find((c) => c.current)?.readOnly);
  const viewing = useViewing();
  const stageRef = useStageRef(ui);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cardMode, setCardMode] = useState<CardMode>(null);
  const [cardHeight, setCardHeight] = useState(CARD_ESTIMATE);
  // a menu's "Play its changes", or Space on a row: play as soon as its card has read what changed
  const [autoPlay, setAutoPlay] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; bottom?: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ clip: { id: string; name: string } | null } | null>(null);
  // The Changes view in place of the list (DESIGN §5.4): from a version to your edit (null) or to another version
  const [changesView, setChangesView] = useState<{ from: Version; to: Version | null } | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [folds, setFolds] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [scrolled, setScrolled] = useState(false);
  // design QA v2 G9: the panel's width while under 340 px (0 when wider), and the landmark rows whose titles take two lines
  const [narrow, setNarrow] = useState(0);
  const [wraps, setWraps] = useState<ReadonlySet<string>>(NO_WRAPS);
  const onWrap = useCallback((key: string, on: boolean) => setWraps((s) => {
    if (s.has(key) === on) return s;
    const n = new Set(s);
    if (on) n.add(key);
    else n.delete(key);
    return n;
  }), []);
  // the row at the top of the view: its day's header stays pinned there (DESIGN §6.1, sticky day headers)
  const [topRow, setTopRow] = useState(0);
  // Why the last action from a menu didn't happen, in the words the app gave.
  const [failed, setFailed] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const scrollTop = useRef<(() => void) | null>(null);
  // Carton UX v2 (DESIGN-V2 §2, §4): the landmarks, the search (its query, debounced by the field), the Landmarks
  // filter, and pick mode. Search and the Landmarks filter narrow the list to their versions (`only`), on top of the
  // filter: every row stays an ordinary row (its card, its ⋯, hold to peek, Shift+click).
  const marks = useLandmarks(cutId);
  // each Before landmark's next row in words (its restore, fold or bring-back), by ref: newest first, and only while
  // some are still to find (they sit just under their own rows)
  const afterWords = useMemo(() => {
    const want = new Set(marks.list.filter((l) => l.kind === "before" && l.after).map((l) => l.after!));
    const out = new Map<string, string>();
    const all = want.size && typeof hist.all === "function" ? hist.all() : [];
    for (let i = all.length - 1; i >= 0 && out.size < want.size; i--) if (want.has(all[i]!.ref) && all[i]!.summary) out.set(all[i]!.ref, all[i]!.summary);
    return out;
  }, [marks, hist, revision]);
  const [query, setQuery] = useState("");
  const searching = searchable(query) && typeof ui.find === "function";
  // (all of them once asked: "The newest 200 of 312 versions · Show them all"; a new query starts at the newest 200)
  const [findAll, setFindAll] = useState<string | null>(null);
  const found = useFind(searching ? query : "", cutId, { revision, ...(findAll === query ? { limit: 5000 } : {}) });
  const [marksOnly, setMarksOnly] = useState(false);
  // "Search every cut" from the empty state (DESIGN-V2 §2.3): N0's find across cuts, for this query only
  const [everyCut, setEveryCut] = useState<EveryCut | null>(null);
  // a search's own folded days (its older days fold after 20 results; a click opens one), new for each query
  const [findFolds, setFindFolds] = useState<{ q: string; days: ReadonlyMap<number, boolean> }>({ q: "", days: new Map() });
  const [pick, setPick] = useState<Picking | null>(null);
  // a polite line for screen readers (hold to peek's "Showing … Release to go back.")
  const [said, setSaid] = useState("");
  const search = useRef<SearchBoxHandle>(null);
  // a search within the Landmarks filter finds landmarks only: the chip says so (review of feat/ux2-n2 #4)
  const only = useMemo<{ has(id: string): boolean } | null>(
    () => (searching ? (marksOnly ? { has: (id: string) => found.byId.has(id) && marks.ids.has(id) } : found.byId) : marksOnly ? marks.ids : null),
    [searching, marksOnly, found.byId, marks.ids],
  );
  // what the list depends on of the search: nothing until it searches (one letter regroups nothing)
  const findKey = searching ? query : "";

  // ---------------------------------------------------------------- rows: days, groups, the start, an agent working
  const fkey = filterKey(filter);
  const versions = useMemo(() => {
    if (typeof hist.all !== "function") return null;
    const all = hist.all();
    // a search's or the Landmarks filter's versions (`only`), within the filter's
    if (filter === "all") return only ? all.filter((v) => only.has(v.id)) : all;
    // the filter's versions, in History's order, without describing any (indexOf is a lookup, at() would ask for a summary)
    return all.filter((v) => hist.indexOf(filter, v.id) >= 0 && (!only || only.has(v.id)));
    // `count` and `status.loading` too: a clip's index arrives after the filter is picked (remote.ts asks the worker),
    // with no new version, so History's revision doesn't move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, revision, fkey, count, status.loading, only]);
  const today = dayNumber(now);
  const grouped = useMemo(() => {
    if (!versions) return null;
    const long = versions.length > COLLAPSE_OVER;
    // A search's results are rows of their own (no runs), and its older days fold after 20 results ("3 more",
    // DESIGN-V2 §2.3). Elsewhere a landmark is a row of its own, and a folded day keeps it (§2.5, §2.6).
    if (searching) {
      const shut = new Set<number>();
      let seen = 0, last = NaN;
      for (let i = versions.length - 1; i >= 0; i--) {
        const d = dayNumber(versions[i]!.at);
        if (d !== last && seen >= 20) shut.add(d);
        last = d;
        seen++;
      }
      const own = findFolds.q === findKey ? findFolds.days : null;
      return groupHistory(versions, (day) => own?.get(day) ?? shut.has(day), { anchor: () => false });
    }
    const marked = marks.ids.size ? marks.ids : null;
    // a past day, open, reads as its landmarks and one line per run between them (DESIGN-V2 §2.5); the newest day too
    // when it isn't today (nothing happened today), below its newest few changes, kept as rows; never Today, nor a
    // filtered list (it lists what it matches)
    const story = marked && filter === "all" && !only ? { runs: (day: number) => day !== today, keepNewest: NEWEST_KEPT } : {};
    return groupHistory(versions, (day, newest) => folds.get(day) ?? (long && !newest), { group: true, open: (k) => openGroups.has(k), ...(marked ? { anchor: (v: Version) => !!v.name || marked.has(v.id), alone: (v: Version) => marked.has(v.id), ...story } : {}) });
    // `revision` too: a source's all() is one array it appends to in place (remote.ts, mock.ts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, revision, folds, openGroups, searching, marks, findFolds, findKey, today]);
  // the live row of an agent working on this cut, on top (in Today), in the lists that show turns
  const live = working && (!working.cutId || !cutId || working.cutId === cutId) && (filter === "all" || filter === "turns") ? working : null;
  const rows = useMemo<Row[] | null>(() => {
    if (!grouped) return null;
    if (!live) return grouped;
    const top = grouped[0];
    const w = { kind: "working", key: "working" } as const;
    if (top?.kind === "day" && top.day === today && !top.collapsed) return [top, w, ...grouped.slice(1)];
    return [{ kind: "day", key: `day:${today}`, day: today, count: 0, collapsed: false, hidden: 0 }, w, ...grouped];
  }, [grouped, live, today]);
  const rowIndex = useMemo(() => (rows ? new Map(rows.map((r, i) => [r.key, i])) : null), [rows]);
  // each row's day header (its index), for the header pinned at the top while that day scrolls by
  const dayOf = useMemo(() => {
    if (!rows) return null;
    const out = new Int32Array(rows.length);
    let d = -1;
    for (let i = 0; i < rows.length; i++) out[i] = rows[i]!.kind === "day" ? (d = i) : d;
    return out;
  }, [rows]);
  const newestId = useMemo(() => hist.at("all", 0)?.id ?? null, [hist, revision]);
  // Someone else's versions that arrive while History is open (arrivals.ts): their rows wear their colour. A step reads
  // only what arrived since the last; working alone, nothing ever arrives.
  const allLoading = !!hist.status?.("all").loading;
  const arrivalState = useRef<ArrivalState | null>(null);
  const arrivals = useMemo(
    () => (arrivalState.current = nextArrivals(arrivalState.current, typeof hist.all === "function" ? hist.all() : [], { source: hist, cut: cutId, rev: revision, loading: allLoading, now: Date.now() })),
    [hist, cutId, revision, allLoading],
  );
  // Only the start rows: History has nothing of the person's yet (the empty state)
  const onlyStart = !!rows && rows.every((r) => r.kind === "day" || r.kind === "start");

  const find = useCallback((id: string) => {
    const hs = ui.history();
    const i = hs.indexOf("all", id);
    return i >= 0 ? hs.at("all", i) : undefined;
  }, [ui]);
  /** The version a row stands for (a group: its newest), by the row's key. */
  const rowOf = useCallback((key: string | null) => (key && rows && rowIndex ? rows[rowIndex.get(key) ?? -1] : undefined), [rows, rowIndex]);
  const versionOfRow = useCallback(
    (r: Row | undefined): Version | undefined => {
      if (!r) return undefined;
      if (r.kind === "version" || r.kind === "group") return !rows ? undefined : only ? find(r.id) : hist.at(filter, r.index);
      return undefined;
    },
    [rows, hist, filter, only, find],
  );
  const versionAt = useCallback((i: number) => (rows ? versionOfRow(rows[i]) : hist.at(filter, i)), [rows, versionOfRow, hist, filter]);
  const keyAt = useCallback((i: number) => (rows ? (rows[i]?.key ?? String(i)) : (hist.at(filter, i)?.id ?? String(i))), [rows, hist, filter]);

  const toggleDay = useCallback((day: number) => {
    const r = rows?.find((x) => x.kind === "day" && x.day === day) as DayHistoryRow | undefined;
    if (searching) setFindFolds((f) => ({ q: findKey, days: new Map(f.q === findKey ? f.days : []).set(day, !(r?.collapsed ?? false)) }));
    else setFolds((m) => new Map(m).set(day, !(r?.collapsed ?? false)));
  }, [rows, searching, findKey]);
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  }, []);

  // ---------------------------------------------------------------- actions
  const setFilter = useCallback((f: HistoryFilter, name = "") => {
    setFilterState(f);
    setClipName(name);
    setOpenKey(null);
    setCardMode(null);
    setMenu(null);
    setActiveKey(null);
  }, []);
  const toList = useCallback(() => {
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(".carton-history-list")?.focus({ preventScroll: true }));
  }, []);
  const openCard = useCallback((key: string, mode: CardMode = null) => {
    setActiveKey(key);
    setOpenKey(key);
    setCardMode(mode);
    setFailed(null);
  }, []);
  const closeCard = useCallback(() => {
    setOpenKey(null);
    setCardMode(null);
    setAutoPlay(null);
  }, []);

  // ---------------------------------------------------------------- Play and Before (docs/carton-ux PLAN 4.2–4.3)
  // A card's Play all and ▶ go to Play (usePlayChanges) on the host's player, unless the host plays them itself
  // (`onPlay`): on the cut's newest version it plays on your edit, nothing viewed; on an older one it views it first.
  // Before shows how it was before the card's changes (a run of changes: before its oldest) at the same moment. The card
  // lights the row playing (`playing`); Play all again on the version paused in goes on from there.
  const onSeek = props.onSeek ?? props.play?.seek;
  // (`key`: the card it came from; a play belongs to its card. `ids`: its row's versions then, newest first; `base`: the
  // oldest's base, what Before shows)
  const [playReq, setPlayReq] = useState<PlayReq | null>(null);
  const pv = playReq?.req.version;
  const yourLength = playReq?.req.newest ? props.play?.length?.() : undefined;
  const beforeRef = playReq?.base ?? pv?.base;
  const cardPlay = usePlayChanges({
    changes: playReq?.req.changes ?? null,
    newer: !pv || playReq!.req.newest ? null : { kind: "version", versionId: pv.id, ref: pv.ref },
    older: pv && beforeRef && !pv.empty ? { kind: "before", versionId: pv.id, ref: beforeRef } : null,
    ...(yourLength && yourLength > 0 ? { length: yourLength } : {}),
    ...(props.play ? { host: props.play } : {}),
  });
  const cardPlayRef = useRef(cardPlay);
  cardPlayRef.current = cardPlay;
  const playReqRef = useRef(playReq);
  playReqRef.current = playReq;
  const openKeyRef = useRef(openKey);
  openKeyRef.current = openKey;
  // A play is its card's, not its version's (laptop B1): an edit of yours that joins the group it plays gives the row a
  // new newest version, and the card, its spinner and Space on the row go by the version the row shows now (`owner`).
  // The play carries on over the changes it started with (Pause, its lit row; Play all after a pause goes on from
  // there) while the row still holds every version it started with, from the same base, and edits only joined at its
  // newer end. A regroup that took one out (a version named in the middle splits the group: its older part keeps the
  // card) or moved its base makes it another card: the play ends (review of 48fd9936), as it does when an edit turns a
  // version into a group (the open card moved).
  const owner = useMemo((): Version | undefined => {
    if (!playReq || !rows) return playReq?.req.version;
    const r = rowOf(playReq.key), v = versionOfRow(r);
    if (!r || !v) return undefined;
    const ids = r.kind === "group" ? r.ids : [v.id], k = ids.length - playReq.ids.length;
    if (k < 0 || playReq.ids.some((id, i) => ids[k + i] !== id)) return undefined;
    return find(ids[ids.length - 1]!)?.base === playReq.base ? v : undefined;
  }, [playReq, rows, rowOf, versionOfRow, find]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const ownPlay = useCallback(
    (req: PlayRequest) => {
      const was = playReqRef.current, cp = cardPlayRef.current;
      if (was && was.key === openKeyRef.current && ownerRef.current && !req.only && !was.req.only && cp.status === "paused") return cp.toggle();
      // a person's run of changes (a group row): Before is before its oldest version
      const r = rowOf(openKeyRef.current);
      const first = r?.kind === "group" ? find(r.ids[r.ids.length - 1]!) : req.version;
      setPlayReq((p) => ({ req, key: openKeyRef.current, ids: r?.kind === "group" ? r.ids : [req.version.id], ...(first?.base ? { base: first.base } : {}), n: (p?.n ?? 0) + 1 }));
    },
    [rowOf, find],
  );
  // a request plays once its rows are the player's (the render that set it)
  useEffect(() => {
    if (!playReq) return;
    const { req } = playReq;
    if (req.only) cardPlayRef.current.playRow(req.changes.indexOf(req.only));
    else cardPlayRef.current.playAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playReq?.n]);
  // the card closed, or another one opened: its play is over, and Before lets go (review #2, #3)
  useEffect(() => {
    const r = playReqRef.current;
    if (!r || r.key === openKey) return;
    cardPlayRef.current.stop();
    setPlayReq(null);
  }, [openKey]);
  // its card is no longer the play's (a regroup, above): it ends, Before lets go, and Play all starts afresh
  useEffect(() => {
    if (!playReqRef.current || owner) return;
    cardPlayRef.current.stop();
    setPlayReq(null);
  }, [owner]);
  // a version that couldn't be loaded says so, in History's words (review #6), in its card (design QA G20)
  const playError = playReq ? cardPlay.error : null;
  const playId = owner?.id;
  const playLoading = cardPlay.status === "loading" ? (playId ?? null) : null;
  let litKey: string | null = null;
  for (const k of cardPlay.lit) litKey = playReq?.req.changes[k]?.key ?? null;
  const playOn = !!playReq && (cardPlay.status === "playing" || cardPlay.status === "loading");
  const ownPlaying = useMemo<PlayState | null>(() => (playOn && playId ? { versionId: playId, key: litKey } : null), [playOn, playId, litKey]);
  const play = props.onPlay ?? ownPlay;
  const pause = props.onPlay ? props.onPause : cardPlay.toggle;
  const playing = props.onPlay ? (props.playing ?? null) : ownPlaying;
  const onPlay = useCallback((req: PlayRequest) => {
    setAutoPlay(null);
    play(req);
  }, [play]);
  // the card's Before, while a play is on (BeforeButton shows itself then)
  const beforeBtn = props.onPlay ? null : h(BeforeButton, { play: cardPlay });
  // B held while History has focus is Before (DESIGN §7), stopped here: the editor's own B never sees it
  const onBeforeKey = (e: KeyboardEvent<HTMLElement>, up: boolean) => {
    if ((e.key !== "b" && e.key !== "B") || e.ctrlKey || e.metaKey || e.altKey || !cardPlay.before.available) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    if (up) cardPlay.before.release({ hold: true });
    else if (!e.repeat) cardPlay.before.pressKey();
  };
  // the panel's width, watched only to know when it is under 340 px (a landmark's title may wrap then: G9)
  const widthWatch = useRef<ResizeObserver | null>(null);
  const sectionRef = useCallback((el: HTMLElement | null) => {
    (panel as { current: HTMLElement | null }).current = el;
    cardPlayRef.current.rootRef(el);
    widthWatch.current?.disconnect();
    widthWatch.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      setNarrow(w > 0 && w < LANDMARK_WRAP_UNDER ? w : 0);
    });
    ro.observe(el);
    widthWatch.current = ro;
  }, []);

  // ---------------------------------------------------------------- the Changes view
  const versionByRef = useCallback((ref: string) => {
    const all = ui.history().all?.();
    if (all) for (let k = all.length - 1; k >= 0; k--) if (all[k]!.ref === ref) return all[k];
    return undefined;
  }, [ui]);
  const openChanges = useCallback(
    (a: string, b: string) => {
      const from = versionByRef(a);
      if (!from) return;
      const head = ui.cuts().find((c) => c.current)?.head;
      cardPlayRef.current.stop();
      setMenu(null);
      setChangesView({ from, to: b === head ? null : (versionByRef(b) ?? null) });
    },
    [ui, versionByRef],
  );
  const compare = props.onCompare ?? openChanges;
  // History's v2 Compare entries (Compare with…, the Compare button, See it first): the editor's Compare when the host
  // has it (N1's openCompare: any two refs, a cut, your edit), else `compare` above
  const openCmp = useMemo(() => openCompareVia(ui, compare), [ui, compare]);
  const compareTo = useCallback(
    (from: string, to: string | null, at?: number) => {
      setMenu(null);
      cardPlayRef.current.stop();
      const run = at !== undefined && typeof ui.openCompare === "function" ? ui.openCompare(from, to, { at }) : openCmp(from, to);
      return run.catch((e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.compareFailed));
    },
    [ui, openCmp, words],
  );
  const sideBySide = useCallback((a: string, b: string) => {
    cardPlayRef.current.stop();
    void ui.openCompare?.(a, b, { play: true }).catch((e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.compareFailed));
  }, [ui, words]);
  const startPick = useCallback((p: Picking) => {
    setMenu(null);
    setOpenKey(null);
    setCardMode(null);
    setPick(p);
  }, []);

  // The rows' handlers are one function each for the panel's life (memoized rows skip a new version: U6); what they
  // read as it is now comes through this ref.
  const live_ = useRef({ onCompare: compare, activeKey, versionOfRow, rowOf, pick, compareTo });
  live_.current = { onCompare: compare, activeKey, versionOfRow, rowOf, pick, compareTo };
  const onPick = useCallback((key: string, e: MouseEvent) => {
    const { onCompare, activeKey: from, versionOfRow: vOf, rowOf: rOf, pick: picking, compareTo: cmp } = live_.current;
    // pick mode (DESIGN-V2 §4.1): a click is the second version (the From row again: stop picking)
    if (picking && !e.shiftKey) {
      const v = vOf(rOf(key));
      if (!v || v.provisional) return;
      setPick(null);
      if (picking.from && picking.from.id === v.id) return;
      void cmp(picking.from ? picking.from.ref : v.ref, picking.from ? v.ref : null);
      return;
    }
    // Shift+click a second version: the changes between the two (the Changes view, Workstream 4)
    if (e.shiftKey && onCompare && from && from !== key) {
      const a = vOf(rOf(from)), b = vOf(rOf(key));
      if (a && b) {
        const [older, newer] = a.at <= b.at ? [a, b] : [b, a];
        onCompare(older.ref, newer.ref);
        return;
      }
    }
    setActiveKey(key);
    // a click opens the row's card (or closes it); it never changes what the editor shows (DESIGN §4.2)
    setOpenKey((k) => (k === key ? null : key));
    setCardMode(null);
    setFailed(null);
  }, []);
  // The menu opens below its row, or above it when there isn't room below (the last rows: P2-3). Opening it doesn't
  // make its row the active one: the row looks picked while its menu is open, and stops when it closes (P2-2).
  const onMenu = useCallback((key: string, el: HTMLElement) => {
    const box = panel.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setFailed(null);
    const below = box ? r.bottom - box.top + 4 : 0;
    const up = !!box && box.height - below < MENU_ROOM && r.top - box.top > box.height - below;
    setMenu({ key, x: box ? r.right - box.left : 0, y: below, ...(up && box ? { bottom: box.bottom - r.top + 4 } : {}) });
  }, []);
  const onName = useCallback(
    (id: string, name: string | null) => {
      setNaming(null);
      toList();
      if (name) void ui.nameVersion(id, name).catch((e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.failed));
    },
    [ui, toList, words],
  );
  const back = useCallback(() => void ui.view(null).catch(() => {}), [ui]);

  // Hold a row to peek (DESIGN-V2 §2.4): viewing, while held, through viewing's own fast back. A version still on its
  // way, an empty one or your edit now (the cut's newest) has nothing to peek at.
  const peekable = useCallback((v: Version | undefined) => (v && !v.provisional && !v.empty && v.id !== hist.at("all", 0)?.id ? v : undefined), [hist]);
  // a held row in words: its landmark as one phrase ("Exported 1080p for the client", "Before restoring the 11:02 am
  // version", "“Sent to client”"), else its version's label (DESIGN-V2 §2.4: the chip says what is held)
  const peekLabel = (v: Version) => {
    const mk = marks.byVersion.get(v.id)?.[0];
    const plain = versionLabel(v, { locale, actor: ui.actor.bind(ui) });
    if (!mk || mk.kind === "turn") return plain;
    const title = landmarkTitle(mk, words, v.name ?? plain, mk.kind === "before" && mk.after ? afterWords.get(mk.after) : undefined);
    if (mk.kind === "named") return `“${title}”`;
    if (mk.kind === "exported" || mk.kind === "before") {
      const tag = words.landmarkTags[mk.kind];
      // (a Before's title is one of History's own verbs, lowered after the tag; an export's is its own label, kept)
      return title === tag ? tag : mk.kind === "before" ? `${tag} ${title[0]!.toLowerCase()}${title.slice(1)}` : `${tag} ${title}`;
    }
    return title;
  };
  const peek = usePeek({
    ui,
    versionOf: (el) => {
      const key = el.id.startsWith(`${listId}-`) ? el.id.slice(listId.length + 1) : null;
      return pick ? undefined : peekable(versionOfRow(rowOf(key)));
    },
    ...(props.play?.prefetch ? { prefetch: props.play.prefetch } : {}),
    // the one thing said while held (DESIGN-V2 §2.4), and the chip's words: the row's landmark, "· holding"
    announce: (v) => setSaid(words.peekShowing(peekLabel(v))),
    labelOf: (v) => words.holdingLabel(peekLabel(v)),
  });
  useEffect(() => {
    if (!peek.holding) setSaid("");
  }, [peek.holding]);

  // Keyboard (DESIGN §7): Enter / → open a row's card, a day or a group, ← closes it; Space plays (or pauses) the
  // version's changes; F2 names it. Esc: stop viewing → close the card → close the panel (the host's), one at a time:
  // viewing is the layer inside the card, so from an open card the first Esc is the one the toast and the chip's ✕
  // promise, back to your edit, and the card stays (design QA G2).
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, i: number): boolean => {
      const r = rows ? rows[i] : undefined;
      const key = i >= 0 ? keyAt(i) : null;
      if (e.key === "Escape") {
        if (pick) return setPick(null), true;
        if (!openKey) return false;
        if (!stopViewing(ui)) closeCard();
        return true;
      }
      if (i < 0 || !key) return false;
      if (peek.keyDown(e, peekable(versionAt(i)))) return true;
      // Shift+↑↓: the Changes view between this version and the one above or below it (DESIGN §7)
      if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const a = versionAt(i), step = e.key === "ArrowDown" ? 1 : -1, n = rows ? rows.length : count;
        let b: Version | undefined;
        for (let j = i + step; j >= 0 && j < n && !(b = versionAt(j)); j += step);
        if (a && b && !a.provisional && !b.provisional) {
          const [older, newer] = a.at <= b.at ? [a, b] : [b, a];
          compare(older.ref, newer.ref);
        }
        return true;
      }
      if (e.key === "ArrowRight") {
        if (r?.kind === "day") {
          if (r.collapsed) toggleDay(r.day);
        } else if ((r?.kind === "group" || r?.kind === "run") && !r.open) toggleGroup(r.key);
        else if (r?.kind !== "start" && r?.kind !== "working" && r?.kind !== "run") openCard(key);
        return true;
      }
      if (e.key === "ArrowLeft") {
        if (openKey === key) closeCard();
        else if ((r?.kind === "group" || r?.kind === "run") && r.open) toggleGroup(r.key);
        else if (r?.kind === "day" && !r.collapsed) toggleDay(r.day);
        else if (r?.kind === "version" && r.child) {
          // from one of a group's versions, back to its group
          for (let k = i - 1; k >= 0; k--) if (rows![k]!.kind === "group") return setActiveKey(rows![k]!.key), true;
        } else if (r?.kind === "version" || r?.kind === "group") {
          // from a row of an open run (a past day's changes between two landmarks), back to its run: up past its other
          // rows, never past a landmark or a day (review of fix/ux2-last #7)
          for (let k = i - 1; k >= 0; k--) {
            const x = rows![k]!;
            if (x.kind === "run") return x.open && x.ids.includes(r.id) ? (setActiveKey(x.key), true) : true;
            if ((x.kind !== "version" && x.kind !== "group") || marks.ids.has(x.id)) break;
          }
        }
        return true;
      }
      if (e.key === " " || e.key === "Spacebar") {
        const v = versionAt(i);
        if (!v || r?.kind === "start" || r?.kind === "working") return false;
        if (playing && playing.versionId === v.id) pause?.();
        else {
          openCard(key);
          setAutoPlay(key);
        }
        return true;
      }
      if (e.key === "F2") {
        const v = versionAt(i);
        if (!v || v.provisional || r?.kind === "start" || r?.kind === "working") return false;
        setNaming(v.id);
        return true;
      }
      return false;
    },
    [rows, count, keyAt, openKey, closeCard, toggleDay, toggleGroup, openCard, versionAt, playing, pause, compare, ui, pick, peek, peekable, marks],
  );
  const onActivate = useCallback(
    (i: number) => {
      const r = rows?.[i];
      if (r?.kind === "day") return toggleDay(r.day);
      if (r?.kind === "run") return toggleGroup(r.key);
      if (r?.kind === "start" || r?.kind === "working") return;
      const key = keyAt(i);
      // Enter on a row while picking is that row as the second version
      if (pick) {
        const v = versionAt(i);
        if (v && !v.provisional) {
          setPick(null);
          if (!pick.from || pick.from.id !== v.id) void compareTo(pick.from ? pick.from.ref : v.ref, pick.from ? v.ref : null);
        }
        return;
      }
      setOpenKey((k) => (k === key ? null : key));
      setCardMode(null);
    },
    [rows, toggleDay, toggleGroup, keyAt, pick, versionAt, compareTo],
  );
  // The context-menu key on the active row opens its actions, anchored to the row.
  const onKeyMenu = useCallback(
    (i: number) => {
      const r = rows?.[i];
      if (r && r.kind !== "version" && r.kind !== "group") return;
      const key = keyAt(i);
      const row = [...(panel.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].find((el) => el.id === `${listId}-${key}`);
      if (row) onMenu(key, row.querySelector<HTMLElement>(".carton-version-more") ?? row);
    },
    [rows, keyAt, listId, onMenu],
  );

  // "Search every cut": the other cuts' versions (this cut's are the list's); a click compares one with your edit
  const searchEveryCut = useCallback(() => {
    const q = query;
    setEveryCut({ q, cutId, status: "loading", hits: [] });
    const done = (e: EveryCut) => setEveryCut((x) => (x && x.q === q && x.cutId === cutId ? e : x));
    // (the newest hits of every cut, this one's too: asked for past this cut's own, so 50 of the others' remain;
    // review of fix/ux2-last #3)
    const mine = found.status === "ready" ? found.total : 0;
    ui.find!(q.trim(), { allCuts: true, limit: Math.min(5000, 50 + mine) }).then(
      (r) => done({ q, cutId, status: "ready", hits: r.hits.filter((x) => x.cutId !== cutId).slice(0, 50) }),
      () => done({ q, cutId, status: "error", hits: [] }),
    );
  }, [ui, query, cutId, found]);
  // (for this query on this cut: another cut switched to starts over, review of fix/ux2-last #4)
  const elsewhere = everyCut && everyCut.q === query && everyCut.cutId === cutId ? everyCut : null;
  // a click views that version, as a teammate's cut opens (DESIGN-V2 §2.3; review of fix/ux2-last #2)
  const viewElsewhere = useCallback((x: FindHit) => {
    const cut = ui.cuts().find((c) => c.id === x.cutId);
    setFailed(null);
    void ui.view({ kind: "version", ref: x.ref, label: words.versionOnCut(cut ? cutRef(cut) : words.anotherCut, clockOfDay(x.at, locale)) }).catch((e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.findFailed));
  }, [ui, words, locale]);

  // ---------------------------------------------------------------- what the list shows
  const active = activeKey ? (rowIndex ? (rowIndex.get(activeKey) ?? -1) : hist.indexOf(filter, activeKey)) : -1;
  // (the open card's row as it is now: a run of changes that grew since keeps its card in this very render)
  const openNow = openKey && rowIndex && !rowIndex.has(openKey) ? rowsFollow(rows, openKey) : openKey;
  const openAt = openNow ? (rowIndex ? (rowIndex.get(openNow) ?? -1) : hist.indexOf(filter, openNow)) : -1;
  // A person's run of changes grows at its newer end as they edit, and its row's key is its newest version's: its open
  // card, its listed versions and the keyboard's row follow it there (a version that joins a run follows it too). A
  // card whose row went otherwise (a filter, a day folded) closes.
  const follow = useCallback((key: string | null): string | null => (!key || !rows || !rowIndex || rowIndex.has(key) ? key : rowsFollow(rows, key)), [rows, rowIndex]);
  useEffect(() => {
    if (!rows || !rowIndex) return;
    if (openKey && !rowIndex.has(openKey)) {
      const k = follow(openKey);
      if (k) setOpenKey(k);
      else closeCard();
    }
    if (activeKey && !rowIndex.has(activeKey)) {
      // (a row of a run closed meanwhile: the run, review of fix/ux2-last #7)
      const id = activeKey.startsWith("group:") ? activeKey.slice(6) : activeKey;
      const k = follow(activeKey) ?? rows.find((x) => x.kind === "run" && x.ids.includes(id))?.key;
      if (k) setActiveKey(k);
    }
    // (a group hidden by a folded day or a filter is closed: review #1, a key kept that no row has looped renders)
    if ([...openGroups].some((k) => !rowIndex.has(k))) {
      const next = new Set<string>();
      for (const k of openGroups) {
        const f = follow(k);
        if (f) next.add(f);
      }
      setOpenGroups((s) => (s.size === next.size && [...next].every((k) => s.has(k)) ? s : next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  useEffect(() => {
    if (openKey && openAt < 0 && !rows) closeCard();
  }, [openKey, openAt, rows, closeCard]);
  const expanded = openAt >= 0 ? { index: openAt, extra: cardHeight + CARD_GAP } : null;
  const wrapping = narrow ? wraps : NO_WRAPS;
  // (a landmark row's own: a key left in `wraps` by a row no longer a landmark gives no height; review of fix/ux2-last #1)
  const wrapsAt = useCallback((r: Row | undefined) => {
    if (!r || r.kind !== "version" || r.child || !wrapping.has(r.key)) return false;
    const mk = marks.byVersion.get(r.id)?.[0];
    return !!mk && mk.kind !== "turn";
  }, [wrapping, marks]);
  const heightOf = useCallback(
    (i: number) => {
      const r = rows?.[i];
      return !r ? VERSION_ROW_HEIGHT : r.kind === "day" ? DAY_ROW_HEIGHT : r.kind === "run" ? RUN_ROW_HEIGHT : r.kind === "working" ? WORKING_ROW_HEIGHT : r.kind === "version" && r.child ? CHILD_ROW_HEIGHT : wrapsAt(r) ? LANDMARK_WRAP_ROW_HEIGHT : VERSION_ROW_HEIGHT;
    },
    [rows, wrapsAt],
  );
  // the tops are rebuilt when a row's height changes: the rows, or which landmarks wrap
  const layoutKey = useMemo(() => [rows, wrapsAt], [rows, wrapsAt]);
  // the row of what the editor shows: never a version still loading, nor one that failed to (design QA G1, review #1)
  const shown = stageRef === undefined ? viewing : stageRef === null ? null : viewing?.ref === stageRef ? viewing : ((ui as StageUi).stageView?.() ?? null);
  const viewedId = shown && (shown.kind === "version" || shown.kind === "before") ? (shown.versionId ?? null) : null;
  // a landmark's picture, made when the stage shows its version: held, viewed (not "before" it), or your edit while it
  // is that version (DESIGN-V2 §2.2); never while something plays or loads
  // (what the stage shows, by the host's stage: a peek's version too, once it is on screen)
  useStagePictures({ marks, shownId: shown ? (shown.kind === "version" ? (shown.versionId ?? null) : null) : viewing ? null : newestId, busy: playOn, capture: props.capturePicture ?? props.play?.picture });

  const renderRow = (i: number): ReactNode => {
    const r = rows?.[i];
    const key = keyAt(i);
    const domId = `${listId}-${key}`;
    if (r?.kind === "day") return h(DayRow, { row: r, label: dayLabel(r.day, today, locale, { today: words.today, yesterday: words.yesterday }), domId, active: key === activeKey, onToggle: toggleDay, marked: marks.ids.size > 0 && !searching });
    if (r?.kind === "start") return h(StartRow, { row: r, domId, active: key === activeKey });
    if (r?.kind === "run") return h(RunRow, { row: r, domId, active: key === activeKey, onToggle: toggleGroup });
    if (r?.kind === "working") return live ? h(WorkingRow, { w: live, domId, active: key === activeKey }) : null;
    const v = versionAt(i);
    if (!v) return null;
    const group = r?.kind === "group" ? r : null;
    const child = r?.kind === "version" && !!r.child;
    const isOpen = key === openNow;
    const row = h(VersionRow, {
      v,
      rowKey: key,
      domId,
      height: child ? CHILD_ROW_HEIGHT : wrapsAt(r) ? LANDMARK_WRAP_ROW_HEIGHT : VERSION_ROW_HEIGHT,
      narrow,
      wrap: wrapping.has(key),
      onWrap,
      active: key === activeKey,
      menuOpen: key === menu?.key,
      open: isOpen,
      now: v.id === newestId && !live && !child,
      viewing: !!viewedId && (v.id === viewedId || (!!group && group.ids.includes(viewedId))),
      naming: naming === v.id,
      child,
      folded: !!dayOf && dayOf[i]! >= 0 && !!(rows![dayOf[i]!] as DayHistoryRow).collapsed,
      group: !!group,
      groupCount: group?.count,
      groupBase: group ? find(group.ids[group.ids.length - 1]!)?.base : undefined,
      groupOpen: group?.open,
      onPick,
      onMenu,
      onName,
      onGroup: toggleGroup,
      onBack: back,
      mark: marks.byVersion.get(v.id)?.[0],
      markAfter: (() => {
        const mk = marks.byVersion.get(v.id)?.[0];
        return mk?.kind === "before" && mk.after ? afterWords.get(mk.after) : undefined;
      })(),
      alsoMark: (() => {
        const xs = marks.byVersion.get(v.id);
        // ("also exported", "also sent"; a day's start under another landmark is no news)
        return xs && xs.length > 1 && xs[0]!.kind !== "turn" && xs[1]!.kind !== "start" ? words.landmarkTags[xs[1]!.kind] || undefined : undefined;
      })(),
      hit: searching ? found.byId.get(v.id) : undefined,
      query: searching ? query : undefined,
      picking: !!pick,
      pickFrom: !!pick?.from && pick.from.id === v.id,
      // "Holding" once the stage shows it (the host's stage: never while it still loads, as Viewing; design QA G1)
      holding: peek.holding === v.id && viewedId === v.id,
      // someone else's, arrived while History is open: a group's or a turn's row by its newest version (the one it shows)
      arrived: arrivals.at.get(v.id),
    });
    // the same shape open or closed (the row, then its card or nothing), so opening the card keeps the row's own DOM
    if (!isOpen) return h(Fragment, null, row, null);
    const versionsOf = group ? group.ids.map((id) => find(id)).filter((x): x is Version => !!x) : undefined;
    return h(
      Fragment,
      null,
      row,
      h(CardHost, {
        key: `card:${key}`,
        id: `${domId}-card`,
        version: v,
        group: versionsOf,
        newest: v.id === newestId,
        readOnly: theirCut,
        mode: cardMode,
        onMode: setCardMode,
        // "See them", "See the 4", a long list: the Changes view (Workstream 4), or the host's own
        onCompare: compare,
        onPlay,
        onPause: pause,
        playing,
        loading: playLoading === v.id,
        playError: playReq?.key === key ? playError : null,
        before: beforeBtn,
        // ⇆ Side by side while its Play runs (Compare in the editor: the host's openCompare, still playing)
        ...(typeof ui.openCompare === "function" ? { onSideBySide: sideBySide } : {}),
        autoPlay: autoPlay === key,
        onSeek,
        onMenu: (el: HTMLElement) => onMenu(key, el),
        ...(props.selectedClip ? { selectedClip: props.selectedClip } : {}),
        onSeeFirst: (ver: Version, c: ClipChoice) => void compareTo(ver.ref, null, (c.now ?? c.then)?.[0]),
        onClose: () => {
          closeCard();
          toList();
        },
        onHeight: setCardHeight,
      }),
    );
  };

  // ---------------------------------------------------------------- the row menu (DESIGN §6.1, PLAN 3.5)
  const menuRow = menu ? rowOf(menu.key) : undefined;
  const menuVersion = menu ? (rows ? versionOfRow(menuRow) : find(menu.key)) : undefined;
  const waiting = !!menuVersion?.provisional;
  const closeMenu = () => setMenu(null);
  const head = () => ui.cuts().find((c) => c.current)?.head;
  const rowMenu =
    menu && menuVersion
      ? h(
          MenuList,
          {
            label: words.versionActions(versionLabel(menuVersion, { locale, actor: ui.actor.bind(ui) })),
            onClose: (why?: string) => {
              const key = menu.key;
              setMenu(null);
              // Esc (the keyboard): back to the list on the row whose menu it was, so ↓ goes on from there, not from
              // the top (regress 2026-11-02 P3-5). A click elsewhere leaves no row picked (P2-2).
              if (why === "escape") {
                setActiveKey(key);
                toList();
              }
            },
            className: "carton-history-menu",
            style: menu.bottom != null ? { position: "absolute", bottom: menu.bottom, left: Math.max(8, menu.x - 260) } : { position: "absolute", top: menu.y, left: Math.max(8, menu.x - 260) },
          },
          // A version still waiting to be sent can't be played, compared, named or restored yet (L5). An empty one
          // (the start of an imported project's history) has nothing to play, restore or make a cut from.
          menuVersion.empty
            ? null
            : h(MenuItem, { icon: "play", disabled: waiting, title: waiting ? words.availableOnceSent : undefined, onSelect: () => (closeMenu(), openCard(menu.key), setAutoPlay(menu.key)) }, words.playItsChanges),
          h(MenuItem, {
            icon: "layers",
            disabled: waiting,
            onSelect: () => {
              closeMenu();
              const b = head() ?? props.currentRef;
              if (b) compare(menuVersion.ref, b);
            },
          }, words.compareWithYourEdit),
          // pick mode (DESIGN-V2 §4.1): this version, and the one clicked next, in any cut
          h(MenuItem, { icon: "compare", disabled: waiting, onSelect: () => startPick({ from: menuVersion }) }, words.compareWith),
          h(MenuSeparator, null),
          h(MenuItem, { icon: "bookmark", disabled: waiting, title: waiting ? words.availableOnceSent : undefined, onSelect: () => (closeMenu(), setNaming(menuVersion.id)) }, menuVersion.name && !promptOf(menuVersion) ? words.renameEllipsis : words.nameVersion),
          menuVersion.empty ? null : h(MenuItem, { icon: "cut", disabled: waiting, onSelect: () => (closeMenu(), openCard(menu.key, "newCut")) }, words.newCutFromVersion),
          menuVersion.foldRest
            ? h(MenuItem, { icon: "foldIn", onSelect: () => (closeMenu(), void ui.foldRest(menuVersion.id).then((r) => !r.ok && setFailed(r.error ?? words.failed), (e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.failed))) }, words.foldRest)
            : null,
          // the newest version is your edit: nothing to go back to. An empty one says why it can't be restored. A
          // teammate's cut has no Restore at all (Workstream 6).
          theirCut || (menuVersion.id === newestId && !menuVersion.empty) ? null : h(MenuSeparator, null),
          theirCut || (menuVersion.id === newestId && !menuVersion.empty)
            ? null
            : h(MenuItem, { icon: "restoreArc", disabled: waiting || !!menuVersion.empty, title: menuVersion.empty ? words.emptyVersionHint : waiting ? words.availableOnceSent : words.restoreMenuHint, onSelect: () => (closeMenu(), openCard(menu.key, "restore")) }, words.restoreEllipsis),
          // an older agent turn: Go back… with its Undo picked (DESIGN-V2 §3.1: the consequence is read first)
          theirCut || menuVersion.id === newestId || menuVersion.provisional || !(menuVersion.author.kind === "agent" || menuVersion.author.kind === "subagent") || !(menuVersion.kind === "turn" || menuVersion.turn)
            ? null
            : h(MenuItem, { icon: "undo", onSelect: () => (closeMenu(), openCard(menu.key, "undoTurn")) }, words.undoThisTurn),
        )
      : null;

  // ---------------------------------------------------------------- the filter (DESIGN §6.1, PLAN 3.2)
  const openFilter = () => {
    if (filterMenu) return setFilterMenu(null);
    const clip = props.selectedClip?.() ?? null;
    setFilterMenu({ clip: clip ? { id: clip.id, name: clip.name } : null });
  };
  const pickFilter = (f: HistoryFilter, name = "") => {
    setFilterMenu(null);
    setFilter(f, name);
    filterBtn.current?.focus({ preventScroll: true });
  };
  const filterLabel = typeof filter === "object" ? words.onlyClip(clipName || words.version) : filter === "all" ? (marksOnly ? words.landmarksFilter : "") : words.filters[filter];
  const filterChoices = ["all", "named", "turns", "mine"] as const;
  const filterPop = filterMenu
    ? h(
        MenuList,
        {
          label: words.show,
          className: "carton-filter-menu",
          ignore: () => [filterBtn.current],
          onClose: (why) => {
            setFilterMenu(null);
            if (why === "escape") filterBtn.current?.focus({ preventScroll: true });
          },
        },
        h(MenuLabel, null, words.show),
        ...filterChoices.flatMap((f) => [
          h(MenuItem, { key: f, checked: filter === f && !marksOnly, onSelect: () => (setMarksOnly(false), pickFilter(f)) }, words.filters[f]),
          // Landmarks, second after All versions (DESIGN-V2 §2.5): the story of the project in a screenful
          f === "all" && marks.ids.size > 0
            ? h(MenuItem, { key: "landmarks", checked: marksOnly, title: words.landmarksFilterHint, onSelect: () => (pickFilter("all"), setMarksOnly(true)) }, words.landmarksFilter)
            : null,
        ]),
        filterMenu.clip
          ? [
              h(MenuSeparator, { key: "s" }),
              h(MenuItem, { key: "clip", checked: typeof filter === "object" && filter.item === filterMenu.clip.id, title: words.onlyClipHint, onSelect: () => pickFilter({ item: filterMenu.clip!.id }, filterMenu.clip!.name) }, words.onlyClip(filterMenu.clip.name)),
            ]
          : null,
      )
    : null;

  // ---------------------------------------------------------------- the panel
  // one element for the panel's life: History re-rendering for a new version never re-renders the cuts menu (U6)
  const ownCuts = useMemo(() => h(CutsMenu, null), []);
  const cut = props.cuts === undefined ? ownCuts : props.cuts;
  const stickyAt = scrolled && rows && dayOf && topRow < rows.length ? dayOf[topRow]! : -1;
  const sticky = stickyAt >= 0 && stickyAt < topRow ? (rows![stickyAt] as DayHistoryRow) : null;
  // (a search's or the Landmarks filter's narrowed list says nothing of History itself: the field stays while it loads)
  const nothing = allCount === 0 || (filter === "all" && !only && onlyStart);
  // a search or the Landmarks filter counts what it narrowed the list to (DESIGN-V2 §2.3, §2.5)
  const listed = only ? (versions?.length ?? 0) : count;
  // (a search on its way: the last results stay on screen, and "nothing found" waits for its answer)
  const findWaits = searching && (found.q !== query || found.status === "loading");
  const empty = !status.loading && !findWaits && (listed === 0 || (filter === "all" && !only && onlyStart));
  const loading = (status.loading && count === 0) || (findWaits && found.status !== "ready" && listed === 0);
  // "“Intro”, the clip" first, when the newest hits name one clip (DESIGN-V2 §2.3)
  const clipHit = searching && found.status === "ready" ? (found.clips[0] ?? null) : null;
  // ← History from the Changes view: back on the row it came from (a run of changes: its group's row)
  const closeChanges = () => {
    const from = changesView?.from;
    setChangesView(null);
    if (from) setActiveKey(follow(from.id) ?? from.id);
    toList();
  };
  if (changesView)
    return h(
      "section",
      { ref: sectionRef, className: cx("carton-history", props.className), "aria-label": words.history, "data-changes": "" },
      h(ChangesView, { from: changesView.from, to: changesView.to, onBack: closeChanges, noRestore: theirCut, ...(props.play ? { host: props.play } : {}) }),
    );

  return h(
    "section",
    {
      ref: sectionRef,
      className: cx("carton-history", props.className),
      "aria-label": words.history,
      "data-menu-open": menu ? "" : undefined,
      "data-scrolled": scrolled ? "" : undefined,
      "data-picking": pick ? "" : undefined,
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        // Ctrl+F or / while History has focus: the search field (DESIGN-V2 §2.3)
        const t = e.target as HTMLElement;
        if (((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === "/" && !e.ctrlKey && !e.metaKey && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) {
          if (search.current) {
            e.preventDefault();
            e.stopPropagation();
            search.current.focus();
            return;
          }
        }
        // Esc in pick mode stops picking, wherever the keyboard is in History (a menu's or the card's own goes first)
        if (e.key === "Escape" && pick && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          setPick(null);
          return;
        }
        onBeforeKey(e, false);
      },
      onKeyUp: (e: KeyboardEvent<HTMLElement>) => {
        peek.keyUp(e);
        onBeforeKey(e, true);
      },
    },
    h(
      "header",
      { className: "carton-panel-head carton-cutbar" },
      cut,
      // (the cuts menu grows into the bar itself: its Viewing pill on a teammate's cut sits at the bar's right)
      cut == null ? h("span", { className: "carton-cutbar-gap" }) : null,
      // ⇆ Compare (DESIGN-V2 §4.2): the questions people ask, "Compare your edit with…"
      nothing ? null : h(CompareButton, { landmarks: marks.list, today, dayOf: dayNumber, onCompare: compareTo, onPick: startPick, findVersion: find }),
      (nothing && filter === "all") || pick?.cut
        ? null
        : h(
            "span",
            { className: "carton-menu-anchor carton-filter-anchor", "data-align": "end" },
            h(
              "button",
              {
                ref: filterBtn,
                type: "button",
                className: "carton-filter-btn",
                "aria-label": words.show,
                "aria-haspopup": "menu",
                "aria-expanded": !!filterMenu,
                "data-active": filter !== "all" || filterMenu ? "" : undefined,
                "data-carton-tip": filterMenu ? undefined : words.show,
                "data-carton-tip-end": "",
                onClick: openFilter,
              },
              h(Icon, { name: "filter", size: 16 }),
            ),
            filterPop ? h("div", { className: "carton-menu-pop" }, filterPop) : null,
          ),
    ),
    props.actions ?? null,
    // the search field, always shown under the cut bar (DESIGN-V2 §2.3), once there is something to find
    typeof ui.find === "function" && !nothing ? h(SearchBox, { handle: search, onQuery: setQuery, onDown: toList }) : null,
    pick ? h(PickLine, { pick, onCompare: compareTo, onLeave: () => setPick(null), onCut: (c) => setPick({ from: pick.from, cut: c }) }) : null,
    (filter !== "all" || marksOnly) && !pick?.cut
      ? h(
          "div",
          { className: "carton-filter-chips" },
          h(
            "span",
            { className: "carton-filter-chip" },
            h("span", { className: "carton-filter-chip-text" }, filterLabel),
            h("button", { type: "button", className: "carton-filter-chip-x", "aria-label": words.removeFilter, "data-carton-tip": words.removeFilter, onClick: () => (setMarksOnly(false), setFilter("all")) }, h(Icon, { name: "x", size: 11 })),
          ),
          status.since !== undefined ? h("span", { className: "carton-filter-note" }, words.clipSince(clock(status.since, { now, locale }))) : null,
        )
      : null,
    typeof filter === "object" && !pick?.cut ? h(ClipCredits, { key: filter.item, item: filter.item, name: clipName }) : null,
    clipHit && typeof filter !== "object" && !pick?.cut
      ? h(
          "div",
          { className: "carton-find-clip" },
          h(ClipCredits, { key: clipHit.itemId, item: clipHit.itemId, name: clipHit.name, title: words.findClip(clipHit.name) }),
          clipHit.deleted ? null : h(Button, { className: "carton-find-only", onClick: () => (search.current?.clear(), pickFilter({ item: clipHit.itemId }, clipHit.name)) }, words.onlyThisClip),
        )
      : null,
    searching && found.status === "ready" && listed && !pick?.cut
      ? h(
          "p",
          { className: "carton-find-count", role: "status" },
          found.total > found.hits.length ? words.findShowing(found.hits.length, found.total) : words.findCount(found.total),
          found.total > found.hits.length ? h("button", { type: "button", className: "carton-link carton-find-all", onClick: () => setFindAll(query) }, words.findShowAll) : null,
        )
      : null,
    failed ? h("p", { className: "carton-error carton-history-error", role: "alert" }, failed) : null,
    // Compare with… on another cut (N2c): that cut's History, to pick the second version from
    pick?.cut
      ? h(CutPicker, {
          key: pick.cut.id,
          cut: pick.cut,
          // the search field searches the cut shown (review of feat/ux2-n2c #2)
          query,
          initialHeight: props.initialHeight,
          onBack: () => setPick({ from: pick.from }),
          onPick: (ref: string) => {
            const from = pick.from;
            setPick(null);
            void compareTo(from ? from.ref : ref, from ? ref : null);
          },
        })
      : loading
      ? h(
          "div",
          { className: "carton-history-skeleton", role: "status", "aria-label": words.history },
          ...[0, 1, 2].map((k) => h("div", { key: k, className: "carton-skeleton-row" }, h("span"), h("span"), h("span"))),
        )
      : empty && searching
        ? h(
            Fragment,
            null,
            h(
            "div",
            { className: "carton-find-empty", role: "status" },
            h("p", { className: "carton-find-empty-title" }, found.status === "error" ? words.findFailed : words.findNone(query.trim())),
            h("p", { className: "carton-find-empty-body" }, words.findNoneHint),
            h(
              "p",
              { className: "carton-find-empty-body" },
              words.findSearched(ui.cuts().find((c) => c.current)?.label ?? words.mainCut),
              // (once asked, what it found is under these lines; one cut only: nothing more to search)
              !elsewhere && found.status === "ready" && ui.cuts().length > 1 ? [" ", h("button", { key: "every", type: "button", className: "carton-link carton-find-every-btn", onClick: searchEveryCut }, words.searchEveryCut)] : null,
            ),
            // (a filter on top of the newest results only: the rest may hold what it looks for)
            found.status === "ready" && found.total > found.hits.length ? h(Button, { onClick: () => setFindAll(query) }, words.findShowAll) : null,
            h(Button, { onClick: () => (search.current?.clear(), search.current?.focus()) }, words.clearFind),
            ),
            // (beside the status line, not in it: the list isn't read out as one announcement, review #5)
            elsewhere ? h(EveryCutHits, { found: elsewhere, here: found.status === "ready" && found.total > 0, onOpen: viewElsewhere }) : null,
          )
      : empty && marksOnly
        ? h("p", { className: "carton-empty" }, words.landmarksEmpty)
      : empty
        ? filter === "all"
          ? h(EmptyHistory, { start: rows?.find((r) => r.kind === "start") as Extract<HistoryRow, { kind: "start" }> | undefined })
          : h("p", { className: "carton-empty" }, typeof filter === "object" ? words.clipEmpty(clipName || words.version) : words.filterEmpty[filter])
        : h(
            "div",
            { className: "carton-history-body", ...peek.list },
            h(VirtualList, {
              key: fkey,
              className: "carton-history-list",
              label: words.history,
              count: rows ? rows.length : listed,
              rowHeight: VERSION_ROW_HEIGHT,
              heightOf,
              layoutKey,
              onScrolledChange: setScrolled,
              initialHeight: props.initialHeight,
              newestFirst: true,
              expanded,
              active,
              activeId: (i: number) => `${listId}-${keyAt(i)}`,
              onActiveChange: (i: number) => setActiveKey(keyAt(i)),
              onMenu: onKeyMenu,
              onActivate,
              onKey,
              scrollTopRef: scrollTop,
              onFirstVisible: setTopRow,
              firstVisibleAt: DAY_ROW_HEIGHT,
              rowKey: keyAt,
              renderRow,
            }),
            // the day scrolled into keeps its header on top (a click folds it, as the header's own does)
            sticky
              ? h(
                  "div",
                  { className: "carton-day-sticky", "aria-hidden": true },
                  h(DayRow, { row: sticky, label: dayLabel(sticky.day, today, locale, { today: words.today, yesterday: words.yesterday }), domId: `${listId}-sticky`, active: false, onToggle: toggleDay }),
                )
              : null,
            // "↑ Newest", in a strip of its own under the list while it is scrolled: it covers no row's text
            scrolled
              ? h(
                  "div",
                  { className: "carton-newest" },
                  h("button", { type: "button", className: "carton-newest-btn", onClick: () => scrollTop.current?.() }, h(Icon, { name: "arrowUp", size: 12 }), words.newest),
                )
              : null,
          ),
    rowMenu,
    h("p", { className: "carton-sr", role: "status", "aria-live": "polite" }, said),
    // (its own component: what it says never re-renders the list; `added` keeps its identity while nothing arrives)
    h(ArrivalNews, { added: arrivals.added, holding: !!peek.holding }),
  );
}

/**
 * What the ring shows, said for screen readers in a line of its own: "Leo made a change". Once the versions are
 * described (a teammate's live version is told by person then: "Leo", never "Teammate"), or 1.5 s on; a person again
 * only after a quiet minute (their agent's turn goes on without a word a version); never while a row is held (its own
 * line speaks then). Nothing in the DOM, no render and no timer until someone else's version arrives: working alone,
 * History is as it was.
 */
const ArrivalNews = memo(function ArrivalNews({ added, holding }: { added: readonly Version[]; holding: boolean }) {
  const ui = useCartonUi();
  const words = useWords();
  // `tick`: 0 until the first arrival (no live region yet), then one step per check
  const [tick, setTick] = useState(0);
  const [text, setText] = useState("");
  // what arrived and isn't said yet: each version and its author's key as it arrived (told by person later, maybe)
  const pending = useRef<{ ids: { id: string; key: string }[]; since: number }>({ ids: [], since: 0 });
  // when each person (by either key) last made a change
  const heard = useRef(new Map<string, number>());
  const holdingNow = useRef(holding);
  holdingNow.current = holding;
  const quiet = (key: string, now: number) => {
    const last = heard.current.get(key);
    return last === undefined || now - last >= ARRIVAL_QUIET_MS;
  };
  useEffect(() => {
    if (!added.length) return;
    const p = pending.current, now = Date.now();
    // (someone heard within the minute goes on unsaid, and keeps the minute running: no work, no render)
    const fresh = added.filter((v) => quiet(v.author.key, now) || (heard.current.set(v.author.key, now), false));
    if (!fresh.length) return;
    if (!p.ids.length) p.since = now;
    p.ids.push(...fresh.map((v) => ({ id: v.id, key: v.author.key })));
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [added]);
  // (after the commit that drew the region: what it says next is announced)
  useEffect(() => {
    const p = pending.current;
    if (!p.ids.length) return;
    const hs = ui.history();
    const vs = p.ids.map((x) => {
      const i = hs.indexOf("all", x.id);
      return { v: i >= 0 ? hs.at("all", i) : undefined, key: x.key };
    }).filter((x): x is { v: Version; key: string } => !!x.v);
    if (vs.some((x) => !x.v.summary) && Date.now() - p.since < 1500) {
      const t = setTimeout(() => setTick((n) => n + 1), 100);
      return () => clearTimeout(t);
    }
    p.ids = [];
    const now = Date.now(), names: string[] = [];
    for (const { v, key } of vs) {
      const say = quiet(v.author.key, now) && quiet(key, now);
      heard.current.set(v.author.key, now).set(key, now);
      const who = actorLabel(v.author, ui.actor.bind(ui), words.you);
      if (say && who && !names.includes(who)) names.push(who);
    }
    if (names.length && !holdingNow.current) setText(words.madeAChange(names));
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ui, words]);
  return tick ? h("p", { className: "carton-sr carton-arrival-news", role: "status", "aria-live": "polite" }, text) : null;
});

/**
 * The host's stage, where it has one (scripts/carton/ui.js connect(): stageRef, stageView, onStage): the ref the editor
 * shows (null: your edit), or undefined without a stage of the host's. A row reads "Viewing" only for what is on screen,
 * never while your edit is still there as a version loads, nor for a newer version still loading over an older one, nor
 * after one failed to load (design QA G1, review of fix/ux2-a #1). Without a host stage: the view model's viewing alone.
 */
type StageUi = CartonUi & { stageRef?: () => string | null; stageView?: () => Viewing | null; onStage?: (f: () => void) => () => void };
const noStage = () => () => {};
function useStageRef(ui: StageUi): string | null | undefined {
  const subscribe = useCallback((f: () => void) => ui.onStage?.(f) ?? noStage(), [ui]);
  const get = () => (typeof ui.stageRef === "function" ? ui.stageRef() : undefined);
  return useSyncExternalStore(subscribe, get, get);
}

/** The row a key went to when a person's run of changes grew (a group's key is its newest version's), or null. */
function rowsFollow(rows: readonly Row[] | null, key: string): string | null {
  if (!rows) return null;
  const id = key.startsWith("group:") ? key.slice(6) : key;
  const g = rows.find((r) => r.kind === "group" && r.ids.includes(id));
  return g ? g.key : null;
}

/**
 * The card under its row, with what it needs from the cut you're on (its head, for "N changes since this"; its name,
 * for a new cut): read here, so a commit moving the head re-renders the open card, never the list.
 */
function CardHost(p: Omit<VersionCardProps, "head" | "cutName">) {
  const cut = useCurrentCut();
  return h(VersionCard, { ...p, head: cut?.head, cutName: cut?.name });
}

/** Nothing of yours yet (DESIGN §6.1): what History is, in one paragraph, and when the cut started. */
function EmptyHistory({ start }: { start?: Extract<HistoryRow, { kind: "start" }> }) {
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const cut = useCurrentCut();
  const at = start?.at;
  const when = at === undefined ? null : dayNumber(at) === dayNumber(now) ? words.todayAt(clockOfDay(at, locale)) : clock(at, { now, locale });
  return h(
    "div",
    { className: "carton-history-empty" },
    h("span", { className: "carton-history-empty-mark", "aria-hidden": true }, h(Icon, { name: "versions", size: 16 })),
    h("p", { className: "carton-history-empty-title" }, words.historyEmptyTitle),
    h("p", { className: "carton-history-empty-body" }, words.historyEmptyBody),
    when ? h("p", { className: "carton-history-empty-cut" }, words.cutStarted(cut?.name ?? words.mainCut, when)) : null,
  );
}
