// What the last link of the proxy chain costs: libx264 making the collab proxy (COLLAB_PROXY_720P) from 10 s 1080p30
// sources, with exactly the arguments ffmpegEncoder("libx264") builds (encodeArgs). PLAN §11 says the chain states the
// CPU cost of its software fallback; this is where that statement's number comes from.
//
//   node carton/bench/media/x264-cost.ts make <dir>                  the two sources (skipped if present)
//   node carton/bench/media/x264-cost.ts run <dir> <rounds> <out.jsonl>   every source each round, under the CPU lock
//   node carton/bench/media/x264-cost.ts one <source.mp4> <out.mp4>  one encode, one JSON line
//
// Sources (deterministic: lavfi test pattern, sine tone, seeded noise):
//   easy   testsrc2, 1920x1080, 30 fps, 10 s, x264 CRF 18 + AAC
//   grain  the same with seeded temporal noise (alls=40), much harder to compress
// CPU time comes from ffmpeg's own -benchmark line (user + system time of the ffmpeg process, all its threads), so it
// works the same on Windows. On a shared box wall-clock speed depends on the load; CPU time much less.
// Per run: cpuS, wallS, cpuPerFootageSecond (core-seconds per second of footage), xRealtime, the proxy's size and rate.
// Numbers are UNVERIFIED until an independent run reproduces them.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeArgs } from "../../packages/media/src/node/ffmpeg-encoder.ts";
import { COLLAB_PROXY_720P } from "../../packages/media/src/proxy.ts";
import { median, runRounds } from "./runner.ts";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";
const SECONDS = 10;
const SOURCES = {
  easy: [] as string[],
  grain: ["-vf", "noise=alls=40:allf=t+u:all_seed=1"],
};
type SourceName = keyof typeof SOURCES;

function make(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, filter] of Object.entries(SOURCES)) {
    const out = join(dir, `src-${name}-1080p30.mp4`);
    if (existsSync(out)) continue;
    execFileSync(FFMPEG, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
      ...filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "30",
      "-c:a", "aac", "-b:a", "128k", "-shortest", out,
    ], { stdio: "inherit" });
    console.log(`${out}: ${statSync(out).size} bytes`);
  }
}

function seconds(path: string): number {
  return Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).toString().trim());
}

function one(source: string, output: string): Record<string, unknown> {
  // -benchmark is a global option: it goes before everything encodeArgs builds.
  const args = ["-benchmark", ...encodeArgs("libx264", source, output, COLLAB_PROXY_720P)];
  const p = spawnSync(FFMPEG, args, { encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true });
  if (p.status !== 0) throw new Error(`ffmpeg exited ${p.status}: ${p.stderr.slice(-2000)}`);
  const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(p.stderr);
  if (!m) throw new Error("no -benchmark line in ffmpeg's output");
  const [utime, stime, rtime] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const footage = seconds(source);
  const outBytes = statSync(output).size;
  rmSync(output, { force: true });
  return {
    source: source.split(/[\\/]/).pop(),
    footageS: footage,
    cpuS: +(utime + stime).toFixed(3),
    wallS: rtime,
    cpuPerFootageSecond: +((utime + stime) / footage).toFixed(3),
    xRealtime: +(footage / rtime).toFixed(3),
    outBytes,
    outKbps: Math.round((outBytes * 8) / footage / 1000),
  };
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === "make") {
  make(resolve(a[0]));
} else if (cmd === "one") {
  console.log(JSON.stringify(one(resolve(a[0]), resolve(a[1]))));
} else if (cmd === "run") {
  const dir = resolve(a[0]);
  make(dir);
  const self = fileURLToPath(import.meta.url);
  const methods = (Object.keys(SOURCES) as SourceName[]).map((name) => ({
    id: name,
    cmd: [process.execPath, self, "one", join(dir, `src-${name}-1080p30.mp4`), join(dir, `out-${name}.mp4`)],
  }));
  const runs = runRounds(methods, Number(a[1]), a[2]);
  const summary: Record<string, unknown> = {};
  for (const name of Object.keys(SOURCES)) {
    const mine = runs.filter((r) => r.id === name);
    const field = (f: string) => mine.map((r) => r[f] as number);
    summary[name] = {
      cpuPerFootageSecond: { median: median(field("cpuPerFootageSecond")), runs: field("cpuPerFootageSecond") },
      xRealtime: { median: median(field("xRealtime")), runs: field("xRealtime") },
      outKbps: field("outKbps"),
    };
  }
  console.log(JSON.stringify(summary, null, 1));
} else {
  console.log("usage: x264-cost.ts make <dir> | run <dir> <rounds> <out.jsonl> | one <source.mp4> <out.mp4>");
}
