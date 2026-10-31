// The pure sequencer core (PLAN §6.1, §6.3, §5.3): validates and orders pushes, never merges, keeps no document
// state. Runs inside any SequencerHost (Durable Object, Node). Rules ported from system-v11 `server.mjs` and the do-seq
// DDL: 1 row per change (+1 per record insert/remove/track change), K = 100 behind cap, dedup by id in the tail since
// base, confirmed-id lists bounded to (b, b + K + 1] (R10-01, R12-01), withdraw (H1), rid bound to the device
// credential (R10-02), spans checked after the overlap test (H4), records existence per branch with a fork-chain
// lookup in each parent's own seq numbering (H3), lww rejected on structure (R11-01), idempotent adoption keyed
// (branchId, n, stateHash@n). Owner: sync-sequencer.
//
// A host stays thin: authenticate the socket (`auth.verify`), hand each message to `sequencer.handle(conn, msg)`,
// keep `conn.state` with the socket across hibernation and `attach` the sockets again after a wake.
export {
  createSequencer,
  CARDBOARD_TIMELINE,
  type Sequencer,
  type SequencerOptions,
  type SequencerControls,
  type SequencerEvent,
  type SequencerStats,
  type ConnectionState,
  type HostConnection,
} from "./sequencer.ts";
export { DDL, Tables, type Row, type StoredBranch } from "./tables.ts";
// The demo AuthProvider is hosts-plugins' (hmac-auth.ts, a contract(server) commit); re-exported here per CONTRACTS.md.
export * from "./hmac-auth.ts";
export { createInProcessHost, type InProcessHost } from "./in-process.ts";
