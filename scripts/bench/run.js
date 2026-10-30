// Benchmarks Cardboard builds against each other on this machine, the way someone uses it: a fresh profile and
// library for every run, the real app driven over the DevTools protocol (../cdp.js), and the `cb` CLI agents run.
//   node scripts/bench/run.js --build baseline=<app> --build ours=<app> [--tests import,cli] [--runs 5]
//                             [--warmup 1] [--media <dir>] [--out <dir>]
// <app> is the folder with Cardboard.exe in it (Windows) or Cardboard.app (macOS). The first --build is the one the
// others are compared with. Runs alternate between the builds (A B, B A, …), so drift such as a laptop warming up
// lands on both alike; each build's first --warmup runs are not counted. Writes <out>/results.json and results.md:
// the machine, the builds, the clips, every run, and each build's median.
//
// Tests:
//   import  Drops every clip in --media (default bench-media, made by media.js) on a new project the way the editor's
//           Import Media does, then waits until no file has been written to the bundle's media/, cache/, proxies/
//           or converted/ or the library's .cache/ for 15 s. Reports when the clips were listed, when the first
//           thumbnail and the last file were written, and what was made: thumbnails, waveforms, proxies, which must
//           match between builds. Watches the folders only: reading project.json while Cardboard runs makes its
//           saves fail on Windows.
//   cli     Times `cb` commands an agent runs, each in a new process, with the app closed and the library in a
//           temp folder.
//   cli-import  The same clips through `cb media add`, which runs the CLI's own copy of the import pipeline (patched
//           as the app's is, patch-cli-media.js) and exits once every thumbnail, waveform and proxy is made. It needs
//           no app window and no sign-in, so it runs anywhere, a CI machine too, though without an NVIDIA GPU it
//           shows only the changes that don't need one.
// A path to a cardboard.mjs as <app> runs that CLI with this Node (cli and cli-import only).
//
// Nothing it runs spends credits: no generation, transcription, captions, voices, mattes or footage search. The
// app uses the stored sign-in, which every profile shares. Close Cardboard first, and plug a laptop in: on battery
// Windows slows the CPU and GPU.
process.env.CDP_PORT ??= "9351";
const { spawn, spawnSync, execFileSync } = require("child_process");
const crypto = require("crypto"), fs = require("fs"), os = require("os"), path = require("path");
const { connect, evaluate, targets } = require("../cdp");

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : def; };
const ROOT = path.join(__dirname, "..", "..");
const TESTS = opt("tests", "import,cli").split(",");
const RUNS = Number(opt("runs", "5")), WARMUP = Number(opt("warmup", "1"));
const MEDIA = path.resolve(ROOT, opt("media", "bench-media"));
const OUT = path.resolve(ROOT, opt("out", path.join("bench-results", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"))));
const QUIET_MS = 15000, IMPORT_TIMEOUT_MS = 30 * 60e3;
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Builds ──
const build = (spec) => {
  const [label, dir] = spec.split(/=(.*)/s);
  if (!label || !dir) throw new Error(`--build wants label=<app>, got ${spec}`);
  const at = path.resolve(dir);
  if (at.endsWith(".mjs")) return { label, dir: at, exe: process.execPath, cli: at, cliOnly: true, info: null, tools: {} };
  const app = MAC && !at.endsWith(".app") && fs.existsSync(path.join(at, "Cardboard.app")) ? path.join(at, "Cardboard.app") : at;
  const mac = app.endsWith(".app");
  const exe = mac ? path.join(app, "Contents", "MacOS", "Cardboard") : path.join(app, "Cardboard.exe");
  const res = mac ? path.join(app, "Contents", "Resources") : path.join(app, "resources");
  if (!fs.existsSync(exe)) throw new Error(`no Cardboard in ${app} (looked for ${exe})`);
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(app, "build-info.json"), "utf8")); } catch {}
  // The CLI finds ffmpeg through CARDBOARD_FFMPEG/CARDBOARD_FFPROBE before PATH: point it at the build's own.
  const bin = (name) => path.join(res, "bin", WIN ? name + ".exe" : name);
  const tools = fs.existsSync(bin("ffmpeg")) ? { CARDBOARD_FFMPEG: bin("ffmpeg"), CARDBOARD_FFPROBE: bin("ffprobe") } : {};
  return { label, dir: app, exe, cli: path.join(res, "cli", "cardboard.mjs"), cliOnly: false, info, tools };
};
const BUILDS = argv.flatMap((a, i) => (a === "--build" ? [build(argv[i + 1])] : []));
if (BUILDS.length < 1) throw new Error("usage: node scripts/bench/run.js --build baseline=<app> --build ours=<app> [--tests import,cli] [--runs 5]");
if (TESTS.includes("import") && BUILDS.some((b) => b.cliOnly)) throw new Error("the import test needs app builds, not a cardboard.mjs");
const CLI_IMPORT_TIMEOUT_MS = 60 * 60e3;

// The environment without ELECTRON_RUN_AS_NODE, which turns Cardboard.exe into plain Node (see README).
const baseEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^ELECTRON_RUN_AS_NODE$/i.test(k) || /^CDP_PORT$/i.test(k)) delete env[k];
  return env;
};
const cb = (b, env, args, timeout = 120e3) =>
  spawnSync(b.exe, [b.cli, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout, windowsHide: true });
const cbOk = (b, env, args, timeout) => {
  const r = cb(b, env, args, timeout);
  if (r.status !== 0) throw new Error(`cb ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
};

// ── The machine ──
const machine = () => {
  const m = { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30) };
  try {
    if (WIN) {
      Object.assign(m, JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "$c=Get-CimInstance Win32_Processor|Select-Object -First 1;$o=Get-CimInstance Win32_OperatingSystem;$b=Get-CimInstance Win32_Battery;" +
        "[pscustomobject]@{cpu=$c.Name.Trim();cores=$c.NumberOfCores;gpus=@(Get-CimInstance Win32_VideoController|ForEach-Object{$_.Name+' (driver '+$_.DriverVersion+')'});" +
        "os=$o.Caption+' '+$o.Version;onBattery=[bool]($b -and $b.BatteryStatus -eq 1)}|ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true })));
    } else if (MAC) {
      m.os = "macOS " + execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
      m.onBattery = /Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }));
    }
  } catch (e) { m.note = "could not read all hardware details: " + e.message.split("\n")[0]; }
  return m;
};
const cardboardRunning = () => {
  try {
    if (WIN) return /Cardboard\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq Cardboard.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
    if (MAC) return spawnSync("pgrep", ["-x", "Cardboard"]).status === 0;
  } catch {}
  return false;
};

// ── The clips ──
const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|m2ts|mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|jpg|jpeg|png|heic|webp)$/i;
const clips = () => {
  if (!fs.existsSync(MEDIA)) throw new Error(`no clips in ${MEDIA}: run node scripts/bench/media.js ${path.relative(ROOT, MEDIA) || "."} first, or pass --media`);
  const files = fs.readdirSync(MEDIA).filter((f) => MEDIA_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length === 0) throw new Error(`no media files in ${MEDIA}`);
  let made = null;
  try { made = JSON.parse(fs.readFileSync(path.join(MEDIA, "media.json"), "utf8")); } catch {}
  return {
    dir: MEDIA,
    files: files.map((f) => {
      const known = made?.clips?.find((c) => c.file === f);
      return { file: f, bytes: fs.statSync(path.join(MEDIA, f)).size, what: known?.what, sha256: known?.sha256 };
    }),
  };
};

// ── Runs ──
const tempDir = (label, test, i) => fs.mkdtempSync(path.join(os.tmpdir(), `cb-bench-${label}-${test}-${i}-`));
const removeDir = async (dir) => {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(500); }
  }
  console.warn(`  could not remove ${dir}`);
};
const waitFor = async (check, ms, what) => {
  const until = Date.now() + ms;
  for (;;) {
    try { const v = await check(); if (v) return v; } catch {}
    if (Date.now() > until) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(250);
  }
};
const portFree = async () => { try { await targets(); return false; } catch { return true; } };

const launch = async (b, env) => {
  if (!(await portFree())) throw new Error(`something already listens on port ${process.env.CDP_PORT}; close it or set CDP_PORT`);
  const child = spawn(b.exe, [`--remote-debugging-port=${process.env.CDP_PORT}`], { env, stdio: "ignore", detached: !WIN, windowsHide: false });
  child.on("error", () => {});
  return child;
};
const quit = async (child) => {
  try {
    if (WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
  await waitFor(portFree, 20e3, "Cardboard to quit");
  await sleep(1000);
};

// Every file under the folders an import writes to, with its size and last write.
const scan = (dirs) => {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const s = fs.statSync(p); files.push({ path: p, bytes: s.size, mtimeMs: s.mtimeMs }); } catch {} }
    }
  };
  for (const d of dirs) walk(d);
  return files;
};
// What an import made, by kind. The same clips must give the same counts in every build.
const inventory = (bundle, files) => {
  const kinds = { thumbnails: 0, waveforms: 0, peaks: 0, proxies: 0, converted: 0, media: 0, other: 0 };
  for (const f of files) {
    const rel = path.relative(bundle, f.path).split(path.sep);
    if (rel[0] === "cache" && rel[1] in kinds) kinds[rel[1]]++;
    else if (rel[0] === "proxies") { if (!/\.partial\./.test(f.path)) kinds.proxies++; }
    else if (rel[0] === "converted" || rel[0] === "media") kinds[rel[0]]++;
    else kinds.other++;
  }
  return kinds;
};

const importRun = async (b, media, tag) => {
  const tmp = tempDir(b.label, "import", tag), userData = path.join(tmp, "userdata"), home = path.join(tmp, "home");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { ...baseEnv(), CARDBOARD_USER_DATA: userData, CARDBOARD_HOME: home };
  const cliEnv = { ...env, CARDBOARD_SOCKET: path.join(userData, "cardboard.sock") };
  const child = await launch(b, env);
  let c = null;
  try {
    await waitFor(async () => (await targets()).some((t) => t.type === "page" && /\/app\//.test(t.url)), 120e3, "Cardboard's window");
    const project = JSON.parse(cbOk(b, cliEnv, ["project", "create", "Bench", "--json"]));
    await waitFor(() => cb(b, cliEnv, ["project", "open", project.id, "--focus"], 60e3).status === 0, 120e3, "the project to open");
    c = await waitFor(() => connect("app/editor/" + project.id), 60e3, "the editor");
    // The editor takes imports once its listener is up, the one its Import Media button and menu item use.
    await waitFor(async () => {
      const win = await c.send("Runtime.evaluate", { expression: "window" });
      const { listeners } = await c.send("DOMDebugger.getEventListeners", { objectId: win.result.objectId });
      return listeners.some((l) => l.type === "editor:import-media");
    }, 60e3, "the editor to take imports");
    await sleep(2000);

    const bundle = project.bundlePath;
    const dirs = ["media", "cache", "proxies", "converted"].map((d) => path.join(bundle, d)).concat(path.join(home, ".cache"));
    const before = new Set(scan(dirs).map((f) => f.path));
    // Files as a file picker gives them, then the editor's own import event, which Import Media sends too.
    await c.send("DOM.getDocument", {});
    const input = await c.send("Runtime.evaluate", { expression: `(() => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.hidden = true; document.body.append(i); return i; })()` });
    await c.send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: media.files.map((f) => path.join(media.dir, f.file)) });
    const t0 = Date.now();
    const sent = await c.send("Runtime.callFunctionOn", {
      objectId: input.result.objectId, returnByValue: true, userGesture: true,
      functionDeclaration: `function () {
        const files = [...this.files];
        this.remove();
        window.__cbBench = { listed: null };
        window.dispatchEvent(new CustomEvent("editor:import-media", { detail: { files, onImported: () => { window.__cbBench.listed ??= performance.timeOrigin + performance.now(); } } }));
        return files.length;
      }`,
    });
    if (sent.result.value !== media.files.length) throw new Error(`the page got ${sent.result.value} of ${media.files.length} files`);

    // Done once nothing has been written for QUIET_MS. The last write is the end, not when the quiet was noticed.
    let sig = "", changed = Date.now(), files = [];
    for (;;) {
      await sleep(500);
      files = scan(dirs).filter((f) => !before.has(f.path));
      const s = files.length + ":" + files.reduce((n, f) => n + f.bytes, 0) + ":" + Math.max(0, ...files.map((f) => f.mtimeMs));
      if (s !== sig) { sig = s; changed = Date.now(); }
      if (files.length > 0 && Date.now() - changed >= QUIET_MS) break;
      if (files.length === 0 && Date.now() - t0 > 180e3) throw new Error("nothing was written in 3 minutes: the import did not start");
      if (Date.now() - t0 > IMPORT_TIMEOUT_MS) throw new Error("the import was still writing after 30 minutes");
    }
    const page = await evaluate(c, `({ listed: window.__cbBench?.listed ?? null, failed: /Could not import|Failed to add files/i.test(document.body.innerText) })`);
    const thumbs = files.filter((f) => path.relative(bundle, f.path).startsWith("cache" + path.sep + "thumbnails"));
    return {
      metrics: {
        "clips listed (s)": page.listed === null ? null : (page.listed - t0) / 1000,
        "first thumbnail (s)": thumbs.length ? (Math.min(...thumbs.map((f) => f.mtimeMs)) - t0) / 1000 : null,
        "everything ready (s)": (Math.max(...files.map((f) => f.mtimeMs)) - t0) / 1000,
      },
      made: inventory(bundle, files),
      importFailed: page.failed,
    };
  } finally {
    try { c?.close(); } catch {}
    await quit(child);
    await removeDir(tmp);
  }
};

const CLI_TIMELINE = (text) => `export default (\n  <timeline aspect="16:9">\n    <track>\n      <text start={0} end={3} textContent="${text}" />\n    </track>\n  </timeline>\n);\n`;
const cliRun = async (b, _media, tag) => {
  const tmp = tempDir(b.label, "cli", tag), lib = path.join(tmp, "library"), env = { ...baseEnv(), ...b.tools };
  const timed = (args) => {
    const t = process.hrtime.bigint();
    const out = cbOk(b, env, args);
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
  };
  try {
    const a = path.join(tmp, "a.tsx"), z = path.join(tmp, "b.tsx");
    fs.writeFileSync(a, CLI_TIMELINE("Bench A"));
    fs.writeFileSync(z, CLI_TIMELINE("Bench B"));
    const m = {};
    m["cb --help (ms)"] = timed(["--help"]).ms;
    const created = timed(["--root", lib, "project", "create", "Bench", "--json"]);
    m["cb project create (ms)"] = created.ms;
    const id = JSON.parse(created.out).id;
    m["cb project list (ms)"] = timed(["--root", lib, "project", "list", "--json"]).ms;
    m["cb source print (ms)"] = timed(["--root", lib, "source", "print", id]).ms;
    m["cb source apply (ms)"] = timed(["--root", lib, "source", "apply", id, a]).ms;
    m["cb source apply, second edit (ms)"] = timed(["--root", lib, "source", "apply", id, z]).ms;
    return { metrics: m };
  } finally {
    await removeDir(tmp);
  }
};

const cliImportRun = async (b, media, tag) => {
  const tmp = tempDir(b.label, "cli-import", tag), lib = path.join(tmp, "library"), env = { ...baseEnv(), ...b.tools };
  try {
    const project = JSON.parse(cbOk(b, env, ["--root", lib, "project", "create", "Bench", "--json"]));
    const t = process.hrtime.bigint();
    cbOk(b, env, ["--root", lib, "media", "add", project.id, ...media.files.map((f) => path.join(media.dir, f.file))], CLI_IMPORT_TIMEOUT_MS);
    const secs = Number(process.hrtime.bigint() - t) / 1e9;
    const dirs = ["media", "cache", "proxies", "converted"].map((d) => path.join(project.bundlePath, d)).concat(path.join(lib, ".cache"));
    return { metrics: { "cb media add, everything ready (s)": secs }, made: inventory(project.bundlePath, scan(dirs)) };
  } finally {
    await removeDir(tmp);
  }
};

// ── Report ──
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const fmt = (x) => (x === null || x === undefined ? "–" : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const report = (res) => {
  const lines = [`# Cardboard benchmark, ${res.started.slice(0, 16).replace("T", " ")}`, ""];
  const m = res.machine;
  lines.push(`Machine: ${m.cpu} (${m.cores ?? "?"} cores, ${m.threads} threads), ${m.ramGB} GB, ${(m.gpus ?? []).join("; ") || "GPU unknown"}, ${m.os ?? m.platform}${m.onBattery ? ", **on battery**" : ""}.`);
  lines.push("", "Builds:");
  for (const b of res.builds) lines.push(`- **${b.label}**: ${b.dir}${b.info ? ` (${b.info.variant}, ${b.info.commit?.slice(0, 7) ?? "?"}, built ${b.info.built?.slice(0, 10)})` : ""}`);
  if (res.media) {
    lines.push("", `Clips (${res.media.dir}):`);
    for (const f of res.media.files) lines.push(`- ${f.file}, ${(f.bytes / 1e6).toFixed(1)} MB${f.what ? `: ${f.what}` : ""}`);
  }
  lines.push("", `${RUNS} counted runs per build after ${WARMUP} warm-up, alternating. Medians; every counted run is listed under each table. The last column is ${res.builds[0].label}'s median ÷ each build's.`);
  for (const test of TESTS) {
    const runs = res.runs.filter((r) => r.test === test && !r.warmup);
    if (runs.length === 0) continue;
    const names = [...new Set(runs.flatMap((r) => Object.keys(r.metrics ?? {})))];
    lines.push("", `## ${test}`, "", `| Measure | ${res.builds.map((b) => b.label).join(" | ")} | ${res.builds.slice(1).map((b) => `${res.builds[0].label} ÷ ${b.label}`).join(" | ")} |`);
    lines.push(`| --- | ${res.builds.map(() => "---:").join(" | ")} |${res.builds.slice(1).map(() => " ---: |").join("")}`);
    for (const n of names) {
      const meds = res.builds.map((b) => median(runs.filter((r) => r.build === b.label).map((r) => r.metrics?.[n])));
      lines.push(`| ${n} | ${meds.map(fmt).join(" | ")} | ${meds.slice(1).map((x) => (x && meds[0] ? (meds[0] / x).toFixed(2) + "×" : "–")).join(" | ")} |`);
    }
    lines.push("");
    for (const b of res.builds) {
      const mine = runs.filter((r) => r.build === b.label);
      for (const n of names) lines.push(`- ${b.label}, ${n}: ${mine.map((r) => (r.error ? "failed" : fmt(r.metrics?.[n]))).join(", ")}`);
    }
    const made = runs.filter((r) => r.made).map((r) => `${r.build}: ${JSON.stringify(r.made)}`);
    if (made.length) {
      const distinct = new Set(runs.filter((r) => r.made).map((r) => JSON.stringify(r.made)));
      lines.push("", distinct.size === 1 ? `Every run made the same files: ${[...distinct][0]}.` : "**Runs made different files:**", ...(distinct.size === 1 ? [] : made.map((x) => `- ${x}`)));
    }
    const failed = runs.filter((r) => r.error || r.importFailed);
    if (failed.length) lines.push("", "**Failures:**", ...failed.map((r) => `- ${r.build} run ${r.i}: ${r.error ?? "the editor showed an import error"}`));
  }
  return lines.join("\n") + "\n";
};

(async () => {
  if (BUILDS.some((b) => !b.cliOnly) && cardboardRunning()) throw new Error("Cardboard is running. Close it first: it competes for the CPU and GPU.");
  const res = { started: new Date().toISOString(), machine: machine(), builds: BUILDS.map(({ label, dir, info }) => ({ label, dir, info })), tests: TESTS, runs: [] };
  if (res.machine.onBattery) console.warn("On battery: plug in for numbers worth keeping.");
  if (TESTS.includes("import") || TESTS.includes("cli-import")) res.media = clips();
  fs.mkdirSync(OUT, { recursive: true });
  const save = () => {
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(path.join(OUT, "results.md"), report(res));
  };
  const TEST_FN = { import: importRun, cli: cliRun, "cli-import": cliImportRun };
  for (const test of TESTS) {
    if (!TEST_FN[test]) throw new Error(`unknown test ${test} (import, cli, cli-import)`);
    for (let i = 0; i < WARMUP + RUNS; i++) {
      // A B, B A, A B…: each build goes first as often as the other.
      const order = i % 2 === 0 ? BUILDS : [...BUILDS].reverse();
      for (const b of order) {
        const warmup = i < WARMUP, tag = warmup ? `w${i + 1}` : String(i - WARMUP + 1);
        process.stdout.write(`${test} ${b.label} ${warmup ? "warm-up" : "run " + tag} … `);
        const run = { test, build: b.label, i: tag, warmup, at: new Date().toISOString() };
        try {
          Object.assign(run, await TEST_FN[test](b, res.media, tag));
          console.log(Object.entries(run.metrics).map(([k, v]) => `${k.replace(/ \((s|ms)\)$/, "")} ${fmt(v)}${/\(s\)$/.test(k) ? " s" : " ms"}`).join(", ") + (run.importFailed ? "  (import error shown)" : ""));
        } catch (e) {
          run.error = e.message;
          console.log("failed: " + e.message);
        }
        res.runs.push(run);
        save();
      }
    }
  }
  res.finished = new Date().toISOString();
  save();
  console.log(`\n${report(res)}\nSaved to ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
