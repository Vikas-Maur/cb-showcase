# @carton/media

Media for Carton (PLAN §11). The edit is a small document; media are immutable files named by content hash, moved in
tiers only when needed. Nothing here runs for a solo local project: it all starts when a project is shared.

## Content ids

`mediaHash = SHA-256(size as u64 big-endian ‖ SHA-256 of each 1 MiB leaf)`. The leaf digests are the manifest, stored
next to the media as `mf/<hash>` (`"CMF1"`, leaf size, size, digests; everything after the 8-byte header is exactly
the id's input, so decoding verifies the id with one digest). Browser and Node give identical ids: the conformance
suite runs this package's own sources in headless Chromium (bytes, Blob, picked File, Web Worker) against Node. Fixed
leaves, never CDC; if CDC is ever added it must be stitched segments (P6), as a new manifest version.

## Pieces

| | Where | What |
|---|---|---|
| Hashing | `hashSource` (any runtime), `hashFile` (Node) | Lazy: `HashScheduler` hashes nothing until a share asks, one file at a time (the disk is the bottleneck), shares before background work, background paused during playback/export, manifests cached per (file, size, mtime). Node hashes in worker threads with reused 8 MiB buffers; files up to 32 MiB hash in-process |
| Tiers | `tiers.ts` | T0 record (whitelisted fields, no local paths), `planShare`, and §11's "without originals" table as `sourceFor(use, availability)` |
| Uploads | `uploadMedia` | Through any `BlobStore`. Dedup by `head`, manifest first, equal parts of 8–64 MiB chosen from the link rate (≤ 10,000 parts, whole leaves), resume by completed parts (`listParts` when the store can, else the parts recorded as they landed), every leaf re-checked against the manifest as it is read |
| Reads | `MediaReader` | Play first, verify after: bytes go out as they arrive, each leaf is checked when complete, a bad leaf is refetched (and a read that already handed out its bytes stops with `LeafMismatchError`, so playback stops and the retry is served repaired). Requests grow 1, 2, 4, 8 leaves; the next one starts while the current one flows |
| Range cache | `MemoryLeafCache`, `FsLeafCache` (Node) | Verified leaves only. On disk: one file per leaf, atomic rename (with Windows lock retries), LRU by bytes |
| Range server | `startRangeServer` (Node) | `http://127.0.0.1:<port>/m/<hash>?t=<token>` for ffmpeg-based tools: Range, HEAD, token and Host checks, backpressure, abort on disconnect |
| Proxies | `encodeProxy`, `ffmpegEncoder`, `hostProxyEncoder` | Reuse Cardboard's proxy when it is H.264, ≤ 4 Mb/s, moov-first; else NVENC → QSV → AMF → libx264, each probed once with a 1-frame test encode; a failed hardware encode falls back |
| Share | `shareMedia` (Node) | Runs a share for one clip: T1 files, the T2 proxy (a teammate's proxy for the same source and profile is reused through `px/<source>/<profile>`), T3 only when opted in |

| Stream proxies | `ProxyStreamWriter`, `ProxyStreamReader`, `encodeSegments` (Node) | The collab proxy as ~2 s CMAF segments (each its own `m/<hash>`), so a teammate plays the first ones while the rest upload; a live HLS playlist on the range server (`/s/<stream>.m3u8`) for tools. Entries are written once and kept in the range cache once read, so a played stream replays offline. The reuse check needs no listing (HEADs and known keys only): it works through any store, a Carton host's HTTP API included. A part that fails verification or is gone (a host that checks reported damage removes the object, so the retry finds it missing) is reported against its stream (`bad/<stream>`) by the player, the playlist's segment URLs (wire the range server's `reportDamage` to `(stream, hash) => reader.reportPartDamage(hash)` and `reportMissing` to `(stream, hash) => reader.reportPartDamage(hash, "missing")`) and whole-stream reads; the reuse check also checks every part a finished stream's end lists (through a Carton host, `heads`: 1,000 parts a request; a few list pages on S3 and R2, which page on the server; a HEAD per part, 16 at a time, elsewhere) and remembers a stream it found whole for 10 minutes, per store object, so later checks through the same object skip it (keep one store object per project for the memory to help across shares) (a damage report still counts at once). Either way the next share makes a new stream. Through a Carton host (`hostMediaBlobs`, which offers `appendStream` and `readStream`) the writer queues parts and sends them in batches, one request each (`POST /streams/<id>/append`: bytes, manifests, entries and the end), while the encoder goes on, and the reader takes the init and first segment in one request, then batches of up to 4 MiB (`GET /streams/<id>/read`), each held by the host at the live edge until the next segment is up; bytes that come that way are verified against the manifest that came with them, and read the usual way if they don't verify. A host from before those routes gets the part-by-part path. The end entry lists every part's size and every segment's duration, so a finished stream's layout is one read |

The record of a stream proxy: `{ stream, profile, encoder, size }` (`size` once the stream has ended; a teammate who
reused a stream still uploading gets it without). A whole-object proxy: `{ hash, size, profile, encoder }`.

Store keys: `m/<hash>` bytes, `mf/<hash>` manifest, `px/<sourceHash>/<profileId>` proxy pointer, `ps/<stream>/init`,
`ps/<stream>/s/<000000>`, `ps/<stream>/end` a stream's entries (an entry also carries its part's encoded manifest,
`manifest`, base64; the end its parts' `sizes` and segments' `durations`; readers before them ignore both),
`bad/<hash or stream>` damage reports.

## Cross-platform notes

- Windows: no shell for ffmpeg/ffprobe (`execFile`, `windowsHide`), renames retried on `EPERM`/`EBUSY`/`EACCES`, paths
  with spaces and non-ASCII characters, leaf files instead of sparse files (FAT/exFAT have none).
- Still needs a run on the user's Windows laptop: NVENC/QSV/AMF probing and encodes (this box has no GPU), the range
  server with the Windows ffmpeg, `FsLeafCache` under antivirus scanning, worker-thread hashing inside Electron's
  utility process.
