// The sync client state machine (PLAN §6.2, §6.3, §12, §5.3): a replica's confirmed log plus pending queue
// (`ReplicaQueue`), and its one pusher (`SyncClient`): pipelined pushes, whole-queue rebase on reject and on the K cap,
// keyframe catch-up, confirmed-id lists, withdraw of absorbed changes (H1), lww resubmitted as merge (H2), fencing by
// the sync lease, and the sequencer hand-off. Port of system-v11 `store.mjs` and `sync.mjs`. Owner: sync-sequencer.

import type { Transport } from "../plugins.ts";
import { SyncClient, type SyncClientOptions } from "./client.ts";
import type { ReplicaQueue } from "./queue.ts";

export * from "./messages.ts";
export * from "./queue.ts";
export * from "./client.ts";
export * from "./replica.ts";

/**
 * What the sync client needs from the replica it pushes for: a `ReplicaQueue` (synchronous and in memory, as core's
 * History is). A Store-backed owner persists it through the queue's events.
 */
export type SyncReplica = ReplicaQueue;

export interface CreateSyncClientOptions extends Omit<SyncClientOptions, "queue" | "connect"> {
  transport: Transport;
  url: string;
  /** Token, or a function that fetches a fresh one per connect. */
  token: string | (() => Promise<string>);
}

/** A sync client for one branch over a Transport. Call `start()`; it reconnects on its own until `stop()`. */
export function createSyncClient(replica: SyncReplica, opts: CreateSyncClientOptions): SyncClient {
  const { transport, url, token, ...rest } = opts;
  return new SyncClient({
    ...rest,
    queue: replica,
    connect: async () => transport.connect(url, { token: typeof token === "string" ? token : await token() }),
  });
}
