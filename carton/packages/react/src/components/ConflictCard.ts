// Conflict cards (docs/carton-ux DESIGN §6.5, PLAN 7.1 and 7.3): both edits are kept, and the person picks.
// - The title says in words what each side did to which clip ("“Interview B”: you and Claude Code both moved it"); the
//   lead says which side the timeline shows until the pick (core keeps the head's side, which isn't always yours).
// - The sides are a radio group that only picks, starting on the side the timeline shows. Picking changes nothing on
//   the stage. Each side's "See it" shows that side there (viewing, kind "conflict"); again, Esc or deciding comes back.
// - One primary button keeps the pick and names it ("Keep Claude Code's"); no two buttons on a card read the same.
// - During the other side's agent turn, one more line; a pick made on values that changed since asks again (`sig`).
// Words come from conflict-words.ts, so the card, its toast and the viewing label agree. Nothing is decided silently.

import { createElement as h, memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { clockTime, when } from "../format.ts";
import { actorLabel } from "../actors.ts";
import { conflictWords } from "../conflict-words.ts";
import { useAction, useCartonUi, useConflicts, useLocale, useNow, usePreview, useViewing, useWords, useWorking } from "../hooks.ts";
import type { Actor, Conflict, ConflictChoice, ConflictSide } from "../model.ts";
import { ActorName, Avatar, Button, cx } from "./ui.ts";
import { Icon } from "../icons.ts";
import type { Words } from "../words.ts";

export interface ConflictCardProps {
  conflict: Conflict;
  /**
   * Pick without applying: the Fold dialog collects its choices first. The card then keeps the look it had before the
   * redesign (a Keep button per side) until the dialog's own pick rows (Workstream 6, PLAN 6.3) replace it there.
   */
  onPick?: (choice: ConflictChoice) => void;
  /** The pick made so far, when the parent holds it (with `onPick`). */
  picked?: ConflictChoice;
  className?: string;
  /**
   * "See it" through the host: show a side on the stage under `label` ("Claude Code's move of “Interview B”").
   * Deprecated with `openPreview`: Cardboard's stage passes it until `ui.view({ kind: "conflict" })` reaches the editor
   * (Workstream 0's view(), Workstream 1's frame). Without it the card calls `ui.view` itself. `live()` turns false
   * once that See it is stale (a newer one, Not now, deciding, the card gone): a host that is still loading the side
   * then doesn't show it.
   */
  onPreview?: (side: ConflictChoice, label: string, live: () => boolean) => unknown;
  /** "On timeline": select the card's clip on the timeline and move the playhead there, without viewing. */
  onReveal?: (conflict: Conflict) => void;
  /** "Not now": the card waits, undecided (the stack folds it into its pill and sends it to the back of the queue). */
  onDismiss?: () => void;
  /** The card's place in its stack: "1/2 ›" steps to the next card. */
  place?: { index: number; count: number; onNext: () => void };
}

const sigOf = (c: Conflict) => c.sig ?? `${c.title}|${c.mine.summary}|${c.mine.where ?? ""}|${c.theirs.summary}|${c.theirs.where ?? ""}`;

export const ConflictCard = memo(function ConflictCard(p: ConflictCardProps) {
  return p.onPick ? h(PickCard, p) : h(StageCard, p);
});

/** A pick the person made, with the card and the values it was made on. */
interface Held {
  id: string;
  path: string;
  sig: string;
  choice: ConflictChoice;
}

function StageCard(p: ConflictCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const viewing = useViewing();
  const preview = usePreview();
  const working = useWorking();
  const open = useConflicts();
  const c = p.conflict;
  const nameOf = (a: Actor) => actorLabel(a, ui.actor.bind(ui), words.you);
  const cw = conflictWords(c, nameOf, words, locale);
  const sig = sigOf(c);
  const shown: ConflictChoice = c.provisional ?? "mine";

  // The pick holds while the card's values are the ones it was made on. A card that changed (or that another took the
  // place of: the same clip and field, the old one gone) asks again; a pick on another card doesn't carry over.
  const [held, setHeld] = useState<Held | null>(null);
  const mine = held && (held.id === c.id || (held.path === (c.path ?? c.id) && !open.some((x) => x.id === held.id))) ? held : null;
  const again = !!mine && mine.sig !== sig;
  const pick: ConflictChoice = mine && !again ? mine.choice : shown;
  const choose = (k: ConflictChoice) => setHeld({ id: c.id, path: c.path ?? c.id, sig, choice: k });

  // "See it": which side the stage shows. Through ui.view the viewing state says; through the host's deprecated path,
  // the side seen last, while the stage still shows it under its label.
  const [seen, setSeen] = useState<{ id: string; side: ConflictChoice; label: string } | null>(null);
  const onStage = viewing ?? preview;
  const seeing: ConflictChoice | null =
    viewing?.kind === "conflict" ? (viewing.conflictId === c.id ? (viewing.side ?? null) : null) : seen && seen.id === c.id && onStage?.label === seen.label ? seen.side : null;
  const [seeFailed, setSeeFailed] = useState(false);
  // Back to your edit, from what the stage shows now (not what this render saw).
  const back = async () => {
    setSeen(null);
    if (ui.viewing()) await ui.view(null);
    else if (ui.preview()) ui.openPreview(null);
  };
  // This card's side `k` is what the stage shows now.
  const onStageNow = (k: ConflictChoice) => {
    const v = ui.viewing();
    if (v?.kind === "conflict") return v.conflictId === c.id && v.side === k;
    return (v ?? ui.preview())?.label === cw.label[k];
  };
  // A See it under way goes stale once a newer one starts, Not now or Keep is pressed, or the card goes: what it loads
  // then must not take the stage (review of feat/ux-7-conflicts #5).
  const seeGen = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      seeGen.current++;
    },
    [],
  );
  const see = async (k: "mine" | "theirs") => {
    setSeeFailed(false);
    const g = ++seeGen.current;
    const live = () => g === seeGen.current && alive.current;
    try {
      if (seeing === k) return await back();
      if (p.onPreview) {
        await p.onPreview(k, cw.label[k], live);
        if (live()) setSeen({ id: c.id, side: k, label: cw.label[k] });
      } else await ui.view({ kind: "conflict", conflictId: c.id, side: k });
      // stale meanwhile, and it showed anyway: back to your edit (only from this side, never from what you went to since)
      if (!live() && onStageNow(k)) await back();
    } catch {
      if (live()) setSeeFailed(true);
    }
  };

  // Deciding comes back from a side being seen first, so the stage shows your edit with the pick in it. One decision at
  // a time: a second Enter while the first is under way does nothing (review #2: it made a second version).
  const keeping = useRef(false);
  const [keep, busy, failed] = useAction(async (choice: ConflictChoice) => {
    if (keeping.current) return;
    keeping.current = true;
    seeGen.current++;
    try {
      if (seeing) await back().catch(() => undefined);
      await ui.resolve(c.id, choice);
      setHeld(null);
    } finally {
      keeping.current = false;
    }
  });
  const notNow = () => {
    seeGen.current++;
    if (seeing) void back().catch(() => undefined);
    p.onDismiss?.();
  };

  // yours first; one person's two changes in the order they were made
  const order: ConflictChoice[] = [cw.first, cw.first === "mine" ? "theirs" : "mine", ...(c.canKeepBoth ? (["both"] as const) : [])];
  const radios = useRef<Partial<Record<ConflictChoice, HTMLElement | null>>>({});
  // The keys a side acts on are the card's alone: Cardboard's own window listeners never see them (review #3: its Enter
  // opens the selected title's text editor and doesn't check defaultPrevented; final N3 in History).
  const onGroupKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).getAttribute("role") !== "radio") return;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (step) {
      const next = order[(order.indexOf(pick) + step + order.length) % order.length]!;
      choose(next);
      radios.current[next]?.focus();
    } else if (e.key === " ") choose((e.target as HTMLElement).dataset.choice as ConflictChoice);
    else if (!e.repeat) void keep(pick);
  };
  // Esc in the card: back from a side being seen, then "Not now" (innermost first, as the panel's Esc). Taken here, so
  // the stage's own Esc never sees it twice. Enter and Space on the card's buttons are theirs too.
  const onCardKey = (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).tagName === "BUTTON") {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!seeing && !p.onDismiss) return;
    e.preventDefault();
    e.stopPropagation();
    if (seeing) void back().catch(() => undefined);
    else notNow();
  };

  const timeOf = (s: ConflictSide) => (s.at == null ? null : cw.ordered ? clockTime(s.at, locale) : when(s.at, now, locale, words.justNow));
  const side = (k: ConflictChoice) => {
    const s = k === "both" ? null : c[k];
    const checked = pick === k;
    const t = s ? timeOf(s) : null;
    const pickOnClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".carton-see")) choose(k);
    };
    return h(
      "div",
      { key: k, className: "carton-conflict-side", "data-side": k, "data-checked": checked ? "" : undefined, "data-seeing": seeing === k ? "" : undefined, onClick: pickOnClick },
      h(
        "div",
        { role: "radio", "aria-checked": checked, tabIndex: checked ? 0 : -1, "data-choice": k, className: "carton-conflict-pick", ref: (el: HTMLElement | null) => void (radios.current[k] = el) },
        h("span", { className: "carton-radio", "aria-hidden": true }),
        h(
          "span",
          { className: "carton-conflict-body" },
          h(
            "span",
            { className: "carton-conflict-who" },
            h("span", { className: "carton-conflict-name" }, cw.name[k]),
            s?.where ? h("span", { className: "carton-conflict-where" }, s.where) : null,
            t && s?.at != null ? h("time", { dateTime: new Date(s.at).toISOString() }, ` · ${t}`) : null,
          ),
          k === "both" ? (c.both ? h("span", { className: "carton-conflict-what" }, c.both) : null) : h("span", { className: "carton-conflict-what" }, s!.text ?? s!.summary),
        ),
      ),
      k === "both"
        ? null
        : h(
            "button",
            { type: "button", className: "carton-see", "aria-pressed": seeing === k, "aria-label": cw.see[k], onClick: () => void see(k) },
            h(Icon, { name: "eye", size: 13 }),
            seeing === k ? words.seeingIt : words.seeIt,
          ),
    );
  };

  // the agent the card is with, while its turn still runs
  const turn = working && [c.theirs.author, c.mine.author].some((a) => a.kind !== "human" && (a.key === working.actor.key || a.name === working.actor.name)) ? working : null;
  return h(
    "section",
    { className: cx("carton-card carton-conflict", p.className), "aria-label": cw.title, onKeyDown: onCardKey },
    h(
      "header",
      { className: "carton-card-head" },
      h(Icon, { name: "warning", className: "carton-conflict-icon" }),
      h(
        "div",
        null,
        h("h3", { className: "carton-card-title" }, cw.title),
        h("p", { className: "carton-card-sub" }, cw.lead),
        turn ? h("p", { className: "carton-conflict-turn" }, h(Avatar, { actor: turn.actor, size: 16, named: true }), words.stillWorking(nameOf(turn.actor))) : null,
        again ? h("p", { className: "carton-conflict-again", role: "status" }, words.changedAgain(cw.other)) : null,
      ),
      p.onDismiss ? h(Button, { variant: "ghost", className: "carton-conflict-later", description: words.notNowHint, keys: "Escape", onClick: notNow }, words.notNow) : null,
    ),
    h("div", { className: "carton-conflict-sides carton-conflict-radios", role: "radiogroup", "aria-label": words.pickOne, onKeyDown: onGroupKey }, ...order.map(side)),
    seeFailed ? h("p", { className: "carton-error", role: "alert" }, words.loadFailed) : null,
    failed ? h("p", { className: "carton-error", role: "alert" }, words.failed) : null,
    h(
      "div",
      { className: "carton-conflict-actions" },
      h(Button, { variant: "primary", busy, keys: "Enter", onClick: () => void keep(pick) }, cw.keep[pick]),
      p.onReveal && c.item ? h(Button, { variant: "ghost", icon: "target", title: words.showOnTimeline, className: "carton-conflict-reveal", onClick: () => p.onReveal!(c) }, words.onTimeline) : null,
      p.place && p.place.count > 1
        ? h(
            "button",
            { type: "button", className: "carton-conflict-next", "aria-label": `${words.nextConflict} (${words.conflictOf(p.place.index + 1, p.place.count)})`, onClick: p.place.onNext },
            `${p.place.index + 1}/${p.place.count}`,
            h(Icon, { name: "caretRight", size: 13 }),
          )
        : null,
    ),
  );
}

// ------------------------------------------------------------------------------------------------------------------
// The Fold dialog's cards (`onPick`): as they were before the redesign, until its own pick rows replace them (PLAN 6.3).

/** `order`: both sides are one person's, told apart as their earlier and later edit (the name slot says which). */
function SideView({ side, which, showing, order }: { side: ConflictSide; which: "mine" | "theirs"; showing: boolean; order?: { label: string } }) {
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  return h(
    "div",
    { className: "carton-conflict-side", "data-side": which, "data-showing": showing ? "" : undefined },
    h(
      "div",
      { className: "carton-conflict-who" },
      h(Avatar, { actor: side.author, size: 16, named: true }),
      order ? h("span", { className: "carton-actor-name", "data-kind": side.author.kind }, order.label) : h(ActorName, { actor: side.author }),
      // an ordered side's name carries its clock time ("Your earlier edit (10:04)"): no second, relative one
      side.at != null && !order ? h("time", { dateTime: new Date(side.at).toISOString() }, when(side.at, now, locale, words.justNow)) : null,
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

/**
 * When both sides would read the same ("You" and "You": two of your own edits, or one teammate's two), they are told
 * apart by order: the side shown now (head) landed first unless their times say otherwise. Null when the names differ.
 */
function byOrder(c: Conflict, name: (s: ConflictSide) => string, words: Words, locale: string | undefined): { mine: string; theirs: string; keepMine: string; keepTheirs: string } | null {
  if (name(c.mine) !== name(c.theirs) || (c.mine.where ?? "") !== (c.theirs.where ?? "")) return null;
  const earlier: ConflictChoice = c.mine.at != null && c.theirs.at != null ? (c.mine.at <= c.theirs.at ? "mine" : "theirs") : c.provisional === "mine" ? "mine" : "theirs";
  const a = c.mine.author;
  const who = a.kind === "human" && a.isYou ? null : name(c.mine);
  const at = (s: ConflictSide) => (s.at != null ? clockTime(s.at, locale) : undefined);
  const side = (k: "mine" | "theirs") => (k === earlier ? words.earlierEdit(who, at(c[k])) : words.laterEdit(who, at(c[k])));
  const keep = (k: "mine" | "theirs") => (k === earlier ? words.keepEarlier : words.keepLater);
  return { mine: side("mine"), theirs: side("theirs"), keepMine: keep("mine"), keepTheirs: keep("theirs") };
}

function PickCard(p: ConflictCardProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const c = p.conflict;
  const name = (s: ConflictSide) => actorLabel(s.author, ui.actor.bind(ui), words.you);
  const order = byOrder(c, name, words, locale);
  const showing = p.picked ?? c.provisional ?? "mine";
  const btn = (choice: ConflictChoice, label: string) =>
    h(Button, { variant: p.picked === choice ? "primary" : "secondary", pressed: p.picked === choice, onClick: () => p.onPick!(choice) }, label);
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
      h(SideView, { side: c.mine, which: "mine", showing: showing === "mine", ...(order ? { order: { label: order.mine } } : {}) }),
      h(SideView, { side: c.theirs, which: "theirs", showing: showing === "theirs", ...(order ? { order: { label: order.theirs } } : {}) }),
    ),
    h(
      "div",
      { className: "carton-card-actions" },
      btn("mine", order ? order.keepMine : keepLabel(c.mine, words)),
      btn("theirs", order ? order.keepTheirs : keepLabel(c.theirs, words)),
      c.canKeepBoth ? btn("both", words.keepBoth) : null,
    ),
  );
}

/** Every open conflict card, one after another, with how many there are. Renders nothing when there are none. */
export function ConflictList({ className }: { className?: string }) {
  const conflicts = useConflicts();
  const words = useWords();
  if (!conflicts.length) return null;
  return h(
    "div",
    { className: cx("carton-conflicts", className), role: "region", "aria-label": words.conflictsToPick(conflicts.length) },
    h("p", { className: "carton-conflicts-count" }, words.conflictsToPick(conflicts.length)),
    ...conflicts.map((c) => h(ConflictCard, { key: c.id, conflict: c })),
  );
}
