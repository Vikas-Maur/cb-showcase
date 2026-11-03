// Conflict cards over the stage (docs/carton-ux DESIGN §6.5, PLAN 7.2): one card at a time, with "1/2 ›" to step
// through them. "Not now" folds the card into the pill "⚠ 2 conflicts to pick" and sends it to the back of the queue;
// nothing is decided by it. While a side panel takes the room (the host's `collapsed`) or the stage shows anything but
// your edit or one of the card's own sides, the stack waits as the pill; the pill's click brings you back to your edit
// and opens the card. A host places it (Cardboard: the stage's bottom-right corner, clear of the timeline and the chat)
// and gives it "On timeline" (and, until `ui.view` reaches its editor, "See it": ConflictCard's `onPreview`).

import { createElement as h, useEffect, useRef, useState } from "react";
import { useCartonUi, useConflicts, usePreview, useViewing, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Conflict, ConflictChoice } from "../model.ts";
import { ConflictCard } from "./ConflictCard.ts";
import { cx } from "./ui.ts";

export interface ConflictStackProps {
  className?: string;
  /** Folded to the pill; a change of this prop folds or opens it (the person can still open it). */
  collapsed?: boolean;
  /** "See it" through the host (deprecated, see ConflictCard's `onPreview`): show one side on the stage under `label`. */
  onPreview?: (conflict: Conflict, side: ConflictChoice, label: string) => unknown;
  /** "On timeline": select the card's clip on the timeline. */
  onReveal?: (conflict: Conflict) => void;
}

export function ConflictStack(p: ConflictStackProps) {
  const ui = useCartonUi();
  const conflicts = useConflicts();
  const words = useWords();
  const viewing = useViewing();
  const preview = usePreview();
  const [collapsed, setCollapsed] = useState(!!p.collapsed);
  // cards sent to the back by "Not now", in the order they went
  const [later, setLater] = useState<readonly string[]>([]);
  const [cursor, setCursor] = useState(0);
  // the label a side was last shown under through the host (its "See it"), so that showing isn't "viewing elsewhere"
  const [sideLabel, setSideLabel] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // where focus goes after the person folds or opens the stack: never on its own (a card arriving mid-edit takes none)
  const focusNext = useRef<"pill" | "card" | null>(null);

  useEffect(() => {
    if (p.collapsed !== undefined) setCollapsed(p.collapsed);
  }, [p.collapsed]);
  const onStage = viewing ?? preview;
  const elsewhere = !!onStage && viewing?.kind !== "conflict" && onStage.label !== sideLabel;
  useEffect(() => {
    if (elsewhere) setCollapsed(true);
  }, [elsewhere]);
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want === "pill" ? root.current?.querySelector<HTMLElement>(".carton-stack-pill") : root.current?.querySelector<HTMLElement>("[role=radio][tabindex='0']");
    el?.focus();
  });

  if (!conflicts.length) return null;
  // The queue: open cards in their order, the ones sent to the back after them. A card resolved elsewhere leaves it.
  const open = new Set(conflicts.map((c) => c.id));
  const back = later.filter((id) => open.has(id));
  const queue = [...conflicts.filter((c) => !back.includes(c.id)), ...back.map((id) => conflicts.find((c) => c.id === id)!)];
  const i = Math.min(cursor, queue.length - 1);
  const top = queue[i]!;

  if (collapsed) {
    const openCard = () => {
      // the pill brings you back to your edit, then opens the card
      if (onStage && viewing?.kind !== "conflict") void (viewing ? ui.view(null) : (ui.openPreview(null), Promise.resolve())).catch(() => undefined);
      focusNext.current = "card";
      setCollapsed(false);
    };
    return h(
      "div",
      { ref: root, className: cx("carton-stack", p.className), "data-collapsed": "" },
      h(
        "button",
        { type: "button", className: "carton-stack-pill", "aria-expanded": false, onClick: openCard },
        h(Icon, { name: "warning", size: 14 }),
        words.conflictsToPick(conflicts.length),
        h(Icon, { name: "caretDown", size: 13 }),
      ),
    );
  }

  const notNow = () => {
    setLater((l) => [...l.filter((id) => id !== top.id), top.id]);
    setCursor(0);
    focusNext.current = "pill";
    setCollapsed(true);
  };
  return h(
    "div",
    { ref: root, className: cx("carton-stack", p.className), role: "region", "aria-label": words.conflictsToPick(conflicts.length) },
    h(ConflictCard, {
      // keyed by what it is about, so a card that takes another's place (its values changed) keeps the pick made on
      // the old one, and says to pick again
      key: top.path ?? top.id,
      conflict: top,
      onDismiss: notNow,
      place: { index: i, count: queue.length, onNext: () => setCursor((i + 1) % queue.length) },
      ...(p.onPreview
        ? {
            onPreview: (side: ConflictChoice, label: string) => {
              setSideLabel(label);
              return p.onPreview!(top, side, label);
            },
          }
        : {}),
      ...(p.onReveal ? { onReveal: p.onReveal } : {}),
    }),
  );
}
