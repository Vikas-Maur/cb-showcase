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
// 5. every op is covered by a declared path (otherwise a writer could hide a write from the overlap test).
// 6. the overlap test against every concurrent row (§6.1).
// 7. the span check, after the overlap test (H4): a concurrent move or remove of the clip is an overlap, so the
//    change is rejected and rebased, never dropped as "span missing". Once no concurrent row touched the clip, its
//    track at head is its track at the change's base.
// 8. existence: no insert of a live id; an item's track must exist.

import { indexChange, LEAF, NONE, overlapKind, hasGroupSegment, STRUCTURE, escapeSegment } from "./overlap.ts";
import type { TimelineConfig } from "../schema.ts";
import type { Op, Span } from "../types.ts";
import type { RejectReason } from "../sync/messages.ts";
import type { Keying, Pushed, RecordState, TailRow } from "./types.ts";

/** The read side of a branch, as the rule needs it. */
export interface SequencerView {
  head(): number;
  /** Confirmed rows with seq in `(after, head]`, in order. At most K rows are ever asked for. */
  tail(after: number): Iterable<TailRow>;
  /** A record's newest state at head on this branch, following the fork chain (§6.3). */
  record(coll: string, id: string): RecordState | undefined;
}

export interface RulesConfig {
  timeline: TimelineConfig;
  /** K: how far behind head a base may be (§6.3). */
  maxBehind?: number;
  keying?: Keying;
  /**
   * The field group a field belongs to, if any (`"time"` for the time group). A change that sets a grouped field
   * must declare the group path `coll/id/#group`. Defaults to the timeline's time group.
   */
  groupOf?: (coll: string, field: string) => string | undefined;
  /** Controls for the conformance suite's negative tests only. Never set them in a host. */
  controls?: RuleControls;
}

export interface RuleControls {
  /** false: skip the span check (a control). */
  spanCheck?: boolean;
  /** false: skip the "lww on structure" guard (R11-01 control). */
  lwwCheck?: boolean;
  /** true: the pre-v12 classifier, where `#time` counts as a leaf and spans don't block lww (a control). */
  groupIsLeaf?: boolean;
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
const EPS = 1e-9;

export const pathKeyOf = (path: readonly (string | number)[]): string => path.map((s) => escapeSegment(String(s))).join("/");

/** Fields that change an item's placement or timing: an op on one of them must carry a span (§6.3). */
export function timingFields(tl: TimelineConfig): Set<string> {
  return new Set([tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed, tl.lane]);
}

/** The time group of the timeline collection (§4.1): `{start, end, source, sourceEnd, speed}`. */
export function timeGroupOf(tl: TimelineConfig): (coll: string, field: string) => string | undefined {
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
export function isStructural(ops: readonly Op[], intent: unknown, tl: TimelineConfig): boolean {
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

/** Every op is covered by a declared path, a grouped field declares its group path, a reorder its track. */
function undeclared(ch: Pushed, tl: TimelineConfig, groupOf: (coll: string, field: string) => string | undefined): string | null {
  const declared = new Set(ch.paths);
  const order = new Set(ch.trackOrder);
  for (const op of ch.ops) {
    if (op.op === "remap") continue; // a remap's surface is its span, checked below
    const p = pathKeyOf(op.path);
    let covered = declared.has(p);
    for (let i = p.lastIndexOf("/"); !covered && i > 0; i = p.lastIndexOf("/", i - 1)) covered = declared.has(p.slice(0, i));
    if (!covered) return p;
    if (op.path.length >= 3) {
      const coll = String(op.path[0]), id = String(op.path[1]), field = String(op.path[2]);
      const g = groupOf(coll, field);
      if (g !== undefined && !declared.has(`${escapeSegment(coll)}/${escapeSegment(id)}/#${g}`)) return `${p} (group #${g})`;
      if (coll === tl.lanes && field === "#pos" && !order.has(id)) return `${p} (track order)`;
    }
  }
  return null;
}

/**
 * §6.3: a timing op must carry a span on its track that contains its new edges. The track is the item's track at
 * the change's base; the overlap test has already rejected any concurrent change to it (H4), so the newest records
 * row at head is that track.
 */
export function spansCover(view: SequencerView, ch: Pushed, tl: TimelineConfig): boolean {
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
  const trackOf = (id: string): string | undefined => {
    const r = view.record(tl.collection, id);
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
        const r = view.record(tl.collection, id);
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
  const tl = cfg.timeline;
  const K = cfg.maxBehind ?? DEFAULT_MAX_BEHIND;
  const keying = cfg.keying ?? "v3-spans";
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
  if (!ch.ops.length) return { kind: "reject", reason: "no ops" };
  if (ch.policy === "lww" && controls.lwwCheck !== false && (ch.spans.length > 0 || ch.trackOrder.length > 0 || ch.paths.some(hasGroupSegment)))
    return { kind: "reject", reason: "lww on structure" };
  const missing = undeclared(ch, tl, cfg.groupOf ?? timeGroupOf(tl));
  if (missing) return { kind: "reject", reason: "undeclared path", detail: missing };

  const structural = isStructural(ch.ops, ch.intent, tl);
  const overwrote: TailRow[] = [];
  let any = false, blocking = false;
  if (tail.length) {
    const me = indexChange(ch, structural, keying);
    for (const row of tail) {
      if (row.withdrawn || past.has(row.id)) continue;
      let k = overlapKind(me, row);
      // the pre-v12 control: a `#time` clash counted as a leaf (and spans were ignored for lww)
      if (k === STRUCTURE && controls.groupIsLeaf && ch.policy === "lww" && onlyGroupClash(me, row)) k = LEAF;
      if (k === NONE) continue;
      any = true;
      if (k === STRUCTURE) blocking = true;
      overwrote.push(row);
    }
  }
  let lww = false;
  if (any) {
    if (ch.policy === "lww" && !blocking && (controls.groupIsLeaf || ch.spans.length === 0)) lww = true;
    else return { kind: "reject", reason: "overlap" };
  }

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

// The groupIsLeaf control: true when every structural clash with this row comes from identical group paths.
function onlyGroupClash(me: ReturnType<typeof indexChange>, row: TailRow): boolean {
  const stripped = { ...row, paths: row.paths.filter((p) => !(me.exact.has(p) && hasGroupSegment(p))), spans: [] as Span[] };
  const meNoSpans = { ...me, spans: new Map<string, number[]>() };
  const k = overlapKind(meNoSpans, stripped);
  return k !== STRUCTURE;
}
