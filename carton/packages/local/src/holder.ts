// The lease holder: the library worker's engine thread while the app is open, or the detached helper while it is
// closed (§6.2, R4-04). It owns the replica's one pusher and serves `cb` calls on its control socket:
//   carton.ping      -> {pid, nonce}          liveness, answered before auth, on the engine's own thread
//   carton.commit    -> a cb result           the change goes into carton.db; on a shared cut, wait up to 5 s for the ack
//   carton.handover  -> {ok}                  finish the in-flight push, release the lease, stop (the app is starting)
//   carton.status    -> {kind, pid, nonce, …} for `cb status` and tests
//   carton.nudge     -> {ok}                  another process wrote carton.db: the engine looks now (B11); no auth
//
// Acquiring: a free or expired lease, or one whose holder doesn't answer a 100 ms ping, is taken at once (CAS on the
// nonce we saw). A live helper is asked to hand over; a worker never waits for a helper's 60 s idle timeout.
// Losing it: every heartbeat is fenced on our nonce, and so is the sync client's every dequeue. The first failed one
// stops this holder for good: it pushes and rebases nothing more, and a helper exits.
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, ControlClient, RpcError } from "./ipc.ts";
import { Lease, LEASE_BEAT_MS, LEASE_EXPIRY_MS, PING_TIMEOUT_MS } from "./lease.ts";
import type { HolderKind, LeaseRow } from "./lease.ts";

/** What the holder runs for one replica: the engine with its store and (for shared cuts) its sync client. */
export interface HolderEngine {
  /** Serve one `cb` request. Must resolve within the request's own wait budget (§6.2: up to 5 s on shared cuts). */
  serve(req: unknown, ctx: { holder: Holder }): Promise<unknown>;
  /**
   * The lease is ours: start pushing (shared cuts). `fence(nonce)` says synchronously whether this holder still holds
   * the lease (asked before every queue step); `onFenced` is called when the client stops because it doesn't.
   */
  startSync?(nonce: string, onFenced: () => void, fence: (nonce: string) => boolean): void | Promise<void>;
  /** Push nothing new and resolve once nothing is in flight (handover, idle exit). */
  quiesce?(): Promise<void>;
  /** Stop everything (after quiesce, or when fenced). */
  stop?(why: string): void | Promise<void>;
  /** Another process wrote carton.db without this holder (a `cb` that committed in its own process): look now (B11). */
  nudge?(): void | Promise<void>;
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

/** A ping's outcome: the holder's answer, or why there is none: nothing listens (`gone`: it died) or no answer in time
 * (`slow`: busy, preempted, or hung). */
export type PingResult = { answer: { nonce: string; pid: number } } | { gone: true } | { slow: true };

export async function pingWhy(socket: string, timeoutMs = PING_TIMEOUT_MS): Promise<PingResult> {
  const deadline = Date.now() + timeoutMs;
  let c: ControlClient | null = null;
  try {
    c = await ControlClient.connect(socket, { timeoutMs, auth: false });
    return { answer: await c.call("carton.ping", {}, Math.max(1, deadline - Date.now())) };
  } catch (e) {
    return (e as { code?: string })?.code === "ETIMEDOUT" ? { slow: true } : { gone: true };
  } finally {
    c?.close();
  }
}

/** Ping a holder: its nonce if it answered within `timeoutMs`, else null. */
export async function ping(socket: string, timeoutMs = PING_TIMEOUT_MS): Promise<{ nonce: string; pid: number } | null> {
  const r = await pingWhy(socket, timeoutMs);
  return "answer" in r ? r.answer : null;
}

/**
 * Further pings for a holder worth waiting for when it was merely slow (B3): the app's engine thread, whose takeover
 * by a helper loses the app's materializer and fences the app, or a helper the starting app would rather have hand
 * over. A dead holder refuses at once (`gone`), so a takeover after a crash waits for none of these.
 */
export const PATIENT_PINGS_MS = [300, 1000];

/**
 * Look at the lease: the live holder, or null, and the nonce that was observed (live or not). Live = the row isn't
 * expired and its socket answers a ping with the row's nonce. A taker must take over from exactly the nonce whose
 * holder it saw fail, never from one it reads later (that one may be a healthy holder another caller just started).
 */
export async function probeHolder(lease: Lease, now = Date.now(), opts: { patient?: (row: LeaseRow) => boolean } = {}): Promise<{ live: LeaseRow | null; seen: string | null; fresh: boolean; row: LeaseRow | null }> {
  // one observation: the nonce a taker may take over from is the one this probe saw, never one read afterwards
  const { nonce, row } = await lease.snapshot();
  if (!row) return { live: null, seen: nonce, fresh: false, row: null };
  if (now - row.heartbeat > LEASE_EXPIRY_MS) return { live: null, seen: row.nonce, fresh: false, row };
  let r = await pingWhy(row.socketPath);
  if ("slow" in r && opts.patient?.(row)) for (const ms of PATIENT_PINGS_MS) if (!("slow" in (r = await pingWhy(row.socketPath, ms)))) break;
  // fresh: a holder beat within 6 s, even if it missed this ping (busy, or dead a moment ago)
  return { live: "answer" in r && r.answer.nonce === row.nonce ? row : null, seen: row.nonce, fresh: true, row };
}

/** The live holder, or null. */
export async function liveHolder(lease: Lease, now = Date.now(), opts: { patient?: (row: LeaseRow) => boolean } = {}): Promise<LeaseRow | null> {
  return (await probeHolder(lease, now, opts)).live;
}

/** A `cb` call waits for a slow app (its engine thread), never for a slow helper (R4-04: takeover in under 1 s). */
export const patientWithApp = (row: LeaseRow): boolean => row.kind === "worker";

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
      // a nudge only makes the engine look at carton.db again (B11): nothing to protect, and no auth round trip
      open: ["carton.ping", "carton.nudge"],
      methods: {
        "carton.ping": () => ({ pid: process.pid, nonce: this.nonce }),
        "carton.nudge": () => { void Promise.resolve(this.opts.engine.nudge?.()).catch(() => {}); return { ok: true }; },
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
    // the fence is this holder's own knowledge, refreshed by every heartbeat (a failed beat stops it); between beats a
    // replaced holder can push at most what the server deduplicates by id (§6.2, R5-06). What it would record from the
    // server's answers is conditional on the lease in the store (the engine's `startSync`), so it records nothing
    await this.opts.engine.startSync?.(row.nonce, () => void this.stop("fenced: lease nonce changed"), (n) => !this.stopped && this.nonce === n);
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
      // a slow holder is asked to hand over rather than fenced: only one that is gone (or never answers) is taken over
      if (!(await liveHolder(lease, Date.now(), { patient: () => true }))) { const r = await lease.take(cur.nonce, who); if (r) return r; continue; }
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
/**
 * A socket path for a holder: next to carton.db, carrying the pid and a random part (never reused). A Unix socket path
 * must fit `sun_path` (104 bytes on macOS, 108 on Linux), so a deep library folder falls back to a per-project name in
 * the OS temp folder. Windows maps the path to a named pipe (`pipeName`), which has no such limit.
 */
export function holderSocketPath(dir: string, kind: HolderKind, platform: string = process.platform): string {
  const name = `${kind}-${process.pid}-${randomBytes(3).toString("hex")}.sock`;
  const near = join(dir, name);
  if (platform === "win32" || Buffer.byteLength(near) <= 100) return near;
  return join(tmpdir(), `carton-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}-${name}`);
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
