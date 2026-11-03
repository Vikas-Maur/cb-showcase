// The Changes view (DESIGN §5.4, PLAN 4.1): everything between two points, in place of History's list. It replaces
// the old Compare card and shot strips (PLAN 4.4).
// - The range in words: "Changes since 12:20 pm" / "From Director's “Add captions to the interview” to your edit now",
//   or "Changes from yesterday at 4:10 pm to 12:20 pm" between two versions.
// - The change map, "7 changes · 0:38", and every change row in timeline order (a virtual list past 50).
// - At the bottom: Play all (and Before while playing), and Restore this version… with its consequence said first.
// - No differences: "No changes since 12:20 pm. Your edit is the same as Director's “Add captions to the interview”."
// ← History (Esc or Backspace) goes back to the list. Opening it never changes the stage: only Play does (§4.2).

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { actorLabel } from "../actors.ts";
import { clock, timecode, versionLabel } from "../format.ts";
import { useAsync, useCartonUi, useLocale, useNow, useTopicSelector, useWords } from "../hooks.ts";
import type { Actor, Change, Version } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { ChangeList, ChangeRow } from "./ChangeRow.ts";
import { ChangeMap, mapLength } from "./ChangeMap.ts";
import { BeforeButton, PlayAllButton, playKeys, usePlayChanges, type PlayHost, type PlayTarget } from "./Play.ts";
import { Button, cx } from "./ui.ts";

export interface ChangesViewProps {
  /** One end: a History version. */
  from: Version;
  /** The other end, or null for your edit now (as is the cut's newest version). Either order: the older one is "from". */
  to?: Version | null;
  /** ← History (Esc, Backspace). */
  onBack: () => void;
  /** The host's player: the editor's playhead, loading a version ahead, your edit's length. */
  host?: PlayHost;
  /** No Restore here: a teammate's cut stays as its owner left it (PLAN 6.2: fold it in or copy it instead). */
  noRestore?: boolean;
  className?: string;
}

/** Past this many rows the list is virtual: rows of one height, a sentence of up to two lines. */
export const CHANGES_VIRTUAL_OVER = 50;
/** A virtual row's height (ChangeRow's padding, two lines of 17 px), with the who-and-when line (16 px) and without. */
const ROW_TALL = 60, ROW_SHORT = 44;

const isAgent = (v: Version) => v.author.kind === "agent" || v.author.kind === "subagent";

/**
 * A version named in a sentence, whole: an agent's prompt isn't shortened here ("From Director's “Add captions to the
 * interview” to your edit now"); anything else as `versionLabel` names it.
 */
export function longLabel(v: Version, ctx: { now?: number; locale?: string; actor?: (k: string) => Actor | undefined; you: string }): string {
  const prompt = v.turn?.label || (isAgent(v) ? v.name : undefined);
  if (isAgent(v) && prompt) return `${actorLabel(v.author, ctx.actor, ctx.you)}'s “${(prompt.split("\n")[0] ?? "").trim().replace(/[.!?]+$/, "")}”`;
  return versionLabel(v, { ...(ctx.now !== undefined ? { now: ctx.now } : {}), ...(ctx.locale ? { locale: ctx.locale } : {}), ...(ctx.actor ? { actor: ctx.actor } : {}) });
}

const older = (a: Version, b: Version) => (a.seq != null && b.seq != null ? a.seq < b.seq : a.at <= b.at);

export function ChangesView(p: ChangesViewProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const head = useTopicSelector("cuts", (u) => u.cuts().find((c) => c.current)?.head);
  // the two ends, the older first
  const [a, b] = p.to && !older(p.from, p.to) ? [p.to, p.from] : [p.from, p.to ?? null];
  const toYou = !b || b.ref === head;
  // "your edit now" follows the cut's head, except while a play session is on (its rows stay put under it)
  const [shownHead, setShownHead] = useState(head);
  const aRef = a.ref;
  const bRef = toYou ? (shownHead ?? head ?? "") : b!.ref;
  const loaded = useAsync(() => ui.changes(aRef, bRef), [ui, aRef, bRef]);
  const changes = loaded.status === "ready" ? loaded.value : null;

  const actor = useCallback((k: string) => ui.actor(k), [ui]);
  const lctx = { now, ...(locale ? { locale } : {}), actor, you: words.you };
  const fromLabel = longLabel(a, lctx);
  // your edit's length, from the host: the map's scale, "· 0:38", and no spot played past its end. Between two older
  // versions it isn't known: the map reads the furthest change (mapLength), and nothing is clipped.
  const hostLength = toYou ? p.host?.length?.() : undefined;
  const known = hostLength && hostLength > 0 ? hostLength : undefined;
  const length = useMemo(() => known ?? mapLength(changes ?? []), [changes, known]);

  const newer: PlayTarget | null = toYou ? null : { kind: "version", versionId: b!.id, ref: b!.ref };
  const olderTarget: PlayTarget = { kind: "version", versionId: a.id, ref: a.ref };
  const play = usePlayChanges({ changes, newer, older: a.empty ? null : olderTarget, ...(known ? { length: known } : {}), ...(p.host ? { host: p.host } : {}) });
  useEffect(() => {
    if (!play.active && head !== shownHead) setShownHead(head);
  }, [head, shownHead, play.active]);

  // Focus comes in when it opens (as Cardboard's own panels do): on the first change (↓ ↑ walk the rows, Enter plays
  // one), or the virtual list, so Space, B and Esc work at once.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    (el?.querySelector<HTMLElement>(".carton-vlist, .carton-change[data-change-key]") ?? el)?.focus({ preventScroll: true });
  }, [changes != null]);

  const [hover, setHover] = useState<string | null>(null);
  // the virtual list's keyboard row (a short list moves focus between rows instead)
  const [active, setActive] = useState(-1);
  const authors = useMemo(() => new Set((changes ?? []).map((c) => c.author?.key ?? "")).size > 1, [changes]);
  const rowOf = useCallback((c: Change) => (changes ? changes.indexOf(c) : -1), [changes]);
  const onSelect = useCallback(
    (c: Change) => {
      const i = rowOf(c);
      if (i >= 0) setActive(i);
      if (c.at != null && Number.isFinite(c.at)) p.host?.seek?.(c.at);
    },
    [rowOf, p.host],
  );
  const playRow = play.playRow;
  const onPlay = useCallback((c: Change) => playRow(rowOf(c)), [playRow, rowOf]);
  const pause = play.toggle;
  // the map's lit ticks: the lit row's, and the row hovered
  const litKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const i of play.lit) if (changes?.[i]) keys.add(changes[i]!.key);
    if (hover) keys.add(hover);
    return keys;
  }, [play.lit, hover, changes]);

  const [confirm, setConfirm] = useState<null | { busy: boolean; failed: boolean }>(null);
  const canRestore = !p.noRestore && !a.empty && !a.provisional && a.start == null;
  const restore = async () => {
    setConfirm({ busy: true, failed: false });
    try {
      await ui.restore(a.ref);
      p.onBack();
    } catch {
      setConfirm({ busy: false, failed: true });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" || (e.key === "Backspace" && (e.target as HTMLElement).tagName !== "INPUT")) {
      e.preventDefault();
      e.stopPropagation();
      if (confirm && e.key === "Escape") return setConfirm(null);
      p.onBack();
      return;
    }
    playKeys(play, e);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLElement>) => void playKeys(play, e, true);

  const atWord = (t: number) => clock(t, { now, ...(locale ? { locale } : {}) });
  const n = changes?.length ?? 0;
  const empty = changes != null && n === 0;
  const title = empty
    ? toYou
      ? words.noChangesSince(atWord(a.at))
      : words.noChangesBetween(atWord(a.at), atWord(b!.at))
    : toYou
      ? words.changesSinceTitle(atWord(a.at))
      : words.changesBetween(atWord(a.at), atWord(b!.at));
  const sub = empty ? (toYou ? words.sameAs(fromLabel) : words.sameVersions) : words.changesFromTo(fromLabel, toYou ? words.yourEditNow : longLabel(b!, lctx));

  // The lit row: `playing` while it plays (lit, ⏸, its progress line), `active` while paused there (lit, ▶ goes on).
  const virtual = n > CHANGES_VIRTUAL_OVER;
  const row = (i: number) => {
    const lit = play.lit.has(i);
    return h(ChangeRow, {
      key: `${changes![i]!.key}#${i}`,
      change: changes![i]!,
      showAuthor: authors,
      playing: lit && play.status === "playing",
      active: (lit && play.status !== "playing") || (virtual && i === active),
      tabIndex: !virtual && i === 0 ? 0 : -1,
      onPlay,
      onPause: pause,
      onSelect,
      onHover: setHover,
    });
  };

  let list = null;
  if (loaded.status === "loading")
    list = h("div", { className: "carton-changes-skeleton", "aria-hidden": true }, h("span", null), h("span", null), h("span", null));
  else if (loaded.status === "error")
    list = h("div", { className: "carton-changes-failed", role: "alert" }, h("p", { className: "carton-error" }, words.failed), h(Button, { onClick: loaded.reload }, words.tryAgain));
  else if (virtual)
    list = h(VirtualList, {
      className: "carton-changes-list",
      label: title,
      count: n,
      rowHeight: authors ? ROW_TALL : ROW_SHORT,
      active,
      onActiveChange: setActive,
      onActivate: (i: number) => play.playRow(i),
      rowKey: (i: number) => `${changes![i]!.key}#${i}`,
      renderRow: row,
    });
  else if (n) list = h(ChangeList, { label: title, className: "carton-changes-list" }, ...changes!.map((_, i) => row(i)));

  return h(
    "section",
    {
      className: cx("carton-changes-view", p.className),
      "aria-label": title,
      "data-compact": n > CHANGES_VIRTUAL_OVER ? "" : undefined,
      onKeyDown,
      onKeyUp,
    },
    h("div", { className: "carton-changes-nav" }, h(Button, { variant: "ghost", icon: "arrowLeft", onClick: p.onBack, title: words.backToHistoryKey, keys: "Escape" }, words.backToHistory)),
    h("header", { className: "carton-changes-head" }, h("h3", { className: "carton-changes-title" }, title), h("p", { className: "carton-changes-sub" }, sub)),
    h(
      "div",
      { ref: (el: HTMLDivElement | null) => ((body.current = el), play.rootRef(el)), className: "carton-changes-body", tabIndex: -1 },
      n
        ? h(
            "div",
            { className: "carton-changes-mapbox" },
            h(ChangeMap, { changes: changes!, length, lit: litKeys }),
            h("div", { className: "carton-changes-ends" }, h("span", null, timecode(0)), h("span", null, known ? words.changesLength(n, timecode(known)) : words.changes(n))),
          )
        : null,
      list,
    ),
    play.error ? h("p", { className: "carton-error carton-changes-error", role: "alert" }, play.error) : null,
    empty || loaded.status !== "ready"
      ? null
      : confirm
        ? h(
            "div",
            { className: "carton-changes-confirm", role: "group", "aria-label": words.restoreQuestion(versionLabel(a, lctx)) },
            h("p", { className: "carton-changes-confirm-title" }, words.restoreQuestion(versionLabel(a, lctx))),
            h("p", { className: "carton-changes-confirm-body" }, words.restoreBody(toYou ? n : 0)),
            confirm.failed ? h("p", { className: "carton-error", role: "alert" }, words.restoreFailed) : null,
            h(
              "div",
              { className: "carton-changes-confirm-acts" },
              h(Button, { variant: "primary", icon: "restoreArc", busy: confirm.busy, onClick: () => void restore() }, words.restore),
              h(Button, { variant: "ghost", onClick: () => setConfirm(null) }, words.cancel),
            ),
          )
        : h(
            "footer",
            { className: "carton-changes-transport" },
            h(PlayAllButton, { play }),
            h(BeforeButton, { play }),
            h("span", { className: "carton-changes-spacer" }),
            canRestore ? h(Button, { variant: "ghost", icon: "restoreArc", description: words.restoreMenuHint, onClick: () => setConfirm({ busy: false, failed: false }) }, words.restoreThisVersion) : null,
          ),
  );
}
