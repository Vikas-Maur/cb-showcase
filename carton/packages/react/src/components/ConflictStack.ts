// Conflict cards as a floating stack (§7): the newest card on top, the ones behind peeking out above it. The stack
// collapses to a small "N conflicts" pill. A card can be set aside for now ("Not now"): it stays open, listed under
// the pill, and is never decided by setting it aside. A host places the stack (Cardboard: the stage's bottom-right
// corner, clear of the timeline and the agent's chat) and gives it "See it": a read-only preview of a side, and the
// clip selected on its timeline.

import { createElement as h, useEffect, useState } from "react";
import { useConflicts, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Conflict, ConflictChoice } from "../model.ts";
import { ConflictCard } from "./ConflictCard.ts";
import { Button, cx } from "./ui.ts";

export interface ConflictStackProps {
  className?: string;
  /** Collapsed to the pill; a change of this prop collapses or opens it (the person can still toggle it). */
  collapsed?: boolean;
  /** "See it": preview the timeline with one side kept (read-only). */
  onPreview?: (conflict: Conflict, side: ConflictChoice, label: string) => void;
  /** "See it": select the card's clip on the timeline. */
  onReveal?: (conflict: Conflict) => void;
}

/** How many cards peek out behind the top one. */
const PEEKS = 2;

export function ConflictStack(p: ConflictStackProps) {
  const conflicts = useConflicts();
  const words = useWords();
  const [collapsed, setCollapsed] = useState(!!p.collapsed);
  const [aside, setAside] = useState<readonly string[]>([]);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (p.collapsed !== undefined) setCollapsed(p.collapsed);
  }, [p.collapsed]);
  if (!conflicts.length) return null;
  // A card resolved elsewhere leaves the set-aside list with it.
  const open = new Set(conflicts.map((c) => c.id));
  const asideNow = aside.filter((id) => open.has(id));
  const shown = conflicts.filter((c) => !asideNow.includes(c.id));
  const setAsideCards = conflicts.filter((c) => asideNow.includes(c.id));

  const list =
    listOpen && setAsideCards.length
      ? h(
          "div",
          { className: "carton-stack-aside", role: "region", "aria-label": words.setAsideList(setAsideCards.length) },
          h("p", { className: "carton-stack-aside-head" }, words.setAsideList(setAsideCards.length)),
          h(
            "ul",
            null,
            ...setAsideCards.map((c) =>
              h(
                "li",
                { key: c.id },
                h("span", { className: "carton-stack-aside-title" }, c.title),
                h(Button, {
                  variant: "ghost",
                  onClick: () => {
                    setAside((a) => a.filter((x) => x !== c.id));
                    setCollapsed(false);
                    if (setAsideCards.length === 1) setListOpen(false);
                  },
                }, words.showAgain),
              ),
            ),
          ),
        )
      : null;

  if (collapsed || !shown.length) {
    return h(
      "div",
      { className: cx("carton-stack", p.className), "data-collapsed": "" },
      list,
      h(
        "button",
        {
          type: "button",
          className: "carton-stack-pill",
          "aria-expanded": false,
          onClick: () => (shown.length ? (setCollapsed(false), setListOpen(false)) : setListOpen((o) => !o)),
        },
        h(Icon, { name: "warning", size: 14 }),
        words.conflictsPill(conflicts.length),
      ),
    );
  }

  const top = shown[0]!;
  const behind = Math.min(shown.length - 1, PEEKS);
  return h(
    "div",
    { className: cx("carton-stack", p.className), role: "region", "aria-label": words.conflictsWaiting(conflicts.length) },
    list,
    h(
      "div",
      { className: "carton-stack-head" },
      h("span", { className: "carton-stack-count" }, h(Icon, { name: "warning", size: 13 }), words.conflictsWaiting(conflicts.length)),
      setAsideCards.length ? h("button", { type: "button", className: "carton-see", "aria-expanded": listOpen, onClick: () => setListOpen((o) => !o) }, words.setAsideList(setAsideCards.length)) : null,
      h(Button, { variant: "ghost", icon: "caretDown", label: words.hideConflicts, title: words.hideConflicts, onClick: () => (setCollapsed(true), setListOpen(false)) }),
    ),
    h(
      "div",
      { className: "carton-stack-cards", "data-behind": behind },
      // the cards behind, peeking out above the top one: deeper ones narrower and fainter
      ...Array.from({ length: behind }, (_, i) => {
        const depth = behind - i;
        return h("div", { key: `peek${i}`, className: "carton-stack-peek", "data-depth": depth, "aria-hidden": true, style: { top: (behind - depth) * 8, left: depth * 9, right: depth * 9, opacity: 1 - depth * 0.22 } });
      }),
      h(ConflictCard, {
        key: top.id,
        conflict: top,
        onDismiss: () => setAside((a) => [...a, top.id]),
        ...(p.onPreview ? { onPreview: (side: ConflictChoice, label: string) => p.onPreview!(top, side, label) } : {}),
        ...(p.onReveal ? { onReveal: p.onReveal } : {}),
      }),
    ),
  );
}
