// Patches Cardboard's macOS main-process bundle so it runs on Windows.
// Usage: node patch-main.js <path-to-dist/main.js>
const fs = require("fs");
const path = require("path");

const file = process.argv[2];
// Keep the pristine bundle outside the asar source tree so it is not repacked.
const orig = path.join(path.dirname(file), "..", "..", "main.orig.js");
if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
let src = fs.readFileSync(orig, "utf8");

const replace = (from, to, count = 1) => {
  const n = src.split(from).length - 1;
  if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
  src = src.split(from).join(to);
};
// CB_BASELINE=1 (build-windows.js --baseline) leaves out the "speed" changes, as patch-worker.js does.
const speed = process.env.CB_BASELINE !== "1";

// Helpers injected once at the top of the bundle.
const preamble = String.raw`
var __cbWin = process.platform === "win32";
var __cbExe = (n) => (__cbWin ? n + ".exe" : n);
// Windows cannot listen on a filesystem socket path; use a named pipe derived from it.
var __cbSock = (p) => __cbWin
  ? "\\\\.\\pipe\\cardboard-" + require("crypto").createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0, 16)
  : p;
// cmd reads a .cmd file in the console's OEM code page, not UTF-8, so a path with non-ASCII characters
// (C:\Users\José\…) written into one is not found. The part of such a path under the user's profile is
// written as %LOCALAPPDATA%, %APPDATA% or %USERPROFILE%, which cmd expands from the environment, in Unicode.
var __cbCmdPath = (p) => {
  if (!/[^\x20-\x7e]/.test(p)) return p;
  for (const v of ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
    const base = process.env[v];
    if (base && p.toLowerCase().startsWith(base.toLowerCase() + "\\")) return "%" + v + "%" + p.slice(base.length);
  }
  return p;
};
// A single-quoted sh word.
var __cbShQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
// Windows replacement for the macOS director-bin setup (symlinks + /bin/sh wrappers).
// Writes POSIX shims (for Claude Code's Git Bash tool) and .cmd shims (for cmd/PowerShell).
var __cbToolBins = [];
var __cbTools = (dir, t, pyRoot, o) => {
  const fs = require("fs"), path = require("path");
  // The real ffmpeg.exe and ffprobe.exe go on the agent's PATH after these shims (see patch 3).
  __cbToolBins = [...new Set([t.ffmpeg, t.ffprobe].filter(Boolean).map((p) => path.dirname(p)))];
  const fwd = (p) => p.replace(/\\/g, "/"), q = __cbShQuote, c = __cbCmdPath;
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ["ffmpeg", "ffprobe", "python3", "python", "pip3", "pip"])
    for (const ext of ["", ".cmd"]) fs.rmSync(path.join(dir, n + ext), { force: true });
  const shim = (name, sh, cmd) => {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n" + sh + "\n");
    fs.writeFileSync(path.join(dir, name + ".cmd"), "@echo off\r\n" + cmd.join("\r\n") + "\r\n");
  };
  if (t.ffmpeg) shim("ffmpeg", "exec " + q(fwd(t.ffmpeg)) + ' "$@"', ['"' + c(t.ffmpeg) + '" %*']);
  if (t.ffprobe) shim("ffprobe", "exec " + q(fwd(t.ffprobe)) + ' "$@"', ['"' + c(t.ffprobe) + '" %*']);
  if (!t.uv) return;
  fs.mkdirSync(pyRoot, { recursive: true });
  const env = path.join(pyRoot, o.envName);
  const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(pyRoot, "interpreters"), UV_CACHE_DIR: path.join(pyRoot, "cache"), UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1" };
  const note = "Setting up Python " + o.py + " with numpy, OpenCV, Pillow and SciPy (first use only)...";
  const shEnv = Object.entries(uvEnv).map(([k, v]) => k + "=" + q(fwd(v))).join(" ");
  const pyExe = fwd(path.join(env, "Scripts", "python.exe"));
  shim("python3", [
    "ENV=" + q(fwd(env)),
    'if [ ! -f "$ENV/.ready" ]; then',
    "  echo " + q(note) + " >&2",
    "  " + shEnv + " " + q(fwd(t.uv)) + ' venv --quiet --seed --allow-existing --python ' + o.py + ' "$ENV" >&2 &&',
    "  " + shEnv + " " + q(fwd(t.uv)) + " pip install --quiet --python " + q(pyExe) + " " + o.pkgs.map(q).join(" ") + " >&2 &&",
    '  touch "$ENV/.ready" || { echo "Python setup failed. Check the network connection and try again." >&2; exit 1; }',
    "fi",
    "exec " + q(pyExe) + ' "$@"',
  ].join("\n"), [
    "setlocal",
    'if not exist "' + c(env) + '\\.ready" (',
    "  echo " + note.replace(/[()]/g, "^$&") + " 1>&2",
    ...Object.entries(uvEnv).map(([k, v]) => '  set "' + k + "=" + c(v) + '"'),
    '  "' + c(t.uv) + '" venv --quiet --seed --allow-existing --python ' + o.py + ' "' + c(env) + '" 1>&2 || exit /b 1',
    '  "' + c(t.uv) + '" pip install --quiet --python "' + c(path.join(env, "Scripts", "python.exe")) + '" ' + o.pkgs.map((p) => '"' + p + '"').join(" ") + " 1>&2 || exit /b 1",
    '  type nul > "' + c(env) + '\\.ready"',
    ")",
    '"' + c(path.join(env, "Scripts", "python.exe")) + '" %*',
  ]);
  shim("python", 'exec "$(dirname "$0")/python3" "$@"', ['"%~dp0python3.cmd" %*']);
  shim("pip3", 'exec "$(dirname "$0")/python3" -m pip "$@"', ['"%~dp0python3.cmd" -m pip %*']);
  shim("pip", 'exec "$(dirname "$0")/python3" -m pip "$@"', ['"%~dp0python3.cmd" -m pip %*']);
};
// "Install agent tools" on Windows: cardboard/cb shims in ~/.local/bin, which is added to the user PATH.
var __cbCliEntry = () => require("path").join(process.resourcesPath, "cli", "cardboard.mjs");
// A shim names this exe (in whichever form an earlier build wrote it).
var __cbOurs = (text) => [process.execPath, __cbCmdPath(process.execPath), process.execPath.replace(/\\/g, "/")].some((p) => text.includes(p));
var __cbLinked = (p) => { try { return __cbOurs(require("fs").readFileSync(p, "utf8")); } catch { return false; } };
// The cmd shim keeps ELECTRON_RUN_AS_NODE to itself (setlocal). Without that, one cb command left it set in
// the console, and every Electron app started from there (Cardboard, VS Code…) ran as Node, with no window.
var __cbCliShims = (exe = process.execPath, entry = __cbCliEntry()) => {
  const fwd = (p) => p.replace(/\\/g, "/");
  return {
    ".cmd": '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' + __cbCmdPath(exe) + '" "' + __cbCmdPath(entry) + '" %*\r\n',
    "": "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec " + __cbShQuote(fwd(exe)) + " " + __cbShQuote(fwd(entry)) + ' "$@"\n',
  };
};
var __cbCliNames = ["cardboard", "cb"];
var __cbCliDir = () => require("path").join(require("os").homedir(), ".local", "bin");
// On start, shims an earlier build installed for this exe are brought up to date. Others are left alone.
// Not while a cb command runs: cmd goes on reading a batch file at its old offset once the command
// returns, so it would run part of the new text. The next start updates them.
var __cbRelinkCli = async () => {
  if (!__cbWin) return;
  const fsp = require("fs/promises"), path = require("path"), shims = __cbCliShims(), stale = [];
  for (const n of __cbCliNames)
    for (const [ext, text] of Object.entries(shims)) {
      const p = path.join(__cbCliDir(), n + ext);
      const cur = await fsp.readFile(p, "utf8").catch(() => null);
      if (cur !== null && cur !== text && __cbOurs(cur)) stale.push([p, text]);
    }
  if (stale.length === 0) return;
  const cli = await new Promise((res) => require("child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;(Get-CimInstance Win32_Process -Filter \"Name='" + require("path").basename(process.execPath) + "'\").CommandLine -join [char]10"],
    { windowsHide: true, timeout: 20000 }, (e, out) => res(e ? null : String(out))));
  if (cli === null || cli.toLowerCase().includes(__cbCliEntry().toLowerCase())) return;
  for (const [p, text] of stale) await fsp.writeFile(p, text).catch((e) => console.warn("[desktop] could not update " + p + ":", e));
};
// The folder goes on the user's Path in the registry as it is: entries such as %USERPROFILE%\… stay
// unexpanded and the value keeps its type (REG_EXPAND_SZ). [Environment]::SetEnvironmentVariable read it
// expanded and wrote it back as a plain string, freezing every %VAR% entry at today's value. Removing a
// variable that isn't there makes .NET tell running programs (Explorer) that the environment changed.
var __cbLinkCli = async (dir, names) => {
  const fs = require("fs"), path = require("path"), shims = __cbCliShims();
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) for (const [ext, text] of Object.entries(shims)) fs.writeFileSync(path.join(dir, n + ext), text);
  const ps = "$d='" + dir.replaceAll("'", "''") + "';$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');" +
    "$p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);" +
    "$t=if($k.GetValueNames() -contains 'Path'){$k.GetValueKind('Path')}else{[Microsoft.Win32.RegistryValueKind]::ExpandString};" +
    "if(-not(($p -split ';'|ForEach-Object{[Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\')}) -contains $d.TrimEnd('\\'))){" +
    "$k.SetValue('Path',((@($p.TrimEnd(';'),$d)|Where-Object{$_}) -join ';'),$t);[Environment]::SetEnvironmentVariable('CARDBOARD_PATH_CHANGED',$null,'User')}";
  await new Promise((res, rej) => require("child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], (e) => (e ? rej(e) : res())));
};
// Host Claude Code / Codex lookup on Windows. Cardboard only looked for <name>.cmd on PATH, which
// misses .exe installs (Codex, the native Claude Code installer), and Node refuses to execFile a
// .cmd (EINVAL), so its start check failed. Take .exe files, and follow npm .cmd shims to their .exe.
// npm's shim for a JavaScript package runs "%dp0%\node.exe" when Node sits next to it (nvm-windows, fnm,
// a prefix in Node's folder); that is Node, not the agent, and its --version check passes. Those shims
// are skipped.
var __cbAgentPaths = (pathStr, name) => {
  const fs = require("fs"), path = require("path");
  const out = [];
  for (const dir of pathStr.split(path.delimiter).map((d) => d.replace(/"/g, "")).filter((d) => d !== "")) {
    const exe = path.join(dir, name + ".exe");
    if (fs.existsSync(exe)) out.push(exe);
    try {
      const m = [...fs.readFileSync(path.join(dir, name + ".cmd"), "utf8").matchAll(/"%~?dp0%?\\?([^"%]+\.exe)"/gi)]
        .find((x) => !/(^|\\)node\.exe$/i.test(x[1]));
      if (m) out.push(path.join(dir, m[1]));
    } catch {}
  }
  return out;
};
// Windows only shows notifications from an app with an AppUserModelID that a Start Menu shortcut
// also carries. Set the ID, and create or fix the shortcuts that launch this exe (Start Menu,
// Desktop, taskbar pin) so they carry it too and stay grouped with the window.
var __cbAumid = "ai.cardboard.desktop";
var __cbNotifySetup = () => {
  if (!__cbWin) return;
  const { app, shell } = require("electron"), fs = require("fs"), path = require("path");
  app.setAppUserModelId(__cbAumid);
  const exe = process.execPath, appData = app.getPath("appData");
  const ours = (l) => l.target.toLowerCase() === exe.toLowerCase();
  const links = [
    [path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Cardboard.lnk"), true],
    [path.join(app.getPath("desktop"), "Cardboard.lnk"), false],
    [path.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", "Cardboard.lnk"), false],
  ];
  for (const [lnk, create] of links) {
    try {
      let cur = null;
      try { cur = shell.readShortcutLink(lnk); } catch {}
      if (cur ? !ours(cur) || cur.appUserModelId === __cbAumid : !create) continue;
      shell.writeShortcutLink(lnk, cur ? "update" : "create", { target: exe, cwd: path.dirname(exe), icon: exe, iconIndex: 0, appUserModelId: __cbAumid });
    } catch (e) { console.warn("[desktop] could not update " + lnk + ":", e); }
  }
};
// Default install locations, for when PATH is stale (e.g. Explorer started before the install).
var __cbAgentKnown = (name) => {
  const path = require("path"), home = require("os").homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return { claude: [path.join(home, ".local", "bin", "claude.exe")], codex: [path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe")] }[name] ?? [];
};
// A copy of the environment with the search path under PATH. Windows names it Path when Explorer
// starts the app; process.env ignores case but a copy of it doesn't, and Cardboard reads and sets
// PATH on its copy.
var __cbEnv = () => {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) out[/^path$/i.test(k) ? "PATH" : k] = v;
  return out;
};
// Windows title bar: Cardboard's tab strip takes the place of the native title bar and menu bar, as it
// does on macOS. The window controls stay native (Snap Layouts, the red close hover), drawn over the
// strip's right end on a clear background so the strip shows through. The strip draws the app menu
// (patch-strip.js) from this description of it, and has main run the item picked.
var __cbTitleBar = { color: "#00000000", symbolColor: "#a3a3a3", height: 40 };
var __cbMenuJson = (items, at = []) => items.flatMap((m, i) => m.visible === false ? [] : [{
  path: [...at, i],
  type: m.type,
  label: m.label,
  enabled: m.enabled !== false,
  checked: !!m.checked,
  accelerator: m.submenu ? null : m.accelerator ?? m.getDefaultRoleAccelerator?.() ?? null,
  submenu: m.submenu ? __cbMenuJson(m.submenu.items, [...at, i]) : null,
}]);
var __cbMenuRun = (path, win, wc) => {
  let items = require("electron").Menu.getApplicationMenu()?.items ?? [], m = null;
  for (const i of Array.isArray(path) ? path : []) {
    m = items[i];
    if (!m) return;
    items = m.submenu?.items ?? [];
  }
  if (m && m.enabled !== false && m.visible !== false && !m.submenu && m.type !== "separator")
    m.click({ triggeredByAccelerator: false, __cbStrip: true }, win ?? undefined, wc ?? undefined);
};
// Alt pressed and released on its own, or F10, opens the menu, as with a native menu bar. A click or
// another key while Alt is down cancels it (Alt+drag duplicates clips, Shift+F10 is the context menu),
// and so does Alt pressed with a mouse button held: Alt in the middle of a drag, released after the drop.
var __cbMenuKeys = (wc, open) => {
  let armed = false;
  const held = new Set();
  wc.on("before-input-event", (e, i) => {
    if (i.type === "keyDown" && i.key === "F10" && !i.shift && !i.control && !i.alt && !i.meta) {
      e.preventDefault();
      armed = false;
      __cbLog("menu.open", { via: "F10" });
      open();
    } else if (i.type === "keyDown") armed = i.key === "Alt" ? (i.isAutoRepeat ? armed : held.size === 0 && !i.shift && !i.control && !i.meta) : false;
    else if (i.type === "keyUp" && i.key === "Alt" && armed) {
      armed = false;
      __cbLog("menu.open", { via: "Alt" });
      open();
    }
    // A key let go while Alt is down is a combination too, even one whose press never came here
    // (Alt+PrintScreen: Windows keeps the press for the screenshot).
    else if (i.type === "keyUp" && i.key !== "Alt") armed = false;
  });
  // Which mouse buttons are down. Mouse events name their button, and a move the one held ("none" when none
  // is, which also catches a release that never came here, as after a drag and drop); they carry no
  // modifiers. Wheel events list every button down.
  wc.on("input-event", (_, i) => {
    if (i.type === "mouseDown") armed = false, held.add(i.button);
    else if (i.type === "mouseUp") armed = false, held.delete(i.button);
    else if (i.type === "mouseMove") {
      if (!i.button || i.button === "none") held.clear();
      else armed = false, held.add(i.button);
    } else if (i.type === "mouseWheel" || i.type === "touchStart") {
      armed = false;
      if (Array.isArray(i.modifiers)) {
        held.clear();
        for (const m of i.modifiers) /^(left|middle|right)buttondown$/i.test(m) && held.add(m.slice(0, -10).toLowerCase());
      }
    }
  });
  wc.on("blur", () => { armed = false; held.clear(); });
};
// File > Import Folder…: the media in a folder and its subfolders, imported the way Import Media
// imports files. The picker runs in the editor, which then gets the media through its own
// "editor:import-media" event, so the usual checks and progress apply. File pickers need a user
// gesture, which a menu click does not give the page, so it runs with one.
var __cbMediaExts = () => {
  try { return GK(); } catch { return ["mp4", "webm", "mov", "avi", "mkv", "m4v", "mxf", "mts", "m2ts", "ts", "3gp", "wmv", "mp3", "wav", "ogg", "oga", "opus", "aac", "m4a", "flac", "aif", "aiff", "caf", "wma", "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif", "hif"]; }
};
var __cbPickFolder = (exts) => new Promise((done) => {
  const ok = new Set(exts), input = document.createElement("input");
  const rel = (f) => f.webkitRelativePath || f.name;
  input.type = "file";
  input.multiple = true;
  input.webkitdirectory = true;
  input.onchange = () => {
    const all = Array.from(input.files ?? []);
    const files = all
      .filter((f) => ok.has(f.name.split(".").pop().toLowerCase()))
      .sort((a, b) => rel(a).localeCompare(rel(b), undefined, { numeric: true, sensitivity: "base" }));
    if (files.length > 0) window.dispatchEvent(new CustomEvent("editor:import-media", { detail: { files } }));
    done({ picked: true, media: files.length });
  };
  input.oncancel = () => done({ picked: false });
  input.click();
});
// File > Import Media… from a menu pressed Cardboard's Ctrl+I in the page, and that picker only opened
// when the editor had been clicked in the last few seconds. Ask the editor for its picker with a gesture.
var __cbImportMedia = (wc) => {
  if (!wc || wc.isDestroyed()) return;
  wc.focus();
  wc.executeJavaScript('window.dispatchEvent(new CustomEvent("editor:import-media"))', true)
    .catch((e) => console.warn("[desktop] import media failed:", e));
};
var __cbImportFolder = async (win, wc, projectId) => {
  const { dialog } = require("electron");
  const tell = (o) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  if (!projectId || !wc || wc.isDestroyed()) {
    await tell({ type: "info", message: "Open a project to import a folder into it", buttons: ["OK"] });
    return;
  }
  wc.focus();
  const r = await wc.executeJavaScript("(" + __cbPickFolder + ")(" + JSON.stringify(__cbMediaExts()) + ")", true)
    .catch((e) => console.warn("[desktop] import folder failed:", e));
  if (r?.picked && r.media === 0)
    await tell({ type: "info", message: "That folder has no media", detail: "Cardboard imports video, audio and image files, and found none in the folder or its subfolders.", buttons: ["OK"] });
};
// Activity log: one JSON object per line in <userData>\logs\activity-<date>.jsonl, for looking back at
// how a session went. It has what the Director's transcripts don't: shortcuts and menu items used, keys
// that did nothing, how and how fast agent questions were answered, warnings and errors (main, the
// library worker, the pages, error toasts). Never text typed into a field. Kept 14 days.
var __cbLogS = { dir: null, buf: [], timer: null, chain: Promise.resolve(), rate: new Map(), held: null };
var __cbStamp = (d = new Date()) => {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, "0"), o = -d.getTimezoneOffset();
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" +
    p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3) + (o < 0 ? "-" : "+") + p(Math.trunc(o / 60)) + ":" + p(o % 60);
};
var __cbLogLine = (rec) => {
  const line = JSON.stringify(rec);
  __cbLogS.buf.push(line.length > 4096 ? JSON.stringify({ t: rec.t, ev: rec.ev, cut: line.slice(0, 4000) }) : line);
};
// A shortcut pressed again and again (stepping frames) is one line with a count, written once the run ends.
var __cbLogRelease = () => {
  const h = __cbLogS.held;
  __cbLogS.held = null;
  if (h) __cbLogLine(h.rec);
};
var __cbLog = (ev, fields) => {
  const s = __cbLogS, now = Date.now();
  if (ev === "shortcut") {
    const key = fields.id + "\0" + fields.combo + "\0" + fields.project;
    if (s.held?.key === key && now - s.held.t < 2000) {
      s.held.rec.n = (s.held.rec.n ?? 1) + 1;
      s.held.t = now;
      s.timer ??= setTimeout(__cbLogFlush, 1000);
      return;
    }
  }
  // At most 120 lines a minute of each kind, so a runaway error can't fill the disk.
  let r = s.rate.get(ev);
  if (!r || now - r.t > 6e4) {
    if (r?.dropped) __cbLogLine({ t: __cbStamp(), ev: "log.dropped", of: ev, n: r.dropped });
    s.rate.set(ev, (r = { t: now, n: 0, dropped: 0 }));
  }
  if (++r.n > 120) return void r.dropped++;
  __cbLogRelease();
  const rec = { t: __cbStamp(), ev, ...fields };
  if (ev === "shortcut") s.held = { key: fields.id + "\0" + fields.combo + "\0" + fields.project, rec, t: now };
  else __cbLogLine(rec);
  if (s.buf.length >= 200) __cbLogFlush();
  else s.timer ??= setTimeout(__cbLogFlush, 1000);
};
var __cbLogFlush = (sync = false) => {
  const s = __cbLogS, fs = require("fs"), path = require("path");
  clearTimeout(s.timer);
  s.timer = null;
  if (s.held && (sync || Date.now() - s.held.t >= 2000)) __cbLogRelease();
  if (s.held) s.timer = setTimeout(__cbLogFlush, 1000);
  if (s.buf.length === 0) return;
  const data = s.buf.join("\n") + "\n";
  s.buf = [];
  if (!s.dir) {
    s.dir = path.join(require("electron").app.getPath("userData"), "logs");
    try { fs.mkdirSync(s.dir, { recursive: true }); } catch {}
    // Drop logs older than 14 days.
    fs.readdir(s.dir, (e, names) => {
      for (const n of names ?? []) {
        const m = /^activity-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(n);
        if (m && Date.now() - Date.parse(m[1]) > 15 * 864e5) fs.rm(path.join(s.dir, n), { force: true }, () => {});
      }
    });
  }
  const file = path.join(s.dir, "activity-" + __cbStamp().slice(0, 10) + ".jsonl");
  if (sync) { try { fs.appendFileSync(file, data); } catch {} return; }
  // One write at a time, so lines keep their order.
  s.chain = s.chain.then(() => require("fs/promises").appendFile(file, data)).catch(() => {});
};
// "CmdOrCtrl+Shift+E" → "Ctrl+Shift+E", the way the pages name keys.
var __cbAccelCombo = (a) => {
  const parts = a.split(/\+(?!$)/), key = parts.pop(), mods = new Set();
  for (const p of parts)
    mods.add(/^(CmdOrCtrl|CommandOrControl|Control|Ctrl|Cmd|Command)$/i.test(p) ? "Ctrl" : /^(Alt|Option|AltGr)$/i.test(p) ? "Alt" : /^shift$/i.test(p) ? "Shift" : "Win");
  const k = { Return: "Enter", Escape: "Esc", Plus: "+", Space: "Space" }[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return ["Ctrl", "Alt", "Shift", "Win"].filter((m) => mods.has(m)).concat(k).join("+");
};
// Menu items run from the strip's menu or by their accelerator.
var __cbAccels = [];
var __cbLogMenu = (menu) => {
  const walk = (items, at) => {
    for (const m of items) {
      const name = at + (m.label || m.role || "").replace(/&/g, "");
      if (m.submenu) walk(m.submenu.items, name + " > ");
      else if (m.type !== "separator" && typeof m.click === "function") {
        const click = m.click;
        m.click = (e, ...rest) => {
          try {
            const a = m.accelerator ?? m.getDefaultRoleAccelerator?.() ?? null, combo = a ? __cbAccelCombo(a) : undefined;
            const via = e?.__cbStrip ? "strip" : e?.triggeredByAccelerator ? "accelerator" : "menu";
            if (via === "accelerator") __cbAccels = [...__cbAccels.slice(-9), { combo, t: Date.now() }];
            __cbLog("menu", { item: name, via, combo });
          } catch {}
          return click.call(m, e, ...rest);
        };
      }
    }
  };
  walk(menu.items, "");
  return menu;
};
// What the pages report (patch-renderer.js). A key the page left alone may have been a menu accelerator,
// which runs right after it; those are in the log as menu items already.
var __cbLogFrom = (d, wc) => {
  if (!d || !/^(key|shortcut|error|toast|playback\.(wait|forced)|preview\.(slow|rebuild)|canvas\.restored)$/.test(d.ev)) return;
  const { ev, ...f } = d, m = /\/app\/editor\/([^/?#]+)/.exec(wc?.getURL?.() ?? "");
  if (m) f.project = m[1];
  if (ev !== "key" || f.handled !== false) return __cbLog(ev, f);
  const t = Date.now(), ran = () => __cbAccels.some((a) => a.combo === f.combo && Math.abs(a.t - t) < 600);
  if (!ran()) setTimeout(() => ran() || __cbLog(ev, f), 300);
};
// Agent questions: when each was asked, so the answer can say how long it waited.
var __cbQuestions = new Map();
var __cbAsked = (project, q) => {
  try {
    if (__cbQuestions.size > 100) __cbQuestions.delete(__cbQuestions.keys().next().value);
    __cbQuestions.set(q.id, { t: Date.now(), project, kind: q.generation ? "generation" : q.clone ? "clone" : "question",
      approve: q.questions?.[0]?.options?.[0]?.label, credits: q.generation?.credits });
  } catch {}
};
// The answer itself is in the transcript; this has how it was given and how long it took.
var __cbLogAnswer = (id, answers, via) => {
  try {
    const q = __cbQuestions.get(id), vals = answers && typeof answers === "object" ? Object.values(answers) : [];
    __cbQuestions.delete(id);
    const outcome = vals.length === 0 ? "skipped" : q?.kind === "generation" ? (vals.every((v) => v === q.approve) ? "approved" : "replied") : "answered";
    __cbLog("director.answer", { id, kind: q?.kind, outcome, waitMs: q ? Date.now() - q.t : undefined, via: typeof via === "string" ? via.slice(0, 48) : undefined,
      credits: typeof q?.credits === "number" ? Math.round(q.credits * 100) / 100 : undefined, project: q?.project });
  } catch {}
};
// The library worker's output, which went straight to the console, goes to the log too.
var __cbPipeWorker = (child) => {
  for (const [name, out] of [["stdout", process.stdout], ["stderr", process.stderr]]) {
    let rest = "";
    child[name]?.on("data", (d) => {
      out.write(d);
      const lines = (rest + d).split(/\r?\n/);
      rest = lines.pop().slice(-4000);
      for (const l of lines) if (l.trim()) __cbLog("worker", { msg: l.slice(0, 2000) });
    });
  }
};
// The fast GPU, on AC power (patch 13). The GPU is chosen before the app is ready; Electron's powerMonitor
// already answers then on Windows (checked on Electron 43: on battery it said so before and after ready,
// in 0.01 ms). If it can't answer, the default GPU, as before.
var __cbGpuAsked = "default";
var __cbOnAc = () => {
  let ac = false;
  try { ac = require("electron").powerMonitor.isOnBatteryPower() === false; } catch {}
  if (ac) __cbGpuAsked = "high-performance";
  return ac;
};
// NVIDIA laptops power the discrete GPU off when it's idle, and the GPU process waited for it to power up
// before the first frame (measured: +135 ms to a usable Dashboard, +260 ms to first paint). nvidia-smi,
// which ships with the driver, wakes it while the app is still loading. Elsewhere it isn't there: nothing.
var __cbWakeGpu = () => {
  try {
    const exe = require("path").join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe");
    if (require("fs").existsSync(exe)) require("child_process").spawn(exe, ["-L"], { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {}
};
var __cbLogStart = () => {
  const { app, screen } = require("electron");
  __cbLog("app.start", { version: app.getVersion(), electron: process.versions.electron, os: require("os").release(),
    displays: screen.getAllDisplays().map((d) => d.size.width + "x" + d.size.height + "@" + d.scaleFactor) });
  app.on("will-quit", () => { __cbLog("app.quit", {}); __cbLogFlush(true); });
  // Which GPU draws the app (PCI vendor: 0x10de NVIDIA, 0x8086 Intel, 0x1002 AMD), and processes that die:
  // a GPU process crash or reset blanks canvases, a renderer's takes a tab. Only the "complete" GPU info
  // marks the GPU in use ("basic" marks none), so it is read once the app has settled.
  setTimeout(() => app.getGPUInfo("complete").then((i) => {
    const all = i.gpuDevice ?? [], d = all.find((g) => g.active);
    const hex = (n) => (typeof n === "number" ? "0x" + n.toString(16).padStart(4, "0") : undefined);
    __cbLog("gpu", { vendor: hex(d?.vendorId), device: hex(d?.deviceId), gpus: all.length, asked: __cbGpuAsked });
  }).catch(() => {}), 15000).unref?.();
  app.on("child-process-gone", (e, d) => __cbLog("process.gone", { type: d.type, reason: d.reason, exitCode: d.exitCode }));
  app.on("render-process-gone", (e, w, d) => __cbLog("process.gone", { type: "renderer", reason: d.reason, exitCode: d.exitCode }));
};
// Main's own warnings and errors ([desktop] …), which only reached a console nobody sees.
if (process.type === "browser") {
  for (const level of ["warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      orig(...a);
      try {
        const msg = require("util").format(...a);
        // Notices printed on every start, which say nothing about the session: Node deprecations
        // (fs.Stats) and the Agent SDK's note that bypassPermissions skips canUseTool.
        if (!/^\(node:\d+\) \[(DEP\d+|CLAUDE_SDK_CAN_USE_TOOL_SHADOWED)\]/.test(msg)) __cbLog("main." + level, { msg: msg.slice(0, 2000) });
      } catch {}
    };
  }
}
`;
const firstNl = src.indexOf("\n");
src = src.slice(0, firstNl + 1) + preamble + src.slice(firstNl + 1);

// 1. Bundled ffmpeg/ffprobe/uv/claude are .exe on Windows.
replace(`sd((0,li.join)(n,"ffmpeg"))`, `sd((0,li.join)(n,__cbExe("ffmpeg")))`);
replace(`sd((0,li.join)(n,"ffprobe"))`, `sd((0,li.join)(n,__cbExe("ffprobe")))`);
replace(`sd((0,li.join)(n,"uv"))`, `sd((0,li.join)(n,__cbExe("uv")))`);
replace(`(0,Jg.join)(t,"director","claude")`, `(0,Jg.join)(t,"director",__cbExe("claude"))`);

// 2. Desktop Director (local Claude Code agent) was gated to darwin-arm64.
replace(
  `(e.platform??process.platform)!=="darwin"||(e.arch??process.arch)!=="arm64")return"Desktop Director`,
  `!((e.platform??process.platform)==="win32"||(e.platform??process.platform)==="darwin"&&(e.arch??process.arch)==="arm64"))return"Desktop Director`,
);

// 3. Director tool shims: symlinks and /bin/sh scripts do not work on Windows.
replace(`jTe=(e,t,r)=>{`, `jTe=(e,t,r)=>{if(__cbWin)return __cbTools(e,t,r,{envName:tWt(),py:JA,pkgs:NTe});`);
// The folder of the real ffmpeg.exe and ffprobe.exe goes on the agent's PATH after the shims. Windows
// starts a bare "ffmpeg" (Python's subprocess.run(["ffmpeg", …]), Node's execFile) only as an .exe, so
// agent code that ran ffmpeg that way failed with "file not found". The shims still come first for
// Git Bash, cmd and PowerShell. On macOS the tool folder holds symlinks to the binaries themselves.
replace(`e.toolsDir&&(n.PATH=[e.toolsDir,n.PATH]`, `e.toolsDir&&(n.PATH=[e.toolsDir,...__cbToolBins,n.PATH]`);
replace(`e.toolsDir&&(r.PATH=[e.toolsDir,r.PATH]`, `e.toolsDir&&(r.PATH=[e.toolsDir,...__cbToolBins,r.PATH]`);

// 4. Control socket (used by the cardboard CLI and the agent) listens on a named pipe on Windows.
// CARDBOARD_SOCKET keeps the file path: the CLI reads the token next to it and maps it to the
// same pipe when connecting (see patch-cli.js).
replace(`(0,NH.join)(t,vb)`, `__cbSock((0,NH.join)(t,vb))`);

// 5. "Install agent tools" (cardboard/cb CLI for external agents) was macOS-only (osascript + /usr/local/bin).
replace(`O5="/usr/local/bin"`, `O5=__cbWin?(0,FE.join)(require("node:os").homedir(),".local","bin"):"/usr/local/bin"`);
replace(`Jje=e=>{`, `Jje=e=>{if(__cbWin)return __cbLinkCli(O5,fie);`);
replace(
  `pie=()=>process.platform!=="darwin"?"Agent tools can only be installed on macOS."`,
  `pie=()=>process.platform!=="darwin"&&!__cbWin?"Agent tools can only be installed on macOS."`,
);
// The cb/cardboard shims Cardboard writes for your own agents (Settings → Agents) in userData\agent-bin, at
// the front of their PATH. On Windows it wrote only .cmd files, which Git Bash, Claude Code's shell, can't
// run by name: `cb` was "command not found" unless agent tools were installed (~/.local/bin). Now the sh
// shim too, as on macOS, and the .cmd with setlocal (see __cbCliShims).
replace(
  'if(process.platform==="win32"){(0,Dp.writeFileSync)((0,dw.join)(e,`${n}.cmd`),dqt(r,t));continue}',
  'if(process.platform==="win32"){let s=__cbCliShims(r,t);(0,Dp.writeFileSync)((0,dw.join)(e,`${n}.cmd`),s[".cmd"]),(0,Dp.writeFileSync)((0,dw.join)(e,n),s[""]);continue}',
);
replace(
  `xh=()=>{let e=fie.map(`,
  `xh=()=>{if(__cbWin){let r=fie.every(n=>__cbLinked((0,FE.join)(O5,n+".cmd")));return{linked:r,target:r?(0,FE.join)(O5,"cardboard.cmd"):null,unavailable:pie()}}let e=fie.map(`,
);

// 6. Finding the user's own Claude Code and Codex (see __cbAgentPaths).
replace(`bHt=(e,t)=>{`, `bHt=(e,t)=>{if(__cbWin)return __cbAgentPaths(e,t).filter(Sl);`);
replace(`fHt=e=>[`, `fHt=e=>__cbWin?__cbAgentKnown(e):[`);
// The environment agents are found and started with. Copied as-is, it has Path but no PATH when
// launched from Explorer, so the lookup searched nothing. Launching then added a PATH holding only
// Cardboard's shim folder, which Windows children get instead of Path.
replace(`if(process.platform==="win32")return{...process.env};`, `if(process.platform==="win32")return __cbEnv();`);

// 7. Notifications when an agent needs you: an AppUserModelID so Windows shows them, and a
// taskbar flash where macOS bounces the Dock icon (it stops when the window is focused). On start the
// cardboard/cb shims an earlier build installed are updated too (__cbRelinkCli).
replace(
  `e=oe.app.whenReady().then(async()=>{let r=process.platform==="darwin"&&hSe();`,
  `e=oe.app.whenReady().then(async()=>{__cbNotifySetup();__cbLogStart();__cbRelinkCli().catch(()=>{});let r=process.platform==="darwin"&&hSe();`,
);
replace(`oe.app.dock?.bounce("informational")`, `(oe.app.dock?.bounce("informational"),__cbWin&&he.window?.flashFrame(!0))`);

// 8. Fewer animations, in Cardboard only: report prefers-reduced-motion as if Windows' "Animation
// effects" were off. Cardboard then drops its scale and slide animations and most fades.
replace(
  `oe.app.commandLine.appendSwitch("autoplay-policy","no-user-gesture-required");`,
  `oe.app.commandLine.appendSwitch("autoplay-policy","no-user-gesture-required");__cbWin&&oe.app.commandLine.appendSwitch("force-prefers-reduced-motion");`,
);

// 9. Windows title bar (see __cbTitleBar). hiddenInset is macOS-only, so Windows drew its own title bar
// and menu bar above the strip. Now the window has no native title bar and the strip is the title bar.
replace(
  `titleBarStyle:"hiddenInset",trafficLightPosition:{x:16,y:14},backgroundColor:this.welcoming?_w:vw`,
  `titleBarStyle:__cbWin?"hidden":"hiddenInset",...__cbWin&&{titleBarOverlay:__cbTitleBar},trafficLightPosition:{x:16,y:14},backgroundColor:this.welcoming?_w:vw`,
);
// The About window too: it showed a native title bar and the whole menu bar. Its page already has a
// drag region and leaves room at the top for the macOS traffic lights.
replace(
  `titleBarStyle:Hne?"hidden":"default",trafficLightPosition:{x:14,y:14}`,
  `titleBarStyle:Hne||__cbWin?"hidden":"default",...__cbWin&&{titleBarOverlay:__cbTitleBar},trafficLightPosition:{x:14,y:14}`,
);
// The strip asks for the menu and runs items from it; closing it hands the keyboard back to the editor.
replace(
  `_e.handle("tabs:command",t=>{Bt(),he.command(t)}),`,
  `_e.handle("tabs:command",t=>{Bt(),he.command(t)}),` +
    `_e.handle("window:menu",()=>__cbMenuJson(oe.Menu.getApplicationMenu()?.items??[])),` +
    `_e.handle("window:menu-run",({path:t})=>{let r=he.activeContents();r?.focus(),__cbMenuRun(t,he.liveWindow(),r)}),` +
    `_e.handle("window:menu-close",()=>{he.activeContents()?.focus()}),`,
);
// Alt or F10 in a tab opens the strip's menu with the keyboard in it.
replace(
  `s.on("blur",()=>this.setModifierHeld(!1)),`,
  `s.on("blur",()=>this.setModifierHeld(!1)),__cbWin&&__cbMenuKeys(s,()=>{this.strip&&this.stripVisible()&&(this.strip.webContents.focus(),this.toStrip("window:menu-open",{}))}),`,
);

// 10. File > Import Folder… (Ctrl+Shift+I), below Import Media… (see __cbImportFolder), and Import Media…
// from a menu opening its picker every time (__cbImportMedia). Folders dropped on the editor or the
// Dashboard are handled in the renderer (patch-renderer.js).
replace(
  String.raw`_i("Import Media\u2026","import-media","CmdOrCtrl+I",e),{type:"separator"}`,
  String.raw`{..._i("Import Media\u2026","import-media","CmdOrCtrl+I",e),click:()=>{__cbImportMedia(e.getContents())}},{label:"Import Folder\u2026",accelerator:"CmdOrCtrl+Shift+I",click:()=>{__cbImportFolder(e.getWindow(),e.getContents(),e.tabs.model.activeProjectId())}},{type:"separator"}`,
);

// 11. The activity log (see __cbLog; it starts with patch 7's whenReady). Menu items say how they ran,
// pages report through cb:log, agent answers say how long their question waited, Ctrl+Tab (which main
// handles itself) is logged as a shortcut, and the library worker's output goes in too.
replace(`dc.Menu.setApplicationMenu(dc.Menu.buildFromTemplate(s))`, `dc.Menu.setApplicationMenu(__cbLogMenu(dc.Menu.buildFromTemplate(s)))`);
replace(
  `_e.handle("local-agent:answer",({id:t,answers:r,choice:n,cloned:i})=>{`,
  `_e.handle("cb:log",(t,r)=>__cbLogFrom(t,r?.sender)),_e.handle("local-agent:answer",({id:t,answers:r,choice:n,cloned:i,via:__cbVia})=>{__cbLogAnswer(t,r,__cbVia);`,
);
replace(`onQuestion(t,r,n,i,s){`, `onQuestion(t,r,n,i,s){__cbAsked(t,i);`);
replace(
  `r.webContents.on("before-input-event",(i,s)=>{Dke(s)&&(i.preventDefault(),s.type==="keyDown"&&this.model.step(s.shift?-1:1))})`,
  `r.webContents.on("before-input-event",(i,s)=>{Dke(s)&&(i.preventDefault(),s.type==="keyDown"&&(s.isAutoRepeat||__cbLog("shortcut",{id:s.shift?"previous-tab":"next-tab",combo:s.shift?"Ctrl+Shift+Tab":"Ctrl+Tab"}),this.model.step(s.shift?-1:1)))})`,
);
replace(`stdio:"inherit"})}catch(o){this.stopped=!0`, `stdio:"pipe"}),__cbPipeWorker(s)}catch(o){this.stopped=!0`);

// 12. Windows wording where main names the Mac: "this PC" for "this Mac", File Explorer for Finder (the
// sign-out and quit dialogs, an agent that isn't installed, the agent's reveal step). patch-renderer.js
// does the same for the pages.
for (const end of ["restarts on the sign-in screen.", "quits."])
  replace(`"Your open projects close and Cardboard ${end} Your projects stay on this Mac."`,
    `(__cbWin?"Your open projects close and Cardboard ${end} Your projects stay on this PC.":"Your open projects close and Cardboard ${end} Your projects stay on this Mac.")`);
replace("`${d.label} is not installed on this Mac.`", "`${d.label} is not installed on this ${__cbWin?\"PC\":\"Mac\"}.`");
replace(
  `reveal:{running:"Revealing the project in Finder",done:"Revealed the project in Finder"}`,
  `reveal:{running:__cbWin?"Revealing the project in File Explorer":"Revealing the project in Finder",done:__cbWin?"Revealed the project in File Explorer":"Revealed the project in Finder"}`,
);

// 13 (speed). The fast GPU on laptops with two, on AC power. Windows gives an app the power-saving GPU
// unless the app asks: on a laptop with an RTX 3050 Cardboard drew everything (preview, timeline,
// graphics, its own video decoding) on the integrated Intel GPU, which shares system RAM, while the RTX
// sat idle. Measured on the RTX: a graphic with video 41–50 frames/s against 24–26, a third to a seventh
// as many editor frames over 50 ms, ~900 MB less system RAM taken as GPU memory. The RTX, otherwise powered
// off, then draws 3.3 W with Cardboard idle and ~9 W while a graphic plays (measured, nvidia-smi), so on
// battery the app keeps the default GPU (__cbOnAc, the power state when it starts; a change
// takes effect at the next start). Its power-up is started early (__cbWakeGpu). A choice made for
// Cardboard in Windows' Settings > Display > Graphics still wins (measured: "Power saving" there keeps it
// on the integrated GPU with this switch on). One GPU or none: the switch does nothing.
if (speed)
  replace(
    `__cbWin&&oe.app.commandLine.appendSwitch("force-prefers-reduced-motion");`,
    `__cbWin&&oe.app.commandLine.appendSwitch("force-prefers-reduced-motion");__cbWin&&__cbOnAc()&&(oe.app.commandLine.appendSwitch("force_high_performance_gpu"),__cbWakeGpu());`,
  );

// 14. The telemetry warning says why the upload failed. Each failed upload of an analytics event files a
// defect about it, and when that defect can't be sent either main warns "[telemetry] sentry delivery
// failed" (145 of them in an hour of exports) without the reason, an HTTP status or a network error.
// The reason is Cardboard's own fixed message ("Telemetry relay failed (429)", "fetch failed").
replace(
  "deliver(t,r=!0){this.send(t).catch(()=>{r?this.defect({process:\"main\",kind:\"telemetry_delivery\",workflow_stage:t.kind}):this.deps.warn(`[telemetry] ${t.kind} delivery failed`)})}",
  "deliver(t,r=!0){this.send(t).catch(__cbE=>{r?this.defect({process:\"main\",kind:\"telemetry_delivery\",workflow_stage:t.kind}):this.deps.warn(`[telemetry] ${t.kind} delivery failed`+(__cbE?.message?`: ${String(__cbE.message).slice(0,120)}`:\"\"))})}",
);

fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes${speed ? "" : ", baseline"})`);
