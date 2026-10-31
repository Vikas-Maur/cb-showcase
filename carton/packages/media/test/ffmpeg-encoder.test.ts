// The ffmpeg encoders against the real ffmpeg on this box (libx264; NVENC is listed but there is no GPU), plus a fake
// ffmpeg (a Node script run as [node, fake.mjs, ...]) for what a real one can't be made to do on demand: a GPU encoder
// that passes its probe and then fails mid-encode, one that hangs, one that stalls.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeProxy, COLLAB_PROXY_720P, moovBeforeMdat } from "../src/proxy.ts";
import { clearProbeCache, encodeArgs, ffmpegEncoder, renameWithRetry } from "../src/node/ffmpeg-encoder.ts";
import { probeProxyFile } from "../src/node/host-proxy.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir } from "./helpers.ts";

const skip = haveFfmpeg() ? false : "ffmpeg is not installed";
const { dir, cleanup } = scratchDir("ffmpeg-encoder");
after(cleanup);

// Spaces and non-ASCII on both sides, as on a Windows user's disk.
const SRC_DIR = join(dir, "source clips é");
const OUT_DIR = join(dir, "proxies 名前");
let hd = "";
let fakeScript = "";

const FAKE_FFMPEG = String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const fake = {};
let i = 0;
for (; i < argv.length && argv[i].startsWith("--fake-"); i++) {
  const s = argv[i].slice(7), eq = s.indexOf("=");
  fake[s.slice(0, eq)] = s.slice(eq + 1);
}
const args = argv.slice(i);
const probe = args.includes("lavfi");
if (fake.log) appendFileSync(fake.log, JSON.stringify({ pid: process.pid, probe }) + "\n");
if (probe) {
  if (fake.probe === "fail") { process.stderr.write("[h264_nvenc @ 0x1] Cannot load nvcuda.dll\n"); process.exit(1); }
  process.exit(0);
}
writeFileSync(args[args.length - 1].replace(/^file:/, ""), "half a proxy");
process.stderr.write("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 900 kb/s\n");
let t = 0;
const tick = (advance) => {
  if (advance) t++;
  process.stdout.write("frame=" + t * 30 + "\ntotal_size=" + t * 1000 + "\nout_time_us=" + t * 1000000 + "\nprogress=continue\n");
};
if (fake.mode === "fail-mid") {
  tick(true); tick(true);
  setTimeout(() => {
    process.stderr.write("[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)\nError submitting video frame to the encoder\n");
    process.exit(1);
  }, 50);
} else if (fake.mode === "hang") {
  tick(true);
  setInterval(() => {}, 1000);
} else if (fake.mode === "stall") {
  tick(true);
  setInterval(() => tick(false), 50); // still reporting, never advancing: a hung GPU
}
`;

function fakeFfmpeg(...flags: string[]): string[] {
  return [process.execPath, fakeScript, ...flags];
}

function logLines(path: string): { pid: number; probe: boolean }[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Probed {
  streams: { codec_type: string; codec_name: string; profile?: string; width?: number; height?: number; pix_fmt?: string; channels?: number; side_data_list?: unknown[] }[];
  format: { tags?: Record<string, string> };
}

function ffprobe(path: string): Probed {
  return JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], { encoding: "utf8" }));
}

function videoSize(path: string): string {
  const v = ffprobe(path).streams.find((s) => s.codec_type === "video");
  return `${v?.width}x${v?.height}`;
}

/** Leftovers next to an output: partials or temporaries. */
function leftovers(d: string): string[] {
  return existsSync(d) ? readdirSync(d).filter((n) => /partial|carton-proxy-/.test(n)) : [];
}

const fileSource = (path: string) => {
  const bytes = new Uint8Array(readFileSync(path));
  return { size: bytes.length, read: async (o: number, n: number) => bytes.subarray(o, o + n) };
};

before(() => {
  if (skip) return;
  mkdirSync(SRC_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  fakeScript = join(dir, "fake-ffmpeg.mjs");
  writeFileSync(fakeScript, FAKE_FFMPEG);
  hd = makeClip(join(SRC_DIR, "camera clip 1080p.mp4"), { size: "1920x1080", seconds: 4 });
});

test("libx264 is available; NVENC is listed but has no GPU here, and QSV and AMF aren't built in", { skip }, async () => {
  clearProbeCache();
  assert.equal(await ffmpegEncoder("libx264", { ffmpeg: FFMPEG }).probe(), true);
  const listed = execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const maybeGpu = process.platform === "win32" || existsSync("/dev/nvidiactl");
  if (listed.includes("h264_nvenc") && !maybeGpu) {
    const nvenc = await ffmpegEncoder("h264_nvenc", { ffmpeg: FFMPEG }).probeDetail();
    assert.equal(nvenc.ok, false, "listed is not usable: only the test encode tells");
    assert.ok(nvenc.detail && nvenc.detail.length > 0, "the reason is kept for the log");
  }
  if (!listed.includes("h264_qsv")) assert.equal(await ffmpegEncoder("h264_qsv", { ffmpeg: FFMPEG }).probe(), false);
  if (!listed.includes("h264_amf")) assert.equal(await ffmpegEncoder("h264_amf", { ffmpeg: FFMPEG }).probe(), false);
  assert.equal(await ffmpegEncoder("libx264", { ffmpeg: join(dir, "no such ffmpeg") }).probe(), false, "a missing ffmpeg is unavailable, not a throw");
});

test("a 1080p source becomes a 720p faststart H.264/AAC MP4 with a keyframe at least every 2 s", { skip }, async () => {
  const out = join(OUT_DIR, "proxy ü 1.mp4");
  const seen: number[] = [];
  const enc = ffmpegEncoder("libx264", { ffmpeg: FFMPEG });
  assert.equal(enc.name, "libx264");
  assert.equal(enc.hardware, false);
  const r = await enc.encode({ path: hd }, { path: out }, COLLAB_PROXY_720P, { onProgress: (f) => seen.push(f) });

  assert.equal(r.bytes, statSync(out).size);
  assert.ok(r.durationMs > 0);
  assert.deepEqual(leftovers(OUT_DIR), [], "the partial was renamed into place");
  const p = ffprobe(out);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  assert.equal(v?.codec_name, "h264");
  assert.equal(v?.profile, "High");
  assert.equal(v?.pix_fmt, "yuv420p");
  assert.equal(`${v?.width}x${v?.height}`, "1280x720");
  assert.equal(a?.codec_name, "aac");
  assert.equal(a?.channels, 2);
  assert.equal(await moovBeforeMdat(fileSource(out)), true, "faststart");
  const facts = await probeProxyFile(out, { ffprobe: FFPROBE });
  assert.ok(facts?.bitrateKbps && facts.bitrateKbps < 2500 + 128 + 50, `about the profile's rate: ${facts?.bitrateKbps}`);

  // Keyframes from packet flags: at 0, then no gap over 2 s, and none longer than 2 s before the end.
  const packets = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-print_format", "json", out], { encoding: "utf8" })).packets as { pts_time: string; flags: string }[];
  const times = packets.map((x) => Number(x.pts_time)).sort((x, y) => x - y);
  const keys = packets.filter((x) => x.flags.includes("K")).map((x) => Number(x.pts_time)).sort((x, y) => x - y);
  assert.equal(keys[0], times[0], "starts on a keyframe");
  assert.ok(keys.length >= 2, `keyframes at ${keys}`);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i - 1] <= 2.001, `gap ${keys[i - 1]} → ${keys[i]}`);
  assert.ok(times[times.length - 1] - keys[keys.length - 1] <= 2.001, "no long tail without a keyframe");

  assert.ok(seen.length >= 2, `progress reported: ${seen}`);
  assert.equal(seen[seen.length - 1], 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] && seen[i] >= 0 && seen[i] <= 1, `non-decreasing: ${seen}`);
});

test("smaller sources aren't upscaled; portrait and rotated phone footage stay portrait; metadata is left out", { skip }, async () => {
  const enc = ffmpegEncoder("libx264", { ffmpeg: FFMPEG });
  const small = makeClip(join(SRC_DIR, "small.mp4"), { size: "640x360", seconds: 2 });
  await enc.encode({ path: small }, { path: join(OUT_DIR, "small.mp4") }, COLLAB_PROXY_720P);
  assert.equal(videoSize(join(OUT_DIR, "small.mp4")), "640x360");

  // A smaller target keeps these clips tiny; the rule is the same: the short side comes down to `height`.
  const p270 = { height: 270, bitrate: 600_000, codec: "h264", audio: "aac" } as const;
  const portrait = makeClip(join(SRC_DIR, "portrait.mp4"), { size: "540x960", seconds: 2 });
  await enc.encode({ path: portrait }, { path: join(OUT_DIR, "portrait.mp4") }, p270);
  assert.equal(videoSize(join(OUT_DIR, "portrait.mp4")), "270x480");

  // Phone footage: landscape pixels with a 90° display rotation, and a title that must not travel with the proxy.
  const rotated = join(SRC_DIR, "rotated.mp4");
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-display_rotation", "90", "-i", small, "-c", "copy", "-metadata", "title=private-title", rotated]);
  assert.equal(ffprobe(rotated).format.tags?.title, "private-title");
  await enc.encode({ path: rotated }, { path: join(OUT_DIR, "rotated.mp4") }, p270);
  const out = ffprobe(join(OUT_DIR, "rotated.mp4"));
  const v = out.streams.find((s) => s.codec_type === "video");
  assert.equal(`${v?.width}x${v?.height}`, "270x480", "upright pixels");
  assert.equal(v?.side_data_list, undefined, "no rotation left to apply");
  assert.equal(out.format.tags?.title, undefined, "the original's metadata stays behind");
});

test("each (ffmpeg, codec) is probed once per process", { skip }, async () => {
  const log = join(dir, "probe-count.log");
  const cmd = fakeFfmpeg(`--fake-log=${log}`);
  const a = ffmpegEncoder("h264_nvenc", { ffmpeg: cmd });
  assert.deepEqual(await Promise.all([a.probe(), a.probe()]), [true, true]);
  assert.equal(await ffmpegEncoder("h264_nvenc", { ffmpeg: cmd }).probe(), true, "another encoder object, same ffmpeg");
  assert.equal(logLines(log).length, 1);
  await ffmpegEncoder("h264_qsv", { ffmpeg: cmd }).probe();
  assert.equal(logLines(log).length, 2, "another codec is its own probe");
  clearProbeCache();
  await a.probe();
  assert.equal(logLines(log).length, 3, "probed again after the cache is cleared");
});

test("a GPU encoder that passes its probe but fails mid-encode falls back to the next one", { skip }, async () => {
  const out = join(OUT_DIR, "fallback.mp4");
  const src = makeClip(join(SRC_DIR, "fallback.mp4"), { size: "640x360", seconds: 2 });
  const chain = [ffmpegEncoder("h264_nvenc", { ffmpeg: fakeFfmpeg("--fake-mode=fail-mid") }), ffmpegEncoder("libx264", { ffmpeg: FFMPEG })];
  const r = await encodeProxy(chain, { path: src }, { path: out }, COLLAB_PROXY_720P);
  assert.equal(r.encoder, "libx264");
  assert.equal(r.hardware, false);
  assert.equal(r.attempts[0].encoder, "h264_nvenc");
  assert.equal(r.attempts[0].outcome, "failed");
  assert.match(r.attempts[0].error ?? "", /OpenEncodeSessionEx failed/);
  assert.deepEqual(r.attempts[1], { encoder: "libx264", outcome: "ok" });

  // An encoder whose probe fails is recorded as unavailable with ffmpeg's reason.
  const r2 = await encodeProxy(
    [ffmpegEncoder("h264_nvenc", { ffmpeg: fakeFfmpeg("--fake-probe=fail") }), ffmpegEncoder("libx264", { ffmpeg: FFMPEG })],
    { path: src }, { path: out }, COLLAB_PROXY_720P,
  );
  assert.deepEqual(r2.attempts[0], { encoder: "h264_nvenc", outcome: "unavailable", error: "[h264_nvenc @ 0x1] Cannot load nvcuda.dll" });
  assert.equal(videoSize(out), "640x360");
  assert.deepEqual(leftovers(OUT_DIR), []);
});

test("abort kills ffmpeg and leaves no partial output", { skip }, async () => {
  // Fake: we know its pid.
  const log = join(dir, "abort.log");
  const out = join(OUT_DIR, "aborted.mp4");
  const ac = new AbortController();
  const enc = ffmpegEncoder("libx264", { ffmpeg: fakeFfmpeg("--fake-mode=hang", `--fake-log=${log}`) });
  await assert.rejects(enc.encode({ path: hd }, { path: out }, COLLAB_PROXY_720P, { signal: ac.signal, onProgress: () => ac.abort() }), { name: "AbortError" });
  const run = logLines(log).find((l) => !l.probe);
  assert.ok(run);
  assert.equal(alive(run.pid), false, "the process is gone");
  assert.equal(existsSync(out), false);
  assert.deepEqual(leftovers(OUT_DIR), []);

  // Real ffmpeg, aborted at its first progress report.
  const realOut = join(OUT_DIR, "aborted real.mp4");
  const ac2 = new AbortController();
  await assert.rejects(
    ffmpegEncoder("libx264", { ffmpeg: FFMPEG }).encode({ path: hd }, { path: realOut }, COLLAB_PROXY_720P, { signal: ac2.signal, onProgress: () => ac2.abort() }),
    { name: "AbortError" },
  );
  assert.equal(existsSync(realOut), false);
  assert.deepEqual(leftovers(OUT_DIR), []);
  assert.notEqual(spawnSync("pgrep", ["-f", `${realOut}.partial`]).status, 0, "no ffmpeg still writing it");
});

test("an ffmpeg that stops advancing is killed and counts as failed", { skip }, async () => {
  const log = join(dir, "stall.log");
  const out = join(OUT_DIR, "stalled.mp4");
  const enc = ffmpegEncoder("h264_nvenc", { ffmpeg: fakeFfmpeg("--fake-mode=stall", `--fake-log=${log}`), stallMs: 400 });
  await assert.rejects(enc.encode({ path: hd }, { path: out }, COLLAB_PROXY_720P), /no progress for 0.4 s/);
  const run = logLines(log).find((l) => !l.probe);
  // On a loaded machine the fake (a node script) may take longer than stallMs to start, and be killed before it logs
  // its pid: then no process with its log path may be left.
  if (run) assert.equal(alive(run.pid), false, "the process is gone");
  else assert.notEqual(spawnSync("pgrep", ["-f", log]).status, 0, "no fake ffmpeg left running");
  assert.deepEqual(leftovers(OUT_DIR), []);
});

test("a Blob input is refused; a sink output gets the whole proxy and no temporary file is left", { skip }, async () => {
  const enc = ffmpegEncoder("libx264", { ffmpeg: FFMPEG, tempDir: join(dir, "tmp") });
  await assert.rejects(enc.encode({ blob: new Blob([new Uint8Array(4)]) }, { path: join(OUT_DIR, "blob.mp4") }, COLLAB_PROXY_720P), TypeError);

  const chunks: Uint8Array[] = [];
  let closed = false;
  const sink = new WritableStream<Uint8Array>({
    write: (c) => void chunks.push(c),
    close: () => void (closed = true),
  });
  const src = makeClip(join(SRC_DIR, "sink.mp4"), { size: "640x360", seconds: 2 });
  const r = await enc.encode({ path: src }, { sink }, COLLAB_PROXY_720P);
  const bytes = Buffer.concat(chunks);
  assert.ok(closed, "the sink is closed at the end");
  assert.equal(r.bytes, bytes.length);
  assert.equal(await moovBeforeMdat({ size: bytes.length, read: async (o, n) => bytes.subarray(o, o + n) }), true);
  assert.deepEqual(readdirSync(join(dir, "tmp")), [], "the temporary file is removed");
});

test("rename retries while Windows holds the target open, and only then", async () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  let calls = 0;
  await renameWithRetry("a", "b", { rename: async () => void (++calls < 3 && (() => { throw errno("EPERM"); })()) });
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(renameWithRetry("a", "b", { rename: async () => { calls++; throw errno("ENOENT"); } }), /ENOENT/);
  assert.equal(calls, 1, "other errors aren't retried");

  calls = 0;
  await assert.rejects(renameWithRetry("a", "b", { tries: 3, rename: async () => { calls++; throw errno("EBUSY"); } }), /EBUSY/);
  assert.equal(calls, 3);
});

test("encode arguments: files by file: URL, keyframes by time, no metadata, faststart", () => {
  const args = encodeArgs("libx264", "-odd name.mov", "out:put.mp4", COLLAB_PROXY_720P);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  // An absolute path after file:, POSIX or Windows (file:C:\...).
  assert.match(at("-i"), /^file:(\/|[A-Za-z]:\\).*-odd name\.mov$/);
  assert.match(args[args.length - 1], /^file:(\/|[A-Za-z]:\\).*out:put\.mp4$/);
  assert.equal(at("-force_key_frames"), "expr:gte(t,n_forced*2)");
  assert.equal(at("-maxrate"), "2500k");
  assert.equal(at("-bufsize"), "5000k");
  assert.equal(at("-b:a"), "128k");
  assert.equal(at("-map_metadata"), "-1");
  assert.equal(at("-movflags"), "+faststart");
});

// Review round 1, findings 2 and 6.
test("an audio-only source gets an AAC proxy, and two encodes of one output don't share a temporary file", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const dir = join(OUT_DIR, "audio");
  mkdirSync(dir, { recursive: true });
  const wav = join(dir, "voice.wav");
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", wav]);
  const out = join(dir, "voice.mp4");
  const enc = ffmpegEncoder("libx264", { ffmpeg: FFMPEG });
  // Both at once, to the same output: each writes its own partial, both rename into place.
  const [a, b] = await Promise.all([enc.encode({ path: wav }, { path: out }, COLLAB_PROXY_720P), enc.encode({ path: wav }, { path: out }, COLLAB_PROXY_720P)]);
  assert.ok(a.bytes > 0 && b.bytes > 0);
  const streams = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", out]).toString().trim();
  assert.equal(streams, "aac,audio");
  assert.deepEqual(leftovers(dir), []);
});
