// Compare card (§9, generalizing the recovery picker): for two versions, when and by whom, how many clips, how long,
// and "N shots / X s of Y s differ", with a way into Watch the changes.

import { createElement as h, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { duration, exactTime, when } from "../format.ts";
import { useAsync, useCartonUi, useLocale, useNow, useWords } from "../hooks.ts";
import type { CompareSide, Comparison } from "../model.ts";
import { ActorName, Avatar, Button, HoverMore, cx } from "./ui.ts";

export interface CompareCardProps {
  a: string;
  b: string;
  /** Show this comparison instead of asking the view model (gallery, hosts that already have it). */
  comparison?: Comparison;
  onWatch?: (a: string, b: string) => void;
  onRestore?: () => void;
  onClose?: () => void;
  className?: string;
}

function Side({ side, now }: { side: CompareSide; now: number }) {
  const words = useWords();
  const locale = useLocale();
  return h(
    "div",
    { className: "carton-compare-side" },
    h("div", { className: "carton-compare-label" }, side.label),
    h(
      "dl",
      { className: "carton-facts" },
      h("dt", null, words.factWhen),
      h("dd", null, h(HoverMore, { as: "time", dateTime: new Date(side.at).toISOString(), short: when(side.at, now, locale, words.justNow), more: exactTime(side.at, locale) })),
      h("dt", null, words.factWho),
      h("dd", { className: "carton-compare-who" }, h(Avatar, { actor: side.author, size: 14, named: true }), h(ActorName, { actor: side.author })),
      h("dt", null, words.factClips),
      h("dd", null, words.clips(side.clipCount)),
      h("dt", null, words.factLength),
      h("dd", null, duration(side.length)),
    ),
  );
}

/** Changes listed at once on the card; "Show N more" lists the rest. */
const COMPARE_SHOWN = 5;

export function CompareCard(p: CompareCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const now = useNow();
  const loaded = useAsync(() => (p.comparison ? Promise.resolve(p.comparison) : ui.compare(p.a, p.b)), [ui, p.a, p.b, p.comparison]);
  // The card takes focus when it opens, and Esc closes it (only it: UI audit P2-1).
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [p.a, p.b]);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || !p.onClose) return;
    e.preventDefault();
    e.stopPropagation();
    p.onClose();
  };
  const [all, setAll] = useState(false);
  let body: ReactNode;
  if (loaded.status === "loading") body = h("p", { className: "carton-muted" }, words.loading);
  else if (loaded.status === "error") body = h("p", { className: "carton-error", role: "alert" }, words.failed);
  else {
    const c = loaded.value;
    // What changed, first (UI audit P2-5): the changes in History's words, a few at once, the rest one click away.
    const changes = c.changes ?? null;
    const shown = changes ? (all ? changes : changes.slice(0, COMPARE_SHOWN)) : [];
    const same = changes ? changes.length === 0 : c.diff.shots === 0;
    body = [
      h(
        "p",
        { key: "diff", className: "carton-compare-diff", "data-same": same ? "" : undefined },
        words.compareSummary(changes ? changes.length : null, c.diff.seconds, c.diff.total),
      ),
      shown.length
        ? h(
            "ul",
            { key: "changes", className: "carton-compare-changes", "aria-label": words.compareChanges },
            ...shown.map((t, i) => h("li", { key: i, className: "carton-compare-change", title: t }, t)),
          )
        : null,
      changes && changes.length > COMPARE_SHOWN
        ? h(Button, { key: "more", variant: "ghost", className: "carton-compare-more", onClick: () => setAll((x) => !x) }, all ? words.compareLess : words.compareMore(changes.length - COMPARE_SHOWN))
        : null,
      h("div", { key: "sides", className: "carton-compare-sides" }, h(Side, { side: c.a, now }), h(Side, { side: c.b, now })),
    ];
  }
  return h(
    "section",
    { ref: root, tabIndex: -1, onKeyDown, className: cx("carton-card carton-compare", p.className), "aria-label": words.compare },
    h(
      "header",
      { className: "carton-card-head" },
      h("h3", { className: "carton-card-title" }, words.compare),
      p.onClose ? h(Button, { variant: "ghost", icon: "x", label: words.close, title: `${words.close} (Esc)`, onClick: p.onClose }) : null,
    ),
    body,
    h(
      "div",
      { className: "carton-card-actions" },
      p.onRestore ? h(Button, { icon: "restore", onClick: p.onRestore, description: words.restoreHint }, words.restore) : null,
      p.onWatch
        ? h(Button, { variant: "primary", icon: "eye", disabled: loaded.status !== "ready" || loaded.value.diff.shots === 0, description: loaded.status === "ready" && loaded.value.diff.shots === 0 && loaded.value.changes?.length ? "These changes don't change the picture." : undefined, onClick: () => p.onWatch!(p.a, p.b) }, words.watchTheChanges)
        : null,
    ),
  );
}
