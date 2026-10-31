// Fold in (§0.1: merge). Shows what folding one cut into another brings in, in plain words, lets you leave some of it
// out ("fold in some of it", partial accept, §5.3 / R2-14), and asks you to pick on any conflict card before folding.
// Leaving changes out is recorded, so "you can fold in the rest later".

import { createElement as h, useMemo, useState } from "react";
import { when } from "../format.ts";
import { useAction, useAsync, useCartonUi, useLocale, useNow, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { ConflictChoice, FoldPlan, FoldResult } from "../model.ts";
import { ConflictCard } from "./ConflictCard.ts";
import { ActorName, Avatar, Button, Dialog } from "./ui.ts";

export interface FoldInDialogProps {
  fromCutId: string;
  intoCutId: string;
  onClose: () => void;
  onDone?: (r: FoldResult) => void;
  /** Use this plan instead of asking the view model (gallery). */
  plan?: FoldPlan;
}

export function FoldInDialog(p: FoldInDialogProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  // §13: after "bring it in with every difference shown as a card", the plan and the fold use the 2-way compare.
  const [allCards, setAllCards] = useState(false);
  const loaded = useAsync(
    () => (p.plan ? Promise.resolve(p.plan) : ui.planFold(p.fromCutId, p.intoCutId, allCards ? { allCards } : undefined)),
    [ui, p.fromCutId, p.intoCutId, p.plan, allCards],
  );
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<Readonly<Record<string, ConflictChoice>>>({});
  const [result, setResult] = useState<FoldResult | null>(null);
  const [fold, busy] = useAction(async () => {
    const r = await ui.fold(p.fromCutId, p.intoCutId, { leaveOut: [...left], choices, ...(allCards ? { allCards } : {}) });
    setResult(r);
    if (r.ok) p.onDone?.(r);
    return r;
  });

  const plan = loaded.status === "ready" ? loaded.value : null;
  const total = plan?.changes.length ?? 0;
  const taking = total - left.size;
  const unpicked = plan ? plan.conflicts.filter((c) => !choices[c.id]).length : 0;
  const title = plan ? words.foldTitle(plan.from.label, plan.into.label) : words.foldSomeOfIt;

  const toggle = (id: string) =>
    setLeft((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const body = useMemo(() => {
    if (loaded.status === "loading") return h("p", { className: "carton-muted" }, words.loading);
    if (loaded.status === "error") return h("p", { className: "carton-error", role: "alert" }, words.failed);
    return null;
  }, [loaded.status, words]);

  const canSplit = plan?.partial !== false;
  const content = plan?.missingBase
    ? [
        h("p", { key: "mb", className: "carton-fold-missing", role: "alert" }, plan.missingBase),
        h("div", { key: "mba", className: "carton-card-actions" }, h(Button, { onClick: () => setAllCards(true) }, words.foldAllCards)),
      ]
    : plan
    ? [
        total === 0 && !plan.conflicts.length
          ? h("p", { key: "none", className: "carton-empty" }, words.foldNothing)
          : h(
              "fieldset",
              { key: "changes", className: "carton-fold-changes" },
              h(
                "legend",
                { className: "carton-fold-legend" },
                h("span", null, words.foldChanges(total)),
                !canSplit ? h("span", { className: "carton-fold-bulk" }, words.foldAllOrNothing) : total > 1
                  ? h(
                      "span",
                      { className: "carton-fold-bulk" },
                      h(Button, { variant: "ghost", onClick: () => setLeft(new Set()), disabled: left.size === 0 }, words.selectAll),
                      h(Button, { variant: "ghost", onClick: () => setLeft(new Set(plan.changes.map((c) => c.id))), disabled: left.size === total }, words.selectNone),
                    )
                  : null,
              ),
              h(
                "ul",
                { className: "carton-fold-list" },
                ...plan.changes.map((c) =>
                  h(
                    "li",
                    { key: c.id, className: "carton-fold-change", "data-left": left.has(c.id) ? "" : undefined },
                    h(
                      "label",
                      null,
                      canSplit ? h("input", { type: "checkbox", className: "carton-check", checked: !left.has(c.id), onChange: () => toggle(c.id) }) : h("span", { "aria-hidden": true }),
                      h("span", { className: "carton-fold-text" }, c.summary),
                      h(
                        "span",
                        { className: "carton-fold-meta" },
                        h(Avatar, { actor: c.author, size: 14 }),
                        h(ActorName, { actor: c.author }),
                        h("time", null, when(c.at, now, locale, words.justNow)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        plan.conflicts.length
          ? h(
              "div",
              { key: "cards", className: "carton-fold-cards" },
              h("p", { className: "carton-fold-cards-head" }, words.foldConflicts(plan.conflicts.length)),
              ...plan.conflicts.map((c) =>
                h(ConflictCard, { key: c.id, conflict: c, picked: choices[c.id], onPick: (ch: ConflictChoice) => setChoices((s) => ({ ...s, [c.id]: ch })) }),
              ),
            )
          : null,
        plan.warnings.length
          ? h(
              "div",
              { key: "warn", className: "carton-fold-warnings", role: "note" },
              h("p", null, h(Icon, { name: "warning", size: 14 }), words.foldWarnings),
              h("ul", null, ...plan.warnings.map((w, i) => h("li", { key: i }, w))),
            )
          : null,
        result && !result.ok ? h("p", { key: "err", className: "carton-error", role: "alert" }, result.error ?? words.failed) : null,
      ]
    : body;

  const partial = plan && taking < total;
  return h(Dialog, {
    title,
    onClose: p.onClose,
    className: "carton-fold",
    children: content,
    footer: [
      partial ? h("span", { key: "later", className: "carton-fold-later" }, words.foldRestLater) : h("span", { key: "sp" }),
      h(Button, { key: "c", onClick: p.onClose }, words.cancel),
      h(
        Button,
        {
          key: "go",
          variant: "primary",
          icon: "fold",
          busy,
          disabled: !plan || !!plan.missingBase || (taking === 0 && !plan.conflicts.length) || unpicked > 0,
          title: unpicked > 0 ? words.foldConflicts(unpicked) : undefined,
          onClick: () => void fold(),
        },
        busy ? words.folding : partial ? words.foldSome(taking, total) : words.foldAll,
      ),
    ],
  });
}
