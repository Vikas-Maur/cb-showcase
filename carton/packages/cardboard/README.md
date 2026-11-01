# @carton/cardboard

Carton's HostAdapter for Cardboard 1.4.0: how a Cardboard project becomes Carton documents, and how Carton writes
Cardboard's files back without ever destroying a write it hasn't seen. PLAN v14 §4.2, §4.3, §6.4, §13, §16.

## Two entry points

| Import | Runs on | What it has |
|---|---|---|
| `@carton/cardboard` | everywhere (no `node:*`) | the schema, project.json ↔ engine conversion, the GUI projection, the `timeline.tsx` header contract, the JSON timeline codec, ripple inference, the `CARDBOARD_ACTOR` identity source |
| `@carton/cardboard/node` | Node and Electron | displace-then-install, the materializer (project.json, the shared `timeline.tsx`, per-agent views and their `.status` sidecars), `.cbproj` export and import, migration of an existing project |

## The schema (§4.2)

- **Root:** `name`, `description`, `aspectRatio`. Nothing else on `project` is versioned: `stateUpdatedAt`, `updatedAt`,
  `id`, `cast` and the rest stay Cardboard's, so a save never turns into a change just because a timestamp moved.
- **tracks:** a sequence ordered by fractional keys. `order` is materialized 0..n-1, so one reorder is one change (B12).
- **timelineItems:** parent `trackId`. The time group `{startTime, endTime, trimStart, trimEnd, playbackSpeed}` merges
  as one unit through the §4.1 edit algebra (move, trim-in, trim-out, slip, speed). Nested objects merge per key.
  `effects`, `captionSegments` and `keyframeTracks` are keyed arrays. Word timings, segmentation data and layout slots
  are blob references. The local-only fields Cardboard rejects (`annotations`, `autoReframeSegmentationStatus`,
  `borderDrawProgress`) are never versioned.
- **media:** only `data.code.source` (merged by line), `data.content`, `data.fileName`, `data.type` and `contentHash`.
- **Hard validators** are 1.4.0's own invariants (times finite, starts ≥ 0, end > start, trimEnd > trimStart, a known
  type, the track exists). **Soft validators** warn about new overlaps and missing media.

## What the host injects

Cardboard's code isn't ours, so the adapter takes it as functions:

```ts
import { createCardboardAdapter, cardboardFilesHost } from "@carton/cardboard";
import { Materializer } from "@carton/cardboard/node";

const adapter = createCardboardAdapter({ projection: fmsvItem });       // 1.4.0's fm∘sv item function (B10)
const mz = new Materializer({ bundle, engine, host: cardboardFilesHost,
  codec: { print: (project, rev) => …, parse: (text, project) => … } }); // 1.4.0's timeline.tsx printer and parser
```

Without them, `cardboardAdapter` has no lossy projection and `jsonTimelineCodec` prints the timeline as JSON under the
same header. `engine` is a `MaterializerEngine` over Carton and carton.db (`@carton/local` provides it).

## Files on disk (§6.4)

- Every Carton write to a watched path is **rename it away, then link the new file**, looping when a foreign write lands
  in between. Displaced files are held in `.carton/displaced/`: Carton's own install is deleted only if its bytes and
  install stamp are unchanged after a 150 ms hold, foreign saves are applied in the order they were written, and a
  half-written file is kept and reported to its writer. On FAT and exFAT, which have no hard links, it falls back to
  stat-then-rename (L13). On Windows, a file another process has open, or a name still being deleted, fails with
  EPERM, EBUSY or EACCES for a moment; every rename, link, unlink, read and stat on these paths is retried with a
  growing backoff, for 5 s in all by default (`busyBudgetMs`). The retries wait on timers, so the worker's thread keeps
  serving everything else; an install that needs none runs synchronously, so the path is missing for microseconds.
  On Linux and macOS these codes are real permission errors and fail at once.
- **The missing window.** Between the displace and the link the path is missing: tens of microseconds on ext4, longer
  on NTFS (bench/race measures it per file system). Windows has no atomic "replace only if unchanged", so an install
  without the window (check the stamp, then rename over) would destroy a save that lands after the check; Carton
  displaces on every OS and makes readers wait instead. Carton's own readers use `retryMissing` (ENOENT retried for up
  to 100 ms), `.cbproj` export included; the app's readers wait while `.carton/install.lock` is held. A writer that
  keeps re-creating the file stops an install after 50 displaced files (`InstallGaveUp`), with nothing lost.
- **The shared `timeline.tsx`** keeps 1.4.0's header contract: `// cardboard:rev main@57~3f9a1c0e b:<branch> p:<nonce>
  by <actor>`, regenerated after every applied save. While a local agent is active it shows the freeze view: the
  person's and remote changes stay out, local agents' own edits (file saves and `cb` changes, on a shared cut also their
  edits still pending offline, as they are now: a rebase that took one of their edits away shows) show at once. While
  the cut is shared remote changes rewrite it at most every 30 s. A project.json write with nothing the print shows
  (`lastOpenedAt`) makes no new print, so an agent's next Edit isn't refused.
- **How old a print can be** (R7-01): each print is pinned, and superseded prints are released once they are past the
  newest 256 and older than a day (`keepPrints`); the print `timeline.tsx` shows on disk keeps its pin, whoever printed
  it (another process, this one before a restart); while the file names none (a writer still writing it), nothing is
  released. A save on a released print still applies exactly when it named a
  confirmed version (no pin needed); one on a freeze view or on edits still pending offline is refused "state unknown:
  re-print". Never a wrong base.
- **A host that writes for its own changes** (the app's GUI save writes project.json after its commit) tells it:
  `onHeadChange("gui", { after })`. The rewrites wait until `after` settles (5 s at most; a write that lands later
  still reaches the file), and with what it resolves to (project.json's envelope and stamp, `HostWrite`) project.json
  isn't read again. A print made meanwhile (`cb source print`, an agent's save) is checked once the write has landed,
  also in a freeze.
- **Per-agent views** `.scratch/views/<name>.tsx` are applied live and never rewritten except by their owner's print.
  The base of a save is the last applied save of the same print, so earlier edits are never merged twice (R4-02).
  After each apply, `.scratch/views/<name>.status` says `confirmed`, `pending`, `conflicts` or `error`.

## `.cbproj` (§13)

`exportCbproj` writes Cardboard's own zip format (stored, zip64 when needed) with two extra entries:
`.carton-export/shallow.json` (the shallow export) and, opt-in, `.carton-export/history.db` (carton.db without its local
tables). It never includes `.carton/` or `.scratch/views/`. `readCbproj` and `bringInTheirChanges` bring a teammate's
file back in as a fold with cards.

## Tests

`npm test` here (unit tests on real files with a fake clock), and `@carton/conformance`'s `cardboardSuite()` (fixtures
made by Cardboard's own CLI, and B10 through 1.4.0's real fm∘sv when a local renderer bundle is available).
`carton/bench/race` is the P10 race harness on this package's displace-then-install.
