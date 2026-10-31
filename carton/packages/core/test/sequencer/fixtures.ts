// Test fixtures for the sequencer rules: a Cardboard-shaped timeline spec, a stand-in for the engine's `declare`
// (the same paths, reads, half-open spans, group paths and track order as core-v5's declare plus system-v11's group
// paths), and an in-memory SequencerView. The system suite runs the same rules on the real engine.

import type { Pushed, RecordState, SequencerView, TailRow } from "../../src/sequencer/index.ts";
import type { Op, Span } from "../../src/types.ts";
import type { TimelineConfig } from "../../src/schema.ts";
import { isStructural, pathKeyOf, storedPaths } from "../../src/sequencer/index.ts";

export const TL: TimelineConfig = {
  collection: "timelineItems",
  lanes: "tracks",
  lane: "trackId",
  start: "startTime",
  end: "endTime",
  source: "trimStart",
  sourceEnd: "trimEnd",
  speed: "playbackSpeed",
};

export interface Item {
  id: string;
  trackId: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  trimEnd: number;
  [k: string]: unknown;
}
export interface Doc {
  tracks: { id: string }[];
  timelineItems: Item[];
}

export const clip = (id: string, s: number, e: number, track = "V1"): Item => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
export const doc = (items: Item[], tracks = ["V1", "T2"]): Doc => ({ tracks: tracks.map((id) => ({ id })), timelineItems: items });
export const set = (id: string, field: string, value: unknown): Op => ({ op: "set", path: ["timelineItems", id, field], value });
export const ins = (coll: string, id: string, value: unknown): Op => ({ op: "insert", path: [coll, id], value });
export const rm = (coll: string, id: string): Op => ({ op: "remove", path: [coll, id] });

const TIME = new Set(["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"]);
const TIMING = new Set([...TIME, "trackId"]);

/** core-v5's declare for this schema, with system-v11's `#time` group paths. */
export function declare(base: Doc, ops: Op[], intent: { maps?: Record<string, { at: number }> } | null = null) {
  const paths: string[] = [], reads = new Set<string>(), spans: Span[] = [], trackOrder = new Set<string>(), groups = new Set<string>();
  const byItem = new Map<string, Op[]>();
  for (const op of ops) {
    paths.push(pathKeyOf(op.path));
    const [coll, id, field] = op.path.map(String);
    if ((coll === "tracks" || coll === "timelineItems") && op.path.length > 2) reads.add(`${coll}/${id}`);
    if (coll === "timelineItems" && op.path.length === 2 && op.op === "insert") reads.add(`tracks/${(op.value as Item).trackId}`);
    if (coll === "timelineItems" && field === "trackId" && op.op === "set") reads.add(`tracks/${String(op.value)}`);
    if (coll === "tracks" && field === "#pos") trackOrder.add(id!);
    if (coll === "timelineItems" && op.path.length === 3 && TIME.has(field!)) groups.add(`timelineItems/${id}/#time`);
    if (coll === "timelineItems") (byItem.get(id!) ?? byItem.set(id!, []).get(id!)!).push(op);
  }
  for (const [id, list] of byItem) {
    const old = base.timelineItems.find((i) => i.id === id);
    const whole = list.find((op) => op.path.length === 2);
    if (whole) {
      if (old) spans.push({ track: old.trackId, lo: old.startTime, hi: old.endTime });
      if (whole.op === "insert") { const v = whole.value as Item; spans.push({ track: v.trackId, lo: v.startTime, hi: v.endTime }); }
      continue;
    }
    if (!old) continue;
    const nw: Record<string, unknown> = { ...old };
    let timing = false;
    for (const op of list) if (op.path.length === 3 && TIMING.has(String(op.path[2]))) { timing = true; nw[String(op.path[2])] = op.op === "set" ? op.value : undefined; }
    if (!timing) continue;
    const ns = (nw.startTime as number | undefined) ?? old.startTime, ne = (nw.endTime as number | undefined) ?? old.endTime;
    if (nw.trackId !== old.trackId) {
      spans.push({ track: old.trackId, lo: old.startTime, hi: old.endTime }, { track: String(nw.trackId), lo: ns, hi: ne });
    } else spans.push({ track: old.trackId, lo: Math.min(old.startTime, ns), hi: Math.max(old.endTime, ne) });
  }
  for (const [track, m] of Object.entries(intent?.maps ?? {})) spans.push({ track, lo: m.at, hi: null });
  return { paths: [...paths, ...groups], reads: [...reads], spans, trackOrder: [...trackOrder] };
}

let N = 0;
export function change(base: Doc, ops: Op[], o: Partial<Omit<Pushed, "intent">> & { intent?: { maps?: Record<string, { at: number }> } | null } = {}): Pushed {
  const d = declare(base, ops, o.intent ?? null);
  const { intent, ...rest } = o;
  return { id: `r${++N}.1`, base: { seq: 0, pending: [] }, ops, policy: "merge", ...d, ...rest, intent: (intent ?? null) as Pushed["intent"] };
}

/** One branch in memory: rows and an append-only records history. */
export class MemView implements SequencerView {
  rows: TailRow[] = [];
  recs = new Map<string, RecordState[]>();
  constructor(d: Doc) {
    for (const t of d.tracks) this.recs.set(`tracks\u0000${t.id}`, [{ alive: true, seq: 0 }]);
    for (const it of d.timelineItems) this.recs.set(`timelineItems\u0000${it.id}`, [{ alive: true, seq: 0, lane: it.trackId }]);
  }
  head() { return this.rows.length; }
  *tail(after: number) { for (let i = after; i < this.rows.length; i++) yield this.rows[i]!; }
  record(coll: string, id: string) { return this.recs.get(`${coll}\u0000${id}`)?.at(-1); }
  /** Confirm a change as the server would (after evaluatePush accepted it). */
  confirm(ch: Pushed, records: { coll: string; id: string; alive: boolean; lane?: string }[] = []) {
    const seq = this.rows.length + 1;
    this.rows.push({ seq, id: ch.id, withdrawn: false, paths: storedPaths(ch), reads: ch.reads, spans: ch.spans, structural: isStructural(ch.ops, ch.intent, TL) });
    for (const r of records) {
      const k = `${r.coll}\u0000${r.id}`;
      (this.recs.get(k) ?? this.recs.set(k, []).get(k)!).push({ alive: r.alive, seq, ...(r.lane !== undefined ? { lane: r.lane } : {}) });
    }
    return seq;
  }
  withdraw(id: string) {
    this.rows.push({ seq: this.rows.length + 1, id, withdrawn: true, paths: [], reads: [], spans: [], structural: false });
  }
}
