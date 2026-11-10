# Where the README's numbers come from

[README](../README.md) · [Windows port](windows-port.md) · [Carton in the app](carton-in-the-app.md) · [Benchmarks](benchmarks.md)

Every number in the [README](../README.md), with the line it's on, where it comes from, and how sure it is. The
README quotes only numbers that are already in one of these sources, copied as they are there.

- **changelog** is the live changelog, <https://cardboard-showcase.vikasmaur10.workers.dev/changelog/>. Its file is
  `carton/apps/web/public/changelog/index.html` on the branch `deploy/carton` (commit `7e473b3a`), and the live page was identical to it at
  11:00 UTC on 2026-11-10. Its sign-off (line 561) says every number on it was checked independently before it went up, and
  that the ones in #1–#7 were measured on Cardboard 1.4.0.
- **home page** is `carton/packages/server-cloudflare/site/index.html` at the same commit, the live home page.
- **old README** is `README.md` at `56142f3f`, before the reference sections moved into `docs/`. A line given for
  both is the same text, moved unchanged.
- **Counts** were made on 2026-11-10 at 08:45 UTC, when main was `56142f3f`, and the commands reproduce them.
- **The 1.5.0 import benchmark** is in `docs/benchmarks/2026-11-10-1.5.0/`: `results.md` is the run, `VERIFY.md`
  the separate agent's check, and `verify-import-2-results.md` its clean re-run.

Left out of the README on purpose: the proxy table in [docs/windows-port.md](windows-port.md#patches), measured
on 1.4.0 and not independently verified. The import times of the first port commit (`ad4b0a05`, 73.5 s → 11.9 s
for four clips, 57.7 s → 16.4 s through `cb media add`) came before the baseline build (`2dacbf73`); an
independent check (`07709a41`, 2026-11-01) couldn't back them from the recorded runs, so they are withdrawn in
favour of the 1.5.0 benchmark.

| README line | Number | Source | Status |
| --- | --- | --- | --- |
| 21 | 43.7.0 | `docs/windows-port.md:9` (old README:10) | A version, a date or a name |
| 23 | 1.5.0 since 2026-11-10, ported from 1.4.0 | changelog:258; changelog:263 | A version, a date or a name |
| 30 | 16 (still in 1.5.0) | changelog:582; changelog:252 | Counted by the changelog's own script (line 582): its 10 single cards (lines 282, 288, 376, 382, 388, 433, 468, 474, 520, 529) plus the 4 and 2 items of its two list cards (484–487, 539–540). The live page's filter bar showed 16 on 2026-11-10 |
| 33 | Windows 10 or 11, 64-bit | home page:200; `.github/workflows/build-windows.yml:52` | A version, a date or a name |
| 40 | i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11 | `docs/benchmarks.md:96` (old README:1343) | A version, a date or a name |
| 42 | The others were measured before the port, on 1.4.0 | changelog:561; commit `5dcaa7c0` | The changelog's rows are #2 and #3; the serving time was committed on 2026-11-02, before the 1.5.0 port (2026-11-10) |
| 52 | 20.3% → 0.7% of a core | changelog:438; `docs/benchmarks.md:143` (old README:1390) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 52 | 144 Hz screen, 5 runs each, medians | changelog:443; `docs/benchmarks.md:137` (old README:1384) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 53 | 64.8% → 2.0% of a core | changelog:439; `docs/benchmarks.md:146` (old README:1393) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 54 | about 143 frames per second and 1.1 cores; 4 runs each | changelog:440; changelog:443; `docs/benchmarks.md:153` (old README:1400) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 55 | 17–20 → 4–6; over 50 ms in 19 s | changelog:457; `docs/benchmarks.md:105` (old README:1352) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 55 | 3 runs each (two-GPU laptop, 1.4.0) | changelog:459 | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 56 | 57 files (9.1 MB), 20 alternated rounds, 170 → 123 ms, medians, Electron 43.7.0 for Linux | `docs/windows-port.md:171` (old README:171); `docs/windows-port.md:172` (old README:172); commit `5dcaa7c0` | Marked as a verified re-run in commit 5dcaa7c0, which added it (that commit calls the patch 15; it is 16 now) |
| 57 | 26–37 → 78–88 | changelog:456; `docs/benchmarks.md:102` (old README:1349) | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 57 | Retired; reworked in 1.4.1 and 1.5.0 | changelog:463 | A statement taken from the source's text |
| 48 | 52.0 → 28.6 s, about 1.7× faster | `docs/benchmarks/2026-11-10-1.5.0/results.md:25`; `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:405` | Independently checked: VERIFY.md recomputed every median from results.json (line 43) and re-ran the import clean, 3 runs each (its verdict, line 397: CONFIRMED). It asks for “about 1.7×”, not 1.81× |
| 48 | 6 clips; 4K HEVC phone, 4K60 H.264, 1080p, a WAV | `docs/benchmarks/2026-11-10-1.5.0/results.md:10`; `docs/benchmarks/2026-11-10-1.5.0/results.md:12`; `docs/benchmarks/2026-11-10-1.5.0/results.md:15` | A version, a date or a name |
| 48 | 1.5.0, both from 56142f3f, 5 runs each, medians | `docs/benchmarks/2026-11-10-1.5.0/results.md:6`; `docs/benchmarks/2026-11-10-1.5.0/results.md:7`; `docs/benchmarks/2026-11-10-1.5.0/results.md:17` | A version, a date or a name |
| 48 | 48.6 → 29.0 s, 3 runs each | `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:380`; `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:381`; `docs/benchmarks/2026-11-10-1.5.0/verify-import-2-results.md:17` | The re-run itself, by the separate agent (verify-import-2-results.md) |
| 49 | 64.2 → 44.5 s, 5 runs each | `docs/benchmarks/2026-11-10-1.5.0/results.md:64`; `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:43` | Recomputed independently from results.json (VERIFY.md line 43); not re-run |
| 50 | 1.62 → 1.94 s, 0.57 → 0.62 s | `docs/benchmarks/2026-11-10-1.5.0/results.md:23`; `docs/benchmarks/2026-11-10-1.5.0/results.md:24`; `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:390` | Recomputed independently (VERIFY.md line 43), and the clean re-run agrees (lines 376–379) |
| 51 | 18 to 234 ms; cb --help 222 → 240 ms | `docs/benchmarks/2026-11-10-1.5.0/results.md:40`; `docs/benchmarks/2026-11-10-1.5.0/results.md:41`; `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:44` | The differences of the 6 medians (results.md lines 40–45): 18, 234, 30, 25, 76 and 215 ms. Recomputed independently (VERIFY.md lines 41–44); not re-run |
| 51 | Ours includes Carton; the baseline doesn't | `docs/benchmarks/2026-11-10-1.5.0/VERIFY.md:67` | A statement taken from the source's text |
| 61 | Cardboard 1.5.0, Electron 43.7.0, ffmpeg 8.1 | `docs/windows-port.md:547` (old README:1421); `docs/windows-port.md:548` (old README:1422) | A version, a date or a name |
| 76 | 1.4.0 to 1.5.0 (2026-11-10) | `carton/docs/INTEGRATION-1.5.0.md:614` | A version, a date or a name |
| 79 | All but a handful of anchors matched once renamed | `carton/docs/INTEGRATION-1.5.0.md:616`; `carton/docs/INTEGRATION-1.5.0.md:617` | A statement taken from the source's text |
| 85 | Two mistakes caught in the real app: two of 1.4.0's names, the string "z" | commit `4cb2ea14`; commit `301b97ea` | A statement taken from the source's text |
| 88 | The third confirmed and two more found by comparing every inserted text | commit `56142f3f` | A statement taken from the source's text |
| 90 | What the laptop tested on the 1.5.0 build | changelog:270 | A statement taken from the source's text |
| 93 | Every "Also in Cardboard" bug re-read in 1.5.0 | changelog:269 | A statement taken from the source's text |
| 106 | Rule 6: a separate agent re-checks every number | `AGENTS.md:12`; changelog:561 | A statement taken from the source's text |
| 110 | 25 page tests, 9 with real keys | `AGENTS.md:62`; `docs/windows-port.md:531` (old README:526) | Counted; the command reproduces it (the test files' own count) |
| 116 | 1.4.0 and 1.4.1, read again in 1.5.0; none measured on a Mac | changelog:253 | A statement taken from the source's text |
| 153 | 5-minute quickstart | `carton/kit/README.md:13` | A version, a date or a name |
| 155 | one-page prompt | `carton/kit/README.md:15` | A version, a date or a name |
| 174 | 20-snapshot history | changelog:385; changelog:391 | A statement taken from the source's text |
| 188 | All 16 | changelog:582 | As “16” above |
| 197 | 1,750 commits on main | `git rev-list --count 56142f3f` → 1750 | Counted; the command reproduces it |
| 198 | 1,914 commits on every branch | `git rev-list --count --remotes --before=2026-11-10T08:45Z` → 1914 | Counted; the command reproduces it. Every branch except chore/pnpm and docs/readme, both made after 08:45 UTC |
| 199 | 119 branches | `git branch -r --format='%(refname:short)' \| grep -v -E '^origin$\|HEAD\|chore/pnpm\|docs/readme' \| wc -l` → 119 | Counted; the command reproduces it. The remote branches without origin/HEAD, chore/pnpm (first commit 09:00 UTC) and docs/readme |
| 200 | 2026-10-27 to 2026-11-10 | `git log --reverse --format=%cs 56142f3f \| head -1` → 2026-10-27; `git log -1 --format=%cs 56142f3f` → 2026-11-10 | Counted; the command reproduces it |
| 201 | 8 patch scripts | `git ls-tree --name-only 56142f3f scripts/ \| grep -c -E '^scripts/patch-.*\.js$'` → 8; `git ls-tree --name-only 56142f3f scripts/carton/sync/patches/ \| grep -c '\.js$'` → 5 | Counted; the command reproduces it |
| 202 | 335 replacements (152 Windows, 183 Carton), 13 prepended blocks | commit `137306a4` | Counted with ~/gfv-scratch/release-150/tools/replog.sh on the dev box (not in the repo): it patches pristine 1.5.0 (~/gfv-scratch/cb-1.5.0) in build order and logs each replace() and prepend. Per script: patch-main 42 (+1 prepended), patch-worker 17 (+1), patch-strip 5, patch-renderer 68, patch-cli 3, patch-cli-media 17 (Windows: 152); patch-carton 158 (+4), patch-carton-sync 25 (+7) (Carton: 183). patch-carton's 158 matches commit 137306a4 |
| 203 | 19 Carton packages, plus a web app | `git ls-tree -d --name-only 56142f3f carton/packages/ \| wc -l` → 19; `git ls-tree -d --name-only 56142f3f carton/apps/ \| wc -l` → 1 | Counted; the command reproduces it |
| 204 | 428 and 51 test files | `git ls-tree -r --name-only 56142f3f -- carton \| grep -c -E '\.test\.(ts\|js\|mjs\|tsx)$'` → 428; `git ls-tree -r --name-only 56142f3f -- scripts \| grep -c -E '\.test\.(ts\|js\|mjs\|tsx)$'` → 51 | Counted; the command reproduces it. All 51 in scripts/ are under scripts/carton/test/ |
| 205 | 24 jobs, 13 groups, 12 Linux, 11 Windows, 1 macOS | `cd carton && node ci/plan.mjs \| wc -l` → 24; `cd carton && node ci/plan.mjs \| grep -c '(linux)'` → 12; `cd carton && node ci/plan.mjs \| grep -c '(windows)'` → 11; `cd carton && node ci/plan.mjs \| grep -c '(macos)'` → 1; `node -e 'console.log(require("./carton/ci/groups.json").groups.length)'` → 13 | Counted; the command reproduces it |
| 206 | 22 measurements | `node -e 'console.log(require("./carton/ci/measure.json").measurements.length)'` → 22 | Counted; the command reproduces it |
| 207 | 6,844 tests, 0 failures, all 24 jobs | changelog:418 | On the changelog, whose sign-off (line 561) says every number on it was checked independently |
| 227 | Node 24 | `.github/workflows/build-windows.yml:29`; `carton/README.md:51` | A version, a date or a name |
| 227 | 7-Zip | `docs/windows-port.md:550` | A version, a date or a name |
| 228 | pnpm 12.18.0 | `tools/package.json:13`; `carton/package.json:7` | A version, a date or a name |
| 250 | Built on Cardboard 1.5.0; not affiliated | changelog:563 | A statement taken from the source's text |
