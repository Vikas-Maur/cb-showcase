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
  Change,
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
import { apply, canonical, composeMaps, declare, diff, fork, hashDoc, inferRemaps, intentRemap, isEmptyMap, merge3, sha256Hex, sideOf } from "../engine/index.ts";
import { forkSealed } from "../engine/doc.ts";
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

/**
 * History a change carries besides its ops (fold-ins, undo, partial accept, names): kept through rebases and sent with
 * every push, so the merge DAG and undo survive on shared cuts (review finding 13).
 */
export type HistoryFields = Partial<Pick<Change, "kind" | "mergeOf" | "mergeEdges" | "mergeBase" | "reverts" | "rejected" | "lastAuthors" | "name">>;
const HISTORY_KEYS = ["kind", "mergeOf", "mergeEdges", "mergeBase", "reverts", "rejected", "lastAuthors", "name"] as const;
/** An empty change that must still be recorded: a fold-in (a DAG node) or an undo (it marks its change undone). */
export const keepsWhenEmpty = (h: HistoryFields | undefined): boolean => !!h && (h.mergeOf !== undefined || h.reverts !== undefined);

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
  /** Refused here (too large to send) after a copy was sent: emptied, withdrawn, then reported rejected with this. */
  rejecting?: string;
  /** The connection that refused its withdraw (its token or branch): not withdrawn again on it. */
  withdrawRefused?: number;
  /**
   * Not to be sent yet, nor anything after it: the store write that keeps it is under way and may fail (a commit with
   * conditions, review R6-2). Cleared by `unhold` once it landed; taken back by `unqueue` if it failed.
   */
  held?: true;
  meta: Record<string, unknown>;
  history?: HistoryFields;
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
  /** Fold-in, undo and naming fields the change records (kept through rebases, sent with the push). */
  history?: HistoryFields;
  /** Hold it back from the pusher until `unhold` (its store write may yet fail: `QueuedChange.held`). */
  held?: boolean;
}

/** A pending change as a store kept it across a restart (`ReplicaQueue.restore`). */
export interface RestoreInput extends CommitInput {
  /** Its latest version's rebase count. */
  k: number;
  supersedes: readonly string[];
  /** The cards each rebase raised, by rebase count (only rebases that raised any). */
  cards: readonly { k: number; cards: ConflictCard[] }[];
  /** Every base a version of it was pushed on. */
  sentBases: readonly number[];
  /** Refused here after a copy was sent: it waits for its withdraw, then is reported rejected with this. */
  rejecting?: string;
  /** The confirmed seq its ops were made on; default: the queue's head. */
  head?: number;
  /**
   * The pending changes its ops were made on, in queue order (its version's `base.pending`). Absent (a row from before
   * they were kept): the changes restored before it on the same `head`.
   */
  basePending?: readonly string[];
  /**
   * Its base exactly, as ops from the confirmed state at `head` (what the pending changes it sits on did, as it read
   * them): rebuilt from these rather than from those changes' rows, which may be held or since confirmed in a rebased
   * version (review SF4-2). Absent on a row from before; then the rows are used.
   */
  baseDelta?: Op[];
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

const BASE_DELTA = new WeakMap<QueueVersion, Op[] | null>();

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
  /** Ids confirmed through a server list inside a stretch held only as placeholders: branch → id → seq (finding 18). */
  private readonly listed = new Map<string, Map<string, number>>();
  /** `branch\0id` → why: changes refused here whose ids a withdraw spent (rare: kept for the queue's life). */
  private readonly refused = new Map<string, string>();
  /** The highest placeholder seq per branch: rows above it are all held, so the client can check them itself. */
  private readonly placeholderTop = new Map<string, number>();
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
  /**
   * A version's base as ops from the confirmed state its base names (`RestoreInput.baseDelta`, review SF4-2): what the
   * pending changes it sits on did, as it read them. Empty when it sits on none; null when that confirmed state isn't
   * held. Once per version (a version never changes).
   */
  baseDelta(b: string, v: QueueVersion): Op[] | null {
    if (!v.base.pending.length) return [];
    let d = BASE_DELTA.get(v);
    if (d === undefined) {
      try {
        d = diff(this.confirmedState(b, v.base.seq), v.baseDoc, this.schema);
      } catch {
        d = null;
      }
      BASE_DELTA.set(v, d);
    }
    return d;
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
      doc = apply(forkSealed(doc, this.schema), log[i]!.ops, this.schema);
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
      if (v.ops.length) doc = apply(forkSealed(doc, this.schema), v.ops, this.schema); // a handed-out head stays sealed
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
    if (!ch.ops.length && !keepsWhenEmpty(ch.history)) return { id: ch.id, status: "confirmed", empty: true };
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
        ...pickHistory(ch.history),
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
      ...(ch.history ? { history: pickHistory(ch.history) } : {}),
      ...(ch.held ? { held: true as const } : {}),
    };
    queue.push(p);
    this.invalidate(b);
    this.emit({ type: "pending", branchId: b, change: p });
    return { id: ch.id, status: "pending" };
  }

  /**
   * Pending changes back in the queue after a restart, in their queue order, as they were (web-demo REQ-7): each at
   * its rebase count and with its supersedes, the cards each rebase raised (reported when it settles: `lateCards` up
   * to the confirmed version, or all of them if it is absorbed), the bases it was sent on (claimed in hello; an
   * emptied one is withdrawn, not dropped, since a copy may still be confirmed) and a refusal here that is waiting for
   * its withdraw. Its stored ops were made on the confirmed state at its `head` plus the changes stored before it on
   * that head: on an older head than this queue's, it is rebased onto what was confirmed since, as an integrate would
   * have done (review SF2-2: another process's row, kept for the next holder, was applied as if made on the newer
   * head). A head whose state this replica can't rebuild is taken as the current one. Returns the ids restored (not:
   * already queued, or empty, never sent and with nothing to report).
   */
  restoreAll(b: string, inputs: readonly RestoreInput[], stateAt?: (seq: number) => Doc | null): { restored: string[]; held: RestoreInput[] } {
    const S = this.schema;
    const out: string[] = [];
    const held: RestoreInput[] = [];
    // the stored ops of the changes restored so far (what a later row's base may include), and per recorded head the
    // ids restored on it (a row from before rows kept their pending base is taken as made after them)
    const storedOps = new Map<string, Op[]>();
    const onHead = new Map<number, string[]>();
    const heldIds = new Set<string>();
    for (const ch of inputs) {
      const queue = this.queues.get(b)!;
      if (queue.some((p) => p.id === ch.id)) continue;
      const reports = ch.cards.some((c) => c.cards.length > 0) || ch.rejecting !== undefined;
      if (!ch.ops.length && !keepsWhenEmpty(ch.history) && !ch.sentBases.length && !reports) continue;
      const head = this.headSeq(b);
      const at = ch.head ?? head;
      // made on a state past this queue's head: it can't be rebased back onto an older one, it waits (the owner puts the
      // queue at its saved catch-up state first)
      // the pending changes it was made on: one that waits makes it wait too, so it is never restored before (and
      // without) a change it builds on (review SF4-1: its edit of a clip that change inserts was emptied and absorbed)
      const deps = ch.basePending ?? onHead.get(at) ?? [];
      if (at > head || deps.some((id) => heldIds.has(id))) {
        held.push(ch), heldIds.add(ch.id);
        continue;
      }
      // its base: the confirmed state at `at` (this queue's, or the owner's: History, a saved catch-up state), never a
      // guess; one nobody can rebuild waits, kept as stored (review SF3-1)
      let baseState: Doc | null = null;
      try {
        baseState = this.confirmedState(b, at);
      } catch {
        // inside a stretch held only through a keyframe
      }
      baseState ??= stateAt?.(at) ?? null;
      if (!baseState) {
        held.push(ch), heldIds.add(ch.id);
        continue;
      }
      this.rids.add(ridOf(ch.id));
      const o = this.optimistic(b);
      // ...plus the pending changes it was made on, as they were: restored before it here, or confirmed since (then they
      // are its base, not concurrent: review SF3-3)
      const log = this.logs.get(b)!;
      let baseDoc = baseState;
      const inBase = new Set<string>();
      if (ch.baseDelta) {
        // its base exactly as it read it (SF4-2)
        baseDoc = apply(fork(baseDoc, S), ch.baseDelta, S);
        for (const id of deps) inBase.add(id);
      } else for (const id of deps) {
        const ops = storedOps.get(id) ?? (log.slice(at, head).find((r): r is ConfirmedChange => !r.placeholder && r.id === id)?.ops ?? null);
        if (!ops) continue; // absorbed or refused meanwhile: in neither its base nor the head
        if (ops.length) baseDoc = apply(fork(baseDoc, S), ops, S);
        inBase.add(id);
      }
      storedOps.set(ch.id, ch.ops);
      if (ch.ops.length) (onHead.get(at) ?? onHead.set(at, []).get(at)!).push(ch.id);
      const exact = at === head && hashDoc(baseDoc, S) === hashDoc(o.doc, S);
      const chain = exact ? null : { doc: baseDoc, ids: [...inBase] };
      const intent = ch.intent ?? null;
      const onBase = (baseDoc: Doc, base: ChangeBase, ops: Op[], i: Intent | null, k: number, supersedes: string[], cards: ConflictCard[]): QueueVersion => {
        const decl = declare(S, baseDoc, ops, i);
        return { k, base, baseDoc, ops, intent: i, kinds: ch.kinds ?? null, policy: policyFor(ch.policy ?? "merge", decl), hash: hashOps(ops, i), decl, supersedes, cards };
      };
      const byK = new Map(ch.cards.map((c) => [c.k, c.cards]));
      const current = { seq: head, pending: queue.filter((p) => last(p.versions).ops.length).map((p) => p.id) };
      let top: QueueVersion;
      let rebased: QueueVersion | null = null;
      if (chain) {
        // as stored, on its own base; then rebased onto what was confirmed since (its own base's changes excepted) and
        // the changes restored before it, as an integrate would have done
        top = onBase(chain.doc, { seq: at, pending: chain.ids }, ch.ops, intent, ch.k, [...ch.supersedes], byK.get(ch.k) ?? []);
        const concurrent = log.slice(at, head).filter((r): r is ConfirmedChange & { withdrawn?: boolean } => !r.placeholder && !(r as { withdrawn?: boolean }).withdrawn && !inBase.has(r.id));
        const r = this.rebaseOne(top, o.doc, concurrent);
        rebased = onBase(o.doc, current, r.ops, r.intent, ch.k + 1, [...top.supersedes, `${ch.id}#${ch.k}`], r.cards);
        rebased.policy = policyFor(top.policy, rebased.decl);
      } else top = onBase(o.doc, current, ch.ops, intent, ch.k, [...ch.supersedes], byK.get(ch.k) ?? []);
      // the earlier versions are gone; each stands in only for the cards its rebase raised (indexed by rebase count, as
      // `confirmed` and `finishAbsorb` read them). The last is the one pushed.
      const versions: QueueVersion[] = [...Array.from({ length: ch.k }, (_, k) => ({ ...top, k, cards: byK.get(k) ?? [] })), top, ...(rebased ? [rebased] : [])];
      // its own array: rebases append to both (review SF2-1: one shared array got every append twice)
      this.versions.set(ch.id, [...versions]);
      const p: QueuedChange = {
        id: ch.id,
        author: ch.author,
        branchId: b,
        created: ch.at,
        versions,
        cards: [],
        sentConn: null,
        sentEpoch: -1,
        sends: 0,
        sentBases: [...ch.sentBases],
        withdrawSent: null,
        meta: ch.meta ?? {},
        ...(ch.history ? { history: pickHistory(ch.history) } : {}),
        ...(ch.rejecting !== undefined ? { rejecting: ch.rejecting } : {}),
      };
      queue.push(p);
      this.invalidate(b);
      out.push(ch.id);
      this.emit({ type: "pending", branchId: b, change: p });
    }
    return { restored: out, held };
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
    // what landed meanwhile: its recorded maps (intents and first-class remap ops), lineage too (a concurrent split
    // records only lineage, which must reach the pieces of a clip this change edits: kit-docs; composed in order, so a
    // piece split again keeps every piece: review SF4-5) and kinds
    const side = sideOf(concurrent.flatMap((c) => [c, ...c.ops.flatMap((op) => (op.op === "remap" ? [{ intent: op }] : []))]));
    const ours = side.remap, concKinds = side.kinds;
    // the change's own remap: its recorded intent and any first-class remap op (a ripple stored as one op, P5)
    const remapOps = v.ops.filter((op): op is Extract<Op, { op: "remap" }> => op.op === "remap");
    const ownMaps: RemapMaps[] = [];
    if (v.intent?.maps && !isEmptyMap(v.intent.maps)) ownMaps.push(v.intent.maps);
    for (const op of remapOps) if (!isEmptyMap(op.maps)) ownMaps.push(op.maps);
    // its own: maps and lineage (a split records lineage only: kept, kit-docs)
    const own = intentRemap({ maps: ownMaps.length ? (ownMaps.length === 1 ? ownMaps[0]! : composeMaps(...ownMaps)) : {}, lineage: v.intent?.lineage ?? remapOps[0]?.lineage });
    const m = merge3(v.baseDoc, head, mine, S, {
      remaps: { ...(ours ? { ours } : {}), ...(own ? { theirs: own } : {}) },
      kinds: { ours: concKinds, theirs: v.kinds ?? {} },
      rekeys: "ours",
    });
    // its remap re-expressed in head's coordinates (its edge map)
    const intent = v.intent?.maps && !isEmptyMap(v.intent.maps) ? { ...v.intent, maps: m.edges.ours } : v.intent;
    if (!remapOps.length) return { ops: diff(head, m.doc, S), cards: m.conflicts, intent };
    // keep a remap as one op through the rebase (one row per ripple at the sequencer, P5): the remap in head's
    // coordinates first, then whatever else takes head there to the merged state
    if (isEmptyMap(m.edges.ours)) return { ops: diff(head, m.doc, S), cards: m.conflicts, intent };
    const remap: Op = { op: "remap", path: ["#remap"], maps: m.edges.ours, ...(remapOps[0]!.lineage ? { lineage: remapOps[0]!.lineage } : {}) };
    const mapped = apply(fork(head, S), [remap], S);
    return { ops: [remap, ...diff(mapped, m.doc, S)], cards: m.conflicts, intent };
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
    // a keyframe becomes confirmed state: it must hash to what it claims (review finding 14)
    // a keyframe without a real digest is refused like a wrong one: nothing unchecked becomes confirmed state (round 2
    // finding 8)
    if (typeof kf.stateHash !== "string" || !/^[0-9a-f]{64}$/.test(kf.stateHash) || hashDoc(kf.doc, this.schema) !== kf.stateHash) throw new KeyframeMismatch(b, kf.seq);
    this.placeholderTop.set(b, kf.seq);
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
      else {
        (this.listed.get(b) ?? this.listed.set(b, new Map()).get(b)!).set(c.id, c.seq);
        this.confirmed(b, p, { id: c.id, seq: c.seq, rebase: c.rebase ?? 0 }, true);
      }
    }
    if (out.length) this.invalidate(b);
    return out;
  }
  /**
   * Whether this replica holds every row of `(lo, hi]` itself (no placeholder, not past head): then it can tell on
   * its own whether a change pushed on base `lo` was confirmed, and needn't claim that base in hello.
   */
  holdsRows(b: string, lo: number, hi: number): boolean {
    return hi <= this.headSeq(b) && lo >= (this.placeholderTop.get(b) ?? 0);
  }

  /**
   * The version a change made (L5: version ids are provisional until confirmed). Confirmed: `<branch>@<seq>`, final.
   * Pending: `<branch>@<head>+<n>` (the n-th change of the queue on top of the confirmed head), provisional: it moves
   * as rows arrive, and the share of a cut stays "syncing" until its sequencer has answered. null: unknown id.
   */
  versionId(b: string, id: string): { id: string; provisional: boolean } | null {
    const log = this.logs.get(b)!;
    for (let i = log.length - 1; i >= 0; i--) if (log[i]!.id === id) return { id: `${b}@${i + 1}`, provisional: false };
    const listed = this.listed.get(b)?.get(id);
    if (listed !== undefined) return { id: `${b}@${listed}`, provisional: false };
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
    return last(p.versions).ops.length === 0 && (p.rejecting !== undefined || !keepsWhenEmpty(p.history));
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
    // a change refused here whose withdraw is now answered: rejected, with the reason it was refused for, and
    // remembered, so its withdraw row is never read as an absorption later (round 4 finding 4)
    if (p.rejecting !== undefined) {
      this.refused.set(`${b}\u0000${p.id}`, p.rejecting);
      return this.emit({ type: "rejected", branchId: b, change: p, reason: p.rejecting });
    }
    const cards = p.versions.slice(1).flatMap((v) => v.cards);
    this.emit({ type: "absorbed", branchId: b, change: p, cards, withdrawn });
  }
  /**
   * Take back a change whose store write never kept it (the write that queued it failed a condition: a lease fence that
   * moved): never sent, it leaves the queue as if it had never been made, with no outcome (no notice, its id unspent, so
   * the process that holds the lease can still apply it), and the changes after it are rebased without it. false, and
   * nothing done, if a copy of it may have been sent: then it is withdrawn instead (rejectLocally).
   */
  unhold(b: string, id: string): boolean {
    const p = this.queues.get(b)!.find((x) => x.id === id);
    if (!p?.held) return false;
    delete p.held;
    return true;
  }
  unqueue(b: string, id: string): boolean {
    const queue = this.queues.get(b)!;
    const p = queue.find((x) => x.id === id);
    if (!p) return true;
    if (p.sentBases.length || p.sends) return false;
    this.queues.set(b, queue.filter((x) => x !== p));
    this.invalidate(b);
    this.rebaseAll(b);
    return true;
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
  /** Why a change whose withdraw row is in the log was refused here, if it was (it was never absorbed). */
  refusedReason(b: string, id: string): string | undefined {
    return this.refused.get(`${b}\u0000${id}`);
  }
  /**
   * Refuse a pending change here (too large to send). Never sent: rejected at once. Sent before, a copy may still be
   * confirmed (H1): it is emptied but kept, so the pusher withdraws its id, and it is reported rejected only once the
   * withdraw is answered, or confirmed if an earlier copy was confirmed after all (round 3 finding 2). Either way the
   * changes after it are rebased without it.
   */
  rejectLocally(b: string, id: string, reason: string): void {
    const p = this.queues.get(b)!.find((x) => x.id === id);
    if (!p) return;
    if (!p.sentBases.length) {
      this.rejectPending(b, id, reason);
      return;
    }
    const v = last(p.versions);
    const nv: QueueVersion = {
      ...v,
      k: v.k + 1,
      ops: [],
      intent: null,
      hash: hashOps([], null),
      decl: declare(this.schema, v.baseDoc, [], null),
      supersedes: [...v.supersedes, `${p.id}#${v.k}`],
      cards: [],
    };
    p.versions.push(nv);
    this.versions.get(p.id)?.push(nv);
    p.rejecting = reason;
    this.rebaseAll(b);
  }
  /** "lww on structure" (H2): the change goes through merge3 from now on. */
  toMerge(b: string, id: string): boolean {
    const p = this.queues.get(b)!.find((x) => x.id === id);
    if (!p) return false;
    for (const v of p.versions) v.policy = "merge";
    return true;
  }
}

function pickHistory(h: HistoryFields | undefined): HistoryFields {
  const out: Record<string, unknown> = {};
  if (h) for (const k of HISTORY_KEYS) if (h[k] !== undefined) out[k] = h[k];
  return out as HistoryFields;
}

/** A keyframe whose document doesn't hash to its stateHash: never installed. */
export class KeyframeMismatch extends Error {
  readonly branchId: string;
  readonly seq: number;
  constructor(branchId: string, seq: number) {
    super(`keyframe ${branchId}@${seq} doesn't match its state hash`);
    this.branchId = branchId;
    this.seq = seq;
  }
}
