// Collab proxies through ffmpeg (PLAN §11 T2, R2-12): NVENC, then Quick Sync, then AMF, then libx264.
//
// - Each encoder test-encodes one frame before it is used, once per process: Windows ffmpeg builds list NVENC, QSV
//   and AMF whether or not the GPU is there, and only opening the encoder tells. The probe passes exactly the options
//   the real encode passes, because ffmpeg refuses an option its build doesn't know, so an option this build lacks
//   makes the encoder unavailable instead of failing every encode.
// - ffmpeg runs without a shell (paths with spaces and non-ASCII names reach it intact on Windows), with no console
//   window, below normal priority so the editor stays responsive, and is killed on abort or when it stalls.
// - A path output is written to `<output>.<random>.partial.mp4` and renamed into place, so a reader never sees half a
//   proxy, and two encodes of the same output (two processes sharing one clip) never write the same temporary file.
// - A source without video (a WAV, an MP3) gets an audio-only proxy: the video map is optional.
//   A sink output is encoded to a temporary file first (moov first needs a seekable file), then streamed to the sink,
//   so a failed encode never writes to the sink and the next encoder of the chain can still use it.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MediaInput, MediaOutput, ProxyEncoder, ProxyProfile } from "@carton/core/plugins";
import { COLLAB_PROXY_720P, collabProfile, type CollabProfile } from "../proxy.ts";

export type FfmpegCodec = "h264_nvenc" | "h264_qsv" | "h264_amf" | "libx264";

/** Hardware first, by how common each GPU is among Cardboard's Windows users; libx264 runs everywhere. */
export const CHAIN_ORDER: readonly FfmpegCodec[] = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];

export interface FfmpegEncoderOptions {
  /** The ffmpeg command, or a command and the arguments before ffmpeg's own (tests: [process.execPath, "fake.js"]). */
  ffmpeg?: string | readonly string[];
  /** The 1-frame probe's limit, ms. A first NVENC open loads the driver, which takes a few seconds at most. */
  timeoutMs?: number;
  /** An encode whose output hasn't advanced for this long is killed and counts as failed (a hung GPU driver), ms. */
  stallMs?: number;
  /** Run ffmpeg below normal priority. Proxies are background work; the editor's own ffmpeg jobs come first. */
  lowPriority?: boolean;
  /** Where a sink output's temporary file goes: the Carton cache's directory. Default: the OS temp directory. */
  tempDir?: string;
}

export interface ProbeResult {
  ok: boolean;
  /** ffmpeg's last error lines when the test encode failed. */
  detail?: string;
}

export interface FfmpegProxyEncoder extends ProxyEncoder {
  readonly name: FfmpegCodec;
  /** probe(), with ffmpeg's reason when it fails. Shares probe()'s cache. */
  probeDetail(): Promise<ProbeResult>;
}

const PROBE_TIMEOUT_MS = 15_000;
const STALL_MS = 120_000;

// NVENC constant quality, capped at the profile's max rate, as our Windows build's Cardboard proxies do
// (scripts/media-helpers.js measured CQ 30 for 1920 proxies). 28 at 720p is a starting point, not a measured one.
const NVENC_CQ = 28;
// libx264's default CRF, capped at the profile's max rate.
const X264_CRF = 23;

const kbps = (bitsPerSecond: number): string => `${Math.round(bitsPerSecond / 1000)}k`;

/** Rate control and pixel format per encoder. The probe passes these too (see the top of this file). */
export function codecArgs(codec: FfmpegCodec, p: CollabProfile): string[] {
  const cap = ["-maxrate", kbps(p.maxBitrate), "-bufsize", kbps(p.maxBitrate * 2)];
  switch (codec) {
    case "h264_nvenc":
      // VBR with a quality target and no average (-b:v 0): simple footage comes out well under the cap.
      return ["-preset", "p4", "-rc", "vbr", "-cq", String(NVENC_CQ), "-b:v", "0", ...cap, "-forced-idr", "1", "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      // Plain VBR: QSV's quality modes (ICQ, QVBR) depend on the GPU generation and driver.
      return ["-preset", "medium", "-b:v", kbps(p.bitrate), ...cap, "-forced_idr", "1", "-profile:v", "high", "-pix_fmt", "nv12"];
    case "h264_amf":
      return ["-usage", "transcoding", "-quality", "speed", "-rc", "vbr_peak", "-b:v", kbps(p.bitrate), ...cap, "-forced_idr", "1", "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "libx264":
      // Forced keyframes are IDR already: x264's GOPs are closed by default.
      return ["-preset", "veryfast", "-crf", String(X264_CRF), ...cap, "-profile:v", "high", "-pix_fmt", "yuv420p"];
  }
}

/**
 * Scales so the displayed short side is at most `height` ("720p"), never up. Both sides shrink by the same factor, so
 * the sample aspect ratio carries over (anamorphic sources stay anamorphic); sides are even for 4:2:0. ffmpeg rotates
 * phone footage before filters run, so iw and ih are already upright and portrait stays portrait.
 */
export function scaleFilter(height: number): string {
  const f = `min(1,${height}/min(iw*sar,ih))`;
  // The tiny bias keeps 1080*(720/1080) from truncating to 718 when the division rounds down.
  return `scale=w='max(2,trunc(iw*${f}/2+0.000001)*2)':h='max(2,trunc(ih*${f}/2+0.000001)*2)'`;
}

/** ffmpeg's arguments for one proxy encode (after the command's own prefix). */
export function encodeArgs(codec: FfmpegCodec, input: string, output: string, p: CollabProfile): string[] {
  return [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", // info: the input's Duration line, for progress
    "-progress", "pipe:1",
    // file: stops a name like "a:b.mp4" being read as a protocol, and a name starting with "-" as an option.
    "-i", `file:${resolve(input)}`,
    // V: the first real video stream, not cover art. Optional, so audio-only sources make an AAC-only proxy (the video
    // filter and encoder options then apply to no stream); a source with neither fails, as it should.
    "-map", "0:V:0?", "-map", "0:a:0?",
    "-vf", scaleFilter(p.height),
    "-c:v", codec, ...codecArgs(codec, p),
    "-force_key_frames", `expr:gte(t,n_forced*${p.keyframeSeconds})`,
    "-c:a", "aac", "-b:a", kbps(p.audioBitrate), "-ac", "2",
    // A proxy is shared with collaborators: leave out the original's metadata (camera GPS, names, chapters).
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-movflags", "+faststart",
    "-f", "mp4", "-y", `file:${resolve(output)}`,
  ];
}

function commandOf(ffmpeg: string | readonly string[] | undefined): readonly string[] {
  if (ffmpeg === undefined) return ["ffmpeg"];
  return typeof ffmpeg === "string" ? [ffmpeg] : ffmpeg;
}

function lastLines(text: string, n = 3): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ").slice(0, 600);
}

// One test encode per (ffmpeg command, codec) for the life of the process. Promises, so concurrent callers share one.
const probes = new Map<string, Promise<ProbeResult>>();

/** Forgets every probe result: after a driver install, or between tests. */
export function clearProbeCache(): void {
  probes.clear();
}

function probeCodec(cmd: readonly string[], codec: FfmpegCodec, timeoutMs: number): Promise<ProbeResult> {
  const key = JSON.stringify([cmd, codec]);
  let p = probes.get(key);
  if (!p) {
    const args = [
      ...cmd.slice(1),
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi", "-i", "color=black:s=256x256:r=30:d=0.04",
      "-frames:v", "1", "-c:v", codec, ...codecArgs(codec, COLLAB_PROXY_720P),
      "-f", "null", "-",
    ];
    p = new Promise((done) => {
      try {
        execFile(cmd[0], args, { windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, _out, stderr) => {
          done(err ? { ok: false, detail: lastLines(String(stderr)) || err.message } : { ok: true });
        });
      } catch (e) {
        done({ ok: false, detail: e instanceof Error ? e.message : String(e) }); // never throws (core's contract)
      }
    });
    probes.set(key, p);
  }
  return p;
}

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * rename, retried while Windows refuses to replace a file another process has open (EPERM/EBUSY/EACCES): a player or
 * a virus scanner reading the old proxy. 10, 20, 40 … 320 ms, about 1.3 s in all, like scripts/rename-retry.js.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: { tries?: number; rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<void> {
  const tries = opts.tries ?? 9;
  const doRename = opts.rename ?? rename;
  for (let i = 0; ; i++) {
    try {
      return await doRename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (i >= tries - 1 || !code || !RETRY_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 10 * 2 ** Math.min(i, 5)));
    }
  }
}

const SINK_CHUNK = 1 << 20;

/**
 * Streams a finished file into a sink and closes it; aborts the sink when reading or the signal fails, so a consumer
 * never takes a cut-short stream for a whole proxy. Returns the bytes written.
 */
export async function pipeFileToSink(path: string, sink: WritableStream<Uint8Array>, signal?: AbortSignal): Promise<number> {
  const fh = await open(path, "r");
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let total = 0;
  try {
    writer = sink.getWriter();
    for (;;) {
      signal?.throwIfAborted();
      // A fresh buffer per chunk: the sink may hold on to what it was given.
      const buf = new Uint8Array(SINK_CHUNK);
      const { bytesRead } = await fh.read(buf, 0, SINK_CHUNK, null);
      if (bytesRead === 0) break;
      await writer.write(bytesRead === SINK_CHUNK ? buf : buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    await writer.close();
    return total;
  } catch (e) {
    await writer?.abort(e).catch(() => {});
    throw e;
  } finally {
    await fh.close();
  }
}

interface RunOptions {
  signal?: AbortSignal;
  stallMs: number;
  lowPriority: boolean;
  onProgress?: (fraction: number) => void;
}

/** "HH:MM:SS.xx" (ffmpeg's Duration and out_time) to seconds. */
function clockSeconds(s: string): number | null {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Runs one ffmpeg encode, reporting `-progress` against the input's duration. Resolves when ffmpeg exits 0. */
function runFfmpeg(cmd: readonly string[], args: string[], opts: RunOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (opts.lowPriority && child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Not allowed here (some containers): run at normal priority.
      }
    }
    let duration: number | null = null;
    let stderr = "";
    let stderrLine = "";
    let stdoutLine = "";
    let lastTime = -1;
    let lastSize = -1;
    let haveUs = false;
    let reported = 0;
    let killed: { why: unknown } | null = null;
    let settled = false;

    const finish = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err === null) resolvePromise();
      else reject(err);
    };
    // SIGKILL: ffmpeg treats SIGTERM as "finish up", which would write the trailer and move moov first.
    const kill = (why: unknown): void => {
      killed ??= { why };
      child.kill("SIGKILL");
    };
    const onAbort = (): void => kill(opts.signal?.reason);
    const stalled = (): void => kill(new Error(`ffmpeg made no progress for ${opts.stallMs / 1000} s`));
    let stallTimer = setTimeout(stalled, opts.stallMs);
    const advanced = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(stalled, opts.stallMs);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only the tail for error messages; read the Duration line as it passes.
      stderr = (stderr + chunk).slice(-8192);
      if (duration !== null) return;
      const lines = (stderrLine + chunk).split("\n");
      stderrLine = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^\s*Duration:\s*([0-9:.]+)/.exec(line);
        if (m) {
          duration = clockSeconds(m[1]);
          break;
        }
      }
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (stdoutLine + chunk).split("\n");
      stdoutLine = lines.pop() ?? "";
      for (const raw of lines) {
        const eq = raw.indexOf("=");
        if (eq < 0) continue;
        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        let t: number | null = null;
        if (key === "out_time_us") {
          haveUs = true;
          t = /^\d+$/.test(value) ? Number(value) / 1e6 : null;
        } else if (key === "out_time" && !haveUs) {
          t = clockSeconds(value); // older ffmpeg: no out_time_us
        } else if (key === "total_size" && /^\d+$/.test(value) && Number(value) > lastSize) {
          lastSize = Number(value);
          advanced();
        }
        if (t !== null && t > lastTime) {
          lastTime = t;
          advanced();
          if (duration && opts.onProgress) {
            // Below 1 until the proxy is in place; never backwards.
            const f = Math.min(0.99, t / duration);
            if (f > reported) {
              reported = f;
              opts.onProgress(f);
            }
          }
        }
      }
    });

    child.on("error", (e) => finish(e));
    child.on("close", (code, sig) => {
      if (killed) finish(killed.why);
      else if (code === 0) finish(null);
      else finish(new Error(`ffmpeg ${code !== null ? `exited with ${code}` : `was killed (${sig})`}: ${lastLines(stderr)}`));
    });
  });
}

/** One encoder of the chain: `codec` through the given ffmpeg. */
export function ffmpegEncoder(codec: FfmpegCodec, opts: FfmpegEncoderOptions = {}): FfmpegProxyEncoder {
  const cmd = commandOf(opts.ffmpeg);
  const probeDetail = (): Promise<ProbeResult> => probeCodec(cmd, codec, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  return {
    name: codec,
    hardware: codec !== "libx264",
    probeDetail,
    probe: async () => (await probeDetail()).ok,
    async encode(input: MediaInput, output: MediaOutput, profile: ProxyProfile, eopts = {}) {
      const started = performance.now();
      if (!("path" in input)) throw new TypeError(`${codec}: ffmpeg reads files; a Blob input can't be encoded here`);
      const { signal, onProgress } = eopts;
      signal?.throwIfAborted();
      const toPath = "path" in output;
      const final = toPath ? resolve(output.path) : null;
      const written = final ? `${final}.${randomUUID().slice(0, 8)}.partial.mp4` : join(resolve(opts.tempDir ?? tmpdir()), `carton-proxy-${randomUUID()}.mp4`);
      await mkdir(dirname(written), { recursive: true });
      let bytes: number;
      try {
        await runFfmpeg(cmd, encodeArgs(codec, input.path, written, collabProfile(profile)), {
          signal,
          stallMs: opts.stallMs ?? STALL_MS,
          lowPriority: opts.lowPriority ?? true,
          onProgress,
        });
        if (final) {
          await renameWithRetry(written, final);
          bytes = (await stat(final)).size;
        } else {
          bytes = await pipeFileToSink(written, (output as { sink: WritableStream<Uint8Array> }).sink, signal);
        }
      } finally {
        // Gone after a rename; after a failure or a sink, the temporary file. Windows may hold a killed process's
        // handle for a moment: rm retries EBUSY/EPERM itself.
        await rm(written, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      }
      onProgress?.(1);
      return { bytes, durationMs: performance.now() - started };
    },
  };
}

/** The four ffmpeg encoders in chain order. Put the host-proxy encoder in front to reuse the editor's proxies. */
export function defaultEncoderChain(opts: FfmpegEncoderOptions = {}): FfmpegProxyEncoder[] {
  return CHAIN_ORDER.map((codec) => ffmpegEncoder(codec, opts));
}

export interface EncoderDescription {
  hardware: boolean;
  note: string;
}

/** What each encoder costs the machine, for settings and the activity log. */
export function describeEncoder(name: string): EncoderDescription {
  switch (name) {
    case "cardboard-proxy":
      return { hardware: false, note: "Reuses Cardboard's own proxy file: nothing is encoded." };
    case "h264_nvenc":
      return { hardware: true, note: `NVIDIA GPU encoder (NVENC), constant quality ${NVENC_CQ} capped at the profile's max rate. Decoding and scaling run on the CPU.` };
    case "h264_qsv":
      return { hardware: true, note: "Intel Quick Sync encoder (integrated GPU), VBR at the profile's rate and cap. Decoding and scaling run on the CPU." };
    case "h264_amf":
      return { hardware: true, note: "AMD GPU encoder (AMF), peak-constrained VBR. Decoding and scaling run on the CPU." };
    case "libx264":
      // The cost is stated, not hidden (PLAN §11). On the 4-core ARM dev box it took about 1 to 2 CPU-core-seconds per
      // second of 1080p30 footage (UNVERIFIED: an oversubscribed box, so CPU time rather than wall clock). The
      // measurement is carton/bench/media/x264-cost.ts; put a laptop figure here before users see a number.
      return {
        hardware: false,
        note: "Software encoder, used when no GPU encoder works. It is CPU-heavy: roughly a CPU core or two for as long as the clip runs, so proxies are made one at a time in the background.",
      };
    default:
      return { hardware: false, note: "Unknown encoder." };
  }
}
