# Cardboard benchmark, 2026-11-10 10:37

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

3 counted runs per build after 1 warm-up, alternating. Medians; every counted run is listed under each table. The last column is baseline's median ÷ each build's.

## import

| Measure | baseline | ours | baseline ÷ ours |
| --- | ---: | ---: | ---: |
| clips listed (s) | 1.54 | 1.93 | 0.80× |
| first thumbnail (s) | 0.54 | 0.62 | 0.86× |
| everything ready (s) | 48.6 | 29.0 | 1.67× |

- baseline, clips listed (s): 1.48, 1.54, 1.68
- baseline, first thumbnail (s): 0.53, 0.54, 0.56
- baseline, everything ready (s): 47.9, 48.6, 50.1
- ours, clips listed (s): 1.96, 1.93, 1.92
- ours, first thumbnail (s): 0.62, 0.64, 0.61
- ours, everything ready (s): 27.1, 29.0, 29.1

Every run made the same files: {"thumbnails":315,"waveforms":6,"peaks":108,"proxies":5,"converted":0,"media":0,"other":12}.
