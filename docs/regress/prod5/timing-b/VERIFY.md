# Timing B on carton-prod5 (39312830): independent verification, phase 1

Reviewer's own numbers only. I did not read RESUME.md, anything else under D:\cbwork\regress\, p3-sum.js,
p6b-sum.js or results\p3\summary.txt. Everything below is computed from the raw files. I launched, ran and changed
nothing (Windows' event log was read-only).

- Inputs: `D:\cbwork\carton\results\p6b\lat-b6-*.json` (12 runs, raw `samples`), `results\p6b\timing.log`,
  `results\p3\lat-b-*.json` (12 runs, per-writer rows only) and `results\p3\timing.log` (B section only).
- Scripts read: `timing-b6.sh`, `lat.sh`, `wr.sh`, `cb.js`, `launch.ps1`, `phase3-timing.sh` (B part),
  `scripts\carton\writers.js`.
- My scripts and their full output are next to this file: `analyze.js` → `analysis-output.txt`, `analyze2.js` →
  `analysis2-output.txt`, `analyze3.js` → `analysis3-output.txt`. They are reproducible with `node analyze*.js`.

## Definitions

- **Sample**: one entry of `samples[Wk]`. Its `ms` runs from before `cb source print` to after `cb source apply`
  returns (writers.js:69–83). Every sample in all 12 runs has `outcome: "applied"`. No edit number is missing, so no
  print failure was silently skipped (writers.js:74–75 `continue` without a sample).
- **Run median**: the median of all of a run's samples, pooled over its writers. For even n it is the mean of the two
  middle values.
- **Pooled median**: the median of all samples of the 3 runs of one side at one writer count. Its n is the sum of the
  runs' n.
- **Median of run medians (MRM)**: the median of the 3 run medians.
- **pXX**: nearest-rank. The values are sorted ascending and the one at index `ceil(XX/100·n)−1` is taken. This is
  the same rule as writers.js `pct()`. I re-derived every per-writer p50/p90/p99 and applied count in `rows` from
  `samples`. All 48 writer rows match exactly (0 mismatches), and the applied totals match timing.log's summary lines.
- **Diff** is always on − off. Positive means Carton on is slower.
- **Stall**: a sample of 5 000 ms or more. I also count samples of 3 000 ms or more, because that is where the on
  side's tail actually sits.

## The runs, in the order they ran (all 12 marked `clean` in timing.log; all times UTC on 2026-11-02)

| # | run | pair pos | start | n | applied | median | p90 | p95 | p99 | max | ≥3 s | ≥5 s | share < 1350 ms |
|---|-----|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | on-w4-r1 | 1st | 23:34:52 | 159 | 159 | 1486 | 1881 | 1990 | 3654 | 3679 | 3 | 0 | 13.8 % |
| 2 | off-w4-r1 | 2nd | 23:36:33 | 164 | 164 | 1468 | 1772 | 1950 | 2120 | 2209 | 0 | 0 | 11.6 % |
| 3 | off-w1-r1 | 1st | 23:38:12 | 40 | 40 | 1471 | 1608 | 1630 | 2230 | 2230 | 0 | 0 | 0 % |
| 4 | on-w1-r1 | 2nd | 23:39:50 | 40 | 40 | 1468 | 1835 | 1967 | 2192 | 2192 | 0 | 0 | 10.0 % |
| 5 | off-w4-r2 | 1st | 23:41:28 | 173 | 173 | 1450 | 1774 | 2025 | 2387 | 2396 | 0 | 0 | 39.3 % |
| 6 | on-w4-r2 | 2nd | 23:43:08 | 164 | 164 | 1474 | 1624 | 1792 | 1923 | 2168 | 0 | 0 | 7.9 % |
| 7 | on-w1-r2 | 1st | 23:44:47 | 33 | 33 | 1483 | 3371 | 3743 | 5927 | 5927 | 4 | 1 | 12.1 % |
| 8 | off-w1-r2 | 2nd | 23:46:26 | 40 | 40 | 1478.5 | 1667 | 1792 | 2202 | 2202 | 0 | 0 | 2.5 % |
| 9 | on-w4-r3 | 1st | 23:48:06 | 140 | 140 | 1515.5 | 2210 | 3294 | 3607 | 5654 | 11 | 1 | 11.4 % |
| 10 | off-w4-r3 | 2nd | 23:49:46 | 184 | 184 | 1249 | 1681 | 2014 | 2180 | 2728 | 0 | 0 | 55.4 % |
| 11 | off-w1-r3 | 1st | 23:51:23 | 40 | 40 | 1463 | 1577 | 2108 | 2212 | 2212 | 0 | 0 | 7.5 % |
| 12 | on-w1-r3 | 2nd | 23:53:00 | 29 | 29 | 1492 | 4970 | 5034 | 5427 | 5427 | 4 | 2 | 0 % |

All values are in ms. "applied" is the number of applies in the 60 s window. Each writer's last edit starts before
60 s and may end after it (span 60.1–62.3 s). The order is as the brief describes: within each pair it alternates,
the W=1 pairs start opposite to the W=4 ones, and on goes first in 3 of the 6 pairs.

A per-run p95/p99 at W=1 (n = 29–40) is just the 2nd–3rd and 1st largest sample. Read those as "largest values", not
as percentiles.

## Q1. Carton on vs off on carton-prod5

### Pooled and MRM

| | n | pooled median | MRM (run medians) | p90 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|---|---|
| on, W=1 | 102 | 1474 | 1483 (1468, 1483, 1492) | 2189 | 3743 | 5427 | 5927 | 1795.8 |
| off, W=1 | 120 | 1469 | 1471 (1471, 1478.5, 1463) | 1630 | 1966 | 2212 | 2230 | 1515.9 |
| **diff W=1** | | **+5** | **+12** | +559 | +1777 | +3215 | | +279.9 |
| on, W=4 | 463 | 1485 | 1486 (1486, 1474, 1515.5) | 1896 | 2140 | 3489 | 5654 | 1583.8 |
| off, W=4 | 521 | 1447 | 1450 (1468, 1450, 1249) | 1757 | 1986 | 2207 | 2728 | 1400.1 |
| **diff W=4** | | **+38** | **+36** | +139 | +154 | +1282 | | +183.6 |

Per-run p90/p95, given as the median over the 3 runs:

- W=1: p90 on 3371 vs off 1608, p95 on 3743 vs off 1792.
- W=4: p90 on 1881 vs off 1772, p95 on 1990 vs off 2014.

How well the samples support each percentile:

- Pooled p90 rests on 10–52 samples above it and p95 on 5–26, so both are real.
- Pooled p99 at W=1 (n = 102–120) is the 2nd largest sample, so treat it as a near-maximum.
- Pooled p99 at W=4 (n = 463–521) has about 5 samples above it.

### Uncertainty of the median difference

Per-pair run-median diffs, in run order:

- W=4: +18, +24, +266.5.
- W=1: −3, +4.5, +29.

Statistics:

- **Exact permutation test over run labels on MRM** (20 relabelings; the smallest two-sided p possible with 3 v 3
  is 2/20 = 0.10):
  - W=1: p = 8/20 = 0.40.
  - W=4: p = 4/20 = 0.20.
  - Neither median difference is significant at the run level.
- **Hierarchical bootstrap** (resample runs, then samples within a run; 10 000 draws, fixed seed). With only 3 runs
  this is crude.
  - W=1: pooled diff 95 % interval [−7, +130], MRM [−11.5, +132.5].
  - W=4: pooled diff [+10, +177.5], MRM [+8, +309].
- **Tests that treat samples as independent** say W=4 is "highly significant": Mann–Whitney z = 8.35, iid bootstrap
  [+21, +48], Hodges–Lehmann +88.
  - Don't use them. The samples are strongly clustered in time; see the two-regimes section below.
- **A ≥3 s sample, per run**: 4 of 6 on runs have one (22 of 565 samples) and 0 of 6 off runs do (0 of 641).
  - Fisher exact at the run level: one-sided p = 15/495 = 0.030, two-sided 0.061.
- **A ≥5 s sample**: 3 of 6 on runs have one (4 samples) and 0 of 6 off runs do.

### Two latency regimes (needed to read any of the above)

Every run, on both sides, is a mix of two tight modes:

- a main mode at about 1 420–1 520 ms;
- a fast mode at about 1 000–1 250 ms.

The fast mode comes in windows of several seconds, during which **all 4 writers are fast at the same seconds** (for
example off-w4-r3 at 18–22 s and 45–58 s, and on-w4-r1 at 18, 24 and 26 s). So it is a state of the machine or the
app, not something that depends on the request path.

How much of each run was spent in it differed. The share of samples under 1 350 ms:

- off-w4-r2: 39 %; off-w4-r3: 55 %.
- every other run: 0–14 %.

Split by regime (analyze2/analyze3):

- **In the main mode** (samples 1 350–3 000 ms) on and off are the same:
  - W=1: MRM diff +6; pooled 1474 vs 1470.5.
  - W=4: MRM diff −6; pooled 1494 vs 1492.
  - Within that mode, the spread over 1 350–1 600 ms is also the same on both sides (p10 ≈ 1 430, p50 ≈ 1 470,
    p90 ≈ 1 510–1 580).
- **In the fast mode** (under 1 350 ms, each writer's first edit excluded) on is slower:
  - W=4: on median 1230 (n = 51) vs off 1077 (n = 187), **+153**.
  - W=1: +52, on n = 7 vs off n = 4 (too few samples to read).
  - These samples come in a handful of time clusters, so the effective n is far smaller than the counts.

The W=4 median gap (+36 to +38) is therefore mostly **how much time each side spent in the fast mode**: pair 3's +266
is off-w4-r3's 55 % fast share. It is not a shift of the main mode.

That leaves two readings this data cannot tell apart:

- **(a)** The fast mode is environmental, and the off side simply got more of it, so the Carton-on median cost in
  this session is about 0.
- **(b)** Something keeps both sides at about 1 470 ms in the main mode and hides Carton's extra work, which shows only
  when that floor lifts. Then the true per-round-trip cost is closer to the fast-mode gap, about +150 ms at W=4.

The tightness of the 1 470 plateau and the identical spread on both sides fit (b) as well as (a).

There is also a second bias: the loop is closed, so faster periods yield more samples. Pooled statistics therefore
over-weight fast periods, and the off side had more of them. That pushes the pooled W=4 diff up relative to a
time-weighted one.

### Throughput (applies in 60 s)

| | runs | median | sum |
|---|---|---|---|
| on, W=1 | 40, 33, 29 | 33 | 102 |
| off, W=1 | 40, 40, 40 | 40 | 120 |
| on, W=4 | 159, 164, 140 | 159 | 463 |
| off, W=4 | 164, 173, 184 | 173 | 521 |

- writers.js waits for each edit before it starts the next (`--rate 1` is a ceiling). At about 1.47 s per round trip
  a writer reaches at most about 40 applies a minute, so "1 apply/s" was never reached on either side.
- Throughput is therefore just the latency seen another way, not independent evidence:
  - W=1: on lost 7 and 11 applies in r2 and r3, which are exactly the two runs with 3–6 s stalls.
  - W=4: off's higher counts in r2 and r3 are its fast-mode share.

### Answer to Q1, with confidence

- **Tail: yes, a real Carton-on cost.** With Carton on, an occasional round trip takes 3.2–5.9 s. With Carton off, the
  largest of 641 round trips was 2 728 ms.
  - The evidence is moderate-to-good: 4 of 6 on runs vs 0 of 6 off runs, run-level p ≈ 0.03 one-sided.
  - At W=1 this costs throughput in 2 of 3 runs (33 and 29 applies vs 40).
  - At W=4 the long samples line up across writers (on-w4-r3: W2, W3 and W4 at 28.6–30.0 s, and W1, W2 and W3 at 55.1–57.8 s;
    on-w4-r1: W1 and W2 both at 58.7 s).
    That looks like a stall shared by all writers, not contention between them.
  - Two loose clusters: about 3.2–3.7 s and about 4.8–5.9 s.
- **Median: no detectable cost at W=1.** The diff is +5 pooled and +12 MRM, but the uncertainty runs to about
  +130 ms, so a cost up to about 100 ms can't be excluded.
- **Median at W=4: +36 to +38 ms as measured, low confidence.** The permutation p is 0.20. The gap is driven by the
  regime mix, not by a shift in the main mode. Within the dominant mode the cost is about 0. Within the fast mode it
  is about +150 ms on clustered samples.
- **What I would not quote:** a single "Carton-on cost per round trip" number from this session, until the regime is
  controlled.

## Q2. Versus the earlier round (carton-final 0cc587f1, results\p3)

The p3 files have no samples, so the only common statistic is **the median of per-writer nearest-rank p50s per run**
(for W=1 that is the run's p50). On p6b this gives almost the same numbers as above.

| | p3 on (rcon) | p3 off (rcoff) | p3 diff, MRM | p3 pair diffs | p6b diff, MRM | p6b pair diffs |
|---|---|---|---|---|---|---|
| W=1 | 1400, 1263, 1425 | 1099, 1152, 1106 | **+294** | +301, +111, +319 | **+14** | −1, +5, +30 |
| W=4 | 1234, 1302, 1203 | 1109, 1113, 1040 | **+125** | +125, +189, +163 | **+33.5** | +15.5, +25.5, +273 |

Applies on − off (median of runs):

- p3: W=1 −15 (34, 42, 37 vs 54, 49, 52); W=4 −44 (186, 127, 155 vs 196, 199, 218).
- p6b: W=1 −7; W=4 −14.

Tails:

- p3 on at W=4: 8 of 12 writers had a p99 of at least 8 s, up to 11 825 ms.
- p6b on at W=4: no writer's p99 is above 5 654 ms (on's maximum anywhere is 5 927).
- p3 off was not stall-free either: off-w4-r2's W4 had a p99 of 11 184.

What the cross-round comparison can support:

- In both rounds, the gap within the round has the same sign: Carton on is slower at the median and in the tail.
  - p3 has every pair positive at both writer counts.
  - In p6b the median gap is smaller in every pair except W=4 r3.
- The longest on-side stalls look shorter (about 11 s → under 6 s). That is consistent with an improvement in the tail.

What it can't support:

- **"The Carton-on cost shrank from about 125–294 ms to about 15–35 ms."** The reasons:
  1. **The off side moved by about 370 ms between rounds** (about 1 100 → about 1 470 at the median).
     - It is a different build (68 commits apart, including patch-main changes that apply to both sides), on a
       different day, in a different machine state.
     - p3's off medians (1 040–1 152) sit exactly in this round's fast mode, and both modes appear within single
       runs of the same prod5 build. So most of the shift is probably the machine state, not the code. I can't prove
       that: out\carton-final no longer exists to re-measure.
     - Even so, a +370 ms off-side regression in shipped code has not been ruled out, and per the no-net-negative
       rule it should be.
  2. **Within this round, in the fast mode that matches p3's conditions, on − off is about +153 ms at W=4.** That is
     in line with p3's +125, so the apparent shrink may be the 1 470 regime hiding the cost (reading (b) above), not
     the perf change.
  3. **The rounds differ in method.**
     - p3's W=1 pairs ran in the same order as its W=4 pairs, so on went first in 4 of 6 pairs, not 3.
     - p3 had no compile-cache warm-up.
     - p3 ran right after an hour of other C and large runs.
     - With 3 runs a side in each round, the run-level noise alone (for example p3 on-w4 run medians 1203–1302) is
       of the same order as the claimed change.
- About the author's "−61 ms per print+apply with Carton on" (measured on Linux): this data neither confirms nor
  refutes it. This round's design measures on − off, not prod5-on vs final-on, and the two rounds' absolute numbers
  aren't comparable.

## Q3. Failures, outcomes, stalls

- **Failures:** 0 in all 12 runs. Every `failures` array is empty, every row has `failed: 0`, and every one of the
  1 206 samples has `outcome: "applied"`. No print failures either: there are no gaps in the edit numbers.
- **Lost updates** (not in timing.log's one-line summary; only in the JSON/.log):
  - **off-w4-r2:** W3 last applied 2143, on disk 2142.
  - **off-w4-r3:** W3 last applied 2146, on disk 2145.
  - All 6 on runs: 0 lost.
  - Two lost updates in 3 off runs at W=4 is the B1 behaviour of Cardboard 1.4.0 that Carton exists to fix. It is
    expected, but it should be reported next to the timing, since the off side's extra throughput includes writes
    that were then lost.
- **Stalls ≥5 s** (writer, edit, seconds into the run, ms):
  - **on:**
    - on-w1-r2: W1 #33 at 56.1 s, 5 927.
    - on-w1-r3: W1 #7 at 9.4 s, 5 034; W1 #23 at 41.8 s, 5 427 (with 4 850 and 4 970 just under).
    - on-w4-r3: W3 #34 at 55.1 s, 5 654.
    - That is 4 samples in 3 runs.
  - **off:** none. The off maximum is 2 728.
- **≥3 s:**
  - on: 22 (on-w4-r1: 3, on-w4-r3: 11, on-w1-r2: 4, on-w1-r3: 4).
  - off: 0.
  - The exact times are in `analysis2-output.txt`.

## Q4. Method

Balanced and in order:

- The order alternates within pairs, and on goes first in exactly 3 of 6 pairs.
- The pair diffs show no order effect:
  - W=4: on-first +18 and +266.5, off-first +24.
  - W=1: on-first +4.5, off-first −3 and +29.
- All runs are marked clean.
- No "on battery" or "waiting" note appears in the log.
- The warm-up did write the compile cache: `%TEMP%\node-compile-cache\v24.21.0-x64-2d60bbc0\f8c867ad` (259 868 B) at
  23:34:49 UTC.
  - No entry was added or rewritten afterwards, so every run saw the same warm cache.
- First edits after the app opens are slow on both sides alike: about 1.95–2.04 s at W=4 r1.

Sample sizes:

- At W=1 a side has 102–120 samples in 3 runs. That is enough for a pooled p90/p95, not for a p99, and enough to see
  the tail stalls, but only 3 runs.
- At W=4 a side has 463–521 samples.
- In both cases the unit of replication is the run (n = 3), and the samples within a run are autocorrelated (the
  regime windows). Any significance that treats samples as independent is overstated.

What could bias a side:

1. **The regime mix** (above). This is the dominant issue at W=4, and it currently favours off.
2. **Closed-loop sampling** over-weights fast periods in pooled statistics (also favours off).
3. **The "2 idle minutes" gate is user-input idle, not a machine cooldown.** Each run started 1–2 s after the previous
   app was killed, so runs are back to back. That is balanced by the alternation, but there is no thermal or
   background settling.
4. **Session start:**
   - The build finished at 23:34:22 UTC, 27 s before the warm-up, so the first launches ran a 239 MB exe that had
     just been written. A first-launch antivirus scan is possible.
   - Windows installed a Store update (WindowsAppRuntime) at 23:34:50–54 UTC, during the warm-up and before run 1's
     writers started at 23:35:24.
   - Run 1 (on-w4-r1) is the one most exposed to both. Its 3 samples of 3 s or more come late in the run (53–59 s),
     though, not at the start.
5. **"Other tests run on this laptop":** the gates check only for other Cardboard.exe processes, user input and power.
   An unrelated CPU load during the session would not be detected and could be what sets the regime.

What I would re-run before quoting anything:

- **Regime control.**
  - Time a trivial Cardboard.exe-as-Node spawn (and a print alone) before and after each run, and log `print` and
    `apply` durations separately in writers.js.
  - Then report on − off within each regime, or only for runs whose baseline spawn matches.
- **More pairs:** at least 6 per writer count, so a run-level test can reach p < 0.05 and both sides get a fair share
  of each regime.
- **A real cross-round comparison:** rebuild carton-final and run final-off, final-on, prod5-off and prod5-on
  interleaved in one session. Only that can show whether the Carton-on cost shrank and whether the off side
  regressed by about 370 ms or the machine was simply slower.
- **The on-side 3–6 s stalls**, which line up across writers: capture what the app and Carton are doing at those
  moments. One hypothesis to check, not a finding: work deferred by this build (for example the WAL checkpoint) now
  lands mid-session.

## Summary (phase 1, reviewer's own numbers)

| | W=1 | W=4 |
|---|---|---|
| median diff (pooled / MRM) | +5 / +12 ms: no detectable cost | +38 / +36 ms: low confidence, driven by the regime mix |
| main-mode diff (MRM) | +6 | −6 |
| fast-mode diff (pooled) | +52 (n = 7 v 4, unusable) | +153 (n = 51 v 187, clustered) |
| p90 / p95 diff (pooled) | +559 / +1 777 | +139 / +154 |
| samples ≥3 s, on v off | 8 v 0 | 14 v 0 |
| samples ≥5 s, on v off | 3 v 0 | 1 v 0 |
| applies (median of runs), on v off | 33 v 40 | 159 v 173 |
| failures | 0 v 0 | 0 v 0 (lost: 0 v 2) |
| cost shrank vs carton-final? | not supported (confounded) | not supported (confounded) |

## Phase 2: comparison with the other agent (`results\p6b\summary-mine.txt`, `p6b-sum.js`)

### Definitions compared

| | other agent (p6b-sum.js) | mine (analyze.js) | effect |
|---|---|---|---|
| sample set | samples with `outcome === "applied"` | all samples | none: all 1 206 are `applied` |
| median | mid-mean for even n | mid-mean for even n | identical |
| p90 / p95 | nearest rank, `ceil(p/100·n)−1` | the same | identical |
| median of run medians | median of the 3 run medians | the same | identical |
| pooled | all samples of the 3 runs | the same | identical |
| stalls | applied samples ≥ 5 000 ms | samples ≥ 5 000 ms | identical |
| lost | `j.lost` | `j.lost`, plus the writer rows | identical |

### Number by number

There are 12 runs, and each has applied, median, p90, p95, max, stalls ≥5 s and lost: 84 values.
On top of those come 4 side rows, each with its run medians, median of run medians, pooled median, pooled p90,
pooled p95 and applies per run.

**Every value is equal. There is no difference at all, not even a rounding one.**

| run | applied | median | p90 | p95 | max | ≥5 s | lost | agree |
|---|---|---|---|---|---|---|---|---|
| off-w1-r1 | 40 | 1471 | 1608 | 1630 | 2230 | 0 | 0 | yes |
| off-w1-r2 | 40 | 1478.5 | 1667 | 1792 | 2202 | 0 | 0 | yes |
| off-w1-r3 | 40 | 1463 | 1577 | 2108 | 2212 | 0 | 0 | yes |
| on-w1-r1 | 40 | 1468 | 1835 | 1967 | 2192 | 0 | 0 | yes |
| on-w1-r2 | 33 | 1483 | 3371 | 3743 | 5927 | 1 | 0 | yes |
| on-w1-r3 | 29 | 1492 | 4970 | 5034 | 5427 | 2 | 0 | yes |
| off-w4-r1 | 164 | 1468 | 1772 | 1950 | 2209 | 0 | 0 | yes |
| off-w4-r2 | 173 | 1450 | 1774 | 2025 | 2396 | 0 | 1 | yes |
| off-w4-r3 | 184 | 1249 | 1681 | 2014 | 2728 | 0 | 1 | yes |
| on-w4-r1 | 159 | 1486 | 1881 | 1990 | 3679 | 0 | 0 | yes |
| on-w4-r2 | 164 | 1474 | 1624 | 1792 | 2168 | 0 | 0 | yes |
| on-w4-r3 | 140 | 1515.5 | 2210 | 3294 | 5654 | 1 | 0 | yes |

| side | run medians | median of run medians | pooled median | pooled p90 | pooled p95 | applies | agree |
|---|---|---|---|---|---|---|---|
| w1 off | 1471, 1478.5, 1463 | 1471 | 1469 | 1630 | 1966 | 40, 40, 40 | yes |
| w1 on | 1468, 1483, 1492 | 1483 | 1474 | 2189 | 3743 | 40, 33, 29 | yes |
| w4 off | 1468, 1450, 1249 | 1450 | 1447 | 1757 | 1986 | 164, 173, 184 | yes |
| w4 on | 1486, 1474, 1515.5 | 1486 | 1485 | 1896 | 2140 | 159, 164, 140 | yes |

What the agreement shows:

- The arithmetic is confirmed. Two separately written scripts got the same numbers from the same raw files.
- This is **not** a re-measurement. The method caveats from phase 1 (Q4) still apply to every number.
- `summary-mine.txt` leaves out three things phase 1 found, and each changes how its numbers should be read:
  1. The two-regime split.
  2. The per-run concentration of the tail.
  3. The fact that the run-level tests are not significant.

### The other agent's three conclusions

**1. "Carton-on p50 is now close to off: 1,483 vs 1,471 ms at 1 writer, 1,486 vs 1,450 ms at 4 writers (median of
run medians)."**

The numbers are correct, but the conclusion needs rewording:

- "Now" implies a comparison with carton-final, and Q2 shows that comparison is confounded: off moved by about
  370 ms between rounds. Drop "now".
- "Close" is fair at 1 writer (+12 ms; pair diffs −3, +4.5, +29).
- At 4 writers +36 ms is not established:
  - The pair diffs are +18, +24 and +266.5.
  - The permutation p over run labels is 0.20.
  - Most of the gap is off-w4-r3's run median of 1249, which spent 55 % of its samples in the faster state.
- Wording I'd allow: "On carton-prod5 the median of run medians was 1,483 ms with Carton on vs 1,471 ms off at
  1 writer (+12), and 1,486 vs 1,450 ms at 4 writers (+36). With 3 runs a side, neither difference is distinguishable
  from run-to-run variation."

**2. "The Carton-on tail is longer: pooled p95 3,743 vs 1,966 ms at 1 writer, and 2,140 vs 1,986 ms at 4. 1-writer
throughput dropped in 2 of 3 runs."**

The tail being longer holds. The p95 numbers are correct, but at 4 writers the pooled p95 is the wrong evidence:

- **At 1 writer** the pooled p95 (n = 102) comes from two runs. on-w1-r1's p95 is 1967, the same as off. Better
  evidence:
  - 8 of 102 on samples took 3 s or more, against 0 of 120 off.
  - 3 took 5 s or more, against 0 off.
  - The max is 5 927 against 2 230.
- **At 4 writers** the +154 pooled-p95 gap is one run, on-w4-r3:
  - on-w4-r1 and on-w4-r2 have p95s of 1990 and 1792, inside or below the off range of 1950–2025.
  - The median of the runs' p95s is 1990 on vs 2014 off, so on is lower.
  - The 4-writer tail evidence is in the extremes instead: 14 of 463 on samples took 3 s or more against 0 of 521
    off, they come from 2 of 3 on runs, and the max is 5 654 against 2 728.
- **Throughput** holds: 33 and 29 applies against 40 in every off run.
  - Say that these are the same two runs that had 3–6 s round trips.
  - Say that throughput restates latency, because writers.js waits for each edit before starting the next.
  - At 4 writers, on was lower too (159, 164, 140 vs 164, 173, 184), but that mostly reflects the off side's faster
    windows. Don't call it a Carton cost.

**3. "No failures; 2 off runs flagged lost=1."**

This holds. It should be more exact:

- It was 0 failures and 0 non-applied outcomes in 1 206 edits.
- Lost was 1 in off-w4-r2 and in off-w4-r3:
  - In both, W3's last applied edit was not on disk (2143 vs 2142, and 2146 vs 2145).
  - This is Cardboard 1.4.0's lost update, which Carton exists to fix.
  - All 6 Carton-on runs lost 0.
- "Flagged" is a slight overstatement. timing.log's summary lines don't show lost; only the JSON and the per-run .log
  do.

### Safe to quote

Context that goes with every quote:

- carton-prod5 (39312830), timing B: `cb source print` + `cb source apply`, with the app open on the project and
  nobody editing.
- 60 s runs at up to 1 apply/s per writer.
- 3 runs a side per writer count, alternating, all marked clean.
- One session: 2026-11-02, 23:34–23:55 UTC.
- The numbers were computed independently twice from the same raw samples. They were not re-measured.

1. "Every round trip applied: 1 206 edits over 12 runs, 0 failures. With Carton off, 2 of 3 runs at 4 writers lost
   one writer's last applied edit (Cardboard 1.4.0's lost update); with Carton on, none did."
2. "Median round trip, as the median of run medians:
   - 1 writer: Carton on 1,483 ms (runs 1468, 1483, 1492) vs off 1,471 ms (1471, 1478.5, 1463).
   - 4 writers: on 1,486 ms (1486, 1474, 1515.5) vs off 1,450 ms (1468, 1450, 1249).

   With 3 runs a side, neither gap is statistically distinguishable from run-to-run variation (run-label permutation
   p = 0.40 and 0.20)."
3. "With Carton on, some round trips take 3–6 s; with Carton off, none took over 2.7 s.
   - Samples of 3 s or more: on 22 of 565 (in 4 of 6 runs), off 0 of 641.
   - Samples of 5 s or more: on 4, off 0.
   - Max on: 5,927 ms (1 writer), 5,654 ms (4 writers). Max off: 2,230 and 2,728 ms.

   Per run, at 1 writer, the max was on 2192, 5927, 5427 vs off 2230, 2202, 2212. At 4 writers it was on 3679, 2168,
   5654 vs off 2209, 2396, 2728."
4. "At 1 writer, those stalls cost throughput in 2 of 3 Carton-on runs: 40, 33 and 29 applies in 60 s vs 40, 40 and
   40 off."
5. "Per-run p95 at 1 writer: on 1967, 3743, 5034 vs off 1630, 1792, 2108. At 4 writers: on 1990, 1792, 3294 vs off
   1950, 2025, 2014. The 4-writer tail difference comes from one run."

### Do not quote

- "Now close to off", "the Carton-on cost shrank", or any cost figure against carton-final.
  - Different build and day, and the off side moved by about 370 ms.
  - There was no interleaved final vs prod5 session.
- "+36 ms Carton-on cost at 4 writers" as a measured cost. It is regime-mix driven and not significant.
- The fast-mode +153 ms or the main-mode −6/+6 ms as a Carton cost. These are my diagnostic splits, on clustered
  samples, with post-hoc thresholds.
- Pooled p95 at 4 writers (2,140 vs 1,986) as "the tail is longer at 4 writers" without saying it is one run.
- Any p99 at 1 writer (n = 29–40 per run, 102–120 pooled). It is the largest or second-largest sample.
- Mann–Whitney, iid-bootstrap or Hodges–Lehmann figures. They treat samples as independent, and the samples are
  clustered in time.
- "4-writer throughput is lower with Carton on" as a Carton cost.
- The author's "−61 ms per print+apply" in any form. This round does not measure it.
- Any statement that the 3–6 s stalls come from the deferred WAL checkpoint or any other cause. Untested.
