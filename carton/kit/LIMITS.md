# What Carton can't do yet

This is the plan's list of limitations (§21, L1–L19), checked against the code that was built, plus what building it
revealed. It describes the merged snapshot of every package on 2026-10-31 (branch `ci/carton`, as merged into the
kit's branch at about 12:40 UTC).

## Numbers

**This kit quotes no performance or size number.** An independent re-run of the packages' own measurements on clean CI
machines has started. It has confirmed some claims, refuted others, and led to fixes. Until a number is in that
verified list, treat every speed or size claim about the built code as **pending verification**. The plan's verified
numbers (§20: P1–P10) were measured on the **prototypes**, not on the built `@carton/*` packages. They show the design
holds; they don't say how fast the built code is.

## For everyone

- **Opening a project still reads every change row** (new). Keyframes are stored (every 64 changes, and at named,
  fold, export and published versions), so only the changes after the newest one are replayed. But every row of every
  cut is still read into memory on each open, and every `cb` call opens the project. Compaction is optional.
- **Fonts aren't synced (L4), and no validator warns about them yet.** The Cardboard schema's soft checks cover overlaps
  only.
- **A split's lineage is used on some paths only** (new). When a local cut's commit is rebased over a split, and when a
  shared cut's queued change is rebased over the host's, an edit made on the old clip also reaches the other pieces. A
  fold, and a shared cut's commit made on an older version, don't use the other side's lineage: there the edit lands
  only on the piece that kept the clip's id. Edits to a clip's time fields or its track never follow lineage.
- **Ripple inference is a heuristic (L9).** Carton infers a ripple from an agent's file edit only when it is
  unambiguous. Recorded intents (H7) are the reliable path.
- **FAT and exFAT have no hard links (L13).** There, a save from another program that lands in a very short window can
  be overwritten. Carton moves `carton.db` out of such a bundle and warns.
- **Where the history lives (L15).** In cloud-synced folders, on network shares (new: WAL needs shared memory), on
  FAT/exFAT, and in folders it can't write (new), `carton.db` lives in app data instead of the bundle. Synced folders are
  found by known locations (OneDrive, Dropbox, iCloud, Box, Windows' sync-root registry), not by file attributes, so a
  sync client it doesn't know is missed. Two more gaps in the wiring: a `carton.db` made on another machine is set
  aside and a fresh history starts, but nothing offers the set-aside history to the user yet; and `@carton/local` keeps
  the placement warning to itself, so `cb` never shows it.
- **Bundles synced between machines by a file-sync client are imported as outside changes (L15), not merged as
  replicas.** An outside save of `project.json` is imported against the head at that moment, so edits that landed after
  its writer read the file are undone by it. They stay in history and the import is credited `external:project.json`.
  This matches today's whole-file behaviour.
- **Writers that edit the shared `timeline.tsx` in place (L19)** can, very rarely, lose a save to Carton's
  displacement; atomic writers lose nothing. The plan's rate is the prototype's; the built code's NTFS and APFS runs are
  still to do.
- **Displace-then-install retries without a limit** (new) when another writer keeps re-creating the file. A broken
  writer can make it spin and fill `.carton/displaced/`. Busy-file waits are bounded.
- **A shallow `.cbproj` (L17)** carries who last changed each clip and the net ripple, not every change. "Undo this
  agent turn" for the sender's agents needs the opt-in full-history export. `Carton.importHistory(store)` reads that
  export back (the sender's cuts arrive read-only, with their versions). `readCbproj` only says whether a file has
  it; `bringInTheirChanges` imports it when given its `history` option (not with `check`).
- **The first version.** `importProject` makes the current document `main@1`, as §16 says. `openLocal({ init })`
  instead records it as the root state at seq 0. Use `importProject` for migration.

## For agents

- **Identity (L1).** Claude Code gives every subagent an id through its hooks, so credits go down to the subagent and
  late conflicts reach the agent through the Stop hook. Codex, Gemini and others declare who they are (`--as
  codex/fix-captions`); that is checked for shape only, not authenticated, and their late conflicts arrive as notices
  on their next `cb` call. With H9 wired, agents the app starts get a per-chat actor from the app without declaring
anything.
- **The hook's prefix is shell syntax** (`export CARDBOARD_ACTOR=…;`). Claude Code runs Bash commands in Git Bash on
  Windows, so it should work there, but that hasn't been run. An agent whose shell is cmd or PowerShell doesn't get it.
- **`cb` on a shared cut waits up to 5 s (L14)** for the server, then answers `pending`; offline it answers `pending`
  at once, and conflicts come later as notices.
- **`cb undo --turn` is all or nothing** (new). If anyone changed any of the same things after the turn, it undoes
  nothing ("Not undone") and lists those cards, which aren't stored for later. §8 asks for the rest to land with cards
  for the clashing parts. (On a shared cut, a clash the server finds after the undo was sent leaves the rest undone,
  with late cards, as for any change.)
- **While an agent turn is running, the shared `timeline.tsx` (L16)** doesn't show others' changes until the agent
  prints again. The app always shows head.
- **The shared `timeline.tsx` (L18):** two outside writers replacing each other's file within the watcher's latency can
  lose the first save, as in 1.4.0. Per-agent views (`.scratch/views/<name>.tsx`, one writer each) avoid it, but they
  print only through a process that runs the materializer: the app's library worker once H8 is wired. The default
  headless helper doesn't run one.
- **The standalone `carton` command can't reach a server.** It has no option for the host's URL or token, so its writes
  to a shared cut fail. Inside Cardboard, `cb` goes through the app's engine. There is no `cb share` command yet (sharing
  is `carton.share()`).

## Shared cuts and live editing

- **"Invite to edit" needs the invite to carry the cut.** `Carton.open({ init: { join } })` opens a shared cut on a
  device that holds nothing; the rows come from the host. But the joiner needs the cut's record and its root state
  from whoever invited them (the quickstart's `live.ts` passes them along); the host's API doesn't hand them out yet.
- **Large changes need a blob store on the client.** Messages over 1 MiB can travel as blob "envelopes" when
  `Carton.open`'s `sync` is given the host's blob store (`sync.blobs`). Without one, a change or a share over the
  message limit (32 MiB) is refused as too large. `openLocal({ sync })` passes the `sync` you give it (blobs
  included) to the process's own handle. The headless helper passes the host's blob client
  (`@carton/host-http/client`) when it can load it, unless its sync settings say `blobs: false`.
- **Version ids are provisional until confirmed (L5).** A share started offline stays "Syncing" until the device
  reaches the server; cancelling a share is a server-side operation only.
- **A process that doesn't hold the sync lease** keeps its own commits on a shared cut queued until it connects. `cb`
  hands its writes to the holder, so it isn't affected; direct API users are.
- **The server validates what it can without document state** (by design): an inserted clip, an edit that sets both
  edges. Replicas validate when merging and turn failures into cards, so a modified client could push edits that are
  invalid against the current state.
- **Latency (L2):** the plan's floor for a committed edit comes from the simulation; it is not measured on the built
  code. Drags are live only as ghosts, and nothing sends ghosts yet.
- **Cost on Cloudflare (L6, L10, L11).** The free plan is bound by rows written. Archiving old rows deletes them, and a
  delete is billed as a row written, so the plan's rows-per-change figure (from the prototype) leaves those out: this is
  arithmetic, not a measurement. The Durable Object CPU limit is undocumented. R2 may need a card; the fallback that
  keeps blobs in a Durable Object is built and passes the same suites. Nothing has been deployed.

## Media

- **Exports without originals are proxy quality (L3).** `carton.media` is not wired on the Carton handle: call
  `@carton/media` directly (INTEGRATION.md, H10).
- **Whole-object proxies play only once their upload finishes.** Multipart objects are invisible on R2 and S3 until
  complete. Streamed proxies (`shareMedia`'s default) play segment by segment while they upload; the whole-object
  path (`proxyStreams: false`) doesn't. The uploader plays either locally at once.
- **The GPU proxy encoders (NVENC, QSV, AMF)** have not run: they need their GPUs. libx264 runs.

## What hasn't run where

Not run yet:

| Area | Not run |
|---|---|
| Any package | Each snapshot's test suites run on Linux, Windows and macOS CI machines. A few Windows- and macOS-only failures are open with their owners. Nothing has run on a user's own Mac (L7) or Windows laptop yet |
| `store-sqlite` | The placement rules on real OneDrive, Dropbox and iCloud folders, mapped network drives and FAT/exFAT |
| `store-idb` | Safari, Firefox |
| `@carton/cardboard` (files) | The full displace/install race gate on NTFS (small runs on CI so far); the FAT/exFAT fallback |
| `@carton/local`, `cli-mcp` | Claude Code's hooks on Windows |
| `@carton/media` | GPU encoders; the range cache under Windows antivirus |
| Hosts | No deploy |
| The kit's own tests | `kit/test/*` run on Linux only (they are outside the workspace's test run) |
| Gates (§16) | G1 (3 remote writers at 1/s for 10 minutes), G2 (GUI save latency with 4 agents), on real machines |

## Our Windows build (for reference)

Our build of Cardboard 1.4.0 for Windows patches H1–H9 and adds the History panel: history, cuts, fold, credits and
`undo --turn` work through `cb` against Cardboard's real bundles (tested on Linux). The editor's pages (H4–H7 and the
panel) run only on Windows, so they have been tested against stand-ins. It is off by default (`CARDBOARD_CARTON=1`)
until G1 and G2 pass. Not wired there yet: the materializer (per-agent views, the freeze), H1b, H10, H11's shallow
export entry and "Bring in their changes" (so a `.cbproj` it writes carries no Carton data), H12, H13, the engine
thread, and any live sync. `carton/docs/INTEGRATION-1.4.0.md` §6 has the details.
