// The pure sequencer core (PLAN §6.1, §6.3, §5.3): validates and orders pushes, never merges, keeps no document
// state. Runs inside any SequencerHost (Durable Object, Node). Rules ported from system-v11 `server.mjs` and the do-seq
// DDL: 1 row per change (+1 per record insert/remove), K = 100 behind cap, dedup by id in the tail since base,
// confirmed-id lists (R10-01), withdraw (H1), rid bound to the device credential (R10-02), spans checked at the
// change's base (H4), records existence per branch with a fork-chain lookup in each parent's own seq numbering (H3),
// lww rejected on structure (R11-01), idempotent adoption keyed (branchId, n, stateHash@n). Owner: sync-sequencer.
import type { AuthProvider, BlobStore, SequencerConnection, SequencerStorage } from "@carton/core/plugins";
import type { sync } from "@carton/core";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** The §6.3 DDL: no secondary indexes; WITHOUT ROWID so a change writes one row. */
export const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS changes (branch TEXT, seq INTEGER, id TEXT, hash BLOB, author TEXT, base TEXT,
    paths TEXT, reads TEXT, spans TEXT, policy TEXT, ops BLOB, blob TEXT,
    PRIMARY KEY (branch, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS records (branch TEXT, coll TEXT, id TEXT, seq INTEGER, alive INTEGER,
    PRIMARY KEY (branch, coll, id, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS branches (branch TEXT PRIMARY KEY, rec TEXT) WITHOUT ROWID`,
];

export interface SequencerOptions {
  storage: SequencerStorage;
  auth: AuthProvider;
  /** Keyframes and archived change segments (R2 in production). */
  blobs?: BlobStore;
  /** K: how far behind a push may be before it is rejected without a scan (default 100). */
  maxBehind?: number;
  keyframeEvery?: number;
  /** The newest schemaVersion this sequencer accepts in hello. */
  schemaVersion?: number;
  clock?: () => number;
}

export interface Sequencer {
  /** Handle one message from an authenticated connection. Messages of one project are handled one at a time. */
  handle(conn: SequencerConnection, msg: sync.ClientMessage): void;
  /** The connection closed: drop its subscriptions (its rid bindings stay, they belong to the credential). */
  disconnect(conn: SequencerConnection): void;
  /** Cancel a share (§5.3: an explicit server-side operation). */
  cancelShare(branchId: string): void;
}

export function createSequencer(opts: SequencerOptions): Sequencer {
  return todo("createSequencer");
}

/** Demo AuthProvider: HMAC-SHA-256 invite tokens on WebCrypto (§14). The secret comes from the host's environment. */
export function createHmacAuth(opts: { secret: string | Uint8Array; clock?: () => number }): AuthProvider {
  return todo("createHmacAuth");
}
