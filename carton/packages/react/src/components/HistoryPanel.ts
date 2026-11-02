// History (§0.1: the list of versions). Newest first, virtualized for 10k+ versions. Named versions and Director
// turns (shown as checkpoints, like the chat's) stand out, and each row says who and when, down to the subagent.
// A version still waiting for the server says so: its place is provisional until confirmed (L5).

import { createElement as h, memo, useCallback, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { exactTime, when } from "../format.ts";
import { useCartonUi, useHistoryCount, useLocale, useNow, useTopic, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { HistoryFilter, Version } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { COLLAPSE_OVER, DAY_ROW_HEIGHT, dayLabel, dayNumber, groupHistory, spansDays, type HistoryRow } from "../history-groups.ts";
import { ActorName, Avatar, HoverMore, InlineName, MenuItem, MenuList, MenuSeparator, cx, radioKeys, tipIfCut } from "./ui.ts";
import { actorLabel } from "../actors.ts";
import { CompareCard } from "./CompareCard.ts";

export const VERSION_ROW_HEIGHT = 52;
/** About the height of a row's actions menu: with less room than this below a row, it opens above it. */
const MENU_ROOM = 260;

export interface HistoryPanelProps {
  /** Open a version (Enter or double-click). Default: a read-only preview of it (§9). */
  onOpen?: (v: Version) => void;
  /** "Watch the changes" on the Compare card. */
  onWatch?: (a: string, b: string) => void;
  /** Ref of the current state, for "Compare with current". */
  currentRef?: string;
  className?: string;
  /** Viewport height used before the list can measure itself. */
  initialHeight?: number;
  filter?: HistoryFilter;
}

const markIcon = (v: Version): IconName =>
  v.kind === "turn" ? "flag" : v.name ? "bookmark" : v.kind === "fold" ? "fold" : v.kind === "restore" || v.kind === "undo" ? "restore" : "dot";

interface RowProps {
  v: Version;
  domId: string;
  active: boolean;
  /** Its actions menu is open: it looks picked while the menu is, and only then (UI audit P2-2). */
  menuOpen: boolean;
  /** It is the version the Compare card compares. */
  compared: boolean;
  naming: "version" | "cut" | null;
  now: number;
  onPick: (id: string, e: MouseEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, el: HTMLElement) => void;
  onName: (id: string, name: string | null) => void;
}

// memo: a row re-renders only when its own version object, its active state or the minute changes. A new version
// arriving above it, or a sync status change, does not touch it.
const VersionRow = memo(function VersionRow(p: RowProps) {
  const words = useWords();
  const locale = useLocale();
  const v = p.v;
  // A turn without a label (the engine knows none) is titled by what it did.
  const title = v.name || v.turn?.label || v.summary;
  // A system row (the cut's start) names no one: no avatar, no name, only its time.
  const meta = [
    v.author.kind === "system" ? null : h(Avatar, { key: "a", actor: v.author, size: 14, named: true }),
    v.author.kind === "system" ? null : h(ActorName, { key: "n", actor: v.author }),
    v.turn ? h("span", { key: "e", className: "carton-version-edits" }, words.turnEdits(v.turn.edits)) : null,
    h(HoverMore, { key: "t", as: "time", dateTime: new Date(v.at).toISOString(), short: when(v.at, p.now, locale, words.justNow), more: exactTime(v.at, locale) }),
  ];
  return h(
    "div",
    {
      id: p.domId,
      role: "option",
      "aria-selected": p.active,
      className: "carton-version",
      "data-kind": v.kind,
      "data-named": v.name ? "" : undefined,
      "data-provisional": v.provisional ? "" : undefined,
      "data-active": p.active ? "" : undefined,
      "data-menu": p.menuOpen ? "" : undefined,
      "data-compared": p.compared ? "" : undefined,
      onClick: (e: MouseEvent) => p.onPick(v.id, e),
      onDoubleClick: () => p.onOpen(v.id),
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        p.onMenu(v.id, e.currentTarget as HTMLElement);
      },
    },
    h("span", { className: "carton-version-mark", "aria-hidden": true }, h(Icon, { name: markIcon(v), size: v.kind === "edit" && !v.name ? 12 : 14 })),
    h(
      "div",
      { className: "carton-version-main" },
      p.naming
        ? h(InlineName, {
            initial: p.naming === "version" ? (v.name ?? "") : "",
            placeholder: p.naming === "version" ? words.nameVersionPlaceholder : words.newCutPlaceholder,
            label: p.naming === "version" ? words.nameVersion : words.newCutName,
            saveLabel: p.naming === "version" ? words.save : words.create,
            onSave: (name) => p.onName(v.id, name),
            onCancel: () => p.onName(v.id, null),
          })
        : h(
            "div",
            { className: "carton-version-title" },
            v.kind === "turn" ? h("span", { className: "carton-version-kind" }, words.checkpoint) : null,
            // cut off at the panel's width: the whole name on hover (P2-16)
            h("span", { className: "carton-version-text", onMouseEnter: tipIfCut }, title),
          ),
      p.naming ? null : h(
        "div",
        { className: "carton-version-meta" },
        ...meta,
        v.published ? h("span", { className: "carton-badge", "data-tone": "info" }, words.published) : null,
        v.provisional ? h("span", { className: "carton-badge", "data-tone": "muted", "aria-description": words.provisionalHint }, words.provisional) : null,
      ),
    ),
    p.naming
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
              p.onMenu(v.id, e.currentTarget as HTMLElement);
            },
          },
          h(Icon, { name: "dots" }),
        ),
  );
});

type DayHistoryRow = Extract<HistoryRow, { kind: "day" }>;

/** A day's header (UI audit P2-17): which day, how many versions, open or folded (its named versions and turns stay). */
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
    h("span", { className: "carton-day-count" }, row.collapsed && row.hidden ? words.dayFolded(row.count, row.count - row.hidden) : words.dayCount(row.count)),
  );
});

export function HistoryPanel(props: HistoryPanelProps) {
  const ui = useCartonUi();
  const words = useWords();
  const now = useNow();
  const listId = useId();
  const [filter, setFilter] = useState<HistoryFilter>(props.filter ?? "all");
  const count = useHistoryCount(filter);
  // The list re-renders when History changes at all (a provisional version confirmed); rows skip by identity.
  const revision = useTopic("history", (u) => u.history().revision());
  const [activeId, setActiveId] = useState<string | null>(null);
  // A row being named in place: naming the version itself, or naming a new cut made from it.
  const [naming, setNaming] = useState<{ id: string; mode: "version" | "cut" } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; bottom?: number } | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const hist = ui.history();
  // All versions, grouped by day (P2-17): headers with counts, a folded day keeping its named versions and turns. Days
  // the person opened or folded stay so; with a long History every day but the newest starts folded.
  const [folds, setFolds] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const grouped = filter === "all" && typeof hist.all === "function";
  const rows = useMemo(() => {
    if (!grouped) return null;
    const all = hist.all!();
    if (!spansDays(all)) return null;
    const long = all.length > COLLAPSE_OVER;
    return groupHistory(all, (day, newest) => folds.get(day) ?? (long && !newest));
  }, [grouped, hist, revision, folds]);
  const rowIndex = useMemo(() => (rows ? new Map(rows.map((r, i) => [r.key, i])) : null), [rows]);
  const versionAtRow = useCallback((i: number) => {
    if (!rows) return hist.at(filter, i);
    const r = rows[i];
    return r?.kind === "version" ? hist.at("all", r.index) : undefined;
  }, [rows, hist, filter]);
  const toggleDay = useCallback((day: number) => {
    const r = rows?.find((x) => x.kind === "day" && x.day === day) as DayHistoryRow | undefined;
    setFolds((m) => new Map(m).set(day, !(r?.collapsed ?? false)));
  }, [rows]);
  const today = dayNumber(now);
  const [scrolled, setScrolled] = useState(false);
  const active = activeId ? (rowIndex ? (rowIndex.get(activeId) ?? -1) : hist.indexOf(filter, activeId)) : -1;

  const find = useCallback((id: string) => {
    const hs = ui.history();
    const i = hs.indexOf("all", id);
    return i >= 0 ? hs.at("all", i) : undefined;
  }, [ui]);

  // What the preview banner says it shows (P2-7): "the version from 12:41 (Claude Code)", or a named version's name,
  // never a change's summary ("Previewing Changed 'W5' font size…").
  const locale = useLocale();
  const previewLabel = useCallback((v: Version) => {
    if (v.name) return `“${v.name}”`;
    const d = new Date(v.at), today = new Date().toDateString() === d.toDateString();
    const time = new Intl.DateTimeFormat(locale, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
    const who = v.author.kind === "system" ? "" : actorLabel(v.author, ui.actor.bind(ui), words.you);
    return words.versionFrom(time, who);
  }, [ui, words, locale]);
  const open = useCallback(
    (id: string) => {
      const v = find(id);
      // A version still waiting to sync has no state to show yet (L5).
      if (!v || v.provisional) return;
      if (props.onOpen) props.onOpen(v);
      else ui.openPreview(v.ref, previewLabel(v));
    },
    [find, props.onOpen, ui, previewLabel],
  );

  const onPick = useCallback((id: string) => setActiveId(id), []);
  // The menu opens below its row, or above it when there isn't room below (the last rows: P2-3). Opening it doesn't
  // make its row the active one: the row looks picked while its menu is open, and stops when it closes (P2-2).
  const onMenu = useCallback((id: string, el: HTMLElement) => {
    const box = panel.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = box ? r.bottom - box.top + 4 : 0;
    const up = !!box && box.height - below < MENU_ROOM && r.top - box.top > box.height - below;
    setMenu({ id, x: box ? r.right - box.left : 0, y: below, ...(up && box ? { bottom: box.bottom - r.top + 4 } : {}) });
  }, []);
  // Back to the list after a menu closed with Esc, or the Compare card closed: never to <body> (P2-1).
  const toList = useCallback(() => {
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(".carton-history-list")?.focus({ preventScroll: true }));
  }, []);
  const namingRef = useRef(naming);
  namingRef.current = naming;
  const onName = useCallback(
    (id: string, name: string | null) => {
      const mode = namingRef.current?.mode;
      setNaming(null);
      if (!name) return;
      if (mode === "cut") {
        const v = find(id);
        if (v) void ui.newCut(name, v.ref);
      } else void ui.nameVersion(id, name);
    },
    [ui, find],
  );

  // Keyboard: the context-menu key on the active row opens its actions, anchored to the row.
  const onKeyMenu = useCallback(
    (i: number) => {
      const v = versionAtRow(i);
      if (!v) return;
      const rowId = `${listId}-${v.id}`;
      const row = [...(panel.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].find((el) => el.id === rowId);
      if (row) onMenu(v.id, row.querySelector<HTMLElement>(".carton-version-more") ?? row);
    },
    [versionAtRow, listId, onMenu],
  );

  const menuVersion = menu ? find(menu.id) : undefined;
  const waiting = !!menuVersion?.provisional;
  const compareVersion = comparing ? find(comparing) : undefined;
  const filters = useMemo(() => (["all", "named", "turns"] as const).map((f) => ({ f, label: words.historyFilters[f] })), [words]);
  const empty = filter === "named" ? words.historyEmptyNamed : filter === "turns" ? words.historyEmptyTurns : words.historyEmpty;

  return h(
    "section",
    { ref: panel, className: cx("carton-history", props.className), "aria-label": words.history, "data-menu-open": menu ? "" : undefined, "data-scrolled": scrolled ? "" : undefined },
    h(
      "header",
      { className: "carton-panel-head" },
      h("h2", { className: "carton-panel-title" }, words.history),
      h(
        "div",
        { className: "carton-segmented", role: "radiogroup", "aria-label": words.history, onKeyDown: radioKeys },
        ...filters.map(({ f, label }) =>
          h(
            "button",
            {
              key: f,
              type: "button",
              role: "radio",
              "aria-checked": filter === f,
              tabIndex: filter === f ? 0 : -1,
              className: "carton-segment",
              onClick: () => {
                setFilter(f);
                setMenu(null);
              },
            },
            label,
          ),
        ),
      ),
    ),
    count === 0
      ? h("p", { className: "carton-empty" }, empty)
      : h(VirtualList, {
          key: filter,
          className: "carton-history-list",
          label: words.history,
          count: rows ? rows.length : count,
          rowHeight: VERSION_ROW_HEIGHT,
          ...(rows ? { heightOf: (i: number) => (rows[i]?.kind === "day" ? DAY_ROW_HEIGHT : VERSION_ROW_HEIGHT), layoutKey: rows } : {}),
          onScrolledChange: setScrolled,
          initialHeight: props.initialHeight,
          newestFirst: true,
          active,
          activeId: (i: number) => `${listId}-${rows ? (rows[i]?.key ?? i) : (hist.at(filter, i)?.id ?? i)}`,
          onActiveChange: (i: number) => setActiveId(rows ? (rows[i]?.key ?? null) : (hist.at(filter, i)?.id ?? null)),
          onMenu: onKeyMenu,
          onActivate: (i: number) => {
            const r = rows?.[i];
            if (r?.kind === "day") return toggleDay(r.day);
            const v = versionAtRow(i);
            if (v) open(v.id);
          },
          rowKey: (i: number) => (rows ? (rows[i]?.key ?? String(i)) : (hist.at(filter, i)?.id ?? String(i))),
          renderRow: (i: number) => {
            const r = rows?.[i];
            if (r?.kind === "day")
              return h(DayRow, { row: r, label: dayLabel(r.day, today, locale, { today: words.today, yesterday: words.yesterday }), domId: `${listId}-${r.key}`, active: r.key === activeId, onToggle: toggleDay });
            const v = versionAtRow(i);
            if (!v) return null;
            return h(VersionRow, {
              v,
              domId: `${listId}-${v.id}`,
              active: v.id === activeId,
              menuOpen: v.id === menu?.id,
              compared: v.id === comparing,
              naming: naming?.id === v.id ? naming.mode : null,
              // Rows only need minute precision; passing the shared minute keeps memo effective.
              now,
              onPick,
              onOpen: open,
              onMenu,
              onName,
            });
          },
        }),
    menu && menuVersion
      ? h(
          MenuList,
          {
            label: words.versionActions(menuVersion.name ?? menuVersion.summary),
            onClose: (why?: string) => {
              setMenu(null);
              if (why === "escape") toList();
            },
            className: "carton-history-menu",
            style: menu.bottom != null ? { position: "absolute", bottom: menu.bottom, left: Math.max(8, menu.x - 220) } : { position: "absolute", top: menu.y, left: Math.max(8, menu.x - 220) },
          },
          // A version still waiting to sync can't be previewed, compared, named or restored yet (L5).
          h(MenuItem, { icon: "eye", disabled: waiting, title: waiting ? words.provisionalHint : undefined, onSelect: () => (setMenu(null), open(menuVersion.id)) }, words.preview),
          props.currentRef
            ? h(MenuItem, { icon: "history", disabled: waiting, onSelect: () => (setMenu(null), setComparing(menuVersion.id)) }, words.compareWithCurrent)
            : null,
          h(MenuItem, { icon: "bookmark", disabled: waiting, onSelect: () => (setMenu(null), setNaming({ id: menuVersion.id, mode: "version" })) }, menuVersion.name ? words.rename : words.nameVersion),
          h(MenuItem, { icon: "cut", disabled: waiting, onSelect: () => (setMenu(null), setNaming({ id: menuVersion.id, mode: "cut" })) }, words.newCutFromHere),
          menuVersion.foldRest ? h(MenuItem, { icon: "fold", onSelect: () => (setMenu(null), void ui.foldRest(menuVersion.id)) }, words.foldRest) : null,
          h(MenuSeparator, null),
          h(MenuItem, { icon: "restore", disabled: waiting, title: waiting ? words.provisionalHint : words.restoreHint, onSelect: () => (setMenu(null), void ui.restore(menuVersion.ref)) }, words.restore),
        )
      : null,
    compareVersion && props.currentRef
      ? h(CompareCard, {
          a: compareVersion.ref,
          b: props.currentRef,
          onWatch: props.onWatch,
          onRestore: () => void ui.restore(compareVersion.ref),
          onClose: () => {
            setComparing(null);
            toList();
          },
          className: "carton-history-compare",
        })
      : null,
  );
}
