// One push, judged (§6.1, §6.3). The rule is pure: it reads the branch through a `SequencerView` (the tail since the
// change's base and record existence) and returns a verdict; the caller writes the row. The local SQLite sequencer
// and `@carton/server` both call it, so a branch is ordered by the same rule wherever its sequencer lives.
//
// Order of the checks, and why:
// 1. shape, then the base: a base past head is unknown; a base more than K behind is rejected at once ("behind",
//    the K cap of §6.3), before any scan of the log.
// 2. dedup by id in the tail since the base, with no global id index (§6.3 DDL): a confirmed id is acked as a
//    duplicate whatever its hash; a withdrawn id is acked as withdrawn (H1).
// 3. the base must be reconstructable: every pending id it builds on is in that tail.
// 4. lww is only for leaf edits: a span or a group path makes it structure, so the change must go through merge3
//    (R11-01). Clients send such changes as `merge` (H2); this guards against bad clients.
// 5. the overlap test against every concurrent row (§6.1).
// 6. every op is covered by a declared path (otherwise a writer could hide a write from the overlap test). It runs
//    after the overlap test so a push rejected anyway doesn't pay a pass over its ops; an accepted change passes both.
// 7. the span check, after the overlap test (H4): a concurrent move or remove of the clip is an overlap, so the
//    change is rejected and rebased, never dropped as "span missing". Once no concurrent row touched the clip, its
//    track at head is its track at the change's base.
// 8. existence: no insert of a live id; an item's track must exist.

import { indexChange, NONE, overlapKind, hasGroupSegment, STRUCTURE, escapeSegment } from "./overlap.ts";
import type { TimelineConfig } from "../schema.ts";
import type { Op, Span } from "../types.ts";
import type { RejectReason } from "../sync/messages.ts";
import type { Pushed, RecordState, TailRow } from "./types.ts";
import type { OverlapKind } from "./overlap.ts";

/** The read side of a branch, as the rule needs it. */
export interface SequencerView {
  head(): number;
  /** Confirmed rows with seq in `(after, head]`, in order. At most K rows are ever asked for. */
  tail(after: number): Iterable<TailRow>;
  /** A record's newest state at head on this branch, following the fork chain (§6.3). */
  record(coll: string, id: string): RecordState | undefined;
  /** Optional batch form of `record` (one query for a 200-item remap instead of 200). */
  records?(coll: string, ids: readonly string[]): Map<string, RecordState | undefined>;
}

export interface RulesConfig {
  /** null: the schema has no timeline, so there are no spans, tracks or timing fields to check (paths and reads are). */
  timeline: TimelineConfig | null;
  /** K: how far behind head a base may be (§6.3). */
  maxBehind?: number;
  /**
   * The field group a field belongs to, if any (`"time"` for the time group). A change that sets a grouped field
   * must declare the group path `coll/id/#group`. Defaults to the timeline's time group.
   */
  groupOf?: (coll: string, field: string) => string | undefined;
  /**
   * Another overlap test in place of the plan's (§6.1). Only the P9 comparisons and the conformance controls inject one
   * (`@carton/conformance` rule-variants), so the shipped bundle carries the plan's rule alone.
   */
  overlap?: OverlapRule;
  /** Controls for the conformance suite's negative tests only. Never set them in a host. */
  controls?: RuleControls;
}

/** An overlap test: index the incoming change once, then classify each concurrent row. */
export interface OverlapRule {
  index(d: Pick<Pushed, "paths" | "reads" | "spans" | "trackOrder">, structural: boolean): unknown;
  kind(index: unknown, row: Pick<TailRow, "paths" | "reads" | "spans" | "structural">): OverlapKind;
}

export interface RuleControls {
  /** false: skip the span check (a control). */
  spanCheck?: boolean;
  /** false: skip the "lww on structure" guard (R11-01 control). */
  lwwCheck?: boolean;
  /** true: spans don't stop an lww accept, as before v12 (the R11-01 control, with its overlap rule). */
  lwwWithSpans?: boolean;
}

/** A row to append to `records` when the change is confirmed: an insert, a remove, or a timeline item's new track. */
export interface RecordWrite {
  coll: string;
  id: string;
  alive: boolean;
  lane?: string;
}

export type Verdict =
  | { kind: "accept"; lww: boolean; overwrote: TailRow[]; records: RecordWrite[]; structural: boolean }
  | { kind: "duplicate"; seq: number; withdrawn: boolean }
  | { kind: "reject"; reason: RejectReason; detail?: string };

export const DEFAULT_MAX_BEHIND = 100;

/**
 * Stands in for a missing timeline: collection names no schema can have (a NUL byte), so every span, track and
 * timing check finds nothing to check and the rest of the rule runs unchanged (foundation review finding 15).
 */
export const NO_TIMELINE: TimelineConfig = { collection: "\u0000items", lanes: "\u0000lanes", lane: "\u0000lane", start: "\u0000s", end: "\u0000e", source: "\u0000ts", sourceEnd: "\u0000te", speed: "\u0000v" };
const EPS = 1e-9;

export const pathKeyOf = (path: readonly (string | number)[]): string => path.map((s) => escapeSegment(String(s))).join("/");

/** Fields that change an item's placement or timing: an op on one of them must carry a span (§6.3). */
export function timingFields(tl: TimelineConfig): Set<string> {
  return new Set([tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed, tl.lane]);
}

/** The time group of the timeline collection (§4.1): `{start, end, source, sourceEnd, speed}`. */
export function timeGroupOf(tl: TimelineConfig | null): (coll: string, field: string) => string | undefined {
  if (!tl) return () => undefined;
  const fields = new Set([tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed]);
  return (coll, field) => (coll === tl.collection && fields.has(field) ? "time" : undefined);
}

const hasMaps = (intent: unknown): boolean => {
  const maps = (intent as { maps?: Record<string, unknown> } | null | undefined)?.maps;
  return !!maps && typeof maps === "object" && Object.keys(maps).length > 0;
};

/**
 * Structural, computed by the sequencer from the change itself, never trusted from the client: an item insert or
 * remove, a track change, or a remap (an intent with maps, or a first-class `remap` op).
 */
export function isStructural(ops: readonly Op[], intent: unknown, timeline: TimelineConfig | null): boolean {
  const tl = timeline ?? NO_TIMELINE;
  if (hasMaps(intent)) return true;
  for (const op of ops) {
    if (op.op === "remap") return true;
    if (op.path[0] !== tl.collection) continue;
    if (op.path.length === 2 || (op.path.length === 3 && op.path[2] === tl.lane && op.op === "set")) return true;
  }
  return false;
}

function shapeError(ch: Pushed): string | null {
  if (!ch || typeof ch !== "object") return "not an object";
  if (typeof ch.id !== "string" || ch.id.lastIndexOf(".") < 1) return "bad id";
  if (!ch.base || !Number.isInteger(ch.base.seq) || ch.base.seq < 0 || !Array.isArray(ch.base.pending)) return "bad base";
  if (ch.policy !== "merge" && ch.policy !== "lww") return "bad policy";
  if (!Array.isArray(ch.ops)) return "ops not an array";
  for (const k of ["paths", "reads", "trackOrder"] as const) {
    const a = ch[k];
    if (!Array.isArray(a)) return `${k} not an array`;
    for (const p of a) if (typeof p !== "string" || !p) return `bad ${k} entry`;
  }
  if (!Array.isArray(ch.spans)) return "spans not an array";
  for (const s of ch.spans) {
    if (!s || typeof s.track !== "string" || typeof s.lo !== "number" || !(s.hi === null || (typeof s.hi === "number" && s.hi >= s.lo))) return "bad span";
  }
  for (const op of ch.ops) {
    if (!op || typeof op.op !== "string" || !Array.isArray(op.path) || op.path.length < 1) return "bad op";
  }
  return null;
}

/**
 * What the sequencer can check of a change without holding the document (§6.3; review findings 8 and 9):
 * - a timeline record is replaced only by remove + insert, never by a record-level set or unset (the engine never
 *   emits one; it would bypass the span check and the records history);
 * - an inserted item is a valid clip (finite times, start ≥ 0, end > start, trimEnd > trimStart when both are set);
 * - a change that sets both edges of an item (or both trims) keeps them in order.
 * Invariants that need the record's other fields (an end moved alone below the start) are the clients' merge and the
 * local sequencer's to enforce, as the plan has it: the server keeps no document state.
 */
function invalidValues(ch: Pushed, tl: TimelineConfig): string | null {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const edges = new Map<string, Record<string, unknown>>();
  for (const op of ch.ops) {
    const coll = op.path[0];
    if ((coll === tl.collection || coll === tl.lanes) && op.path.length === 2 && (op.op === "set" || op.op === "unset")) return `${coll}/${String(op.path[1])}: replace a record by remove and insert`;
    if (coll !== tl.collection) continue;
    if (op.path.length === 2 && op.op === "insert") {
      const v = op.value as Record<string, unknown> | undefined;
      if (!v || typeof v !== "object") return `${coll}/${String(op.path[1])}: not a record`;
      const s0 = v[tl.start], e0 = v[tl.end];
      if (!num(s0) || !num(e0) || (s0 as number) < 0 || !((e0 as number) > (s0 as number))) return `${coll}/${String(op.path[1])}: bad times`;
      const ts = v[tl.source], te = v[tl.sourceEnd];
      if (ts !== undefined && te !== undefined && !(num(ts) && num(te) && (te as number) > (ts as number))) return `${coll}/${String(op.path[1])}: bad trims`;
      if (typeof v[tl.lane] !== "string") return `${coll}/${String(op.path[1])}: no track`;
    } else if (op.path.length === 3 && op.op === "set") {
      const f = String(op.path[2]);
      if (f === tl.start || f === tl.end || f === tl.source || f === tl.sourceEnd) {
        if (!num(op.value)) return `${coll}/${String(op.path[1])}/${f}: not a number`;
        const id = String(op.path[1]);
        (edges.get(id) ?? edges.set(id, {}).get(id)!)[f] = op.value;
      }
    }
  }
  for (const [id, e] of edges) {
    if (e[tl.start] !== undefined && e[tl.end] !== undefined && !((e[tl.end] as number) > (e[tl.start] as number))) return `${tl.collection}/${id}: end before start`;
    if (e[tl.source] !== undefined && e[tl.sourceEnd] !== undefined && !((e[tl.sourceEnd] as number) > (e[tl.source] as number))) return `${tl.collection}/${id}: trim end before trim start`;
  }
  return null;
}

/**
 * Every op is covered by a declared path, a grouped field declares its group path, a reorder its track, and the
 * existence reads the overlap test relies on are declared: the record a field write is under, and the track an item is
 * placed on or moved to (review finding 7: otherwise omitting a read hides a concurrent delete).
 */
function undeclared(ch: Pushed, tl: TimelineConfig, groupOf: (coll: string, field: string) => string | undefined, declared: ReadonlySet<string>): string | null {
  const order = new Set(ch.trackOrder);
  const reads = new Set(ch.reads);
  const lanePath = (lane: unknown) => `${escapeSegment(tl.lanes)}/${escapeSegment(String(lane))}`;
  for (const op of ch.ops) {
    if (op.op === "remap") continue; // a remap's surface is its span, checked below
    const p = pathKeyOf(op.path);
    let covered = declared.has(p);
    for (let i = p.lastIndexOf("/"); !covered && i > 0; i = p.lastIndexOf("/", i - 1)) covered = declared.has(p.slice(0, i));
    if (!covered) return p;
    if (op.path.length >= 3) {
      const coll = String(op.path[0]), field = String(op.path[2]);
      const g = groupOf(coll, field);
      if (g !== undefined) {
        // the record's own key is the op's key up to its second separator: no re-escaping per op
        const rec = p.slice(0, p.indexOf("/", p.indexOf("/") + 1));
        if (!declared.has(`${rec}/#${g}`)) return `${p} (group #${g})`;
      }
      if (coll === tl.lanes && field === "#pos" && !order.has(String(op.path[1]))) return `${p} (track order)`;
      if (coll === tl.collection || coll === tl.lanes) {
        const rec = p.slice(0, p.indexOf("/", p.indexOf("/") + 1));
        if (!reads.has(rec)) return `${p} (read of ${rec})`;
        if (coll === tl.collection && field === tl.lane && op.op === "set" && !reads.has(lanePath(op.value))) return `${p} (read of its track)`;
      }
    } else if (op.path.length === 2 && op.op === "insert" && op.path[0] === tl.collection) {
      const lane = (op.value as Record<string, unknown> | undefined)?.[tl.lane];
      if (!reads.has(lanePath(lane))) return `${p} (read of its track)`;
    }
  }
  return null;
}

/**
 * §6.3: a timing op must carry a span on its track that contains its new edges. The track is the item's track at
 * the change's base; the overlap test has already rejected any concurrent change to it (H4), so the newest records
 * row at head is that track.
 */
export function spansCover(view: SequencerView, ch: Pushed, timeline: TimelineConfig | null): boolean {
  const tl = timeline ?? NO_TIMELINE;
  const spans: readonly Span[] = ch.spans;
  const hiOf = (s: Span) => s.hi ?? Infinity;
  const on = (track: string | undefined, x?: number) =>
    track !== undefined && spans.some((s) => s.track === track && (x === undefined || (s.lo <= x + EPS && x <= hiOf(s) + EPS)));
  const timing = timingFields(tl);
  const moved = new Map<string, string>(); // item -> the track this change moves it to
  const inserted = new Map<string, string>(); // item -> its track, for items this change inserts
  for (const op of ch.ops) {
    if (op.path[0] !== tl.collection) continue;
    if (op.path.length === 3 && op.path[2] === tl.lane && op.op === "set") moved.set(String(op.path[1]), String(op.value));
    if (op.path.length === 2 && op.op === "insert") inserted.set(String(op.path[1]), String((op.value as Record<string, unknown>)?.[tl.lane]));
  }
  // one records lookup per item, however many of its fields the change sets (a 200-item remap sets 400), and one
  // query for all of them when the view can batch
  let seen = new Map<string, ReturnType<SequencerView["record"]>>();
  if (view.records) {
    const ids = new Set<string>();
    for (const op of ch.ops) if (op.path[0] === tl.collection && op.path.length >= 2 && !inserted.has(String(op.path[1]))) ids.add(String(op.path[1]));
    if (ids.size > 1) seen = view.records(tl.collection, [...ids]);
  }
  const recordOf = (id: string) => {
    if (!seen.has(id)) seen.set(id, view.record(tl.collection, id));
    return seen.get(id);
  };
  const trackOf = (id: string): string | undefined => {
    const r = recordOf(id);
    return r?.alive ? r.lane : inserted.get(id);
  };
  for (const op of ch.ops) {
    if (op.op === "remap") {
      // a remap shifts everything from t0 on: its span is [t0, ∞) on each track it maps (§6.1)
      for (const t of Object.keys(op.maps ?? {})) if (!spans.some((s) => s.track === t && s.hi === null)) return false;
      continue;
    }
    if (op.path[0] !== tl.collection) continue;
    const id = String(op.path[1]);
    if (op.path.length === 2) {
      if (op.op === "insert") {
        const v = (op.value ?? {}) as Record<string, unknown>;
        const lane = String(v[tl.lane]), s0 = Number(v[tl.start]), e0 = Number(v[tl.end]);
        if (!spans.some((s) => s.track === lane && s.lo <= s0 + EPS && e0 <= hiOf(s) + EPS)) return false;
      } else if (op.op === "remove") {
        const r = recordOf(id);
        if (r?.alive && !on(r.lane)) return false; // removing an absent record is a no-op (§4.4)
      }
      continue;
    }
    if (op.path.length !== 3 || !timing.has(String(op.path[2]))) continue;
    const oldT = trackOf(id), newT = moved.get(id) ?? oldT;
    if (op.path[2] === tl.lane) {
      if (!on(oldT) || !on(newT)) return false;
      continue;
    }
    const edge = (op.path[2] === tl.start || op.path[2] === tl.end) && op.op === "set" ? Number(op.value) : undefined;
    if (!on(newT, edge)) return false; // trims, speed and unsets still need a span on the track
  }
  return true;
}

/** Judge one push against a branch. Pure: the caller appends the row and the record writes on "accept". */
export function evaluatePush(view: SequencerView, ch: Pushed, cfg: RulesConfig): Verdict {
  const tl = cfg.timeline ?? NO_TIMELINE;
  const K = cfg.maxBehind ?? DEFAULT_MAX_BEHIND;
  const controls = cfg.controls ?? {};
  const bad = shapeError(ch);
  if (bad) return { kind: "reject", reason: "bad change", detail: bad };
  const head = view.head();
  if (ch.base.seq > head) return { kind: "reject", reason: "base unknown", detail: `base ${ch.base.seq} > head ${head}` };
  if (head - ch.base.seq > K) return { kind: "reject", reason: "behind" };

  // One read of the tail since the base (≤ K rows) serves dedup, the causal-past check and the overlap test.
  const tail: TailRow[] = [];
  for (const row of view.tail(ch.base.seq)) {
    if (row.id === ch.id) return { kind: "duplicate", seq: row.seq, withdrawn: row.withdrawn };
    tail.push(row);
  }
  const past = new Set(ch.base.pending);
  if (past.size) {
    let found = 0;
    for (const row of tail) if (past.has(row.id)) found++;
    if (found !== past.size) return { kind: "reject", reason: "base unknown", detail: "a pending id it builds on isn't confirmed" };
  }
  // a fold whose result equals its first parent has no ops but is still a DAG node (its merge edge must be recorded,
  // or a later fold of the same cut finds an older base); an undo whose effect is already at the head still marks its
  // change undone. Any other empty change is refused.
  if (!ch.ops.length && !ch.mergeOf && !ch.reverts) return { kind: "reject", reason: "no ops" };
  if (ch.policy === "lww" && controls.lwwCheck !== false && (ch.spans.length > 0 || ch.trackOrder.length > 0 || ch.paths.some(hasGroupSegment)))
    return { kind: "reject", reason: "lww on structure" };
  const declared = new Set(ch.paths); // built once: the overlap index and the declaration check share it

  const structural = isStructural(ch.ops, ch.intent, tl);
  const overwrote: TailRow[] = [];
  let any = false, blocking = false;
  if (tail.length) {
    const rule = cfg.overlap;
    const me = rule ? rule.index(ch, structural) : indexChange(ch, structural, declared);
    for (const row of tail) {
      if (row.withdrawn || past.has(row.id)) continue;
      const k = rule ? rule.kind(me, row) : overlapKind(me as ReturnType<typeof indexChange>, row);
      if (k === NONE) continue;
      any = true;
      if (k === STRUCTURE) blocking = true;
      overwrote.push(row);
    }
  }
  let lww = false;
  if (any) {
    if (ch.policy === "lww" && !blocking && (controls.lwwWithSpans || ch.spans.length === 0)) lww = true;
    else return { kind: "reject", reason: "overlap" };
  }

  // after the overlap test, so a push that will be rejected anyway doesn't pay a pass over every op; an accepted
  // change has passed both (an undeclared write can't hide from the overlap test and still be confirmed)
  const missing = undeclared(ch, tl, cfg.groupOf ?? timeGroupOf(tl), declared);
  if (missing) return { kind: "reject", reason: "undeclared path", detail: missing };
  const invalid = invalidValues(ch, tl);
  if (invalid) return { kind: "reject", reason: "invalid", detail: invalid };
  if (controls.spanCheck !== false && !spansCover(view, ch, tl)) return { kind: "reject", reason: "span missing" };

  // existence: no insert of a live id; the track an item is placed on must exist (or be inserted by this change)
  const records = new Map<string, RecordWrite>();
  const liveNow = (coll: string, id: string): boolean => {
    const w = records.get(`${coll}\u0000${id}`);
    return w ? w.alive : view.record(coll, id)?.alive === true;
  };
  for (const op of ch.ops) {
    if (op.path.length !== 2 || (op.op !== "insert" && op.op !== "remove")) continue;
    const coll = String(op.path[0]), id = String(op.path[1]);
    if (op.op === "insert") {
      if (liveNow(coll, id)) return { kind: "reject", reason: "exists", detail: `${coll}/${id}` };
      const lane = coll === tl.collection ? String((op.value as Record<string, unknown>)?.[tl.lane]) : undefined;
      records.set(`${coll}\u0000${id}`, lane === undefined ? { coll, id, alive: true } : { coll, id, alive: true, lane });
    } else if (liveNow(coll, id)) {
      records.set(`${coll}\u0000${id}`, { coll, id, alive: false });
    }
  }
  for (const op of ch.ops) {
    if (op.path[0] !== tl.collection || op.path.length !== 3 || op.path[2] !== tl.lane || op.op !== "set") continue;
    const id = String(op.path[1]);
    if (liveNow(tl.collection, id)) records.set(`${tl.collection}\u0000${id}`, { coll: tl.collection, id, alive: true, lane: String(op.value) });
  }
  const lanePrefix = `${escapeSegment(tl.lanes)}/`;
  for (const r of ch.reads) {
    if (!r.startsWith(lanePrefix) || r.indexOf("/", lanePrefix.length) >= 0) continue;
    if (!liveNow(tl.lanes, unescape(r.slice(lanePrefix.length)))) return { kind: "reject", reason: "read of a missing record", detail: r };
  }
  return { kind: "accept", lww, overwrote, records: [...records.values()], structural };
}

const unescape = (s: string): string => (s.includes("~") ? s.replaceAll("~1", "/").replaceAll("~0", "~") : s);
