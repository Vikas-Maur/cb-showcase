// A version's card (docs/carton-ux DESIGN §5.2, PLAN 3.3): opened inline under its row by a click or Enter, one at a
// time. It answers two questions, in words, without taking over the editor:
// - "relative to my work": on any version but the newest, first, "Your edit has 7 changes since this · See them";
// - "what did this do?": the change map, the first four change rows (▶ on hover), "and 9 more";
// then its actions: Play all, Restore… (or Undo this turn on the newest agent turn), and ⋯ (the row's menu).
// Restore… and New cut from this version… open in the card itself, with their consequences in one line (§6.2).
//
// Only an open card asks what changed (`changesIn`, and `changes(v, head)` for the count): a History of 12,000 versions
// describes the one version someone opened. Play is the host's (`onPlay`, PLAN 4.2): the card says what to play and
// shows which row plays; per-frame work never renders it.

import { createElement as h, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { versionLabel } from "../format.ts";
import { useAsync, useCartonUi, useLocale, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Change, Version } from "../model.ts";
import { ChangeList, ChangeRow } from "./ChangeRow.ts";
import { ChangeMap } from "./ChangeMap.ts";
import { Button, cx } from "./ui.ts";

/** The rows a closed card lists (DESIGN §5.2): then "and N more". */
export const CARD_ROWS = 4;
/** "and N more" lists them all, up to this many; a longer list opens in the Changes view instead. */
export const CARD_ROWS_MAX = 50;

/** What to play (PLAN 4.2): every change of a version in order (Play all), or one (its ▶). */
export interface PlayRequest {
  readonly version: Version;
  readonly changes: readonly Change[];
  /** One change's ▶; absent: Play all. */
  readonly only?: Change;
  /** The version is the cut's newest: it plays on your edit, with nothing viewed (DESIGN §5.3). */
  readonly newest: boolean;
}

/** What plays now: the version, and the change on screen (its row is lit). */
export interface PlayState {
  readonly versionId: string;
  readonly key: string | null;
}

/** The card's inline steps (DESIGN §6.2): the restore confirmation, or the new cut's name. */
export type CardMode = "restore" | "newCut" | null;

export interface VersionCardProps {
  /** The version (a group: its newest). */
  version: Version;
  /** A person's run of changes (a group row): its versions, newest first. The card lists all their changes. */
  group?: readonly Version[];
  /** It is the cut's newest version: no "since this"; Play runs on your edit. */
  newest: boolean;
  /** The cut's newest ref: "Your edit has N changes since this" counts `changes(version, head)`. */
  head?: string;
  /**
   * The version is on a teammate's cut (Workstream 6, PLAN 6.2): it stays as its owner left it, so no Restore… and no
   * Undo this turn; Play, Compare and New cut from it stay.
   */
  readOnly?: boolean;
  /** The cut you're on, by name: "You'll switch to it. Main cut stays as it is." */
  cutName?: string;
  mode?: CardMode;
  onMode?: (m: CardMode) => void;
  /** "See them", "See the 4", a long list: the Changes view between two refs (Workstream 4). Absent: none. */
  onCompare?: (a: string, b: string) => void;
  onPlay?: (req: PlayRequest) => void;
  onPause?: () => void;
  playing?: PlayState | null;
  /** A change row's click: the editor's playhead there (on your edit). */
  onSeek?: (at: number) => void;
  /** Before (Workstream 4's BeforeButton), after Play all / Pause: it shows itself while a play is on. */
  before?: ReactNode;
  /** ⋯: the row's menu, anchored to the button. */
  onMenu?: (anchor: HTMLElement) => void;
  /** Esc in the card, or an action done: the card closes (focus back to the list). */
  onClose: () => void;
  /** The card's height, as it lays out (the list makes room for it). */
  onHeight?: (px: number) => void;
  /** Play all as soon as the card has read what changed (a row's "Play its changes", Space on a row). */
  autoPlay?: boolean;
  id?: string;
}

const isAgent = (v: Version) => v.author.kind === "agent" || v.author.kind === "subagent";
const reason = (e: unknown) => (e instanceof Error && e.message ? e.message : typeof e === "string" ? e : undefined);

export function VersionCard(p: VersionCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const v = p.version;
  const versions = p.group && p.group.length > 1 ? p.group : null;
  // What it is: each version's id, ref, whether it's sent and its words (a provisional version confirmed keeps its id,
  // with a new ref and content: review #3), so the card reads it again when any of them changes
  const ids = (versions ?? [v]).map((x) => `${x.id}|${x.ref}|${x.provisional ? 1 : 0}|${x.changes ?? ""}|${x.summary}`).join("\n");
  // What it did: its own changes (a group's: every version's), in timeline order. Only an open card asks.
  const did = useAsync<readonly Change[]>(async () => {
    const one = (x: Version) => ui.changesIn(x.id).catch((e: unknown) => sentences(x, e));
    if (!versions) return one(v);
    // a group's versions can each change one record: each row its own key, so ▶ and the lit row are that change alone
    const lists = await Promise.all(versions.map(async (x) => (await one(x)).map((c) => ({ ...c, key: `${x.id}/${c.key}` }))));
    return lists.flat().sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  }, [ui, ids]);
  // How far your edit has moved on since (DESIGN §5.2): an older, confirmed version only
  const sinceable = !p.newest && !!p.head && !v.provisional && v.ref !== p.head;
  const since = useAsync<number | null>(async () => (sinceable ? (await ui.changes(v.ref, p.head!)).length : null), [ui, v.ref, p.head, sinceable]);
  const [all, setAll] = useState(false);
  const [lit, setLit] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; why?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const label = versionLabel(v, { locale, actor: ui.actor.bind(ui) });
  const root = useRef<HTMLDivElement>(null);

  // The list makes room for the card as it lays out (rows wrapping at 300 px, the confirmation opening)
  const onHeight = useRef(p.onHeight);
  onHeight.current = p.onHeight;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => {
      const px = el.offsetHeight;
      if (px > 0) onHeight.current?.(px);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const changes = did.status === "ready" ? did.value : null;
  const playing = p.playing && p.playing.versionId === v.id ? p.playing : null;
  const waiting = !!v.provisional;
  const turn = isAgent(v) && (v.kind === "turn" || !!v.turn);
  const play = (only?: Change) => {
    if (!changes || !p.onPlay) return;
    setError(null);
    p.onPlay({ version: v, changes, ...(only ? { only } : {}), newest: p.newest });
  };
  // "Play its changes" from the row's menu, or Space on the row: once what changed is known
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    if (p.autoPlay && changes && changes.length && !waiting && !v.empty) playRef.current();
  }, [p.autoPlay, changes, waiting, v.empty]);
  const act = (run: () => Promise<unknown>, failed: string) => {
    setError(null);
    setBusy(true);
    run().then(
      (r) => {
        setBusy(false);
        const res = r as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false) setError({ text: failed, why: res.error });
        else p.onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError({ text: failed, why: reason(e) });
      },
    );
  };

  // Leaving Restore… or New cut keeps the keyboard in the card (its focused control goes: review #8): once the step has
  // closed (after the render that removed it, whatever the runtime's timing), focus that fell out comes to the card
  const leaveMode = () => p.onMode?.(null);
  const lastMode = useRef(p.mode ?? null);
  useEffect(() => {
    const was = lastMode.current;
    lastMode.current = p.mode ?? null;
    if (!was || p.mode) return;
    const el = root.current, at = document.activeElement;
    if (el && (!at || at === document.body || !at.isConnected || !el.contains(at))) el.focus({ preventScroll: true });
  }, [p.mode]);
  // Esc closes the card (the innermost layer, DESIGN §7); ↓ from its buttons goes into the change rows
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      if (t.tagName === "INPUT") return; // a field's own Esc (the new cut's name) goes first
      e.preventDefault();
      e.stopPropagation();
      if (p.mode) leaveMode();
      else p.onClose();
      return;
    }
    if (e.key === "ArrowDown" && !t.closest(".carton-changes") && t.tagName !== "INPUT") {
      const first = root.current?.querySelector<HTMLElement>(".carton-change[data-change-key]");
      if (first) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
      }
    }
  };

  // (a teammate's cut offers no Restore: a mode asked for anyway, by a host, shows nothing of it)
  const mode = p.readOnly && p.mode === "restore" ? null : (p.mode ?? null);
  const shown = changes ? (mode ? changes.slice(0, 1) : all ? changes.slice(0, CARD_ROWS_MAX) : changes.slice(0, CARD_ROWS)) : [];
  const more = changes ? changes.length - shown.length : 0;
  const showAuthor = useMemo(() => !!changes && new Set(changes.map((c) => c.author?.key ?? "")).size > 1, [changes]);
  const oldest = versions ? versions[versions.length - 1]! : v;
  const seeAll = () => p.onCompare?.(oldest.base ?? v.ref, v.ref);
  const n = since.status === "ready" ? since.value : null;

  const rows: ReactNode =
    did.status === "loading"
      ? h("div", { className: "carton-card-skeleton", "aria-label": words.loadingChanges, role: "status" }, h("span"), h("span"))
      : did.status === "error"
        ? h("p", { className: "carton-error carton-card-error", role: "alert", title: reason(did.error) }, words.failed)
        : changes && changes.length === 0
          ? h("p", { className: "carton-card-none" }, words.noChangesInVersion)
          : h(
              Fragment,
              null,
              mode ? null : h(ChangeMap, { changes: changes ?? [], lit: playing?.key ?? lit }),
              h(
                ChangeList,
                { label: words.cardRegion(label) },
                ...shown.map((c) =>
                  h(ChangeRow, {
                    key: c.key,
                    change: c,
                    showAuthor,
                    playing: playing?.key === c.key,
                    active: lit === c.key,
                    onPlay: p.onPlay && !waiting && !v.empty ? (x: Change) => play(x) : undefined,
                    onPause: p.onPause,
                    onSelect: p.onSeek ? (x: Change) => x.at !== undefined && p.onSeek!(x.at) : undefined,
                    onHover: setLit,
                  }),
                ),
              ),
              more > 0
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "carton-card-more",
                      onClick: () => (mode ? leaveMode() : !all && changes!.length <= CARD_ROWS_MAX ? setAll(true) : seeAll()),
                    },
                    !mode && all && changes!.length > CARD_ROWS_MAX && p.onCompare ? words.seeAll(changes!.length) : words.andMore(more),
                  )
                : all && changes && changes.length > CARD_ROWS
                  ? h("button", { type: "button", className: "carton-card-more", onClick: () => setAll(false) }, words.showLess)
                  : null,
            );

  // The since line: "Your edit has 7 changes since this · See them" (the count in bold)
  const sinceLine =
    sinceable && n !== null && !mode
      ? h(
          "div",
          { className: "carton-card-since" },
          h(Icon, { name: "versions", size: 12 }),
          n === 0 ? h("span", null, words.sameSinceThis) : h("span", null, ...bold(words.changesSince(n), words.changes(n))),
          n > 0 && p.onCompare ? h("button", { type: "button", className: "carton-link", onClick: () => p.onCompare!(v.ref, p.head!) }, words.seeThem) : null,
        )
      : null;

  const footer: ReactNode =
    mode === "restore"
      ? h(
          "div",
          { className: "carton-card-confirm", role: "group", "aria-label": words.restoreQuestion(label) },
          h("p", { className: "carton-card-confirm-title" }, words.restoreQuestion(label)),
          h("p", { className: "carton-card-confirm-body" }, words.restoreBody(n ?? 0)),
          h(
            "div",
            { className: "carton-card-actions" },
            h(Button, { variant: "primary", icon: "restoreArc", busy, onClick: () => act(() => ui.restore(v.ref), words.restoreFailed) }, words.restore),
            h(Button, { variant: "ghost", onClick: leaveMode }, words.cancel),
            h("span", { className: "carton-card-gap" }),
            n && p.onCompare ? h("button", { type: "button", className: "carton-link", onClick: () => p.onCompare!(v.ref, p.head!) }, words.seeThe(n)) : null,
          ),
        )
      : mode === "newCut"
        ? h(NewCutForm, { cutName: p.cutName ?? words.mainCut, busy, onCancel: leaveMode, onSave: (name: string) => act(() => ui.newCut(name, v.ref), words.newCutFailed) })
        : h(
            "div",
            { className: "carton-card-actions" },
            v.empty
              ? null
              : playing
                ? h(Button, { icon: "pause", onClick: () => p.onPause?.() }, words.pause)
                : h(Button, { icon: "play", disabled: !changes?.length || !p.onPlay || waiting, description: waiting ? words.availableOnceSent : undefined, onClick: () => play() }, words.playAll),
            v.empty ? null : (p.before ?? null),
            p.readOnly
              ? null
              : p.newest
              ? turn
                ? h(Button, { variant: "ghost", icon: "undo", busy, title: words.undoThisTurnHint(v.changes ?? changes?.length ?? v.turn?.edits ?? 0), onClick: () => act(() => ui.undoTurnOf(v.id), words.undoTurnFailed) }, words.undoThisTurn)
                : null
              : v.empty
                ? null
                : h(Button, { variant: "ghost", icon: "restoreArc", disabled: waiting, description: waiting ? words.availableOnceSent : undefined, onClick: () => p.onMode?.("restore") }, words.restoreEllipsis),
            h("span", { className: "carton-card-gap" }),
            p.onMenu
              ? h(Button, { variant: "ghost", icon: "dots", label: words.versionActions(label), className: "carton-card-menu", onClick: (e) => p.onMenu!(e.currentTarget) })
              : null,
          );

  return h(
    "div",
    {
      ref: root,
      id: p.id,
      role: "region",
      "aria-label": words.cardRegion(label),
      // focusable itself, so the keyboard stays in the card when a step inside it closes
      tabIndex: -1,
      className: cx("carton-card-version", mode ? `carton-card-${mode}` : null),
      "data-own-keys": "",
      onKeyDown,
    },
    sinceLine,
    rows,
    error ? h("p", { className: "carton-error carton-card-error", role: "alert", title: error.why }, error.text) : null,
    footer,
  );
}

/**
 * A host whose engine can't list a version's changes as rows yet (PLAN 0.1 still landing in from-carton.ts): the
 * version's own sentences (`details`, else its summary), as rows with no place and no kind of clip. Rethrows when it
 * has none, so the card says it failed.
 */
function sentences(v: Version, e: unknown): readonly Change[] {
  const lines = v.details?.length ? v.details : v.summary ? [v.summary] : null;
  if (!lines) throw e;
  return lines.map((text, i) => ({ key: `${v.id}:${i}`, text, kind: "change" as const, clip: "project" as const, author: v.author, when: v.at }));
}

/** "Your edit has 7 changes since this", with "7 changes" in bold. */
function bold(text: string, part: string): ReactNode[] {
  const i = text.indexOf(part);
  if (i < 0) return [text];
  return [text.slice(0, i), h("b", { key: "b" }, part), text.slice(i + part.length)];
}

/** New cut from this version (DESIGN §6.2): its name, what happens, Make cut. */
function NewCutForm(p: { cutName: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const words = useWords();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const save = useCallback(() => {
    const name = value.trim();
    if (name) p.onSave(name);
  }, [value, p]);
  return h(
    "form",
    {
      className: "carton-card-newcut",
      onSubmit: (e: { preventDefault(): void }) => {
        e.preventDefault();
        save();
      },
    },
    h(
      "label",
      { className: "carton-field" },
      h("span", { className: "carton-field-label" }, words.newCutTitle),
      h("input", {
        ref,
        className: "carton-input",
        value,
        placeholder: words.newCutPlaceholder,
        maxLength: 120,
        onChange: (e: { currentTarget: HTMLInputElement }) => setValue(e.currentTarget.value),
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            p.onCancel();
          }
        },
      }),
    ),
    h("p", { className: "carton-card-hint" }, words.newCutSwitch(p.cutName)),
    h(
      "div",
      { className: "carton-card-actions" },
      h(Button, { type: "submit", variant: "primary", busy: p.busy, disabled: !value.trim() }, words.makeCut),
      h(Button, { variant: "ghost", onClick: p.onCancel }, words.cancel),
    ),
  );
}
