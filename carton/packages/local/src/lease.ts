// One pusher per replica (§6.2, R3-01, R4-04, R5-06): the sync lease row in carton.db decides who may push and rebase
// the pending queue.
//
// - The row holds `{pid, nonce, socketPath, kind, heartbeat, expires}`. The holder beats every 2 s; a row not beaten for 6 s is
//   expired.
// - Liveness is a ping on the holder's socket with a 100 ms timeout, answered with the holder's nonce. A holder that
//   doesn't answer (dead, or hung) is taken over at once rather than after the 6 s expiry. The nonce, not the pid,
//   names a holder, so a reused pid can't pass for the old holder.
// - Taking is a compare-and-swap on the nonce the taker saw, as one conditional `Store.write`: of two takers that saw
//   the same dead holder, exactly one wins. The Store contract makes that atomic across processes (SQLite) and within
//   one (memory), so the lease needs no SQL of its own.
// - Fencing: the nonce has its own key, so a holder can make any write batch conditional on still holding the lease
//   (`fence(nonce)`). The sync client puts it on every dequeue: a holder whose nonce changed stops rebasing and pushing
//   at its next dequeue (R5-06). The row's heartbeat lives under a different key, so beats never break the condition.
import { randomBytes } from "node:crypto";
import type { Store, StoreCondition } from "@carton/core/plugins";

export const LEASE_BEAT_MS = 2000;
export const LEASE_EXPIRY_MS = 6000;
export const PING_TIMEOUT_MS = 100;

/** The lease is local state: never synced, and dropped from full `.cbproj` exports with the other local tables (§13). */
export const LEASE_TABLE = "lease";
// `["sync"]` is the row (STORE_TABLES); `["sync", "nonce"]` repeats the nonce alone, so a write can be fenced on it
// without depending on the row's heartbeat, which changes every 2 s.
const ROW_KEY = ["sync"] as const;
const NONCE_KEY = ["sync", "nonce"] as const;

export type HolderKind = "worker" | "helper" | "cb";

export interface LeaseRow {
  pid: number;
  nonce: string;
  /** The holder's control socket path (a file path; a named pipe derived from it on Windows). */
  socketPath: string;
  kind: HolderKind;
  /** ms epoch of the last heartbeat. */
  heartbeat: number;
  expires: number;
}

export const newNonce = (): string => randomBytes(12).toString("hex");

/** The condition that makes a write batch apply only while `nonce` still holds the lease. */
export const fence = (nonce: string): StoreCondition => ({ table: LEASE_TABLE, key: NONCE_KEY, expect: { equals: nonce } });

export class Lease {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  async read(): Promise<LeaseRow | null> {
    const [nonce, row] = await Promise.all([this.store.get<string>(LEASE_TABLE, NONCE_KEY), this.store.get<LeaseRow>(LEASE_TABLE, ROW_KEY)]);
    // the nonce key is the truth; a row from an older holder (written in another batch) never names the holder
    return nonce && row?.nonce === nonce ? row : null;
  }
  async nonce(): Promise<string | null> {
    return (await this.store.get<string>(LEASE_TABLE, NONCE_KEY)) ?? null;
  }

  /** Take the lease if its nonce is still `seen` (null: free). The new row, or null when someone else won. */
  async take(seen: string | null, who: { pid: number; socketPath: string; kind: HolderKind }, now = Date.now()): Promise<LeaseRow | null> {
    const row: LeaseRow = { ...who, nonce: newNonce(), heartbeat: now, expires: now + LEASE_EXPIRY_MS };
    const ok = await this.store.write(
      [{ table: LEASE_TABLE, key: NONCE_KEY, value: row.nonce }, { table: LEASE_TABLE, key: ROW_KEY, value: row }],
      [{ table: LEASE_TABLE, key: NONCE_KEY, expect: seen === null ? "absent" : { equals: seen } }],
    );
    return ok ? row : null;
  }

  /** Heartbeat. False when the lease no longer carries `nonce`: this holder was replaced and must stop. */
  async beat(row: LeaseRow, now = Date.now()): Promise<boolean> {
    row.heartbeat = now;
    row.expires = now + LEASE_EXPIRY_MS;
    return this.store.write([{ table: LEASE_TABLE, key: ROW_KEY, value: { ...row } }], [fence(row.nonce)]);
  }

  /** Release our own lease (never someone else's). */
  async release(nonce: string): Promise<boolean> {
    return this.store.write([{ table: LEASE_TABLE, key: NONCE_KEY, value: undefined }, { table: LEASE_TABLE, key: ROW_KEY, value: undefined }], [fence(nonce)]);
  }

  async holds(nonce: string): Promise<boolean> {
    return (await this.nonce()) === nonce;
  }
}
