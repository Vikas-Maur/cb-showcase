// Conflict cards in words (docs/carton-ux DESIGN §6.5 and §8, PLAN 7.1). Two halves:
// - cardSentences(): what each side of one of core's cards did, as a change sentence about the card's clip ("Moved it
//   to start at 0:20"), a verb phrase for the card's title ("moved it") and a noun for the viewing label ("move"). Read
//   from the card's values against its base, with the schema's field labels, the cut's head for names (never ids), and
//   the host's value words (Cardboard's units: "50%", "2×", a media file's name). fromCarton fills ConflictSide.text,
//   .did and .what, and Conflict.clip, with it.
// - conflictWords(): everything a card says, from a view-model Conflict: its title, its lead, each side's name, the
//   Keep button's name for each pick, and the viewing label of each side ("Claude Code's move of “Interview B”"). One
//   place, so the card, its toast and the viewing label agree, and no two sides or buttons on a card read the same.
// core's describeCard (the old "'Intro' timing" title and the side's bare value, ConflictSide.summary) stays as it is:
// the sync tests and the Fold dialog read it.

import { deepEqual, getIn, POS } from "@carton/core";
import type { ConflictCard, Doc, Rec, Schema } from "@carton/core";
import { actorLabel } from "./actors.ts";
import type { Actor, Conflict, ConflictChoice, ConflictSide } from "./model.ts";
import { words as defaultWords, type Words } from "./words.ts";

/** What one side did, in words (see `cardSentences`). */
export interface SideSentence {
  /** "Moved it to start at 0:20" */
  readonly text: string;
  /** "moved it" */
  readonly did: string;
  /** "move" */
  readonly what: string;
}

export interface CardSentences {
  /** The clip's (or record's) name, unquoted, when the card is about one: "Interview B". */
  readonly clip?: string;
  readonly ours: SideSentence;
  readonly theirs: SideSentence;
}

/** The host's words for a field's value (Cardboard's `cardboardValue`); undefined: the default words. */
export type CardValueWords = (key: string, value: unknown, doc: Doc | undefined) => string | undefined;

const EPS = 1e-4;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const unescapeSegment = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");
const isIdKey = (k: string) => k === "id" || /Ids?$/.test(k.slice(k.lastIndexOf(".") + 1));

/** A position in the edit, as the editor shows it ("0:18"), with `p` decimals when whole seconds can't tell two apart. */
function tcode(s: number, p: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const f = 10 ** p;
  const t = Math.round(s * f) / f;
  const whole = Math.floor(t + 1e-9);
  const frac = p ? (t - whole).toFixed(p).slice(1) : "";
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), sec = whole % 60;
  const ss = String(sec).padStart(2, "0") + frac;
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The leaves of a record value, by dotted path (arrays are one leaf). */
function leaves(v: unknown, prefix = "", out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (isObj(v) && depth < 4) for (const k in v) leaves(v[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
  else if (prefix) out.set(prefix, v);
  return out;
}

// What one side did, before it is put in words (so both sides can be worded with the precision that tells them apart).
type Part =
  | { k: "removed" }
  | { k: "added"; s?: number }
  | { k: "move"; s: number }
  | { k: "trimEnd"; e: number }
  | { k: "trimStart"; s: number }
  | { k: "retime"; s: number; e: number }
  | { k: "slip"; src: number }
  | { k: "left"; s: number; e: number }
  | { k: "lane"; track: string }
  | { k: "order" }
  | { k: "text"; v: string }
  | { k: "rename"; v: string }
  | { k: "size"; label: string; v: string; up: boolean }
  | { k: "set"; label: string; v: string }
  | { k: "setting"; label: string; v: string }
  | { k: "cleared"; label: string }
  | { k: "changedField"; label: string }
  | { k: "changed" };

/**
 * What each side of a conflict card did, as change sentences about the card's clip (DESIGN §8 "(a conflict side) Moved
 * it to start at 0:07"). `doc` is the cut's head: it names the clip, its track and its media. `value` words a field's
 * value in the host's units. The two sides' sentences are worded with the precision that tells them apart (0:05 and
 * 0:05.3, never 0:05 twice).
 */
export function cardSentences(card: ConflictCard, schema: Schema, doc?: Doc, value?: CardValueWords, w: Words = defaultWords): CardSentences {
  const path = card.path.split("/").map(unescapeSegment);
  const coll = schema.collections[path[0]!] ? path[0]! : null;
  const cs = coll ? schema.collections[coll]! : null;
  const tl = schema.timeline;
  const isTl = !!tl && coll === tl.collection;
  const whole = !!coll && path.length === 2;
  const rest = coll ? path.slice(2) : path;
  const group = rest.length === 1 && rest[0]!.startsWith("#") && rest[0] !== POS ? rest[0]!.slice(1) : null;
  const atDoc = coll && doc ? (getIn(doc, [coll, path[1]!], schema) as Rec | undefined) : undefined;
  const rec = (atDoc ?? (whole ? (card.ours ?? card.theirs ?? card.base) : undefined)) as Rec | undefined;

  // The clip's name: its label, or for a record that is part of another (a title's own text entry) its holder's.
  const nameOf = (c: string, r: Rec | undefined): string | undefined => {
    if (!r) return undefined;
    const n = schema.label?.(c, r, doc) ?? (typeof r.name === "string" && r.name ? r.name : undefined);
    return n || undefined;
  };
  let clip: string | undefined;
  if (coll && rec) {
    const part = cs?.partOf;
    const holder = part && doc ? ((doc[part.collection] as Rec[] | undefined) ?? []).find((x) => x[part.field] === path[1]) : undefined;
    clip = holder ? nameOf(part!.collection, holder) : nameOf(coll, rec);
  }

  const labelOf = (key: string): string | null => {
    const labels = cs ? cs.labels : schema.labels;
    const parts = key.split(".");
    for (let n = parts.length; n > 0; n--) {
      const l = labels?.[parts.slice(0, n).join(".")];
      if (l) return l;
    }
    return labels && Object.keys(labels).length ? null : key;
  };
  const num = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(2)));
  // Text in curly quotes, cut to 40 characters: its start, or (when two sides' starts read the same) its end, or all
  // of it (review of feat/ux-7-conflicts #6: two titles differing only at the end read alike).
  let cut: "start" | "end" | "none" = "start";
  const quote = (s: string) => `“${s.length <= 40 || cut === "none" ? s : cut === "start" ? s.slice(0, 37) + "…" : "…" + s.slice(-37)}”`;
  const valueWords = (key: string, v: unknown): string | null => {
    const host = value?.(key, v, doc);
    if (host !== undefined) return host.replace(/^'(.*)'$/s, "“$1”");
    if (typeof v === "number") return num(v);
    if (typeof v === "string") return quote(v);
    if (typeof v === "boolean") return v ? "on" : "off";
    return null;
  };
  const trackName = (id: unknown): string => {
    const t = tl && doc ? (getIn(doc, [tl.lanes, id as string], schema) as Rec | undefined) : undefined;
    const n = t ? nameOf(tl!.lanes, t) : undefined;
    return n ? `“${n}”` : w.sideAnotherTrack;
  };
  const TIME = new Set(tl ? [tl.start, tl.end, tl.source, tl.sourceEnd] : []);

  // A clip's times on one side against the base.
  const timeParts = (v: Record<string, unknown>, b: Record<string, unknown> | undefined): Part[] => {
    if (!tl) return [];
    const s = v[tl.start], e = v[tl.end];
    if (typeof s !== "number" || typeof e !== "number") return [];
    const bs = b?.[tl.start], be = b?.[tl.end];
    if (typeof bs !== "number" || typeof be !== "number") return [{ k: "added", s }];
    const ds = s - bs, de = e - be;
    if (Math.abs(ds) < EPS && Math.abs(de) < EPS) {
      const src = v[tl.source], bsrc = b?.[tl.source];
      if (typeof src === "number" && typeof bsrc === "number" && Math.abs(src - bsrc) > EPS) return [{ k: "slip", src }];
      return [{ k: "left", s, e }];
    }
    if (Math.abs(ds - de) < EPS) return [{ k: "move", s }];
    if (Math.abs(ds) < EPS) return [{ k: "trimEnd", e }];
    if (Math.abs(de) < EPS) return [{ k: "trimStart", s }];
    return [{ k: "retime", s, e }];
  };
  // One field's value on one side.
  const fieldPart = (key: string, v: unknown, b: unknown): Part | null => {
    if (isTl && tl && key === tl.lane) return { k: "lane", track: trackName(v) };
    if (isIdKey(key)) {
      const host = value?.(key, v, doc);
      const l = labelOf(key);
      return host === undefined || !l ? null : { k: "set", label: l, v: host.replace(/^'(.*)'$/s, "“$1”") };
    }
    const l = labelOf(key);
    if (!l) return null;
    if (v === undefined || v === null) return { k: "cleared", label: l };
    if (typeof v === "string" && (key === "name" || l === "name")) return { k: "rename", v: quote(v) };
    if (typeof v === "string" && l === "text") return { k: "text", v: quote(v) };
    const vw = valueWords(key, v);
    if (vw === null) return { k: "changedField", label: l };
    // a setting of the whole project: the title names it ("Aspect ratio: …"), so the side says only its new value
    if (!coll) return { k: "setting", label: l, v: typeof v === "string" ? v : vw };
    if (typeof v === "number" && typeof b === "number" && /size|scale/.test(l) && Math.abs(v - b) > EPS) return { k: "size", label: l, v: vw, up: v > b };
    return { k: "set", label: l, v: vw };
  };
  // What one side did, as parts: against a removed side or one that kept the base, what it changed from the base.
  const sideParts = (v: unknown, other: unknown): Part[] => {
    if (v === undefined || v === null) return [whole || card.kind === "parent" || card.kind === "record" ? { k: "removed" } : { k: "cleared", label: labelOf(rest.join(".")) ?? w.sideItsValue }];
    if (rest.at(-1) === POS) return [{ k: "order" }];
    if (whole || group) {
      if (!isObj(v)) return [{ k: "changed" }];
      const b = card.base;
      const lv = leaves(v), lo = leaves(isObj(other) ? other : b), lb = leaves(b);
      let keys = [...new Set([...lv.keys(), ...lo.keys()])].filter((k) => !deepEqual(lv.get(k), lo.get(k)) && !k.endsWith(POS) && k !== POS);
      if (!keys.length) keys = [...lv.keys()].filter((k) => !deepEqual(lv.get(k), lb.get(k)));
      const parts: Part[] = [];
      if (isTl && keys.some((k) => TIME.has(k))) parts.push(...timeParts(v, isObj(b) ? b : undefined));
      for (const k of keys) {
        if (isTl && TIME.has(k)) continue;
        const p = fieldPart(k, lv.get(k), lb.get(k));
        if (p && !parts.some((x) => deepEqual(x, p))) parts.push(p);
      }
      if (!parts.length) parts.push(!isObj(b) && whole ? { k: "added" } : { k: "changed" });
      return parts;
    }
    const key = rest.join(".");
    const p = fieldPart(key, v, card.base);
    return [p ?? { k: "changed" }];
  };

  // The same words for both: try again with tenths, then hundredths of a second, then with text's end, then all of it.
  let o: SideSentence | null = null, t: SideSentence | null = null;
  for (const c of ["start", "end", "none"] as const) {
    cut = c;
    const ours = sideParts(card.ours, card.theirs), theirs = sideParts(card.theirs, card.ours);
    for (let p = 0; p <= 2 && (!o || o.text === t!.text); p++) (o = wordSide(ours, p, w)), (t = wordSide(theirs, p, w));
    if (o!.text !== t!.text) break;
    o = null;
  }
  if (!o || !t) {
    cut = "start";
    const ours = sideParts(card.ours, card.theirs), theirs = sideParts(card.theirs, card.ours);
    (o = wordSide(ours, 0, w)), (t = wordSide(theirs, 0, w));
  }
  return { ...(clip ? { clip } : {}), ours: o, theirs: t };
}

/** One side's parts in words: the first part leads the sentence, up to two more follow it ("and 2 more changes"). */
function wordSide(parts: readonly Part[], p: number, w: Words): SideSentence {
  const one = (x: Part): { text: string; did: string; what: string } => {
    const at = (s: number) => tcode(s, p);
    switch (x.k) {
      case "removed": return { text: w.sideRemoved, did: w.didRemove, what: w.whatRemove };
      case "added": return { text: x.s !== undefined ? w.sideAdded(at(x.s)) : w.sideAddedNoTime, did: w.didAdd, what: w.whatAdd };
      case "move": return { text: w.sideMoved(at(x.s)), did: w.didMove, what: w.whatMove };
      case "trimEnd": return { text: w.sideTrimmedEnd(at(x.e)), did: w.didTrim, what: w.whatTrim };
      case "trimStart": return { text: w.sideTrimmedStart(at(x.s)), did: w.didTrim, what: w.whatTrim };
      case "retime": return { text: w.sideRetimed(at(x.s), at(x.e)), did: w.didRetime, what: w.whatRetime };
      case "slip": return { text: w.sideSlipped(at(x.src)), did: w.didSlip, what: w.whatSlip };
      case "left": return { text: w.sideLeft(at(x.s), at(x.e)), did: w.didRetime, what: w.whatRetime };
      case "lane": return { text: w.sideToTrack(x.track), did: w.didMove, what: w.whatMove };
      case "order": return { text: w.sideOrder, did: w.didReorder, what: w.whatMove };
      case "text": return { text: w.sideText(x.v), did: w.didChangeField("text"), what: w.whatEdit };
      case "rename": return { text: w.sideRenamed(x.v), did: w.didRename, what: w.whatRename };
      case "size": return { text: x.up ? w.sideBigger(x.label, x.v) : w.sideSmaller(x.label, x.v), did: w.didChangeField(x.label), what: w.whatEdit };
      case "set": return { text: w.sideSet(x.label, x.v), did: w.didChangeField(x.label), what: w.whatEdit };
      case "setting": return { text: w.sideText(x.v), did: w.didChange, what: x.label };
      case "cleared": return { text: w.sideCleared(x.label), did: w.didChangeField(x.label), what: w.whatEdit };
      case "changedField": return { text: w.sideChangedField(x.label), did: w.didChangeField(x.label), what: w.whatEdit };
      default: return { text: w.sideChanged, did: w.didChange, what: w.whatEdit };
    }
  };
  const first = one(parts[0] ?? { k: "changed" });
  if (parts.length === 1) return first;
  const shown = parts.slice(0, 2).map((x, i) => (i ? lowerFirst(one(x).text) : one(x).text));
  const more = parts.length - 2;
  return { text: shown.join(", ") + (more > 0 ? ` ${w.sideMore(more)}` : ""), did: w.didChange, what: w.whatEdit };
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * An engine summary in the card's words, for a card that came without its sentences (design QA G30): a name in curly
 * quotes, times as the editor shows them ("0:05", not "0:05.0"; "6 s", not "6.0 s").
 */
export function tidySummary(s: string): string {
  return s
    .replace(/(^|[\s(])'([^']+)'(?=$|[\s,.:;)])/g, "$1“$2”")
    .replace(/(\d:\d{2})\.0+\b/g, "$1")
    .replace(/\b(\d+)\.0+(?= ?s\b)/g, "$1");
}

/** What a card's side says it did: its sentence ("Moved it to start at 0:20"), else the engine's summary, tidied. */
export const sideText = (s: ConflictSide): string => s.text ?? tidySummary(s.summary);

/** A card's subject from an engine title with no clip told: its quoted name ("'Intro' timing" → “Intro”), else the title. */
const subjectOfTitle = (title: string): string => {
  const m = /^['“]([^'”]+)['”]/.exec(title);
  return m ? `“${m[1]}”` : tidySummary(title);
};
/** "Your move" reads "your move" mid-sentence ("Kept your move of …"), as do "Yours" and "Both"; a name keeps its capital. */
const midSentence = (s: string) => s.replace(/^(Yours|Your|Both)\b/, (x) => x.toLowerCase());

/** Everything one conflict card says (see `conflictWords`). */
export interface ConflictCardWords {
  /** "“Interview B”: you and Claude Code both moved it" */
  readonly title: string;
  /** "Pick the one to keep. Until you pick, yours is in the timeline." (or the engine's reason, or "You changed … twice") */
  readonly lead: string;
  /** Each side's name in the card: "Yours", "Claude Code's", "Your earlier change". */
  readonly name: Readonly<Record<ConflictChoice, string>>;
  /** What the primary button reads for each pick: "Keep yours", "Keep Claude Code's", "Keep both", "Keep earlier". */
  readonly keep: Readonly<Record<ConflictChoice, string>>;
  /** Each side as the viewing label names it: "Claude Code's move of “Interview B”", "Your trim of “Intro”". */
  readonly label: Readonly<Record<ConflictChoice, string>>;
  /** "See yours", "See Claude Code's": each See it's name for screen readers (the visible "See it" sits in its side). */
  readonly see: Readonly<Record<"mine" | "theirs", string>>;
  /** The two sides are one person's, told apart by order: show each side's clock time, not "2 min ago". */
  readonly ordered: boolean;
  /** The side listed first: yours, or for one person's two changes the earlier one. */
  readonly first: "mine" | "theirs";
  /** Who the other side is, by name ("Claude Code"): the line during its turn, "changed it again". */
  readonly other: string;
}

/**
 * What a card says, from a view-model Conflict (DESIGN §6.5, §8). `nameOf` names an actor as the card shows it (You,
 * a teammate's name, Director, Claude Code). Two sides by one person read as their earlier and later change.
 */
export function conflictWords(c: Conflict, nameOf: (a: Actor) => string, w: Words = defaultWords, locale?: string): ConflictCardWords {
  const isYou = (s: ConflictSide) => s.author.kind === "human" && !!s.author.isYou;
  const mineName = nameOf(c.mine.author), theirsName = nameOf(c.theirs.author);
  const ordered = mineName === theirsName && (c.mine.where ?? "") === (c.theirs.where ?? "");
  const subject = c.clip ? `“${c.clip}”` : subjectOfTitle(c.title);
  const both = w.bothChangesTo(c.clip);
  const whatOf = (s: ConflictSide) => s.what ?? w.whatEdit;
  const sideLabel = (s: ConflictSide, n: string) =>
    c.clip ? (isYou(s) ? w.yourSideOf(whatOf(s), c.clip) : w.sideOf(n, whatOf(s), c.clip)) : isYou(s) ? w.yourSideAlone(whatOf(s)) : w.sideAlone(n, whatOf(s));

  if (ordered) {
    // the side shown now (head) landed first unless their times say otherwise
    const earlier: "mine" | "theirs" = c.mine.at != null && c.theirs.at != null ? (c.mine.at <= c.theirs.at ? "mine" : "theirs") : c.provisional === "mine" ? "mine" : "theirs";
    const who = isYou(c.mine) ? null : mineName;
    const nm = (k: "mine" | "theirs") => (k === earlier ? (who ? w.theirEarlier(who) : w.yourEarlier) : who ? w.theirLater(who) : w.yourLater);
    // the same thing twice ("You changed its text twice"), or each change as it was, earlier first ("You moved it in one
    // place and removed it in another"); never "twice" for two different things (review #7)
    const did = c.mine.did && c.mine.did === c.theirs.did ? c.mine.did : null;
    const each = !did && c.mine.did && c.theirs.did ? (earlier === "mine" ? [c.mine.did, c.theirs.did] : [c.theirs.did, c.mine.did]) : null;
    const close = c.mine.at != null && c.theirs.at != null && Math.abs(c.mine.at - c.theirs.at) <= 2 * 60_000;
    const shown = c.provisional === "both" ? null : midSentence(nm(c.provisional === "mine" ? "mine" : "theirs"));
    return {
      title: w.conflictTwice(subject, who),
      lead: c.reason ?? (did ? w.conflictTwiceLead(who, did, close) : each ? w.conflictTwiceEach(who, each[0]!, each[1]!) : w.pickLeadFor(shown, c.canKeepBoth)),
      name: { mine: nm("mine"), theirs: nm("theirs"), both: w.both },
      keep: { mine: earlier === "mine" ? w.keepEarlier : w.keepLater, theirs: earlier === "theirs" ? w.keepEarlier : w.keepLater, both: w.keepBoth },
      label: { mine: w.orderedSideOf(nm("mine"), c.clip), theirs: w.orderedSideOf(nm("theirs"), c.clip), both },
      see: { mine: w.seeSide(nm("mine")), theirs: w.seeSide(nm("theirs")) },
      ordered: true,
      first: earlier,
      other: who ?? w.you,
    };
  }
  const possessive = (s: ConflictSide, n: string) => (isYou(s) ? w.yours : w.theirs(n));
  const keepOf = (s: ConflictSide, n: string) => (isYou(s) ? w.keepYours(s.where) : w.keepOf(n, s.where));
  const name = { mine: possessive(c.mine, mineName), theirs: possessive(c.theirs, theirsName), both: w.both };
  // "you" mid-sentence; the other side by name
  const subjectOf = (s: ConflictSide, n: string) => (isYou(s) ? w.you.toLowerCase() : n);
  const a = subjectOf(c.mine, mineName), b = subjectOf(c.theirs, theirsName);
  // without what each side did (a card from before the sentences), "“Intro”: you and Director both changed it"
  const title = !c.mine.did || !c.theirs.did ? w.conflictBoth(subject, a, b, w.didChange) : c.mine.did === c.theirs.did ? w.conflictBoth(subject, a, b, c.mine.did) : w.conflictEach(subject, a, c.mine.did, b, c.theirs.did);
  const shownSide = c.provisional === "both" ? null : c.provisional === "theirs" ? midSentence(name.theirs) : midSentence(name.mine);
  return {
    title,
    lead: c.reason ?? w.pickLeadFor(shownSide, c.canKeepBoth),
    name,
    keep: { mine: keepOf(c.mine, mineName), theirs: keepOf(c.theirs, theirsName), both: w.keepBoth },
    label: { mine: sideLabel(c.mine, mineName), theirs: sideLabel(c.theirs, theirsName), both },
    see: { mine: w.seeSide(name.mine), theirs: w.seeSide(name.theirs) },
    ordered: false,
    first: "mine",
    other: isYou(c.theirs) ? mineName : theirsName,
  };
}

/** "Kept Claude Code's move of “Interview B”." (the toast after a pick, DESIGN §6.7) */
export function keptText(c: Conflict, choice: ConflictChoice, byKey?: (key: string) => Actor | undefined, w: Words = defaultWords, locale?: string): string {
  const cw = conflictWords(c, (a) => actorLabel(a, byKey, w.you), w, locale);
  return w.keptToast(midSentence(cw.label[choice]));
}

/**
 * After a pick's Undo (PLAN 5.3): the side in the timeline again, the one shown before the pick (`provisional`):
 * "Pick undone. Claude Code's move of “Interview B” is back." Just "Pick undone." when the card didn't say which side
 * was shown, or both were.
 */
export function pickUndoneText(c: Conflict, byKey?: (key: string) => Actor | undefined, w: Words = defaultWords, locale?: string): string {
  const side = c.provisional;
  if (side !== "mine" && side !== "theirs") return w.pickUndone(null);
  const cw = conflictWords(c, (a) => actorLabel(a, byKey, w.you), w, locale);
  return w.pickUndone(cw.label[side]);
}
