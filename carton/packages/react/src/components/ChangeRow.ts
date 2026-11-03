// STUB until Workstream 3 (feat/ux-3-history) lands ChangeRow, which owns this file (PLAN "Order and parallelism": 3
// owns ChangeRow and ChangeMap; 4 and 6 import them and stub them until 3 lands). Only what the Fold dialog needs:
// the change row of DESIGN §5.1, "time in the edit · the kind of clip · what happened · who", without Play.

import { createElement as h, type ReactNode } from "react";
import { timecode } from "../format.ts";
import { useWords } from "../hooks.ts";
import type { Change, ClipKind } from "../model.ts";
import { cx } from "./ui.ts";

// The kind of clip as a glyph in the set's weight (24-unit grid), on Cardboard's own timeline colour (the skin's
// [data-clip] rule): video a film frame, title a T, caption "cc", audio a note, image a picture, code brackets, a
// project setting stacked layers.
const glyphs: Record<ClipKind, readonly string[]> = {
  video: ["M4.5 6.5h15v11h-15z", "M8 6.5v11M16 6.5v11M4.5 10h3.5M4.5 14h3.5M16 10h3.5M16 14h3.5"],
  title: ["M6.5 7h11", "M12 7v10.5", "M10 17.5h4"],
  caption: ["M4.5 6.5h15v11h-15z", "M11 10.4a2 2 0 1 0 0 3.2M17 10.4a2 2 0 1 0 0 3.2"],
  audio: ["M9.5 17V6.5l9-2V15", "M9.5 17a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0zM18.5 15a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z"],
  image: ["M4.5 5.5h15v13h-15z", "M4.5 15.5l4-4 3.5 3.5 2.5-2.5 5 5"],
  code: ["M9 8l-4 4 4 4", "M15 8l4 4-4 4"],
  project: ["M12 4.5l7.5 3.8-7.5 3.8-7.5-3.8z", "M4.5 12.3l7.5 3.8 7.5-3.8", "M4.5 16.2l7.5 3.8 7.5-3.8"],
};

/** The kind-of-clip chip with its corner mark: green + added, red − removed, amber dot changed or moved. */
export function ChangeKindChip({ change }: { change: Pick<Change, "clip" | "kind"> }) {
  return h(
    "span",
    { className: "carton-change-kind", "data-clip": change.clip, "data-change": change.kind, "aria-hidden": true },
    h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", focusable: "false" }, ...glyphs[change.clip].map((d, i) => h("path", { key: i, d }))),
    h("span", { className: "carton-change-mark" }, change.kind === "add" ? "+" : change.kind === "remove" ? "−" : null),
  );
}

export interface ChangeRowProps {
  change: Change;
  /** Who and when, under the sentence (a list that mixes authors). */
  meta?: ReactNode;
  /** In front of the time: the Fold dialog's tick box or lock. */
  lead?: ReactNode;
  /** More lines under the sentence ("Can't be left out…", "Left out on Oct 30"). */
  children?: ReactNode;
  className?: string;
}

/** One change: time in the edit (— for none), the kind of clip, the sentence, who. */
export function ChangeRow(p: ChangeRowProps) {
  const words = useWords();
  const c = p.change;
  return h(
    "div",
    { className: cx("carton-change-row", p.className), "data-lead": p.lead != null ? "" : undefined },
    p.lead != null ? h("span", { className: "carton-change-lead" }, p.lead) : null,
    h("span", { className: "carton-change-at" }, c.at == null ? words.noPosition : timecode(c.at)),
    h(ChangeKindChip, { change: c }),
    h("span", { className: "carton-change-body" }, h("span", { className: "carton-change-text" }, c.text), p.meta != null ? h("span", { className: "carton-change-meta" }, p.meta) : null, p.children),
  );
}
