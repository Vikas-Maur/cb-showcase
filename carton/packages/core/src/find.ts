// Find (Carton UX v2, N0): search a cut's versions by text, over what people remember of them: a version's name, the
// agent prompt a turn was named from, who made it, the clips it touched (by name, as they were then and after), and
// the title and caption text it set. Outside the history bundle (scripts/size.mjs): History is never asked for more
// than its log and states. The index is built lazily (the first `find`), walked forward once over the cut's rows and
// kept per cut; a later `find` reads only the rows saved since. Nothing here runs on a save or an open.
import type { Actor, ChangeId, PathKey, StateRef } from "./types.ts";

/** What a match matched, best first: a version's own name, a turn's prompt, a clip's name, text it set, a person. */
export type FindField = "name" | "prompt" | "clip" | "text" | "person";
export const FIND_FIELDS: readonly FindField[] = ["name", "prompt", "clip", "text", "person"];

export interface FindOptions {
  /** The cut to search (default: the current cut). */
  cut?: string;
  /** At most this many matches, newest first (default 50, at most 1000). `total` still counts them all. */
  limit?: number;
  /** Only versions before this seq (the next page: the last match's seq). */
  before?: number;
  /** Only these fields (default: all). */
  fields?: readonly FindField[];
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
  /** Where the match is in `snippet` (UTF-16 offsets, [lo, hi)), for highlighting. */
  hit: [number, number];
  /** A clip or text match: the record (`timelineItems/c1`) and its name ("Intro"). */
  record?: PathKey;
  recordName?: string;
}

export interface FindResult {
  /** Newest first, at most `limit`. */
  matches: FindMatch[];
  /** How many versions matched in all (within `before`). */
  total: number;
  /** How many versions were searched. */
  versions: number;
}
