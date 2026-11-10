# Where the README's numbers come from

[README](../README.md) · [Windows port](windows-port.md) · [Carton in the app](carton-in-the-app.md) · [Benchmarks](benchmarks.md)

Every number in the [README](../README.md), with the line it's on, where it comes from, and how sure it is. The
README quotes only numbers that are already in one of these sources, copied as they are there.

- **changelog** is the live changelog, <https://cardboard-showcase.vikasmaur10.workers.dev/changelog/>. Its file is
  `carton/apps/web/public/changelog/index.html` on the branch `deploy/carton` (commit `c11efd3c`), and the live page was identical to it on
  2026-11-10. Its sign-off (line 559) says every number on it was checked independently before it went up, and
  that the ones in #1–#7 were measured on Cardboard 1.4.0.
- **home page** is `carton/packages/server-cloudflare/site/index.html` at the same commit, the live home page.
- **old README** is `README.md` at `56142f3f`, before the reference sections moved into `docs/`. A line given for
  both is the same text, moved unchanged.
- **Counts** were made on 2026-11-10 at 08:45 UTC, when main was `56142f3f`, and the commands reproduce them.

Left out of the README on purpose: the import times (73.5 s → 11.9 s for four clips, 57.7 s → 16.4 s through
`cb media add`) and the proxy table, in [docs/windows-port.md](windows-port.md#patches). They came in with the
first port commit, `ad4b0a05`, before the baseline build (`2dacbf73`), and an independent check (`07709a41`,
2026-11-01) couldn't back them from the recorded runs. They are being re-measured against the baseline.

| README line | Number | Source | Status |
| --- | --- | --- | --- |
| 21 | 43.7.0 | `docs/windows-port.md:9` (old README:10) | A version, a date or a name |
| 23 | 1.5.0 since 2026-11-10, ported from 1.4.0 | changelog:256; changelog:261 | A version, a date or a name |
| 30 | 16 (still in 1.5.0) | changelog:580; changelog:250 | Counted by the changelog's own script (line 580): its 10 single cards (lines 280, 286, 374, 380, 386, 431, 466, 472, 518, 527) plus the 4 and 2 items of its two list cards (482–485, 537–538). The live page's filter bar showed 16 on 2026-11-10 |
| 33 | Windows 10 or 11, 64-bit | home page:137; `.github/workflows/build-windows.yml:35` | A version, a date or a name |
| 40 | i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11 | `docs/benchmarks.md:52` (old README:1343) | A version, a date or a name |
| 42 | All of them were measured before the port to 1.5.0, on 1.4.0 | changelog:559; commit `5dcaa7c0` | The changelog's rows are #2 and #3; the serving time was committed on 2026-11-02, before the 1.5.0 port (2026-11-10) |
| 47 | 20.3% → 0.7% of a core | changelog:436; `docs/benchmarks.md:99` (old README:1390) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 47 | 144 Hz screen, 5 runs each, medians | changelog:441; `docs/benchmarks.md:93` (old README:1384) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 48 | 64.8% → 2.0% of a core | changelog:437; `docs/benchmarks.md:102` (old README:1393) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 49 | about 143 frames per second and 1.1 cores; 4 runs each | changelog:438; changelog:441; `docs/benchmarks.md:109` (old README:1400) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 50 | 17–20 → 4–6; over 50 ms in 19 s | changelog:455; `docs/benchmarks.md:61` (old README:1352) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 50 | 3 runs each (two-GPU laptop, 1.4.0) | changelog:457 | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 51 | 57 files (9.1 MB), 20 alternated rounds, 170 → 123 ms, medians, Electron 43.7.0 for Linux | `docs/windows-port.md:171` (old README:171); `docs/windows-port.md:172` (old README:172); commit `5dcaa7c0` | Marked as a verified re-run in commit 5dcaa7c0, which added it (that commit calls the patch 15; it is 16 now) |
| 52 | 26–37 → 78–88 | changelog:454; `docs/benchmarks.md:58` (old README:1349) | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 52 | Retired; reworked in 1.4.1 and 1.5.0 | changelog:461 | A statement taken from the source's text |
| 55 | Import times: an independent check couldn't back them | `docs/windows-port.md:221` (old README:221); commit `ad4b0a05`; commit `2dacbf73`; commit `07709a41` | The import times came in with ad4b0a05; the bench kit and the baseline build with 2dacbf73; rule 6 (the independent re-check) with b15b90e2, which `git log -S'separate subagent' -- AGENTS.md` finds; 07709a41 (2026-11-01) records that a separate agent couldn't back them from the recorded runs |
| 60 | Cardboard 1.5.0, Electron 43.7.0, ffmpeg 8.1 | `docs/windows-port.md:543` (old README:1421); `docs/windows-port.md:544` (old README:1422) | A version, a date or a name |
| 75 | 1.4.0 to 1.5.0 (2026-11-10) | `carton/docs/INTEGRATION-1.5.0.md:614` | A version, a date or a name |
| 78 | All but a handful of anchors matched once renamed | `carton/docs/INTEGRATION-1.5.0.md:616`; `carton/docs/INTEGRATION-1.5.0.md:617` | A statement taken from the source's text |
| 84 | Two mistakes caught in the real app: two of 1.4.0's names, the string "z" | commit `4cb2ea14`; commit `301b97ea` | A statement taken from the source's text |
| 87 | The third confirmed and two more found by comparing every inserted text | commit `56142f3f` | A statement taken from the source's text |
| 89 | What the laptop tested on the 1.5.0 build | changelog:268 | A statement taken from the source's text |
| 92 | Every "Also in Cardboard" bug re-read in 1.5.0 | changelog:267 | A statement taken from the source's text |
| 105 | Rule 6: a separate agent re-checks every number | `AGENTS.md:12`; changelog:559 | A statement taken from the source's text |
| 109 | 25 page tests, 9 with real keys | `AGENTS.md:59`; `docs/windows-port.md:527` (old README:526) | Counted; the command reproduces it (the test files' own count) |
| 115 | 1.4.0 and 1.4.1, read again in 1.5.0; none measured on a Mac | changelog:251 | A statement taken from the source's text |
| 152 | 5-minute quickstart | `carton/kit/README.md:13` | A version, a date or a name |
| 154 | one-page prompt | `carton/kit/README.md:15` | A version, a date or a name |
| 173 | 20-snapshot history | changelog:383; changelog:389 | A statement taken from the source's text |
| 187 | All 16 | changelog:580 | As “16” above |
| 196 | 1,750 commits on main | `git rev-list --count 56142f3f` → 1750 | Counted; the command reproduces it |
| 197 | 1,914 commits on every branch | `git rev-list --count --remotes --before=2026-11-10T08:45Z` → 1914 | Counted; the command reproduces it. Every branch except chore/pnpm and docs/readme, both made after 08:45 UTC |
| 198 | 119 branches | `git branch -r --format='%(refname:short)' \| grep -v -E '^origin$\|HEAD\|chore/pnpm\|docs/readme' \| wc -l` → 119 | Counted; the command reproduces it. The remote branches without origin/HEAD, chore/pnpm (first commit 09:00 UTC) and docs/readme |
| 199 | 2026-10-27 to 2026-11-10 | `git log --reverse --format=%cs 56142f3f \| head -1` → 2026-10-27; `git log -1 --format=%cs 56142f3f` → 2026-11-10 | Counted; the command reproduces it |
| 200 | 8 patch scripts | `git ls-tree --name-only 56142f3f scripts/ \| grep -c -E '^scripts/patch-.*\.js$'` → 8; `git ls-tree --name-only 56142f3f scripts/carton/sync/patches/ \| grep -c '\.js$'` → 5 | Counted; the command reproduces it |
| 201 | 335 replacements (152 Windows, 183 Carton), 13 prepended blocks | commit `137306a4` | Counted with ~/gfv-scratch/release-150/tools/replog.sh on the dev box (not in the repo): it patches pristine 1.5.0 (~/gfv-scratch/cb-1.5.0) in build order and logs each replace() and prepend. Per script: patch-main 42 (+1 prepended), patch-worker 17 (+1), patch-strip 5, patch-renderer 68, patch-cli 3, patch-cli-media 17 (Windows: 152); patch-carton 158 (+4), patch-carton-sync 25 (+7) (Carton: 183). patch-carton's 158 matches commit 137306a4 |
| 202 | 19 Carton packages, plus a web app | `git ls-tree -d --name-only 56142f3f carton/packages/ \| wc -l` → 19; `git ls-tree -d --name-only 56142f3f carton/apps/ \| wc -l` → 1 | Counted; the command reproduces it |
| 203 | 428 and 51 test files | `git ls-tree -r --name-only 56142f3f -- carton \| grep -c -E '\.test\.(ts\|js\|mjs\|tsx)$'` → 428; `git ls-tree -r --name-only 56142f3f -- scripts \| grep -c -E '\.test\.(ts\|js\|mjs\|tsx)$'` → 51 | Counted; the command reproduces it. All 51 in scripts/ are under scripts/carton/test/ |
| 204 | 24 jobs, 13 groups, 12 Linux, 11 Windows, 1 macOS | `cd carton && node ci/plan.mjs \| wc -l` → 24; `cd carton && node ci/plan.mjs \| grep -c '(linux)'` → 12; `cd carton && node ci/plan.mjs \| grep -c '(windows)'` → 11; `cd carton && node ci/plan.mjs \| grep -c '(macos)'` → 1; `node -e 'console.log(require("./carton/ci/groups.json").groups.length)'` → 13 | Counted; the command reproduces it |
| 205 | 22 measurements | `node -e 'console.log(require("./carton/ci/measure.json").measurements.length)'` → 22 | Counted; the command reproduces it |
| 206 | 6,844 tests, 0 failures, all 24 jobs | changelog:416 | On the changelog, whose sign-off (line 559) says every number on it was checked independently |
| 226 | Node 24 | `.github/workflows/build-windows.yml:22`; `carton/README.md:51` | A version, a date or a name |
| 226 | 7-Zip | `docs/windows-port.md:546` (old README:1424) | A version, a date or a name |
| 248 | Built on Cardboard 1.5.0; not affiliated | changelog:561 | A statement taken from the source's text |
