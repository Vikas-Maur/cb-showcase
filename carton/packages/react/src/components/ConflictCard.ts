// Conflict cards (§0.1, §7): both edits are kept, and you pick. Nothing is decided silently: until you pick, the edit
// shows the provisional side, and the card says which one that is.

import { createElement as h, memo } from "react";
import { when } from "../format.ts";
import { useAction, useCartonUi, useConflicts, useLocale, useNow, useWords } from "../hooks.ts";
import type { Conflict, ConflictChoice, ConflictSide } from "../model.ts";
import { ActorName, Avatar, Button, cx } from "./ui.ts";
import { Icon } from "../icons.ts";
import type { Words } from "../words.ts";

export interface ConflictCardProps {
  conflict: Conflict;
  /** Pick without applying (the fold dialog collects choices first). Default: resolve it now. */
  onPick?: (choice: ConflictChoice) => void;
  /** The pick made so far, when the parent holds it. */
  picked?: ConflictChoice;
  className?: string;
}

function SideView({ side, which, showing }: { side: ConflictSide; which: "mine" | "theirs"; showing: boolean }) {
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  return h(
    "div",
    { className: "carton-conflict-side", "data-side": which, "data-showing": showing ? "" : undefined },
    h(
      "div",
      { className: "carton-conflict-who" },
      h(Avatar, { actor: side.author, size: 16 }),
      h(ActorName, { actor: side.author }),
      side.at != null ? h("time", { dateTime: new Date(side.at).toISOString() }, when(side.at, now, locale, words.justNow)) : null,
      side.where ? h("span", { className: "carton-conflict-where" }, side.where) : null,
      showing ? h("span", { className: "carton-badge", "data-tone": "muted" }, words.showingNow) : null,
    ),
    h("p", { className: "carton-conflict-what" }, side.summary),
  );
}

/** "Keep yours (Main cut)", "Keep Director's (30s Instagram cut)": who, and where when the sides are on two cuts. */
function keepLabel(side: ConflictSide, words: Words): string {
  const a = side.author;
  return a.isYou && a.kind === "human" ? words.keepYours(side.where) : words.keepOf(a.name, side.where);
}

export const ConflictCard = memo(function ConflictCard(p: ConflictCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const [resolve, busy] = useAction((choice: ConflictChoice) => ui.resolve(p.conflict.id, choice));
  const c = p.conflict;
  const pick = (choice: ConflictChoice) => (p.onPick ? p.onPick(choice) : void resolve(choice));
  const showing = p.picked ?? c.provisional ?? "mine";
  const btn = (choice: ConflictChoice, label: string) =>
    h(Button, { variant: p.picked === choice ? "primary" : "secondary", pressed: p.onPick ? p.picked === choice : undefined, busy, onClick: () => pick(choice) }, label);
  return h(
    "section",
    { className: cx("carton-card carton-conflict", p.className), "aria-label": `${words.conflictCard}: ${c.title}` },
    h(
      "header",
      { className: "carton-card-head" },
      h(Icon, { name: "warning", className: "carton-conflict-icon" }),
      h("div", null, h("h3", { className: "carton-card-title" }, c.title), h("p", { className: "carton-card-sub" }, c.reason ?? words.conflictLead)),
    ),
    h(
      "div",
      { className: "carton-conflict-sides" },
      h(SideView, { side: c.mine, which: "mine", showing: showing === "mine" }),
      h(SideView, { side: c.theirs, which: "theirs", showing: showing === "theirs" }),
    ),
    h(
      "div",
      { className: "carton-card-actions" },
      btn("mine", keepLabel(c.mine, words)),
      btn("theirs", keepLabel(c.theirs, words)),
      c.canKeepBoth ? btn("both", words.keepBoth) : null,
    ),
  );
});

/** Every open conflict card, newest first, with a count. Renders nothing when there are none. */
export function ConflictList({ className }: { className?: string }) {
  const conflicts = useConflicts();
  const words = useWords();
  if (!conflicts.length) return null;
  return h(
    "div",
    { className: cx("carton-conflicts", className), role: "region", "aria-label": words.conflictsWaiting(conflicts.length) },
    h("p", { className: "carton-conflicts-count" }, words.conflictsWaiting(conflicts.length)),
    ...conflicts.map((c) => h(ConflictCard, { key: c.id, conflict: c })),
  );
}
