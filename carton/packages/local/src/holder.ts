// The lease holder: the library worker's engine thread while the app is open, or the detached helper while it is
// closed (§6.2, R4-04). It owns the replica's one pusher and serves `cb` calls on its control socket:
//   carton.ping      -> {pid, nonce}          liveness, answered before auth, on the engine's own thread
//   carton.commit    -> a cb result           the change goes into carton.db; on a shared cut, wait up to 5 s for the ack
//   carton.handover  -> {ok}                  finish the in-flight push, release the lease, stop (the app is starting)
//   carton.status    -> {kind, pid, nonce, …} for `cb status` and tests
//
// Acquiring: a free or expired lease, or one whose holder doesn't answer a 100 ms ping, is taken at once (CAS on the
// nonce we saw). A live helper is asked to hand over; a worker never waits for a helper's 60 s idle timeout.
// Losing it: every heartbeat is fenced on our nonce, and so is the sync client's every dequeue. The first failed one
// stops this holder for good: it pushes and rebases nothing more, and a helper exits.
import { randomBytes } from "node:crypto";
import { ControlServer, ControlClient, RpcError } from "./ipc.ts";
import { Lease, LEASE_BEAT_MS, LEASE_EXPIRY_MS, PING_TIMEOUT_MS } from "./lease.ts";
import type { HolderKind, LeaseRow } from "./lease.ts";

/** What the holder runs for one replica: the engine with its store and (for shared cuts) its sync client. */
export interface HolderEngine {
  /** Serve one `cb` request. Must resolve within the request's own wait budget (§6.2: up to 5 s on shared cuts). */
  serve(req: unknown, ctx: { holder: Holder }): Promise<unknown>;
  /** The lease is ours: start pushing (shared cuts). Every dequeue must carry `fence(nonce)`. */
  startSync?(nonce: string, onFenced: () => void): void | Promise<void>;
  /** Push nothing new and resolve once nothing is in flight (handover, idle exit). */
  quiesce?(): Promise<void>;
  /** Stop everything (after quiesce, or when fenced). */
  stop?(why: string): void | Promise<void>;
}

export interface HolderOptions {
  lease: Lease;
  engine: HolderEngine;
  kind: HolderKind;
  socketPath: string;
  /** The lease nonce the spawner saw (a helper takes over only from that holder). Workers pass undefined. */
  seen?: string | null;
  /** Helpers exit this long after their last use (60 s, like a credential-cache daemon). 0: never. */
  idleMs?: number;
  /** Called once the holder has stopped (released, fenced, idle). The helper process exits on it. */
  onStop?: (why: string) => void;
  log?: (event: Record<string, unknown>) => void;
}

/** Ping a holder: its nonce if it answered within `timeoutMs`, else null. */
export async function ping(socket: string, timeoutMs = PING_TIMEOUT_MS): Promise<{ nonce: string; pid: number } | null> {
  const deadline = Date.now() + timeoutMs;
  let c: ControlClient | null = null;
  try {
    c = await ControlClient.connect(socket, { timeoutMs, auth: false });
    return await c.call("carton.ping", {}, Math.max(1, deadline - Date.now()));
  } catch {
    return null;
  } finally {
    c?.close();
  }
}

/** The live holder, or null. Live = the row isn't expired and its socket answers a ping with the row's nonce. */
export async function liveHolder(lease: Lease, now = Date.now()): Promise<LeaseRow | null> {
  const row = await lease.read();
  if (!row || now - row.heartbeat > LEASE_EXPIRY_MS) return null;
  const r = await ping(row.socketPath);
  return r?.nonce === row.nonce ? row : null;
}

export class Holder {
  readonly kind: HolderKind;
  readonly socketPath: string;
  nonce: string | null = null;
  row: LeaseRow | null = null;
  stopped: string | null = null;
  private opts: HolderOptions;
  private server: ControlServer | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastUse = Date.now();
  private busy = 0;
  private stopping: Promise<void> | null = null;

  constructor(opts: HolderOptions) {
    this.opts = opts;
    this.kind = opts.kind;
    this.socketPath = opts.socketPath;
  }

  private log(ev: Record<string, unknown>): void { this.opts.log?.({ t: Date.now(), kind: this.kind, pid: process.pid, ...ev }); }

  /** Listen, then take the lease. Resolves false when another holder won (a helper then exits). */
  async start(): Promise<boolean> {
    // listen first, so the lease row never names a socket nobody answers
    this.server = await ControlServer.listen({
      path: this.socketPath,
      open: ["carton.ping"],
      methods: {
        "carton.ping": () => ({ pid: process.pid, nonce: this.nonce }),
        "carton.commit": (p) => this.commit(p),
        "carton.handover": () => this.handover(),
        "carton.status": () => ({ kind: this.kind, pid: process.pid, nonce: this.nonce, stopped: this.stopped, busy: this.busy }),
      },
    });
    const row = await this.acquire();
    if (!row) { await this.server.close(); this.server = null; return false; }
    this.row = row;
    this.nonce = row.nonce;
    this.log({ type: "lease", nonce: row.nonce, from: this.opts.seen ?? null });
    this.beatTimer = setInterval(() => void this.heartbeat(), LEASE_BEAT_MS);
    this.beatTimer.unref?.();
    await this.opts.engine.startSync?.(row.nonce, () => void this.stop("fenced: lease nonce changed"));
    if (this.opts.idleMs) this.armIdle();
    return true;
  }

  private async acquire(): Promise<LeaseRow | null> {
    const { lease } = this.opts;
    const who = { pid: process.pid, socketPath: this.socketPath, kind: this.kind };
    for (let i = 0; i < 20; i++) {
      const cur = await lease.read();
      if (this.kind !== "worker") {
        // a helper takes over only from the holder its spawner saw dead; anything newer is someone else's helper
        // The spawner's ping just failed; pinging again here would only add 100 ms to a takeover from a hung
        // holder. If that holder was merely slow, fencing stops it at its next dequeue (R5-06).
        const seen = this.opts.seen ?? null;
        if ((cur?.nonce ?? null) !== seen) return null;
        return lease.take(seen, who);
      }
      if (!cur) { const r = await lease.take(null, who); if (r) return r; continue; }
      if (!(await liveHolder(lease))) { const r = await lease.take(cur.nonce, who); if (r) return r; continue; }
      // a live helper: ask it to finish its in-flight push and leave
      this.log({ type: "handover-request", to: cur.nonce });
      try {
        const c = await ControlClient.connect(cur.socketPath, { timeoutMs: 1000 });
        try { await c.call("carton.handover", {}, 15000); } finally { c.close(); }
      } catch { /* it exited, or died: the next round takes over */ }
    }
    throw new Error("could not take the sync lease");
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.row) return;
    if (!(await this.opts.lease.beat(this.row))) await this.stop("fenced: lease nonce changed");
  }

  private armIdle(): void {
    const idleMs = this.opts.idleMs!;
    const tick = () => {
      if (this.stopped) return;
      const left = this.lastUse + idleMs - Date.now();
      if (left <= 0 && this.busy === 0) return void this.retire("idle");
      this.idleTimer = setTimeout(tick, Math.max(50, Math.min(left, 1000)));
      this.idleTimer.unref?.();
    };
    this.idleTimer = setTimeout(tick, Math.min(idleMs, 1000));
    this.idleTimer.unref?.();
  }

  private async commit(params: unknown): Promise<unknown> {
    if (this.stopped) throw new RpcError(`holder stopped (${this.stopped})`, -32003);
    this.lastUse = Date.now();
    this.busy++;
    try {
      return await this.opts.engine.serve(params, { holder: this });
    } finally {
      this.busy--;
      this.lastUse = Date.now();
    }
  }

  /** The app is starting: finish the in-flight push, release, stop. */
  private async handover(): Promise<{ ok: true }> {
    await this.retire("handover");
    return { ok: true };
  }

  /** Leave cleanly: quiesce the pusher, release the lease, stop. */
  async retire(why: string): Promise<void> {
    if (this.stopped) return;
    this.log({ type: "retire", why });
    await this.opts.engine.quiesce?.();
    if (this.nonce) await this.opts.lease.release(this.nonce).catch(() => false);
    await this.stop(why);
  }

  /** Stop for good: no more pushes, no more requests. Fenced holders come here without releasing (it isn't theirs). */
  stop(why: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = why;
    this.log({ type: "stop", why });
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopping = (async () => {
      await this.opts.engine.stop?.(why);
      // answer the handover call before the socket closes
      await new Promise((r) => setImmediate(r));
      await this.server?.close();
      this.opts.onStop?.(why);
    })();
    return this.stopping;
  }
}

/** A socket path for a holder: next to carton.db, carrying the pid and a random part (never reused). */
export function holderSocketPath(dir: string, kind: HolderKind): string {
  return `${dir.replace(/[\\/]+$/, "")}/${kind}-${process.pid}-${randomBytes(3).toString("hex")}.sock`;
}

/**
 * The worker's lease for as long as the app runs: a holder that is fenced (a busy main loop mistaken for death, R5-06)
 * takes the lease back after `reacquireMs`, by handover from whoever took it, rather than leaving the replica to a
 * helper until the helper's idle timeout.
 */
export function keepLease(make: () => HolderOptions, { reacquireMs = 2000 }: { reacquireMs?: number } = {}) {
  let current: Holder | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const start = async (): Promise<Holder> => {
    const o = make();
    const h = new Holder({
      ...o,
      onStop: (why) => {
        o.onStop?.(why);
        if (!closed && why.startsWith("fenced")) timer = setTimeout(() => void start().catch(() => {}), reacquireMs);
      },
    });
    current = h;
    if (!(await h.start())) throw new Error("could not take the sync lease");
    return h;
  };
  return {
    start,
    get current(): Holder | null { return current; },
    async stop(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      await current?.retire("app closing");
    },
  };
}
