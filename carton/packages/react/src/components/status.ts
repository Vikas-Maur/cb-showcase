// Small status pieces that live in toolbars: the sync status words, the published cut's status, Undo turn, the
// credits popover and the read-only preview banner. Each subscribes to its one topic only.

import { createElement as h, useEffect, useRef, useState } from "react";
import { actorLabel } from "../actors.ts";
import { exactTime, when } from "../format.ts";
import { useAction, useAsync, useCartonUi, useLocale, useNow, usePreview, usePublishedShown, useSyncStatus, useUndoTurn, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { Credits } from "../model.ts";
import { ActorName, Avatar, Button, cx } from "./ui.ts";

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
                  h("span", { className: "carton-credit-who" }, h(Avatar, { actor: l.author, size: 16 }), h(ActorName, { actor: l.author })),
                  l.at != null
                    ? h("time", { className: "carton-credit-when", dateTime: new Date(l.at).toISOString(), "data-carton-tip": exactTime(l.at, locale) }, when(l.at, now, locale, words.justNow))
                    : h("span", { className: "carton-credit-when" }),
                ),
              ),
            ),
  );
}

/** Shown while a preview is open (§9, R2-16): it is read-only, and the way back to editing is one click. */
export function PreviewBanner({ className }: { className?: string }) {
  const preview = usePreview();
  const ui = useCartonUi();
  const words = useWords();
  if (!preview) return null;
  return h(
    "div",
    { className: cx("carton-preview-banner", className), role: "status", "data-blocked": preview.blockedEdit ? "" : undefined },
    h(Icon, { name: "eye", size: 14 }),
    h("span", { className: "carton-preview-label" }, words.previewing(preview.label)),
    h("span", { className: "carton-badge", "data-tone": "muted" }, words.readOnly),
    preview.blockedEdit ? h("span", { className: "carton-preview-blocked" }, words.previewBlocked) : null,
    h(Button, { variant: "primary", icon: "arrowLeft", onClick: () => ui.openPreview(null) }, words.returnToCurrent),
  );
}
