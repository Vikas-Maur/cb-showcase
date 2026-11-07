// Speech with no account: Piper (https://github.com/rhasspy/piper, MIT; its voices are CC BY / public-domain data, each
// voice's model card says which) on this box, text → WAV or MP3, offline. The fallback for `cb generate voice`, which
// speaks with ElevenLabs through a signed-in Cardboard account and its credits (FINDINGS.md §5).
//   node tts.js "<text>" [--voice ryan|lessac|amy|alan] [--speed 1.0] [--out file.wav|file.mp3]
// Piper and its voices live in $DEMO_TTS (default gfv-scratch/carton/demo/tts): piper-x/piper/piper and
// voices/<name>/<name>.onnx(.json). FINDINGS.md says how they were fetched.
const fs = require("fs"), path = require("path");
const { spawn, execFileSync } = require("child_process");
const { TTS } = require("./lib.js");

const VOICES = {
  ryan: "en_US-ryan-high", // US male, the high-quality model (slower to make)
  lessac: "en_US-lessac-medium", // US female
  amy: "en_US-amy-medium", // US female
  alan: "en_GB-alan-medium", // British male
};
const voiceFile = (v) => {
  const name = VOICES[v] ?? v;
  const f = path.join(TTS, "voices", name, name + ".onnx");
  if (!fs.existsSync(f)) throw new Error(`No voice "${v}" (${Object.keys(VOICES).join(", ")}): ${f}`);
  return f;
};

/** Speak `text` into `out` (.wav, or .mp3 through ffmpeg); resolves {file, seconds, ms}. */
function synth(text, { voice = "ryan", speed = 1, out, pause = 0.25 } = {}) {
  const piper = path.join(TTS, "piper-x", "piper", "piper");
  if (!fs.existsSync(piper)) throw new Error("Piper isn't installed at " + piper + " (FINDINGS.md §5)");
  if (!(speed >= 0.5 && speed <= 2)) throw new Error("--speed is 0.5 to 2");
  out = path.resolve(out ?? path.join(TTS, "out", `line-${Date.now()}.wav`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const wav = out.endsWith(".mp3") ? out.replace(/\.mp3$/, ".wav") : out;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    // length_scale is the inverse of speed; a short silence between sentences reads as breath
    const p = spawn(piper, ["--model", voiceFile(voice), "--output_file", wav, "--length_scale", String(1 / speed), "--sentence_silence", String(pause)], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error("Piper failed: " + err.split("\n").slice(-4).join(" ")));
      try {
        if (wav !== out) { execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "3", out]); fs.rmSync(wav, { force: true }); }
        const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
        resolve({ file: out, seconds, ms: Date.now() - t0, voice: VOICES[voice] ?? voice });
      } catch (e) { reject(e); }
    });
    p.stdin.end(String(text));
  });
}

module.exports = { synth, VOICES };

if (require.main === module) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf("--" + k); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
  const voice = opt("voice"), speed = opt("speed"), out = opt("out");
  synth(a.join(" "), { voice: voice ?? "ryan", speed: speed ? Number(speed) : 1, out })
    .then((r) => console.log(`${r.file}  ${r.seconds.toFixed(2)} s of speech (${r.voice}), made in ${(r.ms / 1000).toFixed(2)} s`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
