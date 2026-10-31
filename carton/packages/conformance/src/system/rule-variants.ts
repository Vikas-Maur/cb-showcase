// Overlap rules other than the plan's, for the P9 comparisons and the conformance controls only. They are injected
// into the sequencer (`createSequencer({ controls: { overlap } })`, `RulesConfig.overlap`), so the shipped core carries
// only the plan's v3 rule (§6.1). Ported from system-v11 `server.mjs`'s keyings:
// - "v3-spans-v10": v10's rule: any two intersecting spans conflict, and there are no field-group paths;
// - "v2-layout": v2's per-track key: any two span-bearing changes on one track conflict;
// - "per-item": leaf paths and reads only, no spans, no group paths, no track order (the critic's baseline);
// and the pre-v12 lww classifier (`groupIsLeafRule`): an identical `#time` group path counts as a leaf and spans are
// ignored, which with `lwwCheck: false, lwwWithSpans: true` lets crossing lww trims both through (the R11-01 control).

import { sequencer as rules, type Declaration, type Span } from "@carton/core";

/** "v3-spans" is the plan's rule (the default, built into core); the others are comparisons. */
export type Keying = "v3-spans" | "v3-spans-v10" | "v2-layout" | "per-item";

const { NONE, LEAF, STRUCTURE, storedPaths, isLeafPath, hasGroupSegment } = rules;
type Row = Pick<rules.TailRow, "paths" | "reads" | "spans" | "structural">;

/** A field-group path, `coll/id/#name` (but not `#pos`): what the non-v3 keyings leave out. */
function isFieldGroupPath(p: string): boolean {
  const a = p.indexOf("/");
  if (a <= 0) return false;
  const b = p.indexOf("/", a + 1);
  return b > a && p.charCodeAt(b + 1) === 35 && p.indexOf("/", b + 1) < 0 && p.slice(b + 1) !== "#pos";
}
/** Whether a path takes part in the test under a keying (reorders are not per-item's). */
function counts(p: string, keying: Keying): boolean {
  if (keying === "v3-spans") return true;
  if (keying === "per-item" && p.startsWith("#trackOrder/")) return false;
  return !isFieldGroupPath(p);
}
function someStrictPrefix(p: string, set: ReadonlySet<string>): boolean {
  for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) if (set.has(p.slice(0, i))) return true;
  return false;
}

interface Index {
  keying: Keying;
  exact: Set<string>;
  prefixes: Set<string>;
  readsAtOrAbove: Set<string>;
  spans: Map<string, number[]>;
  structural: boolean;
}

function index(d: Pick<Declaration, "paths" | "reads" | "spans" | "trackOrder">, structural: boolean, keying: Keying): Index {
  const exact = new Set<string>(), prefixes = new Set<string>(), readsAtOrAbove = new Set<string>();
  for (const p of storedPaths(d)) {
    if (!counts(p, keying)) continue;
    exact.add(p);
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) prefixes.add(p.slice(0, i));
  }
  for (const r of d.reads) {
    readsAtOrAbove.add(r);
    for (let i = r.indexOf("/"); i > 0; i = r.indexOf("/", i + 1)) readsAtOrAbove.add(r.slice(0, i));
  }
  const spans = new Map<string, number[]>();
  if (keying !== "per-item")
    for (const s of d.spans) {
      let a = spans.get(s.track);
      if (!a) spans.set(s.track, (a = []));
      a.push(s.lo, s.hi ?? Infinity);
    }
  return { keying, exact, prefixes, readsAtOrAbove, spans, structural };
}

function spansMeet(me: Index, spans: readonly Span[], otherStructural: boolean): boolean {
  if (!me.spans.size || me.keying === "per-item") return false;
  if (me.keying === "v3-spans" && !me.structural && !otherStructural) return false;
  for (const s of spans) {
    const a = me.spans.get(s.track);
    if (!a) continue;
    if (me.keying === "v2-layout") return true;
    const hi = s.hi ?? Infinity;
    for (let i = 0; i < a.length; i += 2) if (a[i]! < hi && s.lo < a[i + 1]!) return true;
  }
  return false;
}

function kind(me: Index, row: Row, { groupIsLeaf = false, ignoreSpans = false } = {}): rules.OverlapKind {
  let k: rules.OverlapKind = NONE;
  for (const q of row.paths) {
    if (!counts(q, me.keying)) continue;
    if (me.exact.has(q)) {
      if (!(isLeafPath(q) || (groupIsLeaf && hasGroupSegment(q) && !q.startsWith("#")))) return STRUCTURE;
      k = LEAF;
    }
    if (me.prefixes.has(q)) return STRUCTURE;
    if (someStrictPrefix(q, me.exact)) return STRUCTURE;
    if (me.readsAtOrAbove.has(q)) return STRUCTURE;
  }
  for (const r of row.reads) if (me.exact.has(r) || someStrictPrefix(r, me.exact)) return STRUCTURE;
  if (!ignoreSpans && spansMeet(me, row.spans, row.structural)) return STRUCTURE;
  return k;
}

/** The overlap rule of a P9 comparison keying (undefined for "v3-spans": the core's own rule). */
export function keyingRule(keying: Keying): rules.OverlapRule | undefined {
  if (keying === "v3-spans") return undefined;
  return {
    index: (d, structural) => index(d, structural, keying),
    kind: (me, row) => kind(me as Index, row),
  };
}

/**
 * The pre-v12 classifier (P5's): any 3+-segment path, `#time` included, was a leaf, and spans weren't looked at for
 * lww. Use with `controls: { lwwCheck: false, lwwWithSpans: true }` (the R11-01 control: an invalid clip confirmed).
 */
export const groupIsLeafRule: rules.OverlapRule = {
  index: (d, structural) => index(d, structural, "v3-spans"),
  kind: (me, row) => kind(me as Index, row, { groupIsLeaf: true, ignoreSpans: true }),
};
