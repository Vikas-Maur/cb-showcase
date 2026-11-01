// History (§0.1: the list of versions). Newest first, virtualized for 10k+ versions. Named versions and Director
// turns (shown as checkpoints, like the chat's) stand out, and each row says who and when, down to the subagent.
// A version still waiting for the server says so: its place is provisional until confirmed (L5).

import { createElement as h, memo, useCallback, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { exactTime, when } from "../format.ts";
import { useCartonUi, useHistoryCount, useLocale, useNow, useTopic, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { HistoryFilter, Version } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { ActorName, Avatar, InlineName, MenuItem, MenuList, MenuSeparator, cx } from "./ui.ts";
import { CompareCard } from "./CompareCard.ts";

export const VERSION_ROW_HEIGHT = 52;

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
    h("time", { key: "t", dateTime: new Date(v.at).toISOString(), "data-carton-tip": exactTime(v.at, locale) }, when(v.at, p.now, locale, words.justNow)),
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
            h("span", { className: "carton-version-text" }, title),
          ),
      p.naming ? null : h(
        "div",
        { className: "carton-version-meta" },
        ...meta,
        v.published ? h("span", { className: "carton-badge", "data-tone": "info" }, words.published) : null,
        v.provisional ? h("span", { className: "carton-badge", "data-tone": "muted", "data-carton-tip": words.provisionalHint }, words.provisional) : null,
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

export function HistoryPanel(props: HistoryPanelProps) {
  const ui = useCartonUi();
  const words = useWords();
  const now = useNow();
  const listId = useId();
  const [filter, setFilter] = useState<HistoryFilter>(props.filter ?? "all");
  const count = useHistoryCount(filter);
  // The list re-renders when History changes at all (a provisional version confirmed); rows skip by identity.
  useTopic("history", (u) => u.history().revision());
  const [activeId, setActiveId] = useState<string | null>(null);
  // A row being named in place: naming the version itself, or naming a new cut made from it.
  const [naming, setNaming] = useState<{ id: string; mode: "version" | "cut" } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const hist = ui.history();
  const active = activeId ? hist.indexOf(filter, activeId) : -1;

  const find = useCallback((id: string) => {
    const hs = ui.history();
    const i = hs.indexOf("all", id);
    return i >= 0 ? hs.at("all", i) : undefined;
  }, [ui]);

  const open = useCallback(
    (id: string) => {
      const v = find(id);
      // A version still waiting to sync has no state to show yet (L5).
      if (!v || v.provisional) return;
      if (props.onOpen) props.onOpen(v);
      else ui.openPreview(v.ref, v.name || v.turn?.label || v.summary);
    },
    [find, props.onOpen, ui],
  );

  const onPick = useCallback((id: string) => setActiveId(id), []);
  const onMenu = useCallback((id: string, el: HTMLElement) => {
    const box = panel.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setActiveId(id);
    setMenu({ id, x: box ? r.right - box.left : 0, y: box ? r.bottom - box.top + 4 : 0 });
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
      const v = ui.history().at(filter, i);
      if (!v) return;
      const rowId = `${listId}-${v.id}`;
      const row = [...(panel.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].find((el) => el.id === rowId);
      if (row) onMenu(v.id, row.querySelector<HTMLElement>(".carton-version-more") ?? row);
    },
    [ui, filter, listId, onMenu],
  );

  const menuVersion = menu ? find(menu.id) : undefined;
  const waiting = !!menuVersion?.provisional;
  const compareVersion = comparing ? find(comparing) : undefined;
  const filters = useMemo(() => (["all", "named", "turns"] as const).map((f) => ({ f, label: words.historyFilters[f] })), [words]);
  const empty = filter === "named" ? words.historyEmptyNamed : filter === "turns" ? words.historyEmptyTurns : words.historyEmpty;

  return h(
    "section",
    { ref: panel, className: cx("carton-history", props.className), "aria-label": words.history },
    h(
      "header",
      { className: "carton-panel-head" },
      h("h2", { className: "carton-panel-title" }, words.history),
      h(
        "div",
        { className: "carton-segmented", role: "radiogroup", "aria-label": words.history },
        ...filters.map(({ f, label }) =>
          h(
            "button",
            {
              key: f,
              type: "button",
              role: "radio",
              "aria-checked": filter === f,
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
          count,
          rowHeight: VERSION_ROW_HEIGHT,
          initialHeight: props.initialHeight,
          newestFirst: true,
          active,
          activeId: (i: number) => `${listId}-${hist.at(filter, i)?.id ?? i}`,
          onActiveChange: (i: number) => setActiveId(hist.at(filter, i)?.id ?? null),
          onMenu: onKeyMenu,
          onActivate: (i: number) => {
            const v = hist.at(filter, i);
            if (v) open(v.id);
          },
          rowKey: (i: number) => hist.at(filter, i)?.id ?? String(i),
          renderRow: (i: number) => {
            const v = hist.at(filter, i);
            if (!v) return null;
            return h(VersionRow, {
              v,
              domId: `${listId}-${v.id}`,
              active: v.id === activeId,
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
            onClose: () => setMenu(null),
            className: "carton-history-menu",
            style: { position: "absolute", top: menu.y, left: Math.max(8, menu.x - 220) },
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
          onClose: () => setComparing(null),
          className: "carton-history-compare",
        })
      : null,
  );
}
