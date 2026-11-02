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
// - A host's write limit (its daily write cap; `error` code `write-limit`): the server dropped the rest of the push's
//   epoch, so the queue is kept, nothing more is pushed (nor a hand-off uploaded) until the limit's time, the owner is
//   told in plain words when the edits will sync, and then they go again, with no reconnect.

import type { BlobStore, TransportConnection } from "../plugins.ts";
import type { Change, ConfirmedChange, Doc } from "../types.ts";
import { hashDoc } from "../engine/index.ts";
import type { AdoptMsg, ClientMessage, ClosureEntry, HistoryMsg, PendingClaim, Person, PersonRids, PresenceMsg, PresenceState, ServerMessage } from "./messages.ts";
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
  /**
   * `code`: a refusal's machine code (`ErrorMsg.code`), or a transport's for a failed connect (`connect: …`). `until`,
   * with `write-limit`: when the edits held back sync (ms, this client's clock).
   */
  | { type: "error"; error: string; code?: string; until?: number };

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
  /**
   * Reconnecting: the first retry after a drop waits `backoffMs` (default 500), as it always did; each further failure
   * in a row doubles the wait, with jitter (half to all of it), up to `maxBackoffMs` (default 15 s: no worse than a dead
   * link's 10 s connect timeout already made it), or up to `unauthorizedBackoffMs` (default 5 min) while the host refuses
   * the session, which retrying with the same token can't fix. A connection the host answers starts over. A fixed
   * half-second retry made a client whose session was refused try 86 times a minute against a deployed Worker, two
   * billed Worker requests each (the upgrade and the transport's probe): one stuck client, about 2.5 times the Workers
   * Free plan's daily requests (cf-lab). `maxBackoffMs` = `backoffMs` keeps the old fixed retry.
   */
  backoffMs?: number;
  maxBackoffMs?: number;
  unauthorizedBackoffMs?: number;
  /** Jitter's randomness (default Math.random; the simulation passes its seeded one). */
  random?: () => number;
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
  /** The person at this replica, sent in every hello and by `identify()` (windows-sync R3). */
  identity?: () => Person | null;
  /** People the server sent (its welcome's list, and each change to it), before the rows they come with. */
  onPeople?: (people: PersonRids[]) => void;
}

/** The most presence updates a client sends a second (§12: 10–20 Hz while dragging). */
export const PRESENCE_PER_SEC = 10;

let CONN = 0;
/** Refusals about the connection (its token, its branch), not the change: the same on every message it sends. */
const CONNECTION_REASONS: ReadonlySet<string> = new Set(["forbidden", "read-only branch", "unknown branch", "foreign id"]);

/**
 * One page of a branch's lineage added to what came before (SF1-8): an entry split across pages comes again with the
 * same branchId and rec, its later states only (`nodes` and `authors` with its first page), so entries concatenate by
 * branchId, in closure order.
 */
function mergeLineage(have: ClosureEntry[], page: readonly ClosureEntry[]): ClosureEntry[] {
  const out = have.slice();
  for (const e of page) {
    const i = out.findIndex((x) => x.branchId === e.branchId);
    if (i < 0) {
      out.push({ ...e, nodes: [...e.nodes], ...(e.states ? { states: [...e.states] } : {}), ...(e.authors ? { authors: [...e.authors] } : {}) });
      continue;
    }
    const x = out[i]!;
    const states = [...(x.states ?? []), ...(e.states ?? [])];
    const authors = [...(x.authors ?? []), ...(e.authors ?? [])];
    out[i] = { ...x, nodes: [...x.nodes, ...e.nodes], ...(states.length ? { states } : {}), ...(authors.length ? { authors } : {}) };
  }
  return out;
}

/** One key per actor in presence (`kind:id`; anything else by its JSON). */
const presenceKey = (a: unknown): string => {
  const x = a as { kind?: unknown; id?: unknown; agentId?: unknown } | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string") return JSON.stringify(a);
  // an agent's own id beside its person's: two agents of one person are two peers
  return typeof x.agentId === "string" ? `${String(x.kind)}:${x.id}:${x.agentId}` : `${String(x.kind)}:${x.id}`;
};

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
  /** This connection's server keeps people (its welcome had `people`): `identity` may be sent alone. */
  private peopleKept = false;
  private quiesced = false;
  private retry: unknown = null;
  private presenceAt = -Infinity;
  private presenceNext: { actor: Change["author"]; state: PresenceState | null } | null = null;
  private presenceTimer: unknown = null;
  /** The latest presence asked for, sent or not: shown again after a reconnect (review SF4-8). */
  private presenceLast: { actor: Change["author"]; state: PresenceState | null } | null = null;
  /** The connection whose first presence (not a leave) went out already, marked `arrived` (see presenceMsg). */
  private presenceSentOn = 0;
  /** Peers this connection shows (their last presence not a leave), by actor: told gone when it closes. */
  private shown = new Map<string, unknown>();
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
  /** Connection attempts that failed, or closed before the hello's answer, in a row (the backoff's exponent). */
  private failures = 0;
  /** The last failed connect's transport code (`unauthorized` backs off longer). */
  private lastFailure: string | undefined;
  /** A host's write limit holds pushes and the hand-off's upload until this timer fires (null: not held). */
  private limitTimer: unknown = null;
  /** The owner's notice of that limit, told again after a reconnect's welcome (which clears an owner's sync error). */
  private limitNotice: Extract<SyncEvent, { type: "error" }> | null = null;
  readonly stats = { pushMsgs: 0, changesSent: 0, rejects: 0, acks: 0, duplicates: 0, rebases: 0, reconnects: 0, withdraws: 0, envelopesSent: 0, envelopesReceived: 0 };

  private unsubscribe: (() => void) | null = null;
  /** `history` requests waiting for their answer on the current connection, by `req`. */
  private requests = new Map<number, { m: HistoryMsg; rows: ConfirmedChange[]; lineage?: ClosureEntry[]; resolve: (r: { rows: ConfirmedChange[]; lineage?: ClosureEntry[] }) => void; reject: (e: Error) => void }>();
  private reqN = 0;

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
    if (this.limitTimer !== null) this.timers.clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.presenceTimer !== null) this.timers.clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    // a coalesced update still waiting goes out before the close: it is often the leave (`null`) a closing editor
    // sends right after its last move, and peers have no other way to learn the person left (the relay keeps none)
    const p = this.presenceNext;
    this.presenceNext = null;
    if (p && this.conn?.open) this.send(this.presenceMsg(p.actor, p.state));
    const c = this.conn;
    this.conn = null;
    c?.close();
    this.failRequests(why);
    this.dropShown();
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
      } catch (e) {
        c = null;
        // why it couldn't connect (a refused token, no host): an owner shows it (REQ-8)
        // a transport that says why in a code (server-node's TransportError: unreachable, unauthorized, …) is read by it
        const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : undefined;
        this.lastFailure = code;
        if (!this.stopped) this.emit({ type: "error", error: `connect: ${e instanceof Error ? e.message : String(e)}`, ...(code ? { code } : {}) });
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
        this.peopleKept = false;
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
      await new Promise<void>((r) => (this.retry = this.timers.setTimeout(r, this.backoff())));
      this.retry = null;
    }
  }
  private onClose(id: number, why: string): void {
    if (id !== this.connId || !this.conn) return;
    this.conn = null;
    this.failRequests(why);
    this.dropShown();
    this.caughtUp = false;
    this.setStatus("offline");
    this.emit({ type: "offline", why });
    this.lastFailure = undefined; // it had connected: the host took the session
    if (!this.stopped) this.retry = this.timers.setTimeout(() => ((this.retry = null), void this.connectLoop()), this.backoff());
  }
  /** The wait before the next connection attempt (see `backoffMs`), counting this failure. */
  private backoff(): number {
    const base = this.o.backoffMs ?? 500;
    const cap = Math.max(base, this.lastFailure === "unauthorized" ? (this.o.unauthorizedBackoffMs ?? 300_000) : (this.o.maxBackoffMs ?? 15_000));
    const n = this.failures++;
    if (n === 0 || cap === base) return base;
    const d = Math.min(cap, base * 2 ** Math.min(n, 20));
    return d / 2 + (this.o.random ?? Math.random)() * (d / 2);
  }
  private failRequests(why: string): void {
    for (const r of this.requests.values()) r.reject(new Error(`history request lost: ${why}`));
    this.requests.clear();
  }
  /**
   * History this replica doesn't hold (Stage F): the rows `(after, upTo]` of this branch, paged like catch-up, and with
   * `lineage` its ancestry closure. Fails if offline or if the connection drops before the last page.
   */
  history(after: number, upTo: number, { lineage = false }: { lineage?: boolean } = {}): Promise<{ rows: ConfirmedChange[]; lineage?: ClosureEntry[] }> {
    if (!this.conn || this.stopped) return Promise.reject(new Error("history request: offline"));
    return new Promise((resolve, reject) => {
      // the lineage paged by the server's byte budget (SF1-8); a server from before paging ignores the cursor and sends
      // it whole in one reply, with no `lineageNext`
      const m: HistoryMsg = { type: "history", branchId: this.branchId, req: ++this.reqN, after, upTo, ...(lineage ? { lineage: true, lineageFrom: { entry: 0, state: 0 } } : {}) };
      this.requests.set(m.req, { m, rows: [], resolve, reject });
      this.send(m);
    });
  }
  /**
   * The connection is gone: every peer it showed is told gone, as a leave (`state: null`). A host that restarts, or a
   * room evicted on a deploy, keeps no one to send leaves for; a peer still there shows again on the next connection
   * (the host tells it from what it keeps, or the peer answers our re-announce: presence P2).
   */
  private dropShown(): void {
    const gone = [...this.shown.values()];
    this.shown.clear();
    for (const actor of gone) this.emit({ type: "presence", branchId: this.branchId, actor, state: null });
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
  private hello(onlyFrom = -1, after?: number): ClientMessage {
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
    if (after !== undefined) m.claimsAfter = after;
    if (this.o.blobs) m.envelopes = true;
    m.writeLimit = true;
    const who = this.o.identity?.();
    if (who) m.identity = who;
    return m;
  }
  /** Send this replica's person now, on a connection whose server keeps people (one that never would says so in error). */
  identify(): void {
    const who = this.o.identity?.();
    if (who && this.peopleKept && this.conn?.open) this.send({ type: "identity", branchId: this.branchId, identity: who });
  }
  private adoptKey(): string | null {
    const s = this.queue.branch(this.branchId).sequencer;
    return s.kind === "handingOff" ? `${this.branchId}|${s.n}|${s.stateHash}` : null;
  }
  private upload(): void {
    const s = this.queue.branch(this.branchId).sequencer;
    if (s.kind !== "handingOff" || !this.o.adoptPayload) return;
    if (this.limitTimer !== null) return; // held by a host's write limit: asked again when it ends
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
      case "people":
        if (m.branchId === b) this.o.onPeople?.(m.people);
        return;
      case "hello":
      case "changes":
        if (m.type === "hello" && m.maxMessageBytes && this.o.blobs) this.serverLimit = m.maxMessageBytes;
        // the people first, so the rows they name are told by person from the start
        if (m.type === "hello" && m.people && m.branchId === b) {
          this.peopleKept = true;
          this.o.onPeople?.(m.people);
        }
        this.fenced(() => {
          if (m.branchId !== b) return;
          if (m.type === "hello" && m.uncheckedFrom !== undefined) {
            // the server checked only part of our claims: keep what it found, ask for the rest, act on nothing yet
            this.confirmedSoFar.push(...m.confirmed);
            return this.send(this.hello(m.uncheckedFrom, m.checkedThrough));
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
            this.failures = 0; // the host answered: the next drop retries quickly again
            this.lastFailure = undefined;
            this.setStatus(this.queue.pending(b).length ? "syncing" : "up-to-date");
            for (const w of this.waiters.splice(0)) w(true);
            this.emit({ type: "online" });
            if (this.limitNotice) this.emit(this.limitNotice); // still held: the welcome mustn't hide why
            // shown again on a new connection: peers got a leave for the old one, and an update the disconnect caught
            // waiting is the latest (review SF4-8); a leave isn't repeated
            const p = this.presenceLast;
            if (p?.state) this.sendPresence(p.actor, p.state);
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
        // a refusal about this connection (its token, its cut) holds for every write it makes: an owner shows it as the
        // sync's error too, not only as that change's outcome (review SF3-6)
        if (CONNECTION_REASONS.has(m.reason)) this.emit({ type: "error", error: m.reason });
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
      case "history": {
        const r = this.requests.get(m.req);
        if (!r || m.branchId !== b) return;
        if (m.error) {
          this.requests.delete(m.req);
          return r.reject(new Error(m.error));
        }
        r.rows.push(...m.rows);
        if (m.lineage) r.lineage = mergeLineage(r.lineage ?? [], m.lineage);
        // rows and lineage page independently: the next rows start after the last one (a page with no row can't make
        // progress, so it ends them); the next lineage at the reply's cursor (SF1-8)
        const rowsLeft = !!m.more && m.rows.length > 0;
        const from = r.m.lineageFrom,
          next = m.lineageNext;
        // a cursor that doesn't move would ask for the same page forever: what came is the answer
        const lineageLeft = !!r.m.lineage && next !== undefined && !(from && next.entry === from.entry && next.state === from.state);
        if (rowsLeft || lineageLeft) {
          const { lineage: _l, lineageFrom: _f, ...base } = r.m;
          const after = rowsLeft ? m.rows[m.rows.length - 1]!.seq : r.m.upTo;
          return this.send((r.m = { ...base, after, ...(lineageLeft ? { lineage: true, lineageFrom: m.lineageNext! } : {}) }));
        }
        this.requests.delete(m.req);
        return r.resolve({ rows: r.rows, ...(r.lineage ? { lineage: r.lineage } : {}) });
      }
      case "overwritten":
        return this.emit({ type: "overwritten", id: m.id, by: m.by, author: m.author });
      case "presence": {
        const k = presenceKey(m.actor);
        const arrived = m.state !== null && !this.shown.has(k);
        if (m.state === null) this.shown.delete(k);
        else this.shown.set(k, m.actor);
        this.emit({ type: "presence", branchId: m.branchId, actor: m.actor, state: m.state });
        // A peer this connection didn't show yet (a teammate joining, or back after the host restarted), or a connection
        // that says it just `arrived` (a second tab of someone shown already), may have subscribed after our own
        // presence went out, and a host that restarted keeps none to tell it: ours goes again, once per arrival (the
        // throttle coalesces several). Not for one the host told us from what it keeps (`kept`): that peer was there
        // when we came, so it had ours (presence P2).
        if ((arrived || m.arrived) && !m.kept && m.state !== null && m.branchId === b) {
          const p = this.presenceLast;
          if (p?.state) this.sendPresence(p.actor, p.state);
        }
        return;
      }
      case "unknownBranch":
        return this.emit({ type: "error", error: "unknown branch" });
      case "adoptError":
        if (m.code === "write-limit") return this.onWriteLimit(m, true);
        return this.emit({ type: "error", error: m.reason });
      case "error":
        // a push's limit (its epoch given) holds pushes; one without was about nothing this client must send again
        if (m.code === "write-limit") return this.onWriteLimit(m, m.epoch !== undefined && m.branchId === b);
        if (m.reconnect) this.drop(id, m.reason);
        return this.emit({ type: "error", error: m.reason, ...(m.code ? { code: m.code } : {}) });
    }
  }

  /**
   * The host refused to store a write for a while (its daily write cap). `hold`: a push's (the server dropped the rest
   * of its epoch) or the hand-off's upload: nothing more is pushed or uploaded until the limit's time, and then the
   * queue goes again in a new epoch (or the hand-off asks again), with no reconnect. The wait is the host's
   * `retryAfterMs` (not its clock's `retryAt`: the two clocks may differ), plus up to a minute's jitter so the clients a
   * cap held back don't all come back in the same second. The owner is told when the edits will sync.
   */
  private onWriteLimit(m: { retryAt?: number; retryAfterMs?: number; epoch?: number }, hold: boolean): void {
    const now = (this.o.clock ?? Date.now)();
    const after = typeof m.retryAfterMs === "number" && m.retryAfterMs >= 0 ? m.retryAfterMs : typeof m.retryAt === "number" ? Math.max(0, m.retryAt - now) : 60_000;
    const wait = after + (this.o.random ?? Math.random)() * Math.min(60_000, after / 10);
    const until = now + wait;
    if (hold) {
      if (m.epoch === this.epoch) this.epoch++; // what was in flight in it goes again, in a new epoch, after the limit
      if (this.limitTimer !== null) this.timers.clearTimeout(this.limitTimer);
      this.limitTimer = this.timers.setTimeout(() => this.afterLimit(), wait);
    }
    const at = new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const notice = { type: "error" as const, error: `The server's daily limit is reached. Your edits are kept and will sync after ${at}.`, code: "write-limit", until };
    if (hold) this.limitNotice = notice;
    this.emit(notice);
  }
  /** The write limit's time has come: push the queue again (or ask about the hand-off again), on this connection. */
  private afterLimit(): void {
    this.limitTimer = null;
    this.limitNotice = null;
    if (this.stopped || !this.conn?.open) return; // the next connection's hello (or branchStatus) takes it from there
    if (this.queue.branch(this.branchId).sequencer.kind === "handingOff") return this.send({ type: "branchStatus", branchId: this.branchId });
    this.pump();
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

  /**
   * Presence goes out at most PRESENCE_PER_SEC times a second: within the interval only the latest state is kept and
   * sent when it ends, so a drag at 60 Hz costs the relay 10 messages a second and the last position always arrives.
   * (The server also drops anything over a per-connection cap.)
   */
  sendPresence(actor: Change["author"], state: PresenceState | null): void {
    this.presenceLast = { actor, state };
    if (!this.conn?.open) return;
    const now = (this.o.clock ?? Date.now)();
    const wait = this.presenceAt + 1000 / PRESENCE_PER_SEC - now;
    if (wait <= 0 && this.presenceTimer === null) {
      this.presenceAt = now;
      this.send(this.presenceMsg(actor, state));
      return;
    }
    this.presenceNext = { actor, state };
    if (this.presenceTimer !== null) return;
    this.presenceTimer = this.timers.setTimeout(() => {
      this.presenceTimer = null;
      const p = this.presenceNext;
      this.presenceNext = null;
      if (!p || !this.conn?.open) return;
      this.presenceAt = (this.o.clock ?? Date.now)();
      this.send(this.presenceMsg(p.actor, p.state));
    }, Math.max(0, wait));
  }
  /**
   * A presence message for the current connection: its first one that isn't a leave says `arrived`, so peers answer
   * with theirs even when they already show this actor through another connection (a second tab, after a host lost
   * what it kept). One per connection: an answer to it never says `arrived` again, so no round goes on.
   */
  private presenceMsg(actor: Change["author"], state: PresenceState | null): PresenceMsg {
    const m: PresenceMsg = { type: "presence", branchId: this.branchId, actor, state };
    if (state !== null && this.presenceSentOn !== this.connId) {
      this.presenceSentOn = this.connId;
      m.arrived = true;
    }
    return m;
  }

  // ---------------------------------------------------------------- pushing
  private inFlight(p: QueuedChange): boolean {
    return p.sentConn === this.connId && p.sentEpoch === this.epoch;
  }
  /** Fenced dequeue: withdraw what was absorbed, then send every pending change not yet sent in this epoch, in order. */
  pump(): void {
    if (!this.conn?.open || !this.caughtUp || this.stopped || this.quiesced || this.limitTimer !== null) return;
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
      if (p.held) break; // its store write is under way: nothing from it on goes out yet (R6-2)
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
      if (p.held) break;
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
