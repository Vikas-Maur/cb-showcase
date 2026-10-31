# @carton/server

The pure sequencer core for shared cuts (PLAN §6.1, §6.3, §5.3, §12). It validates and orders pushes, never merges,
renders or keeps document state, and holds nothing in memory that its storage can't rebuild. It has no transport or
platform code: a host (`@carton/server-cloudflare`'s Durable Object, `@carton/server-node`, or the in-process host
here) owns the sockets and the storage and hands it messages.

## Hosting it

```ts
import { createSequencer } from "@carton/server";

const seq = createSequencer({
  storage,            // SequencerStorage: sync SQL (DO ctx.storage.sql, node:sqlite)
  auth,               // AuthProvider (createHmacAuth for the demo)
  blobs,              // optional BlobStore: keyframes, archived segments, change bodies over 1 MB
  timeline,           // optional: the schema's timeline config (default: Cardboard's)
  groupOf,            // optional: field → group name (default: the timeline's time group)
  projectId,          // optional: refuse tokens for another project
});

// per authenticated socket
seq.attach(conn);                    // conn: { id, auth, send(msg), state? }
await seq.handle(conn, msg);         // one message; processed one at a time per project, even across blob awaits
seq.disconnect(conn);

// periodic (DO alarm, Node timer)
const { nextAt } = await seq.maintain();   // archives rows older than the newest 10,000 to gzip segments (§18)
```

- **Hibernation.** A connection may carry `state: { subs: string[], deadEpoch: number }`. The sequencer creates and
  mutates it (`hello` subscribes; a reject kills an epoch). Persist it with the socket after each `handle`, and after a
  wake `attach` every socket with its restored `state`, so fan-out reaches them.
- **Fan-out** is `conn.send` on every attached connection subscribed to the branch. A pusher gets its row before its
  ack, so a later reject never has to re-send rows. Presence is relayed the same way and never stored.
- `createInProcessHost` is a complete reference host (and the Transport tests use): read it for the glue.

## Storage (the §6.3 DDL, from the P5 proof)

`changes(branch, seq, …)`, `records(branch, coll, id, seq, alive, lane)`, `branches`, `rids`, `keyframes`,
`segments` — all `WITHOUT ROWID`, no secondary index. A change writes 1 row, plus 1 per record insert, remove or track
change; a reject or a duplicate writes nothing. Every read is a primary-key range or lookup: the overlap test reads
at most K = 100 rows (a push further behind is rejected "behind" without a scan), and the confirmed-id list reads at
most K + 1 ids per base a pending id was pushed on, from the segment index when the range is archived.

## The protocol

Messages are in `@carton/core` `sync` (`messages.ts`): `hello` (claims, rids), `push` (pipelined, epochs),
`withdraw` (H1), `adopt` / `branchStatus` (the hand-off), `fork`, `keyframe` (uploaded when an ack asks), `presence`.
The rule a push is judged by is `@carton/core` `sequencer.evaluatePush`, shared with the local sequencer.

## Tests and benchmarks

- `npm test`: the server's own cases (K cap, span checks, per-branch existence with nested forks, H1/H3/H4, the
  bounded confirmed-id list live and archived, rid binding and the hello claim, rows written per change, keyframes,
  restart safety, large bodies, catch-up paging) plus the HMAC auth's.
- The system suite (`@carton/conformance` `systemSuite`) runs the real sync clients against this sequencer in a
  deterministic simulation; `hostSuite` checks a host over its own transport.
- `bench/push-cpu.ts`: CPU per push against the P5 prototype on the prototype's scenarios (`bench/run-push-cpu.sh`
  runs it three times inside the box's CPU lock). Numbers are UNVERIFIED until re-run by a verifier.
