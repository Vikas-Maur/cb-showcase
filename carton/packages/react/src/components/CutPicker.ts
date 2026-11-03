// Compare with… on another cut (Carton UX v2 N2c, DESIGN-V2 §1.12, §4.1): picking a version of any cut. Pick mode's cut
// button, or the ⇆ Compare menu's Another cut, puts that cut's History in place of the list, only to pick from: "Pick
// a version on “30s Instagram cut”", a way back to your cut, then "“30s Instagram cut” as it is now" and its versions,
// newest first. The editor stays on your cut.
//
// Cost: the cut's History is read only when it is shown, a page at a time (`CartonUi.cutHistory`, 100 versions), the next
// page when the list nears its end; the list is virtual (the rows on screen only), so a cut of 12,000 versions costs
// what one screenful does. Nothing is kept once the picker closes.

import { createElement as h, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { clockOfDay, shortDate, versionLabel } from "../format.ts";
import { useCartonUi, useCuts, useLocale, useNow, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import { actorLabel } from "../actors.ts";
import { cutRef } from "../cuts.ts";
import { dayNumber } from "../history-groups.ts";
import type { Cut, Version } from "../model.ts";
import { VirtualList } from "../virtual.ts";
import { LandmarkTag, indexLandmarks, landmarkTitle, type LandmarkIndex } from "./LandmarkRow.ts";

/** A page of another cut's History. */
export const CUT_PAGE = 100;
/** The next page is read when the first row on screen is this close to the end of what is loaded. */
const NEAR_END = 40;
const ROW = 52;

/** Whether the next page is needed: the first row on screen is near the end of what is loaded, and there is more. */
export const needsMore = (firstShown: number, loaded: number, before: number | undefined): before is number => before !== undefined && firstShown + NEAR_END > loaded;

interface State {
  readonly versions: readonly Version[];
  readonly before?: number | undefined;
  readonly marks: LandmarkIndex | null;
  readonly status: "loading" | "ready" | "error";
}

export function CutPicker(p: { cut: Cut; onPick: (ref: string) => void; onBack: () => void; initialHeight?: number | undefined }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const cuts = useCuts();
  const home = cuts.find((c) => c.current);
  const [st, setSt] = useState<State>({ versions: [], marks: null, status: "loading" });
  const reading = useRef(false);
  const seq = useRef(0);
  const read = useCallback(
    async (before?: number) => {
      if (reading.current || typeof ui.cutHistory !== "function") return;
      reading.current = true;
      const mine = seq.current;
      try {
        const r = await ui.cutHistory(p.cut.id, { limit: CUT_PAGE, ...(before !== undefined ? { before } : {}) });
        if (mine !== seq.current) return;
        setSt((s) => ({ versions: before === undefined ? r.versions : [...s.versions, ...r.versions], before: r.before, marks: r.landmarks ? indexLandmarks(r.landmarks) : s.marks, status: "ready" }));
      } catch {
        if (mine === seq.current) setSt((s) => ({ ...s, status: "error" }));
      } finally {
        reading.current = false;
      }
    },
    [ui, p.cut.id],
  );
  useEffect(() => {
    seq.current++;
    reading.current = false;
    setSt({ versions: [], marks: null, status: "loading" });
    void read();
  }, [read]);
  const label = cutRef(p.cut);
  const count = 1 + st.versions.length;
  const onFirstVisible = (top: number) => {
    if (needsMore(top, st.versions.length, st.before)) void read(st.before);
  };
  const today = dayNumber(now);
  const renderRow = (i: number): ReactNode => {
    if (i === 0)
      return h(
        "div",
        { className: "carton-version carton-cut-pick-row", role: "option", "aria-selected": false, "data-now": "", style: { height: ROW }, onClick: () => p.onPick(p.cut.id) },
        h("span", { className: "carton-version-mark", "aria-hidden": true }, h(Icon, { name: "cut", size: 13 })),
        h("span", { className: "carton-version-title" }, words.cutAsItIsNow(label)),
        h("span", { className: "carton-version-pick carton-cut-pick-go", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare),
      );
    const v = st.versions[i - 1]!;
    const mark = st.marks?.byVersion.get(v.id)?.find((l) => l.kind !== "turn");
    const prompt = v.turn?.label || ((v.author.kind === "agent" || v.author.kind === "subagent") && v.name) || null;
    const plain = prompt ? `“${prompt}”` : v.name ? v.name : v.summary || versionLabel(v, { locale, actor: ui.actor.bind(ui), start: true });
    const title = mark ? landmarkTitle(mark, words, plain) : plain;
    const who = v.author.kind === "system" ? "" : actorLabel(v.author, ui.actor.bind(ui), words.you);
    const when = dayNumber(v.at) === today ? clockOfDay(v.at, locale) : `${shortDate(v.at, locale)}, ${clockOfDay(v.at, locale)}`;
    return h(
      "div",
      { className: "carton-version carton-cut-pick-row", role: "option", "aria-selected": false, "data-named": v.name && !prompt ? "" : undefined, style: { height: ROW }, onClick: () => p.onPick(v.ref) },
      h("span", { className: "carton-version-mark", "aria-hidden": true }),
      h("span", { className: "carton-version-title" }, mark ? h(LandmarkTag, { kind: mark.kind }) : null, title),
      h("time", { className: "carton-version-when", dateTime: new Date(v.at).toISOString() }, when),
      h("span", { className: "carton-version-pick carton-cut-pick-go", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare),
      h("span", { className: "carton-version-meta" }, who ? h("span", { className: "carton-actor-name" }, who) : null, v.changes !== undefined ? h("span", { className: "carton-version-count" }, words.changes(v.changes)) : null),
    );
  };
  return h(
    "div",
    { className: "carton-cut-picker", role: "group", "aria-label": words.pickOnCut(label) },
    h(
      "div",
      { className: "carton-cut-picker-head" },
      h("button", { type: "button", className: "carton-cut-picker-back", onClick: p.onBack }, h(Icon, { name: "arrowLeft", size: 13 }), words.backToCut(home ? cutRef(home) : words.mainCut)),
      h("p", { className: "carton-cut-picker-title" }, words.pickOnCut(label)),
    ),
    st.status === "error"
      ? h("p", { className: "carton-error carton-history-error", role: "alert" }, words.cutHistoryFailed)
      : h(VirtualList, {
          className: "carton-history-list carton-cut-picker-list",
          label: words.pickOnCut(label),
          count,
          rowHeight: ROW,
          initialHeight: p.initialHeight,
          rowKey: (i: number) => (i === 0 ? "now" : st.versions[i - 1]!.id),
          onActivate: (i: number) => p.onPick(i === 0 ? p.cut.id : st.versions[i - 1]!.ref),
          onFirstVisible,
          renderRow,
        }),
    st.status === "loading" ? h("p", { className: "carton-cut-picker-loading", role: "status" }, words.readingItsHistory) : null,
  );
}
