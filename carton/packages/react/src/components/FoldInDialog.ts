// Fold in (§0.1: merge; UX redesign PLAN 6.3, DESIGN §6.4). From a cut into a cut, both pickable; one line on what
// happens; every change as a change row (time in the edit, the kind of clip, the sentence, who) with a tick box to leave
// it out ("fold in some of it", partial accept, §5.3 / R2-14), a lock on what can't be left out, "Left out on Oct 30" on
// what an earlier partial fold left out (its rows come and stay together); a conflict as an inline pick between the two
// cuts' versions; and a counted primary button ("Fold in 3 changes", "Fold in the rest"). Leaving changes out is
// recorded, so they can be folded in later.
//
// What it folds and how it counts are the view model's, unchanged (one counting rule: a change per record, a split one;
// the partial fold and its rest, their undo): the dialog only shows the plan and sends the same leave-out and picks.
//
// Before (AUDIT §8, 6/10): sentences without where or what kind, conflicts as nested cards, the direction fixed by where
// it was opened, and no date on what was left out earlier.

import { createElement as h, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { actorLabel } from "../actors.ts";
import { briefWhen, cutRef } from "../cuts.ts";
import { clock, clockOfDay, shortDate } from "../format.ts";
import { useAction, useAsync, useCartonUi, useLocale, useNow, useShownCuts, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Conflict, ConflictChoice, Cut, FoldChange, FoldPlan, FoldResult } from "../model.ts";
import type { Words } from "../words.ts";
import { ChangeRow } from "./ChangeRow.ts";
import { CutDot, CutMark } from "./CutsMenu.ts";
import { Button, Dialog, MenuButton, MenuLabel, radioKeys } from "./ui.ts";

/** A card's fingerprint: the view model's, else what the card says (who, what, which cut). */
const sigOf = (c: Conflict) => c.sig ?? `${c.title}|${c.mine.summary}|${c.mine.where ?? ""}|${c.theirs.summary}|${c.theirs.where ?? ""}`;

export interface FoldInDialogProps {
  /** The cut folded in, to begin with (the From picker changes it). */
  fromCutId: string;
  /** The cut it goes into, to begin with (the Into picker changes it). */
  intoCutId: string;
  onClose: () => void;
  /** Called after a successful fold (default: onClose). */
  onDone?: (r: FoldResult) => void;
  /** Use this plan instead of asking the view model (gallery). */
  plan?: FoldPlan;
}

// What both sides did, as a verb for "Both cuts moved “Interview B”": the sides' own noun when they agree
const VERBS: Record<string, string> = { move: "moved", trim: "trimmed", change: "changed", rename: "renamed", removal: "removed", remove: "removed" };
const verbOf = (c: Conflict) => (c.mine.what && c.mine.what === c.theirs.what ? (VERBS[c.mine.what] ?? "changed") : "changed");

/** "at 12:20 pm", "yesterday at 4:10 pm", "on Oct 30 at 4:10 pm": a moment after a noun. */
function atMoment(at: number, now: number, locale: string | undefined, words: Words): string {
  const t = clock(at, { now, locale });
  const day = t === clockOfDay(at, locale) ? "today" : t.startsWith("yesterday") ? "yesterday" : "other";
  return words.atMoment(t, day);
}

export function FoldInDialog(p: FoldInDialogProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const now = useNow();
  const cuts = useShownCuts();
  // The two cuts: preset by whoever opened it, either one changeable here (F3)
  const [pair, setPair] = useState({ from: p.fromCutId, into: p.intoCutId });
  // §13: after "bring it in with every difference shown as a card", the plan and the fold use the 2-way compare.
  const [allCards, setAllCards] = useState(false);
  const loaded = useAsync(
    () => (p.plan ? Promise.resolve(p.plan) : ui.planFold(pair.from, pair.into, allCards ? { allCards } : undefined)),
    [ui, pair.from, pair.into, p.plan, allCards],
  );
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  // Each pick remembers the card it was made on (its fingerprint). A card whose values changed since (a racing edit,
  // seen when the plan reloads) is a different card: its old pick no longer counts (R3-1, R4-1).
  const [picks, setPicks] = useState<Readonly<Record<string, { choice: ConflictChoice; sig: string }>>>({});
  const [result, setResult] = useState<FoldResult | null>(null);
  // Another pair of cuts is another plan: nothing picked or left out carries over
  const pairKey = `${pair.from}>${pair.into}`;
  const shownPair = useRef(pairKey);
  useEffect(() => {
    if (shownPair.current === pairKey) return;
    shownPair.current = pairKey;
    setLeft(new Set());
    setPicks({});
    setResult(null);
    setAllCards(false);
  }, [pairKey]);
  const [fold, busy] = useAction(async () => {
    // `count`: what the button said it folds in, which its confirmation repeats (PLAN 5.3: "Folded 3 changes from …")
    const r = await ui.fold(pair.from, pair.into, { leaveOut: [...left], choices: choicesFor(planRef.current), ...(allCards ? { allCards } : {}), ...(coming > 0 ? { count: coming } : {}) });
    setResult(r);
    // Done: hand the result to the host, or just close.
    if (r.ok) (p.onDone ?? p.onClose)(r);
    // New cards (someone edited since the plan was shown): show the plan as it is now, with its cards (R2-5). A card
    // that came back was not the one picked on (new, or its values changed), so its old pick goes too (R3-1).
    else if (r.conflicts?.length) {
      const back = new Set(r.conflicts.map((c) => c.id));
      setPicks((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !back.has(id))));
      loaded.reload();
    }
    return r;
  });

  const plan = loaded.status === "ready" ? loaded.value : null;
  const total = plan?.changes.length ?? 0;
  const taking = total - left.size;
  const planRef = useRef(plan);
  planRef.current = plan;
  // The picks that still match the cards on screen; only these are sent.
  const choicesFor = (pl: FoldPlan | null): Record<string, ConflictChoice> => {
    const out: Record<string, ConflictChoice> = {};
    for (const c of pl?.conflicts ?? []) {
      const pk = picks[c.id];
      if (pk && pk.sig === sigOf(c)) out[c.id] = pk.choice;
    }
    return out;
  };
  const choices = choicesFor(plan);
  const unpicked = plan ? plan.conflicts.filter((c) => !choices[c.id]) : [];
  // Counted as History will count the fold (one rule: a change per record, a split one): the records of the rows taken,
  // and of each conflict picked the other cut's way (keeping this cut's own changes nothing), once each: two cards on
  // one clip, or a card and a row of the same clip, are one change. A record left out brings its cards' picks in with
  // it no more. The list counts the records it shows.
  const { listed, coming } = ((): { listed: number; coming: number } => {
    if (!plan) return { listed: 0, coming: 0 };
    const rowOf = (c: FoldChange) => (c.id.startsWith("left:") ? c.id.slice(c.id.indexOf(":", 5) + 1) : c.id);
    const rows = plan.changes.map(rowOf);
    // a card's record: a row's that holds its path, else its record path's first two parts (`timelineItems/c1`)
    const cardOf = (c: Conflict) => {
      const path = c.path ?? c.id;
      const r = rows.find((k) => path === k || path.startsWith(k + "/"));
      if (r) return r;
      const parts = path.split("/");
      return parts.length > 1 ? parts.slice(0, 2).join("/") : path;
    };
    const out = new Set(plan.changes.filter((c) => left.has(c.id)).map(rowOf));
    const taken = new Set(plan.changes.filter((c) => !left.has(c.id)).map(rowOf));
    for (const c of plan.conflicts) {
      const k = cardOf(c);
      if (choices[c.id] && choices[c.id] !== "mine" && !out.has(k)) taken.add(k);
    }
    return { listed: new Set([...rows, ...plan.conflicts.map(cardOf)]).size, coming: taken.size };
  })();

  // A change an earlier partial fold left out comes with that fold's other left-out changes (UI audit P1-4): they
  // fold in, or stay left out, together
  const toggle = (id: string) =>
    setLeft((s) => {
      const n = new Set(s);
      const group = plan?.changes.find((c) => c.id === id)?.leftOut;
      const ids = group ? plan!.changes.filter((c) => c.leftOut === group).map((c) => c.id) : [id];
      const out = !n.has(id);
      for (const x of ids) if (out) n.add(x);
      else n.delete(x);
      return n;
    });

  // The cuts as the plan names them, else as the pickers do
  const fromCut = plan?.from ?? cuts.find((c) => c.id === pair.from);
  const intoCut = plan?.into ?? cuts.find((c) => c.id === pair.into);
  const fromName = fromCut?.label ?? "";
  const canSplit = plan?.partial !== false;
  const leavable = plan ? plan.changes.filter((c) => !c.locked).length : 0;
  // Only what earlier partial folds left out is left: the rest of one (after/fold-rest.png)
  const restOnly = !!plan && total > 0 && !plan.conflicts.length && plan.changes.every((c) => c.leftOut);
  const nothing = !!plan && !plan.missingBase && total === 0 && !plan.conflicts.length;

  const lead = useMemo((): string | null => {
    if (!plan || !intoCut || !fromCut || plan.missingBase || nothing) return null;
    if (restOnly) {
      const at = plan.changes.find((c) => c.leftOutAt != null)?.leftOutAt;
      return at != null ? words.foldRestLine(total, shortDate(at, locale)) : words.foldRestLinePlain(total);
    }
    const into = cutRef(intoCut), from = cutRef(fromCut);
    const m = plan.made;
    if (!m) return words.foldLinePlain(into, from);
    return words.foldLine(into, from, m.which === "from" ? into : from, atMoment(m.at, now, locale, words));
  }, [plan, intoCut, fromCut, restOnly, nothing, total, now, locale, words]);

  const row = (c: FoldChange) => {
    const out = left.has(c.id);
    const box = !canSplit
      ? null
      : c.locked
        ? // A project-level change comes with the rest (core's partial accept inverts records only).
          h("span", { className: "carton-fold-lock", role: "img", "aria-label": words.cantLeaveOut, title: words.cantLeaveOut }, h(Icon, { name: "lock", size: 10 }))
        : h("input", { type: "checkbox", className: "carton-check", checked: !out, "aria-label": c.summary, onChange: () => toggle(c.id), onClick: (e: { stopPropagation(): void }) => e.stopPropagation() });
    const who = actorLabel(c.author, ui.actor.bind(ui), words.you);
    // under the sentence: who and when (a fold spans days: "Director · 2 h ago", "Director · Oct 30"), why a row is
    // locked, and when an earlier partial fold left it out
    const lines = [
      h("span", { key: "who", className: "carton-fold-who" }, [who, briefWhen(c.at, now, { now: words.justNow, yesterdayShort: words.yesterdayShort }, locale)].filter(Boolean).join(" · ")),
      c.locked ? h("span", { key: "lock", className: "carton-fold-note" }, words.cantLeaveOut) : null,
      c.leftOut ? h("span", { key: "left", className: "carton-fold-tag", title: words.leftOutTogether }, c.leftOutAt != null ? words.leftOutOn(shortDate(c.leftOutAt, locale)) : words.foldLeftOutEarlier) : null,
    ];
    const body = c.change
      ? h(ChangeRow, { change: { ...c.change, text: c.summary }, lead: box, muted: out })
      : // no change row from the view model: the sentence alone
        h("div", { className: "carton-fold-plain", role: "listitem" }, box ? h("span", { className: "carton-change-lead" }, box) : null, h("span", { className: "carton-change-text" }, h("span", { className: "carton-change-words" }, c.summary)));
    return h(
      "div",
      {
        key: c.id,
        className: "carton-fold-change",
        "data-left": out ? "" : undefined,
        "data-locked": c.locked ? "" : undefined,
        "data-plain": c.change ? undefined : "",
        "data-lead": box ? "" : undefined,
        // the whole row toggles, as a label would (the box is the control screen readers use)
        onClick: canSplit && !c.locked ? () => toggle(c.id) : undefined,
      },
      body,
      h("div", { className: "carton-fold-lines" }, ...lines),
    );
  };

  const pickRow = (c: Conflict) => {
    const picked = choices[c.id];
    const title = c.clip ? words.bothCutsDid(verbOf(c), c.clip) : words.bothCutsChanged(c.title);
    const side = (choice: ConflictChoice, label: string, who: string | null, i: number) =>
      h(
        "button",
        {
          key: choice,
          type: "button",
          role: "radio",
          "aria-checked": picked === choice,
          // one tab stop: the picked side, else the first
          tabIndex: picked ? (picked === choice ? 0 : -1) : i === 0 ? 0 : -1,
          className: "carton-fold-side",
          onClick: () => setPicks((s) => ({ ...s, [c.id]: { choice, sig: sigOf(c) } })),
        },
        h("span", { className: "carton-radio", "aria-hidden": true }),
        h("span", { className: "carton-fold-side-text" }, label),
        who ? h("span", { className: "carton-fold-side-who" }, `· ${who}`) : null,
      );
    const byKey = ui.actor.bind(ui);
    const sideLabel = (s: Conflict["mine"], cut: Cut | undefined) => (s.where || cut ? words.cutsSide(s.where ?? cut!.label, s.summary) : s.summary);
    return h(
      "div",
      { key: c.id, className: "carton-fold-pick", "data-picked": picked ? "" : undefined },
      h("p", { className: "carton-fold-pick-title" }, h(Icon, { name: "warning", size: 14 }), title),
      c.reason ? h("p", { className: "carton-fold-pick-reason" }, c.reason) : null,
      h(
        "div",
        { className: "carton-fold-sides", role: "radiogroup", "aria-label": title, onKeyDown: (e: KeyboardEvent<HTMLElement>) => radioKeys(e) },
        side("mine", sideLabel(c.mine, intoCut), actorLabel(c.mine.author, byKey, words.you), 0),
        side("theirs", sideLabel(c.theirs, fromCut), actorLabel(c.theirs.author, byKey, words.you), 1),
        c.canKeepBoth ? side("both", words.both, null, 2) : null,
      ),
    );
  };

  let content: ReactNode;
  if (loaded.status === "loading") content = h("p", { className: "carton-muted" }, words.loading);
  else if (loaded.status === "error") content = h("p", { className: "carton-error", role: "alert" }, words.failed);
  else if (plan?.missingBase)
    content = [
      h("p", { key: "mb", className: "carton-fold-missing", role: "alert" }, plan.missingBase),
      h("div", { key: "mba", className: "carton-card-actions" }, h(Button, { onClick: () => setAllCards(true) }, words.foldAllCards)),
    ];
  else if (plan && nothing) content = h("p", { className: "carton-fold-nothing" }, words.alreadyHas(intoCut ? cutRef(intoCut) : "", fromName));
  else if (plan)
    content = [
      lead ? h("p", { key: "lead", className: "carton-fold-lead" }, lead) : null,
      h(
        "div",
        { key: "changes", className: "carton-fold-changes", role: "group", "aria-label": words.foldChanges(listed) },
        listed && !restOnly
          ? h(
              "div",
              { className: "carton-fold-legend" },
              h("span", null, words.foldChanges(listed)),
              !canSplit
                ? h("span", { className: "carton-fold-bulk" }, words.foldAllOrNothing)
                : leavable > 1
                  ? // one link: Select none while all are in, else Select all
                    h(
                      "button",
                      { type: "button", className: "carton-fold-select", onClick: () => setLeft(left.size === 0 ? new Set(plan.changes.filter((c) => !c.locked).map((c) => c.id)) : new Set()) },
                      left.size === 0 ? words.selectNone : words.selectAll,
                    )
                  : null,
            )
          : null,
        h("div", { className: "carton-fold-box" }, total ? h("div", { className: "carton-fold-list", role: "list", "aria-label": words.foldChanges(total) }, ...plan.changes.map(row)) : null, ...plan.conflicts.map(pickRow)),
      ),
      plan.warnings.length
        ? h(
            "div",
            { key: "warn", className: "carton-fold-warnings", role: "note" },
            h("p", null, h(Icon, { name: "warning", size: 14 }), words.foldWarnings),
            h("ul", null, ...plan.warnings.map((w, i) => h("li", { key: i }, w))),
          )
        : null,
      result && !result.ok
        ? h("p", { key: "err", className: "carton-error", role: "alert" }, result.conflicts?.length ? words.foldChangedSince : (result.error ?? words.failed))
        : null,
    ];

  const partial = !!plan && taking < total;
  // The footer's line: why the button waits, what stays behind, or how to take it back
  const footLine = !plan || nothing || plan.missingBase
    ? null
    : unpicked.length
      ? unpicked.length === 1 && unpicked[0]!.clip
        ? words.pickOneFor(unpicked[0]!.clip)
        : words.conflictsToPick(unpicked.length)
      : partial
        ? words.leftOutLine(total - taking, fromName)
        : words.foldUndoLine;
  const primaryLabel = busy ? words.folding : restOnly && !partial ? words.foldRest : coming > 0 ? words.foldInN(coming) : words.foldAll;

  return h(Dialog, {
    title: words.foldInChanges,
    onClose: p.onClose,
    className: "carton-fold",
    children: [
      h(
        "div",
        { key: "pair", className: "carton-fold-pair" },
        h("span", { className: "carton-fold-word" }, words.foldFrom),
        h(CutPicker, { label: words.foldFrom, value: pair.from, cut: fromCut, options: cuts.filter((c) => c.id !== pair.into), disabled: busy, onPick: (id) => setPair((x) => ({ ...x, from: id })) }),
        h("span", { className: "carton-fold-word" }, words.foldIntoWord),
        h(CutPicker, { label: words.foldIntoWord, value: pair.into, cut: intoCut, options: cuts.filter((c) => !c.readOnly && c.id !== pair.from), disabled: busy, onPick: (id) => setPair((x) => ({ ...x, into: id })) }),
      ),
      h("div", { key: "body", className: "carton-fold-content" }, content),
    ],
    footer: nothing
      ? [h("span", { key: "sp" }), h(Button, { key: "close", onClick: p.onClose }, words.close)]
      : [
          h("span", { key: "line", className: "carton-fold-later", "data-tone": unpicked.length ? "warning" : undefined }, footLine),
          h(Button, { key: "c", onClick: p.onClose }, words.cancel),
          h(
            Button,
            {
              key: "go",
              variant: "primary",
              icon: "fold",
              busy,
              disabled: !plan || !!plan.missingBase || (taking === 0 && !plan.conflicts.length) || unpicked.length > 0,
              onClick: () => void fold(),
            },
            primaryLabel,
          ),
        ],
  });
}

/** From or Into: the cut, its dot, "· you're on it", and a menu of the other cuts. */
function CutPicker(p: { label: string; value: string; cut: Cut | undefined; options: readonly Cut[]; disabled?: boolean; onPick: (id: string) => void }) {
  const words = useWords();
  const name = p.cut?.label ?? "";
  const shown = [
    h(CutMark, { key: "m", cut: p.cut }),
    h("span", { key: "n", className: "carton-fold-cut-name" }, name),
    p.cut?.current ? h("span", { key: "on", className: "carton-fold-on" }, `· ${words.youreOnIt}`) : null,
  ];
  // nothing else to pick (or a fold running): the cut, without a menu
  if (p.disabled || !p.options.length) return h("span", { className: "carton-fold-cut", "data-fixed": "" }, ...shown);
  const trigger = [...shown, h(Icon, { key: "c", name: "caretDown", size: 12 })];
  return h(MenuButton, {
    label: p.label,
    ariaLabel: `${p.label}: ${name}${p.cut?.current ? `, ${words.youreOnIt}` : ""}`,
    triggerClassName: "carton-fold-cut",
    trigger,
    children: (close: () => void) => [
      h(MenuLabel, { key: "l" }, words.cuts),
      ...p.options.map((c) =>
        h(
          "button",
          {
            key: c.id,
            type: "button",
            role: "menuitemradio",
            "aria-checked": c.id === p.value,
            tabIndex: -1,
            className: "carton-menu-item carton-cut-item",
            onClick: () => {
              close();
              if (c.id !== p.value) p.onPick(c.id);
            },
          },
          h("span", { className: "carton-menu-icon" }, c.id === p.value ? h(Icon, { name: "check" }) : null),
          h("span", { className: "carton-cut-text" }, h("span", { className: "carton-cut-line" }, h(CutDot, { cut: c }), h("span", { className: "carton-cut-name" }, c.label), c.current ? h("span", { className: "carton-fold-on" }, `· ${words.youreOnIt}`) : null)),
        ),
      ),
    ],
  });
}
