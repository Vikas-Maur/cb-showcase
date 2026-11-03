# Timing B (Update 8): independent verification, phase 1

Reviewer's own numbers only. I did not read `p8-sum.js`, `summary-mine.txt`, `RESUME.md`, or anything else under
`D:\cbwork\regress\`. Inputs, all read-only: `D:\cbwork\carton\results\p8\` (24 `lat-b8-*.json`, 24 `*-activity.jsonl`,
`timing.log`), `timing-b8.sh`, `lat8.sh`, `scripts/carton/writers.js` at 66ee2f3f, and the built `out/carton-prod6`
(I only grepped it). Scripts in this folder: `verify.js` (main → `out.txt`), `verify2.js` (cuts and method checks → `out2.txt`),
`verify3.js` (overlap check). Re-run them with `node verify.js`.

## Definitions

- **Trip** = one sample's `ms`, from just before `cb source print` to the end of `cb source apply` (print + writing
  the edited file + apply). `ms − print − apply` is 0–3 ms in every run except two (≤10 ms, and once 89 ms in off-w4-r3,
  not a slow trip).
- **Median** = the middle value of the sorted list; for an even count, the mean of the two middle values.
- **Median of run medians** = that median over the 6 per-run medians (so the mean of the 3rd and 4th).
- **Pooled** = every sample of the 6 runs of a side and writer count, put together.
- **p90 / p95** = nearest rank, `sorted[ceil(p/100·n) − 1]`, the same rule as writers.js `pct()`. The tables also give
  linear interpolation (numpy's default), marked "lin", to show how much the rule matters.
- **≥3 s / ≥5 s** = `ms >= 3000` / `ms >= 5000`.
- **Applies** = samples with `outcome === "applied"`. **Failures** = `failures.length`. **Lost** = the file's `lost`.
- **Which part holds the extra time** = compare `print` and `apply` against baselines: the pooled medians over trips under
  3 s, for the same side and writer count (on/W1: print 285, apply 1051; off/W1: 254, 1033; on/W4: 335, 987; off/W4: 294, 884).
  The part with the bigger excess holds the extra time.
- Times: `timing.log` is in UTC. Activity logs and every clock time below are local (+05:30), so 04:08 UTC = 09:38 local.

**Cross-checks.** For all 24 runs, my recount matches `timing.log`'s summary line (edits, applied, failed, trips≥3 s,
lost), and it matches writers.js's own per-writer p50/p90/p99 rows (nearest rank) exactly. No mismatches.

## 1. Carton on vs off

### Every run, in execution order

| # | run | UTC start | mark | n | applied | failed samples | failures[] | lost | median | p90 | p95 | p95 lin | ≥3s | ≥5s | print med | apply med | timeline answers |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | on-w4-r1 | 04:08:00 | clean | 168 | 168 | 0 | 0 | 0 | 1348.5 | 1882 | 2158 | 2156.9 | 0 | 0 | 345 | 986.5 | shown 168 |
| 2 | off-w4-r1 | 04:09:26 | clean | 170 | 170 | 0 | 0 | 0 | 1174 | 1647 | 1826 | 1812.1 | 5 | 2 | 291.5 | 852.5 | null 170 |
| 3 | off-w1-r1 | 04:10:51 | clean | 35 | 35 | 0 | 0 | 0 | 1404 | 1823 | 4292 | 2593.8 | 2 | 1 | 258 | 1141 | null 35 |
| 4 | on-w1-r1 | 04:12:17 | clean | 37 | 37 | 0 | 0 | 0 | 1377 | 2092 | 3294 | 2406.0 | 2 | 1 | 284 | 1024 | shown 37 |
| 5 | off-w4-r2 | 04:13:43 | clean | 191 | 191 | 0 | 0 | 2 | 1186 | 1557 | 1681 | 1680 | 0 | 0 | 290 | 870 | null 191 |
| 6 | on-w4-r2 | 04:15:09 | clean | 149 | 149 | 0 | 0 | 0 | 1324 | 3278 | 3564 | 3491.2 | 20 | 2 | 318 | 982 | shown 149 |
| 7 | on-w1-r2 | 04:16:39 | clean | 34 | 34 | 0 | 0 | 0 | 1460 | 3293 | 5348 | 4321.7 | 4 | 2 | 283.5 | 1161 | shown 34 |
| 8 | off-w1-r2 | 04:18:08 | clean | 47 | 47 | 0 | 0 | 0 | 1241 | 1483 | 1809 | 1737.9 | 0 | 0 | 253 | 1002 | null 47 |
| 9 | on-w4-r3 | 04:19:32 | clean | 148 | 148 | 0 | 0 | 0 | 1388 | 2165 | 3353 | 3352.7 | 12 | 1 | 331.5 | 1023 | shown 148 |
| 10 | off-w4-r3 | 04:20:56 | clean | 197 | 197 | 0 | 0 | 0 | 1124 | 1554 | 1618 | 1617.2 | 0 | 0 | 298 | 815 | null 197 |
| 11 | off-w1-r3 | 04:22:20 | clean | 47 | 47 | 0 | 0 | 0 | 1239 | 1500 | 1760 | 1735.7 | 0 | 0 | 257 | 969 | null 47 |
| 12 | on-w1-r3 | 04:23:45 | clean | 42 | 42 | 0 | 0 | 0 | 1418 | 1567 | 2013 | 2002.2 | 0 | 0 | 283.5 | 1126 | shown 42 |
| 13 | off-w4-r4 | 04:25:11 | clean | 190 | 190 | 0 | 0 | 3 | 1215.5 | 1574 | 1660 | 1659.1 | 0 | 0 | 296 | 890 | null 190 |
| 14 | on-w4-r4 | 04:26:36 | clean | 173 | 173 | 0 | 0 | 0 | 1320 | 1689 | 1891 | 1888.6 | 1 | 0 | 343 | 975 | shown 173 |
| 15 | on-w1-r4 | 04:28:03 | clean | 44 | 44 | 0 | 0 | 0 | 1310 | 1504 | 1750 | 1725.0 | 1 | 0 | 288 | 995.5 | shown 44 |
| 16 | off-w1-r4 | 04:29:29 | clean | 26 | 26 | 0 | 0 | 0 | 1617.5 | 2164 | 11145 | 8899.8 | 2 | 2 | 254 | 1366.5 | null 26 |
| 17 | on-w4-r5 | 04:30:54 | clean | 51 | 51 | 0 | 0 | 0 | 5264 | 5389 | 5456 | 5441 | 51 | 38 | 307 | 4956 | shown 51 |
| 18 | off-w4-r5 | 04:32:41 | clean | 92 | 92 | 0 | 0 | 0 | 1468 | 11203 | 11243 | 11232.5 | 11 | 11 | 270 | 1198.5 | null 92 |
| 19 | off-w1-r5 | 04:34:09 | clean | 46 | 46 | 0 | 0 | 0 | 1241.5 | 1567 | 1856 | 1840.8 | 0 | 0 | 253.5 | 977 | null 46 |
| 20 | on-w1-r5 | 04:35:41 | clean | 45 | 45 | 0 | 0 | 0 | 1316 | 1501 | 1564 | 1555.0 | 0 | 0 | 291 | 1020 | shown 45 |
| 21 | off-w4-r6 | 04:37:07 | clean | 188 | 188 | 0 | 0 | 3 | 1222 | 1562 | 1629 | 1626.9 | 1 | 0 | 297 | 911 | null 188 |
| 22 | on-w4-r6 | 04:38:31 | clean | 145 | 145 | 0 | 0 | 0 | 1371 | 3171 | 3351 | 3345.8 | 16 | 3 | 321 | 1023 | shown 145 |
| 23 | on-w1-r6 | 04:39:58 | clean | 44 | 44 | 0 | 0 | 0 | 1336.5 | 1541 | 1642 | 1640.7 | 0 | 0 | 282.5 | 1045.5 | shown 44 |
| 24 | off-w1-r6 | 04:41:24 | clean | 50 | 50 | 0 | 0 | 0 | 1207 | 1436 | 1538 | 1515.0 | 0 | 0 | 254.5 | 960.5 | null 50 |

Times in ms; p90 and p95 use the nearest-rank rule. W=1 runs have 26–50 samples, so their p95 is the 2nd- or 3rd-largest
trip, which makes it very noisy.

### Aggregates, all 24 runs

| W | side | samples | median of run medians | pooled median | pooled p90 (lin) | pooled p95 (lin) | ≥3 s | ≥5 s | applies (per run r1..r6) | failures | lost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | on | 246 | **1356.8** | **1374.5** | 1684 (1675) | 2044 (2036.3) | 7 | 3 | 246 (37, 34, 42, 44, 45, 44) | 0 | 0 |
| 1 | off | 251 | **1241.3** | **1293** | 1679 (1679) | 1841 (1832) | 4 | 3 | 251 (35, 47, 47, 26, 46, 50) | 0 | 0 |
| 4 | on | 834 | **1359.8** | **1370** | 3257 (3257) | 5188 (5188) | 100 | 44 | 834 (168, 149, 148, 173, 51, 145) | 0 | 0 |
| 4 | off | 1028 | **1200.8** | **1215** | 1599 (1598.3) | 1736 (1733.5) | 17 | 13 | 1028 (170, 191, 197, 190, 92, 188) | 0 | 8 (r2 2, r4 3, r6 3) |

Per-run medians and p95 (r1..r6):
- W1 on: medians 1377, 1460, 1418, 1310, 1316, 1336.5; p95 3294, 5348, 2013, 1750, 1564, 1642
- W1 off: medians 1404, 1241, 1239, 1617.5, 1241.5, 1207; p95 4292, 1809, 1760, 11145, 1856, 1538
- W4 on: medians 1348.5, 1324, 1388, 1320, 5264, 1371; p95 2158, 3564, 3353, 1891, 5456, 3351
- W4 off: medians 1174, 1186, 1124, 1215.5, 1468, 1222; p95 1826, 1681, 1618, 1660, 11243, 1629

Paired run medians (on − off, ms): W1 −27, +219, +179, −307.5, +74.5, +129.5 (median +102; on slower in 4/6 pairs).
W4 +174.5, +138, +264, +104.5, +3796, +149 (median +161.8; on slower in 6/6 pairs; without r5 the median is +149).

There were no failures in any of the 24 runs: every sample was applied, and `failures` is empty everywhere.
Confidence: **high**. These are exact recounts from the raw files, and they match timing.log and writers.js's own rows.

## 2. Every trip of 3 s or more (128 in all)

The full list, one row per trip, is in **Appendix A**. Summary:

| side, W | trips ≥3 s | apply holds the extra time | print holds it | timeline answer | matching worker lines |
|---|---|---|---|---|---|
| on, W1 | 7 | 7 | 0 | shown 7 | 0 |
| on, W4 | 100 | 100 | 0 | shown 100 | 0 |
| off, W1 | 4 | 4 | 0 | null 4 (Carton off) | 0 |
| off, W4 | 17 | 17 | 0 | null 17 (Carton off) | 0 |

- **(a) Print or apply.** It is the apply in all 128. The longest print in a slow trip is 789 ms, against print baselines of
  254–335 ms. Every apply excess is ≥1.8 s. Six slow trips also have a somewhat longer print (+340 to +454 ms, in on-w4-r2,
  on-w4-r3 and on-w1-r1), but even there the apply holds most of the extra time. Confidence: **high**.
- **(b) The timeline answer.** All 107 Carton-on slow trips answered `shown`. There were **no `later`**, and no `held` or
  `elsewhere`. In fact all 1080 Carton-on samples, slow or not, were `shown`. All 1279 Carton-off samples are `null`, as
  designed. So no trip ran out cb's 2 s wait. Confidence: **high**.
- **(c) Worker lines.** I found **none**. Each of the 24 activity logs has exactly 4 lines: `app.start`, `temp-sweep`, `gpu`
  and `app.quit`. Across all runs there are **0 `ev:"worker"` lines** and 0 lines containing `a cb write waited`. I matched
  using a window from start − 2 s to start + ms + 5 s, and found 0 matches for all 128 trips. Every run's samples fall inside
  its `app.start`…`app.quit` window: the first write comes 10.6–11.6 s after `app.start`, and `app.quit` comes 0.2–0.6 s
  after the last trip. So the logs do cover the timed period.

**What the absence shows, and what it doesn't.**
- The pipe produced **no `ev:"worker"` line at all, in any of the 24 runs, on either side.** That includes Cardboard's own
  library worker with Carton off.
- The patch is in the build that was timed: `out/carton-prod6/.../app.asar` contains
  `utilityProcess.fork(... "library-worker.js" ..., {..., stdio:"pipe"}),__cbPipeWorker(s)`, and
  `resources/carton/sync/views.js` and `carton-node.cjs` contain the `a cb write waited` string. **The patch is present, but
  these runs don't show it working.**
- Silence is expected if nothing was slow enough to log. `onSlowShow` fires only from `Materializer.showChange`
  (`carton/packages/cardboard/src/node/materializer.ts` ~l.1002), and only when that read-your-writes wait (plus `beforeMs`)
  reaches 500 ms. If every `shown` answer came back in under 500 ms, the hook printed nothing. That is consistent with what we
  see. Nothing in the worker or Carton code prints unconditionally at startup either (every `console.warn` I found is
  conditional). So these runs give **no positive control**: they cannot tell "no show wait reached 500 ms" apart from "the
  pipe or log path drops lines". **The runs cannot confirm that the logging path works.** Confidence: **high** for this
  conclusion.
- One firm inference does follow from the code. A `shown` answer means cb's whole `showOnHolder` call took under 2000 ms:
  it has a single 2000 ms deadline, the holder gets `left − 50` ms, and a timeout comes back as `later`
  (`carton/packages/local/src/client.ts` l.127–146). So for slow Carton-on applies with an excess above ~2 s (the ~5 s, 9.5 s
  and 11 s ones), at least `excess − 2 s` was spent **outside** the read-your-writes wait. The `onSlowShow` hook does not
  instrument that time. In the Carton-off slow trips there is no show wait at all, yet they show the same kind of extra time.
  Confidence: **high** for the bound. Where the time actually went is **unknown**.

## 3. Do the slow applies cluster?

Apply durations of the slow trips (ms, sorted):

- **on W1 (7):** 3013, 3027, 3034, 3480, 5064, 6609, 9489
- **on W4 (100):** 48 between 2813 and 3112, then 3174, 3224, 3250, 3302, 3478; 6 between 4431 and 4596; 40 between 4872
  and 5111; then 5353, 5492, 11000
- **off W1 (4):** 4030, 10882, 10899, 10915
- **off W4 (17):** 2849, 2927, 3039, 3097, then 13 between 10902 and 11235 (12 of them in 10902–11020)

Measured as excess over the baseline apply, they sit near **+2 s** (on: 1826–2125 for ~46 trips; off: 1965–2213 for 4),
near **+4 s** (on only: 3885–4124 for ~40, plus 3444–3609 for 6), and near **+10 s** (off: 9849–10136 for 15, and 10351;
on: 10013 once, 8438 once).

What this suggests:
- The added delay comes in a few narrow, almost whole-second steps, not a smear. That looks like fixed waits, timeouts or
  retry intervals stacked on a normal ~1 s apply, more than gradual CPU or disk contention.
- The ~+10 s stall shows up on **both** sides: 16 off, 2 on.
- The ~+2 s step also shows up on **both** sides, though mostly on: 4 off vs ~51 on.
- The ~+4 s step is **on only**.
- The long ~11 s stalls are **per-process, not a frozen app or machine.** In off-w4-r5, each 11 s apply overlapped 11–20
  other writers' applies that finished normally (~1.1–1.3 s). In off-w4-r1, two stalls started 26 ms apart and ended 2 ms
  apart while the other writers carried on normally.
- For Carton on at W4, 39 of the 99 slow applies under 8 s ended within 100 ms of another writer's slow apply. Many of them
  are released together, which fits a shared wait. It doesn't prove one.

What it does not suggest or show:
- It doesn't show which timer or step is involved. Nothing in these files names it.
- **The ~+2 s step should not be put down to the 2 s read-your-writes wait.** Those answers were `shown`, not `later`. A
  full-budget wait that still answered `shown` would have been ≥500 ms and should have logged, if the path works. And the
  Carton-off side, which has no such wait, has the same step.
- Neither the network nor any other cause is supported by this data.

Confidence: the clusters themselves, **high**. Any cause, **none established**.

## 4. Periods when both sides were slow

**Main window: runs 16–18, 09:59:36–10:04:03 local (04:29:29–04:34:07 UTC).**
- off-w1-r4: two ~10.9 s stalls; median 1617.5, the highest W1-off median; 26 applies, the fewest.
- on-w4-r5: **every one** of its 51 trips was ≥3 s, mostly ~5.0 s applies; median 5264.
- off-w4-r5: 11 stalls of ~11 s spread across the whole minute; median 1468; 92 applies.
- The W1 r5 pair that ran straight afterwards (runs 19–20) was normal.

**Milder earlier window: runs 2–4, 09:40:20–09:43:01 local.** One ~10–11 s stall in each of off-w4-r1 (two at once),
off-w1-r1 and on-w1-r1.

**Is there a machine or network state behind it?** These runs can't name one. The gate only checked mains, free disk, that
no other Cardboard was running, and keyboard/mouse idle. It recorded no CPU, disk, network, antivirus or update activity.
- The pattern is consistent with an outside cause that changes over time: both sides are affected, the runs are contiguous,
  and the ~10 s stalls hit single processes while the others carry on.
- But the two sides in the main window are slow in **different shapes**: Carton on gets ~5 s on every trip, Carton off gets
  ~11 s now and then. So "one state hit both" is **not established**. It may be two different things that happened in the
  same few minutes.

**How it biases the on/off comparison.**
- The window landed on the whole of on-w4-r5, where on ran first. That run supplies 51 of on/W4's 100 trips ≥3 s, 38 of its
  44 trips ≥5 s, and most of its pooled p95 (5188).
- On the off side it supplies 11 of off/W4's 13 trips ≥5 s, and 2 of off/W1's 3.
- So it inflates the tails and counts of **both** sides, on/W4 most of all. Medians barely move.
- The comparison isn't biased in one direction, but it is much noisier in the tails.

**The comparison with and without the window** (whole pairs dropped, so the order stays balanced):

| W | side | all 24: med of meds / pooled med / p95 / ≥3s / ≥5s | B: without the W4 r5 pair | C: without the W4 r5 and W1 r4 pairs (the 10:00–10:04 window) |
|---|---|---|---|---|
| 1 | on | 1356.8 / 1374.5 / 2044 / 7 / 3 | (unchanged) | 1377 / 1386 / 2044 / 6 / 3 |
| 1 | off | 1241.3 / 1293 / 1841 / 4 / 3 | (unchanged) | 1241 / 1254 / 1809 / 2 / 1 |
| 4 | on | 1359.8 / 1370 / 5188 / 100 / 44 | 1348.5 / 1353 / 3261 / 49 / 6 | same as B |
| 4 | off | 1200.8 / 1215 / 1736 / 17 / 13 | 1186 / 1174.5 / 1681 / 6 / 2 | same as B |

`out2.txt` also has cut D, which drops every pair with a ~10–11 s stall on either side. In it, W4 shows 49 trips ≥3 s for on
vs 1 for off, and W1 shows 4 vs 0.

**What survives every cut.**
- The on side's extra **~3 s and ~5 s** trips at W=4 don't come from the shared window: on-w4-r2, r3 and r6 had 20, 12 and
  16 such trips, while their off partners, run within ~90 s of them, had 0, 0 and 1.
- The on side's median is ~100–260 ms higher in every W4 pair.
- So in these runs, with or without the slow window, Carton on has the slower median and the heavier 3–5 s tail.

Confidence: **high** that the window exists and for the numbers. **Low** on its cause.

## 5. Method

**Balance: good.** The order alternates within each pair, and the W1 pairs start opposite to the W4 ones. Each side went
first in 3 of 6 pairs at each writer count, which I checked against `timing.log`. All 24 runs are marked `clean`. No run
waited for battery or for another Cardboard. The idle gate waited twice, both before the first run.

**The idle gate is input idle, not machine rest.**
- `idle.ps1` measures time since the last keyboard or mouse input. After the first run, **every run started 1–2 s after the
  previous run's end mark**, which is right after the previous app was killed (`taskkill /T /F`). Input idleness had already
  piled up across runs, so the gate always passed at once.
- So "started only after 2 idle minutes" holds for user input. The runs were still back to back, with the previous app's
  exit, profile deletion and the new profile's setup just before each one.
- Mains was checked only at the start of each run, and the result wasn't logged.

**Each run starts on a freshly launched app.** Writes begin 10.6–11.6 s after `app.start`. Several Carton-on slow trips are
edit #1 or #2: on-w4-r5 (all 4 writers), on-w4-r6 (3 writers), on-w4-r2, on-w1-r1 and on-w1-r2. Start-up may add to the
on side's tail. I'm noting this, not claiming it.

**Sample sizes.**
- The test is closed-loop. No writer reaches 1 apply/s: each waits for its own trip, which takes ~1.2–1.4 s. A W=1 run
  managed 26–50 applies in 60 s, not 60.
- Slower runs and sides yield fewer samples (W4: 834 on vs 1028 off). The pooled statistics therefore give slow periods less
  weight per minute of wall time. The median of run medians doesn't have that problem.
- Six pairs is enough for the medians. It is **not** enough for tail counts or p95: one run (on-w4-r5) holds half of
  on/W4's ≥3 s trips, and at W1 a per-run p95 is the 2nd- or 3rd-largest trip.

**`lost` doesn't compare like with like.**
- All 8 lost rows are off/W4. In every one, that writer's last apply ended 0–33 ms before the run's last trip ended, and the
  file held the size from 1–2 edits earlier.
- writers.js reads `timeline.tsx` **once, right after the run ends**. With Carton off nothing waits for the file (`timeline`
  is null). With Carton on, the apply returns only after `shown`.
- So the off-side "lost" rows may be the file lagging behind rather than real lost updates. These files can't tell the two
  apart. And Carton on scores 0 by construction.

**What I'd re-run or change before trusting the diagnosis.**
1. **A positive control for the worker log.** Run once with a known slow show, or a lowered `slowShowMs`, and confirm that a
   `[carton] a cb write waited` line reaches `activity-*.jsonl`. Without it, (c) can't be answered.
2. **Time the inside of the apply,** since that's where the extra seconds are and at least part of them sit outside the show
   wait: cb's spawn to commit, the lease read and ping (`timelineWorker`), `showOnHolder`, then exit.
3. **Real rest between runs** (for example 2 minutes after the previous app exits), and record CPU, disk and network per run,
   so a slow window can be identified instead of inferred.
4. **Re-run at least the W4 r5 and W1 r4 pairs.** Better, run ≥10 pairs per writer count before quoting tail counts or p95.
5. **For `lost`, let the file settle or poll for it** before the final read, to separate a lag from a lost update.

## Appendix A: every trip ≥3 s

Columns: start is local time; `ms-p-a` = ms − print − apply; "extra" = the value minus the side/W baseline above; "worker"
= `ev:"worker"` lines in that run's activity log within [start − 2 s, start + ms + 5 s].

| run | writer | edit | start (local) | ms | print | apply | ms-p-a | extra print | extra apply | holder | timeline | worker line in [start-2s, end+5s] |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off-w4-r1 | W3 | 31 | 09:40:20.902 | 11320 | 301 | 11018 | 1 | 7 | 10134 | apply | null | 0 |
| off-w4-r1 | W1 | 29 | 09:40:20.928 | 11318 | 297 | 11020 | 1 | 3 | 10136 | apply | null | 0 |
| off-w4-r1 | W2 | 34 | 09:40:26.192 | 3184 | 256 | 2927 | 1 | -38 | 2043 | apply | null | 0 |
| off-w4-r1 | W1 | 36 | 09:40:39.727 | 3391 | 293 | 3097 | 1 | -1 | 2213 | apply | null | 0 |
| off-w4-r1 | W4 | 45 | 09:40:39.757 | 3330 | 290 | 3039 | 1 | -4 | 2155 | apply | null | 0 |
| off-w1-r1 | W1 | 20 | 09:41:36.380 | 4292 | 262 | 4030 | 0 | 8 | 2997 | apply | null | 0 |
| off-w1-r1 | W1 | 22 | 09:41:42.082 | 11164 | 264 | 10899 | 1 | 10 | 9866 | apply | null | 0 |
| on-w1-r1 | W1 | 2 | 09:42:37.155 | 3294 | 281 | 3013 | 0 | -4 | 1962 | apply | shown | 0 |
| on-w1-r1 | W1 | 18 | 09:43:01.256 | 10114 | 625 | 9489 | 0 | 340 | 8438 | apply | shown | 0 |
| on-w4-r2 | W4 | 2 | 09:45:29.815 | 3249 | 294 | 2954 | 1 | -41 | 1967 | apply | shown | 0 |
| on-w4-r2 | W2 | 4 | 09:45:32.591 | 5484 | 451 | 5032 | 1 | 116 | 4045 | apply | shown | 0 |
| on-w4-r2 | W3 | 9 | 09:45:40.102 | 3278 | 332 | 2945 | 1 | -3 | 1958 | apply | shown | 0 |
| on-w4-r2 | W1 | 11 | 09:45:42.537 | 3564 | 313 | 3250 | 1 | -22 | 2263 | apply | shown | 0 |
| on-w4-r2 | W2 | 9 | 09:45:43.519 | 3258 | 317 | 2940 | 1 | -18 | 1953 | apply | shown | 0 |
| on-w4-r2 | W2 | 11 | 09:45:48.156 | 4910 | 397 | 4513 | 0 | 62 | 3526 | apply | shown | 0 |
| on-w4-r2 | W4 | 15 | 09:45:48.528 | 3257 | 290 | 2966 | 1 | -45 | 1979 | apply | shown | 0 |
| on-w4-r2 | W3 | 15 | 09:45:50.437 | 3257 | 285 | 2971 | 1 | -50 | 1984 | apply | shown | 0 |
| on-w4-r2 | W1 | 16 | 09:45:51.474 | 3368 | 342 | 3025 | 1 | 7 | 2038 | apply | shown | 0 |
| on-w4-r2 | W3 | 19 | 09:45:57.354 | 3284 | 338 | 2945 | 1 | 3 | 1958 | apply | shown | 0 |
| on-w4-r2 | W1 | 20 | 09:45:58.560 | 3794 | 316 | 3478 | 0 | -19 | 2491 | apply | shown | 0 |
| on-w4-r2 | W4 | 26 | 09:46:05.445 | 3382 | 367 | 3014 | 1 | 32 | 2027 | apply | shown | 0 |
| on-w4-r2 | W4 | 29 | 09:46:11.264 | 3332 | 354 | 2977 | 1 | 19 | 1990 | apply | shown | 0 |
| on-w4-r2 | W1 | 29 | 09:46:13.783 | 3758 | 736 | 3021 | 1 | 401 | 2034 | apply | shown | 0 |
| on-w4-r2 | W4 | 32 | 09:46:17.043 | 3245 | 318 | 2926 | 1 | -17 | 1939 | apply | shown | 0 |
| on-w4-r2 | W1 | 32 | 09:46:20.146 | 3375 | 356 | 3018 | 1 | 21 | 2031 | apply | shown | 0 |
| on-w4-r2 | W2 | 32 | 09:46:20.347 | 5332 | 338 | 4993 | 1 | 3 | 4006 | apply | shown | 0 |
| on-w4-r2 | W1 | 35 | 09:46:26.085 | 3282 | 300 | 2981 | 1 | -35 | 1994 | apply | shown | 0 |
| on-w4-r2 | W4 | 39 | 09:46:27.954 | 4920 | 324 | 4596 | 0 | -11 | 3609 | apply | shown | 0 |
| on-w4-r2 | W3 | 40 | 09:46:28.034 | 4840 | 320 | 4519 | 1 | -15 | 3532 | apply | shown | 0 |
| on-w1-r2 | W1 | 2 | 09:46:59.399 | 3293 | 266 | 3027 | 0 | -19 | 1976 | apply | shown | 0 |
| on-w1-r2 | W1 | 10 | 09:47:12.824 | 6892 | 281 | 6609 | 2 | -4 | 5558 | apply | shown | 0 |
| on-w1-r2 | W1 | 14 | 09:47:24.213 | 3769 | 287 | 3480 | 2 | 2 | 2429 | apply | shown | 0 |
| on-w1-r2 | W1 | 34 | 09:47:56.363 | 5348 | 283 | 5064 | 1 | -2 | 4013 | apply | shown | 0 |
| on-w4-r3 | W1 | 8 | 09:49:58.537 | 3354 | 344 | 3009 | 1 | 9 | 2022 | apply | shown | 0 |
| on-w4-r3 | W1 | 9 | 09:50:01.891 | 3190 | 294 | 2895 | 1 | -41 | 1908 | apply | shown | 0 |
| on-w4-r3 | W2 | 12 | 09:50:03.908 | 3439 | 326 | 3112 | 1 | -9 | 2125 | apply | shown | 0 |
| on-w4-r3 | W2 | 16 | 09:50:11.625 | 3793 | 695 | 3098 | 0 | 360 | 2111 | apply | shown | 0 |
| on-w4-r3 | W1 | 16 | 09:50:13.272 | 3352 | 325 | 3026 | 1 | -10 | 2039 | apply | shown | 0 |
| on-w4-r3 | W3 | 19 | 09:50:13.302 | 3353 | 324 | 3028 | 1 | -11 | 2041 | apply | shown | 0 |
| on-w4-r3 | W1 | 18 | 09:50:18.149 | 4073 | 771 | 3302 | 0 | 436 | 2315 | apply | shown | 0 |
| on-w4-r3 | W4 | 26 | 09:50:23.116 | 3261 | 304 | 2955 | 2 | -31 | 1968 | apply | shown | 0 |
| on-w4-r3 | W2 | 26 | 09:50:29.667 | 3873 | 787 | 3086 | 0 | 452 | 2099 | apply | shown | 0 |
| on-w4-r3 | W4 | 29 | 09:50:29.717 | 5305 | 789 | 4515 | 1 | 454 | 3528 | apply | shown | 0 |
| on-w4-r3 | W4 | 30 | 09:50:35.022 | 3247 | 294 | 2951 | 2 | -41 | 1964 | apply | shown | 0 |
| on-w4-r3 | W2 | 34 | 09:50:44.479 | 3489 | 314 | 3174 | 1 | -21 | 2187 | apply | shown | 0 |
| on-w4-r4 | W1 | 7 | 09:57:03.636 | 3272 | 350 | 2921 | 1 | 15 | 1934 | apply | shown | 0 |
| on-w1-r4 | W1 | 41 | 09:59:15.103 | 3314 | 279 | 3034 | 1 | -6 | 1983 | apply | shown | 0 |
| off-w1-r4 | W1 | 17 | 10:00:12.948 | 11145 | 262 | 10882 | 1 | 8 | 9849 | apply | null | 0 |
| off-w1-r4 | W1 | 25 | 10:00:35.200 | 11166 | 250 | 10915 | 1 | -4 | 9882 | apply | null | 0 |
| on-w4-r5 | W1 | 1 | 10:01:30.517 | 5373 | 346 | 5026 | 1 | 11 | 4039 | apply | shown | 0 |
| on-w4-r5 | W2 | 1 | 10:01:30.530 | 11385 | 384 | 11000 | 1 | 49 | 10013 | apply | shown | 0 |
| on-w4-r5 | W3 | 1 | 10:01:30.540 | 5320 | 339 | 4981 | 0 | 4 | 3994 | apply | shown | 0 |
| on-w4-r5 | W4 | 1 | 10:01:30.550 | 5375 | 347 | 5028 | 0 | 12 | 4041 | apply | shown | 0 |
| on-w4-r5 | W3 | 2 | 10:01:35.860 | 5456 | 345 | 5111 | 0 | 10 | 4124 | apply | shown | 0 |
| on-w4-r5 | W1 | 2 | 10:01:35.890 | 5389 | 383 | 5005 | 1 | 48 | 4018 | apply | shown | 0 |
| on-w4-r5 | W4 | 2 | 10:01:35.925 | 5426 | 314 | 5111 | 1 | -21 | 4124 | apply | shown | 0 |
| on-w4-r5 | W1 | 3 | 10:01:41.279 | 5321 | 333 | 4987 | 1 | -2 | 4000 | apply | shown | 0 |
| on-w4-r5 | W3 | 3 | 10:01:41.316 | 5318 | 325 | 4992 | 1 | -10 | 4005 | apply | shown | 0 |
| on-w4-r5 | W4 | 3 | 10:01:41.351 | 5374 | 325 | 5048 | 1 | -10 | 4061 | apply | shown | 0 |
| on-w4-r5 | W2 | 2 | 10:01:41.915 | 5297 | 291 | 5005 | 1 | -44 | 4018 | apply | shown | 0 |
| on-w4-r5 | W1 | 4 | 10:01:46.600 | 5260 | 323 | 4936 | 1 | -12 | 3949 | apply | shown | 0 |
| on-w4-r5 | W3 | 4 | 10:01:46.634 | 5316 | 321 | 4994 | 1 | -14 | 4007 | apply | shown | 0 |
| on-w4-r5 | W4 | 4 | 10:01:46.725 | 3228 | 295 | 2932 | 1 | -40 | 1945 | apply | shown | 0 |
| on-w4-r5 | W2 | 3 | 10:01:47.212 | 5218 | 273 | 4944 | 1 | -62 | 3957 | apply | shown | 0 |
| on-w4-r5 | W4 | 5 | 10:01:49.953 | 3109 | 296 | 2813 | 0 | -39 | 1826 | apply | shown | 0 |
| on-w4-r5 | W1 | 5 | 10:01:51.860 | 5250 | 304 | 4946 | 0 | -31 | 3959 | apply | shown | 0 |
| on-w4-r5 | W3 | 5 | 10:01:51.950 | 3219 | 284 | 2933 | 2 | -51 | 1946 | apply | shown | 0 |
| on-w4-r5 | W2 | 4 | 10:01:52.430 | 5204 | 280 | 4923 | 1 | -55 | 3936 | apply | shown | 0 |
| on-w4-r5 | W4 | 6 | 10:01:53.062 | 5388 | 285 | 5102 | 1 | -50 | 4115 | apply | shown | 0 |
| on-w4-r5 | W3 | 6 | 10:01:55.169 | 3302 | 281 | 3019 | 2 | -54 | 2032 | apply | shown | 0 |
| on-w4-r5 | W1 | 6 | 10:01:57.111 | 5153 | 280 | 4872 | 1 | -55 | 3885 | apply | shown | 0 |
| on-w4-r5 | W2 | 5 | 10:01:57.634 | 5188 | 272 | 4914 | 2 | -63 | 3927 | apply | shown | 0 |
| on-w4-r5 | W4 | 7 | 10:01:58.450 | 3195 | 323 | 2871 | 1 | -12 | 1884 | apply | shown | 0 |
| on-w4-r5 | W3 | 7 | 10:01:58.471 | 3267 | 365 | 2901 | 1 | 30 | 1914 | apply | shown | 0 |
| on-w4-r5 | W4 | 8 | 10:02:01.645 | 3177 | 328 | 2848 | 1 | -7 | 1861 | apply | shown | 0 |
| on-w4-r5 | W3 | 8 | 10:02:01.738 | 3170 | 292 | 2877 | 1 | -43 | 1890 | apply | shown | 0 |
| on-w4-r5 | W1 | 7 | 10:02:02.264 | 5635 | 281 | 5353 | 1 | -54 | 4366 | apply | shown | 0 |
| on-w4-r5 | W2 | 6 | 10:02:02.822 | 5188 | 252 | 4934 | 2 | -83 | 3947 | apply | shown | 0 |
| on-w4-r5 | W4 | 9 | 10:02:04.822 | 3209 | 292 | 2915 | 2 | -43 | 1928 | apply | shown | 0 |
| on-w4-r5 | W3 | 9 | 10:02:04.908 | 3201 | 295 | 2905 | 1 | -40 | 1918 | apply | shown | 0 |
| on-w4-r5 | W1 | 8 | 10:02:07.899 | 5331 | 341 | 4989 | 1 | 6 | 4002 | apply | shown | 0 |
| on-w4-r5 | W2 | 7 | 10:02:08.010 | 5308 | 341 | 4966 | 1 | 6 | 3979 | apply | shown | 0 |
| on-w4-r5 | W4 | 10 | 10:02:08.031 | 3344 | 348 | 2996 | 0 | 13 | 2009 | apply | shown | 0 |
| on-w4-r5 | W3 | 10 | 10:02:08.109 | 5264 | 327 | 4937 | 0 | -8 | 3950 | apply | shown | 0 |
| on-w4-r5 | W4 | 11 | 10:02:11.375 | 5331 | 312 | 5019 | 0 | -23 | 4032 | apply | shown | 0 |
| on-w4-r5 | W1 | 9 | 10:02:13.230 | 5268 | 291 | 4976 | 1 | -44 | 3989 | apply | shown | 0 |
| on-w4-r5 | W2 | 8 | 10:02:13.318 | 5301 | 303 | 4996 | 2 | -32 | 4009 | apply | shown | 0 |
| on-w4-r5 | W3 | 11 | 10:02:13.373 | 5220 | 315 | 4904 | 1 | -20 | 3917 | apply | shown | 0 |
| on-w4-r5 | W4 | 12 | 10:02:16.706 | 5280 | 272 | 5007 | 1 | -63 | 4020 | apply | shown | 0 |
| on-w4-r5 | W1 | 10 | 10:02:18.498 | 5387 | 297 | 5089 | 1 | -38 | 4102 | apply | shown | 0 |
| on-w4-r5 | W3 | 12 | 10:02:18.593 | 5385 | 303 | 5081 | 1 | -32 | 4094 | apply | shown | 0 |
| on-w4-r5 | W2 | 9 | 10:02:18.619 | 5391 | 307 | 5083 | 1 | -28 | 4096 | apply | shown | 0 |
| on-w4-r5 | W4 | 13 | 10:02:21.986 | 5287 | 310 | 4976 | 1 | -25 | 3989 | apply | shown | 0 |
| on-w4-r5 | W1 | 11 | 10:02:23.885 | 5307 | 287 | 5019 | 1 | -48 | 4032 | apply | shown | 0 |
| on-w4-r5 | W3 | 13 | 10:02:23.978 | 3227 | 323 | 2903 | 1 | -12 | 1916 | apply | shown | 0 |
| on-w4-r5 | W2 | 10 | 10:02:24.010 | 3289 | 319 | 2969 | 1 | -16 | 1982 | apply | shown | 0 |
| on-w4-r5 | W3 | 14 | 10:02:27.205 | 5262 | 305 | 4956 | 1 | -30 | 3969 | apply | shown | 0 |
| on-w4-r5 | W4 | 14 | 10:02:27.273 | 5219 | 304 | 4914 | 1 | -31 | 3927 | apply | shown | 0 |
| on-w4-r5 | W2 | 11 | 10:02:27.299 | 5247 | 312 | 4934 | 1 | -23 | 3947 | apply | shown | 0 |
| on-w4-r5 | W1 | 12 | 10:02:29.192 | 5209 | 283 | 4924 | 2 | -52 | 3937 | apply | shown | 0 |
| off-w4-r5 | W1 | 3 | 10:03:01.511 | 11243 | 295 | 10947 | 1 | 1 | 10063 | apply | null | 0 |
| off-w4-r5 | W3 | 4 | 10:03:02.835 | 11306 | 329 | 10976 | 1 | 35 | 10092 | apply | null | 0 |
| off-w4-r5 | W2 | 6 | 10:03:05.745 | 11244 | 275 | 10968 | 1 | -19 | 10084 | apply | null | 0 |
| off-w4-r5 | W1 | 4 | 10:03:12.754 | 11476 | 240 | 11235 | 1 | -54 | 10351 | apply | null | 0 |
| off-w4-r5 | W3 | 7 | 10:03:17.179 | 11212 | 275 | 10936 | 1 | -19 | 10052 | apply | null | 0 |
| off-w4-r5 | W2 | 12 | 10:03:24.270 | 11164 | 261 | 10902 | 1 | -33 | 10018 | apply | null | 0 |
| off-w4-r5 | W4 | 22 | 10:03:30.094 | 11207 | 279 | 10926 | 2 | -15 | 10042 | apply | null | 0 |
| off-w4-r5 | W3 | 15 | 10:03:38.212 | 11276 | 310 | 10965 | 1 | 16 | 10081 | apply | null | 0 |
| off-w4-r5 | W2 | 18 | 10:03:42.836 | 11224 | 276 | 10947 | 1 | -18 | 10063 | apply | null | 0 |
| off-w4-r5 | W1 | 20 | 10:03:45.888 | 11216 | 275 | 10940 | 1 | -19 | 10056 | apply | null | 0 |
| off-w4-r5 | W4 | 29 | 10:03:51.047 | 11203 | 268 | 10934 | 1 | -26 | 10050 | apply | null | 0 |
| off-w4-r6 | W4 | 3 | 10:07:26.997 | 3162 | 313 | 2849 | 0 | 19 | 1965 | apply | null | 0 |
| on-w4-r6 | W1 | 1 | 10:08:50.485 | 5849 | 356 | 5492 | 1 | 21 | 4505 | apply | shown | 0 |
| on-w4-r6 | W3 | 1 | 10:08:50.512 | 3315 | 376 | 2938 | 1 | 41 | 1951 | apply | shown | 0 |
| on-w4-r6 | W4 | 1 | 10:08:50.524 | 3453 | 348 | 3104 | 1 | 13 | 2117 | apply | shown | 0 |
| on-w4-r6 | W1 | 4 | 10:08:58.790 | 3165 | 297 | 2867 | 1 | -38 | 1880 | apply | shown | 0 |
| on-w4-r6 | W4 | 7 | 10:09:00.850 | 3295 | 306 | 2987 | 2 | -29 | 2000 | apply | shown | 0 |
| on-w4-r6 | W3 | 11 | 10:09:06.822 | 3278 | 298 | 2979 | 1 | -37 | 1992 | apply | shown | 0 |
| on-w4-r6 | W4 | 10 | 10:09:07.407 | 3171 | 296 | 2875 | 0 | -39 | 1888 | apply | shown | 0 |
| on-w4-r6 | W3 | 15 | 10:09:14.569 | 5359 | 372 | 4986 | 1 | 37 | 3999 | apply | shown | 0 |
| on-w4-r6 | W2 | 18 | 10:09:14.663 | 3309 | 339 | 2970 | 0 | 4 | 1983 | apply | shown | 0 |
| on-w4-r6 | W2 | 24 | 10:09:25.708 | 5344 | 351 | 4992 | 1 | 16 | 4005 | apply | shown | 0 |
| on-w4-r6 | W1 | 24 | 10:09:28.171 | 3325 | 337 | 2987 | 1 | 2 | 2000 | apply | shown | 0 |
| on-w4-r6 | W2 | 26 | 10:09:32.331 | 3606 | 382 | 3224 | 0 | 47 | 2237 | apply | shown | 0 |
| on-w4-r6 | W3 | 26 | 10:09:33.628 | 4735 | 303 | 4431 | 1 | -32 | 3444 | apply | shown | 0 |
| on-w4-r6 | W1 | 30 | 10:09:38.581 | 3324 | 344 | 2979 | 1 | 9 | 1992 | apply | shown | 0 |
| on-w4-r6 | W4 | 36 | 10:09:44.216 | 3351 | 361 | 2989 | 1 | 26 | 2002 | apply | shown | 0 |
| on-w4-r6 | W3 | 33 | 10:09:46.762 | 4787 | 304 | 4482 | 1 | -31 | 3495 | apply | shown | 0 |


## Appendix B: the sensitivity cuts and checks

See `out2.txt` (cuts C and D, slow trips by apply cluster per run, overlap of long stalls, applies per writer, the lost rows, gaps between runs) and `out.txt` (10 s time series per run, apply histograms).

---

# Phase 2: comparison with the other agent (`p8-sum.js` → `summary-mine.txt`)

I read both files only after the phase 1 report above was written. The comparison is done by `compare.js`, in this
folder: it parses `summary-mine.txt` and checks it field by field against my recount of the raw files.

## Method differences, and whether they matter

| | other agent | me | effect here |
|---|---|---|---|
| Per-run sample set | applied samples only | every sample | none: all 2359 samples are `applied` |
| Median | middle value; mean of the two middle values for even n | same | none |
| p90/p95 | nearest rank | nearest rank (the lin variant shown separately) | none |
| "Held by" | `apply >= print` | the bigger excess over that side and writer count's median print/apply for trips under 3 s | same answer (apply) for all 128, but see claim 1 |
| Worker-line window | [start − 200 ms, start + ms + 1 s], `waited` lines only | [start − 2 s, start + ms + 5 s], any `ev:"worker"` | none: there are 0 worker lines anywhere |

## Number by number

- **Per-run rows (24 × 10 fields):** edits, applied, failed, lost, median, p90, p95, max, ≥3 s and ≥5 s. **0 differences.**
- **Group rows (4):** the run medians, the median of run medians, the pooled median/p90/p95, the per-run p95 list, ≥3 s (of n),
  ≥5 s and the applies per run. **0 differences.** My phase 1 tables printed the medians of run medians to one decimal
  (1356.8, 1241.3, 1359.8, 1200.8). The exact values, as both scripts compute them, are **1356.75, 1241.25, 1359.75,
  1200.75**. That's rounding only.
- **Slow trips:** the same 128 (writer, edit, ms, print, apply) on both sides, with nothing only in one list. The timeline
  answer is the same for all 128. Both find 0 worker lines.

## The claims to be reported

1. **"All 128 trips ≥3 s were held by the apply"** holds, but tighten the wording. Their test, `apply >= print`, is true of
   almost every trip, slow or not: the per-run median apply is 815–1366.5 ms, and the median print 253–345 ms. So on its own it doesn't
   show where the *extra* time went. The raw values do. Across the 128 slow trips the apply took 2813–11235 ms and the
   print 240–789 ms. My baseline comparison puts every slow trip's extra time in the apply (apply excess ≥1826 ms, print
   excess ≤454 ms); that comparison is mine alone so far. Say: "In all 128 trips of 3 s or more the extra time was in the
   apply, not the print." Don't say "held" without that sentence behind it.
   **"Every slow Carton-on trip answered `shown`, never `later`"** holds: 107 of 107.
   **"No `[carton] a cb write waited` worker line appeared in any run"** holds, but on its own it is misleading. **No
   `ev:"worker"` line of any kind** appeared in any of the 24 logs, on either side, so the pipe was never shown working.
   Report it as: "no worker line of any kind reached the activity log in any of the 24 runs, so these runs can't tell
   whether that logging works, and the missing lines say nothing about how long the read-your-writes waits took."
2. **The clusters.**
   - "Carton on mostly **2.9–3.5 s (55)**" is **wrong as written**: the label and the count don't match. 2.9–3.5 s holds
     48 applies. **55 is the count for 2.8–3.5 s.** The 7 between are 2813, 2848, 2867, 2871, 2875, 2877 and 2895 ms, all
     at 4 writers. Trip `ms` in 2.9–3.5 s gives 47, not 55 either. So the count was made with a 2.8 s lower bound and
     labelled 2.9. Use "2.8–3.5 s (55)" or "2.9–3.5 s (48)".
   - "**4.8–5.7 s (43)**" holds (1 at 1 writer, 42 at 4 writers).
   - "Carton off mostly **10–11.5 s (16)**" holds (3 at 1 writer, 13 at 4; the range is 10882–11235).
   - Both "Carton on" counts pool the 1- and 4-writer runs; say so. The 9 Carton-on slow applies outside both bands are
     4431, 4482, 4513, 4515, 4519, 4596, 6609, 9489 and 11000. The 5 Carton-off ones are 2849, 2927, 3039, 3097 and 4030.
   - No cause may be attached.
3. **"The 4-writer r5 pair was slow on both sides"** holds, with three qualifications:
   - **Different shapes.** on-w4-r5 was slow on every trip: 51 of 51 ≥3 s, median 5264. off-w4-r5 had 11 slow trips
     (11164–11476 ms) in an otherwise near-normal run, with median 1468.
   - **The slow stretch is longer than the pair.** off-w1-r4, the run just before, was slow too (two applies ~10.9 s,
     median 1617.5, 26 applies). The stretch covers 3 runs, 09:59:36–10:04:03 local.
   - **Nothing shows a shared cause.** Say "both runs of that pair were slow", not "a slow period affected both sides".
4. **"Medians and tails as in the summary"** holds number for number. When quoting tails, though, also give the per-run
   lists: one run, on-w4-r5, holds 51 of the 100 Carton-on trips ≥3 s at 4 writers, 38 of the 44 ≥5 s, and most of its
   pooled p95 (5188).

## The two setup facts

**1. The onboarding helper failed, so no first-run screens were clicked through.** I can't see the broken file:
`D:\cbbench\build\onboard.js` was last written at 10:14:22 local, after the last run. I'm relying on the stated fact.
- **On vs off within this round:** both sides ran in the same state (fresh profile, first run not completed), so the
  comparison stays like for like on that axis. No number in this round has to change.
- **What's not established for each run:** that the editor page was actually open. lat8.sh waits up to 20 s for the
  `app/editor/<id>` page and then carries on whether or not it appeared, and it records nothing. The other agent's later
  check, one fresh profile of the same build, makes it likely but isn't evidence for each run.
  - For Carton on there is indirect evidence: all 1080 applies (my count) were answered `shown` by the worker's timeline
    view, so the library worker had the project open, with its view running, throughout each Carton-on run.
  - For Carton off there is no such evidence.
- **Whether onboarding leaves background work** that changes timings is unknown.
- **How to quote:** say the setup was "a fresh profile with first-run onboarding not completed, the project opened by `cb
  project open`". Don't put these numbers next to earlier rounds' as before/after, or as the same test.
- The failure was silent: lat8.sh sends the helper's output to /dev/null and checks neither its exit code nor the editor
  wait. Fix both before the next round.

**2. A new clip and new profiles.**
- The clip at `D:\cbwork\carton\media\clip.mp4` is 20.0 s, h264 1280×720 at 30 fps, plus AAC at 48 kHz. Its mtime is
  09:34:11 local, before the first run's `app.start` at 09:38:08, and nothing rewrote it during the round. I checked with
  the build's ffprobe, read-only.
- Each run already built a fresh profile from that one clip (lat8.sh `setup`), so the media were the same for all 24 runs
  and both sides. **The on vs off comparison within this round is unaffected.**
- Across rounds, the media and the first-run state both differ, so **absolute numbers can't be compared with earlier rounds'**
  (for example Update 6b).
- Whether the clip affects the timed part (proxy, thumbnail or waveform work in the app while the writers run) is unknown.

## Safe to quote

These were computed independently by both agents with no differences, unless a line says otherwise. Quote them with this
setup sentence:

> Timing B (Update 8): build 66ee2f3f (`out/carton-prod6`), Carton on vs Carton off, on the same laptop on mains. An
> agent's `cb source print` + `cb source apply` round trip, with the app open, the project opened by `cb project open`
> and nobody editing. Fresh test profile each run, first-run onboarding not completed, a 20 s generated test clip. 60 s
> per run, closed loop: each writer starts its next edit when the last one ends, at most once a second. 6 alternated
> pairs at 1 writer and 6 at 4 writers, 24 runs, all marked clean. Not comparable with earlier rounds.

1. "Median round trip, median of the 6 run medians:
   - 1 writer: Carton on **1356.75 ms** (runs 1377, 1460, 1418, 1310, 1316, 1336.5); Carton off **1241.25 ms** (1404, 1241,
     1239, 1617.5, 1241.5, 1207).
   - 4 writers: Carton on **1359.75 ms** (1348.5, 1324, 1388, 1320, 5264, 1371); Carton off **1200.75 ms** (1174, 1186,
     1124, 1215.5, 1468, 1222)."
2. "Pooled over each side's 6 runs, median / p90 / p95 (nearest rank):
   - 1 writer: Carton on **1374.5 / 1684 / 2044 ms** (246 trips); Carton off **1293 / 1679 / 1841 ms** (251 trips).
   - 4 writers: Carton on **1370 / 3257 / 5188 ms** (834 trips); Carton off **1215 / 1599 / 1736 ms** (1028 trips)."
3. "Per-run p95 (ms), r1–r6:
   - 1 writer: on 3294, 5348, 2013, 1750, 1564, 1642; off 4292, 1809, 1760, 11145, 1856, 1538.
   - 4 writers: on 2158, 3564, 3353, 1891, 5456, 3351; off 1826, 1681, 1618, 1660, 11243, 1629."
4. "Trips of 3 s or more / 5 s or more:
   - 1 writer: Carton on **7 / 3** of 246 (per run 2, 4, 0, 1, 0, 0 / 1, 2, 0, 0, 0, 0); Carton off **4 / 3** of 251
     (2, 0, 0, 2, 0, 0 / 1, 0, 0, 2, 0, 0).
   - 4 writers: Carton on **100 / 44** of 834 (0, 20, 12, 1, 51, 16 / 0, 2, 1, 0, 38, 3); Carton off **17 / 13** of 1028
     (5, 0, 0, 0, 11, 1 / 2, 0, 0, 0, 11, 0)."
5. "Applies per run:
   - 1 writer: on 37, 34, 42, 44, 45, 44; off 35, 47, 47, 26, 46, 50.
   - 4 writers: on 168, 149, 148, 173, 51, 145; off 170, 191, 197, 190, 92, 188.
   No apply failed in any of the 24 runs."
6. "writers.js's end-of-run check flagged 8 writers whose last applied value wasn't in timeline.tsx. All 8 were Carton off
   at 4 writers (r2: 2, r4: 3, r6: 3), and no other run had any. The check reads the file once, right after the last edit,
   and with Carton off nothing waits for the file to be rewritten, so it can't tell a file that hadn't caught up yet from a
   lost update." (Never call these "lost updates" without that sentence.)
7. "In all 128 trips of 3 s or more the extra time was in the apply, not the print: those applies took 2813–11235 ms, their
   prints 240–789 ms."
8. "All 107 slow Carton-on trips got the timeline answer `shown`. None got `later`, so none ran out cb's 2 s wait."
9. "No worker line of any kind reached the activity log in any of the 24 runs. So no slow trip has a matching `[carton] a
   cb write waited` line, and these runs can't show whether that logging works."
10. "The slow applies fall in narrow bands. Carton on, both writer counts, 107: 55 at 2.8–3.5 s, 43 at 4.8–5.7 s, and 9
    others (4431–4596 ms ×6, then 6609, 9489, 11000). Carton off, 21: 16 at 10.9–11.2 s, and 5 others (2849, 2927, 3039,
    3097, 4030). What causes them isn't known."
11. "Both runs of the 4-writer r5 pair were slow, in different ways:
    - Carton on: all 51 trips ≥3 s, median 5264 ms.
    - Carton off: 11 trips of 11.2–11.5 s, median 1468 ms, 92 applies.
    - The run just before, Carton off at 1 writer (r4), was slow too: two trips over 11 s, median 1617.5 ms, 26 applies."

## Do not quote

- **Any cause for the slow applies:** the network, the 2 s read-your-writes wait, machine load, lock contention, start-up,
  "a slow period". Nothing in these files names a step.
- **"No read-your-writes wait reached 500 ms"** or **"the worker logged nothing because nothing was slow"**: the logging
  path has never been shown to work.
- **"The worker logging works"** or **"the diagnostic is in place and confirmed"**: it is present in the build, not
  confirmed working.
- **"Carton off lost 8 updates"** or **"Carton on prevents lost updates"** on the strength of these runs.
- **"2.9–3.5 s (55)":** the label and the count disagree (see claim 2).
- **The pooled 4-writer Carton-on p95 (5188) or ≥3 s count (100)** without the per-run lists. One run holds most of each.
- **"1 apply per second per writer"** as the load that was achieved, and **"each run started after 2 idle minutes"** as
  machine rest. The gate measured keyboard and mouse idle only, and the runs went back to back.
- **Any before/after or "same test" comparison with earlier rounds** (6b and others): the onboarding state and the media
  differ.
- **Any percentage or ratio between on and off** (for example "x % slower"): neither agent computed one, so it would be
  unverified.
- **Not yet independently checked; mine only, so get a second check before quoting:**
  - the cuts without the slow runs (B, C and D in phase 1);
  - the paired on − off run medians ("on slower in 6/6 four-writer pairs");
  - "1080 of 1080 Carton-on applies `shown`";
  - the per-trip excess over the baseline (≥1826 ms apply, ≤454 ms print) and the ~+2/+4/+10 s steps;
  - the overlap and "ended together" counts;
  - the lost rows' timings (0–33 ms) and how many edits behind they were;
  - the slow window's clock times.
