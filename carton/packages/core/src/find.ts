// Find (Carton UX v2, N0; DESIGN-V2 §2.3): search a cut's versions by text, over what people remember of them: the
// clips it touched (by name, as they were then and after), the title and caption text it set, the agent request a turn
// was named from, a version's name and landmark words, who made it, and the day. Every word of the text matches the
// start of a word there, in any order, any case, accents ignored ("intr cap" finds "Add captions to the intro"). Outside the history bundle (scripts/size.mjs): History is never asked for more
// than its log and states. The index is built lazily (the first `find`), walked forward once over the cut's rows and
// kept per cut; a later `find` reads only the rows saved since. Nothing here runs on a save or an open.
import type { Actor, ChangeId, PathKey, StateRef } from "./types.ts";
import type { LandmarkKind } from "./landmarks.ts";

/**
 * What a match matched, by weight (DESIGN-V2 §2.3): a clip's name, title and caption text (then and now), an agent's
 * request (the prompt its turn was named from), a version's name and its landmark words ("exported", "sent", "start"),
 * a person, a day ("yesterday", "Monday", "Oct 30").
 */
export type FindField = "clip" | "text" | "prompt" | "name" | "person" | "day";
export const FIND_FIELDS: readonly FindField[] = ["clip", "text", "prompt", "name", "person", "day"];

export interface FindOptions {
  /** The cut to search (default: the current cut). */
  cut?: string;
  /** At most this many matches, newest first (default 50, at most 1000). `total` still counts them all. */
  limit?: number;
  /** Only versions before this seq (the next page: the last match's seq). */
  before?: number;
  /** Only these fields (default: all). */
  fields?: readonly FindField[];
  /** Every cut ("Search every cut", `cb history --find … --all-cuts`): matches from all, newest first. */
  allCuts?: boolean;
  /** What "today" and "yesterday" mean (default: now). */
  now?: number;
}

/** One version that matched. */
export interface FindMatch {
  ref: StateRef;
  /** Its change (null: a cut's start). */
  change: ChangeId | null;
  at: number;
  /** Who made it, told as `log()` tells it (a generic person by the person behind the replica). */
  author: Actor | null;
  /** The version's name, when it has one ("Sent to client"). */
  name?: string;
  /** The best field it matched (FIND_FIELDS' order). */
  field: FindField;
  /** Every field it matched, in that order. */
  fields: FindField[];
  /**
   * A short piece of what matched (at most about 80 characters, `…` where it was cut), for a row's second line: the
   * name or prompt itself, a clip's name, the text, the person's name. Never an id or a hash.
   */
  snippet: string;
  /** Where the first word matched in `snippet` (UTF-16 offsets, [lo, hi)), for highlighting; `hits`: every word's. */
  hit: [number, number];
  hits: [number, number][];
  /** A clip or text match: the record (`timelineItems/c1`) and its name ("Intro"). */
  record?: PathKey;
  recordName?: string;
  /** A clip match: where the clip was after this version, in seconds ("“Intro” was 0:00–0:06 here"); absent: deleted. */
  span?: { start: number; end: number };
  /** The version's landmarks, if it is any (`LANDMARK_ORDER`'s order). */
  landmarks?: LandmarkKind[];
}

export interface FindResult {
  /**
   * The clips the words name ("A clip first", DESIGN-V2 §2.3), as the cut has them now or had them last (a deleted
   * one), best first: what "Only this clip" filters by.
   */
  clips: { record: PathKey; name: string; cut: string; deleted?: true }[];
  /** Newest first, at most `limit`. */
  matches: FindMatch[];
  /** How many versions matched in all (within `before`). */
  total: number;
  /** How many versions were searched. */
  versions: number;
}

// ------------------------------------------------------------------ the index

import type { ConfirmedChange, Doc, Rec } from "./types.ts";
import type { Schema } from "./schema.ts";
import * as E from "./engine/index.ts";
import { unescapeSegment } from "./engine/json.ts";

/** Lower case, accents dropped ("Émile" → "emile"): what find compares. */
export const foldText = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * A string with its words, folded once (at index time): each word's offset in the string, for the highlight. A word
 * is a run of letters and digits ("Summer ’26": "summer", "26").
 */
export interface Words {
  readonly text: string;
  readonly toks: readonly { readonly at: number; readonly len: number; readonly w: string }[];
  /** Its folded words, each after a space: a word starts with `q` where `hay.includes(" " + q)`. */
  readonly hay: string;
}
const WORD = /[\p{L}\p{N}]+/gu;
export function findWords(s: string): Words {
  const text = s.replace(/\s+/g, " ").trim();
  const toks: { at: number; len: number; w: string }[] = [];
  let hay = "";
  for (const m of text.matchAll(WORD)) {
    const w = foldText(m[0]);
    toks.push({ at: m.index, len: m[0].length, w });
    hay += " " + w;
  }
  return { text, toks, hay };
}
/** Words as one string to test a word's start with `includes(" " + q)`: each folded word after a space. */
export const hayOf = (ws: readonly Words[]): string => {
  let h = "";
  for (const w of ws) h += w.hay;
  return h;
};
/** The words of a query, folded. */
export const queryWords = (q: string): string[] => [...foldText(q).matchAll(WORD)].map((m) => m[0]);
/** The words of `w` each query word starts: [lo, hi) per word matched, or null when a query word matches none. */
export function hitsIn(w: Words, q: readonly string[], all = false): [number, number][] | null {
  const out: [number, number][] = [];
  for (const x of q) {
    const t = w.toks.find((t) => t.w.startsWith(x));
    if (t) out.push([t.at, t.at + Math.min(t.len, x.length)]);
    else if (all) return null;
  }
  return out.length ? out : null;
}

interface Entry {
  seq: number;
  row: ConfirmedChange;
  /** Every word of its clips' names and its texts, folded, each after a space: a word's start is `" " + word`. */
  hay: string;
  /** Who made it (an index into `FindIndex.whos`: actor and change replica, what `log()` tells them by) and its local day (yyyymmdd), for the query's caches. */
  who: number;
  day: number;
  /** The clips it touched, each by every name it had (before and after the version), and where it was after it. */
  clips: { key: PathKey; names: Words[]; span?: { start: number; end: number } }[];
  /** Text it set (a title's, a caption's), by record. */
  texts: { key: PathKey; name: string; text: Words }[];
}

/** What the index reads from Carton: its rows, the state they start from, and which records each touched. */
export interface FindSource {
  schema: Schema;
  log: readonly ConfirmedChange[];
  /** The cut's start state (seq 0), as History holds it (never written: the walk forks it). */
  start: () => Doc | null;
  /** The records a row touched (Carton's `#recordsOf`). */
  records: (c: ConfirmedChange) => readonly PathKey[];
  /** A row is a fold-some's fold, whose version is the partial revert right after it. */
  completedAt: (log: readonly ConfirmedChange[], seq: number) => boolean;
}

/**
 * One cut's find index: a forward walk over its rows, kept between calls. Each version's entry holds the names of the
 * clips it touched (as they were before and after it) and the text it set. Names of versions and people aren't kept:
 * they are read at query time (a rename, a person's name from the server, shows at once).
 */
export class FindIndex {
  #log: readonly ConfirmedChange[] | null = null;
  #last: ConfirmedChange | null = null;
  #seq = 0;
  #doc: Doc | null = null;
  readonly entries: Entry[] = [];
  /** Every clip the cut's versions touched, by its newest name (deleted: the name it had last): find's `clips`. */
  readonly clips = new Map<PathKey, { names: Words[]; seq: number; deleted?: true }>();
  /** Who made each version, by index (`Entry.who`): actor and change replica. */
  readonly #whoIx = new Map<string, number>();
  /** A string's words, once per string (names and texts repeat over thousands of versions). */
  readonly #wordsOf = new Map<string, Words>();
  #words(s: string): Words {
    let w = this.#wordsOf.get(s);
    if (!w) this.#wordsOf.set(s, (w = findWords(s)));
    return w;
  }

  /** Index the rows saved since the last call; start again when the cut's log was rebuilt (a compaction, a reload). */
  update(src: FindSource): void {
    const { log, schema } = src;
    const tl = schema.timeline;
    if (log !== this.#log || (this.#seq && log[this.#seq - 1] !== this.#last) || log.length < this.#seq) this.#reset(src);
    if (!this.#doc) return;
    let doc = this.#doc;
    for (let s = this.#seq + 1; s <= log.length; s++) {
      const c = log[s - 1]!;
      // no version of its own: a withdraw row, a compacted row (its ops are in the row it was squashed into), a
      // fold-some's fold (its version is the partial revert after it, which takes its records)
      const version = !c.withdrawn && c.squashedInto === undefined && !src.completedAt(log, s);
      let keys: readonly PathKey[] = version ? src.records(c) : [];
      if (version && s > 1 && src.completedAt(log, s - 1)) {
        const out = new Set((c.rejected ?? []).map((p) => p.split("/").slice(0, 2).join("/")));
        keys = src.records(log[s - 2]!).filter((k) => !out.has(k));
      }
      const recs = keys.flatMap((k) => {
        const [a, b] = k.split("/");
        if (b === undefined) return [];
        const coll = unescapeSegment(a!), spec = schema.collections[coll];
        return spec ? [{ key: k, coll, id: unescapeSegment(b), spec }] : [];
      });
      const before = recs.map((r) => this.#read(doc, r.coll, r.id, r.spec, schema));
      if (c.ops.length) doc = E.apply(doc, c.ops, schema);
      if (!version) continue;
      const d = new Date(c.at);
      const wk = `${c.author ? `${c.author.kind}/${c.author.id}/${c.author.agentId ?? ""}` : ""}\u0000${c.id.slice(0, c.id.lastIndexOf("."))}`;
      let who = this.#whoIx.get(wk);
      if (who === undefined) this.#whoIx.set(wk, (who = this.#whoIx.size));
      const entry: Entry = { seq: s, row: c, clips: [], texts: [], hay: "", who, day: d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate() };
      recs.forEach((r, i) => {
        const was = before[i]!, now = this.#read(doc, r.coll, r.id, r.spec, schema);
        const part = r.spec.nounOf?.((now.rec ?? was.rec)!) === null;
        if (!part) {
          const names = [...new Set([now.name, was.name].filter((n): n is string => !!n))];
          const span = now.rec && tl && r.coll === tl.collection && typeof now.rec[tl.start] === "number" && typeof now.rec[tl.end] === "number" ? { start: now.rec[tl.start] as number, end: now.rec[tl.end] as number } : undefined;
          if (names.length) {
            const ws = names.map((n) => this.#words(n));
            entry.clips.push({ key: r.key, names: ws, ...(span ? { span } : {}) });
            // the clip as the cut has it last: its name now, or the one it had when it was deleted, and every name it had
            const was = this.clips.get(r.key);
            const all = was ? (ws.every((w) => was.names.includes(w)) ? was.names : [...ws, ...was.names.filter((w) => !ws.includes(w))]) : ws;
            if (was && all === was.names && all[0] !== ws[0]) all.sort((x, y) => Number(y === ws[0]) - Number(x === ws[0]));
            this.clips.set(r.key, { names: all, seq: s, ...(now.rec ? {} : { deleted: true as const }) });
          }
        }
        // the text it set: what the record holds after it that it didn't before
        const had = new Set(was.words);
        const name = now.name ?? was.name ?? "";
        for (const w of now.words) if (!had.has(w)) entry.texts.push({ key: r.key, name, text: this.#words(w) });
      });
      entry.hay = hayOf([...entry.clips.flatMap((x) => x.names), ...entry.texts.map((x) => x.text)]);
      this.entries.push(entry);
    }
    this.#doc = doc;
    this.#seq = log.length;
    this.#last = log[log.length - 1] ?? null;
  }

  #reset(src: FindSource): void {
    this.entries.length = 0;
    this.clips.clear();
    this.#whoIx.clear();
    this.#wordsOf.clear();
    this.#log = src.log;
    this.#seq = 0;
    this.#last = null;
    const start = src.start();
    this.#doc = start ? E.fork(start, src.schema) : null;
  }

  #read(doc: Doc, coll: string, id: string, spec: Schema["collections"][string], schema: Schema): { rec: Rec | undefined; name: string | undefined; words: readonly string[] } {
    const rec = E.getIn(doc, [coll, id], schema) as Rec | undefined;
    if (!rec) return { rec, name: undefined, words: [] };
    const label = schema.label ? schema.label(coll, rec, doc) : typeof rec.name === "string" ? rec.name : undefined;
    // a name only: never a label made of an id fragment (a clip with no name or media: "video 3f9a1c")
    const name = label && label !== "?" && !label.includes(String(id).slice(0, 6)) ? label : undefined;
    let ws: readonly string[] = [];
    try {
      ws = (spec.words?.(rec) ?? []).filter((w: unknown): w is string => typeof w === "string" && w.trim().length > 0);
    } catch {
      ws = [];
    }
    return { rec, name, words: ws };
  }
}

/** A snippet of at most `max` characters around the first hit of `s`, `…` where it was cut, and the hits inside it. */
export function snippetOf(s: string, hits: readonly [number, number][], max = 80): { snippet: string; hits: [number, number][] } {
  if (s.length <= max || !hits.length) return { snippet: s.length <= max ? s : s.slice(0, max - 1) + "…", hits: s.length <= max ? hits.map((h) => [h[0], h[1]]) : hits.filter((h) => h[1] < max).map((h) => [h[0], h[1]]) };
  const [lo, hi] = hits[0]!;
  const room = Math.max(0, max - (hi - lo));
  let a = Math.max(0, lo - Math.floor(room / 3));
  const b = Math.min(s.length, a + max);
  a = Math.max(0, b - max);
  const pre = a > 0 ? "…" : "", post = b < s.length ? "…" : "";
  const shift = pre.length - a;
  return { snippet: pre + s.slice(a, b) + post, hits: hits.filter((h) => h[0] >= a && h[1] <= b).map((h) => [h[0] + shift, h[1] + shift]) };
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A day in words find knows (local time): "today" or "yesterday", its weekday, its month and day ("oct 30"). */
export function dayWords(at: number, now: number): Words {
  const d = new Date(at), n = new Date(now);
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  const rel = days === 0 ? "today " : days === 1 ? "yesterday " : "";
  return findWords(`${rel}${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`);
}
