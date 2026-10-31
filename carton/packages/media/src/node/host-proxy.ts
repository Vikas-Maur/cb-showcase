// The first encoder of the chain (PLAN §11 T2): reuse Cardboard's own proxy when it already suits range streaming, so
// most shared media costs no encode at all. Cardboard writes H.264 proxies with moov first; our Windows build encodes
// them with NVENC constant quality under a 12 Mb/s cap, so many come out under REUSE_MAX_KBPS.
//
// - `reusable(input)` is what the T2 pipeline calls first: it gets the path and uploads that file as it is.
// - `encode` is for callers that want the proxy at their own output: a hard link (no copy, no extra disk), else a
//   copy, else the bytes streamed into a sink. It declines with ProxyDeclinedError when the proxy doesn't qualify.
// - The host's file is opened only briefly (a few 16-byte reads, then one ffprobe): on Windows, a reader holding it
//   open would make Cardboard's own rename onto it fail with EPERM.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, link, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { MediaInput, MediaOutput, ProxyEncoder, ProxyProfile } from "@carton/core/plugins";
import { moovBeforeMdat, ProxyDeclinedError, reusableProxy, type ProxyFacts } from "../proxy.ts";
import { pipeFileToSink, renameWithRetry } from "./ffmpeg-encoder.ts";

export interface HostProxyDecision {
  /** The host proxy looked at; null when the host has none for this media. */
  path: string | null;
  ok: boolean;
  reason: string;
  facts?: ProxyFacts;
}

export interface HostProxyOptions {
  /** Where the host keeps its proxy for this media (the Cardboard adapter knows); null when it has none. */
  locate: (input: MediaInput) => Promise<string | null> | string | null;
  /** The ffprobe command, or a command and its leading arguments. */
  ffprobe?: string | readonly string[];
  /** ffprobe's limit, ms. */
  timeoutMs?: number;
  /** Every reuse decision, with its reason, for the activity log. */
  onDecide?: (decision: HostProxyDecision) => void;
}

export interface HostProxyEncoder extends ProxyEncoder {
  readonly name: "cardboard-proxy";
  /** The host proxy's path when it can be shared as the collab proxy as it is; null otherwise. Throws only on abort. */
  reusable(input: MediaInput, opts?: { signal?: AbortSignal }): Promise<string | null>;
}

const PROBE_TIMEOUT_MS = 15_000;

interface ProbeJson {
  format?: { bit_rate?: string; size?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; disposition?: { attached_pic?: number } }[];
}

function ffprobeJson(cmd: readonly string[], path: string, timeoutMs: number, signal?: AbortSignal): Promise<ProbeJson> {
  const args = [
    ...cmd.slice(1),
    "-v", "error", "-print_format", "json",
    "-show_entries", "format=bit_rate,size,duration:stream=codec_type,codec_name,width,height,pix_fmt:stream_disposition=attached_pic",
    `file:${path}`,
  ];
  return new Promise((done, fail) => {
    execFile(cmd[0], args, { windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL", signal }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr).trim().split(/\r?\n/).pop() || err.message;
        fail(err.name === "AbortError" ? err : new Error(`ffprobe failed: ${why}`));
        return;
      }
      try {
        done(JSON.parse(String(stdout)) as ProbeJson);
      } catch {
        fail(new Error("ffprobe gave unreadable output"));
      }
    });
  });
}

function positive(s: string | undefined): number | null {
  const n = s === undefined ? Number.NaN : Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether the file's moov comes before its mdat; null when the file doesn't exist. */
async function readMoovFirst(path: string): Promise<boolean | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const { size } = await fh.stat();
    return await moovBeforeMdat({
      size,
      read: async (offset, length) => {
        const buf = new Uint8Array(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      },
    });
  } finally {
    await fh.close();
  }
}

/** Probes an existing proxy file for the reuse rule. Null when the file doesn't exist. */
export async function probeProxyFile(
  path: string,
  opts: { ffprobe?: string | readonly string[]; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProxyFacts | null> {
  const moovFirst = await readMoovFirst(path);
  if (moovFirst === null) return null;
  if (!moovFirst) {
    // Not streamable whatever else it is, and a file the host is still writing has no moov yet: skip ffprobe.
    return { codec: null, bitrateKbps: null, longEdge: null, moovBeforeMdat: false, hasVideo: false };
  }
  const cmd = opts.ffprobe === undefined ? ["ffprobe"] : typeof opts.ffprobe === "string" ? [opts.ffprobe] : opts.ffprobe;
  const info = await ffprobeJson(cmd, path, opts.timeoutMs ?? PROBE_TIMEOUT_MS, opts.signal);
  const video = info.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const fmt = info.format ?? {};
  let bps = positive(fmt.bit_rate);
  if (bps === null) {
    const size = positive(fmt.size);
    const seconds = positive(fmt.duration);
    if (size !== null && seconds !== null) bps = (size * 8) / seconds;
  }
  return {
    codec: video?.codec_name ?? null,
    bitrateKbps: bps === null ? null : bps / 1000,
    longEdge: video?.width && video.height ? Math.max(video.width, video.height) : null,
    moovBeforeMdat: true,
    hasVideo: video !== undefined,
    pixFmt: video?.pix_fmt ?? null,
  };
}

/** Puts the host's file at `to`: a hard link where the file system allows one, else a copy. Atomic either way. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  // Its own temporary name: two processes sharing the same clip may place the same proxy at once.
  const partial = `${to}.${randomUUID().slice(0, 8)}.partial.mp4`;
  try {
    try {
      await link(from, partial);
    } catch {
      // Another volume (EXDEV), FAT/exFAT, or a share without links: copy instead.
      await copyFile(from, partial);
    }
    await renameWithRetry(partial, to);
  } finally {
    // Also after a "successful" rename: when `to` is already a link to the same file, POSIX rename does nothing and
    // leaves the partial in place.
    await rm(partial, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

/** Shares Cardboard's proxy as the collab proxy when `reusableProxy` accepts it; declines otherwise. */
export function hostProxyEncoder(opts: HostProxyOptions): HostProxyEncoder {
  // The decision, with its reason: reusable() reports a path, encode() a decline's reason.
  const check = async (input: MediaInput, signal?: AbortSignal): Promise<HostProxyDecision> => {
    signal?.throwIfAborted();
    let d: HostProxyDecision;
    try {
      const located = await opts.locate(input);
      if (!located) {
        d = { path: null, ok: false, reason: "Cardboard has no proxy for this media" };
      } else {
        const path = resolve(located);
        const facts = await probeProxyFile(path, { ffprobe: opts.ffprobe, timeoutMs: opts.timeoutMs, signal });
        if (!facts) d = { path, ok: false, reason: "Cardboard's proxy file doesn't exist (yet)" };
        else d = { path, ...reusableProxy(facts), facts };
      }
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if ((e as { name?: unknown } | null)?.name === "AbortError") throw e;
      // A proxy we can't read is a proxy we don't reuse; the chain encodes one instead.
      d = { path: null, ok: false, reason: `couldn't check Cardboard's proxy: ${e instanceof Error ? e.message : String(e)}` };
    }
    opts.onDecide?.(d);
    return d;
  };

  return {
    name: "cardboard-proxy",
    hardware: false,
    probe: async () => true,
    reusable: async (input, ropts) => {
      const d = await check(input, ropts?.signal);
      return d.ok ? d.path : null;
    },
    async encode(input: MediaInput, output: MediaOutput, _profile: ProxyProfile, eopts = {}) {
      const started = performance.now();
      const { signal } = eopts;
      const d = await check(input, signal);
      if (!d.ok || !d.path) throw new ProxyDeclinedError(d.reason);
      signal?.throwIfAborted();
      let bytes: number;
      if ("path" in output) {
        const to = resolve(output.path);
        await linkOrCopy(d.path, to);
        bytes = (await stat(to)).size;
      } else {
        bytes = await pipeFileToSink(d.path, output.sink, signal);
      }
      eopts.onProgress?.(1);
      return { bytes, durationMs: performance.now() - started };
    },
  };
}
