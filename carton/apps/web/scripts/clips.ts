// The demo's sample media: four short clips the system ffmpeg generates from its own test sources (bars, a test card,
// a fractal, Conway's life), each with a tone, so the demo never touches anyone's footage. Each clip also gets the T1
// files the timeline shows (PLAN §11): a poster and a filmstrip sprite.
//
// Files are named by a digest of their recipe, so a second run with the same recipe reuses them and a changed recipe
// makes new ones. ffmpeg runs with an argument list, never through a shell (paths with spaces, Windows).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SampleClip {
  id: string;
  name: string;
  /** The MP4 (H.264 + AAC, moov first). */
  file: string;
  /** JPEG, the frame at 1 s, 320 px wide. */
  poster: string;
  /** JPEG, FILMSTRIP_FRAMES frames side by side, FILMSTRIP_HEIGHT px high. */
  filmstrip: string;
  /** Seconds, as ffprobe reports it. */
  duration: number;
  width: number;
  height: number;
}

export interface ClipOptions {
  /** The ffmpeg and ffprobe to run (default: $FFMPEG / $FFPROBE, else from PATH). */
  ffmpeg?: string;
  ffprobe?: string;
}

export const FILMSTRIP_FRAMES = 8;
export const FILMSTRIP_HEIGHT = 96;

// Bump when the encode settings below change, so cached files from the old settings aren't reused.
const RECIPE_VERSION = 1;
const SIZE = "640x360";
const FPS = 24;

// Distinct pictures and an A major chord across the four tones, so clips are easy to tell apart by eye and by ear.
const RECIPES = [
  { id: "bars", name: "Bars", video: `smptebars=s=${SIZE}:r=${FPS}`, tone: 440, seconds: 5 },
  { id: "testcard", name: "Test card", video: `testsrc2=s=${SIZE}:r=${FPS}`, tone: 554.37, seconds: 6 },
  { id: "fractal", name: "Fractal", video: `mandelbrot=s=${SIZE}:r=${FPS}:maxiter=512`, tone: 659.25, seconds: 7 },
  { id: "life", name: "Life", video: `life=s=${SIZE}:r=${FPS}:seed=7:ratio=0.2:mold=8:death_color=#202040:life_color=#ffcc33`, tone: 880, seconds: 8 },
] as const;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 << 20, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(-1)[0]}: ${err.message}\n${stderr}`.trim()));
      else resolve(stdout);
    });
  });
}

const exists = (p: string) => stat(p).then(
  (s) => s.size > 0,
  () => false,
);

// drawtext needs a font, and Windows builds of ffmpeg often find none without a fontfile: probe once, else no titles.
async function canDrawText(ffmpeg: string): Promise<boolean> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1", "-vf", "drawtext=text=A:fontsize=20", "-frames:v", "1", "-f", "null", "-"];
  return run(ffmpeg, args).then(
    () => true,
    () => false,
  );
}

function encodeArgs(r: (typeof RECIPES)[number], title: boolean, out: string): string[] {
  const filters = title ? ["-vf", `drawtext=text='${r.name}':fontsize=56:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-tw)/2:y=h-th-36`] : [];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", r.video,
    "-f", "lavfi", "-i", `sine=frequency=${r.tone}:sample_rate=48000`,
    "-t", String(r.seconds),
    ...filters,
    "-map", "0:v", "-map", "1:a",
    // A keyframe every second, so the timeline seeks and scrubs quickly.
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-g", String(FPS),
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    out,
  ];
}

const posterArgs = (src: string, out: string) => ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", "1", "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", out];

const filmstripArgs = (src: string, seconds: number, out: string) => [
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
  "-vf", `fps=${FILMSTRIP_FRAMES}/${seconds},scale=-2:${FILMSTRIP_HEIGHT},tile=${FILMSTRIP_FRAMES}x1`,
  "-frames:v", "1", "-q:v", "5", out,
];

async function probe(ffprobe: string, file: string): Promise<{ duration: number; width: number; height: number }> {
  const out = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json", file]);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { width?: number; height?: number }[] };
  const duration = Number(j.format?.duration);
  const { width = 0, height = 0 } = j.streams?.[0] ?? {};
  if (!(duration > 0) || !width || !height) throw new Error(`ffprobe could not read ${file}`);
  return { duration, width, height };
}

/** Generates the sample clips in `dir` (or reuses them) and describes them. */
export async function makeSampleClips(dir: string, opts: ClipOptions = {}): Promise<SampleClip[]> {
  const ffmpeg = opts.ffmpeg ?? process.env.FFMPEG ?? "ffmpeg";
  const ffprobe = opts.ffprobe ?? process.env.FFPROBE ?? "ffprobe";
  await mkdir(dir, { recursive: true });
  const title = await canDrawText(ffmpeg);
  const clips: SampleClip[] = [];
  // One clip at a time: the encodes are short, and the machine may be busy with other work.
  for (const r of RECIPES) {
    const tag = createHash("sha256")
      .update(JSON.stringify({ v: RECIPE_VERSION, r, title, encode: encodeArgs(r, title, "out.mp4") }))
      .digest("hex")
      .slice(0, 12);
    const base = join(dir, `${r.id}-${tag}`);
    const file = `${base}.mp4`, poster = `${base}.poster.jpg`, filmstrip = `${base}.filmstrip.jpg`;
    if (!(await exists(file)) || !(await exists(poster)) || !(await exists(filmstrip))) {
      // Written under temporary names and renamed into place, so an interrupted run never leaves a file that looks done.
      const tmp = `${base}.tmp-${process.pid}`;
      const parts = [`${tmp}.mp4`, `${tmp}.poster.jpg`, `${tmp}.filmstrip.jpg`];
      try {
        await run(ffmpeg, encodeArgs(r, title, parts[0]!));
        await run(ffmpeg, posterArgs(parts[0]!, parts[1]!));
        await run(ffmpeg, filmstripArgs(parts[0]!, r.seconds, parts[2]!));
        await rename(parts[1]!, poster);
        await rename(parts[2]!, filmstrip);
        await rename(parts[0]!, file);
      } finally {
        await Promise.all(parts.map((p) => rm(p, { force: true })));
      }
    }
    clips.push({ id: r.id, name: r.name, file, poster, filmstrip, ...(await probe(ffprobe, file)) });
  }
  return clips;
}
