// The overlap test of §6.1, the same for the local SQLite sequencer and every host.
//
// Two changes overlap if any of these holds:
// - a path of one is a segment-prefix of a path of the other, in either direction (R1-02);
// - one's reads meet a write at or above the read record in the other's paths (a write to one of the record's
//   fields leaves its existence alone, so two style edits of one clip still take the lww path: Finding 9);
// - they have half-open spans on one track that intersect, and at least one of the two is structural (an insert,
//   a remove, a track change or a remap). Two plain trims of different clips never overlap by span alone;
// - both touch the same field group of one record (`items/X/#time` is a path, so the first rule catches it);
// - both reorder the same track (`#trackOrder/<track>` is folded into the paths, so the first rule catches it).
//
// The incoming change is indexed once per push (every path, every segment-prefix), so the test against each row of
// the tail is a handful of set lookups, as in the P5 sequencer (proofs/do-seq/src/seq-core.mjs).

import type { Declaration, Span } from "../types.ts";
import type { Keying, TailRow } from "./types.ts";

export const NONE = 0;
/** The only overlaps are identical leaf paths: the lww path may accept it (§6.1 outcome 2). */
export const LEAF = 1;
export const STRUCTURE = 2;
export type OverlapKind = typeof NONE | typeof LEAF | typeof STRUCTURE;

const HASH = 35; // "#"

/** Escape one path segment the way the engine's `pathKey` does: `~` → `~0`, `/` → `~1`. */
export const escapeSegment = (s: string): string =>
  s.includes("/") || s.includes("~") ? s.replaceAll("~", "~0").replaceAll("/", "~1") : s;

/** The path key of a track's position, folded into a change's paths so a reorder clash is a path clash. */
export const trackOrderPath = (track: string): string => `#trackOrder/${escapeSegment(track)}`;

/** True for a path with a `#…` segment: a group path (`items/X/#time`), a position (`tracks/T/#pos`) or a reorder. */
export function hasGroupSegment(p: string): boolean {
  if (p.charCodeAt(0) === HASH) return true;
  for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) if (p.charCodeAt(i + 1) === HASH) return true;
  return false;
}

/** A leaf: at least three segments (collection, record, field…) and no `#…` segment. Group paths are structure. */
export function isLeafPath(p: string): boolean {
  if (hasGroupSegment(p)) return false;
  const first = p.indexOf("/");
  return first > 0 && p.indexOf("/", first + 1) > first + 1;
}

/** A field-group path, `coll/id/#name` (but not `#pos`): what the non-v3 keyings leave out. */
function isFieldGroupPath(p: string): boolean {
  const a = p.indexOf("/");
  if (a <= 0) return false;
  const b = p.indexOf("/", a + 1);
  return b > a && p.charCodeAt(b + 1) === HASH && p.indexOf("/", b + 1) < 0 && p.slice(b + 1) !== "#pos";
}

function forEachStrictPrefix(p: string, fn: (prefix: string) => void): void {
  for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) fn(p.slice(0, i));
}

function someStrictPrefix(p: string, set: ReadonlySet<string>): boolean {
  for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) if (set.has(p.slice(0, i))) return true;
  return false;
}

/** The incoming change, indexed for the tail scan. */
export interface ChangeIndex {
  keying: Keying;
  exact: ReadonlySet<string>;
  /** Strict segment-prefixes of the change's own paths. */
  prefixes: Set<string>;
  /** The change's reads and every segment-prefix of them: a path in here is at or above one of its reads. */
  readsAtOrAbove: Set<string>;
  spans: Map<string, number[]>;
  structural: boolean;
}

/** Folds `trackOrder` into the paths. Rows are stored this way, so both sides of the test look alike. */
export function storedPaths(d: Pick<Declaration, "paths" | "trackOrder">): string[] {
  if (!d.trackOrder.length) return [...d.paths];
  const out = [...d.paths];
  for (const t of d.trackOrder) out.push(trackOrderPath(t));
  return out;
}

/** Whether a path takes part in the test under a keying (group paths are v3's; reorders are not per-item's). */
function counts(p: string, keying: Keying): boolean {
  if (keying === "v3-spans") return true;
  if (keying === "per-item" && p.startsWith("#trackOrder/")) return false;
  return !isFieldGroupPath(p);
}

export function indexChange(d: Pick<Declaration, "paths" | "reads" | "spans" | "trackOrder">, structural: boolean, keying: Keying = "v3-spans", pathSet?: ReadonlySet<string>): ChangeIndex {
  const prefixes = new Set<string>(), readsAtOrAbove = new Set<string>();
  // the plan's keying counts every path: reuse the caller's set of the change's paths when it has one
  const reuse = keying === "v3-spans" && pathSet !== undefined && !d.trackOrder.length;
  const own = reuse ? null : new Set<string>();
  const exact: ReadonlySet<string> = reuse ? pathSet! : own!;
  for (const p of reuse ? d.paths : storedPaths(d)) {
    if (own) {
      if (!counts(p, keying)) continue;
      own.add(p);
    }
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) prefixes.add(p.slice(0, i));
  }
  for (const r of d.reads) {
    readsAtOrAbove.add(r);
    forEachStrictPrefix(r, (q) => readsAtOrAbove.add(q));
  }
  const spans = new Map<string, number[]>();
  if (keying !== "per-item") {
    for (const s of d.spans) {
      let a = spans.get(s.track);
      if (!a) spans.set(s.track, (a = []));
      a.push(s.lo, s.hi ?? Infinity); // null: a remap's open end
    }
  }
  return { keying, exact, prefixes, readsAtOrAbove, spans, structural };
}

function spansMeet(me: ChangeIndex, spans: readonly Span[], otherStructural: boolean): boolean {
  if (!me.spans.size) return false;
  const k = me.keying;
  if (k === "per-item") return false;
  if (k === "v3-spans" && !me.structural && !otherStructural) return false;
  for (const s of spans) {
    const a = me.spans.get(s.track);
    if (!a) continue;
    if (k === "v2-layout") return true;
    // half-open: [lo, hi) intervals that only touch don't intersect (P5 finding 5)
    const hi = s.hi ?? Infinity;
    for (let i = 0; i < a.length; i += 2) if (a[i]! < hi && s.lo < a[i + 1]!) return true;
  }
  return false;
}

/**
 * How the indexed incoming change overlaps one confirmed row: `NONE`, `LEAF` (only identical leaf paths, which lww
 * may overwrite), or `STRUCTURE`.
 */
export function overlapKind(me: ChangeIndex, row: Pick<TailRow, "paths" | "reads" | "spans" | "structural">): OverlapKind {
  let kind: OverlapKind = NONE;
  for (const q of row.paths) {
    if (me.keying !== "v3-spans" && !counts(q, me.keying)) continue;
    if (me.exact.has(q)) {
      if (!isLeafPath(q)) return STRUCTURE;
      kind = LEAF;
    }
    if (me.prefixes.has(q)) return STRUCTURE; // q is above one of our paths
    if (someStrictPrefix(q, me.exact)) return STRUCTURE; // one of our paths is above q
    if (me.readsAtOrAbove.has(q)) return STRUCTURE; // q writes at or above a record we read
  }
  for (const r of row.reads) {
    if (me.exact.has(r) || someStrictPrefix(r, me.exact)) return STRUCTURE; // we write at or above its read
  }
  if (spansMeet(me, row.spans, row.structural)) return STRUCTURE;
  return kind;
}
