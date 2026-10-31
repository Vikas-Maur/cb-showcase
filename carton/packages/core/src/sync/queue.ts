// A replica's confirmed log plus its pending queue (PLAN §5.2, §6.2, §6.3, §13), per branch: what the sync client
// pushes from and integrates into. Port of system-v11 `store.mjs` (commit, integrate, rebase of the queue, keyframe
// jump, confirmed-id list) with PLAN v14's fixes:
// - an absorbed change (its rebase left nothing to push) is withdrawn when any copy of it may have been sent (H1),
//   and absorbed locally only when none was;
// - every base a change was pushed on is kept (`sentBases`), so `hello` can claim them and the server's scan of
//   `(b, b + K + 1]` per base finds a confirmed change whatever version was confirmed (R12-01);
// - lww is chosen only for leaf edits: a change that declares a span, a group path or a reorder is committed as
//   `merge` (H2's client rule), and a "lww on structure" reject turns the change into `merge`;
// - an empty version is left out of later changes' bases: it contributes nothing to their state, so they must not
//   depend on it (if an older copy of it is confirmed after all, they meet it as a concurrent row).
//
// Synchronous and in memory, like core's History; the Store-backed owner persists through `onChange` events.
// States are rebuilt from the log deterministically; keyframes are only a cache.

import type { Schema } from "../schema.ts";
import type {
  Actor,
  ChangeBase,
  ConfirmedChange,
  ConflictCard,
  Declaration,
  Doc,
  EditKinds,
  Intent,
  Op,
  Policy,
  RemapMaps,
  SequencerState,
} from "../types.ts";
import { apply, canonical, composeMaps, declare, diff, fork, inferRemaps, isEmptyMap, merge3, sha256Hex } from "../engine/index.ts";
import type { ConfirmedId, KeyframeData } from "./messages.ts";

/** A confirmed row as a replica holds it. Rows learned only through a keyframe are placeholders (`id: null`). */
export type QueueRow = (ConfirmedChange & { withdrawn?: boolean; placeholder?: false }) | { seq: number; id: null; ops: Op[]; placeholder: true };

export interface QueueVersion {
  /** Its rebase count. */
  k: number;
  base: ChangeBase;
  baseDoc: Doc;
  ops: Op[];
  intent: Intent | null;
  kinds: EditKinds | null;
  policy: Policy;
  hash: string;
  decl: Declaration;
  supersedes: string[];
  /** Cards the rebase that produced this version raised (provisionally keeping head's value). */
  cards: ConflictCard[];
}

export interface QueuedChange {
  id: string;
  author: Actor;
  branchId: string;
  created: number;
  versions: QueueVersion[];
  /** Cards raised when it was committed (its merge against head). */
  cards: ConflictCard[];
  /** The connection and epoch it was last sent in (only the lease holder's sync client sets them). */
  sentConn: number | null;
  sentEpoch: number;
  sentAt?: number;
  sends: number;
  /** Every base a version of it was pushed on: claimed in `hello` (R10-01, bounded scan). */
  sentBases: number[];
  /** A withdraw was sent for it on this connection and epoch (H1). */
  withdrawSent: { conn: number; epoch: number } | null;
  meta: Record<string, unknown>;
}

export interface QueueBranch {
  id: string;
  name: string;
  kind: string;
  sequencer: SequencerState;
  forkOf?: { branchId: string; seq: number } | null;
  lineage?: { seq: number; kind: string }[];
}

export type QueueEvent =
  | { type: "pending"; branchId: string; change: QueuedChange }
  /** A pending change was confirmed. `lateCards`: cards of the rebases up to the confirmed version only (M3). */
  | { type: "confirmed"; branchId: string; row: { id: string; seq: number; rebase: number }; change: QueuedChange; lateCards: ConflictCard[]; viaList: boolean }
  /** Confirmed at once by a branch this replica sequences itself. */
  | { type: "local-confirmed"; branchId: string; row: ConfirmedChange }
  | { type: "remote"; branchId: string; rows: ConfirmedChange[] }
  /** Its rebase left nothing to push and it is gone: its effect was already in head, or its cards kept head's value. */
  | { type: "absorbed"; branchId: string; change: QueuedChange; cards: ConflictCard[]; withdrawn: boolean }
  /** The sequencer's validation refused it: it left the queue (§4.4). */
  | { type: "rejected"; branchId: string; change: QueuedChange; reason: string };

export interface CommitInput {
  id: string;
  author: Actor;
  ops: Op[];
  intent?: Intent | null;
  kinds?: EditKinds | null;
  policy?: Policy;
  at: number;
  meta?: Record<string, unknown>;
  /** Infer and record a remap from an unrecorded edit that is unambiguously a ripple (§6.1). Default true. */
  inferIntent?: boolean;
}

export const last = <T>(a: readonly T[]): T => a[a.length - 1]!;
const ridOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(".")));

/** `sha256(canonical({ops, intent}))`: the change hash the prototype used. */
export const hashOps = (ops: readonly Op[], intent: Intent | null): string => sha256Hex(canonical({ ops, intent: intent ?? null }));

/** H2's client rule: lww only for leaf edits. A span, a group path or a reorder makes the change structure. */
export function policyFor(wanted: Policy, d: Declaration): Policy {
  if (wanted !== "lww") return wanted;
  if (d.spans.length || d.trackOrder.length) return "merge";
  for (const p of d.paths) if (p.charCodeAt(0) === 35 || p.includes("/#")) return "merge";
  return "lww";
}

export class ReplicaQueue {
  readonly schema: Schema;
  readonly keyframeEvery: number;
  private readonly branches = new Map<string, QueueBranch>();
  private readonly logs = new Map<string, QueueRow[]>();
  private readonly kf = new Map<string, Map<number, Doc>>();
  private readonly queues = new Map<string, QueuedChange[]>();
  private readonly opt = new Map<string, { doc: Doc; version: number }>();
  private optVersion = 0;
  /** Change id → every version it had, kept after confirmation (pins reference them, §5.2). */
  readonly versions = new Map<string, QueueVersion[]>();
  /** Optimistic version → doc, for GUI bases held in engine memory (bounded). */
  readonly statesByVersion = new Map<number, Doc>();
  /** Every replica id (process) that committed here; claimed in `hello` (R10-02). */
  readonly rids = new Set<string>();
  private readonly listeners: ((e: QueueEvent) => void)[] = [];

  constructor(schema: Schema, opts: { keyframeEvery?: number } = {}) {
    this.schema = schema;
    this.keyframeEvery = opts.keyframeEvery ?? 64;
  }

  on(listener: (e: QueueEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  private emit(e: QueueEvent): void {
    for (const l of this.listeners) l(e);
  }

  // ---------------------------------------------------------------- branches and the confirmed log
  addBranch(rec: QueueBranch, doc0: Doc, rows: readonly ConfirmedChange[] = []): void {
    this.branches.set(rec.id, { ...rec });
    this.logs.set(rec.id, []);
    this.kf.set(rec.id, new Map([[0, doc0]]));
    this.queues.set(rec.id, []);
    for (const r of rows) this.appendRow(rec.id, r);
    this.opt.delete(rec.id);
  }
  branch(b: string): QueueBranch {
    const br = this.branches.get(b);
    if (!br) throw new Error(`unknown branch ${b}`);
    return br;
  }
  branchIds(): string[] {
    return [...this.branches.keys()];
  }
  headSeq(b: string): number {
    return this.logs.get(b)!.length;
  }
  rows(b: string): readonly QueueRow[] {
    return this.logs.get(b)!;
  }
  pending(b: string): readonly QueuedChange[] {
    return this.queues.get(b)!;
  }
  /** The confirmed state at `seq` (an error if this replica doesn't hold it, never a guess: §4.4). */
  confirmedState(b: string, seq: number): Doc {
    const kf = this.kf.get(b)!, log = this.logs.get(b)!;
    if (seq > log.length || seq < 0) throw new Error(`state unknown: ${b}@${seq} not held`);
    let s = seq;
    while (!kf.has(s)) {
      s--;
      if (s < 0 || log[s]?.placeholder) throw new Error(`state unknown: ${b}@${seq} is inside a stretch known only through a keyframe`);
    }
    let doc = kf.get(s)!;
    for (let i = s; i < seq; i++) {
      doc = apply(fork(doc, this.schema), log[i]!.ops, this.schema);
      if ((i + 1) % this.keyframeEvery === 0 || i + 1 === seq) kf.set(i + 1, doc);
    }
    return doc;
  }
  /** The local optimistic state: confirmed head plus every pending change's latest version. */
  optimistic(b: string): { doc: Doc; version: number } {
    let o = this.opt.get(b);
    if (o) return o;
    let doc = this.confirmedState(b, this.headSeq(b));
    for (const p of this.queues.get(b)!) {
      const v = last(p.versions);
      if (v.ops.length) doc = apply(fork(doc, this.schema), v.ops, this.schema);
    }
    o = { doc, version: ++this.optVersion };
    this.opt.set(b, o);
    this.statesByVersion.set(o.version, doc);
    if (this.statesByVersion.size > 200) this.statesByVersion.delete(this.statesByVersion.keys().next().value!);
    return o;
  }
  invalidate(b: string): void {
    this.opt.delete(b);
  }
  /** Append a confirmed row (idempotent by seq). True if new. */
  appendRow(b: string, row: QueueRow): boolean {
    const log = this.logs.get(b)!;
    if (row.seq <= log.length) return false;
    if (row.seq !== log.length + 1) throw new Error(`gap: have ${log.length}, got ${row.seq}`);
    log.push(row);
    return true;
  }
  setSequencer(b: string, s: SequencerState): void {
    this.branch(b).sequencer = s;
  }

  // ---------------------------------------------------------------- commit
  /** A local change. On a branch this replica sequences it is confirmed at once; otherwise it joins the queue. */
  commit(b: string, ch: CommitInput): { id: string; status: "confirmed" | "pending"; seq?: number; empty?: boolean } {
    const br = this.branch(b);
    if (!ch.ops.length) return { id: ch.id, status: "confirmed", empty: true };
    this.rids.add(ridOf(ch.id));
    const o = this.optimistic(b);
    const queue = this.queues.get(b)!;
    // an unrecorded edit that is unambiguously a ripple gets its remap inferred and recorded at commit (§6.1)
    let intent = ch.intent ?? null;
    if (!intent && ch.inferIntent !== false && this.schema.timeline) {
      const maps = inferRemaps(this.schema, o.doc, ch.ops.map((op) => ({ path: op.path, op })));
      if (!isEmptyMap(maps)) intent = { maps, inferred: true };
    }
    const decl = declare(this.schema, o.doc, ch.ops, intent);
    const v: QueueVersion = {
      k: 0,
      base: { seq: this.headSeq(b), pending: queue.filter((p) => last(p.versions).ops.length).map((p) => p.id) },
      baseDoc: o.doc,
      ops: ch.ops,
      intent,
      kinds: ch.kinds ?? null,
      policy: policyFor(ch.policy ?? "merge", decl),
      hash: hashOps(ch.ops, intent),
      decl,
      supersedes: [],
      cards: [],
    };
    this.versions.set(ch.id, [v]);
    if (br.sequencer.kind === "local") {
      const row: ConfirmedChange = {
        id: ch.id,
        hash: v.hash,
        author: ch.author,
        branchId: b,
        base: v.base,
        ops: ch.ops,
        intent: v.intent,
        kinds: v.kinds,
        policy: v.policy,
        at: ch.at,
        rebase: 0,
        supersedes: [],
        ...decl,
        seq: this.headSeq(b) + 1,
      };
      this.appendRow(b, row);
      this.invalidate(b);
      this.emit({ type: "local-confirmed", branchId: b, row });
      return { id: ch.id, status: "confirmed", seq: row.seq };
    }
    const p: QueuedChange = {
      id: ch.id,
      author: ch.author,
      branchId: b,
      created: ch.at,
      versions: [v],
      cards: [],
      sentConn: null,
      sentEpoch: -1,
      sends: 0,
      sentBases: [],
      withdrawSent: null,
      meta: ch.meta ?? {},
    };
    queue.push(p);
    this.invalidate(b);
    this.emit({ type: "pending", branchId: b, change: p });
    return { id: ch.id, status: "pending" };
  }

  // ---------------------------------------------------------------- integrating confirmed rows
  /**
   * New confirmed rows arrived. Our own changes leave the queue; the rest of the queue is rebased, in order, onto the
   * new head (only someone else's rows change what the queue sits on).
   */
  integrate(b: string, rows: readonly (ConfirmedChange & { withdrawn?: boolean })[]): { mine: ConfirmedChange[]; others: ConfirmedChange[]; cards: { change: QueuedChange; cards: ConflictCard[] }[] } {
    const fresh: (ConfirmedChange & { withdrawn?: boolean })[] = [];
    for (const r of rows) if (this.appendRow(b, r)) fresh.push(r);
    if (!fresh.length) return { mine: [], others: [], cards: [] };
    const queue = this.queues.get(b)!;
    const byId = new Map(queue.map((p) => [p.id, p]));
    const mine = fresh.filter((r) => byId.has(r.id));
    const others = fresh.filter((r) => !byId.has(r.id));
    const done = new Set(mine.map((r) => r.id));
    const keep = queue.filter((p) => !done.has(p.id));
    const changed = others.filter((r) => !r.withdrawn);
    const cards = changed.length ? this.rebaseChain(b, keep, changed) : [];
    this.queues.set(b, keep);
    this.invalidate(b);
    for (const r of mine) {
      const p = byId.get(r.id)!;
      if (r.withdrawn) this.finishAbsorb(b, p, true);
      else this.confirmed(b, p, { id: r.id, seq: r.seq, rebase: r.rebase ?? 0 }, false);
    }
    if (others.length) this.emit({ type: "remote", branchId: b, rows: others });
    return { mine, others, cards };
  }
  private confirmed(b: string, p: QueuedChange, row: { id: string; seq: number; rebase: number }, viaList: boolean): void {
    // late cards: those of the rebases that produced the confirmed version. Versions the server never confirmed
    // don't count: their cards described a merge that didn't happen (M3).
    const lateCards = p.versions.slice(1, row.rebase + 1).flatMap((v) => v.cards);
    this.emit({ type: "confirmed", branchId: b, row, change: p, lateCards, viaList });
  }

  private rebaseChain(b: string, chain: readonly QueuedChange[], concurrent: readonly ConfirmedChange[]) {
    let cur = this.confirmedState(b, this.headSeq(b));
    const out: { change: QueuedChange; cards: ConflictCard[] }[] = [];
    const ids: string[] = [];
    for (const p of chain) {
      const v = last(p.versions);
      const r = this.rebaseOne(v, cur, concurrent);
      const decl = declare(this.schema, cur, r.ops, r.intent);
      // an empty result (its effect is already in head, or a card kept head's value) stays as an empty version: the
      // pusher withdraws or absorbs it, and later bases leave it out
      const nv: QueueVersion = {
        k: v.k + 1,
        base: { seq: this.headSeq(b), pending: [...ids] },
        baseDoc: cur,
        ops: r.ops,
        intent: r.intent,
        kinds: v.kinds,
        policy: policyFor(v.policy, decl),
        hash: hashOps(r.ops, r.intent),
        decl,
        supersedes: [...v.supersedes, `${p.id}#${v.k}`],
        cards: r.cards,
      };
      p.versions.push(nv);
      this.versions.get(p.id)?.push(nv);
      if (r.cards.length) out.push({ change: p, cards: r.cards });
      if (r.ops.length) {
        cur = apply(fork(cur, this.schema), r.ops, this.schema);
        ids.push(p.id);
      }
    }
    return out;
  }

  /**
   * Rebase one version from its base onto `head` with merge3. `concurrent` = the confirmed rows between them; their
   * recorded remaps and edit kinds go in as the head side's, and the change's own remap is re-expressed in head
   * coordinates (its edge map). Cards keep head's value (the provisional side).
   */
  private rebaseOne(v: QueueVersion, head: Doc, concurrent: readonly ConfirmedChange[]): { ops: Op[]; cards: ConflictCard[]; intent: Intent | null } {
    const S = this.schema;
    const mine = apply(fork(v.baseDoc, S), v.ops, S);
    const recorded: RemapMaps[] = [];
    const concKinds: EditKinds = {};
    for (const c of concurrent) {
      if (c.intent?.maps && !isEmptyMap(c.intent.maps)) recorded.push(c.intent.maps);
      for (const op of c.ops) if (op.op === "remap") recorded.push(op.maps);
      if (c.kinds) Object.assign(concKinds, c.kinds);
    }
    const own = v.intent?.maps && !isEmptyMap(v.intent.maps) ? v.intent : undefined;
    const m = merge3(v.baseDoc, head, mine, S, {
      remaps: { ...(recorded.length ? { ours: { maps: composeMaps(...recorded) } } : {}), ...(own ? { theirs: { maps: own.maps!, ...(own.lineage ? { lineage: own.lineage } : {}) } } : {}) },
      kinds: { ours: concKinds, theirs: v.kinds ?? {} },
      rekeys: "ours",
    });
    const intent = own ? { ...v.intent!, maps: m.edges.ours } : v.intent;
    return { ops: diff(head, m.doc, S), cards: m.conflicts, intent };
  }

  /** Rebase the whole queue onto the current head with no new rows (after "behind", a keyframe jump, a reject). */
  rebaseAll(b: string): { change: QueuedChange; cards: ConflictCard[] }[] {
    const c = this.rebaseChain(b, this.queues.get(b)!, []);
    this.invalidate(b);
    return c;
  }

  /**
   * A keyframe catch-up (§6.3): the rows between our head and the keyframe are not sent; they become placeholders,
   * and the keyframe is the state at its seq. A merge over them infers remaps, since the recorded ones are unknown.
   */
  jumpTo(b: string, kf: KeyframeData): boolean {
    const log = this.logs.get(b)!;
    if (kf.seq <= log.length) return false;
    for (let s = log.length + 1; s <= kf.seq; s++) log.push({ seq: s, id: null, ops: [], placeholder: true });
    this.kf.get(b)!.set(kf.seq, kf.doc);
    this.invalidate(b);
    return true;
  }

  /**
   * R10-01: pending ids the server says it already confirmed or withdrew, inside a stretch we may never see as rows,
   * leave the queue first, before any rebase, so a confirmed change is never rebased and confirmed again.
   */
  confirmFromList(b: string, list: readonly ConfirmedId[] | undefined): QueuedChange[] {
    const out: QueuedChange[] = [];
    const head = this.headSeq(b);
    for (const c of list ?? []) {
      if (c.seq > head) continue; // it will arrive as a row in the tail
      const queue = this.queues.get(b)!;
      const p = queue.find((x) => x.id === c.id);
      if (!p) continue;
      this.queues.set(b, queue.filter((x) => x !== p));
      out.push(p);
      if (c.withdrawn) this.finishAbsorb(b, p, true);
      else this.confirmed(b, p, { id: c.id, seq: c.seq, rebase: c.rebase ?? 0 }, true);
    }
    if (out.length) this.invalidate(b);
    return out;
  }

  /**
   * The version a change made (L5: version ids are provisional until confirmed). Confirmed: `<branch>@<seq>`, final.
   * Pending: `<branch>@<head>+<n>` (the n-th change of the queue on top of the confirmed head), provisional: it moves
   * as rows arrive, and the share of a cut stays "syncing" until its sequencer has answered. null: unknown id.
   */
  versionId(b: string, id: string): { id: string; provisional: boolean } | null {
    const log = this.logs.get(b)!;
    for (let i = log.length - 1; i >= 0; i--) if (log[i]!.id === id) return { id: `${b}@${i + 1}`, provisional: false };
    const queue = this.queues.get(b)!;
    let n = 0;
    for (const p of queue) {
      if (last(p.versions).ops.length) n++;
      if (p.id === id) return { id: `${b}@${log.length}+${n}`, provisional: true };
    }
    return null;
  }

  // ---------------------------------------------------------------- leaving the queue
  /** The change's latest version is empty: it changes nothing now. */
  isEmpty(p: QueuedChange): boolean {
    return last(p.versions).ops.length === 0;
  }
  /**
   * Absorb a change that was never sent: no copy can exist anywhere, so it just leaves the queue. A change any copy
   * of which may have been sent is withdrawn instead (the sync client sends `withdraw`, then `finishAbsorb`).
   */
  absorbLocally(b: string, p: QueuedChange): void {
    const queue = this.queues.get(b)!;
    if (!queue.includes(p)) return;
    this.queues.set(b, queue.filter((x) => x !== p));
    this.invalidate(b);
    this.finishAbsorb(b, p, false);
  }
  /** The server spent its id (or it was never sent): its cards reach the human and the actor (§6.2). */
  finishAbsorb(b: string, p: QueuedChange, withdrawn: boolean): void {
    const queue = this.queues.get(b)!;
    if (queue.includes(p)) {
      this.queues.set(b, queue.filter((x) => x !== p));
      this.invalidate(b);
    }
    const cards = p.versions.slice(1).flatMap((v) => v.cards);
    this.emit({ type: "absorbed", branchId: b, change: p, cards, withdrawn });
  }
  /** The sequencer's validation refused the change: it is dropped, never retried, and the queue is rebased without it. */
  rejectPending(b: string, id: string, reason: string): QueuedChange | null {
    const queue = this.queues.get(b)!;
    const p = queue.find((x) => x.id === id);
    if (!p) return null;
    this.queues.set(b, queue.filter((x) => x !== p));
    this.rebaseAll(b);
    this.emit({ type: "rejected", branchId: b, change: p, reason });
    return p;
  }
  /** "lww on structure" (H2): the change goes through merge3 from now on. */
  toMerge(b: string, id: string): boolean {
    const p = this.queues.get(b)!.find((x) => x.id === id);
    if (!p) return false;
    for (const v of p.versions) v.policy = "merge";
    return true;
  }
}
