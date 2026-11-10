# Benchmarks

[README](../README.md) · [Windows port](windows-port.md) · [Carton in the app](carton-in-the-app.md) · [Benchmarks](benchmarks.md)

The benchmark kit and every measured table. These sections were the README until 2026-11-10. Measurements
were taken on 1.4.0-based builds unless they say otherwise.

`scripts\bench\` measures builds against each other on one machine, the way someone uses Cardboard. It runs the real
app with a fresh profile and library each run, drives it over DevTools, and times the `cb` CLI that agents use.

To show what this port's speed changes do, it compares two builds:
- **baseline**: Cardboard's own pipeline, as it runs on a Mac. It has only what Windows needs to run it, and leaves
  out the speed changes in the media patches. `build-windows.js --baseline` builds it (`CB_BASELINE=1`). In it:
  - decoding happens on the CPU;
  - filmstrips decode every frame;
  - proxies are made one at a time, by the hardware encoder at Cardboard's bitrate, as VideoToolbox makes them
    on a Mac.
- **ours**: the normal build.

The workflow publishes both: `Cardboard-1.5.0-windows-x64-baseline.exe` unpacks into `Cardboard-baseline\`. The
bugs the patches fix stay fixed in both.

```sh
node scripts/bench/media.js bench-media --ffmpeg Cardboard\resources\bin\ffmpeg.exe
node scripts/bench/run.js --build baseline=Cardboard-baseline --build ours=Cardboard
```

`media.js` makes six clips. They're synthetic, but they have what decides how much work an import is:
- 4K HEVC 10-bit from a phone, in landscape and in portrait (rotated);
- 4K60 H.264 from an action camera;
- a 1080p screen recording with a keyframe every 10 s;
- 1080p HEVC 10-bit;
- a WAV.

`run.js` runs 5 counted runs per build after a warm-up, alternating between the builds. It writes every run and the
medians to `bench-results\<date>\results.md` and `results.json`, together with the machine and the clips.
- **import** drops the clips on a new project, through the event the editor's Import Media sends. It waits until
  nothing has been written to the bundle's `media\`, `cache\`, `proxies\` and `converted\` folders for 15 s. It
  reports when the clips were listed, when the first thumbnail and the last file were written, and what was made.
  What was made must be the same for both builds.
- **cli** times `cb --help`, `project create`, `project list`, `source print` and `source apply` with the app closed.
- **cli-import** imports the same clips through `cb media add`. That runs the CLI's own copy of the import pipeline,
  patched as the app's is, and exits once every thumbnail, waveform and proxy is made. It needs no window and no
  sign-in.

Nothing the benchmarks do spends credits: no generation, transcription, captions, voices, mattes or footage search.
Every profile shares the stored sign-in (`%APPDATA%\ai.cardboard\account.json`), so sign in to Cardboard once
beforehand. Close Cardboard and plug the laptop in first: on battery, Windows slows the CPU and GPU.

## Import, on 1.5.0

Measured on 2026-11-10 on the laptop below (i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11), on mains for the
whole run. `run.js` compared the baseline with ours, both built from `56142f3f` (the 1.5.0 release), with the six
clips of `media.js`: 5 counted runs per build after a warm-up, alternating. Ours is the build people download,
Carton included; the baseline leaves Carton out. Every run made the same files: 315 thumbnails, 6 waveforms, 108 peak
files, 5 proxies and 12 others. The recorded runs and the independent check are in
[benchmarks/2026-11-10-1.5.0/](benchmarks/2026-11-10-1.5.0/README.md).

| Measure | Baseline | Ours | Baseline ÷ ours |
| --- | --- | --- | ---: |
| Import, everything ready (s) | 52.0, 54.8, 48.6, 52.7, 47.6 (median 52.0) | 28.0, 30.0, 28.6, 29.6, 28.5 (median 28.6) | 1.81× |
| Import, clips listed (s) | 1.69, 2.15, 1.59, 1.62, 1.46 (median 1.62) | 1.94, 2.00, 1.91, 1.86, 1.94 (median 1.94) | 0.84× |
| Import, first thumbnail (s) | 0.57, 0.70, 0.57, 0.49, 0.48 (median 0.57) | 0.63, 0.64, 0.58, 0.55, 0.62 (median 0.62) | 0.91× |
| `cb media add`, everything ready (s) | 63.6, 69.6, 61.8, 64.2, 64.3 (median 64.2) | 40.7, 44.5, 43.7, 49.6, 48.3 (median 44.5) | 1.44× |

A separate agent checked it (AGENTS.md rule 6). It read the method, matched the clips' SHA-256 and both builds'
`build-info.json`, recomputed every median and ratio from `results.json`, checked that the builds alternated, and
that the laptop stayed on mains. Then it ran the import again, 3 counted runs per build: everything ready took
47.9, 48.6, 50.1 s (median 48.6) for the baseline and 27.1, 29.0, 29.1 s (median 29.0) for ours, 1.67×. Every
median of the re-run falls within the first run's spread, and in both sets every run of ours was ready before every
run of the baseline. So import is **about 1.7× faster** (1.67× to 1.81× across the two sets). The check recomputed
`cb media add` but didn't re-run it. Its first re-run doesn't count: its own `tail -f` on the window guard's log
stopped the guard, so those runs went on unguarded, with the user at the laptop. That attempt stays in
[VERIFY.md](benchmarks/2026-11-10-1.5.0/VERIFY.md).

What is slower in ours:
- The clips show up in the media list about 0.3 s later (1.62 → 1.94 s), and the first thumbnail about 0.05 s later
  (0.57 → 0.62 s). The clean re-run agrees (1.54 → 1.93 s and 0.54 → 0.62 s). Not yet explained.
- Each `cb` command, run with the app closed, takes 18 to 234 ms more:

  | Command (ms) | Baseline | Ours |
  | --- | ---: | ---: |
  | `cb --help` | 225, 221, 210, 231, 222 (median 222) | 245, 237, 233, 240, 243 (median 240) |
  | `cb project create` | 958, 832, 1177, 839, 923 (median 923) | 1178, 1073, 1161, 1157, 1004 (median 1157) |
  | `cb project list` | 231, 243, 253, 227, 229 (median 231) | 261, 263, 255, 263, 252 (median 261) |
  | `cb source print` | 229, 214, 225, 233, 209 (median 225) | 248, 250, 250, 244, 259 (median 250) |
  | `cb source apply` | 1087, 943, 974, 916, 903 (median 943) | 1204, 1109, 1019, 929, 1011 (median 1019) |
  | `cb source apply`, a second edit | 936, 898, 10866, 1085, 826 (median 936) | 1061, 1165, 1063, 1196, 1151 (median 1151) |

  Carton patches the CLI and the baseline leaves Carton out, so this may be Carton's cost rather than the speed
  changes'. The two haven't been measured apart. The baseline's 10,866 ms run was a real stall (the next run
  started 13.7 s later instead of about 4 s); it is that build's slowest, so the median doesn't move.

## Playback, the timeline and the GPU

Measured on one laptop (i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11, on mains), on 1.4.0-based builds (the
graphic's frame rate includes the 1.4.0-only speed change in [the patch notes](windows-port.md#patches)), the build before these changes against the build after, each run in its own isolated instance, alternating builds, every run listed.
The graphic is a 20 s `<code>` clip with a video inside it (a real project's), played from the start for 19 s.

| | Before | After |
| --- | --- | --- |
| Graphic, frames drawn per second | 29.8, 37.2, 26.2 | 87.7, 77.7, 80.7 |
| Its wait for video frames, median per frame | 24, 20, 25 ms | 5, 4, 5 ms |
| Editor frames, slowest 5% | 27.7, 20.8, 20.9 ms | 7.6, 7.3, 7.6 ms |
| Editor frames over 50 ms (19 s) | 20, 20, 17 | 6, 6, 4 |
| Black preview frames | 0, 0, 0 | 0, 0, 0 |
| Memory (working set, all processes) | 3113, 3153, 3708 MB | 2800, 2796, 2842 MB |
| System RAM taken as GPU memory | 902, 603, 1031 MB | 36 MB (the RTX's own ~870 MB) |
| CPU while playing | 1.37, 1.56, 1.87 cores | 2.20, 2.23, 2.26 cores |

The CPU goes into drawing about 2.7 times as many frames: per frame drawn it is about 55% less. Split, with the
after build kept on the Intel GPU (Windows' per-app "Power saving"): the graphic alone went from 41.3, 39.8 to
72.4, 74.2 frames/s (+0.15 core), the editor's frame times did not change. The RTX gives the editor's smoothness
and the memory.

- Timeline after the GPU process restarts: 99.4% black at 1.5, 4 and 10 s before; redrawn by 1.5 s after.
- ← / → across the edge of the view and dragging the playhead past either edge: the playhead left the view in
  all four before; stays in view in all four after.
- Play right after a seek into a clip whose sound is extracted audio, every such read answered 3 s late: one press
  3.9–4.2 s before, 4.0–4.3 s after (the audio must load); a second press at 0.6 s, 3.9–4.1 s before, 0.81–0.83 s
  after; the clip's track muted, 4.0–4.1 s before, 0.18–0.22 s after. Without the delay, about 0.2 s in both.
- A pause, a seek and Play again while an earlier audio load still runs (reads 6 s late): without the load
  numbering playback started 1.5 s before the new spot's audio was in, with it after.
- Startup to the Dashboard on mains, 7 launches each, medians: first paint 2505 → 2589 ms, prompt box ready
  2354 → 2310 ms, largest paint 2891 → 3081 ms, working set 1123 → 1082 MB, private 810 → 1013 MB (the NVIDIA
  driver), idle CPU the same. The slowest launches were 0.6–0.8 s slower, when the RTX wakes late. Without the
  early wake, first paint was 260 ms slower at the median.
- Export at 1080p, on mains: the 60 s media timeline (4K HEVC and H.264 clips) took 159.2, 164.5, 160.8,
  158.4 s before and 156.4, 155.1, 150.7 s after, plus one run of 357.0 s while Windows Update installed a
  Windows Security platform update (in the System log at the same minutes). The 20 s graphic: 81.4, 117.5 s
  before, 68.0, 135.7 s after (as noisy in both). Outputs the same size and length.
- The 25 page tests of `scripts\test-shortcuts.js` pass on the after build.

## An idle editor

The same laptop on mains, with a 144 Hz screen. The build before the preview's position loop rested is compared with
the build after, alternating, 5 runs each. Each run is a fresh isolated instance with fresh two-clip projects. It is
left untouched for 20 s, then measured for 60 s. CPU is the instance's processes together, as a share of one core.

| | Before | After |
| --- | --- | --- |
| One project tab: frame callbacks per second | 144.2, 144.2, 144.2, 144.2, 144.4 | 0 in every run |
| One project tab: CPU | 11.2, 21.5, 21.2, 19.0, 20.3% (median 20.3%) | 0.9, 0.4, 0.7, 1.1, 0.7% (median 0.7%) |
| … of which the GPU process | 3.0, 6.3, 5.9, 5.9, 6.5% | 0.2, 0.1, 0.3, 0.2, 0.2% |
| Four project tabs: frame callbacks per second | 578.8, 581.4, 538.2, 536.0, 542.8 | 0 in every run |
| Four project tabs: CPU | 68.7, 64.8, 66.4, 53.0, 52.5% (median 64.8%) | 1.6, 0.9, 2.9, 2.0, 3.2% (median 2.0%) |

A separate re-run measured with a Chromium trace and Windows' CPU counters instead, with the window pinned in
front, 3 runs per build, and got the same medians:
- one tab: 144.1 → 0 callbacks per second, 19.9% → 0.9% of a core;
- four tabs: 576.3 → 0 callbacks per second, 68.3% → 1.6% of a core.

Playing the 56 s timeline with the window in front, nothing changed: 143.5, 143.3, 143.3, 142.8 frames/s and
1.13, 1.13, 1.14, 1.12 cores before, against 143.1, 143.2, 136.7, 142.3 frames/s and 1.10, 1.14, 1.13, 1.11 cores
after. After the change, the position loop ran 0 times during playback.

These figures are for a window that is on screen. Normally Windows Chromium treats a completely covered window as
hidden, and a hidden window gets no frame callbacks, in either build. The runs above turn that detection off, so
that a window left behind others still counts as visible.
