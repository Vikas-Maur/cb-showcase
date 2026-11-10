<img src="assets/icon.svg" width="64" height="64" alt="">

# cb-showcase

Cardboard is an agentic video editor that ships only for Apple Silicon Macs. This repository builds it for Windows,
adds **Carton** (git for video, with live editing together), and fixes bugs that are in Cardboard's own code. We made
it to show the Cardboard team how we work. We don't have Cardboard's source: everything here is a patch to the app
they ship, applied at build time.

**[Download for Windows](https://github.com/Vikas-Maur/cb-showcase/releases/download/windows-latest/Cardboard-1.5.0-windows-x64.exe)**
· [Website](https://cardboard-showcase.vikasmaur10.workers.dev)
· [Changelog](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/)
· [Still in Cardboard](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/?only=cardboard)
· [Carton's cost on Cloudflare](https://cardboard-showcase.vikasmaur10.workers.dev/cost/)

![Cardboard running on Windows](assets/screenshot-windows.png)

## What this is

1. **Cardboard on Windows.** We turn Cardboard's Mac release into a Windows app: its compiled code, patched, on the
   Windows build of the same Electron (43.7.0), with Windows builds of the tools it bundles (ffmpeg, uv, Claude Code).
   The tab strip is the title bar, the Director works from Git Bash, cmd and PowerShell, and imported video is
   decoded and encoded on an NVIDIA GPU, with a fallback to the CPU. It's on Cardboard 1.5.0 since 2026-11-10, ported
   from 1.4.0. Details: [docs/windows-port.md](docs/windows-port.md).
2. **[Carton](#carton), git for video.** Every version of a project, with who made it: you, a teammate, the
   Director, its subagents, your own Claude Code or Codex. Cuts you can fold back together, undo by who did it, and
   live editing with a teammate through a server on Cloudflare's free plan. It's built as a module the Cardboard
   team could drop into their own app.
3. **[Fixes to bugs in Cardboard's own code](#fixed-in-cardboards-own-code).** We found them by reading its code.
   The changelog marks 16 that are still in 1.5.0, each fixed in this build.

**Run it.** Download `Cardboard-1.5.0-windows-x64.exe` from the release
[`windows-latest`](https://github.com/Vikas-Maur/cb-showcase/releases/tag/windows-latest) (Windows 10 or 11,
64-bit). Run it, choose a folder to unpack into, then open `Cardboard\Cardboard.exe` and sign in with your Cardboard
account. It isn't code-signed: if Windows says it protected your PC, choose More info, then Run anyway. If you start
it from a terminal that has `ELECTRON_RUN_AS_NODE=1` set (some Electron-based IDEs set it), unset that first.

## Results

Unless a row says otherwise, measured on one Windows laptop (i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11),
plugged in. Each row compares before and after a change on the same machine, alternating the two. All of them were
measured before the port to 1.5.0, on 1.4.0. The changes they measure are in the 1.5.0 build, except the retired
one in the last row. Where each number comes from: [docs/readme-sources.md](docs/readme-sources.md).

| Change, and what was measured | Before → after | Build and runs | More |
| --- | --- | --- | --- |
| **An idle editor rests.** CPU with one project open, window on screen, nothing moving | 20.3% → 0.7% of a core | 1.4.0-based, 144 Hz screen, 5 runs each, medians | [table](docs/benchmarks.md#an-idle-editor), [#3](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#3) |
| … with four projects open | 64.8% → 2.0% of a core | the same | |
| … while playing, window in front | unchanged: about 143 frames per second and 1.1 cores | the same, 4 runs each | |
| **Draw on the NVIDIA GPU of a two-GPU laptop.** Editor stutters over 50 ms in 19 s of playing a graphic with a video inside | 17–20 → 4–6 | 1.4.0-based, 3 runs each | [table](docs/benchmarks.md#playback-the-timeline-and-the-gpu), [#2](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#2) |
| **Serve the app's files without copies in `%TEMP%`.** Time to fetch 57 of Cardboard's files (9.1 MB) | 170 → 123 ms | Cardboard 1.4.0's own handler in a test app, Electron 43.7.0 for Linux, 20 alternated rounds, medians | [patch 16](docs/windows-port.md#patches) |
| **Retired: draw a graphic with the newest ready video frame**, plus the GPU change. Frames per second of a graphic with a video inside, while playing | 26–37 → 78–88 | 1.4.0 only. Cardboard reworked how a graphic gets its frames (1.4.1, 1.5.0), so the 1.5.0 build uses Cardboard's way | [#2](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#2) |

Import times are in the [patch notes](docs/windows-port.md#patches). They were measured before we had the baseline
build and the independent re-check, so they aren't in this table.

## How it works

`scripts/build-windows.js` downloads Cardboard 1.5.0 for Mac from cardboard.ai, Electron 43.7.0 for Windows, ffmpeg
8.1, uv and Claude Code for Windows. It unpacks Cardboard's code, patches it, and packs it onto the Windows Electron.

- **Anchors that must match exactly.** Each `scripts/patch-*.js` reads a pristine bundle and changes it with
  `replace(from, to, count)`. `from` is exact text in the minified code, and it must match exactly `count` times, or
  the build stops. A new Cardboard version can't break a patch quietly.
- **Helpers.** Larger code goes into helpers injected at the top of a bundle (`__cb…` names: `media-helpers.js`,
  `rename-retry.js`, `strip-titlebar.js`, `asar-assets.js`).
- **The same code still runs on a Mac.** Windows-only behaviour sits behind `__cbWin` (in the pages,
  `window.desktop?.platform === "win32"`).
- **Switches.** Speed changes sit behind `speed`, so `--baseline` can leave them out. Carton is on by default;
  starting Cardboard with `CARDBOARD_CARTON=0` turns it off, and `--no-carton` leaves it out of the build.
- **Documented where they live.** Every patch has a comment saying what it fixes and why, and
  [docs/windows-port.md](docs/windows-port.md) describes each one for users.

**Porting to a new Cardboard version.** Moving from 1.4.0 to 1.5.0 (2026-11-10) went like this:

1. **Anchor by anchor.** Every patch ran against 1.5.0's bundles. 1.5.0 renamed nearly every minified name. All
   but a handful of anchors matched once their short names were renamed. The rest were real changes in Cardboard,
   redone by hand: the new proxy bitrate, and the graphics frame pump, where one speed change was dropped. 1.5.0's
   new Premiere import needed a fix of its own on Windows ([1.5.0 notes](docs/windows-port.md#cardboard-150),
   [INTEGRATION-1.5.0.md §7](carton/docs/INTEGRATION-1.5.0.md#7-cardboard-150-2026-11-10)).
2. **Name by name.** Matching anchors aren't enough: inserted code calls bundle names its anchor doesn't show.
   Tests in the real app caught two mistakes the anchors passed: the title bar's helper still used two of 1.4.0's
   names, and a rename also changed the string `"z"` that Ctrl+Y's patch needs. Then every `replace()` and every
   injected helper was logged on 1.4.0 and on 1.5.0, paired by anchor, and each name in the inserted text was matched
   to what 1.5.0 calls the same thing. That found three more: Carton's editor events, the Join dialog and Import
   Folder (commit `56142f3f`).
3. **In the real app.** The build was tested on the Windows laptop: shortcuts, the title bar and its menus, a
   graphic with a video inside, an export, the Director, History, undo and cuts, a project shared live with a
   teammate on another computer ([changelog #8](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#8)).
4. **Bugs re-read.** The code of every bug marked "Also in Cardboard" was read again in 1.5.0. All of them are
   still there.

## How we proved it

- **Two builds on one machine, never a Mac.** We have no Mac, so we never claim "faster than the Mac". A speed
  claim compares two builds on the same machine: the build before the change and the build after it, or, for the
  media pipeline, the baseline. The baseline (`build-windows.js --baseline`) is Cardboard's own pipeline with only
  what Windows needs to run it. The release ships it beside the app, so anyone can re-run the comparison.
- **Alternating runs, medians, every run listed.** [`scripts/bench/run.js`](docs/benchmarks.md) runs the real app
  with a fresh profile and library each run, drives it over the DevTools protocol, alternates the builds, and writes
  every run with the medians. Measurements are taken plugged in: on battery, Windows slows the CPU and GPU.
- **An independent re-check.** No measured number is published until a separate agent has re-checked the method
  and the numbers, or re-run them ([AGENTS.md](AGENTS.md), rule 6). The changelog says so for every number on it.
- **The real app, on Windows.** Features are tested in the real app on a Windows laptop with an NVIDIA GPU, with a
  throwaway profile and library. `scripts/test-shortcuts.js` presses the shortcuts and checks what each one did:
  25 page tests over DevTools, and 9 more with real keys.
- **Cardboard's own code as the reference.** Carton's tests run against Cardboard's own unpacked bundles. With
  Carton off, `cb`'s output and files must equal the build without Carton. Where a bug can be shown, the changelog's
  "See what happens" dialog plays it in Cardboard's own editor pages, next to this build's.
- **Bugs are Cardboard's only if its code says so.** Each one was found by reading Cardboard's code (1.4.0 and
  1.4.1) and read again in 1.5.0. None was measured on a Mac.

## Carton

Carton is git for video, plus live editing together, built for Cardboard. It keeps every version of a project, says
who changed each clip, down to the subagent, and lets people and agents work on separate cuts and fold them back
together. It uses editors' words, and `cb` also takes git's:

| Carton | git | What it is |
| --- | --- | --- |
| Version | commit | A saved point, made for every save and every agent edit |
| Cut | branch | A separate line of the edit. Only the edit is copied, never the media |
| Fold in | merge | Take all of a cut, or part of it, into another |
| Conflict card | merge conflict | Two edits changed the same thing: both are kept, and someone picks |
| Credits | blame | Who last changed a clip, down to the subagent |
| Restore, Undo turn | revert | Go back to a version, or undo one agent turn, as a new version |

**Its design, in brief** ([carton/kit/README.md](carton/kit/README.md#how-it-fits-together)):

- **One module.** TypeScript with no runtime dependencies. It runs in Electron and Node (Mac, Windows, Linux), in
  browsers and in Cloudflare Workers.
- **One project, one history.** Each project has one `carton.db`. The app, every `cb` process and every agent write
  to it, and SQLite decides the order, so two writers can't overwrite each other.
- **The edit is small, media is big.** Carton versions the timeline. Media files are never copied into history.
- **A conflict is data.** When two edits change the same thing, one lands and the other becomes a conflict card. No
  edit is dropped silently.
- **Sharing is optional.** Everything works offline, with no server. Sharing a cut hands its ordering to a host,
  which checks and orders each change and never merges. Every replica keeps a full copy.
- **Every outside service is a plug-in.** The host, the blob store, the auth, the local store and the editor adapter
  each sit behind a small interface, with a conformance suite.

**In this build** it's on by default, in preview. The title bar shows the cut you're on, History and Share, and every
`cb` goes through Carton. Share fills in this build's own server, which runs on Cloudflare's free plan, so sharing
takes your name and one click. Details: [docs/carton-in-the-app.md](docs/carton-in-the-app.md).

**For the Cardboard team:**

- [carton/kit/](carton/kit/README.md): the injection kit. The words, the architecture and a 5-minute quickstart;
  [INTEGRATION.md](carton/kit/INTEGRATION.md), where Carton goes in Cardboard's source, hook by hook;
  [INJECT.md](carton/kit/INJECT.md), a one-page prompt for your coding agent to wire it in, with checkpoints;
  [SKILL.md](carton/kit/SKILL.md) for agents that edit through `cb`; [CONFORMANCE.md](carton/kit/CONFORMANCE.md),
  to prove the wiring; and [LIMITS.md](carton/kit/LIMITS.md), what Carton can't do yet.
- [carton/docs/INTEGRATION-1.5.0.md](carton/docs/INTEGRATION-1.5.0.md): how it hooks into Cardboard 1.5.0, by what
  Cardboard's code does at each hook, with the exact text each of our patches replaces.
- [carton/README.md](carton/README.md): the packages. [carton/CONTRACTS.md](carton/CONTRACTS.md): the contracts
  every package builds on.
- [The cost calculator](https://cardboard-showcase.vikasmaur10.workers.dev/cost/): what Carton's server costs on
  Cloudflare, with every number marked measured, estimated or assumed.

## Fixed in Cardboard's own code

Bugs in Cardboard's code, not from our port, and still in 1.5.0, its newest Mac release. Each one is fixed in this
build. Some of the most notable:

- **[Two saves at nearly the same moment can undo one.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-saves)**
  Yours and the Director's, even on different clips: each save writes the whole project. Carton saves every change
  against the version it was made on.
- **[An agent's old copy can undo newer edits.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-stale)**
  Once its version drops out of Cardboard's 20-snapshot history, its edit is merged against the current timeline.
- **[An idle editor works on every screen refresh.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-idle)**
  It measures where the preview sits on every frame, even when nothing moves.
- **[Play waits for sound nobody will hear.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-play)**
  After a seek, Play can wait for clips on muted tracks, and a second press doesn't skip the wait.
- **[Prompt badges break apart.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-badges)** Click
  or arrow into a badge in the Director's prompt box, type, and it breaks into loose text.
- **[Code graphics drift in full screen.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-fullscreen)**
  With the preview zoomed, full screen draws them at the wrong size, off the video.
- **[Clip names drawn twice.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-names)** A clip that
  starts just off the timeline's left edge has its name drawn on top of itself.
- **[A dropped folder imports nothing.](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#cb-folder)**
  Now a folder dropped on the editor or the Dashboard, or File → Import Folder…, brings in its media.

All 16, with a side-by-side capture where one helps:
[Still in Cardboard](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/?only=cardboard).

## Effort

Counted on 2026-11-10 at 08:45 UTC, when main was `56142f3f`. Each count says how it was made.

| What | Count | How it was counted |
| --- | --- | --- |
| Commits on main | 1,750 | `git rev-list --count 56142f3f` |
| Commits on every branch | 1,914 | `git rev-list --count --remotes --before=2026-11-10T08:45Z` |
| Branches on GitHub | 119 | `git branch -r` at that time, without `origin/HEAD` |
| Span | 2026-10-27 to 2026-11-10 | the first and the newest commit on main |
| Patch scripts | 8, plus 5 Carton sync parts | `scripts/patch-*.js`, `scripts/carton/sync/patches/*.js` |
| Anchors | 335 exact-text replacements (152 for Windows, 183 for Carton), plus 13 blocks of code added at the top of a bundle | every `replace()` and prepend logged as it ran, in a full build on pristine 1.5.0 |
| Carton packages | 19, plus a web app | `carton/packages/*`, `carton/apps/*` |
| Test files | 428 in `carton/`, 51 in `scripts/carton/test/` | `git ls-files` names ending in `.test.ts`, `.test.js`, `.test.mjs` or `.test.tsx` |
| CI | 24 test jobs: 13 groups, 12 jobs on Linux, 11 on Windows, 1 on macOS | `node carton/ci/plan.mjs` (`.github/workflows/carton-ci.yml`) |
| Measurements CI can re-run | 22 | defined in `carton/ci/measure.json`, run by `.github/workflows/carton-measure.yml` |
| Tests at Carton's final integration | all 24 jobs passed: 6,844 tests, 0 failures | [changelog #4](https://cardboard-showcase.vikasmaur10.workers.dev/changelog/#4) |

Two more workflows: `carton-agent.yml` runs one agent's test groups on its own branch, and `build-windows.yml` builds
the app and the baseline on a Windows runner and publishes them as the release `windows-latest`.

## Docs map

| Doc | What's in it |
| --- | --- |
| [docs/windows-port.md](docs/windows-port.md) | Every patch and why, saves on Windows, the activity log, the keyboard tests, what isn't ported, rebuilding |
| [docs/carton-in-the-app.md](docs/carton-in-the-app.md) | Carton in this build: what changes with it on, History, cuts, sharing, and its tests |
| [docs/benchmarks.md](docs/benchmarks.md) | The benchmark kit and every measured table |
| [docs/readme-sources.md](docs/readme-sources.md) | Where each number in this README comes from |
| [carton/kit/](carton/kit/README.md) | The injection kit for Cardboard's engineers and their agents |
| [carton/docs/INTEGRATION-1.5.0.md](carton/docs/INTEGRATION-1.5.0.md) | Each Carton hook in Cardboard 1.5.0 |
| [carton/README.md](carton/README.md), [carton/CONTRACTS.md](carton/CONTRACTS.md) | Carton's packages and contracts |
| [AGENTS.md](AGENTS.md) | How changes are made, built, tested and measured here |

## Build from source

You need Windows, Node 24 and 7-Zip. From the repository's root:

```sh
cd tools && npm ci && cd ..
node scripts/build-windows.js                               # the app, in out\Cardboard-win
node scripts/build-windows.js --baseline --out out-baseline # the baseline the benchmarks compare against
node scripts/build-windows.js --no-carton                   # the app without Carton
```

The build downloads into `dl\` what the app is made from, from where each is published, and installs Carton's
workspace when it needs to. Not on Windows: `gh workflow run build-windows.yml --ref <branch>` runs the same build on
a GitHub Windows runner and publishes it as the release `windows-latest`. Carton's own workspace runs anywhere with
Node 24:

```sh
cd carton && npm ci
npm test            # every package
npm run typecheck
```

## Disclaimer

An independent project, built on Cardboard 1.5.0 for macOS. It isn't made by, or affiliated with, the Cardboard team.
This repository holds none of Cardboard's code and no built app: the build downloads Cardboard from cardboard.ai, and
`.gitignore` keeps its code and the build out of git.

Created in [T3 Code](https://t3.codes).
