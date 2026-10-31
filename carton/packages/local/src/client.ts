// The `cb` side of the lease (§6.2, R4-04): a `cb` or MCP process never pushes. It hands its write to the live lease
// holder and waits for the status. When there is none:
//   - the cut is shared (or handing off): start a detached helper that takes the lease and does headless sync, then
//     hand the write to it. The helper keeps the connection for 60 s, so later calls cost one local round trip;
//   - the cut is only local: there is nothing to push, so the write is committed in this process, through the
//     store's cross-process CAS (the local sequencer is carton.db itself; P3). That saves a helper start per call.
//
// A holder that dies while answering (ECONNRESET) is retried with the **same change id**: the next holder finds the
// id already in carton.db's queue or log and never makes a second change (stable ids, R3-01).
import { ControlClient, RpcError } from "./ipc.ts";
import { liveHolder } from "./holder.ts";
import type { Lease, LeaseRow } from "./lease.ts";

export interface SubmitOptions {
  lease: Lease;
  /** True when headless sync is needed (a shared or handing-off cut). False: commit in-process instead of a helper. */
  needsHelper: () => Promise<boolean>;
  /** Start a helper that takes over from the holder with nonce `seen` (null: none). Must not wait for it. */
  spawnHelper: (seen: string | null) => void;
  /** Retry on a holder that died mid-call, with the same id (default true). */
  retryOnReset?: boolean;
  /** How long to wait for the holder's answer: the server-ack wait (5 s) plus room for the commit itself. */
  callTimeoutMs?: number;
  /** How long a spawned helper may take to own the lease. */
  helperStartMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export type SubmitResult =
  | { via: "holder"; holder: LeaseRow; result: unknown; attempts: number }
  | { via: "in-process" }
  | { via: "error"; error: string; code?: string | number };

const RETRYABLE = new Set(["ECONNRESET", "ECONNREFUSED", "ENOENT", "EPIPE"]);

export async function submit(method: string, params: object, opts: SubmitOptions): Promise<SubmitResult> {
  const { lease, retryOnReset = true, callTimeoutMs = 20000, helperStartMs = 5000 } = opts;
  const log = opts.log ?? (() => {});
  let lastError: { error: string; code?: string | number } = { error: "no lease holder" };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const holder = await liveHolder(lease);
    if (!holder) {
      if (!(await opts.needsHelper())) return { via: "in-process" };
      const seen = (await lease.nonce()) ?? null;
      const t0 = Date.now();
      opts.spawnHelper(seen);
      const got = await waitForHolder(lease, seen, helperStartMs);
      log({ type: seen ? "takeover" : "helper-start", from: seen, to: got?.nonce ?? null, ms: Date.now() - t0 });
      if (!got) lastError = { error: `no helper took the sync lease within ${helperStartMs} ms` };
      continue;
    }
    let c: ControlClient | null = null;
    try {
      c = await ControlClient.connect(holder.socketPath, { timeoutMs: 1000 });
      const result = await c.call(method, params, callTimeoutMs);
      return { via: "holder", holder, result, attempts: attempt };
    } catch (e: any) {
      const code = e?.code;
      lastError = { error: String(e?.message ?? e), code };
      log({ type: "cb-error", error: lastError.error, code });
      // the holder stopped (fenced, retiring) or died while answering: look again, same id
      const retry = RETRYABLE.has(String(code)) || (e instanceof RpcError && e.code === -32003);
      if (!retry || !retryOnReset) return { via: "error", ...lastError };
    } finally {
      c?.close();
    }
  }
  return { via: "error", ...lastError };
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
