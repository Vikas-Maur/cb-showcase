// Test helpers: deterministic bytes, scratch directories, small generated media.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** xorshift32 words, little-endian, cut to n bytes. Same stream as the conformance vectors' Python generator. */
export function xorshiftBytes(n: number, seed: number): Uint8Array {
  const words = new Uint32Array(Math.ceil(n / 4));
  let x = seed >>> 0;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    words[i] = x;
  }
  return new Uint8Array(words.buffer, 0, n);
}

/** Scratch lives on disk, not in the small shared /tmp (COMMON.md). */
export const SCRATCH_ROOT = process.env.CARTON_MEDIA_SCRATCH ?? "/home/ubuntu/gfv-scratch/carton/media/test";

export function scratchDir(name: string): { dir: string; cleanup: () => void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, `${name}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE ?? "ffprobe";

export function haveFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A small test clip: lavfi test pattern plus a sine tone, H.264/AAC MP4. `faststart` puts moov first, like
 * Cardboard's proxies; without it moov is at the end, like camera files.
 */
export function makeClip(path: string, opts: { seconds?: number; size?: string; faststart?: boolean; kbps?: number } = {}): string {
  const args = [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${opts.size ?? "640x360"}:rate=30:duration=${opts.seconds ?? 4}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${opts.seconds ?? 4}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p",
    ...(opts.kbps ? ["-b:v", `${opts.kbps}k`, "-maxrate", `${opts.kbps}k`, "-bufsize", `${opts.kbps * 2}k`] : []),
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    ...(opts.faststart ? ["-movflags", "+faststart"] : []),
    path,
  ];
  execFileSync(FFMPEG, args, { stdio: "inherit" });
  return path;
}
