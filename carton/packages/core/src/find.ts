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

/** A string kept with its folded form (folded once, at index time). */
type Words = readonly [text: string, folded: string];
const words = (s: string): Words => {
  const one = s.replace(/\s+/g, " ").trim();
  return [one, foldText(one)];
};

interface Entry {
  seq: number;
  row: ConfirmedChange;
  /** The clips it touched, each by every name it had (before and after the version). */
  clips: { key: PathKey; names: Words[] }[];
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

  /** Index the rows saved since the last call; start again when the cut's log was rebuilt (a compaction, a reload). */
  update(src: FindSource): void {
    const { log, schema } = src;
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
      const entry: Entry = { seq: s, row: c, clips: [], texts: [] };
      recs.forEach((r, i) => {
        const was = before[i]!, now = this.#read(doc, r.coll, r.id, r.spec, schema);
        const part = r.spec.nounOf?.((now.rec ?? was.rec)!) === null;
        if (!part) {
          const names = [...new Set([was.name, now.name].filter((n): n is string => !!n))];
          if (names.length) entry.clips.push({ key: r.key, names: names.map(words) });
        }
        // the text it set: what the record holds after it that it didn't before
        const had = new Set(was.words);
        const name = now.name ?? was.name ?? "";
        for (const w of now.words) if (!had.has(w)) entry.texts.push({ key: r.key, name, text: words(w) });
      });
      this.entries.push(entry);
    }
    this.#doc = doc;
    this.#seq = log.length;
    this.#last = log[log.length - 1] ?? null;
  }

  #reset(src: FindSource): void {
    this.entries.length = 0;
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

/** A snippet of at most `max` characters around [lo, hi) of `s`, `…` where it was cut, and the hit inside it. */
export function snippetOf(s: string, lo: number, hi: number, max = 80): { snippet: string; hit: [number, number] } {
  const one = s;
  if (one.length <= max) return { snippet: one, hit: [lo, hi] };
  const room = Math.max(0, max - (hi - lo));
  let a = Math.max(0, lo - Math.floor(room / 2));
  const b = Math.min(one.length, a + max);
  a = Math.max(0, b - max);
  const pre = a > 0 ? "…" : "", post = b < one.length ? "…" : "";
  return { snippet: pre + one.slice(a, b) + post, hit: [lo - a + pre.length, hi - a + pre.length] };
}

/** Where `q` (folded) is in `w`: offsets in its text (the folded form when folding changed its length: then none). */
export function hitIn(w: Words, q: string): [number, number] | null {
  const i = w[1].indexOf(q);
  if (i < 0) return null;
  return w[0].length === w[1].length ? [i, i + q.length] : [0, 0];
}
export { words as findWords };
