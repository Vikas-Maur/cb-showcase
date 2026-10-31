// A shared cut on one replica (PLAN §5.3, §6.2, §6.3, §12, §13, L5, L14): what Carton holds for each cut whose
// sequencer is a server. It joins the replica's confirmed log plus pending queue (`ReplicaQueue`) to its one pusher
// (`SyncClient`) behind the calls Carton, the lease holder and `cb` need:
// - `commit` queues a change (it is pushed at once when connected; confirmed when its row comes back);
// - `connect({ nonce })` starts pushing under the sync lease (fenced: if the lease's nonce changes, the client stops
//   for good); `disconnect({ drain })` stops, after the in-flight pushes are answered when draining (handover);
// - `state()` is `syncing`, `up-to-date`, `offline` (with the number of edits waiting), `connecting` or `stopped`,
//   with the status words of §0.1 ("Syncing", "Up to date", "Offline: N edits waiting");
// - one event stream: confirmed (with late cards), absorbed (with cards), rejected, remote rows, overwritten, presence
//   (with its cut), errors;
// - `waitFor(id, ms)`: what a `cb` write returns after up to 5 s (§6.2): confirmed@seq, conflicts, rejected, or still
//   pending.

import type { Transport } from "../plugins.ts";
import type { Schema } from "../schema.ts";
import type { Actor, ConfirmedChange, ConflictCard, Doc } from "../types.ts";
import { SyncClient, type SyncClientOptions, type SyncStatus, type Timers } from "./client.ts";
import type { PresenceState } from "./messages.ts";
import { ReplicaQueue, type CommitInput, type QueueBranch, type QueueEvent } from "./queue.ts";

export interface SyncState {
  status: SyncStatus;
  /** Edits made here and not yet confirmed by the sequencer. */
  pending: number;
  /** The words people see (§0.1): "Syncing", "Up to date", "Offline: 3 edits waiting", "Connecting", "Stopped". */
  label: string;
}

export type SharedCutEvent =
  | { type: "confirmed"; id: string; seq: number; lateCards: ConflictCard[] }
  | { type: "absorbed"; id: string; cards: ConflictCard[]; withdrawn: boolean }
  | { type: "rejected"; id: string; reason: string }
  | { type: "remote"; rows: ConfirmedChange[] }
  | { type: "overwritten"; id: string; by: string; author: unknown }
  | { type: "presence"; branchId: string; actor: unknown; state: PresenceState | null }
  | { type: "state"; state: SyncState }
  | { type: "error"; error: string };

/** What a write learns within its wait (§6.2, L14). */
export type WriteOutcome =
  | { status: "confirmed"; id: string; seq: number }
  | { status: "conflicts"; id: string; seq?: number; cards: ConflictCard[]; absorbed?: boolean }
  | { status: "rejected"; id: string; reason: string }
  | { status: "pending"; id: string };

export interface SharedCutOptions {
  /** The replica's queue; one per replica, shared by all its cuts. Made from `schema` when absent. */
  queue?: ReplicaQueue;
  schema?: Schema;
  /** The cut, when the queue doesn't hold it yet: its record, its state at seq 0 and the rows this replica has. */
  branch: QueueBranch;
  doc0?: Doc;
  rows?: readonly ConfirmedChange[];
  transport: Transport;
  url: string;
  token: string | (() => Promise<string>);
  schemaVersion: number;
  /** Passed through to the SyncClient (timers, a defer hook, K, the hand-off payload, presence…). */
  client?: Omit<SyncClientOptions, "queue" | "branchId" | "connect" | "schemaVersion" | "fence" | "onEvent">;
}

const label = (s: SyncStatus, pending: number): string =>
  s === "up-to-date" ? "Up to date" : s === "syncing" ? "Syncing" : s === "offline" ? `Offline: ${pending} edit${pending === 1 ? "" : "s"} waiting` : s === "connecting" ? "Connecting" : "Stopped";

export class SharedCut {
  readonly queue: ReplicaQueue;
  readonly branchId: string;
  private readonly o: SharedCutOptions;
  private client: SyncClient | null = null;
  private readonly listeners = new Set<(e: SharedCutEvent) => void>();
  private readonly waiters = new Map<string, ((o: WriteOutcome) => void)[]>();
  private readonly outcomes = new Map<string, WriteOutcome>();
  private readonly unsubscribe: () => void;
  private lastState: SyncState;

  constructor(o: SharedCutOptions) {
    this.o = o;
    if (!o.queue && !o.schema) throw new Error("SharedCut: pass the replica's queue or a schema");
    this.queue = o.queue ?? new ReplicaQueue(o.schema!);
    this.branchId = o.branch.id;
    if (!this.queue.branchIds().includes(this.branchId)) {
      if (!o.doc0) throw new Error(`SharedCut: the queue doesn't hold ${this.branchId}; pass its doc0`);
      this.queue.addBranch(o.branch, o.doc0, o.rows ?? []);
    }
    this.lastState = this.computeState();
    this.unsubscribe = this.queue.on((e) => this.onQueue(e));
  }

  // ---------------------------------------------------------------- writing
  /** Queue a change on this cut. Returns at once: `pending` (or `confirmed` when the cut is still local). */
  commit(input: CommitInput): ReturnType<ReplicaQueue["commit"]> {
    const r = this.queue.commit(this.branchId, input);
    this.refreshState();
    return r;
  }
  /**
   * The outcome of change `id` within `ms` (a `cb` write waits up to 5 s, §6.2): confirmed@seq, conflicts (late cards,
   * or absorbed with cards), rejected (validation), or still pending.
   */
  waitFor(id: string, ms: number): Promise<WriteOutcome> {
    const known = this.outcomes.get(id);
    if (known) return Promise.resolve(known);
    const v = this.queue.versionId(this.branchId, id);
    if (v && !v.provisional) return Promise.resolve({ status: "confirmed", id, seq: Number(v.id.slice(v.id.lastIndexOf("@") + 1)) });
    return new Promise((res) => {
      const list = this.waiters.get(id) ?? [];
      list.push(res);
      this.waiters.set(id, list);
      this.timers().setTimeout(() => {
        const l = this.waiters.get(id);
        if (!l?.includes(res)) return;
        l.splice(l.indexOf(res), 1);
        res({ status: "pending", id });
      }, ms);
    });
  }

  // ---------------------------------------------------------------- the lease holder's controls
  /**
   * Start syncing under the sync lease `nonce` (§6.2). `fence()` is asked before every step that touches the queue:
   * once it answers false (another process took the lease) the client stops for good. Resolves once caught up, or
   * after `timeoutMs` (default 5 s) with whether it caught up.
   */
  async connect({ nonce, fence, timeoutMs = 5000 }: { nonce: string; fence?: (nonce: string) => boolean; timeoutMs?: number }): Promise<boolean> {
    if (this.client && !this.client.stopped) return this.client.whenCaughtUp(timeoutMs);
    const { transport, url, token } = this.o;
    this.client = new SyncClient({
      ...(this.o.client ?? {}),
      queue: this.queue,
      branchId: this.branchId,
      schemaVersion: this.o.schemaVersion,
      connect: async () => transport.connect(url, { token: typeof token === "string" ? token : await token() }),
      ...(fence ? { fence: () => fence(nonce) } : {}),
      onEvent: (e) => {
        if (e.type === "status") this.refreshState();
        else if (e.type === "presence") this.emit({ type: "presence", branchId: this.branchId, actor: e.actor, state: e.state });
        else if (e.type === "overwritten") this.emit({ type: "overwritten", id: e.id, by: e.by, author: e.author });
        else if (e.type === "error") this.emit({ type: "error", error: e.error });
      },
    }).start();
    this.refreshState();
    return this.client.whenCaughtUp(timeoutMs);
  }
  /**
   * Stop syncing. With `drain`, push nothing new and wait (up to `timeoutMs`) until every in-flight push and withdraw
   * has been answered, as a lease handover requires (§6.2: the helper finishes its in-flight push, then releases).
   */
  async disconnect({ drain = false, timeoutMs = 5000 }: { drain?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const c = this.client;
    if (!c) return;
    if (drain && !c.stopped) {
      c.quiesce();
      const until = Date.now() + timeoutMs;
      while (!c.drained() && !c.stopped && Date.now() < until) await new Promise<void>((r) => this.timers().setTimeout(r, 10));
    }
    c.stop("disconnected");
    this.client = null;
    this.refreshState();
  }
  sendPresence(actor: Actor, state: PresenceState | null): void {
    this.client?.sendPresence(actor, state);
  }
  /** The live SyncClient (null while disconnected), for diagnostics and tests. */
  get sync(): SyncClient | null {
    return this.client;
  }

  // ---------------------------------------------------------------- state and events
  state(): SyncState {
    return this.lastState;
  }
  on(listener: (e: SharedCutEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Forget this cut's listeners and stop syncing (the queue keeps its log and pending changes). */
  close(): void {
    this.client?.stop("closed");
    this.client = null;
    this.unsubscribe();
    this.listeners.clear();
  }

  private computeState(): SyncState {
    const pending = this.queue.pending(this.branchId).length;
    const c = this.client;
    let status: SyncStatus = c ? c.status : "offline";
    if (status === "up-to-date" && pending) status = "syncing";
    return { status, pending, label: label(status, pending) };
  }
  private refreshState(): void {
    const s = this.computeState();
    if (s.status === this.lastState.status && s.pending === this.lastState.pending) return;
    this.lastState = s;
    this.emit({ type: "state", state: s });
  }
  private emit(e: SharedCutEvent): void {
    for (const l of this.listeners) l(e);
  }
  private settle(id: string, o: WriteOutcome): void {
    this.outcomes.set(id, o);
    if (this.outcomes.size > 1000) this.outcomes.delete(this.outcomes.keys().next().value!);
    for (const w of this.waiters.get(id)?.splice(0) ?? []) w(o);
    this.waiters.delete(id);
  }
  private onQueue(e: QueueEvent): void {
    if (e.branchId !== this.branchId) return;
    switch (e.type) {
      case "confirmed": {
        const cards = [...e.change.cards, ...e.lateCards];
        this.settle(e.row.id, cards.length ? { status: "conflicts", id: e.row.id, seq: e.row.seq, cards } : { status: "confirmed", id: e.row.id, seq: e.row.seq });
        this.emit({ type: "confirmed", id: e.row.id, seq: e.row.seq, lateCards: e.lateCards });
        break;
      }
      case "local-confirmed":
        this.settle(e.row.id, { status: "confirmed", id: e.row.id, seq: e.row.seq });
        this.emit({ type: "confirmed", id: e.row.id, seq: e.row.seq, lateCards: [] });
        break;
      case "absorbed": {
        const cards = [...e.change.cards, ...e.cards];
        this.settle(e.change.id, cards.length ? { status: "conflicts", id: e.change.id, cards, absorbed: true } : { status: "confirmed", id: e.change.id, seq: this.queue.headSeq(this.branchId) });
        this.emit({ type: "absorbed", id: e.change.id, cards: e.cards, withdrawn: e.withdrawn });
        break;
      }
      case "rejected":
        this.settle(e.change.id, { status: "rejected", id: e.change.id, reason: e.reason });
        this.emit({ type: "rejected", id: e.change.id, reason: e.reason });
        break;
      case "remote":
        this.emit({ type: "remote", rows: e.rows });
        break;
    }
    this.refreshState();
  }
  private timers(): Timers {
    return this.o.client?.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }
}

/** A shared cut over a Transport: `new SharedCut(opts)`. */
export function createSharedCut(opts: SharedCutOptions): SharedCut {
  return new SharedCut(opts);
}

