// carton.db for one simulated machine (port of system-v11 `store.mjs`): the real `ReplicaQueue` (confirmed log plus
// pending queue, from `@carton/core`) plus the local tables the prototype modelled around it: pins with owner sets
// (§5.2), notices (§6.2), the sync lease (§6.2) and per-view metadata (§6.4). One store per machine, shared by every
// process on it (worker, helper, cb). Transactions are atomic at a virtual instant.

import { sync } from "@carton/core";
import type { Doc, RemapMaps } from "@carton/core";
import { S, applyOps, hashDoc } from "./adapter.ts";

export interface PinRow {
  b: string;
  seq: number;
  kind: "pending" | "state";
  pend?: { id: string; k: number }[];
  state?: Doc;
  stateHash: string;
  owners: Map<string, number>;
}
export interface Lease {
  pid: number;
  nonce: string;
  socket: string;
  beat: number;
}
export interface Notice {
  kind: string;
  text: string;
  changeId?: string;
  cards?: unknown[];
  delivered: boolean;
}
export interface ViewMeta {
  owner: string | null;
  header: string;
  nonce: string;
  lastPin: { contentHash: string; nonce: string | null; ref: string | null; state: Doc; causal: { seq: number; ids: string[] } | null } | null;
  printedAt: number;
  lastChange?: string;
}

export class SimStore extends sync.ReplicaQueue {
  readonly pins = new Map<string, PinRow>();
  readonly notices = new Map<string, Notice[]>();
  lease: Lease | null = null;
  readonly views = new Map<string, ViewMeta>();

  constructor() {
    super(S);
  }
  tx<T>(fn: (s: this) => T): T {
    return fn(this);
  }

  // ---- pins (§5.2): (branchId, seq, stateHash8) → how to rebuild the state, plus the full hash to check. Several
  // readers can pin one state (the shared file's header and an agent's print of the same head): a pin row keeps every
  // owner with its own expiry, and is gone only when the last owner releases it or expires.
  private pin(key: string, row: Omit<PinRow, "owners">, owner: string, expires: number): void {
    const cur = this.pins.get(key);
    if (cur) {
      cur.owners.set(owner, Math.max(cur.owners.get(owner) ?? -Infinity, expires));
      return;
    }
    this.pins.set(key, { ...row, owners: new Map([[owner, expires]]) });
  }
  pinOptimistic(b: string, owner: string, expires = Infinity): { ref: string; doc: Doc } {
    const o = this.optimistic(b);
    const full = hashDoc(o.doc);
    const seq = this.headSeq(b);
    const pend = this.pending(b).map((p) => ({ id: p.id, k: sync.last(p.versions).k }));
    this.pin(`${b}|${seq}|${full.slice(0, 8)}`, { b, seq, kind: "pending", pend, stateHash: full }, owner, expires);
    return { ref: this.refString(b, seq, full), doc: o.doc };
  }
  pinState(b: string, doc: Doc, owner: string, expires = Infinity): { ref: string; doc: Doc } {
    const full = hashDoc(doc);
    const seq = this.headSeq(b);
    this.pin(`${b}|${seq}|${full.slice(0, 8)}`, { b, seq, kind: "state", state: doc, stateHash: full }, owner, expires);
    return { ref: this.refString(b, seq, full), doc };
  }
  refString(b: string, seq: number, full: string): string {
    return `${this.branch(b).name}@${seq}~${full.slice(0, 8)} b:${b.slice(0, 8)}`;
  }
  /** A stale or unknown ref is an error, never a guess (§4.4, principle 9). */
  resolve(ref: string | null, now: number): { b: string; doc: Doc; pin: PinRow; causal: { seq: number; ids: string[] } | null } {
    const m = /^(\S+)@(\d+)~([0-9a-f]{8}) b:([0-9a-f-]{8})$/.exec(ref ?? "");
    if (!m) throw new Error(`state unknown: re-print (bad ref ${ref})`);
    const b = this.branchIds().find((id) => id.startsWith(m[4]!));
    const pin = b ? this.pins.get(`${b}|${m[2]}|${m[3]}`) : undefined;
    if (!b || !pin) throw new Error(`state unknown: re-print (${ref} is not pinned)`);
    if (![...pin.owners.values()].some((e) => e >= now)) throw new Error(`state unknown: re-print (${ref} expired)`);
    let doc: Doc;
    if (pin.kind === "state") doc = pin.state!;
    else {
      doc = this.confirmedState(b, pin.seq);
      for (const { id, k } of pin.pend!) {
        const v = this.versions.get(id)![k]!;
        if (v.ops.length) doc = this.apply(doc, v.ops);
      }
    }
    if (hashDoc(doc) !== pin.stateHash) throw new Error(`state unknown: re-print (${ref} rebuilt to a different state)`);
    return { b, doc, pin, causal: pin.kind === "pending" ? { seq: pin.seq, ids: pin.pend!.map((x) => x.id) } : null };
  }
  private apply(doc: Doc, ops: Parameters<typeof applyOps>[1]): Doc {
    return applyOps(doc, ops);
  }
  /**
   * The recorded remaps of every change in head that isn't in `causal` (confirmed rows up to seq, plus those ids), in
   * log order then queue order: what a merge against this base must treat as the concurrent side's intents (§7).
   * null when the causal past is unknown (the merge infers instead).
   */
  recordedSince(b: string, causal: { seq: number; ids: string[] } | null): RemapMaps[] | null {
    if (!causal) return null;
    const ids = new Set(causal.ids);
    const maps: RemapMaps[] = [];
    for (const r of this.rows(b)) {
      if (r.seq <= causal.seq) continue;
      if (r.placeholder) return null; // a stretch known only through a keyframe: its remaps are unknown, so infer
      if (!ids.has(r.id) && r.intent?.maps) maps.push(r.intent.maps);
    }
    for (const p of this.pending(b)) {
      const v = sync.last(p.versions);
      if (!ids.has(p.id) && v.intent?.maps) maps.push(v.intent.maps);
    }
    return maps;
  }
  releasePins(owner: string): void {
    for (const [k, p] of this.pins) if (p.owners.delete(owner) && p.owners.size === 0) this.pins.delete(k);
  }

  // ---- notices (§6.2): late conflicts and other news for an actor, delivered on its next call or Stop hook
  notice(actorId: string, n: Omit<Notice, "delivered">): void {
    const l = this.notices.get(actorId) ?? [];
    l.push({ ...n, delivered: false });
    this.notices.set(actorId, l);
  }
  takeNotices(actorId: string): Notice[] {
    const l = (this.notices.get(actorId) ?? []).filter((n) => !n.delivered);
    for (const n of l) n.delivered = true;
    return l;
  }
  peekNotices(actorId: string): Notice[] {
    return (this.notices.get(actorId) ?? []).filter((n) => !n.delivered);
  }
}

