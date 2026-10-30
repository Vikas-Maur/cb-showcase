// Makes the clips the import benchmark drops on Cardboard (run.js). Synthetic, so anyone can make the same set, but
// with what decides how much work an import is: real footage's resolutions, codecs, bit depths, bitrates, keyframe
// spacing and rotation. Moving noise over the test pattern keeps the encoders spending bits as they would on camera
// footage, so the clips cost about as much to decode. Your own clips can be used instead (run.js --media).
//   node scripts/bench/media.js <out-dir> [--ffmpeg <path>] [--short]
// --ffmpeg defaults to the ffmpeg on PATH; Cardboard's own is in Cardboard\resources\bin. --short makes 3-second
// clips, for checking the kit itself. Writes media.json beside the clips: what each one is, with its SHA-256.
const { execFileSync } = require("child_process");
const crypto = require("crypto"), fs = require("fs"), path = require("path");

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : undefined; };
const out = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--ffmpeg");
if (!out) throw new Error("usage: node scripts/bench/media.js <out-dir> [--ffmpeg <path>] [--short]");
const ffmpeg = opt("ffmpeg") ?? "ffmpeg", ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"));
const short = argv.includes("--short");

const x265 = (rate, keyint) => ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-profile:v", "main10", "-tag:v", "hvc1",
  "-b:v", rate, "-x265-params", `keyint=${keyint}:min-keyint=${keyint}:log-level=error`];
const x264 = (rate, keyint) => ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-profile:v", "high", "-b:v", rate,
  "-g", String(keyint), "-keyint_min", String(keyint), "-sc_threshold", "0"];
const CLIPS = [
  // 4K HEVC 10-bit with a keyframe every second, as phones record: Cardboard makes a proxy (over 1920 px, 10-bit).
  { name: "a-4k30-hevc10-phone.mov", what: "4K30 HEVC 10-bit, 40 Mb/s, keyframe every 1 s (phone)", size: "3840x2160", fps: 30, secs: 30, video: x265("40M", 30), rate: 48000 },
  // The same, held upright: stored landscape with a 90° rotation, as phones store portrait video.
  { name: "b-4k30-hevc10-portrait.mov", what: "4K30 HEVC 10-bit, rotated 90° (phone, portrait)", size: "3840x2160", fps: 30, secs: 15, video: x265("40M", 30), rate: 48000, rotate: 90 },
  // 4K60 H.264 at 80 Mb/s, as action cameras record.
  { name: "c-4k60-h264-camera.mp4", what: "4K60 H.264, 80 Mb/s, keyframe every 1 s (action camera)", size: "3840x2160", fps: 60, secs: 20, video: x264("80M", 60), rate: 48000 },
  // 1080p H.264 with a keyframe every 10 s, as screen recorders write: no proxy, and too few keyframes for a filmstrip.
  { name: "d-1080p30-h264-screen.mp4", what: "1080p30 H.264, 8 Mb/s, keyframe every 10 s (screen recording)", size: "1920x1080", fps: 30, secs: 60, video: x264("8M", 300), rate: 44100 },
  // 1080p HEVC 10-bit: no larger than 1920 px, but 10-bit, so Cardboard makes a proxy.
  { name: "e-1080p30-hevc10.mov", what: "1080p30 HEVC 10-bit, 15 Mb/s, keyframe every 1 s", size: "1920x1080", fps: 30, secs: 30, video: x265("15M", 30), rate: 48000 },
  // Music, for a waveform.
  { name: "f-music.wav", what: "60 s stereo WAV, 44.1 kHz", secs: 60, rate: 44100 },
];

const run = (args) => execFileSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const sha256 = (file) => {
  const h = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
};

fs.mkdirSync(out, { recursive: true });
const made = [];
for (const c of CLIPS) {
  const secs = short ? 3 : c.secs, file = path.join(out, c.name), started = Date.now();
  process.stdout.write(`${c.name}: ${c.what}, ${secs} s … `);
  const tone = ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${c.rate}:duration=${secs}`];
  if (!c.size) {
    run([...tone, "-ac", "2", "-c:a", "pcm_s16le", file]);
  } else {
    const tmp = c.rotate ? file + ".tmp" + path.extname(file) : file;
    run(["-f", "lavfi", "-i", `testsrc2=size=${c.size}:rate=${c.fps}:duration=${secs},noise=alls=12:allf=t`, ...tone,
      "-map", "0:v", "-map", "1:a", ...c.video, "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest", tmp]);
    if (c.rotate) {
      // ffmpeg 7 and later take the rotation as -display_rotation (counter-clockwise); older ones as rotate metadata.
      try { run(["-display_rotation:v:0", String(-c.rotate), "-i", tmp, "-c", "copy", file]); }
      catch { run(["-i", tmp, "-c", "copy", "-metadata:s:v:0", `rotate=${c.rotate}`, file]); }
      fs.rmSync(tmp);
    }
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(1)} s`);
  made.push({ file: c.name, what: c.what, secs, bytes: fs.statSync(file).size, sha256: sha256(file) });
}
// Check what came out: codec, size, bit depth and rotation as Cardboard's probe will see them.
for (const m of made) {
  if (!/\.(mov|mp4)$/.test(m.file)) continue;
  try {
    const p = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate:stream_side_data=rotation", "-of", "json", path.join(out, m.file)], { encoding: "utf8" })).streams[0];
    m.probe = { codec: p.codec_name, width: p.width, height: p.height, pixFmt: p.pix_fmt, fps: p.r_frame_rate, rotation: p.side_data_list?.find((s) => "rotation" in s)?.rotation ?? 0 };
  } catch { /* no ffprobe beside this ffmpeg: media.json goes without it */ }
}
fs.writeFileSync(path.join(out, "media.json"), JSON.stringify({ made: new Date().toISOString(), short, clips: made }, null, 2) + "\n");
console.log(`\n${made.length} files in ${path.resolve(out)}`);
for (const m of made) console.log(`  ${m.file.padEnd(28)} ${(m.bytes / 1e6).toFixed(1).padStart(6)} MB  ${m.probe ? `${m.probe.codec} ${m.probe.width}x${m.probe.height} ${m.probe.pixFmt} ${m.probe.fps} rot ${m.probe.rotation}` : ""}`);
