// Helpers the media patches add to Cardboard's library code: the app's library worker (patch-worker.js)
// and the copy the CLI runs in-process (patch-cli-media.js). Both bundles name ffmpeg failures ToolError.
module.exports = String.raw`var __cbWin = process.platform === "win32";
// Hardware video encoding: Apple's VideoToolbox on macOS, NVIDIA NVENC on Windows.
var __cbHwEnc = __cbWin ? { h264: "h264_nvenc", hevc: "hevc_nvenc" } : { h264: "h264_videotoolbox", hevc: "hevc_videotoolbox" };
// -allow_sw is VideoToolbox-only. NVENC gets a balanced preset, and IDR keyframes so proxies seek cleanly.
var __cbHwOpts = __cbWin ? ["-preset", "p4", "-forced-idr", "1"] : ["-allow_sw", "1"];
// Proxies: Cardboard asks the hardware encoder for a set bitrate, which is what VideoToolbox needs: 1.4.0 asked
// for a fixed 12 Mb/s (6 Mb/s for cloud proxies); 1.5.0 asks for 1.5 times the source's bitrate, between a third
// of that and that ("8000k"). NVENC has a constant-quality mode, which spends bits where the picture needs them,
// with that rate as the cap. At CQ 30, with lanczos scaling on the GPU, proxies of two 4K clips came out
// smaller than the CPU path's (libx264 CRF 20) and scored higher (VMAF against the 4K source: 95.3 and 94.9
// against 92.4 and 91.1), where 12 Mb/s made them 5 to 14 times the size (measured on 1.4.0's fixed rate).
// The buffer is two seconds at the cap, in the rate's own unit ("12M" → "24M", "8000k" → "16000k").
var __cbProxyRate = (rate) => __cbWin ? ["-rc", "vbr", "-cq", "30", "-b:v", "0", "-maxrate", rate, "-bufsize", Number.parseFloat(rate) * 2 + String(rate).replace(/^[\d.]+/, "")] : ["-b:v", rate];
// A clip's background work after an import (filmstrip, waveform, proxy, and the saves that record them)
// reports a failure as that clip's background error, as Cardboard does for a failed proxy, and never
// rejects. The import's completion waits on all of it, and only then does the worker tell main the import
// is done. A failed save rejected it, so main waited for that import forever and Cardboard couldn't quit:
// its window closed and the process stayed.
var __cbSettled = (work, item, opts) => work.catch((e) => {
  opts.onBackgroundError?.({ mediaId: item.mediaId, fileName: item.fileName, message: e instanceof Error ? e.message : String(e) });
});
// Notes for the app's activity log, which gets the library worker's output (patch-main.js). Only in the
// worker: the CLI runs this code too, and the agent reads what it prints.
var __cbMediaNote = (msg) => { if (process.parentPort) console.log("[media] " + msg); };
var __cbFirstLine = (e) => String(e?.stderr || e?.message || e).trim().split(/\r?\n/).pop().slice(0, 300);
// The Windows ffmpeg lists NVENC even without an NVIDIA GPU, so test-encode a few frames once per encoder.
var __cbHwSeen = new Map();
var __cbHwProbe = (ffmpeg, enc) => {
  const key = ffmpeg + "\0" + enc;
  let p = __cbHwSeen.get(key);
  if (!p) {
    const fmt = /^hevc/.test(enc) ? ["-profile:v", "main10", "-pix_fmt", "p010le"] : ["-profile:v", "high", "-pix_fmt", "yuv420p"];
    p = new Promise((res) => require("child_process").execFile(ffmpeg,
      ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:r=30:d=0.2", "-c:v", enc, ...fmt, "-f", "null", "-"],
      { windowsHide: true, timeout: 15000 }, (e) => { __cbMediaNote(enc + (e ? " is not usable, encoding in software: " + __cbFirstLine(e) : " works")); res(!e); }));
    __cbHwSeen.set(key, p);
  }
  return p;
};
// NVIDIA GPU decoding (NVDEC). The Windows ffmpeg accepts -hwaccel cuda on any machine and only fails
// once it opens the device, so check once that a CUDA device opens.
var __cbCudaSeen = new Map();
var __cbCuda = (ffmpeg) => {
  let p = __cbCudaSeen.get(ffmpeg);
  if (!p) {
    p = new Promise((res) => require("child_process").execFile(ffmpeg,
      ["-hide_banner", "-v", "error", "-init_hw_device", "cuda", "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.04", "-f", "null", "-"],
      { windowsHide: true, timeout: 15000 }, (e) => { __cbMediaNote(e ? "no CUDA device, decoding on the CPU: " + __cbFirstLine(e) : "CUDA decoding works"); res(!e); }));
    __cbCudaSeen.set(ffmpeg, p);
  }
  return p;
};
// Runs an ffmpeg step decoding on the GPU, then again on the CPU (after undo) if that ffmpeg run fails.
var __cbCudaFirst = async (ffmpeg, run, undo) => {
  if (__cbWin && (await __cbCuda(ffmpeg))) {
    try {
      return await run(true);
    } catch (e) {
      if (e?.name !== "ToolError") throw e;
      __cbMediaNote("GPU decoding failed, retrying on the CPU: " + __cbFirstLine(e));
      await undo();
    }
  }
  return run(false);
};
// Proxy input decoded on the GPU. Frames stay there to be scaled (scale_cuda), except for rotated
// sources: ffmpeg only applies the rotation to frames in system memory, so those come back to be scaled.
var __cbProxyOnGpu = (mode, probe) => mode === "cuda" && !probe.rotation;
var __cbProxyIn = (mode, probe) => mode !== "cuda" ? [] : __cbProxyOnGpu(mode, probe) ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] : ["-hwaccel", "cuda"];
// Longest gap between keyframes in the first 30 s, from packet flags (nothing is decoded). Infinity when
// unknown, or when the first keyframe is not at the start.
var __cbKeyGap = (ffprobe, file) => new Promise((res) => require("child_process").execFile(ffprobe,
  ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+30", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file],
  { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (e, out) => {
    if (e) return res(Infinity);
    let start = Infinity, end = -Infinity;
    const keys = [];
    for (const line of String(out).split(/\r?\n/)) {
      const [pts, flags] = line.split(",");
      const t = Number.parseFloat(pts);
      if (!Number.isFinite(t)) continue;
      start = Math.min(start, t);
      end = Math.max(end, t);
      if (flags?.startsWith("K")) keys.push(t);
    }
    keys.sort((a, b) => a - b);
    if (keys.length === 0 || keys[0] - start > 0.25) return res(Infinity);
    let gap = end - keys[keys.length - 1];
    for (let i = 1; i < keys.length; i++) gap = Math.max(gap, keys[i] - keys[i - 1]);
    res(gap);
  }));
// Timeline filmstrip. Cardboard decodes every frame to keep one per half or whole second, which for 4K
// HEVC takes about as long as the clip runs. When keyframes come at least every 2 s, decode only those.
// Otherwise decode every frame, on the GPU when there is one. run(inputArgs, fpsOptions) runs ffmpeg.
var __cbStrip = async (ffmpeg, ffprobe, file, dir, count, run) => {
  const fsp = require("fs/promises"), path = require("path");
  const jpgs = async () => (await fsp.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  const clear = async () => { for (const f of await jpgs()) await fsp.rm(path.join(dir, f), { force: true }); };
  if (ffprobe && (await __cbKeyGap(ffprobe, file)) <= 2) {
    try {
      // eof_action=pass keeps the last keyframe: by default the fps filter can drop it at the end.
      await run(["-skip_frame", "nokey"], ":eof_action=pass");
      const done = await jpgs();
      if (done.length > 0) {
        // The strip stops at the last keyframe, so it can end a thumbnail or two short. Repeat the last one.
        for (let n = done.length + 1; n <= count; n++) await fsp.copyFile(path.join(dir, done[done.length - 1]), path.join(dir, String(n).padStart(6, "0") + ".jpg"));
        return;
      }
    } catch (e) {
      if (e?.name !== "ToolError") throw e;
      __cbMediaNote("keyframe filmstrip failed, decoding every frame: " + __cbFirstLine(e));
    }
    await clear();
  }
  await __cbCudaFirst(ffmpeg, (gpu) => run(gpu ? ["-hwaccel", "cuda"] : []), clear);
};
`;
