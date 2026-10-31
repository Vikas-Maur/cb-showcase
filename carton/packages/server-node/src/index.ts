// SequencerHost for Node (PLAN §3.1, §6.3): node:sqlite storage, a WebSocket endpoint, and an in-process host plus
// transport for tests and local use. Production: runs inside Cardboard's own API behind its auth. Owner: hosts-plugins.
import type { AuthProvider, BlobStore, SequencerHost, SequencerStorage, Transport } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface NodeHostOptions {
  /** Directory holding one SQLite file per project. */
  dataDir: string;
  auth: AuthProvider;
  blobs?: BlobStore;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
}

export async function startNodeHost(opts: NodeHostOptions): Promise<SequencerHost> {
  return todo("startNodeHost");
}

/** A host and a matching Transport in one process, with no sockets (tests, local single-machine sharing). */
export function createInProcessHost(opts: { auth: AuthProvider; blobs?: BlobStore; dataDir?: string }): { host: SequencerHost; transport: Transport } {
  return todo("createInProcessHost");
}

/** SequencerStorage over a node:sqlite DatabaseSync (BEGIN IMMEDIATE transactions). */
export function nodeSqliteStorage(path: string): SequencerStorage & { close(): void } {
  return todo("nodeSqliteStorage");
}

/** A WebSocket Transport for Node clients (Node 24's global WebSocket). */
export function webSocketTransport(): Transport {
  return todo("webSocketTransport");
}
