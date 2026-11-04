// Go back… (docs/carton-ux/v2 DESIGN-V2 §3): the card's one way back from a version, with its four choices side by
// side, each with what it will do, smallest first, so nobody restores a whole edit when they meant to fix one clip:
// - Bring back one clip ("Choose a clip…": the clips that differ between that version and now, §3.2);
// - Undo Director's turn (agent turns only);
// - Restore the whole edit;
// - Start a new cut from here.
// Nothing is picked when it opens (the button reads "Choose one"), unless a clip is selected on the timeline and differs
// since: then Bring back one clip is picked, and its button names the clip. Every button names its action; no two read
// the same. The row's ⋯ entries (Restore…, Undo this turn, New cut from this version…) open it with theirs picked.
//
// Only an open chooser asks what differs (`changes(version, head)`, cached by the host, and the other way round for how
// each clip was then): History never diffs a version nobody opened.

import { createElement as h, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { clockOfDay, timecode, versionLabel } from "../format.ts";
import { useAsync, useCartonUi, useLocale, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import { actorLabel } from "../actors.ts";
import type { Actor, BringBack, BringBackChoices, BringBackPlace, BringBackRipple, Change, ClipKind, Version } from "../model.ts";
import type { Words } from "../words.ts";
import { Button, radioKeys } from "./ui.ts";

/** A choice of Go back… (DESIGN-V2 §3.1), smallest first. */
export type GoBackChoice = "clip" | "turn" | "restore" | "newCut";

/** One clip that differs between a version and now (§3.2): what Bring back does to it. */
export interface ClipChoice {
  readonly itemId: string;
  /** Its name, as the change sentences say it ("Intro"). */
  readonly name: string;
  readonly clip: ClipKind;
  /** changed: it is there in both; deleted: it was there then and is gone now; added: it wasn't there then. */
  readonly how: "changed" | "deleted" | "added";
  /** Where it was then and is now, in seconds, when known. */
  readonly then?: readonly [number, number];
  readonly now?: readonly [number, number];
  /** Who made the newest change to it since, and when (a deletion's, an addition's). */
  readonly author?: Actor;
  readonly when?: number;
  /** The newest sentence about it, for a change with no timing to show ("Changed caption to “in half”"). */
  readonly text: string;
  /** A title's or caption's text then ("Then “Summer sale”"), when the engine says. */
  readonly thenText?: string;
  /** The clip as it is now (N0b): `restoreClip`'s `expect`, so one that changed since is refused, never overwritten. */
  readonly token?: string;
  /** What bringing it back does (N0b): where it goes, and what else moves (null: nothing; absent: not known). */
  readonly place?: BringBackPlace;
  readonly ripple?: BringBackRipple | null;
}

const NOUN_KIND: Record<string, ClipKind> = { title: "title", "lower third": "title", caption: "caption", audio: "audio", music: "audio", image: "image", "code graphic": "code", code: "code" };

/**
 * The engine's "Choose a clip…" (`CartonUi.bringBackChoices`, N0) as the list's rows, in its order within each group:
 * how each clip was then and is now, who deleted or added it, a title's text then.
 */
export function fromBringBack(c: BringBackChoices): ClipChoice[] {
  const span = (x?: { start?: number; end?: number }): readonly [number, number] | undefined => (x && x.start !== undefined ? [x.start, x.end ?? x.start] : undefined);
  const row = (how: ClipChoice["how"]) => (x: BringBackChoices["changed"][number]): ClipChoice => {
    const then = span(x.then), now = span(x.now);
    return {
      itemId: x.itemId,
      name: x.name,
      clip: NOUN_KIND[(x.noun ?? "").toLowerCase()] ?? "video",
      how,
      ...(then ? { then } : {}),
      ...(now ? { now } : {}),
      ...(x.by ? { author: x.by } : {}),
      ...(x.at !== undefined ? { when: x.at } : {}),
      text: "",
      ...(x.then?.text !== undefined && x.then.text !== x.now?.text ? { thenText: x.then.text } : {}),
      ...(x.token !== undefined ? { token: x.token } : {}),
      ...(x.place ? { place: x.place } : {}),
      ...(x.ripple !== undefined ? { ripple: x.ripple } : {}),
    };
  };
  return [...c.changed.map(row("changed")), ...c.deleted.map(row("deleted")), ...c.added.map(row("added"))];
}

const NAME = /“([^”]+)”/;
const span = (c: Change): readonly [number, number] | undefined => (c.at !== undefined ? [c.at, c.end ?? c.at] : undefined);

/**
 * The clips that differ between a version and now, by clip, in three groups (changed, deleted since, not there yet),
 * each in timeline order. `forward` is `changes(version, head)`; `backward`, when known, `changes(head, version)` (its
 * places are the version's: how each clip was then). Changes with no clip (the frame rate) can't be brought back alone,
 * so they aren't listed. Pure: linear in the number of changes.
 */
export function clipChoices(forward: readonly Change[], backward: readonly Change[] = []): ClipChoice[] {
  const then = new Map<string, readonly [number, number]>();
  for (const c of backward) if (c.itemId && c.kind !== "remove") {
    const s = span(c);
    if (s && !then.has(c.itemId)) then.set(c.itemId, s);
  }
  const by = new Map<string, Change[]>();
  for (const c of forward) {
    if (!c.itemId) continue;
    const list = by.get(c.itemId);
    if (list) list.push(c);
    else by.set(c.itemId, [c]);
  }
  const out: ClipChoice[] = [];
  for (const [itemId, list] of by) {
    const how = list.some((c) => c.kind === "remove") ? "deleted" : list.some((c) => c.kind === "add") ? "added" : "changed";
    // the newest change to it says who and when; a deletion's place is where it was (forward's "in a for a removal")
    let last = list[0]!;
    for (const c of list) if ((c.when ?? 0) >= (last.when ?? 0)) last = c;
    const named = list.find((c) => NAME.test(c.text)) ?? last;
    const name = NAME.exec(named.text)?.[1] ?? "";
    const place = list.find((c) => c.at !== undefined);
    const s = place ? span(place) : undefined;
    out.push({
      itemId,
      name,
      clip: last.clip,
      how,
      ...(how === "deleted" ? (s ? { then: s } : {}) : how === "added" ? (s ? { now: s } : {}) : { ...(then.has(itemId) ? { then: then.get(itemId)! } : {}), ...(s ? { now: s } : {}) }),
      ...(last.author ? { author: last.author } : {}),
      ...(last.when !== undefined ? { when: last.when } : {}),
      text: last.text,
    });
  }
  const at = (c: ClipChoice) => (c.then ?? c.now)?.[0] ?? Infinity;
  return out.sort((a, b) => at(a) - at(b));
}

const KIND_ICON: Record<ClipKind, IconName> = { video: "film", title: "text", caption: "cc", audio: "music", image: "image", code: "code", project: "layers" };
const spanText = (s: readonly [number, number]) => `${timecode(s[0])}–${timecode(s[1])}`;
const sameSpan = (a?: readonly [number, number], b?: readonly [number, number]) => !!a && !!b && Math.round(a[0]) === Math.round(b[0]) && Math.round(a[1]) === Math.round(b[1]);

export interface GoBackProps {
  version: Version;
  /** Your edit now (the cut's newest ref): what "now" is. */
  head?: string;
  /** How many changes were made after it (the card's "since" count), when known. */
  after: number | null;
  /** The choice picked when it opens (a ⋯ entry's), or the clip list at once ("clip" with `list`). */
  picked?: GoBackChoice | null;
  /** Open straight on the clip list (Bring back one clip from elsewhere). */
  list?: boolean;
  /** The clip selected on the timeline, when exactly one is: Bring back one clip is picked for it, if it differs. */
  selectedClip?: { readonly id: string; readonly name: string } | null;
  /** A teammate's cut: nothing here changes it (the card offers none of this then). */
  readOnly?: boolean;
  /** Its new cut's name form (VersionCard's), shown in place of the choices. */
  newCut: (onCancel: () => void) => ReactNode;
  /** "See it first": Compare at that clip, when the host has Compare. */
  onSeeFirst?: (choice: ClipChoice) => void;
  /** Cancel: the card as it was. */
  onCancel: () => void;
  /** Done: an action ran; the card closes. */
  onDone: () => void;
}

/**
 * The chooser's steps. A confirmation the engine refused because the clip changed since it showed (N0b's ChangedSince)
 * shows its words (`again`) over the clip as it is now, and asks again (DESIGN-V2 §3.2's conflicts).
 */
type Step = { kind: "choose" } | { kind: "clips" } | { kind: "confirm"; choice: ClipChoice; again?: string } | { kind: "newCut" };

/**
 * What Bring back will do, in DESIGN-V2 §3.2's words, from the engine's preview (N0b's place and ripple): where it goes
 * ("Its place is taken by “Drone shot”, so it goes on a new track above, at 0:06"), what else moves ("Everything after
 * it moves 5 s later"; null: "Nothing else moves."; not known: nothing said), and that Ctrl+Z takes it back.
 */
export function bringBackLine(c: ClipChoice, when: string, words: Words): string {
  const out = c.how === "added";
  const at = c.then ? timecode(c.then[0]) : c.now ? timecode(c.now[0]) : null;
  const names = c.place?.takenBy?.length ? c.place.takenBy.map((t) => `“${t.name}”`).join(" and ") : words.anotherClip;
  const lead = out
    ? words.takeOutLead
    : c.place?.placed === "new-track"
      ? `${c.how === "changed" ? `${words.asItWasAt(when)} ` : ""}${words.placeTaken(names, at)}`
      : c.how === "deleted"
        ? words.goesBackWhere(at)
        : words.bringBackChangedLead(when);
  const ripple = c.ripple === null ? words.nothingElseMoves : c.ripple ? (c.ripple.direction === "later" ? words.restMovesLater(c.ripple.by) : words.restMovesEarlier(c.ripple.by)) : null;
  return [lead, ripple, out ? words.ctrlZPutsBack : words.ctrlZTakesBack].filter(Boolean).join(" ");
}

const isAgent = (v: Version) => v.author.kind === "agent" || v.author.kind === "subagent";
const reason = (e: unknown) => (e instanceof Error && e.message ? e.message : typeof e === "string" ? e : undefined);

export function GoBack(p: GoBackProps) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const v = p.version;
  const who = actorLabel(v.author, ui.actor.bind(ui), words.you);
  const turn = isAgent(v) && (v.kind === "turn" || !!v.turn);
  const canClip = typeof ui.restoreClip === "function" && !!p.head;
  const [choice, setChoice] = useState<GoBackChoice | null>(() => (p.picked === "turn" && !turn ? null : p.picked === "clip" && !canClip ? null : (p.picked ?? null)));
  const [step, setStep] = useState<Step>(() => (p.list && canClip ? { kind: "clips" } : p.picked === "newCut" && p.list ? { kind: "newCut" } : { kind: "choose" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; why?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const time = clockOfDay(v.at, locale);
  // A step that closes takes its focused control with it: focus that fell out comes to the chooser (as the card does)
  const root = useRef<HTMLDivElement>(null);
  const lastStep = useRef<Step["kind"] | null>(null);
  useEffect(() => {
    // (on opening too: the Go back… button or the ⋯ entry that opened it is gone; review of feat/ux2-n2 #2)
    if (lastStep.current === step.kind) return;
    lastStep.current = step.kind;
    const at = document.activeElement, el = root.current;
    if (el && (!at || at === document.body || !at.isConnected)) (el.querySelector<HTMLElement>("[role=radio][tabindex='0'], .carton-bringback-btn, .carton-btn[data-variant=primary]") ?? el).focus({ preventScroll: true });
  }, [step.kind]);
  const label = turn ? words.turnOf(time, who) : versionLabel(v, { locale, actor: ui.actor.bind(ui) });
  const n = v.changes ?? v.turn?.edits ?? 0;

  // What differs since (only once the chooser is open): forward for the list, backward for how each clip was then
  const head = p.head;
  const differ = useAsync<{ list: ClipChoice[]; same: number | null } | null>(async () => {
    if (!canClip || !head || head === v.ref) return null;
    // the engine's own list when it has one (N0's bringBackChoices), else from what changed, both ways
    if (typeof ui.bringBackChoices === "function") {
      const r = await ui.bringBackChoices(v.ref);
      return { list: fromBringBack(r), same: r.same };
    }
    const [fwd, back] = await Promise.all([ui.changes(v.ref, head), ui.changes(head, v.ref).catch(() => [] as readonly Change[])]);
    return { list: clipChoices(fwd, back), same: null };
  }, [ui, v.ref, head, canClip]);
  const clips = differ.status === "ready" ? (differ.value?.list ?? null) : null;
  const same = differ.status === "ready" ? (differ.value?.same ?? null) : null;
  // A clip selected on the timeline that differs since: Bring back one clip, for it (DESIGN-V2 §3.1's exception)
  const selected = useMemo(() => (p.selectedClip && clips ? (clips.find((c) => c.itemId === p.selectedClip!.id) ?? null) : null), [clips, p.selectedClip]);
  const autoPicked = useRef(false);
  useEffect(() => {
    if (selected && !autoPicked.current && choice === null && step.kind === "choose") {
      autoPicked.current = true;
      setChoice("clip");
    }
  }, [selected, choice, step.kind]);

  const act = (run: () => Promise<unknown>, failed: string, after?: (r: unknown) => string | null) => {
    setError(null);
    setNote(null);
    setBusy(true);
    run().then(
      (r) => {
        setBusy(false);
        const res = r as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false) return setError({ text: failed, ...(res.error ? { why: res.error } : {}) });
        const said = after?.(r) ?? null;
        if (said) setNote(said);
        else p.onDone();
      },
      (e: unknown) => {
        setBusy(false);
        setError({ text: failed, ...(reason(e) ? { why: reason(e)! } : {}) });
      },
    );
  };
  // Bring back the clip as the confirmation showed it (N0b: `expect`, its token). The engine refuses one that changed
  // since (ChangedSince, checked inside the write, nothing written): then the confirmation shows its words over the clip
  // as it is now (read again: its new token, place and ripple) and asks again. One that is now as it was then: said.
  const fresh = async (c: ClipChoice): Promise<ClipChoice | "same" | null> => {
    if (typeof ui.bringBackChoices !== "function") return null;
    return fromBringBack(await ui.bringBackChoices(v.ref)).find((x) => x.itemId === c.itemId) ?? "same";
  };
  const bringBack = (c: ClipChoice) => {
    setError(null);
    setNote(null);
    setBusy(true);
    ui.restoreClip!(v.ref, c.itemId, { ...(c.how === "added" ? { remove: true } : {}), ...(c.token !== undefined ? { expect: c.token } : {}) }).then(
      (r: BringBack) => {
        setBusy(false);
        if (r?.how === "same") setNote(words.alreadyAsItWas(r.clipName || c.name));
        else p.onDone();
      },
      async (e: unknown) => {
        const x = e as { code?: string; token?: string } | null;
        // (across a bridge that keeps only a refusal's words, the clip's token says it changed)
        const now = c.token !== undefined ? await fresh(c).catch(() => null) : null;
        setBusy(false);
        // ChangedSince by its code; a changed token says it only when the refusal came with no code at all (a bridge that
        // keeps only words): any other refusal is that failure, said as such (review of feat/ux2-n2b #2)
        const code = typeof x?.code === "string" ? x.code : undefined;
        const changed = code === "CHANGED_SINCE" || (code === undefined && now !== null && (now === "same" || now.token !== c.token));
        if (!changed) return setError({ text: words.bringBackFailed, ...(reason(e) ? { why: reason(e)! } : {}) });
        if (now === "same") {
          setStep({ kind: "clips" });
          return setNote(words.alreadyAsItWas(c.name));
        }
        const said = code === "CHANGED_SINCE" && reason(e) ? reason(e)! : words.clipChangedNothing(c.name);
        // the clip as it is now could not be read: never ask again over the old preview (where it goes, what moves);
        // back to the list, read again, with the engine's words (review of feat/ux2-n2b #1)
        if (now === null) {
          setStep({ kind: "clips" });
          return setNote(said);
        }
        setStep({ kind: "confirm", choice: now, again: said });
      },
    );
  };

  const go = () => {
    if (!choice) return;
    if (choice === "clip") return selected ? setStep({ kind: "confirm", choice: selected }) : setStep({ kind: "clips" });
    if (choice === "turn") return act(() => ui.undoTurnOf(v.id), words.undoTurnFailed);
    if (choice === "restore") return act(() => ui.restore(v.ref), words.restoreFailed);
    setStep({ kind: "newCut" });
  };

  // Esc: one step back at a time (a confirmation → the list → the choices → the card), never past this chooser
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || (e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    e.stopPropagation();
    back();
  };
  const back = () => {
    setError(null);
    setNote(null);
    if (step.kind === "confirm") setStep({ kind: "clips" });
    else if (step.kind !== "choose" && !p.list) setStep({ kind: "choose" });
    else p.onCancel();
  };

  if (step.kind === "newCut") return h("div", { ref: root, tabIndex: -1, className: "carton-goback-step", onKeyDown }, p.newCut(back));

  // (the failure in History's words, the app's reason in its tooltip, as the card's own failures)
  const failure = error ? h("p", { className: "carton-error carton-card-error", role: "alert", title: error.why }, error.text) : note ? h("p", { className: "carton-goback-note", role: "status" }, note) : null;

  if (step.kind === "confirm") {
    const c = step.choice;
    const out = c.how === "added";
    return h(
      "div",
      { ref: root, tabIndex: -1, className: "carton-bringback-confirm", role: "group", "aria-label": out ? words.takeOutQ(c.name) : words.bringBackQ(c.name), onKeyDown },
      // (refused because it changed again: the engine's words, then the question again, over the clip as it is now)
      step.again ? h("p", { className: "carton-goback-warn", role: "status" }, step.again) : null,
      h("p", { className: "carton-card-confirm-title" }, out ? words.takeOutQ(c.name) : words.bringBackQ(c.name)),
      h("p", { className: "carton-card-confirm-body" }, bringBackLine(c, time, words)),
      failure,
      h(
        "div",
        { className: "carton-card-actions" },
        h(Button, { variant: "primary", icon: out ? "x" : "restoreArc", busy, onClick: () => bringBack(c) }, out ? words.takeOutNamed(c.name) : words.bringBackNamed(c.name)),
        h(Button, { variant: "ghost", onClick: back }, words.cancel),
        h("span", { className: "carton-card-gap" }),
        p.onSeeFirst ? h("button", { type: "button", className: "carton-link", onClick: () => p.onSeeFirst!(c) }, words.seeItFirst) : null,
      ),
    );
  }

  if (step.kind === "clips") return h(ClipList, { root, clips, same, loading: differ.status === "loading", failed: differ.status === "error", time, onPick: (c: ClipChoice) => setStep({ kind: "confirm", choice: c }), onBack: back, onKeyDown, failure });

  // the choices, smallest first
  const after = p.after ?? 0;
  const options: { id: GoBackChoice; title: string; line: string; button: string }[] = [];
  if (canClip) options.push({ id: "clip", title: words.bringBackOne, line: words.bringBackOneLine, button: selected ? words.bringBackAsItWas(selected.name) : words.chooseAClip });
  if (turn) options.push({ id: "turn", title: words.undoWhoseTurn(who), line: words.undoTurnLine(n, after), button: words.undoWhoseTurn(who) });
  options.push({ id: "restore", title: words.restoreWhole, line: words.restoreWholeLine(after), button: words.restoreWhole });
  options.push({ id: "newCut", title: words.newCutHere, line: words.newCutHereLine, button: words.nameTheNewCut });
  const picked = options.find((o) => o.id === choice);
  return h(
    "div",
    { ref: root, tabIndex: -1, className: "carton-goback", role: "group", "aria-label": words.goBackTo(label), onKeyDown },
    h("p", { className: "carton-goback-title" }, words.goBackTo(label)),
    p.after !== null ? h("p", { className: "carton-goback-sub" }, words.goBackAfter(after)) : null,
    h(
      "div",
      { className: "carton-goback-choices", role: "radiogroup", "aria-label": words.goBackChoices, onKeyDown: radioKeys },
      ...options.map((o) =>
        h(
          "button",
          {
            key: o.id,
            type: "button",
            role: "radio",
            className: "carton-goback-choice",
            "aria-checked": choice === o.id,
            "data-choice": o.id,
            tabIndex: choice === o.id || (!choice && o === options[0]) ? 0 : -1,
            onClick: () => (setChoice(o.id), setError(null)),
          },
          h("span", { className: "carton-goback-radio", "aria-hidden": true }),
          h("span", { className: "carton-goback-text" }, h("span", { className: "carton-goback-name" }, o.title), h("span", { className: "carton-goback-line" }, o.line)),
        ),
      ),
    ),
    failure,
    h(
      "div",
      { className: "carton-card-actions" },
      h(Button, { variant: "primary", disabled: !picked, busy, onClick: go }, picked ? picked.button : words.chooseOne),
      h(Button, { variant: "ghost", onClick: p.onCancel }, words.cancel),
      h("span", { className: "carton-card-gap" }),
      h("span", { className: "carton-goback-hint" }, words.ctrlZUndoesThese),
    ),
  );
}

/** Choose a clip… (§3.2): the clips that differ, in three plain groups; past 8, a field to find one. */
function ClipList(p: { root: { current: HTMLDivElement | null }; clips: ClipChoice[] | null; same: number | null; loading: boolean; failed: boolean; time: string; onPick: (c: ClipChoice) => void; onBack: () => void; onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void; failure: ReactNode }) {
  const ui = useCartonUi();
  const words = useWords();
  const locale = useLocale();
  const [q, setQ] = useState("");
  const all = p.clips ?? [];
  const find = q.trim().toLowerCase();
  const shown = find ? all.filter((c) => c.name.toLowerCase().includes(find)) : all;
  const groups: [string, ClipChoice[]][] = [
    [words.changedSince(shown.filter((c) => c.how === "changed").length), shown.filter((c) => c.how === "changed")],
    [words.deletedSince(shown.filter((c) => c.how === "deleted").length), shown.filter((c) => c.how === "deleted")],
    [words.notThereYet(p.time, shown.filter((c) => c.how === "added").length), shown.filter((c) => c.how === "added")],
  ];
  const meta = (c: ClipChoice): string => {
    const who = c.author ? actorLabel(c.author, ui.actor.bind(ui), words.you) : null;
    const when = c.when !== undefined ? clockOfDay(c.when, locale) : null;
    if (c.how === "deleted") return [c.then ? words.wasAt(spanText(c.then)) : null, who && when ? words.deletedBy(who, when) : null].filter(Boolean).join(" · ") || c.text;
    if (c.how === "added") return who && when ? words.addedByAt(who, when) : c.text;
    if (c.then && c.now && !sameSpan(c.then, c.now)) return words.thenNow(spanText(c.then), spanText(c.now));
    return c.thenText !== undefined ? words.thenText(c.thenText) : c.text;
  };
  return h(
    "div",
    { ref: p.root as never, tabIndex: -1, className: "carton-bringback", role: "group", "aria-label": words.bringBackOne, onKeyDown: p.onKeyDown },
    h(
      "div",
      { className: "carton-bringback-head" },
      h("button", { type: "button", className: "carton-bringback-back", "aria-label": words.backToChoices, "data-carton-tip": words.backToChoices, onClick: p.onBack }, h(Icon, { name: "arrowLeft", size: 14 })),
      h("p", { className: "carton-goback-title" }, words.bringBackOne),
    ),
    h("p", { className: "carton-goback-sub" }, words.bringBackLead(p.time)),
    all.length > 8
      ? h("input", { className: "carton-input carton-bringback-find", value: q, placeholder: words.findAClip, "aria-label": words.findAClip, onChange: (e: { currentTarget: HTMLInputElement }) => setQ(e.currentTarget.value) })
      : null,
    p.loading
      ? h("div", { className: "carton-card-skeleton", role: "status", "aria-label": words.loadingChanges }, h("span"), h("span"))
      : p.failed
        ? h("p", { className: "carton-error carton-card-error", role: "alert" }, words.failed)
        : !all.length
          ? h("p", { className: "carton-card-none" }, words.noClipDiffers)
          : h(
              "div",
              { className: "carton-bringback-list", role: "list" },
              ...groups.flatMap(([title, list]) =>
                list.length
                  ? [
                      h("p", { key: `h:${title}`, className: "carton-bringback-group", role: "presentation" }, title),
                      ...list.map((c) =>
                        h(
                          "div",
                          { key: c.itemId, role: "listitem", className: "carton-bringback-row", "data-how": c.how },
                          h("span", { className: "carton-bringback-icon", "data-clip": c.clip, "aria-hidden": true }, h(Icon, { name: KIND_ICON[c.clip] ?? "film", size: 12 })),
                          h("span", { className: "carton-bringback-text" }, h("span", { className: "carton-bringback-name" }, c.name ? `“${c.name}”` : c.text), h("span", { className: "carton-bringback-meta" }, meta(c))),
                          h("button", { type: "button", className: "carton-btn carton-bringback-btn", "data-variant": "secondary", "data-size": "sm", "aria-label": `${c.how === "added" ? words.takeOutBtn : words.bringBackBtn} “${c.name}”`, onClick: () => p.onPick(c) }, h("span", { className: "carton-btn-text" }, c.how === "added" ? words.takeOutBtn : words.bringBackBtn)),
                        ),
                      ),
                    ]
                  : [],
              ),
            ),
    // "14 other clips are the same as now." (when the engine counts them)
    p.same ? h("p", { className: "carton-bringback-same" }, words.sameAsNow(p.same)) : null,
    p.failure,
  );
}
