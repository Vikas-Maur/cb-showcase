# Media benchmarks

All numbers these produce are **UNVERIFIED** until a separate verifier re-runs them (AGENTS.md rule 6). They run the
package's real code paths, on small generated inputs, one fresh process per run, inside the box's shared CPU lock
(`flock /tmp/gfv-race/cpu.lock`), round-robin with the order rotated each round. Each JSON line records the 1-minute
load and how busy other processes kept the CPUs before the run; `gateTimedOut: true` marks a run taken on a busy box
(the shared box rarely goes quiet). Raw output goes under `/home/ubuntu/gfv-scratch/carton/media/raw/`.

| Script | Measures | Run |
|---|---|---|
| `hash-throughput.ts` | MB/s of the read ceiling, in-process hashing, `hashFile` with 1/2/4 workers (cold and warm pool), and Chromium (page and Web Worker) on a picked File; every method must give the same hash | `node hash-throughput.ts make <file> 256` then `node hash-throughput.ts run <file> 3 <out.jsonl>` |
| `resume-overhead.ts` | Bytes and upload time of a clean upload, a cut link then resume (state on disk, fresh process objects), and a cut link then starting over, over a simulated link (rate + round trip per request) | `node resume-overhead.ts run 5 <out.jsonl> 64 4 60` (64 MiB, 4 MB/s, 60 ms) |
| `x264-cost.ts` | CPU cost of the chain's software fallback: libx264 making the 720p collab proxy, with the exact arguments `ffmpegEncoder("libx264")` builds, from two deterministic 10 s 1080p30 sources (easy test pattern; seeded noise), in CPU core-seconds per second of footage (from ffmpeg's `-benchmark`, so it works on Windows) and x realtime | `node x264-cost.ts run <dir> 3 <out.jsonl>` (makes the sources in `<dir>` first) |
| `reuse-check.ts` | Time and requests of the proxy reuse check (`usableProxy`) on a finished stream of N parts (default 2,000), first check and a repeat in the same process, through a real host (server-node + blob-fs via `hostMediaBlobs`: no list) and blob-fs directly (lists), each at 0 and 20 ms per request; `before` is an older checkout of the package's `src` | `node reuse-check.ts run 3 <out.jsonl> <beforeSrc> 2000` |
| `first-frame.ts` | Time to the first frame through the loopback range server over a throttled link: Chromium `<video>` to `playing`, and `ffmpeg -frames:v 1`, for faststart and moov-at-end clips | `node first-frame.ts --help` |

`runner.ts` is the shared lock, gate and round-robin runner.
