# Cardboard benchmark, 2026-11-10 09:50

Machine: 12th Gen Intel(R) Core(TM) i5-12450HX (8 cores, 12 threads), 16 GB, Intel(R) UHD Graphics (driver 32.0.101.7026); NVIDIA GeForce RTX 3050 6GB Laptop GPU (driver 32.0.15.8186), Microsoft Windows 11 Home Single Language 10.0.26300.

Builds:
- **baseline**: D:\cbwork\bench150\Cardboard-baseline (baseline, 56142f3, built 2026-11-10)
- **ours**: D:\cbwork\bench150\Cardboard (full, 56142f3, built 2026-11-10)

Clips (D:\cbwork\bench150\repo\bench-media):
- a-4k30-hevc10-phone.mov, 152.7 MB: 4K30 HEVC 10-bit, 40 Mb/s, keyframe every 1 s (phone)
- b-4k30-hevc10-portrait.mov, 76.6 MB: 4K30 HEVC 10-bit, rotated 90° (phone, portrait)
- c-4k60-h264-camera.mp4, 208.2 MB: 4K60 H.264, 80 Mb/s, keyframe every 1 s (action camera)
- d-1080p30-h264-screen.mp4, 61.6 MB: 1080p30 H.264, 8 Mb/s, keyframe every 10 s (screen recording)
- e-1080p30-hevc10.mov, 57.9 MB: 1080p30 HEVC 10-bit, 15 Mb/s, keyframe every 1 s
- f-music.wav, 10.6 MB: 60 s stereo WAV, 44.1 kHz

5 counted runs per build after 1 warm-up, alternating. Medians; every counted run is listed under each table. The last column is baseline's median ÷ each build's.

## import

| Measure | baseline | ours | baseline ÷ ours |
| --- | ---: | ---: | ---: |
| clips listed (s) | 1.62 | 1.94 | 0.84× |
| first thumbnail (s) | 0.57 | 0.62 | 0.91× |
| everything ready (s) | 52.0 | 28.6 | 1.81× |

- baseline, clips listed (s): 1.69, 2.15, 1.59, 1.62, 1.46
- baseline, first thumbnail (s): 0.57, 0.70, 0.57, 0.49, 0.48
- baseline, everything ready (s): 52.0, 54.8, 48.6, 52.7, 47.6
- ours, clips listed (s): 1.94, 2.00, 1.91, 1.86, 1.94
- ours, first thumbnail (s): 0.63, 0.64, 0.58, 0.55, 0.62
- ours, everything ready (s): 28.0, 30.0, 28.6, 29.6, 28.5

Every run made the same files: {"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":0,"other":12}.

## cli

| Measure | baseline | ours | baseline ÷ ours |
| --- | ---: | ---: | ---: |
| cb --help (ms) | 222 | 240 | 0.93× |
| cb project create (ms) | 923 | 1157 | 0.80× |
| cb project list (ms) | 231 | 261 | 0.89× |
| cb source print (ms) | 225 | 250 | 0.90× |
| cb source apply (ms) | 943 | 1019 | 0.93× |
| cb source apply, second edit (ms) | 936 | 1151 | 0.81× |

- baseline, cb --help (ms): 225, 221, 210, 231, 222
- baseline, cb project create (ms): 958, 832, 1177, 839, 923
- baseline, cb project list (ms): 231, 243, 253, 227, 229
- baseline, cb source print (ms): 229, 214, 225, 233, 209
- baseline, cb source apply (ms): 1087, 943, 974, 916, 903
- baseline, cb source apply, second edit (ms): 936, 898, 10866, 1085, 826
- ours, cb --help (ms): 245, 237, 233, 240, 243
- ours, cb project create (ms): 1178, 1073, 1161, 1157, 1004
- ours, cb project list (ms): 261, 263, 255, 263, 252
- ours, cb source print (ms): 248, 250, 250, 244, 259
- ours, cb source apply (ms): 1204, 1109, 1019, 929, 1011
- ours, cb source apply, second edit (ms): 1061, 1165, 1063, 1196, 1151

## cli-import

| Measure | baseline | ours | baseline ÷ ours |
| --- | ---: | ---: | ---: |
| cb media add, everything ready (s) | 64.2 | 44.5 | 1.44× |

- baseline, cb media add, everything ready (s): 63.6, 69.6, 61.8, 64.2, 64.3
- ours, cb media add, everything ready (s): 40.7, 44.5, 43.7, 49.6, 48.3

Every run made the same files: {"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":6,"other":12}.
