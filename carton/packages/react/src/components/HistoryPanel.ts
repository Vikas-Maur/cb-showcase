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

import { createElement as h, Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { clock, clockOfDay, exactTime, shortDate, versionLabel } from "../format.ts";
import { useAsync, useCartonUi, useCurrentCut, useCurrentCutId, useHistoryCount, useLocale, useNow, useTopic, useViewing, useWords, useWorking } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Actor, CartonUi, Credits, HistoryFilter, Version, Working } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { COLLAPSE_OVER, DAY_ROW_HEIGHT, dayLabel, dayNumber, groupHistory, type HistoryRow } from "../history-groups.ts";
import { ActorName, Avatar, HoverMore, InlineName, MenuItem, MenuLabel, MenuList, MenuSeparator, cx, tipIfCut } from "./ui.ts";
import { actorLabel } from "../actors.ts";
import { CompareCard } from "./CompareCard.ts";
import { CutsMenu } from "./CutsMenu.ts";
import { VersionCard, type CardMode, type PlayRequest, type PlayState, type VersionCardProps } from "./VersionCard.ts";

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
   * The clip selected on the timeline, when exactly one is: the filter menu offers "Only “clip”" (PLAN 0.8). Read when
   * the menu opens, so the list never re-renders for a selection.
   */
  selectedClip?: () => { readonly id: string; readonly name: string } | null;
  /**
   * The Changes view between two refs (Workstream 4): "See them" and "See the 4" on a card, "Compare with your edit" in
   * a row's menu. Without it, "Compare with your edit" opens the Compare card (with `currentRef`), as before.
   */
  onCompare?: (a: string, b: string) => void;
  /** Play (PLAN 4.2): the host's player plays a version's changes. Without it, Play moves the playhead to the change (and views an older version). */
  onPlay?: (req: PlayRequest) => void;
  onPause?: () => void;
  /** What plays now (the host's player): its row in the open card is lit. */
  playing?: PlayState | null;
  /** A change row's click: the editor's playhead there (on your edit). */
  onSeek?: (at: number) => void;
  /** Deprecated (the Compare card, until the Changes view replaces it): its Play (WatchTheChanges). */
  onWatch?: (a: string, b: string) => void;
  /** Ref of the current state, for the Compare card when there is no `onCompare`. */
  currentRef?: string;
  className?: string;
  /** Viewport height used before the list can measure itself. */
  initialHeight?: number;
  filter?: HistoryFilter;
}

type Row = HistoryRow | { readonly kind: "working"; readonly key: "working" };
type DayHistoryRow = Extract<HistoryRow, { kind: "day" }>;

const isAgent = (a: Actor) => a.kind === "agent" || a.kind === "subagent";
/** An agent's prompt, when the version is its turn (as versionLabel reads it). */
const promptOf = (v: Version) => v.turn?.label || (isAgent(v.author) ? v.name : undefined) || undefined;
const filterKey = (f: HistoryFilter) => (typeof f === "object" ? `item:${f.item}` : f);

// ------------------------------------------------------------------------------------------------- the rows' parts

/** A row's mark: a person's avatar or an agent's own mark; a named version's bookmark, a fold's or a restore's sign. */
function RowMark({ v, live }: { v: Version; live?: boolean }) {
  const named = !!v.name && !promptOf(v);
  const sign = named ? "bookmarkFill" : v.kind === "fold" ? "foldIn" : v.kind === "restore" ? "restoreArc" : v.kind === "undo" ? "undo" : null;
  if (sign) return h("span", { className: "carton-version-mark carton-mark-sign", "data-sign": named ? "named" : v.kind, "aria-hidden": true }, h(Icon, { name: sign, size: named ? 11 : 12 }));
  return h("span", { className: "carton-version-mark", "data-live": live ? "" : undefined, "aria-hidden": true }, h(Avatar, { actor: v.author, size: 20, named: true }));
}

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
  /** A person's run of changes (a group row): its versions' total changes, and whether its versions are listed. */
  group?: boolean;
  groupCount?: number;
  groupOpen?: boolean;
  onPick: (key: string, e: MouseEvent) => void;
  onMenu: (key: string, el: HTMLElement) => void;
  onName: (id: string, name: string | null) => void;
  onGroup: (key: string) => void;
  onBack: () => void;
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
  const title = prompt ? `“${prompt}”` : named ? v.name! : v.summary || versionLabel(v, { locale, actor: ui.actor.bind(ui), start: true });
  const when = p.viewing
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
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              p.onBack();
            },
          },
          h(Icon, { name: "x", size: 11 }),
        ),
      )
    : p.now
      ? h("span", { className: "carton-version-when", "data-now": "" }, words.nowRow)
      : h(HoverMore, { as: "time", className: "carton-version-when", dateTime: new Date(v.at).toISOString(), short: clockOfDay(v.at, locale), more: exactTime(v.at, locale) });
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
      onClick: (e: MouseEvent) => p.onPick(p.rowKey, e),
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        p.onMenu(p.rowKey, e.currentTarget as HTMLElement);
      },
    },
    p.child ? h("span", { className: "carton-version-mark", "aria-hidden": true }) : h(RowMark, { v }),
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
          h("span", { className: "carton-version-title", onMouseEnter: tipIfCut }, title),
          when,
          p.child
            ? null
            : h(
                "span",
                { className: "carton-version-meta" },
                h(Meta, { v, count: p.group ? p.groupCount : undefined, ui }),
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

/** History's start, one row (PLAN 0.4): "Project created · Oct 28", or "History starts here" for an imported project. No menu, no card. */
const StartRow = memo(function StartRow({ row, domId, active }: { row: Extract<HistoryRow, { kind: "start" }>; domId: string; active: boolean }) {
  const words = useWords();
  const locale = useLocale();
  return h(
    "div",
    { id: domId, role: "option", "aria-selected": active, className: "carton-version carton-start", style: { height: VERSION_ROW_HEIGHT }, "data-start": "", "data-active": active ? "" : undefined },
    h("span", { className: "carton-version-mark carton-mark-sign", "data-sign": "start", "aria-hidden": true }, h(Icon, { name: "flag", size: 12 })),
    h("span", { className: "carton-version-title" }, words.startOn(row.imported ? words.historyStartsHere : words.projectCreated, shortDate(row.at, locale))),
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
const DayRow = memo(function DayRow({ row, label, domId, active, onToggle }: { row: DayHistoryRow; label: string; domId: string; active: boolean; onToggle: (day: number) => void }) {
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
    row.collapsed && row.count ? h("span", { className: "carton-day-count" }, words.dayVersions(row.count, row.count - row.hidden)) : null,
  );
});

/** The clip History is filtered to: its credits, oldest first ("Added by You on Oct 30 · trimmed by Director · …"). */
function ClipCredits({ item, name }: { item: string; name: string }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const credits = useAsync<Credits>(() => ui.credits(item), [ui, item]);
  if (credits.status !== "ready" || !credits.value.lines.length) return null;
  const lines = [...credits.value.lines].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const today = dayNumber(now);
  const text = lines
    .map((l, i) => {
      const who = actorLabel(l.author, ui.actor.bind(ui), words.you);
      const verb = words.creditVerb[l.what] ?? `${l.what.toLowerCase()} changed`;
      const when = l.at === undefined ? "" : dayNumber(l.at) === today ? words.creditAt(clockOfDay(l.at, locale)) : dayNumber(l.at) === today - 1 ? clock(l.at, { now, locale }) : words.creditOn(shortDate(l.at, locale));
      const s = words.creditPart(verb, who, when);
      return i === 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
    })
    .join(" · ");
  return h(
    "div",
    { className: "carton-clip-credits" },
    h("div", { className: "carton-clip-credits-name" }, `“${credits.value.clip || name}”`),
    h("p", null, text),
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
  const viewing = useViewing();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cardMode, setCardMode] = useState<CardMode>(null);
  const [cardHeight, setCardHeight] = useState(CARD_ESTIMATE);
  // a menu's "Play its changes", or Space on a row: play as soon as its card has read what changed
  const [autoPlay, setAutoPlay] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; bottom?: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ clip: { id: string; name: string } | null } | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [folds, setFolds] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [scrolled, setScrolled] = useState(false);
  // the row at the top of the view: its day's header stays pinned there (DESIGN §6.1, sticky day headers)
  const [topRow, setTopRow] = useState(0);
  // Why the last action from a menu didn't happen, in the words the app gave.
  const [failed, setFailed] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const scrollTop = useRef<(() => void) | null>(null);

  // ---------------------------------------------------------------- rows: days, groups, the start, an agent working
  const fkey = filterKey(filter);
  const versions = useMemo(() => {
    if (typeof hist.all !== "function") return null;
    const all = hist.all();
    if (filter === "all") return all;
    // the filter's versions, in History's order, without describing any (indexOf is a lookup, at() would ask for a summary)
    return all.filter((v) => hist.indexOf(filter, v.id) >= 0);
    // `count` and `status.loading` too: a clip's index arrives after the filter is picked (remote.ts asks the worker),
    // with no new version, so History's revision doesn't move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, revision, fkey, count, status.loading]);
  const grouped = useMemo(() => {
    if (!versions) return null;
    const long = versions.length > COLLAPSE_OVER;
    return groupHistory(versions, (day, newest) => folds.get(day) ?? (long && !newest), { group: true, open: (k) => openGroups.has(k) });
    // `revision` too: a source's all() is one array it appends to in place (remote.ts, mock.ts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, revision, folds, openGroups]);
  // the live row of an agent working on this cut, on top (in Today), in the lists that show turns
  const live = working && (!working.cutId || !cutId || working.cutId === cutId) && (filter === "all" || filter === "turns") ? working : null;
  const today = dayNumber(now);
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
      if (r.kind === "version" || r.kind === "group") return rows ? hist.at(filter, r.index) : undefined;
      return undefined;
    },
    [rows, hist, filter],
  );
  const versionAt = useCallback((i: number) => (rows ? versionOfRow(rows[i]) : hist.at(filter, i)), [rows, versionOfRow, hist, filter]);
  const keyAt = useCallback((i: number) => (rows ? (rows[i]?.key ?? String(i)) : (hist.at(filter, i)?.id ?? String(i))), [rows, hist, filter]);

  const toggleDay = useCallback((day: number) => {
    const r = rows?.find((x) => x.kind === "day" && x.day === day) as DayHistoryRow | undefined;
    setFolds((m) => new Map(m).set(day, !(r?.collapsed ?? false)));
  }, [rows]);
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

  // Play: the host's player, or (until it has one) the playhead moved to the change, an older version viewed first.
  const [ownPlaying, setOwnPlaying] = useState<PlayState | null>(null);
  const onSeek = props.onSeek;
  const ownPlay = useCallback(
    (req: PlayRequest) => {
      const first = req.only ?? req.changes.find((c) => c.at !== undefined) ?? req.changes[0];
      setOwnPlaying({ versionId: req.version.id, key: first?.key ?? null });
      const go = () => {
        if (first?.at !== undefined) onSeek?.(Math.max(0, first.at - 1));
      };
      if (req.newest) go();
      else
        ui.view({ kind: "version", versionId: req.version.id }).then(go, (e: unknown) => {
          setOwnPlaying(null);
          setFailed(e instanceof Error && e.message ? e.message : words.loadFailed);
        });
    },
    [ui, onSeek, words],
  );
  // (the interim Play holds nothing on the stage: back to your edit, or the card closed, it's over)
  const viewingNow = !!viewing;
  useEffect(() => {
    if (!viewingNow) setOwnPlaying((p) => (p && p.versionId !== newestId ? null : p));
  }, [viewingNow, newestId]);
  useEffect(() => {
    if (!openKey) setOwnPlaying(null);
  }, [openKey]);
  const play = props.onPlay ?? ownPlay;
  const pause = props.onPlay ? props.onPause : () => setOwnPlaying(null);
  const playing = props.onPlay ? (props.playing ?? null) : ownPlaying;
  const onPlay = useCallback((req: PlayRequest) => {
    setAutoPlay(null);
    play(req);
  }, [play]);

  // The rows' handlers are one function each for the panel's life (memoized rows skip a new version: U6); what they
  // read as it is now comes through this ref.
  const live_ = useRef({ onCompare: props.onCompare, activeKey, versionOfRow, rowOf });
  live_.current = { onCompare: props.onCompare, activeKey, versionOfRow, rowOf };
  const onPick = useCallback((key: string, e: MouseEvent) => {
    const { onCompare, activeKey: from, versionOfRow: vOf, rowOf: rOf } = live_.current;
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

  // Keyboard (DESIGN §7): Enter / → open a row's card, a day or a group, ← closes it; Space plays (or pauses) the
  // version's changes; F2 names it; Esc closes the card first (then the host's: stop viewing, close the panel).
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, i: number): boolean => {
      const r = rows ? rows[i] : undefined;
      const key = i >= 0 ? keyAt(i) : null;
      if (e.key === "Escape") {
        if (!openKey) return false;
        closeCard();
        return true;
      }
      if (i < 0 || !key) return false;
      if (e.key === "ArrowRight") {
        if (r?.kind === "day") {
          if (r.collapsed) toggleDay(r.day);
        } else if (r?.kind === "group" && !r.open) toggleGroup(r.key);
        else if (r?.kind !== "start" && r?.kind !== "working") openCard(key);
        return true;
      }
      if (e.key === "ArrowLeft") {
        if (openKey === key) closeCard();
        else if (r?.kind === "group" && r.open) toggleGroup(r.key);
        else if (r?.kind === "day" && !r.collapsed) toggleDay(r.day);
        else if (r?.kind === "version" && r.child) {
          // from one of a group's versions, back to its group
          for (let k = i - 1; k >= 0; k--) if (rows![k]!.kind === "group") return setActiveKey(rows![k]!.key), true;
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
    [rows, keyAt, openKey, closeCard, toggleDay, toggleGroup, openCard, versionAt, playing, pause],
  );
  const onActivate = useCallback(
    (i: number) => {
      const r = rows?.[i];
      if (r?.kind === "day") return toggleDay(r.day);
      if (r?.kind === "start" || r?.kind === "working") return;
      const key = keyAt(i);
      setOpenKey((k) => (k === key ? null : key));
      setCardMode(null);
    },
    [rows, toggleDay, keyAt],
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
      const k = follow(activeKey);
      if (k) setActiveKey(k);
    }
    if ([...openGroups].some((k) => !rowIndex.has(k))) setOpenGroups(new Set([...openGroups].map((k) => follow(k) ?? k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  useEffect(() => {
    if (openKey && openAt < 0 && !rows) closeCard();
  }, [openKey, openAt, rows, closeCard]);
  const expanded = openAt >= 0 ? { index: openAt, extra: cardHeight + CARD_GAP } : null;
  const heightOf = useCallback(
    (i: number) => {
      const r = rows?.[i];
      return !r ? VERSION_ROW_HEIGHT : r.kind === "day" ? DAY_ROW_HEIGHT : r.kind === "working" ? WORKING_ROW_HEIGHT : r.kind === "version" && r.child ? CHILD_ROW_HEIGHT : VERSION_ROW_HEIGHT;
    },
    [rows],
  );
  const viewedId = viewing && (viewing.kind === "version" || viewing.kind === "before") ? (viewing.versionId ?? null) : null;

  const renderRow = (i: number): ReactNode => {
    const r = rows?.[i];
    const key = keyAt(i);
    const domId = `${listId}-${key}`;
    if (r?.kind === "day") return h(DayRow, { row: r, label: dayLabel(r.day, today, locale, { today: words.today, yesterday: words.yesterday }), domId, active: key === activeKey, onToggle: toggleDay });
    if (r?.kind === "start") return h(StartRow, { row: r, domId, active: key === activeKey });
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
      height: child ? CHILD_ROW_HEIGHT : VERSION_ROW_HEIGHT,
      active: key === activeKey,
      menuOpen: key === menu?.key,
      open: isOpen,
      now: v.id === newestId && !live && !child,
      viewing: !!viewedId && (v.id === viewedId || (!!group && group.ids.includes(viewedId))),
      naming: naming === v.id,
      compared: comparing === v.id,
      child,
      group: !!group,
      groupCount: group?.count,
      groupOpen: group?.open,
      onPick,
      onMenu,
      onName,
      onGroup: toggleGroup,
      onBack: back,
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
        mode: cardMode,
        onMode: setCardMode,
        // without the Changes view (Workstream 4), "See them" opens the Compare card, as the menu's Compare did
        onCompare: props.onCompare ?? (props.currentRef ? () => setComparing(v.id) : undefined),
        onPlay,
        onPause: pause,
        playing,
        autoPlay: autoPlay === key,
        onSeek,
        onMenu: (el: HTMLElement) => onMenu(key, el),
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
          props.onCompare || props.currentRef
            ? h(MenuItem, {
                icon: "layers",
                disabled: waiting,
                onSelect: () => {
                  closeMenu();
                  const b = head() ?? props.currentRef;
                  if (props.onCompare && b) props.onCompare(menuVersion.ref, b);
                  else setComparing(menuVersion.id);
                },
              }, words.compareWithYourEdit)
            : null,
          h(MenuSeparator, null),
          h(MenuItem, { icon: "bookmark", disabled: waiting, title: waiting ? words.availableOnceSent : undefined, onSelect: () => (closeMenu(), setNaming(menuVersion.id)) }, menuVersion.name && !promptOf(menuVersion) ? words.renameEllipsis : words.nameVersion),
          menuVersion.empty ? null : h(MenuItem, { icon: "cut", disabled: waiting, onSelect: () => (closeMenu(), openCard(menu.key, "newCut")) }, words.newCutFromVersion),
          menuVersion.foldRest
            ? h(MenuItem, { icon: "foldIn", onSelect: () => (closeMenu(), void ui.foldRest(menuVersion.id).then((r) => !r.ok && setFailed(r.error ?? words.failed), (e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.failed))) }, words.foldRest)
            : null,
          // the newest version is your edit: nothing to go back to. An empty one says why it can't be restored.
          menuVersion.id === newestId && !menuVersion.empty ? null : h(MenuSeparator, null),
          menuVersion.id === newestId && !menuVersion.empty
            ? null
            : h(MenuItem, { icon: "restoreArc", disabled: waiting || !!menuVersion.empty, title: menuVersion.empty ? words.emptyVersionHint : waiting ? words.availableOnceSent : words.restoreMenuHint, onSelect: () => (closeMenu(), openCard(menu.key, "restore")) }, words.restoreEllipsis),
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
  const filterLabel = typeof filter === "object" ? words.onlyClip(clipName || words.version) : filter === "all" ? "" : words.filters[filter];
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
        ...filterChoices.map((f) => h(MenuItem, { key: f, checked: filter === f, onSelect: () => pickFilter(f) }, words.filters[f])),
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
  const nothing = allCount === 0 || (filter === "all" && onlyStart);
  const empty = !status.loading && (count === 0 || (filter === "all" && onlyStart));
  const loading = status.loading && count === 0;
  const compareVersion = comparing ? find(comparing) : undefined;

  return h(
    "section",
    {
      ref: panel,
      className: cx("carton-history", props.className),
      "aria-label": words.history,
      "data-menu-open": menu ? "" : undefined,
      "data-scrolled": scrolled ? "" : undefined,
    },
    h(
      "header",
      { className: "carton-panel-head carton-cutbar" },
      cut,
      h("span", { className: "carton-cutbar-gap" }),
      nothing && filter === "all"
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
                onClick: openFilter,
              },
              h(Icon, { name: "filter", size: 16 }),
            ),
            filterPop ? h("div", { className: "carton-menu-pop" }, filterPop) : null,
          ),
    ),
    filter !== "all"
      ? h(
          "div",
          { className: "carton-filter-chips" },
          h(
            "span",
            { className: "carton-filter-chip" },
            h("span", { className: "carton-filter-chip-text" }, filterLabel),
            h("button", { type: "button", className: "carton-filter-chip-x", "aria-label": words.removeFilter, "data-carton-tip": words.removeFilter, onClick: () => setFilter("all") }, h(Icon, { name: "x", size: 11 })),
          ),
          status.since !== undefined ? h("span", { className: "carton-filter-note" }, words.clipSince(clock(status.since, { now, locale }))) : null,
        )
      : null,
    typeof filter === "object" ? h(ClipCredits, { key: filter.item, item: filter.item, name: clipName }) : null,
    failed ? h("p", { className: "carton-error carton-history-error", role: "alert" }, failed) : null,
    loading
      ? h(
          "div",
          { className: "carton-history-skeleton", role: "status", "aria-label": words.history },
          ...[0, 1, 2].map((k) => h("div", { key: k, className: "carton-skeleton-row" }, h("span"), h("span"), h("span"))),
        )
      : empty
        ? filter === "all"
          ? h(EmptyHistory, { start: rows?.find((r) => r.kind === "start") as Extract<HistoryRow, { kind: "start" }> | undefined })
          : h("p", { className: "carton-empty" }, typeof filter === "object" ? words.clipEmpty(clipName || words.version) : words.filterEmpty[filter])
        : h(
            "div",
            { className: "carton-history-body" },
            h(VirtualList, {
              key: fkey,
              className: "carton-history-list",
              label: words.history,
              count: rows ? rows.length : count,
              rowHeight: VERSION_ROW_HEIGHT,
              heightOf,
              layoutKey: rows,
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
    compareVersion && props.currentRef && !props.onCompare
      ? h(CompareCard, {
          a: compareVersion.ref,
          b: props.currentRef,
          onWatch: props.onWatch,
          ...(compareVersion.empty ? {} : { onRestore: () => void ui.restore(compareVersion.ref).catch((e: unknown) => setFailed(e instanceof Error && e.message ? e.message : words.failed)) }),
          onClose: () => {
            setComparing(null);
            toList();
          },
          className: "carton-history-compare",
        })
      : null,
  );
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
