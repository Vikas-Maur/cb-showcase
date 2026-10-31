// The sync client state machine (PLAN §6.2, §6.3, §12, §5.3): one pusher per replica (the sync-lease holder),
// pipelined pushes, rebase of the whole queue on reject, keyframe catch-up, confirmed-id lists, withdraw of absorbed
// changes, fencing by lease nonce, and the sequencer hand-off. Port of system-v11 `sync.mjs`.
// Owner: sync-sequencer. Signatures by the foundation.

import type { Transport } from "../plugins.ts";
import type { ConfirmedChange, PendingChange } from "../types.ts";
import type { ConfirmedId, PresenceState } from "./messages.ts";
import { notImplemented } from "../todo.ts";

export * from "./messages.ts";

/**
 * What the sync client needs from the replica it pushes for. Implemented by core's history (`Replica`), backed by
 * the Store. Every method that touches the queue runs fenced: `leaseNonce()` is re-read first.
 */
export interface SyncReplica {
  headSeq(branchId: string): number;
  pending(branchId: string): readonly PendingChange[];
  rids(): readonly string[];
  schemaVersion: number;
  /** Integrate confirmed rows: our ids leave the queue, the rest of the queue is rebased onto the new head. */
  integrate(branchId: string, rows: readonly ConfirmedChange[]): Promise<{ mine: ConfirmedChange[]; others: ConfirmedChange[] }>;
  /** Jump to a server keyframe (far behind), dropping confirmed ids first, then rebase the whole queue. */
  jumpTo(branchId: string, keyframe: { seq: number; doc: unknown }, confirmed: readonly ConfirmedId[]): Promise<void>;
  confirmFromList(branchId: string, confirmed: readonly ConfirmedId[]): Promise<void>;
  rebaseAll(branchId: string): Promise<void>;
  /** A validation reject: the change leaves the queue as rejected; its author gets a notice. */
  rejectPending(branchId: string, id: string, reason: string): Promise<void>;
  /** The current sync-lease nonce (fencing, R5-06). */
  leaseNonce(): Promise<string | null>;
}

export type SyncStatus = "offline" | "connecting" | "syncing" | "up-to-date" | "stopped";

export interface SyncClientOptions {
  transport: Transport;
  url: string;
  /** Token, or a function that fetches a fresh one per connect. */
  token: string | (() => Promise<string>);
  branchId: string;
  /** The lease nonce this client was started under; it stops when the store's nonce changes. */
  nonce: string;
  backoffMs?: number;
}

export interface SyncClient {
  readonly status: SyncStatus;
  start(): void;
  stop(why?: string): void;
  /** Push every pending change not yet sent in this epoch (call after a local commit). */
  pump(): void;
  /** Resolve when caught up (or after `timeoutMs`, with the current state). */
  whenCaughtUp(timeoutMs: number): Promise<boolean>;
  sendPresence(state: PresenceState | null): void;
  onStatus(listener: (status: SyncStatus) => void): () => void;
}

export function createSyncClient(replica: SyncReplica, opts: SyncClientOptions): SyncClient {
  return notImplemented("createSyncClient");
}
