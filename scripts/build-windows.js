// Builds the Windows app from scratch into <out>\Cardboard-win: the Windows Electron that Cardboard 1.5.0 is
// built on, Cardboard's app code from its macOS installer with every patch applied, and Windows builds of the
// tools it bundles (ffmpeg, ffprobe, uv, Claude Code). Runs on Windows (7-Zip, tar, PowerShell); the GitHub
// workflow .github/workflows/build-windows.yml runs it.
//   node scripts/build-windows.js [--out <dir>] [--baseline] [--no-carton]   (default out)
// --baseline builds the baseline the benchmarks compare against (scripts/bench): the media patches leave out their
// speed changes (CB_BASELINE=1, see patch-worker.js), so the app runs Cardboard's own pipeline as a Mac does.
// Carton (version history, cuts, fold in, credits; carton/docs/INTEGRATION-1.5.0.md) is built in and on by default;
// starting the app with CARDBOARD_CARTON=0 turns it off. --no-carton leaves it out of the build entirely, and so does
// --baseline.
// Everything it starts from is downloaded into dl\ when missing, from where its makers publish it.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const argOut = process.argv.indexOf("--out");
const OUT = path.resolve(ROOT, argOut > 0 ? process.argv[argOut + 1] : "out");
const APP = path.join(OUT, "Cardboard-win"), WORK = path.join(OUT, "work"), RES = path.join(APP, "resources");
const BASELINE = process.argv.includes("--baseline");
const CARTON = !BASELINE && !process.argv.includes("--no-carton");
const SYNC = CARTON && fs.existsSync(path.join(ROOT, "scripts", "patch-carton-sync.js"));
// The patch scripts read it from the environment they inherit.
if (BASELINE) process.env.CB_BASELINE = "1";
const INPUTS = {
  // Cardboard's macOS installer, the version the patches are written against. cardboard.ai/desktop/download
  // links the newest one (/desktop/download/stable); each version stays at its own address.
  cardboard: { file: "dl/Cardboard-1.5.0-arm64.dmg", url: "https://assets.cardboard.ai/desktop/releases/1.5.0/Cardboard-1.5.0-arm64.dmg" },
  electron: { file: "dl/electron/electron-v43.7.0-win32-x64.zip", url: "https://github.com/electron/electron/releases/download/v43.7.0/electron-v43.7.0-win32-x64.zip" },
  // Stay on ffmpeg 8.1: 9.0 and the nightlies need NVIDIA driver 610+ for NVENC (see README).
  ffmpeg: { file: "dl/ffmpeg-n8.1/ffmpeg-n8.1.zip", url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip" },
  uv: { file: "dl/uv/uv-win.zip", url: "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip" },
  // The Claude Code version the macOS build bundles.
  claude: { file: "dl/claude/anthropic-ai-claude-code-win32-x64-2.1.309.tgz", url: "https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.309.tgz" },
};
const ASAR = path.join(ROOT, "tools", "node_modules", "@electron", "asar", "bin", "asar.mjs");
const SEVEN_ZIP = process.env.SEVEN_ZIP ?? [path.join(ROOT, "tools", "7zip", "Files", "7-Zip", "7z.exe"), "C:\\Program Files\\7-Zip\\7z.exe"].find((p) => fs.existsSync(p)) ?? "7z";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
const node = (...args) => process.stdout.write(run(process.execPath, args, { cwd: ROOT }));
const step = (s) => console.log(`\n== ${s}`);
const download = async (name) => {
  const { file, url } = INPUTS[name], dest = path.join(ROOT, file);
  if (fs.existsSync(dest)) return dest;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await require("stream/promises").pipeline(require("stream").Readable.fromWeb(res.body), fs.createWriteStream(dest + ".part"));
  fs.renameSync(dest + ".part", dest);
  return dest;
};
// The largest PNG in a macOS .icns (the 512 and 1024 px icons are stored as PNG).
const icnsPng = (icns) => {
  const b = fs.readFileSync(icns);
  let best = null;
  for (let i = 8; i + 8 <= b.length;) {
    const len = b.readUInt32BE(i + 4), data = b.subarray(i + 8, i + len);
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && (!best || data.length > best.length)) best = data;
    if (len < 8) break;
    i += len;
  }
  if (!best) throw new Error("no PNG icon in " + icns);
  return best;
};

(async () => {
  const files = {};
  for (const name of Object.keys(INPUTS)) files[name] = await download(name);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  step("Cardboard's app from its macOS installer");
  // Only the app's Resources: the installer also holds an /Applications link, which 7-Zip refuses to make.
  run(SEVEN_ZIP, ["x", files.cardboard, "-o" + path.join(WORK, "dmg"), "-y", "Cardboard 1.5.0/Cardboard.app/Contents/Resources/*"]);
  const mac = path.join(WORK, "dmg", "Cardboard 1.5.0", "Cardboard.app", "Contents", "Resources");
  if (!fs.existsSync(path.join(mac, "app.asar"))) throw new Error("no Cardboard.app/Contents/Resources/app.asar in the installer");

  step("Windows Electron 43.7.0, as Cardboard.exe");
  run(SEVEN_ZIP, ["x", files.electron, "-o" + APP, "-y"]);
  fs.renameSync(path.join(APP, "electron.exe"), path.join(APP, "Cardboard.exe"));
  fs.rmSync(path.join(RES, "default_app.asar"), { force: true });
  for (const d of ["cli", "chat-skills"]) fs.cpSync(path.join(mac, d), path.join(RES, d), { recursive: true });

  step("Patches");
  const src = path.join(WORK, "asar-src"), dist = path.join(src, "dist"), assets = path.join(dist, "renderer", "assets");
  node(ASAR, "extract", path.join(mac, "app.asar"), src);
  // Each patch script keeps the pristine bundle next to asar-src (in work\) and starts from it.
  node("scripts/patch-main.js", path.join(dist, "main.js"));
  node("scripts/patch-worker.js", path.join(dist, "library-worker.js"));
  node("scripts/patch-strip.js", path.join(assets, "tabs-DauD2kkX.js"));
  node("scripts/patch-renderer.js", path.join(assets, "index-CMWd3X51.js"), path.join(assets, "EditorRoute-fdkrSHAw.js"), path.join(assets, "installErrorTelemetry-B0RfASW6.js"));
  if (CARTON) {
    // Carton's bundles (resources\carton, and carton-ui.js beside the editor's chunks) and its hooks, which go on top
    // of the Windows patches. The carton workspace brings esbuild.
    step("Carton");
    const workspace = path.join(ROOT, "carton");
    if (!fs.existsSync(path.join(workspace, "node_modules"))) run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: workspace, shell: process.platform === "win32" });
    node("scripts/carton/build.js", RES, assets);
    // The tab strip last: Carton's History and Share icons in the title bar (patch-carton-sync.js takes the first five).
    const app = [path.join(dist, "main.js"), path.join(dist, "library-worker.js"), path.join(assets, "index-CMWd3X51.js"), path.join(assets, "EditorRoute-fdkrSHAw.js"), path.join(assets, "installErrorTelemetry-B0RfASW6.js"), path.join(assets, "tabs-DauD2kkX.js")];
    node("scripts/patch-carton.js", "--app", ...app);
    // The live-sync and sharing half (windows-sync) patches on top of Carton's; build.js put its files in
    // resources\carton\sync.
    if (SYNC) node("scripts/patch-carton-sync.js", "--app", ...app);
  }
  node(ASAR, "pack", src, path.join(RES, "app.asar"));
  node("scripts/patch-cli.js", path.join(RES, "cli", "cardboard.mjs"), path.join(WORK, "cardboard.orig.mjs"));
  node("scripts/patch-cli-media.js", path.join(RES, "cli", "chunks", "chunk-AEX5IIG7.mjs"), path.join(WORK, "cli-media.orig.mjs"));
  if (CARTON) node("scripts/patch-carton.js", "--cli", path.join(RES, "cli", "cardboard.mjs"), path.join(RES, "cli", "chunks", "chunk-AEX5IIG7.mjs"));
  if (CARTON && SYNC) node("scripts/patch-carton-sync.js", "--cli", path.join(RES, "cli", "cardboard.mjs"), path.join(RES, "cli", "chunks", "chunk-AEX5IIG7.mjs"));

  step("ffmpeg, ffprobe, uv, Claude Code");
  const bin = path.join(RES, "bin"), director = path.join(RES, "director");
  run(SEVEN_ZIP, ["e", files.ffmpeg, "-o" + bin, "-y", "-r", "ffmpeg.exe", "ffprobe.exe"]);
  run(SEVEN_ZIP, ["e", files.uv, "-o" + bin, "-y", "uv.exe"]);
  // Windows' own tar: a Git Bash tar earlier on PATH takes "D:" for a remote host.
  run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xzf", files.claude, "-C", WORK, "package/claude.exe"]);
  fs.mkdirSync(director, { recursive: true });
  fs.renameSync(path.join(WORK, "package", "claude.exe"), path.join(director, "claude.exe"));

  step("Icon and version info");
  const png = path.join(WORK, "icon.png"), ico = path.join(WORK, "Cardboard.ico");
  fs.writeFileSync(png, icnsPng(path.join(mac, "electron.icns")));
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "make-ico.ps1"), "-Png", png, "-Ico", ico]);
  const { rcedit } = await import(require("url").pathToFileURL(path.join(ROOT, "tools", "node_modules", "rcedit", "lib", "index.js")).href);
  await rcedit(path.join(APP, "Cardboard.exe"), {
    icon: ico,
    "file-version": "1.5.0",
    "product-version": "1.5.0",
    "version-string": { FileDescription: "Cardboard", ProductName: "Cardboard", CompanyName: "Cardboard, Inc.", OriginalFilename: "Cardboard.exe", InternalName: "Cardboard" },
  });

  // Which build this is, for the benchmarks to report beside their numbers.
  let commit = null;
  try { commit = run("git", ["rev-parse", "HEAD"], { cwd: ROOT }).trim(); } catch {}
  fs.writeFileSync(path.join(APP, "build-info.json"), JSON.stringify({ variant: BASELINE ? "baseline" : "full", carton: CARTON, commit, built: new Date().toISOString() }, null, 2) + "\n");

  step("Check");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const checks = [
    ["Cardboard CLI", run(path.join(APP, "Cardboard.exe"), [path.join(RES, "cli", "cardboard.mjs"), "--version"], { env }).trim(), /^1\.5\.0$/],
    ["ffmpeg", run(path.join(bin, "ffmpeg.exe"), ["-version"]).split("\n")[0], /version n8\.1/],
    ["uv", run(path.join(bin, "uv.exe"), ["--version"]).trim(), /^uv 0\.13\.6/],
    ["Claude Code", run(path.join(director, "claude.exe"), ["--version"]).trim(), /^2\.1\.309/],
  ];
  // Carton's Node bundle loads in Electron's own Node (node:sqlite and all).
  if (CARTON) checks.push(["Carton", run(path.join(APP, "Cardboard.exe"), ["-e", `require(${JSON.stringify(path.join(RES, "carton", "carton-node.cjs"))});require("node:sqlite");console.log("loads")`], { env }).trim(), /^loads$/]);
  for (const [name, got, want] of checks) {
    console.log(`${want.test(got) ? "ok  " : "FAIL"} ${name}: ${got}`);
    if (!want.test(got)) process.exitCode = 1;
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\nbuilt ${APP}${BASELINE ? " (baseline)" : CARTON ? "" : " (no Carton)"}`);
})().catch((e) => { console.error(e); process.exit(1); });
