# Independent check of the Cardboard 1.5.0 import benchmark (2026-11-10)

Verifier: separate agent (AGENTS.md rule 6). Everything below I checked or ran myself, unless it says otherwise.

**Verdict: NOT CONFIRMED.** The first run's method, run order, medians, results.md and file inventory are all
correct. But my re-run's "everything ready" medians fall outside the first run's spread for both builds
(baseline 59.4 s against 47.6–54.8 s; ours 34.6 s against 28.0–30.0 s). My re-run was also compromised: my own
`tail -f` on guard.log made the guard crash at 15:51:27, so all 6 counted runs ran without it. Ours was faster
than baseline in every run of both sets (baseline ÷ ours: first run 1.81×, mine 1.72×), but the absolute
times (52.0 s against 28.6 s) are not reproduced. Don't quote them until a clean re-run with the guard running agrees.

## What I checked, and how

- Read the method in `D:\cbwork\bench150\repo\scripts\bench\run.js` (all 373 lines) and `media.js`. The worktree is
  at `56142f3f1e884c88633fb41594b15d9cee930f7a`, and `git status` shows it clean.
- Clips: `sha256sum` of all 6 files in `repo\bench-media` matches the SHA-256 values in `media.json`.
- Builds: `build-info.json` gives ours = variant `full`, `carton: true`, and baseline = variant `baseline`,
  `carton: false`. Both are commit 56142f3f, built 2026-11-10 06:54/06:55 UTC. I did not re-check the release
  digests.
- I wrote my own scripts in `D:\cbwork\bench150\verify-import\audit\`, with my own median function rather than
  run.js's:
  - `audit.js <results.json> <runs> <warmup>`: run count, order and alternation against A B / B A, `at` times
    and gaps, errors, importFailed, medians, min–max, means, and the distinct `made` inventories.
  - `mdcheck.js <dir>`: rebuilds every table row and every run list in results.md from results.json, using
    run.js's display format, and requires an exact line match.
  - `gaps.js <results.json>`: the wall time from each import run's start to the next one's, minus its
    "everything ready". This checks the ready times against the clock instead of file mtimes.
  - `compare.js <first> <verify>`: the task 3 table.
- `power.log` and my own `verify-import\power.log`: number of samples, coverage, largest gap, and any value
  other than `PowerOnline=True` (awk).
- `guard.ps1` (read in full) and `guard.log`, checked against the run times.

## Task 1: audit of the first run (`repo\bench-results\2026-11-10-09-50`)

1. **OK. Every run is present and none failed.** For each test (import, cli, cli-import) there are 12 runs:
   1 warm-up and 5 counted per build. There are no `error` fields, and `importFailed` is false in all 12 import runs.
2. **OK. The builds alternate.** For every test the order is exactly `baseline:w1 ours:w1 | ours:1 baseline:1 |
   baseline:2 ours:2 | ours:3 baseline:3 | baseline:4 ours:4 | ours:5 baseline:5`, which is what run.js's
   `i % 2` rule gives. The `at` times only increase: import 15:20:59–15:32:25, cli 15:33:35–15:34:28,
   cli-import 15:34:31–15:45:01 local (UTC+5:30). The file ends at 15:46:06.
3. **OK. Every median recomputes the same.** All 10 measures (3 import, 6 cli, 1 cli-import) and all ratios match
   results.md once rounded. Unrounded: import everything ready, baseline 51.965 s and ours 28.645 s
   (1.814×); clips listed 1.619 / 1.938 s; first thumbnail 0.567 / 0.620 s; cli-import 64.247 / 44.496 s (1.444×).
   For cli, all 6 ratios are below 1 (0.80×–0.93×), so ours has the higher median on every command.
4. **OK. results.md lists every counted run.** `mdcheck.js` found 30 matching lines and no mismatches
   (10 table rows plus 20 run lists of 5 values each).
5. **OK. The made inventory is identical between builds.** Import, in all 12 runs warm-ups included:
   `{"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":0,"other":12}`. cli-import, in
   all 12 runs: the same, but with `"media":6`. Since every run made every file, no run was cut short by an early
   15 s quiet window.
6. **OK. Power.** `machine.onBattery` is false. `D:\cbwork\bench150\power.log` has 80 samples from 15:20:25
   to 16:01:21, every one `PowerOnline=True`, with the largest gap 32 s. That covers 15:20–15:46.
7. **OK. The wall clock agrees with "everything ready".** Wall time minus ready is 22.2–24.7 s in every import
   run, for both builds alike. That is launch, opening the project, the 15 s quiet window and quitting. So the
   ~23 s gap between the builds is real elapsed time, not an artifact of file mtimes.
8. **Note: outlier.** cli baseline run 3 had `cb source apply, second edit` = 10866 ms, where the others were
   826–1085 ms. The next run started 13.7 s later instead of the usual ~4 s, so the stall was real. It is that
   build's maximum, so the median stays 936 ms (917 ms if the run is dropped), and the ratio stays 0.81× (0.80×).
   A mean would be distorted (2922 ms). The same run also has baseline's highest `project create` (1177 ms).
9. **Note: other spread.** The baseline import warm-up's clips listed (3.70 s) and first thumbnail (2.73 s) are
   high, but warm-ups don't count. In cli-import, ours w1 had about 11 s of extra time after its timed part
   (cleanup). That is outside the measured interval.
10. **Note: the guard during the first run.** It moved all 12 import windows to desktop 1, each about 1 s after
    the run's `at`. It logged 3 FOREGROUND events: 15:26:33 (ours 2), 15:27:25 (ours 3) and 15:28:16
    (baseline 3), with the user idle 34, 86 and 137 s. There were no USER DESKTOP CHANGED lines and no MOVE FAILED.
    guard.log's last line, 15:32:26, is the last import window. That fits: cli and cli-import open no windows.
11. **Note: the builds differ in more than speed changes.** "ours" contains Carton (`carton: true`). The
    baseline does not, because `build-windows.js --baseline` always leaves Carton out (line 19). Carton also
    patches the CLI (`patch-carton.js --cli`, lines 108–109). So the cli slowdown might be Carton's and not the
    speed changes'. I did not test that.

## Task 2: my re-run

### Preconditions (checked at 15:49:07–15:49:28)

- PowerOnline: True.
- Cardboard.exe processes: 0. Nothing listening on port 9351. No node processes.
- Guard: running, `powershell.exe ... -File D:\cbwork\bench150\guard.ps1`, PID 25140, started 15:20:21.
  `guard.stop` did not exist. The last line in guard.log was 15:32:26 (no window had appeared since).
- CPU idle, `Get-Counter '\Processor(_Total)\% Idle Time' -SampleInterval 2 -MaxSamples 5`: 90.6, 93.1, 93.7,
  93.3, 92.6 %. The top CPU users over 3 s were chrome (0.8 s) and the guard (0.19 s). Nothing heavy.
- During the run, `verify-import\power.log` has 20 samples from 15:50:17 to 15:59:48, all `PowerOnline=True`,
  largest gap 31 s.

### Command

From `D:\cbwork\bench150\repo`, with E:\nodejs\node.exe (v24.19.0):
`node scripts\bench\run.js --build baseline=D:\cbwork\bench150\Cardboard-baseline --build ours=D:\cbwork\bench150\Cardboard --tests import --runs 3 --warmup 1 --out D:\cbwork\bench150\verify-import`

There was a first attempt at 15:49:45. My Bash quoting stripped the backslashes from the `--build` paths, and
run.js stopped at argument parsing ("no Cardboard in ...cbworkbench150Cardboard-baseline") before it launched
anything. Its log is `verify-import\attempt0-quoting-error.log`. The real run went from 15:50:09 to 15:59:19 and exited 0.

### Results (`D:\cbwork\bench150\verify-import\results.json`, `results.md`)

Order: `baseline:w1 ours:w1 | ours:1 baseline:1 | baseline:2 ours:2 | ours:3 baseline:3`. That alternates correctly.
There were no errors, `importFailed` is false in all 8 runs, and `mdcheck.js` matched 9 lines with no mismatches.

| Run (local start) | clips listed (s) | first thumbnail (s) | everything ready (s) | Guard active? |
| --- | ---: | ---: | ---: | --- |
| baseline w1 (15:50:14), not counted | 1.53 | 0.52 | 49.2 | yes (moved 15:50:15.318) |
| ours w1 (15:51:26), not counted | 2.66 | 0.79 | 32.2 | **no**, guard died 15:51:27.382 |
| ours 1 (15:52:22) | 2.29 | 0.71 | 34.98 | no |
| baseline 1 (15:53:20) | 3.16 | 0.83 | 62.34 | no |
| baseline 2 (15:54:46) | 2.12 | 0.72 | 59.41 | no |
| ours 2 (15:56:08) | 2.23 | 0.72 | 34.63 | no |
| ours 3 (15:57:06) | 2.50 | 0.80 | 34.14 | no |
| baseline 3 (15:58:04) | 1.64 | 0.54 | 53.16 | no |

Medians (3 counted runs): clips listed baseline 2.12 s, ours 2.29 s (0.93×). First thumbnail baseline 0.72 s,
ours 0.72 s (0.99×). Everything ready baseline 59.4 s, ours 34.6 s (**1.72×**).

Made inventory, identical in all 8 runs and the same as the first run's import:
`{"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":0,"other":12}`.

Wall time minus ready was 22.4–24.0 s in every run, the same as the first run. So the slower ready times are real
elapsed time too.

## Task 3: comparison

| Measure | Build | First run median | First run min–max (5 runs) | My median (3 runs) | My runs | My median within first run's min–max? |
| --- | --- | ---: | ---: | ---: | --- | --- |
| clips listed (s) | baseline | 1.62 | 1.46–2.15 | 2.12 | 3.16, 2.12, 1.64 | yes (2 of 3 runs within) |
| clips listed (s) | ours | 1.94 | 1.86–2.00 | 2.29 | 2.29, 2.23, 2.50 | **no** (0 of 3) |
| first thumbnail (s) | baseline | 0.57 | 0.48–0.70 | 0.72 | 0.83, 0.72, 0.54 | **no**, just above (1 of 3) |
| first thumbnail (s) | ours | 0.62 | 0.55–0.64 | 0.72 | 0.71, 0.72, 0.80 | **no** (0 of 3) |
| everything ready (s) | baseline | 52.0 | 47.6–54.8 | 59.4 | 62.3, 59.4, 53.2 | **no** (1 of 3) |
| everything ready (s) | ours | 28.6 | 28.0–30.0 | 34.6 | 35.0, 34.6, 34.1 | **no** (0 of 3) |

Baseline ÷ ours for everything ready: **1.81× in the first run, 1.72× in mine.** Pairing every baseline run
with every ours run gives 1.58–1.96× in the first run and 1.52–1.83× in mine. Mine (1.72×) falls inside the
first run's range.

Where they agree:
- Ours is faster to "everything ready" in every run of both sets. In both sets the slowest ours run is faster
  than the fastest baseline run.
- The speed-up is of the same order, 1.72× against 1.81×.
- Both builds make the same files.
- In both sets, ours is slightly slower than baseline to list the clips, and about the same or slightly slower
  to the first thumbnail.

Where they disagree:
- My run is slower for both builds: everything ready is +7.4 s (+14%) for baseline and +6.0 s (+21%) for ours.
  Neither median is inside the first run's min–max. Ours, the build with the tighter spread, has all 3 of my runs
  above the first run's maximum.
- So the absolute times 52.0 s and 28.6 s did not reproduce. The ratio moved from 1.81× to 1.72×.

The likely reason, which I have not proven: my runs ran under different conditions (see the incident below).
After 15:51:27 the bench windows were not moved to the hidden desktop 2. Most likely they were shown on the user's
desktop, with `--focus`, and the user was active (last input 15:55:26). A visible editor window draws while it
imports, and the user's own activity competes too. One run of mine did keep the first run's conditions: the
baseline warm-up, which the guard moved to desktop 2. All three of its measures (1.53, 0.52, 49.2 s) are within
the first run's baseline min–max. It is a single uncounted run, so this proves nothing.

## Incident: I made the guard crash

- The guard (PID 25140) logged its last line at 15:50:15.318, when it moved my baseline warm-up window. The
  Windows PowerShell event log has `id 403 Engine state is changed from Available to Stopped` for
  `powershell.exe ... -File D:\cbwork\bench150\guard.ps1` at **15:51:27.382**. That is ~1 s after run.js launched
  the ours warm-up (15:51:26.410), the moment the guard would park the new window and append to guard.log.
- The cause was me. A few seconds earlier, to follow progress, I had started a monitor that ran Git Bash's
  `tail -n 0 -f` on `guard.log`. I reproduced the effect in my own folder: while Git Bash's `tail -f` holds a
  file, PowerShell 5.1 `Add-Content` on it fails with "The process cannot access the file ... because it is being
  used by another process" (3 of 3 tries). Once the tail had exited, the same `Add-Content` worked (control).
  guard.ps1 sets `$ErrorActionPreference = 'Stop'` and writes its log with `& $say`, which uses `Add-Content`,
  outside any try/catch. So the first failed write ended the script.
- What followed: nothing moved or logged the 7 bench windows after 15:50:15 (ours w1 and all 6 counted runs, from
  15:51:26 to about 15:59:19). Per guard.ps1's own header, run.js starts Cardboard on the user's current desktop
  and opens each project with `--focus`, so these windows most likely appeared on the user's desktop and may
  have taken focus. There is no record of it either way. The user's last input was at 15:55:26, during
  baseline run 2. Each instance used a fresh temporary profile and library, and run.js removed them afterwards:
  no `cb-bench-*` folders remain in %TEMP%. Nothing asked for credits, a purchase or a sign-in.
- Current state, checked 15:59–16:01: the guard is not running and guard.stop does not exist. No Cardboard.exe
  is running, nothing listens on port 9351, and no `tail` holds guard.log (my monitor's tails were killed when it
  ended). I did not restart the guard: anything I start in the background ends when my session ends.
- Following the brief ("if the guard is not running, do not run the import test"), I did not do a second, clean
  re-run.
- To avoid this next time, don't follow guard.log with Git Bash `tail -f` (`Get-Content -Wait` should be safe,
  though I did not test it). Better, make the guard's logging survive failures: wrap `& $say` in try/catch, or
  write through a `FileStream` opened with `FileShare.ReadWrite`.

## guard.log lines written during my re-run (15:50:09–15:59:19)

```
15:50:14.651 parked 0x6E07BC pid 5816 visible False ''
15:50:14.928 parked 0x4C0650 pid 5816 visible False ''
15:50:14.931 parked 0xC4058C pid 5816 visible False 'Cardboard'
15:50:15.186 parked 0x8B038A pid 25452 visible False ''
15:50:15.318 moved 0xC4058C pid 5816 'Cardboard' to desktop 1; user's desktop 0
```

There are no FOREGROUND or USER DESKTOP CHANGED lines. The guard was dead from 15:51:27.382, so it could not
have logged any. Their absence says nothing about the 7 later windows.

## Files

- `D:\cbwork\bench150\verify-import\results.json`, `results.md`: my re-run
- `D:\cbwork\bench150\verify-import\run.log`: its console output; `power.log`: power and CPU idle every 30 s
- `D:\cbwork\bench150\verify-import\attempt0-quoting-error.log`, `attempt0-power.log`: the failed first attempt
- `D:\cbwork\bench150\verify-import\audit\`: `audit.js`, `mdcheck.js`, `gaps.js`, `compare.js`, and
  `tailtest.log` (the tail/Add-Content repro)

**Verdict: NOT CONFIRMED.** The first run's method and arithmetic are correct, and ours is faster than baseline
to "everything ready" in every run (1.81× first, 1.72× mine). But my re-run's medians fall outside the first run's
spread for both builds, and my re-run was itself compromised: I made the guard crash, so the windows were not
hidden and the user was active. The 52.0 s and 28.6 s figures need a clean re-run, with the guard running, before
they are quoted.

---

## Clean re-run (verify-import-2)

The coordinator asked for this run after hardening the guard (log writes shared and wrapped in try/catch, the
loop can't die on an error) and restarting it at 16:05:43. I did not tail or follow any log. guard.log and
watchdog.log were read only with one-shot `Get-Content`, after the run. `D:\cbwork\bench150\verify-import` is
kept as it was, for the record. I also added `coverage.js` to the audit folder (it maps each run to its guard
and watchdog lines, and bounds its import timer).

### Preconditions (16:06:41–16:07:03)

- PowerOnline: True.
- Cardboard.exe processes: 0. Nothing listening on port 9351. No `tail` or `Get-Content -Wait` processes.
- Guard: `powershell.exe ... -File D:\cbwork\bench150\guard.ps1`, PID 25964, started 16:05:42. guard.stop
  does not exist. guard.log's last line: `16:06:45.419 alive: parked 0, moved 0, user idle 0 s`.
- CPU idle (5 × 2 s samples): 96.0, 94.1, 97.1, 84.6, 92.9 %. The top CPU users over 3 s were a powershell
  (0.88 s, most likely my own sampling), NahimicSvc64 (0.72 s) and T3 Code (0.3 s).
- User idle at 16:07:03: 2 s (last input 16:07:01). The user was active just before the start. I recorded it
  and went ahead, since the brief only asks for it to be recorded. According to the guard's "alive" lines, the
  last input after that was at about 16:07:34, and the next was at about 16:15:12 (see below).
- Watchdog: not running when I started (16:07:17). The coordinator's watchdog instruction came after the start.
  The watchdog started at 16:09:11.860, PID 32748 (`powershell.exe ... -File D:\cbwork\bench150\watchdog.ps1`),
  and was still running at 16:15:51. It started before the first counted run (ours 1, 16:09:19.393). Only the
  two warm-ups began before it.
- The HOLD message reached me after the run had already finished (16:15:25, exit 0), and the UPDATE said to let
  it continue. I stopped nothing, killed nothing and did not retry.
- Power during the run: `verify-import-2\power.log` has 17 samples from 16:07:25 to 16:15:26, all
  `PowerOnline=True`.

### Command

From `D:\cbwork\bench150\repo`:
`E:\nodejs\node.exe scripts\bench\run.js --build baseline=D:\cbwork\bench150\Cardboard-baseline --build ours=D:\cbwork\bench150\Cardboard --tests import --runs 3 --warmup 1 --out D:\cbwork\bench150\verify-import-2`
It ran from 16:07:17 to 16:15:25 and exited 0. results.json `started` is 10:37:18Z, `finished` 10:45:25Z.

### Per-run values (`D:\cbwork\bench150\verify-import-2\results.json`)

Order: `baseline:w1 ours:w1 | ours:1 baseline:1 | baseline:2 ours:2 | ours:3 baseline:3`. That alternates
correctly. There were no errors, `importFailed` is false in all 8 runs, and `mdcheck.js` matched 9 lines with no
mismatches. Wall time minus ready was 21.9–23.0 s in every run, the same as the first run's 22.2–24.7 s.

| Run (local `at`) | clips listed (s) | first thumbnail (s) | everything ready (s) |
| --- | ---: | ---: | ---: |
| baseline w1 (16:07:22.432), not counted | 1.54 | 0.50 | 44.2 |
| ours w1 (16:08:29.633), not counted | 1.86 | 0.55 | 26.9 |
| ours 1 (16:09:19.393) | 1.96 | 0.62 | 27.08 |
| baseline 1 (16:10:08.798) | 1.48 | 0.53 | 47.89 |
| baseline 2 (16:11:18.577) | 1.54 | 0.54 | 48.62 |
| ours 2 (16:12:29.447) | 1.93 | 0.64 | 29.05 |
| ours 3 (16:13:21.141) | 1.92 | 0.61 | 29.12 |
| baseline 3 (16:14:12.666) | 1.68 | 0.56 | 50.07 |

Medians (3 counted runs): clips listed baseline 1.54 s, ours 1.93 s (0.80×). First thumbnail baseline 0.54 s,
ours 0.62 s (0.86×). Everything ready baseline 48.6 s, ours 29.0 s (**1.67×**).

Made inventory, identical in all 8 runs and the same as the first run's import:
`{"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":0,"other":12}`.

### Guard lines (guard.log, 16:05:42 onward, one-shot read at 16:15:51)

```
16:05:42.130 NOTE: the guard died at about 15:51:27 (an uncaught Add-Content error while a reader had this log open); the verifier's import runs from 15:51:26 to about 15:59 ran without it. Restarting the hardened guard.
16:05:43.134 guard start: user's desktop index 0, test desktop index 1, root D:\cbwork\bench150\, user idle 617 s
16:06:45.419 alive: parked 0, moved 0, user idle 0 s
16:07:22.899 parked 0xBA0624 pid 34700 visible False ''
16:07:23.158 parked 0x7F0696 pid 34700 visible False ''
16:07:23.159 parked 0x8505E2 pid 34700 visible False 'Cardboard'
16:07:23.422 parked 0x87080A pid 17148 visible False ''
16:07:23.610 moved 0x8505E2 pid 34700 'Cardboard' to desktop 1; user's desktop 0
16:07:49.996 alive: parked 4, moved 1, user idle 16 s
16:08:30.076 parked 0xC20806 pid 23144 visible False ''
16:08:30.334 parked 0x510368 pid 23144 visible False ''
16:08:30.602 parked 0x390862 pid 23144 visible False 'Cardboard'
16:08:30.860 parked 0x109037A pid 33960 visible False ''
16:08:30.947 moved 0x390862 pid 23144 'Cardboard' to desktop 1; user's desktop 0
16:08:52.217 alive: parked 8, moved 2, user idle 78 s
16:09:19.834 parked 0x9E01DE pid 14008 visible False ''
16:09:20.092 parked 0xA502DA pid 14008 visible False ''
16:09:20.349 parked 0x5006D6 pid 14008 visible False 'Cardboard'
16:09:20.552 moved 0x5006D6 pid 14008 'Cardboard' to desktop 1; user's desktop 0
16:09:20.816 parked 0x740130 pid 21712 visible False ''
16:09:54.547 alive: parked 12, moved 3, user idle 141 s
16:10:09.231 parked 0x10207A2 pid 21608 visible False ''
16:10:09.495 parked 0x7604B2 pid 21608 visible False ''
16:10:09.751 parked 0x910642 pid 21608 visible False 'Cardboard'
16:10:09.754 parked 0x6E06EC pid 32140 visible False ''
16:10:09.925 moved 0x910642 pid 21608 'Cardboard' to desktop 1; user's desktop 0
16:10:58.708 alive: parked 16, moved 4, user idle 205 s
16:11:18.999 parked 0x5206D6 pid 23284 visible False ''
16:11:19.276 parked 0xEF039E pid 23284 visible False ''
16:11:19.277 parked 0x8F087E pid 23284 visible False 'Cardboard'
16:11:19.537 parked 0xA101DE pid 33452 visible False ''
16:11:19.673 moved 0x8F087E pid 23284 'Cardboard' to desktop 1; user's desktop 0
16:12:03.301 alive: parked 20, moved 5, user idle 270 s
16:12:29.916 parked 0x8C080A pid 25888 visible False ''
16:12:30.170 parked 0x3D0862 pid 25888 visible False ''
16:12:30.426 parked 0x7006EC pid 25888 visible False 'Cardboard'
16:12:30.716 moved 0x7006EC pid 25888 'Cardboard' to desktop 1; user's desktop 0
16:12:30.716 parked 0x6B080E pid 21500 visible False ''
16:13:05.780 alive: parked 24, moved 6, user idle 332 s
16:13:21.586 parked 0x8307FE pid 18448 visible False ''
16:13:21.850 parked 0xAB0394 pid 18448 visible False ''
16:13:22.107 parked 0x3E0862 pid 18448 visible False 'Cardboard'
16:13:22.107 parked 0x5A0650 pid 18184 visible False ''
16:13:22.326 moved 0x3E0862 pid 18448 'Cardboard' to desktop 1; user's desktop 0
16:14:08.210 alive: parked 28, moved 7, user idle 394 s
16:14:13.099 parked 0x670620 pid 16716 visible False ''
16:14:13.364 parked 0x950642 pid 16716 visible False ''
16:14:13.365 parked 0xC40624 pid 16716 visible False 'Cardboard'
16:14:13.621 parked 0x440672 pid 12688 visible False ''
16:14:13.751 moved 0xC40624 pid 16716 'Cardboard' to desktop 1; user's desktop 0
16:15:12.776 alive: parked 32, moved 8, user idle 0 s
```

- There are 8 bench windows and 8 "moved … to desktop 1" lines, one per run, each 1.1–1.3 s after that run's `at`.
- **There are no FOREGROUND, USER DESKTOP CHANGED, MOVE FAILED or "guard loop error" lines.** So no foreground
  event fell before or inside any import timer.
- User input, from the alive lines: the last input was at about 16:07:34 (idle 16 s at 16:07:49, and 394 s at
  16:14:08). So nobody touched the input from 16:07:34 to at least 16:14:08. That covers ours w1 and the
  counted runs ours 1, baseline 1, baseline 2, ours 2 and ours 3 completely.
- The next input was at about 16:15:12 (idle 0 s at 16:15:12.776). That is after baseline 3's timed interval,
  which ended between 16:15:04.7 and 16:15:09.7. But input between 16:14:08 and 16:15:12 can't be ruled out,
  because the alive line only records the latest input. Baseline 3 (50.07 s) is inside the first run's
  baseline range and doesn't change the median: baseline 2 is the median.
- The baseline warm-up's timed interval (about 16:07:24–16:08:13) contains the 16:07:34 input. It is a warm-up,
  not counted.

### Watchdog lines (watchdog.log, all, one-shot read at 16:15:51)

```
16:09:11.860 watchdog start: pid 32748, max alive age 90 s, check every 10 s, root D:\cbwork\bench150\; guard pid(s) 25964
16:09:12.500 bench in progress: True (run.js pids 20932 ; Cardboard pids 23144,33960,18888,11940,30696,24516,31980,29752); guard pid(s) 25964, last alive 20 s ago
16:10:16.029 heartbeat: bench in progress True, guard pid(s) 25964, guard last alive 21 s ago, ok True
16:11:19.372 heartbeat: bench in progress True, guard pid(s) 25964, guard last alive 21 s ago, ok True
16:12:23.493 heartbeat: bench in progress True, guard pid(s) 25964, guard last alive 20 s ago, ok True
16:13:26.886 heartbeat: bench in progress True, guard pid(s) 25964, guard last alive 21 s ago, ok True
16:14:30.269 heartbeat: bench in progress True, guard pid(s) 25964, guard last alive 22 s ago, ok True
16:15:33.752 bench in progress: False (run.js pids  ; Cardboard pids ); guard pid(s) 25964, last alive 21 s ago
16:15:33.753 heartbeat: bench in progress False, guard pid(s) 25964, guard last alive 21 s ago, ok True
```

There are no STOPPING lines and no kill lines anywhere. The watchdog saw my run.js as PID 20932.

### Coverage of each counted run (from its `at` to the next run's `at`; `coverage.js`)

t0 is the import timer at run.js:211. Its lower bound is `at` + 2 s, because run.js sleeps 2 s before t0. Its
upper bound is the next `at` − ready − 16 s, because after the last write run.js waits at least 15 s of quiet,
then quit() sleeps 1 s.

| Run | Interval (local) | Guard "moved … to desktop 1" | FOREGROUND / desktop lines | t0 between | Watchdog lines in or around it |
| --- | --- | --- | --- | --- | --- |
| ours 1 | 16:09:19.393–16:10:08.798 | 16:09:20.552 (pid 14008) | none | 16:09:21.4–16:09:25.7 | 16:09:12.5 "bench in progress: True" before; 16:10:16.0 heartbeat ok True after (none inside, at 1/min); no STOPPING |
| baseline 1 | 16:10:08.798–16:11:18.577 | 16:10:09.925 (pid 21608) | none | 16:10:10.8–16:10:14.7 | 16:10:16.0 heartbeat ok True; no STOPPING |
| baseline 2 | 16:11:18.577–16:12:29.447 | 16:11:19.673 (pid 23284) | none | 16:11:20.6–16:11:24.8 | 16:11:19.4 and 16:12:23.5 heartbeats ok True; no STOPPING |
| ours 2 | 16:12:29.447–16:13:21.141 | 16:12:30.716 (pid 25888) | none | 16:12:31.4–16:12:36.1 | 16:12:23.5 before and 16:13:26.9 after, both ok True (none inside); no STOPPING |
| ours 3 | 16:13:21.141–16:14:12.666 | 16:13:22.326 (pid 18448) | none | 16:13:23.1–16:13:27.5 | 16:13:26.9 heartbeat ok True; no STOPPING |
| baseline 3 | 16:14:12.666–16:15:25.727 (finish) | 16:14:13.751 (pid 16716) | none | 16:14:14.7–16:14:19.7 | 16:14:30.3 heartbeat ok True; 16:15:33.8 "bench in progress: False", ok True after; no STOPPING |

The watchdog writes a heartbeat about once a minute, though the coordinator says it checks every 10 s. So
ours 1 and ours 2, each about 50 s long, have no heartbeat inside them. Both are bracketed by "ok True" lines
less than 65 s apart, and the watchdog never logged a STOPPING line.

### Comparison with the first run (clean re-run)

| Measure | Build | First run median | First run min–max (5 runs) | Clean re-run median (3 runs) | Clean re-run runs | Median within first run's min–max? |
| --- | --- | ---: | ---: | ---: | --- | --- |
| clips listed (s) | baseline | 1.62 | 1.46–2.15 | 1.54 | 1.48, 1.54, 1.68 | yes (3 of 3 runs within) |
| clips listed (s) | ours | 1.94 | 1.86–2.00 | 1.93 | 1.96, 1.93, 1.92 | yes (3 of 3) |
| first thumbnail (s) | baseline | 0.57 | 0.48–0.70 | 0.54 | 0.53, 0.54, 0.56 | yes (3 of 3) |
| first thumbnail (s) | ours | 0.62 | 0.55–0.64 | 0.62 | 0.62, 0.64, 0.61 | yes (3 of 3) |
| everything ready (s) | baseline | 52.0 | 47.6–54.8 | 48.6 | 47.9, 48.6, 50.1 | yes (3 of 3) |
| everything ready (s) | ours | 28.6 | 28.0–30.0 | 29.0 | 27.1, 29.0, 29.1 | yes (2 of 3; 27.1 is just below, i.e. faster) |

Baseline ÷ ours for everything ready: **first run 1.81×, clean re-run 1.67×.** Pairing every baseline run
with every ours run gives 1.58–1.96× in the first run and 1.64–1.85× in the clean re-run. Pooling both sets
(8 runs per build) gives medians of 49.3 s and 28.8 s, 1.71×.

- **Agree:**
  - All six medians fall within the first run's min–max for that build.
  - In both sets, every ours run reached "everything ready" before every baseline run.
  - In both sets, ours lists clips about 0.3–0.4 s later and writes the first thumbnail about 0.05–0.09 s later.
  - The same files were made in every run.
- **Differs:** the baseline median came out 3.3 s lower (48.6 s against 52.0 s) and ours 0.4 s higher (29.0 s
  against 28.6 s). So the ratio is 1.67× against 1.81×. The first run's 1.81× is near the top of what the two
  sets support. "About 1.7×" or "1.67–1.81×" is safer to quote than "1.81×".
- Nothing to flag: no foreground event fell inside any timed interval, and there was none at all.

**Verdict (clean re-run): CONFIRMED.** The first run's method and arithmetic are correct.
- **Medians:** in the clean re-run, which the guard and watchdog covered, every import median falls within the
  first run's run-to-run spread for each build: everything ready 48.6 s against 47.6–54.8 s for baseline, and
  29.0 s against 28.0–30.0 s for ours.
- **Clean conditions:**
  - Every window was moved to desktop 1, with no foreground or desktop-change events.
  - Power stayed on mains throughout, and the same files were made every run.
  - There was no user input from 16:07:34 to at least 16:14:08, which covers 5 of the 6 counted runs.
- **Caveat:** the "everything ready" ratio reproduced at 1.67×, not 1.81×. Quote it as about 1.7× (or
  1.67–1.81×), not as 1.81×.

The earlier verdict above (NOT CONFIRMED, my compromised first re-run) stays in the record. This clean re-run
replaces it as the basis for judging the import numbers.
