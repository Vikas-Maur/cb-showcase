// The segment encoder against the real ffmpeg on this box (libx264 and "copy"; no GPU here), small clips only. A fake
// ffmpeg (a Node script run as [node, fake.mjs]) stands in for one that hangs without progress.
//
// `-readrate` in front of ffmpeg's own arguments (the command prefix) holds the input to a few times real time, so a
// few-second clip takes long enough to see segments arrive while ffmpeg is still running.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { COLLAB_PROXY_720P, collabProfile } from "../src/proxy.ts";
import { clearProbeCache, ffmpegEncoder } from "../src/node/ffmpeg-encoder.ts";
import { encodeSegments, parsePlaylist, segmentArgs, SEGMENT_PLAYLIST, type SegmentInfo } from "../src/node/segment-encoder.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir } from "./helpers.ts";

const skip = haveFfmpeg() ? false : "ffmpeg is not installed";
const { dir, cleanup } = scratchDir("segment-encoder");
after(cleanup);

// Spaces, non-ASCII and a printf pattern in the folder names, as a Windows user's disk may have.
const SRC_DIR = join(dir, "source clips é");
let clip6 = ""; // 6 s, 640x360, H.264/AAC, 1 s GOP, faststart
let clip20 = ""; // 20 s, 160x90: long enough to stop ffmpeg halfway
let audioOnly = "";

before(() => {
  if (skip) return;
  mkdirSync(SRC_DIR, { recursive: true });
  clip6 = makeClip(join(SRC_DIR, "six seconds.mp4"), { seconds: 6, faststart: true });
  clip20 = makeClip(join(SRC_DIR, "twenty seconds.mp4"), { seconds: 20, size: "160x90" });
  audioOnly = join(SRC_DIR, "tone only.m4a");
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=5", "-c:a", "aac", audioOnly]);
});

const slowed = (rate: number): string[] => [FFMPEG, "-readrate", String(rate)];

interface Delivery {
  init: string | null;
  initBeforeFirst: boolean;
  segments: SegmentInfo[];
  /** Per segment: whether ffmpeg was still writing the playlist (no #EXT-X-ENDLIST yet) when it was delivered. */
  whileRunning: boolean[];
}

function recorder(streamDir: string, onSeg?: (s: SegmentInfo) => Promise<void>) {
  const d: Delivery = { init: null, initBeforeFirst: false, segments: [], whileRunning: [] };
  return {
    d,
    onInit: async (path: string) => {
      assert.equal(d.init, null, "onInit twice");
      d.init = path;
      d.initBeforeFirst = d.segments.length === 0;
      assert.ok(readFileSync(path).length > 0);
    },
    onSegment: async (s: SegmentInfo) => {
      const pl = readFileSync(join(streamDir, SEGMENT_PLAYLIST), "utf8");
      d.whileRunning.push(!pl.includes("#EXT-X-ENDLIST"));
      d.segments.push(s);
      assert.ok(existsSync(s.path), `${s.path} is on disk`);
      await onSeg?.(s);
    },
  };
}

/** init + segments as one file, the way the stream's range source serves it. */
function concat(d: Delivery, out: string): string {
  writeFileSync(out, Buffer.concat([readFileSync(d.init!), ...d.segments.map((s) => readFileSync(s.path))]));
  return out;
}

function probe(path: string): { streams: { codec_type: string; codec_name: string; width?: number; height?: number; nb_read_packets?: string }[]; format: { duration: string } } {
  return JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_packets", "-show_entries", "format=duration", "-of", "json", path], { encoding: "utf8" }));
}

/** Whether the first video packet of init + this one segment is a keyframe. */
function startsOnKeyframe(init: string, seg: string, out: string): boolean {
  writeFileSync(out, Buffer.concat([readFileSync(init), readFileSync(seg)]));
  const flags = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "packet=flags", "-of", "csv=p=0", out], { encoding: "utf8" });
  return flags.trim().split("\n")[0].startsWith("K");
}

test("segmentArgs: relative outputs (ffmpeg runs in the folder), forced keyframes per segment, copy remuxes only", () => {
  const a = segmentArgs("libx264", "/clips/a b.mp4", COLLAB_PROXY_720P, 2);
  assert.ok(a.includes("file:/clips/a b.mp4") || a.some((x) => x.startsWith("file:") && x.endsWith("a b.mp4")));
  assert.deepEqual(a.slice(-4), ["-hls_segment_filename", "seg_%06d.m4s", "-y", "index.m3u8"]);
  assert.equal(a[a.indexOf("-hls_fmp4_init_filename") + 1], "init.mp4");
  assert.equal(a[a.indexOf("-force_key_frames") + 1], "expr:gte(t,n_forced*2)");
  assert.equal(a[a.indexOf("-hls_time") + 1], "2");
  assert.equal(a[a.indexOf("-b:a") + 1], "128k");
  assert.ok(a.includes("-vf"));
  const c = segmentArgs("copy", "x.mp4", COLLAB_PROXY_720P, 4);
  assert.equal(c[c.indexOf("-c") + 1], "copy");
  assert.ok(!c.includes("-vf") && !c.includes("-force_key_frames") && !c.includes("-c:v"));
  assert.equal(c[c.indexOf("-hls_time") + 1], "4");
  assert.throws(() => segmentArgs("libx264", "x.mp4", COLLAB_PROXY_720P, 0), RangeError);
});

test("parsePlaylist counts only whole lines", () => {
  const text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000000,\nseg_000000.m4s\n#EXTINF:1.966667,\nseg_000001.m4s\n#EXTINF:2.0,\nseg_0000";
  assert.deepEqual(parsePlaylist(text), [
    { name: "seg_000000.m4s", durationSec: 2 },
    { name: "seg_000001.m4s", durationSec: 1.966667 },
  ]);
});

test("libx264: init then ~2 s segments, in order, while ffmpeg runs; together one fMP4 with a keyframe at each cut", { skip }, async () => {
  const streamDir = join(dir, "stream 100% %06d é 名前");
  const r = recorder(streamDir);
  const progress: number[] = [];
  // 240p, so the scale filter visibly applies to the 640x360 source.
  const profile = collabProfile({ ...COLLAB_PROXY_720P, height: 240 });
  const res = await encodeSegments({ input: clip6, dir: streamDir, profile, codec: "libx264", ffmpeg: slowed(4), onInit: r.onInit, onSegment: r.onSegment, onProgress: (f) => progress.push(f) });
  const { d } = r;
  assert.ok(d.initBeforeFirst);
  assert.ok(d.segments.length >= 3 && d.segments.length <= 4, `${d.segments.length} segments`);
  assert.deepEqual(d.segments.map((s) => s.index), d.segments.map((_, i) => i));
  assert.equal(res.segments, d.segments.length);
  const total = d.segments.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(Math.abs(total - 6) < 0.25, `durations sum to ${total}`);
  assert.ok(Math.abs(res.durationSec - total) < 1e-9);
  for (const s of d.segments.slice(0, -1)) assert.ok(Math.abs(s.durationSec - 2) < 0.1, `segment ${s.index}: ${s.durationSec} s`);
  // Every segment but the last (made at the trailer) reached the callback before ffmpeg finished.
  assert.ok(d.whileRunning.slice(0, -1).every(Boolean), `delivered while running: ${d.whileRunning.join(",")}`);
  // Progress: in [0, 1], never backwards, ends at 1.
  assert.ok(progress.length >= 2);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.ok(progress.every((f) => f >= 0 && f <= 1));
  assert.equal(progress.at(-1), 1);

  const all = probe(concat(d, join(dir, "x264 whole.mp4")));
  const v = all.streams.find((s) => s.codec_type === "video")!;
  const a = all.streams.find((s) => s.codec_type === "audio")!;
  assert.equal(v.codec_name, "h264");
  assert.equal(a.codec_name, "aac");
  assert.equal(Math.min(v.width!, v.height!), 240);
  assert.equal(v.width, 426);
  assert.equal(Number(v.nb_read_packets), 180); // every frame of 6 s at 30 fps
  assert.ok(Math.abs(Number(all.format.duration) - 6) < 0.25, `duration ${all.format.duration}`);
  for (const s of d.segments) assert.ok(startsOnKeyframe(d.init!, s.path, join(dir, `k${s.index}.mp4`)), `segment ${s.index} starts on a keyframe`);
});

test("copy: remuxes a faststart H.264 clip with a 1 s GOP into segments, no re-encode", { skip }, async () => {
  const streamDir = join(dir, "copy é");
  const r = recorder(streamDir);
  const res = await encodeSegments({ input: clip6, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "copy", ffmpeg: FFMPEG, onInit: r.onInit, onSegment: r.onSegment });
  assert.equal(res.segments, 3);
  assert.ok(Math.abs(res.durationSec - 6) < 0.25, `${res.durationSec} s`);
  const all = probe(concat(r.d, join(dir, "copy whole.mp4")));
  const v = all.streams.find((s) => s.codec_type === "video")!;
  assert.equal(v.codec_name, "h264");
  assert.equal(v.width, 640); // not scaled: copied
  assert.equal(Number(v.nb_read_packets), 180);
  assert.equal(all.streams.find((s) => s.codec_type === "audio")?.codec_name, "aac");
  for (const s of r.d.segments) assert.ok(startsOnKeyframe(r.d.init!, s.path, join(dir, `ck${s.index}.mp4`)));
});

test("an audio-only source makes AAC-only segments", { skip }, async () => {
  const streamDir = join(dir, "audio only");
  const r = recorder(streamDir);
  const res = await encodeSegments({ input: audioOnly, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "libx264", ffmpeg: FFMPEG, onInit: r.onInit, onSegment: r.onSegment });
  assert.ok(res.segments >= 2, `${res.segments} segments`);
  assert.ok(Math.abs(res.durationSec - 5) < 0.25, `${res.durationSec} s`);
  const all = probe(concat(r.d, join(dir, "audio whole.mp4")));
  assert.deepEqual(all.streams.map((s) => s.codec_name), ["aac"]);
  assert.ok(Math.abs(Number(all.format.duration) - 5) < 0.25);
});

test("a slow onSegment (a slow upload) still gets every segment exactly once, in order", { skip }, async () => {
  const streamDir = join(dir, "slow");
  let busy = false;
  const r = recorder(streamDir, async () => {
    assert.ok(!busy, "two callbacks at once");
    busy = true;
    await new Promise((res) => setTimeout(res, 300));
    busy = false;
  });
  const res = await encodeSegments({ input: clip6, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "copy", segmentSeconds: 1, ffmpeg: slowed(8), onInit: r.onInit, onSegment: r.onSegment });
  assert.equal(res.segments, 6);
  assert.deepEqual(r.d.segments.map((s) => s.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(r.d.segments.map((s) => s.path)).size, 6);
  assert.ok(Math.abs(res.durationSec - 6) < 0.25);
  // ffmpeg (0.75 s at 8x) finished long before the 1.8 s of callbacks: the rest came from the final playlist.
  assert.ok(r.d.whileRunning.includes(false));
  assert.equal(Number(probe(concat(r.d, join(dir, "slow whole.mp4"))).streams.find((s) => s.codec_type === "video")!.nb_read_packets), 180);
});

/** Segment files in a folder, finished or not. */
const segFiles = (d: string): string[] => readdirSync(d).filter((n) => n.startsWith("seg_"));

test("a throwing onSegment stops ffmpeg and rejects with that error", { skip }, async () => {
  const streamDir = join(dir, "throws");
  const boom = new Error("upload refused");
  const started = Date.now();
  let calls = 0;
  await assert.rejects(
    encodeSegments({
      input: clip20, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "libx264", ffmpeg: slowed(2),
      onInit: async () => {},
      onSegment: async () => {
        calls++;
        throw boom;
      },
    }),
    (e) => e === boom,
  );
  assert.equal(calls, 1);
  // At 2x the 20 s clip takes 10 s; killed after the first segment, it stops well before.
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  const files = segFiles(streamDir);
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(segFiles(streamDir), files, "ffmpeg kept writing after the rejection");
  assert.ok(!readFileSync(join(streamDir, SEGMENT_PLAYLIST), "utf8").includes("#EXT-X-ENDLIST"));
});

test("abort kills ffmpeg and rejects with the signal's reason, also before it starts", { skip }, async () => {
  const streamDir = join(dir, "abort");
  const ac = new AbortController();
  const why = new Error("user cancelled the share");
  const started = Date.now();
  await assert.rejects(
    encodeSegments({
      input: clip20, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "libx264", ffmpeg: slowed(2), signal: ac.signal,
      onInit: async () => {},
      onSegment: async () => ac.abort(why),
    }),
    (e) => e === why,
  );
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  const files = segFiles(streamDir);
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(segFiles(streamDir), files, "ffmpeg kept writing after the abort");

  const pre = new AbortController();
  pre.abort(why);
  await assert.rejects(
    encodeSegments({ input: clip6, dir: join(dir, "pre"), profile: COLLAB_PROXY_720P, codec: "copy", ffmpeg: FFMPEG, signal: pre.signal, onInit: async () => {}, onSegment: async () => {} }),
    (e) => e === why,
  );
});

test("an ffmpeg that makes no progress is killed after stallMs; a failing ffmpeg rejects with its error", { skip }, async () => {
  const fake = join(dir, "hang.mjs");
  writeFileSync(fake, "setInterval(() => {}, 1000);\n");
  await assert.rejects(
    encodeSegments({ input: clip6, dir: join(dir, "stall"), profile: COLLAB_PROXY_720P, codec: "libx264", ffmpeg: [process.execPath, fake], stallMs: 400, onInit: async () => {}, onSegment: async () => {} }),
    /no progress/,
  );
  await assert.rejects(
    encodeSegments({ input: join(SRC_DIR, "missing.mp4"), dir: join(dir, "missing"), profile: COLLAB_PROXY_720P, codec: "copy", ffmpeg: FFMPEG, onInit: async () => {}, onSegment: async () => {} }),
    /ffmpeg exited with/,
  );
});

test("a stale playlist in the folder is not delivered", { skip }, async () => {
  const streamDir = join(dir, "stale");
  mkdirSync(streamDir, { recursive: true });
  writeFileSync(join(streamDir, SEGMENT_PLAYLIST), "#EXTM3U\n#EXTINF:9.0,\nseg_000000.m4s\n#EXTINF:9.0,\nseg_000001.m4s\n#EXTINF:9.0,\nseg_000002.m4s\n#EXTINF:9.0,\nseg_000003.m4s\n#EXT-X-ENDLIST\n");
  writeFileSync(join(streamDir, "keep.txt"), "not ours");
  const r = recorder(streamDir);
  const res = await encodeSegments({ input: clip6, dir: streamDir, profile: COLLAB_PROXY_720P, codec: "copy", ffmpeg: FFMPEG, onInit: r.onInit, onSegment: r.onSegment });
  assert.equal(res.segments, 3);
  assert.ok(r.d.segments.every((s) => s.durationSec < 3));
  assert.ok(existsSync(join(streamDir, "keep.txt")));
});

test("GPU encoders report unavailable through the existing probe on a box without a GPU", { skip }, async () => {
  clearProbeCache();
  for (const codec of ["h264_nvenc", "h264_qsv", "h264_amf"] as const) {
    const r = await ffmpegEncoder(codec, { ffmpeg: FFMPEG }).probeDetail();
    assert.equal(r.ok, false, `${codec} probed ok on a box without a GPU`);
  }
});
