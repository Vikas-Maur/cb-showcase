// Fetches what a CI test group needs beyond `pnpm install`, and tells later steps where it is ($GITHUB_ENV, $GITHUB_PATH).
//   node ci/fetch.mjs [tool...]
//   ffmpeg     ffmpeg 8.1 (BtbN's builds; the version Cardboard bundles), Linux and Windows. macOS has none: the
//              tests that need it skip there.
//   versitygw  VersityGW 1.10.0, the strict-SigV4 S3 gateway blob-s3's integration tests run against (Linux).
//   electron   Electron 43.7.0 (Cardboard 1.4.0's release zip), for store-sqlite's process tests under its Node.
//   chromium   Playwright 1.64.1 driving the runner's Google Chrome (Playwright's own Chromium when there is none).
//   cardboard  Cardboard 1.4.0's app and CLI, unpacked from its macOS installer at run time the way
//              scripts/build-windows.js does, plus the prettified renderer bundle the fm∘sv slicer reads. It is
//              Cardboard's proprietary code: it stays in the runner's temp dir, and is never cached, uploaded or
//              committed.
// Everything but cardboard goes under dirs.cache, which the workflow caches. Always writes the scratch dirs
// (env.mjs testEnv) to $GITHUB_ENV, so the package tests never fall back to the dev box's paths.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OS, REPO, dirs, exportEnv, exportPath, testEnv } from "./env.mjs";

const VERSIONS = { ffmpeg: "n8.1", versitygw: "1.10.0", electron: "43.7.0", playwright: "1.64.1", prettier: "3.9.10", cardboard: "1.4.0" };
const exe = (name) => (OS === "windows" ? name + ".exe" : name);
// pnpm on Windows is a .cmd shim (corepack) or pnpm.exe (pnpm 12's own binary): a shell finds either
const pnpm = "pnpm";
const SEVEN_ZIP = OS === "windows" ? "C:\\Program Files\\7-Zip\\7z.exe" : "7z";

// `quiet`: the tool reads Cardboard's code, whose errors can quote it (a parse error prints a code frame), so its
// stderr is kept out of the log but for one short line.
function run(cmd, args, opts = {}, quiet = false) {
  const stdio = quiet ? ["ignore", opts.stdio?.[1] ?? "ignore", "pipe"] : (opts.stdio ?? "inherit");
  const r = spawnSync(cmd, args, { shell: cmd === pnpm && OS === "windows", encoding: "utf8", ...opts, stdio });
  if (r.status !== 0) {
    // Only the error's own line: Node's `SyntaxError: …` / `Error [ERR_X]: …`, or prettier's `[error] file: …Error: …`.
    // Never a fallback line: a file name or a code frame above it may be Cardboard's code.
    const lines = String(r.stderr ?? "").split("\n").map((l) => l.trim());
    const errLine = /^(\[error\] [^\s:]+: )?([A-Z][A-Za-z]*)?Error( \[[A-Z0-9_]+\])?: /;
    const why = quiet ? (lines.find((l) => errLine.test(l)) ?? "").slice(0, 160) : "";
    throw new Error(`${path.basename(cmd)} ${quiet ? path.basename(args[0] ?? "") : args.join(" ")} exited ${r.status ?? r.signal}${r.error ? ": " + r.error.message : ""}${why ? ": " + why : ""}`);
  }
  return r;
}

async function download(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file + ".part"));
      fs.renameSync(file + ".part", file);
      console.log(`  downloaded ${url} (${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MiB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      return file;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      console.log(`  ${url}: ${e.message}; retrying`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

// Zips keep their symlinks (Electron.app's frameworks need them): 7-Zip on Windows, unzip on Linux, ditto on macOS.
function extract(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!file.endsWith(".zip")) run("tar", ["-xf", file, "-C", dir]);
  else if (OS === "windows") run(SEVEN_ZIP, ["x", file, "-o" + dir, "-y", "-bso0", "-bsp0"]);
  else if (OS === "macos") run("ditto", ["-x", "-k", file, dir]);
  else run("unzip", ["-q", "-o", file, "-d", dir]);
}

function find(dir, rel, depth = 3) {
  if (fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
  if (depth === 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) {
      const f = find(path.join(dir, e.name), rel, depth - 1);
      if (f) return f;
    }
  return null;
}

function firstLine(cmd, args, env) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } }).split("\n")[0].trim();
}

const tools = {
  async ffmpeg() {
    if (OS === "macos") return console.log("  none on macOS");
    const name = OS === "windows" ? `ffmpeg-${VERSIONS.ffmpeg}-latest-win64-gpl-8.1.zip` : `ffmpeg-${VERSIONS.ffmpeg}-latest-${process.arch === "arm64" ? "linuxarm64" : "linux64"}-gpl-8.1.tar.xz`;
    const dir = path.join(dirs.cache, "ffmpeg-" + VERSIONS.ffmpeg);
    let ff = find(dir, path.join("bin", exe("ffmpeg")));
    if (!ff) {
      const file = await download(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${name}`, path.join(dirs.root, "carton-dl", name));
      extract(file, dir);
      fs.rmSync(file);
      ff = find(dir, path.join("bin", exe("ffmpeg")));
      if (!ff) throw new Error(`no bin/${exe("ffmpeg")} in ${name}`);
    }
    const bin = path.dirname(ff);
    exportPath(bin);
    exportEnv({ FFMPEG: ff, FFPROBE: path.join(bin, exe("ffprobe")), CARDBOARD_FFMPEG: ff, CARDBOARD_FFPROBE: path.join(bin, exe("ffprobe")) });
    console.log("  " + firstLine(ff, ["-hide_banner", "-version"]));
  },

  async versitygw() {
    if (OS !== "linux") return console.log("  Linux only");
    const name = `versitygw_v${VERSIONS.versitygw}_Linux_${process.arch === "arm64" ? "arm64" : "x86_64"}.tar.gz`;
    const dir = path.join(dirs.cache, "versitygw-" + VERSIONS.versitygw);
    let bin = find(dir, "versitygw");
    if (!bin || fs.statSync(bin).isDirectory()) {
      const file = await download(`https://github.com/versity/versitygw/releases/download/v${VERSIONS.versitygw}/${name}`, path.join(dirs.root, "carton-dl", name));
      extract(file, dir);
      fs.rmSync(file);
      bin = find(dir, "versitygw");
      if (!bin) throw new Error(`no versitygw binary in ${name}`);
    }
    fs.chmodSync(bin, 0o755);
    exportEnv({ VERSITYGW_BIN: bin });
    console.log("  " + firstLine(bin, ["--version"]));
  },

  async electron() {
    // The release zip, as build-windows.js takes it (the electron package's postinstall download is an install script,
    // which pnpm doesn't run).
    const plat = { linux: "linux", windows: "win32", macos: "darwin" }[OS];
    const name = `electron-v${VERSIONS.electron}-${plat}-${process.arch}.zip`;
    const dir = path.join(dirs.cache, "electron-" + VERSIONS.electron);
    const bin = path.join(dir, { linux: "electron", windows: "electron.exe", macos: "Electron.app/Contents/MacOS/Electron" }[OS]);
    if (!fs.existsSync(bin)) {
      fs.rmSync(dir, { recursive: true, force: true });
      const file = await download(`https://github.com/electron/electron/releases/download/v${VERSIONS.electron}/${name}`, path.join(dirs.root, "carton-dl", name));
      extract(file, dir);
      fs.rmSync(file);
    }
    exportEnv({ CARTON_CI_ELECTRON: bin });
    console.log("  " + firstLine(bin, ["-p", "`electron ${process.versions.electron}, node ${process.versions.node}, sqlite ${require('node:sqlite').DatabaseSync ? 'yes' : 'no'}`"], { ELECTRON_RUN_AS_NODE: "1" }));
  },

  async chromium() {
    const dir = path.join(dirs.cache, "playwright-" + VERSIONS.playwright);
    const pw = path.join(dir, "node_modules", "playwright");
    // a scratch project of its own (pnpm adds a package.json there), with no install scripts run, as npm 11 ran none
    if (!fs.existsSync(path.join(pw, "package.json"))) {
      fs.mkdirSync(dir, { recursive: true });
      run(pnpm, ["add", "--dir", dir, "--ignore-scripts", `playwright@${VERSIONS.playwright}`], { env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
    }
    const chrome = {
      linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
      windows: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
      macos: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    }[OS]?.find((f) => fs.existsSync(f));
    let browser = chrome;
    if (!browser) {
      const browsers = path.join(dirs.cache, "ms-playwright");
      exportEnv({ PLAYWRIGHT_BROWSERS_PATH: browsers });
      run(process.execPath, [path.join(pw, "cli.js"), "install", "chromium"]);
      browser = createRequire(path.join(pw, "index.js"))("playwright").chromium.executablePath();
    }
    // store-idb reads CARTON_*, media's suites PLAYWRIGHT/CHROMIUM and its range-server test CHROME
    exportEnv({ CARTON_PLAYWRIGHT: pw, PLAYWRIGHT: pw, CARTON_CHROMIUM: browser, CHROMIUM: browser, CHROME: browser });
    // Start it once here, so a browser that can't run fails this step with its own error, not as skipped tests.
    const check = `const { chromium } = require(${JSON.stringify(pw)}); chromium.launch({ headless: true, executablePath: ${JSON.stringify(browser)} }).then(async (b) => { console.log("browser " + b.version()); await b.close(); }).catch((e) => { console.error(e); process.exit(1); });`;
    console.log("  " + firstLine(process.execPath, ["-e", check]));
  },

  async cardboard() {
    const dest = path.join(dirs.root, "cardboard-" + VERSIONS.cardboard);
    const renderer = path.join(dest, "pretty", "installErrorTelemetry-DxKId8tA.js");
    if (!fs.existsSync(renderer)) {
      fs.rmSync(dest, { recursive: true, force: true });
      const work = path.join(dirs.root, "cardboard-dl");
      fs.rmSync(work, { recursive: true, force: true });
      const dmg = await download(`https://assets.cardboard.ai/desktop/releases/${VERSIONS.cardboard}/Cardboard-${VERSIONS.cardboard}-arm64.dmg`, path.join(work, "Cardboard.dmg"));
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(dmg)) hash.update(chunk);
      console.log("  sha256 " + hash.digest("hex"));
      // Only the app's Resources, as build-windows.js does (the installer also holds an /Applications link).
      run(SEVEN_ZIP, ["x", dmg, "-o" + path.join(work, "x"), "-y", "-bso0", "-bsp0", `Cardboard ${VERSIONS.cardboard}/Cardboard.app/Contents/Resources/*`]);
      const res = path.join(work, "x", `Cardboard ${VERSIONS.cardboard}`, "Cardboard.app", "Contents", "Resources");
      if (!fs.existsSync(path.join(res, "app.asar"))) throw new Error("no Cardboard.app/Contents/Resources/app.asar in the installer");
      // @electron/asar from the repo's tools/ (what build-windows.js uses), and prettier into the scratch dir
      if (!fs.existsSync(path.join(REPO, "tools", "node_modules", "@electron", "asar"))) run(pnpm, ["install", "--frozen-lockfile"], { cwd: path.join(REPO, "tools") });
      run(process.execPath, [path.join(REPO, "tools", "node_modules", "@electron", "asar", "bin", "asar.mjs"), "extract", path.join(res, "app.asar"), path.join(dest, "app-asar")], {}, true);
      fs.cpSync(path.join(res, "cli"), path.join(dest, "cli"), { recursive: true, dereference: true });
      const pdir = path.join(work, "prettier");
      fs.mkdirSync(pdir, { recursive: true });
      run(pnpm, ["add", "--dir", pdir, "--ignore-scripts", `prettier@${VERSIONS.prettier}`]);
      fs.mkdirSync(path.dirname(renderer), { recursive: true });
      // Prettier's defaults, as the copy the agents sliced (_inspect/pretty) was made. It runs on a copy in an empty
      // folder of its own: prettier 3 reads .gitignore from its working directory and prints an ignored file unchanged
      // (carton/.gitignore's `dist/` matched app-asar/dist/…).
      const pin = path.join(work, "pretty-in");
      fs.mkdirSync(pin);
      fs.copyFileSync(path.join(dest, "app-asar", "dist", "renderer", "assets", "installErrorTelemetry-DxKId8tA.js"), path.join(pin, "renderer.js"));
      const out = fs.openSync(renderer + ".part", "w");
      run(process.execPath, [path.join(pdir, "node_modules", "prettier", "bin", "prettier.cjs"), "--no-config", "--no-editorconfig", "--parser", "babel", "renderer.js"], { cwd: pin, stdio: ["ignore", out, "pipe"] }, true);
      fs.closeSync(out);
      fs.renameSync(renderer + ".part", renderer);
      fs.rmSync(work, { recursive: true, force: true });
    }
    // Fingerprints only (never the code): the dev box's copies are c30cd768… (minified) and 00c7775b… (prettified).
    const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 8);
    const pretty = fs.readFileSync(renderer, "utf8");
    const anchor = /\bho = \(t\) => Math\.round\(t \* 10\) \/ 10/.test(pretty);
    console.log(`  renderer ${sha(path.join(dest, "app-asar", "dist", "renderer", "assets", "installErrorTelemetry-DxKId8tA.js"))}…, prettified ${sha(renderer)}… (${pretty.length} chars, fm∘sv anchor ${anchor ? "found" : "MISSING"})`);
    if (!anchor) throw new Error("the prettified renderer has no fm∘sv anchor, so the cardboard suite's B10 would skip");
    const version = fs.readFileSync(path.join(dest, "cli", "version.txt"), "utf8").trim();
    if (!version.startsWith(VERSIONS.cardboard)) throw new Error(`Cardboard CLI version ${version}, expected ${VERSIONS.cardboard}`);
    exportEnv({ CARTON_CARDBOARD_DIR: dest, CARDBOARD_PRISTINE: dest, CARTON_CARDBOARD_CLI: path.join(dest, "cli", "cardboard.mjs"), CARTON_CARDBOARD_RENDERER: renderer });
    console.log(`  Cardboard CLI ${version}`);
  },
};

const wanted = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
for (const t of wanted) if (!tools[t]) throw new Error(`unknown tool ${t} (known: ${Object.keys(tools).join(", ")})`);
console.log("test scratch dirs:");
exportEnv({ ...testEnv(), CARTON_CI_RESULTS: dirs.results, CARTON_CI_CACHE: dirs.cache });
for (const t of wanted) {
  console.log(`${t}:`);
  await tools[t]();
}
