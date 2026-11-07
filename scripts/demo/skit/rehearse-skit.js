// The whole skit on this box (README.md "Rehearsing on Linux"): a local sharing server; Vikas, a participant playing the
// laptop's app, with the promo shared; Claude 2 joined as "Claude"; the stand-in (actor.js) on Claude 1's scene; and the
// real Claude Code CLI in Vikas's project (its own config folder, ANTHROPIC_BASE_URL at the stand-in, a dead proxy for
// anything else) running Cardboard's real cb from its PATH, as the app runs its agent. Claude 2's cue sheet runs beside
// it. The app's editor runs in Chromium for `cb app …` (app-player.js: Cardboard's own playback, Loading audio… and
// all), as Claude 1's seek/play/pause reach the laptop's. Then the app side's editor and History in Chromium (shots.js)
// at the moments that matter.
//   DEMO_DIR=~/gfv-scratch/carton/demo-skit node rehearse-skit.js [--claude <path>] [--no-shots] [--gone-after <s>]
//     [--end-after <s>] [--media-delay <ms>] [--setup-only]
// --gone-after / --end-after: the operator's cues, that long after the stand-in starts waiting for them (no
// --end-after: 3 s). --media-delay: the app's first fetch of each sound waits that long (the laptop's download).
// Everything goes to $DEMO_DIR/skit-runs/<time>/: chat.txt (what the chat panel would show, timed), chat.jsonl (Claude
// Code's own stream), actor.log, claude2.log, app.log and app-trace.jsonl (the app's playback), timeline.txt (all of
// them merged), shots/.
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn, spawnSync, execFileSync } = require("child_process");
const readline = require("readline");

const HERE = __dirname, DEMO_SCRIPTS = path.join(HERE, "..");
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const DEMO = process.env.DEMO_DIR || path.join(os.homedir(), "gfv-scratch", "carton", "demo-skit");
process.env.DEMO_DIR = DEMO;
process.env.DEMO_TTS ??= path.join(os.homedir(), "gfv-scratch", "carton", "demo", "tts");
process.env.TMPDIR ??= path.join(DEMO, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
const lib = require("../lib.js");
const CLAUDE = opt("claude", path.join(os.homedir(), ".local", "bin", "claude"));
const HOST_PORT = Number(opt("host-port", 8795)), ACTOR_PORT = Number(opt("actor-port", 8796));
const SOCK = path.join(DEMO, "app-sock", "cardboard.sock"); // app-player.js, the running app for `cb app …`
const scene = JSON.parse(fs.readFileSync(path.join(HERE, "claude1-scene.json"), "utf8"));
const RUN = path.join(DEMO, "skit-runs", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(RUN, { recursive: true });
const t0 = Date.now();
const stamp = (ms = Date.now()) => `${new Date(ms).toISOString().slice(11, 23)} +${((ms - t0) / 1000).toFixed(1).padStart(6)}s`;
const note = (s) => { const l = `${stamp()}  ${s}`; console.log(l); fs.appendFileSync(path.join(RUN, "rehearsal.log"), l + "\n"); };
const peer = (...args) => {
  const r = spawnSync(process.execPath, [path.join(DEMO_SCRIPTS, "peer"), ...args], { env: process.env, encoding: "utf8" });
  const out = (r.stdout + r.stderr).trim();
  if (r.status !== 0) throw new Error(`peer ${args.join(" ")}: ${out}`);
  return out;
};

(async () => {
  // 1. the project, shared, and Claude 2 in it (this folder's own participants only)
  for (const n of ["Claude", "Vikas"]) { try { peer("--peer", n, "leave"); } catch {} }
  try { peer("host", "stop"); } catch {} // before its folder moves (host stop reads its pid there)
  await new Promise((r) => setTimeout(r, 600));
  const old = path.join(DEMO, "old", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const d of ["peer-claude", "peer-vikas", "host"]) if (fs.existsSync(path.join(DEMO, d))) { fs.mkdirSync(old, { recursive: true }); fs.renameSync(path.join(DEMO, d), path.join(old, d)); }
  if (!fs.existsSync(path.join(DEMO, "build", "build.json"))) note(peer("setup"));
  note(peer("host", "start", "--port", String(HOST_PORT)));
  note(peer("app", "--name", "Vikas"));
  note(peer("--peer", "Vikas", "create", scene.project, "--tsx", path.join(HERE, "promo.tsx")));
  note(peer("--peer", "Vikas", "share", "--host", `http://127.0.0.1:${HOST_PORT}`));
  note(peer("join", peer("--peer", "Vikas", "invite"), "--name", "Claude"));
  const vik = lib.peerDir("Vikas"), cfg = lib.readJson(path.join(vik, "peer.json")), b = lib.build(), env0 = lib.peerEnv(vik, b);
  const bundle = path.join(cfg.root, `${scene.project}.cardboard`);

  // 2. cb on the agent's PATH, as the app puts it there: Cardboard's own cb on Vikas's library
  const bin = path.join(DEMO, "bin"), q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  fs.mkdirSync(bin, { recursive: true });
  const keep = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "LOCALAPPDATA", "CARDBOARD_CARTON", "CARTON_DIR", "TMPDIR"];
  // `cb app …` goes to the running app (app-player.js: Vikas's editor in Chromium) through CARDBOARD_SOCKET, as the
  // laptop's cb finds the demo Cardboard. cb never asks the app about a library given with --root, and without it a
  // project argument wants a signed-in cb (never here): so the project's name is dropped from those commands, and they
  // act on the app's tab, which is that project (on the laptop the name finds that same tab).
  const appCmd = `if [ "$1" = app ]; then\n  n=$#\n  for x in "$@"; do [ "$x" = ${q(cfg.projectName)} ] || [ "$x" = ${q(cfg.projectId)} ] || set -- "$@" "$x"; done\n  shift $n\n  CARDBOARD_SOCKET=${q(SOCK)} exec ${q(process.execPath)} ${q(path.join(b.cli, "cardboard.mjs"))} "$@"\nfi\n`;
  fs.writeFileSync(path.join(bin, "cb"), `#!/bin/sh\n# Cardboard's own cb on Vikas's library, as the app puts cb on its agent's PATH (the skit rehearsal on Linux)\n${keep.map((k) => `export ${k}=${q(env0[k])}`).join("\n")}\n${appCmd}exec ${q(process.execPath)} ${q(path.join(b.cli, "cardboard.mjs"))} --root ${q(cfg.root)} "$@"\n`, { mode: 0o755 });
  if (a.includes("--setup-only")) { note(`set up: the project shared, Claude joined; cb: ${path.join(bin, "cb")}; app socket (app-player.js): ${SOCK}`); process.exit(0); }

  // 3. the app's editor, for `cb app …` (one Chromium: slot.sh)
  const appLog = path.join(RUN, "app.log");
  const app = spawn(path.join(os.homedir(), "gfv-scratch", "carton", "slot.sh"), [process.execPath, path.join(DEMO_SCRIPTS, "app-player.js"), "--app", "Vikas", "--socket", SOCK, "--trace", path.join(RUN, "app-trace.jsonl"), "--media-delay", String(opt("media-delay", 0)), "--stdin"], { env: process.env, stdio: ["pipe", fs.openSync(appLog, "a"), fs.openSync(appLog, "a")] });
  for (let i = 0; i < 600 && !/ ready: | ✗ /.test(fs.existsSync(appLog) ? fs.readFileSync(appLog, "utf8") : ""); i++) await new Promise((r) => setTimeout(r, 500));
  if (!/ ready: /.test(fs.readFileSync(appLog, "utf8"))) throw new Error("the app's editor didn't open: " + fs.readFileSync(appLog, "utf8").slice(-600));
  note(`the app's editor open for cb app (app.log)`);

  // 4. the stand-in
  const actor = spawn(process.execPath, [path.join(DEMO_SCRIPTS, "actor", "actor.js"), "--scene", path.join(HERE, "claude1-scene.json"), "--port", String(ACTOR_PORT), "--log", path.join(RUN, "actor.log"), "--cb", JSON.stringify([path.join(bin, "cb")])], { env: { ...process.env, ACTOR_QUIET: "1" }, stdio: ["ignore", "ignore", fs.openSync(path.join(RUN, "actor.err"), "a")] });
  await new Promise((r) => setTimeout(r, 800));
  note(`stand-in on 127.0.0.1:${ACTOR_PORT} (pid ${actor.pid})`);

  // 5. Claude 2's cue sheet, beside it
  const c2log = fs.openSync(path.join(RUN, "claude2.log"), "a");
  const c2 = spawn(process.execPath, [path.join(DEMO_SCRIPTS, "peer"), "run", path.join(HERE, "claude2-cues.yaml"), "--peer", "Claude"], { env: process.env, stdio: ["ignore", c2log, c2log] });
  note(`Claude 2's cue sheet running (pid ${c2.pid})`);

  // 6. Claude 1: the real Claude Code, its own config folder, the stand-in as its API, nothing else reachable
  const cfgDir = path.join(RUN, "claude-config");
  fs.mkdirSync(cfgDir, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE|CODEX_)/.test(k)));
  Object.assign(env, {
    PATH: bin + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: cfgDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ACTOR_PORT}`, ANTHROPIC_API_KEY: "sk-mock",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
    // what the app's hooks name the person's own Claude Code (main-bridge.js hookActor: claude-code/<session>)
    CARDBOARD_ACTOR: "claude-code/rehearse",
  });
  note(`Claude Code: ${CLAUDE} -p ${JSON.stringify(scene.prompt)} in ${bundle}`);
  const goneAfter = opt("gone-after", null);
  const cc = spawn(CLAUDE, ["-p", scene.prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"], { cwd: bundle, env, stdio: ["ignore", "pipe", fs.openSync(path.join(RUN, "claude.err"), "a")] });
  const jsonl = fs.openSync(path.join(RUN, "chat.jsonl"), "a"), chat = fs.openSync(path.join(RUN, "chat.txt"), "a");
  const say = (s) => { fs.writeSync(chat, `${stamp()}  ${s}\n`); };
  let block = null, buf = "";
  readline.createInterface({ input: cc.stdout }).on("line", (l) => {
    fs.writeSync(jsonl, JSON.stringify({ at: Date.now(), line: l }) + "\n");
    let x; try { x = JSON.parse(l); } catch { return; }
    const e = x.type === "stream_event" ? x.event : null;
    if (e?.type === "content_block_start") { block = e.content_block.type; buf = ""; if (block === "thinking") say("✻ thinking…"); if (block === "tool_use") buf = e.content_block.name + " "; }
    else if (e?.type === "content_block_delta") buf += e.delta.thinking ?? e.delta.text ?? e.delta.partial_json ?? "";
    else if (e?.type === "content_block_stop") {
      if (block === "thinking") say(`✻ ${buf.trim()}`);
      else if (block === "text" && buf.trim() && buf !== "\u200b") say(`Claude: ${buf.trim()}`);
      else if (block === "tool_use") say(`⏺ ${buf.length > 220 ? buf.slice(0, 220) + "…" : buf}`);
      block = null;
    } else if (x.type === "user" && Array.isArray(x.message?.content)) {
      for (const c of x.message.content) if (c.type === "tool_result") say(`  ⎿ ${String(typeof c.content === "string" ? c.content : (c.content ?? []).map((y) => y.text ?? "").join(" ")).replace(/\s+/g, " ").replace(/<system-reminder>.*$/, "").slice(0, 200)}${c.is_error ? "  (error)" : ""}`);
    } else if (x.type === "result") say(`■ turn ended: ${x.subtype}${x.is_error ? " (error)" : ""}`);
  });
  // the operator's cues: "the human has gone" (without --gone-after, the stand-in goes on by itself after 6 s) and "end
  // the turn", some seconds after the stand-in starts waiting for each
  const cueAfter = (name, secs) => {
    const watch = setInterval(() => {
      const log = fs.existsSync(path.join(RUN, "actor.log")) ? fs.readFileSync(path.join(RUN, "actor.log"), "utf8") : "";
      if (log.includes(`"event":"wait","cue":"${name}"`)) { clearInterval(watch); setTimeout(() => fetch(`http://127.0.0.1:${ACTOR_PORT}/cue/${name}`).catch(() => {}), Number(secs) * 1000); }
    }, 300);
  };
  if (goneAfter !== null) cueAfter("gone", goneAfter);
  cueAfter("end", opt("end-after", 3));
  const code = await new Promise((r) => cc.on("exit", r));
  note(`Claude Code ended (exit ${code})`);
  await Promise.race([new Promise((r) => c2.on("exit", r)), new Promise((r) => setTimeout(r, 60_000))]);
  note(`Claude 2's cue sheet ended (exit ${c2.exitCode})`);
  actor.kill();
  app.stdin.end(); // the app's editor closes
  await Promise.race([new Promise((r) => app.on("exit", r)), new Promise((r) => setTimeout(r, 20_000))]);

  // 7. one timeline: the chat, the stand-in, Claude 2, the app's playback
  const lines = [];
  for (const l of fs.readFileSync(path.join(RUN, "chat.txt"), "utf8").split("\n").filter(Boolean)) lines.push([l.slice(0, 12), "chat    " + l.slice(23)]);
  for (const l of fs.readFileSync(path.join(RUN, "actor.log"), "utf8").split("\n").filter(Boolean)) {
    const x = JSON.parse(l);
    if (typeof x.at === "string" && (["wait", "waited", "pause", "cue", "wait-timeout"].includes(x.event) || (x.event === "request" && x.kind !== "scene"))) lines.push([x.at.slice(11, 23), `actor   ${x.event} ${JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "at" && k !== "event"))).slice(0, 180)}`]);
  }
  for (const l of fs.readFileSync(path.join(RUN, "claude2.log"), "utf8").split("\n").filter((x) => /^\d\d:\d\d:\d\d\.\d{3} /.test(x))) lines.push([l.slice(0, 12), "claude2 " + l.slice(23).slice(0, 200)]);
  for (const l of fs.readFileSync(appLog, "utf8").split("\n").filter((x) => /^\d\d:\d\d:\d\d\.\d{3} /.test(x))) lines.push([l.slice(0, 12), "app     " + l.slice(23).trim().slice(0, 200)]);
  lines.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  fs.writeFileSync(path.join(RUN, "timeline.txt"), lines.map(([t, s]) => `${t}  ${s}`).join("\n") + "\n");
  note(`timeline: ${path.join(RUN, "timeline.txt")}`);
  note("History (app side):\n" + spawnSync(path.join(bin, "cb"), ["history", scene.project, "--limit", "40"], { encoding: "utf8" }).stdout);

  // 8. the app side in Chromium: Main at Claude 2's first line, at Claude 1's first reply, at "He's gone.", and Edit v2
  if (!a.includes("--no-shots")) {
    const layout = fs.readFileSync(path.join(HERE, "layout.md"), "utf8");
    const atOf = (words) => Number(layout.split("\n").find((l) => l.includes(words))?.split("|")[3]?.trim() ?? 25) + 0.6;
    const shots = spawnSync(path.join(os.homedir(), "gfv-scratch", "carton", "slot.sh"), [process.execPath, path.join(DEMO_SCRIPTS, "shots.js"), "--app", "Vikas", "--out", path.join(RUN, "shots"),
      "--state", `Main cut@${atOf("We have no time")}`, "--state", `Main cut@${atOf("Who are you")}`, "--state", `Edit v2@3`, "--state", `Main cut@${atOf("He's gone")}`], { env: process.env, encoding: "utf8", timeout: 900_000 });
    note("shots:\n" + (shots.stdout + shots.stderr).trim().split("\n").slice(-8).join("\n"));
  }
  note(`run folder: ${RUN}`);
  process.exit(code === 0 ? 0 : 1);
})().catch((e) => { note("✗ " + (e?.stack ?? e)); process.exit(1); });
