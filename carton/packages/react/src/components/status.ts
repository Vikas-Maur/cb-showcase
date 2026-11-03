// Small status pieces that live in toolbars: the sync status words, the published cut's status, Undo turn, the
// credits popover, and viewing's frame round the stage (the read-only preview banner before it). Each subscribes to its
// one topic only.

import { Fragment, createElement as h, useEffect, useRef, useState, type RefObject } from "react";
import { actorLabel } from "../actors.ts";
import { exactTime, when } from "../format.ts";
import { useAction, useAsync, useCartonUi, useLocale, useNow, usePreview, usePublishedShown, useSyncStatus, useUndoTurn, useViewing, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { Credits, Viewing } from "../model.ts";
import { ActorName, Avatar, Button, HoverMore, cx } from "./ui.ts";

/** Syncing · Up to date · Offline: N edits waiting (§0.1, §13). Nothing for a cut that isn't shared. */
export function SyncStatusWords({ className }: { className?: string }) {
  const s = useSyncStatus();
  const words = useWords();
  if (s.kind === "local") return null;
  const [icon, text, hint]: [IconName, string, string] =
    s.kind === "syncing"
      ? ["syncing", words.syncing, words.syncingHint]
      : s.kind === "upToDate"
        ? ["cloudCheck", words.upToDate, words.upToDateHint]
        : ["cloudSlash", words.offline(s.waiting), words.offlineHint];
  return h(
    "span",
    { className: cx("carton-sync", className), "data-state": s.kind, role: "status", "aria-live": "polite", "data-carton-tip": hint },
    h(Icon, { name: icon, size: 14 }),
    h("span", null, text),
  );
}

/** Published cut status: what the share link shows, and "Newer edits exist" when the cut moved on. */
export function PublishedStatus({ className, onOpen }: { className?: string; onOpen?: (url: string) => void }) {
  // Re-renders only when what it shows changes: whether newer edits exist, not each new one (U7).
  const pub = usePublishedShown();
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const [publish, busy] = useAction(() => ui.publish(pub!.cutId));
  if (!pub) return null;
  const stale = pub.newerEdits > 0;
  return h(
    "div",
    { className: cx("carton-published", className), "data-stale": stale ? "" : undefined },
    h(Icon, { name: "link", size: 14 }),
    h(
      "div",
      { className: "carton-published-text" },
      h(
        "span",
        { className: "carton-published-meta" },
        h("span", null, words.publishedCut),
        stale ? h("span", { className: "carton-badge", "data-tone": "warning", "data-carton-tip": words.newerEditsHint }, words.newerEdits) : null,
        h("time", { dateTime: new Date(pub.at).toISOString(), "data-carton-tip": exactTime(pub.at, locale) }, when(pub.at, now, locale, words.justNow)),
      ),
      h("span", { className: "carton-published-name", title: pub.versionName ? `${pub.cutName} · ${pub.versionName}` : pub.cutName }, pub.versionName ? `${pub.cutName} · ${pub.versionName}` : pub.cutName),
      stale ? null : h("span", { className: "carton-published-meta" }, words.upToDatePublished),
    ),
    h(
      "div",
      { className: "carton-published-actions" },
      pub.url && onOpen ? h(Button, { variant: "ghost", icon: "eye", onClick: () => onOpen(pub.url!) }, words.openShareLink) : null,
      stale ? h(Button, { variant: "primary", busy, onClick: () => void publish() }, words.publishAgain) : null,
    ),
  );
}

/** Undo turn (§8): undoes your group's newest turn, labelled "Undo Director: tighter intro". */
export function UndoTurnButton({ className }: { className?: string }) {
  const turn = useUndoTurn();
  const ui = useCartonUi();
  const words = useWords();
  const [note, setNote] = useState<string | null>(null);
  const [undo, busy] = useAction(async () => {
    const r = await ui.undo(turn!.id);
    setNote(r.ok ? null : r.conflicts?.length ? words.undoConflict : (r.error ?? words.failed));
    return r;
  });
  useEffect(() => setNote(null), [turn?.id]);
  if (!turn) return h(Button, { className: cx("carton-undo", className), icon: "restore", disabled: true, title: words.undoNothing }, words.undoTurn);
  const who = actorLabel(turn.author, ui.actor.bind(ui), words.you);
  const label = words.undoLabel(who, turn.label);
  return h(
    "span",
    { className: cx("carton-undo-wrap", className) },
    h(Button, { className: "carton-undo", icon: "restore", busy, onClick: () => void undo(), title: turn.edits != null ? words.turnEdits(turn.edits) : undefined }, label),
    note ? h("span", { className: "carton-undo-note", role: "alert" }, note) : null,
  );
}

/** Credits for one clip: who changed which part of it, down to the subagent. */
export function CreditsPopover({ itemId, credits, onClose, className }: { itemId: string; credits?: Credits; onClose?: () => void; className?: string }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const loaded = useAsync(() => (credits ? Promise.resolve(credits) : ui.credits(itemId)), [ui, itemId, credits]);
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const down = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [onClose]);
  const c = loaded.status === "ready" ? loaded.value : null;
  return h(
    "div",
    { ref, className: cx("carton-popover carton-credits", className), role: "dialog", "aria-label": c ? words.creditsFor(c.clip) : words.credits },
    h("div", { className: "carton-popover-head" }, h("span", { className: "carton-popover-title" }, c ? words.creditsFor(c.clip) : words.credits)),
    loaded.status === "loading"
      ? h("p", { className: "carton-muted" }, words.loading)
      : loaded.status === "error"
        ? h("p", { className: "carton-error", role: "alert" }, words.failed)
        : !c!.lines.length
          ? h("p", { className: "carton-muted" }, words.creditsEmpty)
          : h(
              "ul",
              { className: "carton-credits-list" },
              ...c!.lines.map((l, i) =>
                h(
                  "li",
                  { key: i, className: "carton-credit" },
                  h("span", { className: "carton-credit-what" }, l.what),
                  h("span", { className: "carton-credit-who" }, h(Avatar, { actor: l.author, size: 16, named: true }), h(ActorName, { actor: l.author, detail: true })),
                  l.at != null
                    ? h(HoverMore, { as: "time", className: "carton-credit-when", dateTime: new Date(l.at).toISOString(), short: when(l.at, now, locale, words.justNow), more: exactTime(l.at, locale) })
                    : h("span", { className: "carton-credit-when" }),
                ),
              ),
            ),
  );
}

/**
 * Esc back to your edit while viewing (regress 2026-11-02 #4, UI audit P2-1: while viewing, focus is on the page itself,
 * so Esc reached nothing). Esc returns only when it was nobody else's: focus on the page (<body>) or inside `inside`
 * (the frame's label, the banner), and decided once the key has reached every handler (not by which listened first: a
 * chat approval that appears while viewing registers after this one). It stays when a handler took it
 * (`preventDefault`: a menu, a dialog, the chat's approval card) or when it changed what the host's own Esc changes
 * (`escapeState`; Cardboard's clip selection, which its Esc clears without saying so): that Esc was theirs, and the
 * next one returns. That state is read as the key arrives (the capture phase), so the host's listener may come before
 * or after this one (final re-check N2). Listened for only while `open`. `viewing()` says whether there is still
 * something to come back from (read again once the key has been everyone's); `back()` comes back.
 */
export function useEscapeBack(p: { open: boolean; viewing: () => boolean; back: () => unknown; escapeState?: () => unknown; inside: RefObject<HTMLElement | null> }): void {
  const state = useRef(p.escapeState);
  state.current = p.escapeState;
  const live = useRef(p);
  live.current = p;
  const { open } = p;
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The host's state as the key found it, read in the capture phase: before every page listener, whichever was
    // registered first (final re-check N2: Cardboard registers its Esc-deselect again on every selection change, so a
    // clip selected before the preview put it ahead of this listener, which then read the selection already cleared).
    let seen: { e: KeyboardEvent; before: unknown } | null = null;
    const onCapture = (e: KeyboardEvent) => {
      seen = e.key === "Escape" && state.current ? { e, before: state.current() } : null;
    };
    const onKey = (e: KeyboardEvent) => {
      const was = seen?.e === e ? seen : null;
      seen = null;
      // viewing ended a moment ago (this listener goes after the render): the key isn't ours
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || !live.current.viewing()) return;
      const t = e.target as Node | null, doc = t?.ownerDocument ?? document;
      if (t && t !== doc.body && t !== doc.documentElement && t !== doc && !live.current.inside.current?.contains(t)) return;
      const before = was ? was.before : state.current?.();
      // a task, not a microtask: one runs between two listeners of the same key
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (e.defaultPrevented || !live.current.viewing() || (state.current && !Object.is(state.current(), before))) return;
        live.current.back();
      }, 0);
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKey);
      if (timer) clearTimeout(timer);
    };
  }, [open]);
}

/**
 * Deprecated: `ViewingFrame` (UX redesign PLAN 1.1) replaces it in the app. Kept one release for the gallery. Shown while a preview is open (§9, R2-16), with the way back to editing: one click, or Esc (useEscapeBack).
 */
export function PreviewBanner({ className, escapeState }: { className?: string; escapeState?: () => unknown }) {
  const preview = usePreview();
  const ui = useCartonUi();
  const words = useWords();
  const banner = useRef<HTMLDivElement>(null);
  useEscapeBack({ open: !!preview, viewing: () => !!ui.preview(), back: () => ui.openPreview(null), escapeState, inside: banner });
  if (!preview) return null;
  return h(
    "div",
    { ref: banner, className: cx("carton-preview-banner", className), role: "status", "data-blocked": preview.blockedEdit ? "" : undefined },
    h(Icon, { name: "eye", size: 14 }),
    h("span", { className: "carton-preview-label", title: words.previewing(preview.label) }, words.previewing(preview.label)),
    preview.blockedEdit ? h("span", { className: "carton-preview-blocked" }, words.previewBlocked) : null,
    h(Button, { variant: "primary", icon: "arrowLeft", keys: "Escape", title: words.returnToCurrentKey, onClick: () => ui.openPreview(null) }, words.returnToCurrent),
  );
}

export interface ViewingFrameProps {
  /** What the stage shows when it isn't your edit; default `ui.viewing()`. A host that knows more passes its own. */
  viewing?: Viewing | null;
  /**
   * The label tab on the frame's top-left corner, with its ✕ (DESIGN §4.2): only when History's list isn't on screen to
   * mark the row viewed (a conflict's side, Comments' "See it as it was", the panel closed). Default true.
   */
  label?: boolean;
  /** Back to your edit (the tab's ✕, Esc); default `ui.view(null)`. */
  onBack?: () => unknown;
  /** Whether there is still something to come back from, read as an Esc lands; default `ui.viewing()`. */
  isViewing?: () => boolean;
  /** The host's own Esc state (useEscapeBack): Cardboard's clip selection. */
  escapeState?: () => unknown;
  /** Goes up by one at each edit tried while viewing: the frame pulses once (PLAN 1.4). */
  pulse?: number;
  className?: string;
}

/**
 * Viewing on the stage (UX redesign PLAN 1.1, DESIGN §4.2), in place of the preview banner: a 2 px blue frame round the
 * stage, over nothing in the picture, and, only when History's list isn't on screen, a small tab on its top-left corner
 * with the one label (the chip's and the row's: "Director's “Add captions…”") and ✕ "Back to my edit (Esc)". Esc
 * returns as the banner's did (useEscapeBack: the capture-phase state, the editor's own Esc first). Viewing and the
 * return are announced once each, politely ("Looking at …. Esc to go back.", "Back to your edit"), never per frame.
 */
export function ViewingFrame(p: ViewingFrameProps) {
  const ui = useCartonUi();
  const words = useWords();
  const own = useViewing();
  const v = p.viewing !== undefined ? p.viewing : own;
  const frame = useRef<HTMLDivElement>(null);
  const shown = useRef(v);
  shown.current = v;
  const back = () => void Promise.resolve(p.onBack ? p.onBack() : ui.view(null)).catch(() => undefined);
  const isViewing = p.isViewing ?? (() => !!(p.viewing !== undefined ? shown.current : ui.viewing()));
  useEscapeBack({ open: !!v, viewing: isViewing, back, escapeState: p.escapeState, inside: frame });
  // What the live region says: a new label when viewing starts or changes, "Back to your edit" once it ends. A frame
  // still waiting for its label (a swap made at once, PLAN 4.3) says nothing yet: its label, when it comes.
  const open = !!v;
  const label = v?.label || null;
  const [said, setSaid] = useState("");
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      if (last.current) setSaid(words.backAnnounce);
      last.current = null;
    } else if (label && label !== last.current) {
      last.current = label;
      setSaid(words.lookingAtAnnounce(label));
    }
  }, [open, label, words]);
  const tab = p.label !== false && !!label;
  return h(
    Fragment,
    null,
    h("span", { className: "carton-sr", role: "status", "aria-live": "polite" }, said),
    v
      ? h(
          "div",
          {
            ref: frame,
            className: cx("carton-frame", p.className),
            "data-kind": v.kind,
            "data-label": tab ? "" : undefined,
            // two names for one pulse: a new attempt switches the animation, so it plays again from the start
            "data-pulse": p.pulse ? (p.pulse % 2 ? "a" : "b") : undefined,
          },
          tab
            ? h(
                "div",
                { className: "carton-frame-label" },
                h(Icon, { name: "eye", size: 13 }),
                h("span", { className: "carton-frame-text", title: label! }, label),
                h("button", { type: "button", className: "carton-frame-back", "aria-label": words.backToMyEditKey, title: words.backToMyEditKey, "aria-keyshortcuts": "Escape", onClick: back }, h(Icon, { name: "x", size: 12 })),
              )
            : null,
        )
      : null,
  );
}
