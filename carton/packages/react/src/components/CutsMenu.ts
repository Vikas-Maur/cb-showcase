// The cuts menu (UX redesign PLAN 6.1, DESIGN §4.1, §6.3): which cut you're on, every cut with its colour and who changed
// it last, teammates' cuts marked View only, New cut from your edit, one "Fold in changes from a cut…", Rename, and the
// one fact that surprises people: "Agents work on the cut you're on." While an agent's turn holds the timeline, a switch
// doesn't happen silently: the cut opens in place with "Switch when it finishes" (queued: cuts.ts) and "Switch now".
// More than 8 cuts scroll; more than 12 get a search field. The same menu opens from the title bar's cut chip
// (openCutsMenu, cuts.ts).
//
// Before (AUDIT §7, 4/10): bare names, a "Fold “X” in here" line per cut beside "Fold into Main cut", a 12 px lock for a
// teammate's cut, nothing on agents, and a menu wider than a 300 px panel.

import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { actorLabel } from "../actors.ts";
import { briefWhen, cancelQueuedSwitch, cutColor, cutRef, dismissQueuedSwitchError, homeCut, isMainCut, queuedSwitch, queuedSwitchError, registerCutsMenu, rememberHome, subscribeQueuedSwitch, switchWhenDone, type QueuedSwitch } from "../cuts.ts";
import { useCartonUi, useCuts, useLocale, useNow, useShownCuts, useViewing, useWords, useWorking } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { CartonUi, Cut, Working } from "../model.ts";
import { Button, InlineName, MenuButton, MenuItem, MenuLabel, MenuSeparator, cx, tipIfCut } from "./ui.ts";
import { Glyph } from "./CompareView.ts";

export interface CutsMenuProps {
  /** Fold a cut into another: opens the Fold in dialog, preset with the two cuts as they are now (their heads). */
  onFoldIn?: (from: Cut, into: Cut) => void;
  /** Ref "New cut from your edit" starts from. Default: your cut's newest version. */
  fromRef?: string;
  /** Offer "Open History" (the menu opened from somewhere else than History: the title bar's chip). */
  onOpenHistory?: () => void;
  className?: string;
}

/** More than this many cuts scroll; more than SEARCH_AT get a search field (DESIGN §6.3). */
const SCROLL_AT = 8;
const SEARCH_AT = 12;

/** A cut's colour dot (none for Main cut). */
export function CutDot({ cut }: { cut: Cut }) {
  const color = cutColor(cut);
  return color ? h("span", { className: "carton-cut-dot", style: { background: color }, "aria-hidden": true }) : null;
}

/**
 * A cut as the title bar's chip draws it (DESIGN §4.1): Main cut the scissors, any other cut its colour dot alone, never
 * both (design QA G12). The cut bar's trigger and the Fold dialog's pickers.
 */
export function CutMark({ cut }: { cut: Cut | undefined }) {
  return cut && cutColor(cut) ? h(CutDot, { cut }) : h(Icon, { name: "cut" });
}

const info = h(
  "svg",
  { className: "carton-icon", width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", "aria-hidden": true, focusable: "false" },
  h("circle", { cx: 12, cy: 12, r: 8.5 }),
  h("path", { d: "M12 11v5.2M12 7.9v.1" }),
);

/** The switch queued behind an agent's turn, read where it shows (one store per view model, cuts.ts). */
function useQueuedSwitch(ui: CartonUi): QueuedSwitch | null {
  const subscribe = useCallback((fn: () => void) => subscribeQueuedSwitch(ui, fn), [ui]);
  return useSyncExternalStore(subscribe, () => queuedSwitch(ui), () => queuedSwitch(ui));
}
function useQueuedSwitchError(ui: CartonUi): string | null {
  const subscribe = useCallback((fn: () => void) => subscribeQueuedSwitch(ui, fn), [ui]);
  return useSyncExternalStore(subscribe, () => queuedSwitchError(ui), () => queuedSwitchError(ui));
}

/** A teammate's cut on screen (DESIGN §6.3): the cut being viewed, or the read-only cut switched to. */
export function useTeammateCut(): Cut | undefined {
  const cuts = useShownCuts();
  const viewing = useViewing();
  return useMemo(() => (viewing?.kind === "cut" ? cuts.find((c) => c.id === viewing.cutId) : cuts.find((c) => c.current && c.readOnly)), [cuts, viewing]);
}

/** Back from a teammate's cut to your own: out of viewing, or back to the cut you came from. */
function leaveTeammateCut(ui: CartonUi): Promise<void> {
  if (ui.viewing()?.kind === "cut") return ui.view(null);
  cancelQueuedSwitch(ui);
  const home = homeCut(ui);
  return home && !home.current ? ui.switchCut(home.id) : Promise.resolve();
}

export function CutsMenu(p: CutsMenuProps) {
  const ui = useCartonUi();
  const words = useWords();
  // What the trigger shows (names, current, read-only, colour): a commit moving a head doesn't re-render it (U6). The
  // open menu reads the cuts whole (who changed each, when): it renders only while open.
  const cuts = useShownCuts();
  const current = cuts.find((c) => c.current);
  const teammate = useTeammateCut();
  const queued = useQueuedSwitch(ui);
  const queuedError = useQueuedSwitchError(ui);
  const [mode, setMode] = useState<"menu" | "new" | "rename">("menu");
  // A failed switch, new cut or rename says so next to the menu; nothing fails silently.
  const [error, setError] = useState<string | null>(null);
  const attempt = (run: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    dismissQueuedSwitchError(ui);
    run().then(
      () => after?.(),
      (e: unknown) => setError(e instanceof Error && e.message ? e.message : words.failed),
    );
  };
  // openCutsMenu(ui) (the title bar's chip) opens this menu and puts focus in it
  const openRef = useRef<(() => void) | null>(null);
  useEffect(() => registerCutsMenu(ui, () => openRef.current?.()), [ui]);

  const shown = teammate ?? current;
  const label = shown?.label ?? words.mainCut;
  const menu = h(MenuButton, {
    label: words.cuts,
    // no tip: the trigger already says which cut, and a tip would sit over the History list below it
    triggerClassName: cx("carton-cuts-trigger", p.className),
    menuClassName: "carton-cuts-menu",
    openRef,
    // what the button is, for screen readers (P3-8); a name cut off at the panel's width shows whole on hover (P2-16)
    ariaLabel: `${words.cut}: ${label}`,
    onOpenChange: (open) => !open && setMode("menu"),
    trigger: [
      h(CutMark, { key: "m", cut: shown }),
      h("span", { key: "n", className: "carton-cuts-name", onMouseEnter: tipIfCut }, label),
      h(Icon, { key: "c", name: "caretDown", size: 12 }),
    ],
    children: (close: () => void) => h(CutsMenuBody, { ...p, close, mode, setMode, attempt, setError }),
  });
  const err = error ?? (queuedError !== null ? queuedError || words.failed : null);
  return h(
    "span",
    { className: "carton-cuts", "data-teammate": teammate ? "" : undefined },
    menu,
    // a teammate's cut is viewing (DESIGN §6.3): the cut bar says so, with the way back
    teammate
      ? h(
          "span",
          { className: "carton-cuts-viewing" },
          h(Icon, { name: "eye", size: 12 }),
          words.viewingMark,
          h(Button, { variant: "ghost", icon: "x", label: words.backToMyEdit, title: words.backToMyEditKey, onClick: () => attempt(() => leaveTeammateCut(ui)) }),
        )
      : null,
    queued ? h(QueuedLine, { queued, attempt }) : null,
    err ? h("span", { className: "carton-cuts-error", role: "alert" }, err) : null,
  );
}

/** "Switches to “30s cut” when Claude Code finishes." under the cut bar, with Switch now and Don't switch. */
function QueuedLine({ queued, attempt }: { queued: QueuedSwitch; attempt: (run: () => Promise<unknown>) => void }) {
  const ui = useCartonUi();
  const words = useWords();
  const cuts = useShownCuts();
  const cut = cuts.find((c) => c.id === queued.cutId);
  const agent = actorLabel(queued.agent, ui.actor.bind(ui), words.you);
  return h(
    "span",
    { className: "carton-cuts-queued", role: "status" },
    h("span", { className: "carton-cuts-queued-text" }, words.switchQueued(cut ? cutRef(cut) : words.cut, agent)),
    h(
      "span",
      { className: "carton-cuts-queued-actions" },
      h(Button, { variant: "ghost", onClick: () => (cancelQueuedSwitch(ui), attempt(() => ui.switchCut(queued.cutId))) }, words.switchNow),
      h(Button, { variant: "ghost", onClick: () => cancelQueuedSwitch(ui) }, words.dontSwitch),
    ),
  );
}

interface BodyProps extends CutsMenuProps {
  close: () => void;
  mode: "menu" | "new" | "rename";
  setMode: (m: "menu" | "new" | "rename") => void;
  attempt: (run: () => Promise<unknown>, after?: () => void) => void;
  setError: (e: string | null) => void;
}

/** Is an agent's turn holding the timeline of the cut you're on? Then a switch would move its next edits. */
const holding = (w: Working | null, current: Cut | undefined): w is Working => !!w && !!current && (!w.cutId || w.cutId === current.id);

/** The open menu: renders only while open, so who and when per cut can follow every commit without costing the bar. */
function CutsMenuBody(p: BodyProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const cuts = useCuts();
  const working = useWorking();
  const queued = useQueuedSwitch(ui);
  const current = cuts.find((c) => c.current);
  const home = homeCut(ui, cuts);
  const byKey = ui.actor.bind(ui);
  const turn = holding(working, current) ? working : null;
  // the cut opened in place during a turn (its two buttons)
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const done = () => {
    p.setMode("menu");
    p.close();
  };

  if (p.mode === "new")
    return h(
      "div",
      { className: "carton-menu-form" },
      h(MenuLabel, null, words.newCutName),
      h(InlineName, {
        placeholder: words.newCutPlaceholder,
        label: words.newCutName,
        saveLabel: words.makeCut,
        onSave: (name) =>
          p.attempt(() => {
            const from = p.fromRef ?? homeCut(ui)?.head;
            // a new cut is a switch made by hand: a switch queued behind a turn is dropped
            if (from) cancelQueuedSwitch(ui);
            return from ? ui.newCut(name, from) : Promise.reject(new Error(words.failed));
          }, done),
        onCancel: () => p.setMode("menu"),
      }),
    );
  const rename = ui.renameCut;
  if (p.mode === "rename" && current && !current.readOnly && rename)
    return h(
      "div",
      { className: "carton-menu-form" },
      h(MenuLabel, null, words.renameCutNamed(current.label)),
      h(InlineName, {
        initial: current.name,
        label: words.renameCutNamed(current.label),
        saveLabel: words.save,
        onSave: (name) => p.attempt(() => rename.call(ui, current.id, name), done),
        onCancel: () => p.setMode("menu"),
      }),
    );

  const switchTo = (c: Cut) => {
    p.close();
    cancelQueuedSwitch(ui);
    if (c.readOnly && home) rememberHome(ui, home.id);
    p.attempt(() => ui.switchCut(c.id));
  };
  const select = (c: Cut) => {
    if (c.current) return p.close();
    // During a turn the cut opens in place: switching would move the agent's next edits (K4)
    if (turn || queued?.cutId === c.id) return setOpen((o) => (o === c.id ? null : c.id));
    switchTo(c);
  };

  const q = query.trim().toLowerCase();
  const match = (c: Cut) => !q || c.label.toLowerCase().includes(q);
  const own = cuts.filter((c) => !c.readOnly && match(c));
  const theirs = cuts.filter((c) => c.readOnly && match(c)).sort((a, b) => a.label.localeCompare(b.label));
  const many = cuts.length > SCROLL_AT;

  const sub = (c: Cut): string => {
    if (turn && c.current) return words.cutWho(actorLabel(turn.actor, byKey, words.you), words.workingNow);
    if (queued?.cutId === c.id) return words.switchQueuedRow(actorLabel(queued.agent, byKey, words.you));
    const at = c.updatedAt > 0 ? briefWhen(c.updatedAt, now, words, locale) : "";
    const who = c.updatedBy ? actorLabel(c.updatedBy, byKey, words.you) : "";
    return who && at ? words.cutWho(who, at) : who || at;
  };
  const item = (c: Cut) => {
    const isOpen = open === c.id && !c.current;
    const button = h(
      "button",
      {
        key: "b",
        type: "button",
        role: "menuitemradio",
        "aria-checked": c.current,
        "aria-expanded": isOpen || undefined,
        tabIndex: -1,
        className: "carton-menu-item carton-cut-item",
        onClick: () => select(c),
      },
      h("span", { className: "carton-menu-icon" }, c.current ? h(Icon, { name: "check" }) : null),
      h(
        "span",
        { className: "carton-cut-text" },
        h("span", { className: "carton-cut-line" }, h(CutDot, { cut: c }), h("span", { className: "carton-cut-name", onMouseEnter: tipIfCut }, c.label)),
        isOpen ? null : h("span", { className: "carton-cut-sub" }, sub(c)),
      ),
      c.readOnly ? h("span", { className: "carton-cut-view" }, h(Icon, { name: "eye", size: 12 }), words.viewOnly) : null,
    );
    // Compare in the editor (UX v2 N1, DESIGN-V2 §1.12): another cut's row offers ⇆ Compare (on hover and focus): that
    // cut now with the cut you're on now. Only when the host has Compare (ui.openCompare).
    const compare = !c.current && typeof ui.openCompare === "function"
      ? h("button", { key: "cmp", type: "button", role: "menuitem", tabIndex: -1, className: "carton-cut-compare", "aria-label": words.compareThisCutHint(c.label), title: words.compareThisCutHint(c.label), onClick: () => { p.close(); void ui.openCompare!(c.id, null).catch(() => undefined); } }, h(Glyph, { name: "compare", size: 13 }), words.compareThisCut)
      : null;
    if (!isOpen) return h("div", { key: c.id, className: "carton-cut-row" }, button, compare);
    return h("div", { key: c.id, className: "carton-cut-row", "data-open": "" }, button, h(TurnPane, { cut: c, current, turn, queued, onSwitch: () => switchTo(c), onClose: p.close, attempt: p.attempt }));
  };

  // One entry however many cuts (K3): the dialog has From and Into. Into your own cut; from the teammate's cut on screen,
  // else your cut changed most recently (a teammate's offers its own Fold into… while you look at it). The cuts as they
  // are now (their heads, F-5): the shown ones don't follow heads.
  const foldPair = (): [Cut, Cut] | null => {
    const all = ui.cuts();
    const into = homeCut(ui, all);
    const cur = all.find((c) => c.current);
    const others = all.filter((c) => c.id !== into?.id).sort((a, b) => Number(a.readOnly) - Number(b.readOnly) || b.updatedAt - a.updatedAt);
    const from = cur?.readOnly ? cur : others[0];
    return into && from ? [from, into] : null;
  };
  const canFold = !!p.onFoldIn && !!home && cuts.some((c) => c.id !== home.id);

  const list: ReactNode[] = [h(MenuLabel, { key: "l" }, words.cuts), ...own.map(item)];
  if (theirs.length) list.push(h(MenuLabel, { key: "t" }, words.fromTeammates), ...theirs.map(item));
  if (q && !own.length && !theirs.length) list.push(h("p", { key: "none", className: "carton-cuts-none" }, words.noCutMatches));

  return [
    cuts.length > SEARCH_AT
      ? h("input", {
          key: "find",
          className: "carton-input carton-cuts-find",
          placeholder: words.findCut,
          "aria-label": words.findCut,
          value: query,
          onChange: (e: { currentTarget: HTMLInputElement }) => setQuery(e.currentTarget.value),
          // the arrows go on into the list (MenuList leaves keys typed in a field alone)
          onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key !== "ArrowDown") return;
            e.preventDefault();
            e.currentTarget.parentElement?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus();
          },
        })
      : null,
    h("div", { key: "cuts", className: many ? "carton-cuts-scroll" : "carton-cuts-list" }, ...list),
    h(MenuSeparator, { key: "s1" }),
    home ? h(MenuItem, { key: "new", icon: "plus", onSelect: () => p.setMode("new") }, words.newCutFromYourEdit) : null,
    canFold
      ? h(
          MenuItem,
          {
            key: "fold",
            icon: "fold",
            onSelect: () => {
              p.close();
              // The shown cuts don't follow head moves: hand the host the cuts as they are now (their heads, F-5).
              const pair = foldPair();
              if (pair) p.onFoldIn!(pair[0], pair[1]);
            },
          },
          words.foldInFromCut,
        )
      : null,
    // Offered only when the engine can rename cuts, and never a teammate's
    rename && current && !current.readOnly ? h(MenuItem, { key: "ren", icon: "pencil", onSelect: () => p.setMode("rename") }, words.renameCutNamed(current.label)) : null,
    p.onOpenHistory ? h(MenuItem, { key: "hist", icon: "versions", onSelect: () => (p.close(), p.onOpenHistory!()) }, words.openHistory) : null,
    h(MenuSeparator, { key: "s2" }),
    h("div", { key: "note", className: "carton-cuts-note", role: "presentation" }, info, words.agentsWorkHere),
  ];
}

/** A cut opened in place while an agent works (DESIGN §6.3, after/cuts-menu-turn-384.png). */
function TurnPane(p: { cut: Cut; current: Cut | undefined; turn: Working | null; queued: QueuedSwitch | null; onSwitch: () => void; onClose: () => void; attempt: (run: () => Promise<unknown>) => void }) {
  const ui = useCartonUi();
  const words = useWords();
  const first = useRef<HTMLButtonElement>(null);
  // focus moves to the first choice: Enter on the cut, then Enter again, queues it
  useLayoutEffect(() => first.current?.focus({ preventScroll: true }), []);
  const byKey = ui.actor.bind(ui);
  const agent = p.turn?.actor ?? p.queued?.agent;
  const who = agent ? actorLabel(agent, byKey, words.you) : "";
  const waitingHere = p.queued?.cutId === p.cut.id;
  const choice = (key: string, primary: boolean, label: string, run: () => void, ref?: typeof first) =>
    h("button", { key, ref, type: "button", role: "menuitem", tabIndex: -1, className: "carton-btn", "data-variant": primary ? "primary" : "secondary", "data-size": "sm", onClick: run }, h("span", { className: "carton-btn-text" }, label));
  return h(
    "div",
    { className: "carton-cut-turn" },
    who && p.current ? h("p", { className: "carton-cut-turn-text" }, words.workingOnCut(who, p.current.label)) : null,
    h(
      "div",
      { className: "carton-cut-turn-actions" },
      waitingHere
        ? [
            choice("now", true, words.switchNow, p.onSwitch, first),
            choice("no", false, words.dontSwitch, () => (cancelQueuedSwitch(ui), p.onClose())),
          ]
        : [
            choice("wait", true, words.switchWhenDone, () => {
              p.onClose();
              if (p.cut.readOnly) {
                const home = homeCut(ui);
                if (home) rememberHome(ui, home.id);
              }
              // queued, or (the turn ended while the pane was open) a switch now, whose failure says so
              p.attempt(() => switchWhenDone(ui, p.cut.id));
            }, first),
            choice("now", false, words.switchNow, p.onSwitch),
          ],
    ),
  );
}

export interface TeammateCutActionsProps {
  /** Fold the teammate's cut into your own (opens the Fold in dialog). */
  onFoldIn?: (from: Cut, into: Cut) => void;
  className?: string;
}

/**
 * What you can do with a teammate's cut you're looking at (PLAN 6.2, DESIGN §6.3): fold it into your cut, or copy it as
 * a new cut of yours. No Restore: it stays as its owner left it. Nothing renders on your own cuts.
 */
export function TeammateCutActions(p: TeammateCutActionsProps) {
  const ui = useCartonUi();
  const words = useWords();
  const teammate = useTeammateCut();
  const cuts = useShownCuts();
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setNaming(false), [teammate?.id]);
  if (!teammate) return null;
  const home = homeCut(ui, cuts);
  const fail = (e: unknown) => setError(e instanceof Error && e.message ? e.message : words.failed);
  return h(
    "div",
    { className: cx("carton-teammate-cut", p.className), role: "group", "aria-label": words.teammateCut(teammate.label) },
    h(
      "div",
      { className: "carton-teammate-cut-actions" },
      home && p.onFoldIn
        ? h(
            Button,
            {
              icon: "fold",
              onClick: () => {
                // the cuts as they are now (their heads)
                const now = ui.cuts();
                const from = now.find((c) => c.id === teammate.id) ?? teammate, into = now.find((c) => c.id === home.id) ?? home;
                p.onFoldIn!(from, into);
              },
            },
            words.foldIntoCut(isMainCut(home) ? home.label : `“${home.label}”`),
          )
        : null,
      h(Button, { variant: "ghost", icon: "plus", pressed: naming, onClick: () => (setError(null), setNaming((n) => !n)) }, words.newCutFromIt),
      // Compare in the editor (DESIGN-V2 §1.11): their cut now with yours now
      home && typeof ui.openCompare === "function"
        ? h(Button, { variant: "ghost", icon: "compare", onClick: () => void ui.openCompare!(teammate.id, home.id).catch(fail) }, words.compareWithCut(isMainCut(home) ? home.label : `“${home.label}”`))
        : null,
    ),
    naming
      ? h(InlineName, {
          placeholder: words.newCutPlaceholder,
          label: words.newCutName,
          saveLabel: words.makeCut,
          onSave: (name) => {
            setError(null);
            const head = ui.cuts().find((c) => c.id === teammate.id)?.head ?? teammate.head;
            cancelQueuedSwitch(ui);
            ui.newCut(name, head).then(() => setNaming(false), fail);
          },
          onCancel: () => setNaming(false),
        })
      : null,
    error ? h("p", { className: "carton-error", role: "alert" }, error) : null,
  );
}
