# Running the conformance suite against your integration

`@carton/conformance` is how you know your Carton integration keeps Carton's promises. It has one suite per plug-in
interface (Store, BlobStore, SequencerHost…), plus suites for the engine and for the sync protocol. A plug-in is
accepted when it passes its suite unchanged, and nothing else in Carton has to change (plan §3.1).

Each suite is a function that registers `node:test` tests. You call it in a test file with your implementation, and
run the file with `node --test`. A test may skip itself only when your plug-in lacks an optional feature (for example
signed URLs). Never skip one to make a suite pass.

## Start from the templates

[`conformance/`](conformance/) has one template per area. Each runs today against an implementation that ships with
Carton; swap the lines marked `← your …` for yours.

| Template | Suites | Checks your… | Stand-in it runs on | Result on this machine |
|---|---|---|---|---|
| [`store.test.ts`](conformance/store.test.ts) | `storeSuite` | client-side history `Store` | store-sqlite, store-memory | 52 pass |
| [`local.test.ts`](conformance/local.test.ts) | `leaseSuite`, `identitySuite`, `localSuite` | Store as the sync lease; your `IdentitySource`s | store-sqlite (two connections) | 12 pass |
| [`cardboard.test.ts`](conformance/cardboard.test.ts) | `hostAdapterSuite`, `identitySourceSuite`, `cardboardSuite` | `HostAdapter` on your projects; identity from `CARDBOARD_ACTOR` | `cardboardAdapter`, Cardboard-made fixtures | 32 pass |
| [`engine.test.ts`](conformance/engine.test.ts) | `engineSuite`, `fuzzSuite`, `cardRateSuite` | schema (fields, groups, validators) | `@carton/cardboard`'s `cardboardSchema` | 99 pass, 2 skip |
| [`host.test.ts`](conformance/host.test.ts) | `sequencerHostSuite`, `transportSuite`, `hostSuite`, `liveSyncSuite`, `sequencerStorageSuite`, `authProviderSuite`, `httpApiSuite` | host, its SQL storage, transport, auth and HTTP API | server-node over WebSocket, HMAC auth | 44 pass, 1 skip |
| [`system.test.ts`](conformance/system.test.ts) | `systemSuite` | the sequencer's SQL storage, under the whole sync protocol | node:sqlite files | 107 pass (quick) |
| [`blob.test.ts`](conformance/blob.test.ts) | `blobStoreSuite` | `BlobStore` (your bucket) | blob-fs; blob-memory with signed URLs | 43 pass, 1 skip |
| [`media.test.ts`](conformance/media.test.ts) | `hasherSuite`, `mediaStoreSuite`, `proxyEncoderSuite`, `browserParitySuite` | `Hasher`, media over your BlobStore, `ProxyEncoder` | node:crypto, WebCrypto, blob-fs, ffmpeg | 16 pass, 6 skip |

The results are from running each template here (Linux, Node 24.21; engine and system with their reduced "quick"
counts). The skips: engine B8 and B11 are system-level and always skip; blob-fs has no signed URLs; the host template
gives clients no blob store, so `liveSyncSuite`'s envelope test skips; the NVENC, QSV and AMF encoders skip without
their GPU. `browserParitySuite` runs only when `PLAYWRIGHT` points at a Playwright install.

```sh
cd carton
export CARTON_SCRATCH=/some/scratch/dir         # optional; default: <os tmp>/carton-conformance
node --test kit/conformance/store.test.ts
node --test kit/conformance/host.test.ts
FULL=1 node --test kit/conformance/system.test.ts   # FULL=1: every file and the full fuzz counts (slow)
```

Run them from inside `carton/` (or a project that depends on the `@carton/*` packages). Node 24 runs the `.ts` files
directly, with no build. Pass Node's flags **before** the files: `node --test --test-name-pattern=B1 file.ts`.
`pnpm test --test-name-pattern=B1` passes them after the glob, where Node silently ignores them.

## What each suite proves

### Your Store: `storeSuite(name, make, { second?, reopen? })`
26 cases on the ordered key–value store history lives in. Reads of missing keys; key order (numbers before strings,
numbers by value, strings by UTF-16 code unit, `-0` = `0`); ranges with prefix, bounds, reverse and limit; atomic
conditional batches (`absent`, `present`, `equals`), where a failing condition writes nothing; 50 concurrent batches;
the compare-and-swap append the local sequencer uses, on one handle and across handles (4 × 25 appends, none lost);
`watch`; persistence; a 2 MB value; NaN keys refused. A store that says it is multi-process must give `second` (another
handle on the same data), and a persistent one `reopen`, or those cases fail on purpose. Browser stores run the same
cases in the page: import `storeCases` and `runStoreCase` from `@carton/conformance`'s `src/store/suite.ts` by file
path (the package's main entry needs Node), as `packages/store-idb/test/page.ts` does.

### The sync lease and who is acting: `leaseSuite`, `identitySuite`, `localSuite`
The lease (3 cases): a free lease goes to exactly one of two takers; a takeover is a compare-and-swap on the nonce the
taker saw; a replaced holder's heartbeats, release and fenced writes fail. With `second`, the races run across two
handles, as two processes would. Identity (3 cases): the same environment gives the same actor; a source never invents
a turn or an agent id (only `CARDBOARD_ACTOR` names a Director turn, and a hostile one is refused); local actors share
one undo group. Process-level behaviour (a helper killed or hung mid-call, handover, a stalled holder) is in
`@carton/local`'s own tests.

### Your adapter: `hostAdapterSuite(name, adapter, { hosts })`, `identitySourceSuite`, `cardboardSuite()`
Per project you give it: converting a project is deterministic byte for byte, and converting it back and again is not
a change; unmoved records keep their sequence keys; the GUI projection (when the adapter has one) is idempotent.
`cardboardSuite()` (no options; `await` it) runs that on `@carton/cardboard` with projects Cardboard's own CLI wrote,
plus: a project round-trips and materializes back unchanged, an agent's CLI apply diffs to exactly the records it
touched, and B10 (below). Feed `hostAdapterSuite` your own real `project.json` files: the template reads a folder of
them (`SAMPLES=/path`).

### Your schema and the engine: `engineSuite`, `fuzzSuite`, `cardRateSuite`
The scenarios the plan was proved with, ported with their names:
- **B1–B13**, Cardboard's bugs today: a lost update becomes a card; a pruned base is an error, never a silent revert;
  a GUI save touches only what changed; nested values merge per key; deleting a track never drops a clip just added
  to it; history beyond 20 snapshots; authorship down to the subagent; no "(recovered conflict)" copies; the lossy GUI
  serializer (B10); track order as a sequence; crossing trims never make an invalid clip. B8 (media ids) and B11 (the
  renderer's adopt) are system-level and always skip here: the media suites and G1 cover them.
- **S1–S7**, the expired-ref cases, `.cbproj` round trips (Alice → Bob → Alice twice, then a third fold), partial
  accept, fractional interleaving (4 × 1,000 trials), remaps and ripple inference, shot diff, describe wording.
- **Fuzz:** the version graph against a full-state reference, three replicas exchanging `.cbproj` files, apply
  determinism, remap transformation, key generation.
- **Card rate:** on a realistic mix of concurrent edits, at most 1.5% of merges raise a card, and none is invalid.

The scenarios are written in Cardboard's terms (tracks, timelineItems, the time group), so this suite checks a schema
that describes those fields: `@carton/cardboard`'s, or your edit of it. Without `schema` the suites use the pinned
fixture they were proved with. The template's quick counts are for every run; `FULL=1` gives the defaults.

**B10 with your real projection.** The engine suite's B10 reads Cardboard 1.4.0's shipped renderer bundle
(`cardboardDir`, or `CARTON_CARDBOARD_DIR`), and `cardboardSuite`'s B10 reads a pretty-printed copy of it
(`CARTON_CARDBOARD_RENDERER`); both skip without it. From your source, test your own save projection directly: pass
it to `createCardboardAdapter({ projection })` and check that a GUI save with one person's edit, on a timeline an agent
set to frame-accurate times, changes exactly that edit (`kit/test/samples.test.ts`, "H4", shows the shape).

### Your host: `sequencerHostSuite`, `transportSuite`, `hostSuite`, `liveSyncSuite`
All four take one `HostFixture`: your host's URL, the Transport clients use, an `AuthProvider` that can issue test
tokens, a fresh device credential per `token()` call, and optional hooks that turn on stricter checks: `restart()`
(restart on the same storage), `rows()` (rows read and written), `tokenFor()` (a token for exactly this credential)
and `clientBlobs(token)` (the blob store a client uses for large messages). The template gives the first three.
- `sequencerHostSuite` (9): a token the host didn't issue never reaches the sequencer; an accepted change reaches every
  subscriber before the pusher's ack; 20 pipelined pushes acked in order; a viewer's push refused; presence relayed
  and never stored; replica ids bound to the device credential; a duplicate acked with its first seq; the host adds no
  rows of its own (1 per edit, 2 per insert); everything survives a restart.
- `transportSuite` (4): 200 pipelined changes acked and fanned out in order; a 300 KB change whole; close fires once
  and nothing comes after; an aborted connect.
- `hostSuite` (10): the protocol through your host: idempotent hand-off, row-before-ack fan-out, rejects and
  duplicates, replica-id claims, withdraw (H1), the 100-behind cap, restart safety, and two real sync clients trimming
  one clip at once and converging.
- `liveSyncSuite` (2): two real replicas edit one cut at once, the same field included, and settle on one head. With
  `restart`, the host restarts under them and they reconnect on their own (without it, that half is not run). With
  `clientBlobs`, a change over 32 MiB travels as blob envelopes, up to the host and down to the other replica (it
  skips without).

### Your SQL storage: `sequencerStorageSuite`, and `systemSuite`
`sequencerStorageSuite` (6): parameters bound as data, BLOBs exact, transactions all-or-nothing, `WITHOUT ROWID`
range reads, one row written per inserted row, and (with `reopen`) durability. If your SQL runs only inside your
platform, as Durable Object SQLite does, run `storageChecks()` there instead: the same checks with no test runner
(`packages/server-cloudflare/test/test-worker.ts`).

`systemSuite(name, { storage, quick })` runs the whole sync protocol in a deterministic simulation (virtual time,
simulated links and crashes) around the real sync client and sequencer, with your storage under the sequencer: the 97
scenarios of the verified prototype with their names, holes H1–H4, the v14 additions, shared cuts and oversized
changes. It includes R1-01 (the four-step scenario), R2-02 (`cb` statuses, late conflicts, the Stop hook), R2-03 (two
parallel subagents × three edits), R2-08 (an external `cb` then ⌘Z), R3-03 (hand-off and diverged replicas joining),
R4-04 (a dead helper's push lands once), R5-06 (fencing), R7/R8 (the shared file and displace-then-install), G1, and
P9 (single-track contention; with `quick: true`, P9, chaos and G1 are left out). `storage` is a synchronous factory
called once per simulated world. Call `systemSuite` once per test file: the storage is process-wide.

### Your bucket: `blobStoreSuite(name, make, opts)`
22 tests: bytes, size, content type and real SHA-256; your buffers never shared; exact ranges, clipped at the end;
invalid keys and ranges refused before any I/O, legal odd keys kept (case, Unicode, `CON`, 1,024 bytes); listing
visits every key once; multipart out of order, resumed by id after a restart, completed in part order, a re-uploaded
part replacing the old one; atomic replace under concurrent readers; signed URLs, bound to their key, expiring. It
writes under a random `conf-…/` prefix and deletes what it wrote, so a real shared bucket is fine. Options:
`minPartSize` (5 MiB for S3, R2 and GCS interoperability), `objectsBesideFolders: { reason }` for POSIX-backed S3
servers, `fetch` and `expiryWaitMs` for signed URLs.

### Your accounts: `authProviderSuite(name, make, { advanceClock? })`
`verify` returns null, never an exception, for tokens it didn't issue. With `issue` (a test-only one is fine) it also
checks that every claim round-trips for every role, that one token always gives one credential, that any changed
bit invalidates it, and (with `advanceClock`) expiry. Not checked anywhere yet: that `verify` takes constant time, and
that a commenter can't push (only a viewer's push is tested).

### Your host's HTTP API: `httpApiSuite(name, make)`
9 tests on the routes every host serves through `@carton/host-http`: health; the first owner only through the admin
token; joins with bad or foreign invites refused; only owners invite; refresh keeps the device credential; the
WebSocket takes the session in its subprotocol; signed media URLs with ranges, bound to key, project and method;
resumable multipart over HTTP.

### Media: `hasherSuite`, `mediaStoreSuite`, `proxyEncoderSuite`, `browserParitySuite`
SHA-256 and media ids against independent vectors; uploads that store a manifest and dedupe, resume after a cut link
from the parts that landed, and refetch a corrupt leaf; a play-first read that stops on a bad leaf; proxies that are
seekable H.264/AAC MP4s at the profile, with progress and abort (each encoder skips where its GPU or library is
missing); and the same media ids in headless Chromium (bytes, `Blob`, a picked `File`, a Web Worker) as in Node.

## What the suites can't prove for you

The suites prove Carton's behaviour and your plug-ins. They can't drive your app. For each hook,
[INTEGRATION.md](INTEGRATION.md) lists the integration test to write in your repo (four concurrent `cb source apply`
keep all four edits; a GUI save during an agent apply keeps both; a change from elsewhere is adopted with no undo
entry…). Our versions of those tests, against Cardboard 1.4.0's shipped bundles, are in `scripts/carton/test/`. Then
the gates on real machines: G1 (3 remote writers at 1/s for 10 minutes), G2 (GUI save latency with 4 agents applying
at once) and the displace/install race on NTFS and APFS (`carton/bench/race/`).

## The plan's list (§15), and where each item is

| §15 item | Suite | Test |
|---|---|---|
| B1–B13 | `engineSuite` | `B1 lost update …` to `B13 / coupled-times …` |
| R1-01's four-step scenario | `systemSuite` | `R1-01 four-step scenario, …` |
| S1–S7 | `engineSuite` | `S1 …` to `S7 …` (S6 is B10) |
| expired ref | `engineSuite` | `expired ref → error: …` |
| `.cbproj` twice, then a third merge | `engineSuite` | `.cbproj Alice → Bob → Alice twice, then a third merge …` |
| diverged replicas joining | `systemSuite` | `§5.3 two replicas with diverged local "main" both share …` |
| partial accept | `engineSuite` | `§5.3 partial accept …` |
| single-track contention | `systemSuite` (not `quick`) | `P9/S2 …`, `P9 single track, RTT …` |
| coupled times | `engineSuite` | `B13 / coupled-times …` |
| fractional interleaving | `engineSuite` | `fi-interleave M4, …` |
| two parallel subagents × three edits | `systemSuite` | `R2-03 two parallel subagents × three dependent edits …` |
| an external `cb` followed by ⌘Z | `systemSuite` | `R2-08 external cb then ⌘Z …` |
| the displace/install race | `systemSuite` | `Displacement …` (and the race harness in `carton/bench/race/`) |
| remap tests | `engineSuite`, `fuzzSuite` | §7 remaps, R5-01, R5-02, R6-01, ripple, `TP1` |
| DAG fuzz and apply-determinism fuzz | `fuzzSuite` | `DAG fuzz …`, `apply determinism …` |
| shot diff | `engineSuite` | `shot diff: …` |
| the load test (P9) | `systemSuite` | `p9-contention` checks the P9 targets in simulation; the full matrix is a benchmark (`carton/bench/p9/`) |

## Carton's own runs

- **Every suite on every shipped implementation:** `cd carton && pnpm test` runs each package's tests in turn. Cloudflare's
  run inside `wrangler dev` and fail, not skip, when wrangler can't start. store-idb's run in headless Chromium.
- **The conformance package itself:** `cd carton/packages/conformance && pnpm test`: 351 tests on this machine, 348 pass,
  2 skip (B8, B11), 1 marked todo that passes. It also runs Cardboard-specific scenarios on the real engine and
  materializer (`src/cardboard/system/`) and checks against Cardboard 1.4.0's real CLI. These need things only this
  machine has: the 1.4.0 CLI (`CARTON_CARDBOARD_CLI`), its renderer bundle, `python3` for a zip cross-check. Without
  them those checks skip (or, for the zip cross-check, are left out).
- **Environment variables** the suites read: `CARTON_SCRATCH`, `CARTON_TEST_TMP` (scratch folders);
  `CARTON_CARDBOARD_DIR`, `CARTON_CARDBOARD_RENDERER`, `CARTON_CARDBOARD_CLI` (Cardboard 1.4.0's files, for B10 and the
  CLI checks); `FUZZ`, `DAG`, `MULTI`, `DET`, `TP1` (fuzz counts in the package's runners); `VERSITYGW_BIN` (blob-s3
  against a real S3 server); `PLAYWRIGHT`, `CHROMIUM` (media's browser parity) and `CARTON_PLAYWRIGHT`,
  `CARTON_CHROMIUM` (store-idb's); `FFMPEG`, `FFPROBE` (media's encoders).
- **Only on other machines:** the GPU proxy encoders (NVENC, QSV, AMF) need their GPUs; the displace/install race gate
  runs on NTFS (`carton/bench/race/run-windows.ps1`) and APFS; none of the suites has run on Windows or a Mac yet.
