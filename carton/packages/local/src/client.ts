// The `cb` side of the lease (§6.2, R4-04): a `cb` or MCP process never pushes. It hands its write to the live lease
// holder and waits for the status. When there is none:
//   - the cut is shared (or handing off): start a detached helper that takes the lease and does headless sync, then
//     hand the write to it. The helper keeps the connection for 60 s, so later calls cost one local round trip;
//   - the cut is only local and no holder has beaten within the lease expiry: there is nothing to push, so the write
//     is committed in this process, through the store's cross-process CAS (the local sequencer is carton.db itself;
//     P3). That saves a helper start per call. A holder that beat recently but missed the ping is taken over instead.
//
// A holder that dies while answering (ECONNRESET) is retried with the **same change id**: the next holder finds the
// id already in carton.db's queue or log and never makes a second change (stable ids, R3-01).
import { ControlClient, RpcError, callOnce } from "./ipc.ts";
import { liveHolder, patientWithApp, probeHolder, SHOW_WAIT_MS } from "./holder.ts";
import type { ShowTarget, Showing } from "@carton/cardboard/node";
import type { Lease, LeaseRow } from "./lease.ts";

export interface SubmitOptions {
  lease: Lease;
  /** True when headless sync is needed (a shared or handing-off cut). False: commit in-process instead of a helper. */
  needsHelper: () => Promise<boolean>;
  /** Start a helper that takes over from the holder with nonce `seen` (null: none). Must not wait for it. */
  spawnHelper: (seen: string | null) => void;
  /** Set when no helper may be started (it would open the project differently): the error answered instead. */
  noHelper?: string;
  /** Retry on a holder that died mid-call, with the same id (default true). */
  retryOnReset?: boolean;
  /**
   * The write is safe to run twice (default true). When false, a holder that dies after receiving it leaves its outcome
   * unknown, and the call answers that instead of running it again (an undo retried would undo the next change).
   */
  idempotent?: boolean;
  /** How long to wait for the holder's answer: the server-ack wait (5 s) plus room for the commit itself. */
  callTimeoutMs?: number;
  /** How long a spawned helper may take to own the lease. */
  helperStartMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

/**
 * `passedOver`: a holder the lease named that didn't answer (or whose lease had expired), so the write went elsewhere
 * (a helper that took over, or this process). If it is alive after all, it should look at carton.db (B11).
 */
export type SubmitResult =
  | { via: "holder"; holder: LeaseRow; result: unknown; attempts: number; passedOver?: LeaseRow }
  | { via: "in-process"; passedOver?: LeaseRow }
  | { via: "error"; error: string; code?: string | number };

/** A non-idempotent write whose holder died after receiving it: it may or may not have been saved. */
export const UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME";
/** No helper could be started that opens the project as this process does (another adapter, no factory for it). */
export const NO_HELPER = "NO_HELPER";

const RETRYABLE = new Set(["ECONNRESET", "ECONNREFUSED", "ENOENT", "EPIPE"]);

export async function submit(method: string, params: object, opts: SubmitOptions): Promise<SubmitResult> {
  const { lease, retryOnReset = true, idempotent = true, callTimeoutMs = 20000, helperStartMs = 5000 } = opts;
  const log = opts.log ?? (() => {});
  let lastError: { error: string; code?: string | number } = { error: "no lease holder" };
  let passedOver: LeaseRow | undefined;
  for (let attempt = 1; attempt <= 6; attempt++) {
    // the app's engine thread is waited for when it is merely slow (B3): a helper taking over has no materializer
    const { live: holder, seen, fresh, row } = await probeHolder(lease, Date.now(), { patient: patientWithApp });
    if (!holder) {
      if (row && !passedOver) passedOver = row;
      // in-process only when nobody holds the lease: a holder that beat recently but missed the ping is taken over
      // (§6.2), never bypassed, or the app's materializer and GUI wouldn't hear of the change
      if (!fresh && !(await opts.needsHelper())) return { via: "in-process", ...(passedOver ? { passedOver } : {}) };
      if (opts.noHelper) return { via: "error", error: opts.noHelper, code: NO_HELPER };
      const t0 = Date.now();
      opts.spawnHelper(seen);
      const got = await waitForHolder(lease, seen, helperStartMs);
      log({ type: seen ? "takeover" : "helper-start", from: seen, to: got?.nonce ?? null, ms: Date.now() - t0 });
      if (!got) lastError = { error: `no helper took the sync lease within ${helperStartMs} ms` };
      continue;
    }
    let c: ControlClient | null = null;
    let sent = false;
    try {
      c = await ControlClient.connect(holder.socketPath, { timeoutMs: 1000 });
      sent = true;
      const result = await c.call(method, params, callTimeoutMs);
      return { via: "holder", holder, result, attempts: attempt, ...(passedOver ? { passedOver } : {}) };
    } catch (e: any) {
      const code = e?.code;
      lastError = { error: String(e?.message ?? e), code };
      log({ type: "cb-error", error: lastError.error, code, sent });
      // refused before running it (a stopped holder answers -32003), or never reached: always safe to look again
      const refused = e instanceof RpcError && e.code === -32003;
      if (sent && !refused && !idempotent) {
        return { via: "error", error: "the sync-lease holder stopped while running this write: it may or may not have been saved. Check `cb history` before running it again.", code: UNKNOWN_OUTCOME };
      }
      // the holder stopped (fenced, retiring) or died while answering: look again, same id
      const retry = RETRYABLE.has(String(code)) || refused;
      if (!retry || !retryOnReset) return { via: "error", ...lastError };
    } finally {
      c?.close();
    }
  }
  return { via: "error", ...lastError };
}

/**
 * Tell a holder that carton.db changed without it (`carton.nudge`, B11): true when it answered. Best effort, bounded
 * by `timeoutMs` (a busy holder finds the change by itself, by polling).
 */
export async function nudgeHolder(socketPath: string, timeoutMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let c: ControlClient | null = null;
  try {
    c = await ControlClient.connect(socketPath, { timeoutMs, auth: false });
    await c.call("carton.nudge", {}, Math.max(1, deadline - Date.now()));
    return true;
  } catch {
    return false;
  } finally {
    c?.close();
  }
}

/**
 * Read-your-writes (apply-ryw): ask the lease holder at `socketPath` to answer once the shared timeline.tsx it prints
 * shows `target`, a write this process just made (`carton.shown`, at most `waitMs`). Its answer: `shown`, `held` (a
 * freeze holds the change back for someone else's work), `elsewhere` (another cut than the file's) or `later` (not
 * yet); null when that holder prints no timeline.tsx. A holder that can't be asked (gone, no answer in time) is `later`.
 */
export async function showOnHolder(socketPath: string, target: ShowTarget, waitMs: number = SHOW_WAIT_MS): Promise<Showing | null> {
  try {
    const r = await callOnce<{ timeline?: Showing | null }>(socketPath, "carton.shown", { ...target, waitMs }, { timeoutMs: waitMs + 1000 });
    return r?.timeline ?? null;
  } catch {
    return "later";
  }
}

/** Wait until the lease has moved on from `seen` and its new holder answers a ping. */
export async function waitForHolder(lease: Lease, seen: string | null, timeoutMs: number): Promise<LeaseRow | null> {
  const end = Date.now() + timeoutMs;
  let delay = 5;
  while (Date.now() < end) {
    const n = await lease.nonce();
    if (n && n !== seen) {
      const live = await liveHolder(lease);
      if (live) return live;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 40);
  }
  return null;
}
