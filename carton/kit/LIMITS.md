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

- **Opening a project still reads every change row, after open returns** (new). Keyframes are stored (every 64 changes,
  and at named, fold, export and Published versions). On a local cut, open and the first `head()` read only the newest
  keyframe and the rows after it; the older rows load in the background, newest first, in pages. Every call that can
  reach them waits for them (`log`, `credits`, `diff`, `checkout`, every write…), so a commit right after open pays for
  them once; `head()`, `cuts()`, `pendingCount()` and `notices()` don't wait. Shared and tracking cuts (and a cut that
  an older fork without its own fork state forks from) are read whole at open, as before. The whole log still goes into
  memory, and every `cb` call opens the project. Compaction is optional.
- **A compaction during the background load** (new). A handle holds older versions as its background load reads
  them: a compaction another process makes before then squashes them for this handle too, as for one opened after it.
- **Fonts aren't synced (L4), and no validator warns about them yet.** The Cardboard schema's soft checks cover overlaps
  only.
- **Split lineage from before the fix** (new). Merges and `.cbproj` lineage edges made before foundation's lineage
  fix carry no split lineage, so an edit that reaches a split clip only through them reaches its first piece only. A
  retime of a split clip is a card by design (PLAN §7).
- **Ripple inference is a heuristic (L9).** Carton infers a ripple from an agent's file edit only when it is
  unambiguous. Recorded intents (H7) are the reliable path.
- **FAT and exFAT have no hard links (L13).** There, a save from another program that lands in a very short window can
  be overwritten. Carton moves `carton.db` out of such a bundle and warns.
- **Where the history lives (L15).** In cloud-synced folders, on network shares (new: WAL needs shared memory), on
  FAT/exFAT, and in folders it can't write (new), `carton.db` lives in app data instead of the bundle. Synced folders
  are found by known locations (OneDrive, Dropbox, iCloud, Box, Windows' sync-root registry), not by file attributes, so
  a sync client it doesn't know is missed. Two more gaps in the wiring: a `carton.db` made on another machine is set
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
- **A later shallow `.cbproj` from the same sender doesn't extend a cut held read-only from an earlier file's
  history.** Its newer versions come in as a separate cut `<cut>.<hash8>` linked to the versions both hold, so a fold
  still finds the right base. PLAN §13 asks for lineage that finds the base, not one cut per sender. Workaround: bring
  the later file in with its history (`importHistory` grows the tracking cut).
- **No export of a state that includes waiting offline edits.** Every export's history (the shallow export) ends at a
  confirmed version with its state hash; a state with pending edits has none yet, and confirms later under another seq
  and hash, so a copy built on it couldn't find its base. §13's "Offline edits (date)" variant, whose head could be
  exported, isn't built. Meanwhile: `carton.pendingCount(cut)` to wait, or export the confirmed head.
- **The first version.** `importProject` makes the current document `main@1`, as §16 says. `openLocal({ init })`
  instead records it as the root state at seq 0. Use `importProject` for migration.

## For agents

- **Identity (L1).** Claude Code gives every subagent an id through its hooks, so credits go down to the subagent and
  late conflicts reach the agent through the Stop hook. Codex, Gemini and others declare who they are (`--as
  codex/fix-captions`); that is checked for shape only, not authenticated, and their late conflicts arrive as notices
  on their next `cb` call. With H9 wired, agents the app starts get a per-chat actor from the app without declaring
anything.
- **Ctrl+Z doesn't reach a terminal's agents** (new, by design, laptop report 90c4127). It covers the person's own
  edits and the agent turns they started in the app, from the editor's session only. A `cb` agent in a terminal, even
  on the same machine, is undone from History ("Undo turn") or with `cb undo --turn`. An undo that clashes with a
  later change does nothing but raise its cards; there is no partial undo from Ctrl+Z.
- **The hook's prefix is shell syntax** (`export CARDBOARD_ACTOR=…;`). Claude Code runs Bash commands in Git Bash on
  Windows, so it should work there, but that hasn't been run. An agent whose shell is cmd or PowerShell doesn't get it.
- **`cb` on a shared cut waits up to 5 s (L14)** for the server, then answers `pending`; offline it answers `pending`
  at once, and conflicts come later as notices.
- **While an agent turn is running, the shared `timeline.tsx` is frozen (L16).** From the agent's first Read of it
  until its turn's Stop, Carton doesn't rewrite it with the person's or remote teammates' changes; the app always shows
  head. Local agents' saves still go into it, and so do their confirmed `cb` changes; on a shared cut, only those of
  agents hooked here (cardboard-adapter's head; not yet in the snapshot the kit runs on). It can show newer state
  before the Stop. A plain `cb source print` and a cut switch reprint it from head. A save that repeats an edit the file
  hides, or whose check for that reads more than its limit of changes or fails, restarts the freeze from that save's
  state; a `cb` change restarts it from that change's state when merging it wouldn't add exactly its edits (it repeats,
  overwrites or builds on an edit the file hides). Claude Code sends no
  Stop when the user interrupts a turn, so a hooked agent's hold also ends 60 s after its last hook event, and its next
  event holds the file again. An agent that isn't hooked holds it for 60 s after each save or `cb` call.
- **`cb` talks to the app over a local socket, one JSON line per message.** A `cb` save carries the whole project, and
  an answer can carry the head. The reader drops the connection when the part of a message it is still waiting for
  passes 64 Mi UTF-16 code units (counted after UTF-8 decoding, not in bytes), and `cb` can fail at once or after
  retries. A message within that cap always passes this check; a larger one may pass or fail, depending on how it
  arrives in pieces.
- **The file-tool hook runs on every matching tool call.** `hookSettings` gives host Claude Code a PreToolUse matcher
  `Read|Write|Edit|MultiEdit`, so a hook process starts for every Read or edit of any file; it acts only on the
  project's `timeline.tsx` and `project.json`. Claude Code's `if` conditions on each hook (`Read(**/timeline.tsx)`,
  `Edit(**/project.json)`…, one per tool and file) start no process for other files; our Windows build uses them
  (checked against Claude Code 2.1.309 and 2.1.316 on Linux). `hookSettings` doesn't add them yet. The cost per call
  hasn't been measured.
- **The shared `timeline.tsx` (L18):** two outside writers replacing each other's file within the watcher's latency can
  lose the first save, as in 1.4.0. Per-agent views (`.scratch/views/<name>.tsx`, one writer each) avoid it, but they
  print only through a process that runs the materializer: the app's library worker once H8 is wired. The default
  headless helper doesn't run one, so with the app closed `cb source print --view` answers "views need the app open".
- **The standalone `carton` command can't reach a server.** It has no option for the host's URL or token, so its writes
  to a shared cut fail. Inside Cardboard, `cb` goes through the app's engine. There is no `cb share` command yet
  (sharing is `carton.share()`).

## Shared cuts and live editing

- **"Invite to edit" needs the invite to carry the cut.** `Carton.open({ init: { join } })` opens a shared cut on a
  device that holds nothing; the rows come from the host. But the joiner needs the cut's record and its root state
  from whoever invited them (the quickstart's `live.ts` passes them along); the host's API doesn't hand them out yet.
- **Large changes need a blob store on the client.** Messages over 1 MiB can travel as blob "envelopes" when
  `Carton.open`'s `sync` is given the host's blob store (`sync.blobs`). Without one, a change or a share over the
  message limit (32 MiB) is refused as too large. `openLocal({ sync })` passes the `sync` you give it (blobs
  included) to the process's own handle. The headless helper passes the host's blob client
  (`@carton/host-http/client`) when it can load it, unless its sync settings say `blobs: false`.
- **A watch link's viewers see the generic person.** In a shared project, editors see each GUI edit under the name of
  the person behind the device (`setIdentity`). A reader scoped to a Published cut (a watch link) gets no people from
  the host, so it never learns the team's accounts and names, and every GUI edit there shows as the generic person.
  (`carton/docs/plugins.md`, "People".)
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
| The kit's own tests | `kit/test/*` run on CI's Linux, Windows and macOS machines; nothing on a user's own machine |
| Gates (§16) | G1 (3 remote writers at 1/s for 10 minutes), G2 (GUI save latency with 4 agents), on real machines |

## Our Windows build (for reference)

With Carton off (the default), every Carton hook there runs Cardboard's own code, except three changes that apply
either way: the staging folder's removal after Open Project retries on Windows; Open Project of a `.cbproj` that holds
Carton's data removes, from the staged copy only, the `.carton\` folder and the view files Carton wrote in
`.scratch\views\` (a person's or an agent's own files there stay; a stock `.cbproj` opens as before); and Save As of a
`.cbproj` leaves the same files out. The repository's README, "Saves on Windows", has the details.


Our build of Cardboard 1.4.0 for Windows wires Carton into Cardboard's real bundles. Tested on Linux with the real
library worker and `cb`: history, cuts, fold, credits and `undo --turn`; the per-agent views and the `timeline.tsx`
freeze (H8), with the Director's and host Claude Code's hooks; and, between two libraries through a host on
127.0.0.1, sharing, live edits, presence, offline and back, shared media (H10), `.cbproj` with history and "Bring in
their changes" (H11), and `cb`'s cloud mode (H13). The editor's pages (H4–H7, the History tab, the Share panel) and
main's hooks run only on Windows, so they have been tested against stand-ins. It is off by default
(`CARDBOARD_CARTON=1`) until G1 and G2 pass. Not wired there yet: Carton's merge in the apply's preview (H3), the
engine thread, a hook of its own for H1b, and H12 (dormant on desktop). This is windows-sync's branch, ahead of the
snapshot the kit runs on; `carton/docs/INTEGRATION-1.4.0.md` §6 has the details.
