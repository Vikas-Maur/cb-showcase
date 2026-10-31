// The sequencer rule (PLAN §6.1, §6.3), the same for the local sequencer and every SequencerHost: a change is accepted
// if it overlaps no change confirmed after its base that isn't in its causal past; `lww` changes also when every
// overlap is between leaf sets on live records; otherwise rejected, and the client rebases. `evaluatePush` is the one
// implementation; `createLocalSequencer` runs it over an in-memory log and head doc, `@carton/server` over SQL.
// Owner: sync-sequencer. Ported from core-v5 `engine.mjs` (`overlap`, `Sequencer`) and system-v11 `server.mjs`, with
// PLAN v14's fixes (H1 withdraw rows, H2, H3 in the server's records lookup, H4).

import type { Schema } from "../schema.ts";
import type { Actor, Change, ConfirmedChange, Declaration, Doc, Notice, Overlap, Rec, Span } from "../types.ts";
import type { RejectReason } from "../sync/messages.ts";
import { apply, fork, getIn, pathKey } from "../engine/index.ts";
import { evaluatePush, isStructural, NO_TIMELINE, type RulesConfig, type SequencerView } from "./evaluate.ts";
import { storedPaths } from "./overlap.ts";
import type { TailRow } from "./types.ts";

export * from "./types.ts";
export {
  NONE,
  LEAF,
  STRUCTURE,
  type OverlapKind,
  type ChangeIndex,
  indexChange,
  overlapKind,
  storedPaths,
  trackOrderPath,
  escapeSegment,
  hasGroupSegment,
  isLeafPath,
} from "./overlap.ts";
export {
  type SequencerView,
  type RulesConfig,
  type RuleControls,
  type OverlapRule,
  type RecordWrite,
  type Verdict,
  DEFAULT_MAX_BEHIND,
  NO_TIMELINE,
  evaluatePush,
  isStructural,
  spansCover,
  timingFields,
  timeGroupOf,
  pathKeyOf,
} from "./evaluate.ts";

const related = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const hiOf = (s: Span) => s.hi ?? Infinity;
const structuralDecl = (d: Declaration) => d.structural ?? d.spans.some((s) => s.structural === true);

/**
 * How two declarations overlap, for describing a clash (empty object: they don't). The same rule as
 * `overlapKind`: spans meet only when one side is structural (v11), group paths are paths.
 */
export function overlap(x: Declaration, y: Declaration): Overlap {
  const out: Overlap = {};
  const xp = storedPaths(x), yp = storedPaths(y);
  outer: for (const p of xp) for (const q of yp) if (related(p, q)) { out.path = p.length >= q.length ? p : q; break outer; }
  const readHit = (reads: readonly string[], paths: readonly string[]) => reads.find((r) => paths.some((p) => r === p || r.startsWith(p + "/")));
  const read = readHit(x.reads, y.paths) ?? readHit(y.reads, x.paths);
  if (read !== undefined) out.read = read;
  if (structuralDecl(x) || structuralDecl(y)) {
    spans: for (const a of x.spans)
      for (const b of y.spans)
        if (a.track === b.track && a.lo < hiOf(b) && b.lo < hiOf(a)) {
          out.span = { track: a.track, a: [a.lo, a.hi], b: [b.lo, b.hi] };
          break spans;
        }
  }
  const to = new Set(x.trackOrder);
  for (const t of y.trackOrder) if (to.has(t)) out.order = t;
  return out;
}

export type PushResult =
  | { ok: true; seq: number; change: ConfirmedChange; duplicate?: boolean; notices: Notice[]; missing: ConfirmedChange[] }
  | { ok: false; reason: RejectReason; overlap?: Overlap; invalid?: { path?: string; error: string }; head: number; missing: ConfirmedChange[] };

/**
 * One branch's sequencer over an in-memory log and head doc: what a replica runs for a cut it sequences itself
 * (persisted by its Store), and what the conformance suite runs against. The server variant keeps no document
 * (records table instead) and lives in `@carton/server`.
 */
export interface LocalSequencer {
  readonly seq: number;
  readonly head: Doc;
  readonly log: readonly ConfirmedChange[];
  /** Validate and order one change. A duplicate id is acked with its existing seq whatever its hash. */
  push(change: Change & { baseDoc?: Doc }): PushResult;
  pull(since: number): ConfirmedChange[];
  /** Adopt rows confirmed elsewhere (a reload from the Store). */
  load(rows: readonly ConfirmedChange[]): void;
}

export const actorKey = (a: Actor | null | undefined): string => (a ? `${a.kind}/${a.id}${a.agentId ? `/${a.agentId}` : ""}` : "unknown");
const nameOf = (a: Actor | null | undefined) => a?.name ?? a?.id ?? "someone";

/** The rule's configuration for a schema: its timeline and its field groups. */
export function rulesFor(schema: Schema, extra: Partial<RulesConfig> = {}): RulesConfig {
  return {
    timeline: schema.timeline ?? null,
    groupOf: (coll, field) => schema.collections[coll]?.groupOf.get(field)?.name,
    ...extra,
  };
}

export function createLocalSequencer(doc: Doc, schema: Schema, opts: Partial<RulesConfig> = {}): LocalSequencer {
  const cfg = rulesFor(schema, opts);
  const tl = cfg.timeline ?? NO_TIMELINE;
  let head = fork(doc, schema);
  const log: ConfirmedChange[] = [];
  const tails: TailRow[] = [];

  const tailOf = (c: ConfirmedChange): TailRow => ({
    seq: c.seq,
    id: c.id,
    withdrawn: false,
    paths: storedPaths(c),
    reads: c.reads,
    spans: c.spans,
    structural: isStructural(c.ops, c.intent, tl),
  });
  // existence comes from the head doc: this sequencer holds the state (the server can't, so it keeps records rows)
  const view: SequencerView = {
    head: () => log.length,
    *tail(after) {
      for (let i = after; i < tails.length; i++) yield tails[i]!;
    },
    record(coll, id) {
      const rec = getIn(head, [coll, id], schema) as Rec | undefined;
      if (rec === undefined) return undefined;
      return coll === tl.collection && rec[tl.lane] !== undefined ? { alive: true, seq: log.length, lane: String(rec[tl.lane]) } : { alive: true, seq: log.length };
    },
  };
  const append = (c: ConfirmedChange) => {
    log.push(c);
    tails.push(tailOf(c));
  };

  // Hard validators on the records the change touches, against the state it would produce (§4.1: a failure is
  // rejected by the sequencer's validation; the client's merge turns it into a card).
  const invalid = (ops: Change["ops"]): { path?: string; error: string } | null => {
    if (!schema.hard) return null;
    const touched = new Map<string, readonly [string, string]>();
    for (const op of ops) if (op.path.length >= 2 && schema.collections[String(op.path[0])]) touched.set(pathKey(op.path.slice(0, 2)), [String(op.path[0]), String(op.path[1])]);
    if (!touched.size) return null;
    const trial = apply(fork(head, schema), ops, schema);
    for (const [key, [coll, id]] of touched) {
      const rec = getIn(trial, [coll, id], schema) as Rec | undefined;
      if (!rec) continue;
      const issues = schema.hard(coll, rec, trial);
      if (issues.length) return { path: key, error: issues.join("; ") };
    }
    return null;
  };

  return {
    get seq() {
      return log.length;
    },
    get head() {
      return head;
    },
    get log() {
      return log;
    },
    push(change) {
      const v = evaluatePush(view, change, cfg);
      const base = Math.min(change.base?.seq ?? 0, log.length);
      if (v.kind === "duplicate") return { ok: true, duplicate: true, seq: v.seq, change: log[v.seq - 1]!, notices: [], missing: [] };
      if (v.kind === "reject") {
        // describe the clash with overlap(x, y) when a caller wants it: not computed here, so the shipped bundle
        // (History only reads the reason) doesn't carry it
        const r: PushResult = { ok: false, reason: v.reason, head: log.length, missing: log.slice(base) };
        if (v.detail) r.invalid = { error: v.detail };
        return r;
      }
      const bad = invalid(change.ops);
      if (bad) return { ok: false, reason: "invalid", invalid: bad, head: log.length, missing: log.slice(base) };
      const notices: Notice[] = [];
      for (const row of v.overwrote) {
        const c = log[row.seq - 1]!;
        notices.push({ to: actorKey(c.author), kind: "overwritten", text: `overwritten by ${nameOf(change.author)}`, by: change.author, change: c.id });
      }
      const notes: { op: { path: readonly (string | number)[] } }[] = [];
      apply(head, change.ops, schema, notes as never);
      for (const nt of notes) {
        const rp = pathKey(nt.op.path.slice(0, 2));
        const by = [...log].reverse().find((c) => c.ops.some((o) => o.op === "remove" && pathKey(o.path) === rp));
        notices.push({ to: actorKey(change.author), kind: "lost-to-delete", text: `lost to delete by ${nameOf(by?.author)}`, path: pathKey(nt.op.path) });
      }
      const seq = log.length + 1;
      const { baseDoc: _drop, ...rest } = change as Change & { baseDoc?: Doc };
      const entry: ConfirmedChange = { ...rest, base: { seq: change.base.seq, pending: [...change.base.pending] }, seq };
      append(entry);
      return { ok: true, seq, change: entry, notices, missing: log.slice(base, seq - 1) };
    },
    pull(since) {
      return log.slice(since);
    },
    load(rows) {
      for (const r of rows) {
        if (r.seq <= log.length) continue;
        if (r.seq !== log.length + 1) throw new Error(`sequencer load: gap, have ${log.length}, got ${r.seq}`);
        head = apply(head, r.ops, schema);
        append(r);
      }
    },
  };
}
