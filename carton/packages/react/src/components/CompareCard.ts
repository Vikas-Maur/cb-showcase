// Compare card (§9, generalizing the recovery picker): for two versions, when and by whom, how many clips, how long,
// and "N shots / X s of Y s differ", with a way into Watch the changes.

import { createElement as h, type ReactNode } from "react";
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

export function CompareCard(p: CompareCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const now = useNow();
  const loaded = useAsync(() => (p.comparison ? Promise.resolve(p.comparison) : ui.compare(p.a, p.b)), [ui, p.a, p.b, p.comparison]);
  let body: ReactNode;
  if (loaded.status === "loading") body = h("p", { className: "carton-muted" }, words.loading);
  else if (loaded.status === "error") body = h("p", { className: "carton-error", role: "alert" }, words.failed);
  else {
    const c = loaded.value;
    body = [
      h("div", { key: "sides", className: "carton-compare-sides" }, h(Side, { side: c.a, now }), h(Side, { side: c.b, now })),
      h(
        "p",
        { key: "diff", className: "carton-compare-diff", "data-same": c.diff.shots === 0 ? "" : undefined },
        words.differ(c.diff.shots, c.diff.seconds, c.diff.total),
      ),
    ];
  }
  return h(
    "section",
    { className: cx("carton-card carton-compare", p.className), "aria-label": words.compare },
    h(
      "header",
      { className: "carton-card-head" },
      h("h3", { className: "carton-card-title" }, words.compare),
      p.onClose ? h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: p.onClose }) : null,
    ),
    body,
    h(
      "div",
      { className: "carton-card-actions" },
      p.onRestore ? h(Button, { icon: "restore", onClick: p.onRestore, description: words.restoreHint }, words.restore) : null,
      p.onWatch
        ? h(Button, { variant: "primary", icon: "eye", disabled: loaded.status !== "ready" || loaded.value.diff.shots === 0, onClick: () => p.onWatch!(p.a, p.b) }, words.watchTheChanges)
        : null,
    ),
  );
}
