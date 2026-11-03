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
import { FIND_LIMIT, searchable, snippetOf } from "./SearchBox.ts";
import type { FindHit } from "../model.ts";

/** A page of another cut's History. */
export const CUT_PAGE = 100;
/** The next page is read when the last row on screen is this close to the end of what is loaded. */
const NEAR_END = 40;
const ROW = 52;

/**
 * Whether the next page is needed: the last row on screen (the first one and as many as the view holds: a tall view
 * holds many, review of feat/ux2-n2c #3) is near the end of what is loaded, and there is more.
 */
export const needsMore = (lastShown: number, loaded: number, before: number | undefined): before is number => before !== undefined && lastShown + NEAR_END > loaded;

interface State {
  readonly versions: readonly Version[];
  readonly before?: number | undefined;
  readonly marks: LandmarkIndex | null;
  readonly status: "loading" | "ready" | "error";
}

export function CutPicker(p: { cut: Cut; onPick: (ref: string) => void; onBack: () => void; initialHeight?: number | undefined; query?: string }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const cuts = useCuts();
  const home = cuts.find((c) => c.current);
  const [st, setSt] = useState<State>({ versions: [], marks: null, status: "loading" });
  const reading = useRef(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(0);
  const [active, setActive] = useState(0);
  const inView = () => Math.ceil((box.current?.clientHeight || p.initialHeight || 600) / ROW);
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
  // The search field searches the cut shown (review of feat/ux2-n2c #2): N0's find across cuts, this cut's hits only
  const q = p.query && searchable(p.query) && typeof ui.find === "function" ? p.query.trim() : "";
  const [hits, setHits] = useState<{ q: string; list: readonly FindHit[] } | null>(null);
  useEffect(() => {
    if (!q) return setHits(null);
    let live = true;
    ui.find!(q, { allCuts: true, limit: FIND_LIMIT }).then(
      (r) => live && setHits({ q, list: r.hits.filter((x) => x.cutId === p.cut.id) }),
      () => live && setHits({ q, list: [] }),
    );
    return () => void (live = false);
  }, [ui, q, p.cut.id]);
  const found = q && hits?.q === q ? hits.list : null;
  const label = cutRef(p.cut);
  const count = found ? 1 + found.length : 1 + st.versions.length;
  const onFirstVisible = (top: number) => {
    first.current = top;
    if (!found && needsMore(top + inView(), st.versions.length, st.before)) void read(st.before);
  };
  // a page that leaves the view short of its end reads the next (nothing to scroll yet in a tall view)
  useEffect(() => {
    if (!q && st.status === "ready" && needsMore(first.current + inView(), st.versions.length, st.before)) void read(st.before);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);
  const today = dayNumber(now);
  const renderRow = (i: number): ReactNode => {
    if (i === 0)
      return h(
        "div",
        { id: "carton-cut-pick-0", className: "carton-version carton-cut-pick-row", role: "option", "aria-selected": active === 0, "data-active": active === 0 ? "" : undefined, "data-now": "", style: { height: ROW }, onClick: () => p.onPick(p.cut.id) },
        h("span", { className: "carton-version-mark", "aria-hidden": true }, h(Icon, { name: "cut", size: 13 })),
        h("span", { className: "carton-version-title" }, words.cutAsItIsNow(label)),
        h("span", { className: "carton-version-pick carton-cut-pick-go", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare),
      );
    if (found) {
      const x = found[i - 1]!;
      const who = x.author.kind === "system" ? "" : actorLabel(x.author, ui.actor.bind(ui), words.you);
      return h(
        "div",
        { id: `carton-cut-pick-${i}`, className: "carton-version carton-cut-pick-row", role: "option", "aria-selected": active === i, "data-active": active === i ? "" : undefined, style: { height: ROW }, onClick: () => p.onPick(x.ref) },
        h("span", { className: "carton-version-mark", "aria-hidden": true }),
        h("span", { className: "carton-version-title" }, snippetOf(x)),
        h("time", { className: "carton-version-when", dateTime: new Date(x.at).toISOString() }, dayNumber(x.at) === today ? clockOfDay(x.at, locale) : `${shortDate(x.at, locale)}, ${clockOfDay(x.at, locale)}`),
        h("span", { className: "carton-version-pick carton-cut-pick-go", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare),
        h("span", { className: "carton-version-meta" }, h("span", { className: "carton-find-why" }, words.findFields[x.field]), who ? h("span", { className: "carton-actor-name" }, who) : null),
      );
    }
    const v = st.versions[i - 1]!;
    const mark = st.marks?.byVersion.get(v.id)?.find((l) => l.kind !== "turn");
    const prompt = v.turn?.label || ((v.author.kind === "agent" || v.author.kind === "subagent") && v.name) || null;
    const plain = prompt ? `“${prompt}”` : v.name ? v.name : v.summary || versionLabel(v, { locale, actor: ui.actor.bind(ui), start: true });
    const title = mark ? landmarkTitle(mark, words, plain) : plain;
    const who = v.author.kind === "system" ? "" : actorLabel(v.author, ui.actor.bind(ui), words.you);
    const when = dayNumber(v.at) === today ? clockOfDay(v.at, locale) : `${shortDate(v.at, locale)}, ${clockOfDay(v.at, locale)}`;
    return h(
      "div",
      { id: `carton-cut-pick-${i}`, className: "carton-version carton-cut-pick-row", role: "option", "aria-selected": active === i, "data-active": active === i ? "" : undefined, "data-named": v.name && !prompt ? "" : undefined, style: { height: ROW }, onClick: () => p.onPick(v.ref) },
      h("span", { className: "carton-version-mark", "aria-hidden": true }),
      h("span", { className: "carton-version-title" }, mark ? h(LandmarkTag, { kind: mark.kind }) : null, title),
      h("time", { className: "carton-version-when", dateTime: new Date(v.at).toISOString() }, when),
      h("span", { className: "carton-version-pick carton-cut-pick-go", "aria-hidden": true }, h(Icon, { name: "compare", size: 12 }), words.compare),
      h("span", { className: "carton-version-meta" }, who ? h("span", { className: "carton-actor-name" }, who) : null, v.changes !== undefined ? h("span", { className: "carton-version-count" }, words.changes(v.changes)) : null),
    );
  };
  return h(
    "div",
    { ref: box, className: "carton-cut-picker", role: "group", "aria-label": words.pickOnCut(label) },
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
          rowKey: (i: number) => (i === 0 ? "now" : found ? `hit:${found[i - 1]!.ref}` : st.versions[i - 1]!.id),
          active,
          onActiveChange: setActive,
          activeId: (i: number) => `carton-cut-pick-${i}`,
          onActivate: (i: number) => p.onPick(i === 0 ? p.cut.id : found ? found[i - 1]!.ref : st.versions[i - 1]!.ref),
          onFirstVisible,
          renderRow,
        }),
    st.status === "loading" ? h("p", { className: "carton-cut-picker-loading", role: "status" }, words.readingItsHistory) : null,
    found && !found.length ? h("p", { className: "carton-cut-picker-loading", role: "status" }, words.findNone(q)) : null,
  );
}
