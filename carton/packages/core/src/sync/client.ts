// The sync client (PLAN §6.2, §6.3, §12, §5.3): the one pusher of a replica (only the sync-lease holder runs one).
// Port of system-v11 `sync.mjs`, with PLAN v14's fixes.
// - Pipelined: every pending change is pushed as soon as it exists, with base = (confirmed seq, earlier pending ids).
// - A reject kills the rest of that epoch on the server. The client is already rebased on the rows it received (they
//   reach it before the reject, FIFO), so it resubmits its whole queue in a new epoch.
// - "behind" (the K cap): drop the ids the reject lists as confirmed, then rebase the whole queue on head and push it
//   with every base = head, so a long offline burst can't livelock (§6.3). If head itself is more than K behind the
//   server, catch up first (a keyframe plus the tail).
// - "lww on structure": resubmit as `merge`, never drop (H2). Validation rejects leave the queue as rejected.
// - An absorbed change (empty after a rebase) is withdrawn if any copy of it may have been sent (H1), and absorbed only
//   when the server confirms the withdraw (or that an older copy was confirmed after all: then it is confirmed).
// - Fencing (R5-06): every step that touches the queue first asks `fence()`; if this client no longer holds the sync
//   lease it stops for good and never touches the queue again.
// - Hand-off (§5.3): while the branch is `handingOff`, ask `branchStatus` first; upload only if the server doesn't have
//   the branch; become `server{since: n}` only on the server's answer. Never resume local sequencing alone.
// - With a blob store (`blobs`), any message over 1 MiB either way travels as an envelope (`envelope.ts`), in order.

import type { BlobStore, TransportConnection } from "../plugins.ts";
import type { Change, ConfirmedChange, Doc } from "../types.ts";
import { hashDoc } from "../engine/index.ts";
import type { AdoptMsg, ClientMessage, PendingClaim, PresenceState, ServerMessage } from "./messages.ts";
import { VALIDATION_REASONS, PROTOCOL } from "./messages.ts";
import { KeyframeMismatch, last, type QueuedChange, type ReplicaQueue } from "./queue.ts";
import { ENVELOPE_BYTES, Inbox, Outbox, clientEnvelopeKey, jsonBytesBound, oversized, seal, unseal } from "./envelope.ts";
import type { ConfirmedId } from "./messages.ts";

export type SyncStatus = "offline" | "connecting" | "syncing" | "up-to-date" | "stopped";

export type SyncEvent =
  | { type: "status"; status: SyncStatus }
  | { type: "online" }
  | { type: "offline"; why: string }
  | { type: "keyframe"; seq: number }
  | { type: "shared"; since: number }
  | { type: "overwritten"; id: string; by: string; author: unknown }
  | { type: "presence"; branchId: string; actor: unknown; state: PresenceState | null }
  | { type: "push"; ids: string[]; epoch: number }
  | { type: "withdraw"; id: string; epoch: number }
  | { type: "reject"; id: string | undefined; reason: string; epoch: number }
  | { type: "rebase"; n: number }
  | { type: "stopped"; why: string }
  | { type: "error"; error: string };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncClientOptions {
  queue: ReplicaQueue;
  branchId: string;
  /** Open a connection to the branch's host (Transport.connect with a fresh token). */
  connect: () => Promise<TransportConnection>;
  schemaVersion: number;
  /** K, the server's behind cap (default 100). */
  maxBehind?: number;
  /** false: one push message in flight at a time (a sensitivity row of the load test). Default true. */
  pipeline?: boolean;
  backoffMs?: number;
  timers?: Timers;
  /**
   * Run `fn` after `costMs` of the pusher's work (a rebase holds the engine thread). Default: soon, on a timer. The
   * simulation passes its engine thread here.
   */
  defer?: (fn: () => void, costMs: number) => void;
  /** Cost of rebasing one pending change, ms (only used to size `defer`). Default 0. */
  rebaseCostMs?: number;
  /** True while this client still holds the sync lease (R5-06). Checked before every step that touches the queue. */
  fence?: () => boolean;
  /** For the hand-off upload: the rows 1..n, the state at the root and the ancestry closure (§5.3). */
  adoptPayload?: () => Pick<AdoptMsg, "rows" | "rec" | "doc0" | "closure"> & { rootSeq?: number };
  onEvent?: (e: SyncEvent) => void;
  /** Called after confirmed rows were integrated (incremental soft validators, GUI adopt, materializer). */
  afterIntegrate?: (res: { mine: ConfirmedChange[]; others: ConfirmedChange[] }) => void;
  /** Fault injection for tests: rewrite each change just before it is sent. */
  tamper?: (ch: Change) => Change;
  clock?: () => number;
  /**
   * The blob store the host's sequencer uses (or a client for it): messages over `envelopeBytes` (1 MiB) either way
   * travel through it as envelopes. Without it every message goes inline, whatever its size.
   */
  blobs?: BlobStore;
  envelopeBytes?: number;
  /** The largest message this client fetches from an envelope (default 1 GiB). */
  maxEnvelopeBytes?: number;
  /**
   * The largest message this client sends, until the server says its own (`WelcomeMsg.maxMessageBytes`): default 64
   * MiB with `blobs` (the server's envelope limit), 32 MiB without (a WebSocket frame). A change bigger than this is
   * rejected locally ("too large"); pushes over it together go in several messages.
   */
  maxMessageBytes?: number;
}

let CONN = 0;
/** Refusals about the connection (its token, its branch), not the change: the same on every message it sends. */
const CONNECTION_REASONS: ReadonlySet<string> = new Set(["forbidden", "read-only branch", "unknown branch", "foreign id"]);

export class SyncClient {
  readonly queue: ReplicaQueue;
  readonly branchId: string;
  private readonly o: SyncClientOptions;
  private readonly timers: Timers;
  private readonly K: number;
  epoch = 0;
  private conn: TransportConnection | null = null;
  private connId = 0;
  /** The largest client message the server reads, from its welcome. */
  private serverLimit: number | null = null;
  /** The current connection's outgoing side: keeps order around envelope uploads. */
  private out: Outbox<ClientMessage> | null = null;
  stopped = false;
  stopReason: string | null = null;
  caughtUp = false;
  private quiesced = false;
  private retry: unknown = null;
  private waiters: ((ok: boolean) => void)[] = [];
  private statusListeners: ((s: SyncStatus) => void)[] = [];
  private _status: SyncStatus = "offline";
  /** The server found some claims beyond its per-message cap: their lists so far, merged into the final answer. */
  private confirmedSoFar: ConfirmedId[] = [];
  /** A keyframe failed its hash on this connection: catch up by rows only. */
  private noKeyframe = false;
  /** For hand-off tests: send the upload twice (a retry that crosses the first answer). */
  forceAdoptTwice = false;
  /** For hand-off tests: upload again on the next connection instead of asking `branchStatus` first. */
  reuploadOnReconnect = false;
  tamper: ((ch: Change) => Change) | undefined;
  readonly stats = { pushMsgs: 0, changesSent: 0, rejects: 0, acks: 0, duplicates: 0, rebases: 0, reconnects: 0, withdraws: 0, envelopesSent: 0, envelopesReceived: 0 };

  private unsubscribe: (() => void) | null = null;

  constructor(opts: SyncClientOptions) {
    this.o = opts;
    this.queue = opts.queue;
    this.branchId = opts.branchId;
    this.K = opts.maxBehind ?? 100;
    this.timers = opts.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.tamper = opts.tamper;
    // a local commit joins the queue: push it soon (after the committing task), without the owner having to call pump
    this.unsubscribe = this.queue.on((e) => {
      if (e.type === "pending" && e.branchId === this.branchId && !this.stopped) {
        if (this._status === "up-to-date") this.setStatus("syncing"); // an unconfirmed edit is never "up to date" (finding 20)
        this.defer(() => this.pump(), 0);
      }
    });
  }

  get status(): SyncStatus {
    return this._status;
  }
  private setStatus(s: SyncStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.emit({ type: "status", status: s });
    for (const l of this.statusListeners) l(s);
  }
  onStatus(l: (s: SyncStatus) => void): () => void {
    this.statusListeners.push(l);
    return () => (this.statusListeners = this.statusListeners.filter((x) => x !== l));
  }
  private emit(e: SyncEvent): void {
    this.o.onEvent?.(e);
  }
  get online(): boolean {
    return !!this.conn?.open && this.caughtUp;
  }

  start(): this {
    void this.connectLoop();
    return this;
  }
  stop(why = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = why;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retry !== null) this.timers.clearTimeout(this.retry);
    const c = this.conn;
    this.conn = null;
    c?.close();
    this.setStatus("stopped");
    this.emit({ type: "stopped", why });
    for (const w of this.waiters.splice(0)) w(false);
  }
  whenCaughtUp(timeoutMs: number): Promise<boolean> {
    if (this.online) return Promise.resolve(true);
    return new Promise((res) => {
      // cleared once answered: a settled wait never keeps the process alive
      const timer = this.timers.setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        res(this.online);
      }, timeoutMs);
      const done = (ok: boolean) => {
        this.timers.clearTimeout(timer);
        res(ok);
      };
      this.waiters.push(done);
    });
  }
  /** Run `fn` only while this client holds the lease; otherwise stop for good (R5-06). */
  private fenced(fn: () => void): boolean {
    if (this.stopped) return false;
    if (this.o.fence && !this.o.fence()) {
      this.stop("fenced: lease nonce changed");
      return false;
    }
    fn();
    return true;
  }
  /** Run `fn` after `n` pending changes' worth of rebase work (n = 0: just after the current task). */
  private defer(fn: () => void, n: number): void {
    const cost = n === 0 ? 0 : (this.o.rebaseCostMs ?? 0) * n;
    if (this.o.defer) this.o.defer(fn, cost);
    else this.timers.setTimeout(fn, cost);
  }

  // ---------------------------------------------------------------- connection
  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      this.setStatus("connecting");
      let c: TransportConnection | null = null;
      try {
        c = await this.o.connect();
      } catch {
        c = null;
      }
      if (this.stopped) {
        c?.close();
        return;
      }
      if (c?.open) {
        this.conn = c;
        this.connId = ++CONN;
        this.epoch++;
        this.caughtUp = false;
        this.confirmedSoFar = [];
        this.noKeyframe = false;
        this.stats.reconnects++;
        const id = this.connId;
        const conn = c;
        this.out = new Outbox((m) => conn.send(m));
        const blobs = this.o.blobs;
        const inbox = new Inbox<ServerMessage>({
          deliver: (m) => this.onMessage(id, m),
          open: async (ref) => {
            if (!blobs) throw new Error("an envelope, and no blob store to read it from");
            const m = await unseal(ref, blobs, { from: "server", maxBytes: this.o.maxEnvelopeBytes ?? 1 << 30 });
            this.stats.envelopesReceived++;
            return m;
          },
          fail: (e) => this.drop(id, `envelope: ${e instanceof Error ? e.message : String(e)}`),
        });
        c.onMessage((m) => inbox.receive(m));
        c.onClose((why) => this.onClose(id, why));
        this.setStatus("syncing");
        this.onOpen();
        return;
      }
      c?.close();
      this.setStatus("offline");
      await new Promise<void>((r) => (this.retry = this.timers.setTimeout(r, this.o.backoffMs ?? 500)));
      this.retry = null;
    }
  }
  private onClose(id: number, why: string): void {
    if (id !== this.connId || !this.conn) return;
    this.conn = null;
    this.caughtUp = false;
    this.setStatus("offline");
    this.emit({ type: "offline", why });
    if (!this.stopped) this.retry = this.timers.setTimeout(() => ((this.retry = null), void this.connectLoop()), this.o.backoffMs ?? 500);
  }
  /** Drop connection `id` (a lost message: the server couldn't read an envelope, or we couldn't): reconnect, catch up. */
  private drop(id: number, why: string): void {
    const c = this.conn;
    if (id !== this.connId || !c) return;
    this.onClose(id, why);
    c.close();
  }
  private send(m: ClientMessage): void {
    if (!this.conn || !this.out) return;
    const blobs = this.o.blobs;
    const big = blobs ? oversized(m, this.o.envelopeBytes ?? ENVELOPE_BYTES) : null;
    if (!big) return this.out.push(m);
    this.stats.envelopesSent++;
    const now = (this.o.clock ?? Date.now)();
    this.out.push(m, seal(big, blobs!, (sha) => clientEnvelopeKey(sha, now)));
  }
  private onOpen(): void {
    const br = this.queue.branch(this.branchId);
    if (br.sequencer.kind === "handingOff" && this.reuploadOnReconnect && this.stats.reconnects > 1) this.upload();
    else if (br.sequencer.kind === "handingOff") this.send({ type: "branchStatus", branchId: this.branchId });
    else this.send(this.hello());
  }
  /**
   * hello (§6.3, R10-01, R10-02): what we have, every pending id we sent with every base we sent it on (so the server
   * lists those it already confirmed, scanning (b, b + K + 1] per base), and every rid this replica has used.
   */
  private hello(onlyFrom = -1): ClientMessage {
    const b = this.branchId;
    const pending: PendingClaim[] = [];
    for (const p of this.queue.pending(b)) {
      // a base whose whole range (b, b + K + 1] this replica holds as rows needs no claim: had that push been
      // confirmed, its row would be here and the change would have left the queue (keeps hellos small, finding 10)
      const bases = p.sentBases.filter((x) => x >= onlyFrom && !this.queue.holdsRows(b, x, x + this.K + 1));
      if (bases.length) pending.push({ id: p.id, bases });
    }
    const m: ClientMessage = { type: "hello", branchId: b, have: this.queue.headSeq(b), pending, rids: [...this.queue.rids], schemaVersion: this.o.schemaVersion, protocol: PROTOCOL };
    if (this.noKeyframe) m.noKeyframe = true;
    if (this.o.blobs) m.envelopes = true;
    return m;
  }
  private adoptKey(): string | null {
    const s = this.queue.branch(this.branchId).sequencer;
    return s.kind === "handingOff" ? `${this.branchId}|${s.n}|${s.stateHash}` : null;
  }
  private upload(): void {
    const s = this.queue.branch(this.branchId).sequencer;
    if (s.kind !== "handingOff" || !this.o.adoptPayload) return;
    const payload = this.o.adoptPayload();
    const msg: AdoptMsg = { type: "adopt", branchId: this.branchId, n: s.n, stateHash: s.stateHash, ...payload };
    if (payload.doc0) msg.rootHash = hashDoc(payload.doc0, this.queue.schema);
    if (oversized(msg, this.messageLimit())) {
      // never sent to be refused: the owner learns now (sharing without history uploads only the current state)
      this.emit({ type: "error", error: `this cut's upload is over the server's limit of ${this.messageLimit()} bytes: share it without history` });
      return;
    }
    this.send(msg);
    if (this.forceAdoptTwice) {
      this.forceAdoptTwice = false;
      this.send(msg);
    }
  }
  private becomeServer(since: number): void {
    this.fenced(() => {
      const br = this.queue.branch(this.branchId);
      if (br.sequencer.kind === "handingOff") this.queue.setSequencer(this.branchId, { kind: "server", since });
      this.emit({ type: "shared", since });
    });
    this.send(this.hello());
  }

  // ---------------------------------------------------------------- messages
  private onMessage(id: number, m: ServerMessage): void {
    if (id !== this.connId || this.stopped) return;
    const b = this.branchId;
    switch (m.type) {
      case "status": {
        // the limit, before the hand-off's upload (round 3 finding 6)
        if (m.maxMessageBytes && this.o.blobs) this.serverLimit = m.maxMessageBytes;
        if (this.queue.branch(b).sequencer.kind !== "handingOff") return;
        if (m.adopted && m.adoptKey === this.adoptKey()) return this.becomeServer(m.since ?? 0);
        if (!m.adopted) return this.upload();
        return this.emit({ type: "error", error: "branch id already adopted with another log" });
      }
      case "adopted":
        if (this.queue.branch(b).sequencer.kind !== "handingOff") return;
        return this.becomeServer(m.since);
      case "hello":
      case "changes":
        if (m.type === "hello" && m.maxMessageBytes && this.o.blobs) this.serverLimit = m.maxMessageBytes;
        this.fenced(() => {
          if (m.branchId !== b) return;
          if (m.type === "hello" && m.uncheckedFrom !== undefined) {
            // the server checked only part of our claims: keep what it found, ask for the rest, act on nothing yet
            this.confirmedSoFar.push(...m.confirmed);
            return this.send(this.hello(m.uncheckedFrom));
          }
          const confirmed = m.type === "hello" ? [...this.confirmedSoFar.splice(0), ...m.confirmed] : [];
          if (m.type === "changes" && m.rows.length && m.rows[0]!.seq > this.queue.headSeq(b) + 1) return this.resync("a gap in the rows");
          try {
            // keyframe catch-up: jump, drop the pending ids already confirmed in the jumped stretch (R10-01), then
            // rebase the rest of the queue onto the keyframe before the tail
            if (m.type === "hello" && m.keyframe && this.queue.jumpTo(b, m.keyframe)) {
              this.queue.confirmFromList(b, confirmed);
              this.queue.rebaseAll(b);
              this.emit({ type: "keyframe", seq: m.keyframe.seq });
            } else if (confirmed.length) this.queue.confirmFromList(b, confirmed);
          } catch (e) {
            if (!(e instanceof KeyframeMismatch)) throw e;
            this.emit({ type: "error", error: e.message });
            this.noKeyframe = true; // catch up by rows only (finding 14)
            return this.resync("a keyframe failed its hash");
          }
          const pendingBefore = this.queue.pending(b).length;
          let res: ReturnType<ReplicaQueue["integrate"]>;
          try {
            res = this.queue.integrate(b, m.rows);
          } catch (e) {
            return this.resync(e instanceof Error ? e.message : String(e)); // rows out of order: catch up again (finding 3)
          }
          if (res.others.length && pendingBefore) {
            this.stats.rebases += this.queue.pending(b).length;
            this.emit({ type: "rebase", n: this.queue.pending(b).length });
          }
          this.o.afterIntegrate?.(res);
          if (m.type === "hello") {
            if (m.more) return this.send(this.hello()); // more rows to catch up on
            this.caughtUp = true;
            this.setStatus(this.queue.pending(b).length ? "syncing" : "up-to-date");
            for (const w of this.waiters.splice(0)) w(true);
            this.emit({ type: "online" });
          }
          this.pump();
        });
        return;
      case "ack": {
        this.stats.acks++;
        if (m.duplicate) this.stats.duplicates++;
        if (m.withdrawn) {
          // the id is spent (H1): the change is absorbed for good
          this.fenced(() => {
            const p = this.queue.pending(b).find((x) => x.id === m.id);
            if (p) this.queue.finishAbsorb(b, p, true);
            this.pump();
          });
        }
        if (m.keyframeWanted !== undefined) this.uploadKeyframe(m.keyframeWanted);
        if (this.caughtUp && !this.queue.pending(b).length) this.setStatus("up-to-date");
        return;
      }
      case "reject": {
        if (m.epoch !== this.epoch) return;
        this.stats.rejects++;
        this.epoch++; // everything still in flight from the dead epoch is dropped by the server; resend all
        this.emit({ type: "reject", id: m.id, reason: m.reason, epoch: m.epoch });
        if (VALIDATION_REASONS.has(m.reason)) {
          this.fenced(() => {
            const p = m.id ? this.queue.pending(b).find((x) => x.id === m.id) : undefined;
            if (p && this.queue.isEmpty(p)) {
              // an emptied change (absorbed, or refused here) is only withdrawn: nothing about it is decided by a
              // refusal, since a copy sent earlier may still be confirmed (round 4 finding 1). One this connection may
              // not make (its token, its branch) isn't sent again on it; any other answered a push refused for its
              // content, and the change is withdrawn in the new epoch.
              if (CONNECTION_REASONS.has(m.reason)) {
                p.withdrawRefused = this.connId;
                this.emit({ type: "error", error: `withdraw of ${m.id} refused (${m.reason}): it stays pending` });
              }
            } else if (m.id) this.queue.rejectPending(b, m.id, m.reason); // the rest is rebased without it
            this.defer(() => this.pump(), 1);
          });
          return;
        }
        this.fenced(() => {
          const n = this.queue.pending(b).length;
          if (m.reason === "lww on structure" && m.id) {
            this.queue.toMerge(b, m.id); // H2: through merge3, never dropped
          } else if (m.reason === "behind") {
            if (m.uncheckedFrom !== undefined) {
              // an incomplete list: never rebase on it; catch up with hello, which asks for the rest
              this.caughtUp = false;
              this.send(this.hello());
              return;
            }
            this.queue.confirmFromList(b, m.confirmed);
            if (m.head - this.queue.headSeq(b) > this.K) {
              // our own head is too far behind to push from: catch up (a keyframe plus the tail), which rebases
              this.caughtUp = false;
              this.send(this.hello());
              return;
            }
            this.queue.rebaseAll(b);
          }
          this.stats.rebases += n;
          this.emit({ type: "rebase", n });
          this.defer(() => this.pump(), Math.max(1, n)); // the rebase holds the pusher, then the resubmission
        });
        return;
      }
      case "overwritten":
        return this.emit({ type: "overwritten", id: m.id, by: m.by, author: m.author });
      case "presence":
        return this.emit({ type: "presence", branchId: m.branchId, actor: m.actor, state: m.state });
      case "unknownBranch":
        return this.emit({ type: "error", error: "unknown branch" });
      case "adoptError":
        return this.emit({ type: "error", error: m.reason });
      case "error":
        if (m.reconnect) this.drop(id, m.reason);
        return this.emit({ type: "error", error: m.reason });
    }
  }

  /** Catch up again from what we hold (a gap, a bad keyframe): hello, and no pushes until it is answered. */
  private resync(why: string): void {
    this.caughtUp = false;
    this.setStatus("syncing");
    this.emit({ type: "offline", why: `resync: ${why}` });
    this.send(this.hello());
  }

  private uploadKeyframe(seq: number): void {
    if (seq > this.queue.headSeq(this.branchId)) return;
    let doc: Doc;
    try {
      doc = this.queue.confirmedState(this.branchId, seq);
    } catch {
      return; // not held (inside a jumped stretch): someone else will upload it
    }
    const msg: ClientMessage = { type: "keyframe", branchId: this.branchId, keyframe: { seq, stateHash: hashDoc(doc, this.queue.schema), doc } };
    if (oversized(msg, this.messageLimit())) return; // keyframes are optional: another replica, or rows, serve instead
    this.send(msg);
  }

  sendPresence(actor: Change["author"], state: PresenceState | null): void {
    if (this.conn?.open) this.send({ type: "presence", branchId: this.branchId, actor, state });
  }

  // ---------------------------------------------------------------- pushing
  private inFlight(p: QueuedChange): boolean {
    return p.sentConn === this.connId && p.sentEpoch === this.epoch;
  }
  /** Fenced dequeue: withdraw what was absorbed, then send every pending change not yet sent in this epoch, in order. */
  pump(): void {
    if (!this.conn?.open || !this.caughtUp || this.stopped || this.quiesced) return;
    const b = this.branchId;
    if (this.queue.branch(b).sequencer.kind !== "server") return;
    this.fenced(() => this.pushPending(b));
    // a validation reject or a local absorption can empty the queue with no ack to come: up to date now (round 2
    // finding 9)
    if (!this.stopped && this._status === "syncing" && !this.queue.pending(b).length) this.setStatus("up-to-date");
  }
  /** Withdraw what was absorbed, then send every pending change not yet sent in this epoch, in order. */
  private pushPending(b: string): void {
    const head = this.queue.headSeq(b);
    for (const p of [...this.queue.pending(b)]) {
      if (!this.queue.isEmpty(p)) continue;
      if (!p.sentBases.length) {
        this.queue.absorbLocally(b, p); // never sent: no copy can exist anywhere
        continue;
      }
      if (p.withdrawSent?.conn === this.connId && p.withdrawSent.epoch === this.epoch) continue;
      if (p.withdrawRefused === this.connId) continue;
      p.withdrawSent = { conn: this.connId, epoch: this.epoch };
      // a withdraw lands in (head, head + K + 1] like a push: its base joins the claims a reconnect makes, so a lost
      // answer is found again rather than spent twice (round 4 finding 2)
      if (!p.sentBases.includes(head)) p.sentBases.push(head);
      this.stats.withdraws++;
      this.emit({ type: "withdraw", id: p.id, epoch: this.epoch });
      this.send({ type: "withdraw", branchId: b, id: p.id, base: head, epoch: this.epoch });
    }
    const pend = this.queue.pending(b);
    if (this.o.pipeline === false && pend.some((p) => !this.queue.isEmpty(p) && this.inFlight(p))) return;
    const limit = this.messageLimit();
    // the server reads whole messages: the push around the changes counts too (round 3 finding 1)
    const wrapper = { type: "push" as const, branchId: b, epoch: this.epoch, changes: [] as Change[] };
    const wrap = jsonBytesBound(wrapper, Infinity);
    const out: Change[] = [];
    const sizes: number[] = [];
    let tooLarge: string | null = null;
    for (const p of pend) {
      if (this.queue.isEmpty(p) || this.inFlight(p)) continue;
      const v = last(p.versions);
      let ch: Change = {
        id: p.id,
        hash: v.hash,
        author: p.author,
        branchId: b,
        base: v.base,
        ops: v.ops,
        intent: v.intent,
        kinds: v.kinds,
        policy: v.policy,
        at: p.created,
        rebase: v.k,
        supersedes: v.supersedes,
        paths: v.decl.paths,
        reads: v.decl.reads,
        spans: v.decl.spans,
        trackOrder: v.decl.trackOrder,
      };
      if (v.decl.structural !== undefined) ch.structural = v.decl.structural;
      if (p.history) Object.assign(ch, p.history); // fold-in and undo fields travel with the change (finding 13)
      if (this.tamper) ch = this.tamper(ch);
      // a change bigger than one message the server reads can never be confirmed: rejected here rather than sent and
      // stranded; the changes after it wait for the rebase without it (round 2 finding 2)
      const n = jsonBytesBound(ch, limit);
      if (wrap + n > limit && oversized({ ...wrapper, changes: [ch] }, limit)) {
        tooLarge = p.id;
        break;
      }
      p.sentEpoch = this.epoch;
      p.sentConn = this.connId;
      p.sentAt ??= (this.o.clock ?? Date.now)();
      p.sends++;
      if (!p.sentBases.includes(v.base.seq)) p.sentBases.push(v.base.seq);
      out.push(ch);
      sizes.push(n);
    }
    if (out.length) {
      this.stats.changesSent += out.length;
      this.emit({ type: "push", ids: out.map((c) => c.id), epoch: this.epoch });
      // changes over the limit together go in several messages, in order, in the same epoch; each message's size is
      // its wrapper plus its changes and their commas (a change alone was checked to fit above)
      let from = 0, size = wrap;
      for (let i = 0; i <= out.length; i++) {
        if (i === out.length || (i > from && size + sizes[i]! + 1 > limit)) {
          this.stats.pushMsgs++;
          this.send({ type: "push", branchId: b, epoch: this.epoch, changes: out.slice(from, i) });
          from = i;
          size = wrap;
        }
        if (i < out.length) size += sizes[i]! + 1;
      }
    }
    if (tooLarge) {
      // sent before (a copy may still be confirmed): withdrawn first, reported once the server answers (round 3
      // finding 2); never sent: rejected at once
      this.emit({ type: "reject", id: tooLarge, reason: "too large", epoch: this.epoch });
      this.queue.rejectLocally(b, tooLarge, "too large");
      this.defer(() => this.pump(), 1);
    }
  }
  /** The largest message we send: the server's, else ours (64 MiB with a blob store, 32 MiB without). */
  private messageLimit(): number {
    return this.serverLimit ?? this.o.maxMessageBytes ?? (this.o.blobs ? 64 << 20 : 32 << 20);
  }

  /** Handover / idle exit: push nothing new from now on. */
  quiesce(): void {
    this.quiesced = true;
  }
  /** Nothing of ours is in flight on the current connection (true when offline). */
  drained(): boolean {
    if (!this.conn?.open) return true;
    return this.queue.pending(this.branchId).every((p) => !this.inFlight(p) && !(p.withdrawSent?.conn === this.connId && p.withdrawSent.epoch === this.epoch));
  }
}
