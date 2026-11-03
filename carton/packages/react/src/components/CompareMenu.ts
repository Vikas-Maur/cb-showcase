// Compare any two (docs/carton-ux/v2 DESIGN-V2 §4):
// - the cut bar's **⇆ Compare** button and its menu, "Compare your edit with…": the questions people actually ask
//   (the version you sent, the last export, how it was this morning, another cut, pick a version…), each only when it
//   exists, with its picture;
// - **pick mode** ("Compare with…" in a row's ⋯): one line above the list, "Comparing from “Sent to client”. Click a
//   second version, or another cut", the From row's pill, and ⇆ Compare on every other row. Search, filters and folded
//   days all work while picking.
// Both open Compare in the editor through N1's `openCompare(from, to)` (`openCompareVia`): a host without it keeps the
// panel's own Changes view, between two versions of the cut you're on.

import { createElement as h, useRef, useState } from "react";
import { clockOfDay, versionLabel } from "../format.ts";
import { useCartonUi, useCuts, useLocale, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import { cutColor } from "../cuts.ts";
import type { CartonUi, Cut, Landmark, Version } from "../model.ts";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "./ui.ts";
import { LandmarkTile, landmarkTitle } from "./LandmarkRow.ts";

/** Compare two states: refs of any cut, a cut's id for its head; `to` null is your edit now. */
export type CompareTo = (from: string, to: string | null) => Promise<void>;

/**
 * The one way History's Compare entries open a comparison (the seam to N1): the editor's Compare (`ui.openCompare`)
 * when the host has it, else the host's `onCompare` or the panel's own Changes view, between two refs (your edit: the
 * cut's head). A cut's id is only for the editor's Compare: without it, nothing opens.
 */
export function openCompareVia(ui: CartonUi, fallback: (a: string, b: string) => void): CompareTo {
  return (from, to) => {
    if (typeof ui.openCompare === "function") return ui.openCompare(from, to);
    const cuts = ui.cuts();
    const head = cuts.find((c) => c.current)?.head;
    const isCut = (r: string) => cuts.some((c) => c.id === r);
    const b = to ?? head;
    if (b && !isCut(from) && !isCut(b)) fallback(from, b);
    return Promise.resolve();
  };
}

/** What pick mode compares from: a version, or your edit now (null: Pick a version… from the Compare menu). */
export interface Picking {
  readonly from: Version | null;
}

/** The newest landmark of these kinds (`landmarks` is newest first). */
const newest = (list: readonly Landmark[], kinds: readonly Landmark["kind"][]) => list.find((l) => kinds.includes(l.kind));

/** The other cuts you can compare your edit with (yours and teammates'), in the cuts menu's order. */
const others = (cuts: readonly Cut[]) => cuts.filter((c) => !c.current);

/** A cut's mark: Main cut's scissors, any other cut's colour dot (as the cuts menu). */
function CutMark({ cut }: { cut: Cut }) {
  const color = cutColor(cut);
  return !color ? h(Icon, { name: "cut", size: 13 }) : h("span", { className: "carton-cut-dot", style: { background: color } });
}

/**
 * ⇆ Compare (DESIGN-V2 §4.2): an icon alone at the panel's narrowest. With nothing to offer (a new project: no
 * landmark, no other cut), a click is Pick a version… at once.
 */
export function CompareButton(p: { landmarks: readonly Landmark[]; today: number; dayOf: (at: number) => number; onCompare: CompareTo; onPick: (pick: Picking) => void; findVersion: (id: string) => Version | undefined }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const cuts = useCuts();
  const [open, setOpen] = useState<null | "menu" | "cuts">(null);
  const btn = useRef<HTMLButtonElement>(null);
  const sent = newest(p.landmarks, ["sent"]) ?? newest(p.landmarks, ["named"]);
  const exported = newest(p.landmarks, ["exported"]);
  const morning = p.landmarks.find((l) => l.kind === "start" && p.dayOf(l.at) === p.today);
  const other = others(cuts);
  const entries = [sent, exported, morning].filter((x): x is Landmark => !!x);
  const close = (why?: string) => {
    setOpen(null);
    if (why === "escape") btn.current?.focus({ preventScroll: true });
  };
  const go = (ref: string, to: string | null = null) => {
    setOpen(null);
    void p.onCompare(ref, to).catch(() => {});
  };
  const onClick = () => {
    if (open) return setOpen(null);
    if (!entries.length && !other.length) return p.onPick({ from: null });
    setOpen("menu");
  };
  const line = (l: Landmark) => {
    const v = p.findVersion(l.versionId);
    const title = landmarkTitle(l, words, v ? versionLabel(v, { locale, actor: ui.actor.bind(ui) }) : "");
    return l.kind === "start" ? words.whenYouOpened(clockOfDay(l.at, locale)) : `${title} · ${clockOfDay(l.at, locale)}`;
  };
  const item = (key: string, l: Landmark, name: string) =>
    h(
      "button",
      { key, type: "button", role: "menuitem", tabIndex: -1, className: "carton-menu-item carton-compare-entry", "data-described": "", onClick: () => go(l.ref) },
      h(LandmarkTile, { kind: l.kind, picture: l.picture }),
      h("span", { className: "carton-menu-text" }, name, h("span", { className: "carton-menu-desc" }, line(l))),
    );
  return h(
    "span",
    { className: "carton-menu-anchor carton-compare-anchor", "data-align": "end" },
    h(
      "button",
      {
        ref: btn,
        type: "button",
        className: "carton-compare-btn",
        "aria-haspopup": entries.length || other.length ? "menu" : undefined,
        "aria-expanded": open ? true : undefined,
        "aria-label": words.compare,
        "data-active": open ? "" : undefined,
        onClick,
      },
      h(Icon, { name: "compare", size: 14 }),
      h("span", { className: "carton-compare-word" }, words.compare),
    ),
    open === "menu"
      ? h(
          "div",
          { className: "carton-menu-pop" },
          h(
            MenuList,
            { label: words.compareYourEditWith, className: "carton-compare-menu", ignore: () => [btn.current], onClose: close },
            h(MenuLabel, null, words.compareYourEditWith),
            sent ? item("sent", sent, words.versionYouSent) : null,
            exported ? item("exported", exported, words.lastExport) : null,
            morning ? item("morning", morning, words.thisMorning) : null,
            entries.length ? h(MenuSeparator, null) : null,
            other.length ? h(MenuItem, { icon: "cut", onSelect: () => setOpen("cuts"), hint: h(Icon, { name: "caretRight", size: 12 }) }, words.anotherCut) : null,
            h(MenuItem, { icon: "target", title: words.pickAVersionLine, onSelect: () => (setOpen(null), p.onPick({ from: null })) }, words.pickAVersion),
          ),
        )
      : open === "cuts"
        ? h(
            "div",
            { className: "carton-menu-pop" },
            h(
              MenuList,
              { label: words.anotherCut, className: "carton-compare-menu", ignore: () => [btn.current], onClose: close },
              h(MenuLabel, null, words.anotherCut),
              ...other.map((c) =>
                h(
                  "button",
                  { key: c.id, type: "button", role: "menuitem", tabIndex: -1, className: "carton-menu-item", onClick: () => go(c.id) },
                  h("span", { className: "carton-menu-icon" }, h(CutMark, { cut: c })),
                  h("span", { className: "carton-menu-text" }, c.label),
                ),
              ),
            ),
          )
        : null,
  );
}

/**
 * Pick mode's line above the list (DESIGN-V2 §4.1): what it compares from, "Click a second version", the other cuts
 * (for Compare across cuts: that cut now), and Esc.
 */
export function PickLine(p: { pick: Picking; onCompare: CompareTo; onLeave: () => void }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const cuts = useCuts();
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const from = p.pick.from;
  const label = from ? versionLabel(from, { locale, actor: ui.actor.bind(ui) }) : null;
  const here = cuts.find((c) => c.current);
  const other = others(cuts);
  return h(
    "div",
    { className: "carton-pick-line", role: "status", "aria-label": label ? words.pickAnnounce(label) : words.clickAVersion },
    h(Icon, { name: "compare", size: 14, className: "carton-pick-icon" }),
    h(
      "div",
      { className: "carton-pick-text" },
      h("p", { className: "carton-pick-title" }, label ? words.comparingFrom(label) : words.comparingYourEdit),
      h(
        "p",
        { className: "carton-pick-sub" },
        h("span", null, label ? words.clickASecond : words.clickAVersion),
        other.length
          ? h(
              "span",
              { className: "carton-menu-anchor carton-pick-cut" },
              h(
                "button",
                { ref: btn, type: "button", className: "carton-pick-cut-btn", "aria-haspopup": "menu", "aria-expanded": menu, onClick: () => setMenu((m) => !m) },
                here ? h(CutMark, { cut: here }) : null,
                h("span", null, words.anotherCut),
                h(Icon, { name: "caretDown", size: 10 }),
              ),
              menu
                ? h(
                    "div",
                    { className: "carton-menu-pop" },
                    h(
                      MenuList,
                      {
                        label: words.anotherCut,
                        className: "carton-compare-menu",
                        ignore: () => [btn.current],
                        onClose: (why) => {
                          setMenu(false);
                          if (why === "escape") btn.current?.focus({ preventScroll: true });
                        },
                      },
                      ...other.map((c) =>
                        h(
                          "button",
                          {
                            key: c.id,
                            type: "button",
                            role: "menuitem",
                            tabIndex: -1,
                            className: "carton-menu-item",
                            onClick: () => {
                              setMenu(false);
                              p.onLeave();
                              // that cut now, with the version picked from (or your edit)
                              void p.onCompare(c.id, from ? from.ref : null).catch(() => {});
                            },
                          },
                          h("span", { className: "carton-menu-icon" }, h(CutMark, { cut: c })),
                          h("span", { className: "carton-menu-text" }, words.thatCutNow(c.label)),
                        ),
                      ),
                    ),
                  )
                : null,
            )
          : null,
      ),
    ),
    h("button", { type: "button", className: "carton-pick-esc", "aria-label": words.leavePick, "data-carton-tip": words.leavePick, onClick: p.onLeave }, h("kbd", null, "Esc")),
  );
}
