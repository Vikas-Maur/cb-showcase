// Segmented collab proxies through ffmpeg (orchestrator decision on e2e S5-1, PLAN §11 T2): the init segment and ~2 s
// fragmented-MP4 (CMAF) media segments, handed over one by one AS ffmpeg makes them, so the share uploads segment 0
// while segment 1 is encoding and a teammate can play the proxy before the encode ends (stream.ts).
//
// - ffmpeg's HLS muxer makes the parts: init.mp4 (ftyp + moov, no samples), seg_000000.m4s … (styp + moof + mdat), and
//   an EVENT playlist it rewrites after each segment. Concatenated in order they are one fragmented MP4.
// - A finished segment is told by the playlist: with `temp_file` a segment is written as `.tmp` and renamed before it is
//   listed, and an EVENT playlist is itself written to `.tmp` and renamed, so a listed segment is complete and a read
//   playlist is whole. The playlist is polled (a small file, a few reads a second): fs.watch misses renames on some
//   file systems and network drives. The EXTINF lines give each segment's duration.
// - ffmpeg runs IN the working folder and every output name it gets is relative and plain ASCII. Two reasons, both in
//   ffmpeg 8.0's hlsenc.c: it finds the init segment's folder with strrchr(playlist, '/') only, so a Windows path
//   (backslashes) would put init.mp4 in ffmpeg's current folder; and the segment name is a printf pattern, so a "%" in
//   a folder name ("100% done") would be read as a conversion. A folder with spaces, non-ASCII or "%" never reaches the
//   pattern this way.
// - Back-pressure: ffmpeg is never held back (it has the disk); finished segments wait in the folder and are delivered
//   in order, one callback at a time, each after the previous one's promise resolves. After ffmpeg exits, every
//   remaining listed segment is delivered, then the call resolves.
// - Windows: ffmpeg ignores a failed rename (hlsenc.c drops ff_rename's result), so if the playlist can't replace the
//   old one while something reads it, it only lags until the next rewrite; after the exit a leftover `index.m3u8.tmp`
//   (the final rewrite whose rename failed) is read too, and whichever lists more wins.
// - A callback that throws stops ffmpeg (SIGKILL, runFfmpeg) and the call rejects with that error; an abort rejects
//   with the signal's reason; a stall (no progress for stallMs) rejects. The folder's files are left to the caller.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProxyProfile } from "@carton/core/plugins";
import { collabProfile, type CollabProfile } from "../proxy.ts";
import { codecArgs, commandOf, kbps, runFfmpeg, scaleFilter, STALL_MS, type FfmpegCodec } from "./ffmpeg-encoder.ts";

export interface SegmentInfo {
  index: number;
  path: string;
  durationSec: number;
}

export interface EncodeSegmentsOptions {
  /** A local file. */
  input: string;
  /** An empty working folder for this stream (created if missing). */
  dir: string;
  /** Through collabProfile() for the extended fields. */
  profile: ProxyProfile;
  /** "copy": remux only (Cardboard's own proxy, already H.264/AAC at the profile); else an ffmpeg encoder name. */
  codec: FfmpegCodec | "copy";
  /** Target segment length, s. Cuts land on keyframes: forced at this interval when encoding, the source's for "copy". */
  segmentSeconds?: number;
  ffmpeg?: string | readonly string[];
  signal?: AbortSignal;
  /** ffmpeg's progress through the input, in [0, 1], never backwards; 1 once every segment is delivered. */
  onProgress?: (fraction: number) => void;
  /** Called once, before the first segment, with the init segment (ftyp+moov, no samples). */
  onInit: (path: string) => Promise<void>;
  /** Called for each finished segment, in order, one at a time: the next call waits for this one's promise. */
  onSegment: (s: SegmentInfo) => Promise<void>;
  /** ffmpeg is killed when its progress hasn't advanced for this long, ms. */
  stallMs?: number;
  /** Below normal priority (default): proxies are background work. */
  lowPriority?: boolean;
}

/** Output names, relative to the working folder ffmpeg runs in (see the top of this file). */
export const SEGMENT_PLAYLIST = "index.m3u8";
export const SEGMENT_INIT = "init.mp4";
const SEGMENT_PATTERN = "seg_%06d.m4s";
const segmentName = (i: number): string => `seg_${String(i).padStart(6, "0")}.m4s`;
const OUR_FILE = /^(index\.m3u8|init\.mp4|seg_\d{6,}\.m4s)(\.tmp)?$/;

// How often the playlist is read while ffmpeg runs. A segment is ~2 s of media; even a fast GPU encode makes a few a
// second, so 150 ms keeps the upload close behind without costing anything measurable.
const POLL_MS = 150;

/**
 * ffmpeg's arguments for one segmented encode (after the command's own prefix). Outputs are relative: run ffmpeg with
 * the working folder as its current directory.
 */
export function segmentArgs(codec: FfmpegCodec | "copy", input: string, profile: ProxyProfile, segmentSeconds = 2): string[] {
  if (!(segmentSeconds > 0) || !Number.isFinite(segmentSeconds)) throw new RangeError(`bad segment length ${segmentSeconds}`);
  const p: CollabProfile = collabProfile(profile);
  const streams =
    codec === "copy"
      ? ["-c", "copy"] // cuts land on the source's keyframes
      : [
          "-vf", scaleFilter(p.height),
          "-c:v", codec, ...codecArgs(codec, p),
          // A keyframe at every segment boundary, so segments are ~segmentSeconds and each starts on one.
          "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
          "-c:a", "aac", "-b:a", kbps(p.audioBitrate), "-ac", "2",
        ];
  return [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", // info: the input's Duration line, for progress
    "-progress", "pipe:1",
    // file: stops a name like "a:b.mp4" being read as a protocol, and a name starting with "-" as an option.
    "-i", `file:${resolve(input)}`,
    // The first real video stream (not cover art) and the first audio, each optional: audio-only sources work.
    "-map", "0:V:0?", "-map", "0:a:0?",
    ...streams,
    // A proxy is shared with collaborators: leave out the original's metadata (camera GPS, names, chapters).
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", String(segmentSeconds),
    // EVENT: the playlist keeps every segment (no sliding window) and is rewritten through a .tmp after each one.
    "-hls_playlist_type", "event", "-hls_list_size", "0",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_fmp4_init_filename", SEGMENT_INIT,
    "-hls_segment_filename", SEGMENT_PATTERN,
    "-y", SEGMENT_PLAYLIST,
  ];
}

interface Listed {
  name: string;
  durationSec: number;
}

/** The segments a playlist lists, in order. Only whole lines count (a line without its newline may be cut short). */
export function parsePlaylist(text: string): Listed[] {
  const lines = text.split("\n");
  lines.pop(); // "" after the last newline, or an unfinished line
  const out: Listed[] = [];
  let pending: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^#EXTINF:([0-9.]+)/.exec(line);
    if (m) pending = Number(m[1]);
    else if (line && !line.startsWith("#") && pending !== null) {
      out.push({ name: line, durationSec: pending });
      pending = null;
    }
  }
  return out;
}

async function listed(dir: string, final: boolean): Promise<Listed[]> {
  const read = async (name: string): Promise<Listed[]> => {
    try {
      return parsePlaylist(await readFile(join(dir, name), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // not written yet
      throw e;
    }
  };
  const main = await read(SEGMENT_PLAYLIST);
  if (!final) return main;
  // After the exit only: a .tmp left behind is the final rewrite, whose rename failed (see the top of this file).
  const tmp = await read(`${SEGMENT_PLAYLIST}.tmp`);
  return tmp.length > main.length ? tmp : main;
}

/**
 * Encodes (or, for "copy", remuxes) `input` into an init segment and ~segmentSeconds fragmented-MP4 segments in `dir`,
 * handing each to the callbacks as soon as ffmpeg has finished it. Resolves once ffmpeg has exited and every segment
 * has been delivered.
 */
export async function encodeSegments(o: EncodeSegmentsOptions): Promise<{ segments: number; durationSec: number }> {
  o.signal?.throwIfAborted();
  const args = segmentArgs(o.codec, o.input, o.profile, o.segmentSeconds ?? 2);
  const dir = resolve(o.dir);
  await mkdir(dir, { recursive: true });
  // A stale playlist from an earlier run in this folder would be delivered before ffmpeg replaces it.
  for (const name of await readdir(dir)) if (OUR_FILE.test(name)) await rm(join(dir, name), { force: true });

  // Our own stop (a callback failed) and the caller's abort both kill ffmpeg; runFfmpeg rejects with the reason.
  const stop = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal;
  let exit: { ok: true } | { ok: false; error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const run = runFfmpeg(commandOf(o.ffmpeg), args, {
    signal,
    stallMs: o.stallMs ?? STALL_MS,
    lowPriority: o.lowPriority ?? true,
    onProgress: o.onProgress,
    cwd: dir,
  }).then(
    () => void (exit = { ok: true }),
    (error: unknown) => void (exit = { ok: false, error }),
  ).finally(() => wake?.());
  // Read through functions: the callbacks above change `exit` behind the compiler's back.
  const exited = (): boolean => exit !== null;
  const throwIfFailed = (): void => {
    const x = exit as { ok: true } | { ok: false; error: unknown } | null;
    if (x && !x.ok) throw x.error;
  };

  let delivered = 0;
  let initDone = false;
  let durationSec = 0;
  try {
    for (;;) {
      // Taken before the read: a playlist read after the exit is the final one.
      const ended = exited();
      throwIfFailed();
      const list = await listed(dir, ended);
      for (; delivered < list.length; delivered++) {
        const { name, durationSec: d } = list[delivered];
        // Anything else would mean the muxer numbered or named segments differently from what the reader expects.
        if (name !== segmentName(delivered)) throw new Error(`ffmpeg's playlist lists ${JSON.stringify(name)} where ${segmentName(delivered)} was expected`);
        throwIfFailed(); // ffmpeg failed while the last callback ran: stop delivering
        o.signal?.throwIfAborted();
        if (!initDone) {
          // The init segment is closed before the first segment is listed.
          await o.onInit(join(dir, SEGMENT_INIT));
          initDone = true;
        }
        await o.onSegment({ index: delivered, path: join(dir, name), durationSec: d });
        durationSec += d;
      }
      if (ended) break;
      if (!exited()) {
        // The next poll, or at once when ffmpeg exits.
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            wake = null;
            r();
          }, POLL_MS);
          wake = () => {
            clearTimeout(t);
            wake = null;
            r();
          };
        });
      }
    }
  } catch (e) {
    // A callback threw, the folder couldn't be read, or ffmpeg failed: make sure ffmpeg is gone before rejecting.
    stop.abort(e);
    await run;
    if (o.signal?.aborted) throw o.signal.reason;
    throw e;
  }
  await run;
  if (delivered === 0) throw new Error("ffmpeg made no segments");
  o.onProgress?.(1);
  return { segments: delivered, durationSec };
}
