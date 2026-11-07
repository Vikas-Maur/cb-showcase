// Shared pieces of the demo rig (scripts/demo/README.md): where things live, the staged Cardboard build a participant
// runs, a participant's environment, and the control socket's JSON-lines client.
//
// A participant ("peer") is one headless Cardboard: Cardboard 1.4.0's real library worker, patched with every Windows
// and Carton patch exactly as build-windows.js patches it (scripts/carton/test/stage.js), under Node, with its own app
// data. Nothing of Cardboard's is in git: `peer setup` stages it from CARDBOARD_PRISTINE into the demo folder.
const fs = require("fs"), path = require("path"), net = require("net");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
// Scratch for everything the rig writes. Never /tmp (a small shared tmpfs on the dev box).
const DEMO = process.env.DEMO_DIR || path.join(process.env.HOME || "/home/ubuntu", "gfv-scratch", "carton", "demo");
const BUILD = path.join(DEMO, "build");
const PRISTINE = process.env.CARDBOARD_PRISTINE || path.join(process.env.HOME || "/home/ubuntu", ".t3", "projects", "cardboard-showcase", "_inspect", "cardboard-1.4.0");
const TTS = process.env.DEMO_TTS || path.join(DEMO, "tts");

const slug = (name) => String(name ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "peer";
const peerDir = (name) => path.join(DEMO, "peer-" + slug(name));
const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + "." + process.pid + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };

/** The staged build: {cli, worker, carton}, made by `peer setup`. */
function build() {
  const b = readJson(path.join(BUILD, "build.json"));
  if (!b || !fs.existsSync(b.worker) || !fs.existsSync(path.join(b.carton, "carton-node.cjs"))) throw new Error("No staged Cardboard yet: run `scripts/demo/peer setup` first");
  return b;
}

/** Stage Cardboard's bundles with every patch and build Carton, as the sync tests do (support.js build). */
async function setup() {
  if (!fs.existsSync(path.join(PRISTINE, "app-asar"))) throw new Error("CARDBOARD_PRISTINE must name Cardboard 1.4.0's unpacked app (app-asar/, cli/): " + PRISTINE);
  if (!fs.existsSync(path.join(REPO, "carton", "node_modules", "esbuild"))) throw new Error("run `npm ci` in carton/ first");
  const { stage } = require(path.join(REPO, "scripts", "carton", "test", "stage.js"));
  fs.mkdirSync(BUILD, { recursive: true });
  const s = stage(PRISTINE, path.join(BUILD, "stage"), { carton: true });
  const bundle = path.join(BUILD, "bundle");
  fs.rmSync(bundle, { recursive: true, force: true });
  await require(path.join(REPO, "scripts", "carton", "build.js")).build(bundle, s.assets);
  const head = spawnSync("git", ["-C", REPO, "rev-parse", "--short=8", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const b = { cli: s.cli, worker: s.worker, assets: s.assets, carton: path.join(bundle, "carton"), commit: head, at: new Date().toISOString() };
  writeJson(path.join(BUILD, "build.json"), b);
  return b;
}

/**
 * A participant's environment: its own home and app data (its own install key, sessions and sync settings), Carton on,
 * and none of the agent variables of whoever started it (CLAUDECODE, CODEX_*: they would leak into who cb says it is).
 */
function peerEnv(dir, b, extra = {}) {
  const home = path.join(dir, "home");
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX_|GEMINI_|CURSOR_|CARDBOARD_ACTOR|CARTON_AGENT|DEMO_MACHINE)/.test(k)) delete env[k];
  // --machine: this participant's computer name, in its daemon and every cb it starts (machine.cjs)
  const cfg = readJson(path.join(dir, "peer.json"), {});
  const machine = cfg.machine ? { DEMO_MACHINE: String(cfg.machine), DEMO_MACHINE_USER: slug(cfg.name), NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${path.join(__dirname, "machine.cjs")}`.trim() } : {};
  return {
    ...env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "appdata"),
    CARDBOARD_CARTON: "1", CARTON_DIR: b.carton, TMPDIR: path.join(dir, "tmp"), ...machine, ...extra,
  };
}

/** `cb` on a participant's library, as Cardboard's agents run it (its own process, its own environment). */
function cb(dir, args, { actor, json = true, input, timeout = 180_000 } = {}) {
  const b = build(), cfg = readJson(path.join(dir, "peer.json"), {});
  const env = peerEnv(dir, b, actor ? { CARDBOARD_ACTOR: actor } : {});
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", cfg.root ?? path.join(dir, "library"), ...(json ? ["--json"] : []), ...args], { env, encoding: "utf8", timeout, input });
  const out = (r.stdout ?? "").replace(/^\[carton\][^\n]*\n/gm, "");
  return { code: r.status, out, err: r.stderr ?? "", ms: Date.now() - t0, json: () => JSON.parse(out) };
}

/** One request to a participant's daemon; resolves with its answer (or rejects with its error). */
function request(dir, op, args = {}, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(dir, "ctl.sock"));
    let buf = "", done = false;
    const end = (f, v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); f(v); };
    const t = setTimeout(() => end(reject, new Error(`${op}: no answer in ${timeout / 1000} s`)), timeout);
    s.on("error", (e) => end(reject, e.code === "ENOENT" || e.code === "ECONNREFUSED" ? new Error("This participant isn't running (join first)") : e));
    s.on("connect", () => s.write(JSON.stringify({ id: 1, op, args }) + "\n"));
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) end(m.ok ? resolve : reject, m.ok ? m.data : new Error(m.error));
      }
    });
  });
}

/** A stream of the daemon's watch events: `on(event)` for each; returns {close}. */
function subscribe(dir, on, { since } = {}) {
  const s = net.connect(path.join(dir, "ctl.sock"));
  let buf = "";
  s.on("error", (e) => process.stderr.write(`(the participant's stream: ${e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "it isn't running" : e.message})\n`));
  s.on("connect", () => s.write(JSON.stringify({ id: 1, op: "watch", args: { since } }) + "\n"));
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.event) on(m.event);
    }
  });
  return { close: () => s.destroy(), socket: s };
}

const clock = (ms = Date.now()) => new Date(ms).toISOString().slice(11, 23);

// ------------------------------------------------------------------ watch: one line per thing the other side did
const fmtSpan = (r) => (r.start !== null && r.start !== undefined ? ` (${r.start.toFixed(1)}–${(r.end ?? r.start).toFixed(1)} s)` : "");
function line(ev, { mine = false } = {}) {
  const at = clock(ev.at);
  if (ev.type === "edit") {
    if (ev.mine && !mine) return null;
    const rows = ev.rows.slice(0, 4).map((r) => `      ${r.text}${fmtSpan(r)}`).join("\n");
    const lag = ev.madeAt ? `  [${((ev.seenAt - ev.madeAt) / 1000).toFixed(2) + " s"} after it was made]` : "";
    return `${at}  ${ev.by.padEnd(22)} ${ev.what}${ev.cut ? `  · on ${ev.cut}` : ""}${ev.mine ? "" : lag}${rows ? "\n" + rows : ""}`;
  }
  if (ev.type === "presence") {
    const what = ev.change === "left" ? "left" : ev.idle ? "is here, not editing" : ev.activity ? `· ${ev.activity}` : "is here";
    return `${at}  ${ev.who.padEnd(22)} ${ev.change === "here" ? "joined " : ""}${what}${ev.cut && ev.change !== "left" ? `  (on ${ev.cut})` : ""}`;
  }
  if (ev.type === "cuts") {
    const parts = [...ev.added.map((c) => `new cut “${c.name}” (${c.where})`), ...ev.removed.map((c) => `cut “${c.name}” gone`), ...ev.renamed.map((c) => `cut “${c.from}” is now “${c.to}”`), ...ev.moved.map((c) => `cut “${c.name}” is now ${c.where}`)];
    return `${at}  cuts: ${parts.join("; ")}`;
  }
  if (ev.type === "status") return `${at}  sync: ${ev.status}${ev.code ? ` (${ev.code}: ${ev.message})` : ev.waiting ? ` (${ev.waiting} waiting)` : ""}`;
  if (ev.type === "self" && mine) return `${at}  (you) ${ev.op} ${ev.name ?? ev.project ?? (ev.removed ?? []).join(", ")}`;
  return null;
}


module.exports = { line, REPO, DEMO, BUILD, PRISTINE, TTS, slug, peerDir, readJson, writeJson, build, setup, peerEnv, cb, request, subscribe, clock };
