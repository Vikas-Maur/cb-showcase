// Time and length formatting in the editor's own style: lengths like the player's "0:13 / 0:26", differences in
// seconds with one decimal ("4.2 s", as describe() writes them), and short relative times in History.
//
// Two kinds of time (DESIGN §2.5): positions in the edit are timecodes (`timecode`: "0:06"), moments of the day always
// carry am/pm (`clock`: "12:20 pm", "yesterday at 4:10 pm"); a bare "12:20" beside a "0:06" reads as twelve minutes
// twenty. A version is named one way everywhere (`versionLabel`): its name, an agent's prompt, or "your edit from
// 12:41 pm". These two are the only places that format a version's time for display (PLAN 0.9).

import type { Actor, Version } from "./model.ts";
import { actorLabel } from "./actors.ts";

/** A length or position as the player shows it: 7.4 → "0:07.4", 75 → "1:15.0", 3725 → "1:02:05". */
export function duration(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  if (s >= 3600) {
    const t = Math.round(s);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  // Round to tenths first, so 59.96 becomes "1:00.0" and never "0:60.0".
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600), rest = (tenths % 600) / 10;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** A difference in seconds, as describe() writes it: 4.25 → "4.3 s". */
export function seconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${s.toFixed(1)} s`;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// Intl formatters, built once per locale and style. toLocaleTimeString() and friends build a new formatter on every
// call, which was the biggest cost of mounting a History row while scrolling (U3); the output is identical.
type Style = "time" | "clock" | "weekday" | "dayMonth" | "dayMonthYear" | "exact";
const STYLES: Record<Style, Intl.DateTimeFormatOptions> = {
  time: { hour: "2-digit", minute: "2-digit" },
  // the locale's 12-hour form (PLAN 0.9): every locale Intl knows has one
  clock: { hour: "numeric", minute: "2-digit", hour12: true },
  weekday: { weekday: "short" },
  dayMonth: { day: "numeric", month: "short" },
  dayMonthYear: { day: "numeric", month: "short", year: "numeric" },
  exact: { dateStyle: "medium", timeStyle: "short" },
};
const formatters = new Map<string, Intl.DateTimeFormat>();
// A formatter fixes the system time zone when it is built. If the zone changes while the app runs (a laptop that
// travels), the cache must be dropped. The offsets of now, 1 January and 1 July tell most zones apart cheaply on every
// call (Lagos and Paris share UTC+1 in winter, not in July); once a minute the zone's own name is compared too, for
// zones with the same offsets on those days.
const zoneSignature = () => {
  const y = new Date().getFullYear();
  return `${new Date().getTimezoneOffset()}|${new Date(y, 0, 1).getTimezoneOffset()}|${new Date(y, 6, 1).getTimezoneOffset()}`;
};
const zoneName = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
let zoneSig = zoneSignature();
let zone = zoneName();
let zoneCheckedAt = Date.now();
function format(style: Style, at: number | Date, locale?: string): string {
  const sig = zoneSignature();
  let changed = sig !== zoneSig;
  if (!changed && Date.now() - zoneCheckedAt > 60_000) {
    zoneCheckedAt = Date.now();
    changed = zoneName() !== zone;
  }
  if (changed) {
    zoneSig = sig;
    zone = zoneName();
    zoneCheckedAt = Date.now();
    formatters.clear();
  }
  const key = `${locale ?? ""}|${style}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, STYLES[style])));
  return f.format(at);
}

/**
 * When something happened, short and in the reader's locale: "just now", "4 min ago", "2 h ago", then the moment as
 * `clock` says it ("4:10 pm", "yesterday at 4:10 pm", "Oct 30 at 4:10 pm"): never a bare H:MM.
 */
export function when(at: number, now: number, locale?: string, justNow = "just now"): string {
  const d = now - at;
  if (d < MIN) return justNow;
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  const then = new Date(at), today = new Date(now);
  if (d < 6 * HOUR && then.getDate() === today.getDate()) return `${Math.floor(d / HOUR)} h ago`;
  return clock(at, { now, locale });
}

/** How `clock` says a day: the words around the time (a host can pass its own language's). */
export interface ClockWords {
  /** "yesterday at 4:10 pm" */
  yesterday: (time: string) => string;
  /** "Oct 30 at 4:10 pm" */
  on: (day: string, time: string) => string;
}
const CLOCK_WORDS: ClockWords = { yesterday: (t) => `yesterday at ${t}`, on: (d, t) => `${d} at ${t}` };

/** The time of day alone, always with am/pm (or the locale's own marker): "12:41 pm". */
export function clockOfDay(at: number, locale?: string): string {
  // Intl writes "12:41 PM" with a narrow no-break space; the design's form is "12:41 pm"
  return format("clock", at, locale).replace(/[\u202f\u00a0]/g, " ").replace(/\b([AP])\.?M\.?(?=$|\s)/, (_m, x: string) => `${x.toLowerCase()}m`);
}

/**
 * A moment of the day, as a person reads it beside timecodes (PLAN 0.9): "12:41 pm" today, "yesterday at 4:10 pm",
 * "Oct 30 at 4:10 pm" (the year when it isn't this one). Always with am/pm, in the locale's 12-hour form.
 */
export function clock(at: number, opts: { now?: number; locale?: string; words?: ClockWords } = {}): string {
  const now = opts.now ?? Date.now(), w = opts.words ?? CLOCK_WORDS;
  const t = clockOfDay(at, opts.locale);
  const today = new Date(now), then = new Date(at);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday && at < startOfToday + DAY) return t;
  if (at >= startOfToday - DAY && at < startOfToday) return w.yesterday(t);
  return w.on(format(then.getFullYear() === today.getFullYear() ? "dayMonth" : "dayMonthYear", then, opts.locale), t);
}

/** What `versionLabel` needs besides the version: who "you" are in words, and how to find an agent's person. */
export interface LabelContext {
  now?: number;
  locale?: string;
  /** Look up an actor by key (an agent's owner: "Leo's Director"). */
  actor?: (key: string) => Actor | undefined;
  /** At the start of a sentence (the chip, the frame label): "Your edit from 12:41 pm"; else "your edit from …". */
  start?: boolean;
  clockWords?: ClockWords;
}

// small words a shortened prompt doesn't end on: "Add captions to the…" reads "Add captions…"
const TRAILING = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "from", "by", "into", "but"]);
/**
 * An agent's prompt as a version's name (PLAN 0.9): its first line, at most `max` characters (24), cut at a word and
 * never on a small word, with "…" when cut: "Add captions to the interview" → "Add captions…".
 */
export function shortPrompt(text: string, max = 24): string {
  const one = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (Array.from(one).length <= max) return one;
  const words = Array.from(one).slice(0, max + 1).join("").split(" ");
  // the last word is cut (or the one after the limit): drop it, then any small words before it
  words.pop();
  while (words.length > 1 && TRAILING.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const kept = words.join(" ").replace(/[,;:\-–—]+$/, "");
  return `${kept || Array.from(one).slice(0, max).join("")}…`;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const isAgent = (a: Actor) => a.kind === "agent" || a.kind === "subagent";

/**
 * Straight quotation marks in what someone typed (a prompt, a version's name), as the curly ones Compare and History
 * use everywhere (laptop: Director's “Make the title say "Summer launch"” mixed them). Shown inside the panel's own
 * “…”, so its quotes become single ones: ‘Summer launch’. An apostrophe inside a word (Leo's) stays as typed.
 */
export function curlyQuotes(text: string): string {
  if (!/["']/.test(text)) return text;
  return text
    .replace(/"([^"\n]*)"/g, "‘$1’")
    .replace(/(^|[\s([{“‘—–-])'([^'\n]*?)'(?=$|[\s.,;:!?)\]}”’—–-])/g, "$1‘$2’");
}

/**
 * A version named by what it is (PLAN 0.9, DESIGN §2.5), the one label the chip, the row, the frame, the toasts and
 * the Changes title use: its name ("“Sent to client”"), an agent's prompt ("Director's “Add captions…”"), or "your
 * edit from 12:41 pm" ("Leo's edit from 12:41 pm" for a teammate's). A History start reads "the start of History".
 */
export function versionLabel(v: Version, ctx: LabelContext = {}): string {
  const done = (s: string) => (ctx.start ? cap(s) : s);
  const who = actorLabel(v.author, ctx.actor, "You");
  const prompt = v.turn?.label || (isAgent(v.author) ? v.name : undefined);
  if (isAgent(v.author) && prompt) return done(`${who}'s “${shortPrompt(curlyQuotes(prompt))}”`);
  if (v.name) return `“${curlyQuotes(v.name)}”`;
  if (v.start) return done("the start of History");
  const at = clock(v.at, { ...(ctx.now !== undefined ? { now: ctx.now } : {}), ...(ctx.locale ? { locale: ctx.locale } : {}), ...(ctx.clockWords ? { words: ctx.clockWords } : {}) });
  if (v.author.kind === "system" || !who) return done(`the version from ${at}`);
  return done(v.author.isYou && v.author.kind === "human" ? `your edit from ${at}` : `${who}'s edit from ${at}`);
}

/** The chip's short form of a version (PLAN 0.5): "12:20 pm · Director". */
export function versionShort(v: Version, ctx: LabelContext = {}): string {
  const at = clock(v.at, { ...(ctx.now !== undefined ? { now: ctx.now } : {}), ...(ctx.locale ? { locale: ctx.locale } : {}), ...(ctx.clockWords ? { words: ctx.clockWords } : {}) });
  const who = actorLabel(v.author, ctx.actor, "You");
  return who ? `${at} · ${who}` : at;
}

/**
 * A position in the edit, as the change sentences say it (core's describe), to the nearest second: 9 → "0:09", 75.4 →
 * "1:15", 3725 → "1:02:05".
 */
export function timecode(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** A full date and time for tooltips. */
export function exactTime(at: number, locale?: string): string {
  return format("exact", at, locale);
}

/** A clock time, "10:04 am": tells apart two edits of one day (a conflict card between two of your own edits). */
export function clockTime(at: number, locale?: string): string {
  return clockOfDay(at, locale);
}

/** A short date for names like "Offline edits (31 Oct)". */
export function shortDate(at: number, locale?: string): string {
  return format("dayMonth", at, locale);
}
