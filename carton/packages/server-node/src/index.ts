// SequencerHost for Node (PLAN §3.1, §6.3): node:sqlite storage, a WebSocket endpoint (a zero-dependency RFC 6455
// server), the same HTTP API as the Worker, and an in-process host plus transport for tests and local use.
// Production: runs inside Cardboard's own API behind its auth. Owner: hosts-plugins.

import type { AuthProvider, BlobStore, SequencerHost, Transport } from "@carton/core/plugins";
import { createInProcessHost as inProcess, type InProcessHost } from "@carton/server";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { nodeSqliteStorage } from "./storage.ts";

export { startNodeHost, type NodeHost, type NodeHostOptions } from "./host.ts";
export { nodeSqliteStorage, type NodeSqliteStorage, type NodeSqliteOptions } from "./storage.ts";
export { webSocketTransport, transportError, type WebSocketTransportOptions, type TransportError, type TransportErrorCode } from "./transport.ts";
export { acceptWebSocket, rejectUpgrade, ServerWebSocket, WsError, type WsOptions } from "./ws.ts";

/** A host and a matching Transport in one process, with no sockets (tests, local single-machine sharing). The
 * sequencer and transport are @carton/server's reference host; this adds node:sqlite storage (in memory, or a file
 * under `dataDir`). */
export function createInProcessHost(opts: { auth: AuthProvider; blobs?: BlobStore; dataDir?: string; projectId?: string }): { host: SequencerHost; transport: Transport; inner: InProcessHost } {
  let path = ":memory:";
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    path = join(opts.dataDir, "in-process.db");
  }
  const storage = nodeSqliteStorage(path);
  const inner = inProcess({ storage, auth: opts.auth, ...(opts.blobs ? { blobs: opts.blobs } : {}), ...(opts.projectId ? { projectId: opts.projectId } : {}) });
  return {
    host: { kind: inner.kind, url: inner.url, close: async () => { await inner.close(); storage.close(); } },
    transport: inner.transport,
    inner,
  };
}
