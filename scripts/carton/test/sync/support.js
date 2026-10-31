// Shared pieces of the live-sync tests: staging Cardboard's real bundles with every Carton patch, building
// carton-node.cjs with the sync half, a host process, "computers" (a real library worker each, with its own app data),
// and cb runs against a computer's library.
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { createInterface } = require("readline");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app and cli" : false;
const WORKSPACE = path.join(__dirname, "..", "..", "..", "..", "carton");
const noBuild = skip || (!fs.existsSync(path.join(WORKSPACE, "node_modules", "esbuild")) && "run `npm ci` in carton/ to build the facade");
// Never /tmp (a small shared tmpfs on the build box).
const TMP = process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync", "test");
const ADMIN = "carton-sync-test-admin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(f, ms = 20_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(50);
  }
}

/** A child speaking JSON lines; `next(pred)` waits for a line, `lines` keeps them all. */
function proc(file, args, env) {
  const p = spawn(process.execPath, [file, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [], waiters = [];
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
  createInterface({ input: p.stdout }).on("line", (l) => {
    let x;
    try { x = JSON.parse(l); } catch { return; }
    lines.push(x);
    for (const w of [...waiters]) if (w.pred(x)) waiters.splice(waiters.indexOf(w), 1), w.resolve(x);
  });
  const next = (pred, ms = 30_000) => {
    const hit = lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1), reject(new Error("no line in time; stderr:\n" + stderr.slice(-4000))); }, ms).unref();
    });
  };
  return { p, lines, next, stderr: () => stderr, send: (x) => p.stdin.write(JSON.stringify(x) + "\n") };
}

let built = null;
/** Stage the bundles (Windows patches, patch-carton, patch-carton-sync) and build carton-node.cjs with the sync half. */
async function build() {
  if (built) return built;
  fs.mkdirSync(TMP, { recursive: true });
  const { stage } = require("../stage.js");
  const s = stage(PRISTINE, path.join(TMP, "stage"), { carton: true });
  const bundle = path.join(TMP, "bundle");
  fs.rmSync(bundle, { recursive: true, force: true });
  await require("./shim.js").build(bundle, s.assets);
  const clip = path.join(TMP, "clip.mp4");
  if (!fs.existsSync(clip)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  return (built = { ...s, carton: path.join(bundle, "carton"), clip });
}

async function startHost(dir, port) {
  if (!port) fs.rmSync(dir, { recursive: true, force: true });
  const h = proc(path.join(__dirname, "host.mjs"), [dir, String(port ?? 0)], process.env);
  const r = await h.next((x) => x.ready);
  return { ...h, port: r.port, origin: r.origin, stop: async () => {
    h.send("exit");
    await new Promise((ok) => {
      if (h.p.exitCode !== null) return ok();
      const t = setTimeout(() => h.p.kill("SIGKILL"), 3000);
      h.p.once("exit", () => (clearTimeout(t), ok()));
    });
  } };
}

/** One computer: its library, its app data, its library worker, and cb on that library. */
async function computer(name, b) {
  const home = path.join(TMP, name), root = path.join(home, "library");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "appdata"), CARDBOARD_CARTON: "1", CARTON_DIR: b.carton, CARDBOARD_ACTOR: "", CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" };
  const cb = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", root, "--json", ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout.replace(/^\[carton\][^\n]*\n/gm, "")) };
  };
  let w = null, n = 0;
  const startWorker = async () => {
    w = proc(path.join(__dirname, "worker-proc.js"), [b.worker, root], env);
    await w.next((x) => x.ready, 60_000);
  };
  const call = async (method, ...args) => {
    const id = ++n;
    w.send({ id, method, args });
    const r = await w.next((x) => x.id === id, 60_000);
    if (!r.ok) throw new Error(`${name} ${method}: ${r.error}\n--- ${name}'s worker stderr (tail):\n${w.stderr().split("\n").filter((l) => /carton|Error|error/.test(l)).slice(-15).join("\n")}`);
    return r.data;
  };
  const events = () => (w ? w.lines.filter((x) => x.event).map((x) => x.event) : []);
  return {
    name, home, root, env, cb, call, events, startWorker,
    stopWorker: async () => { if (!w) return; w.send({ method: "exit" }); await new Promise((ok) => (w.p.exitCode !== null ? ok() : w.p.once("exit", ok))); w = null; },
    kill: () => { try { w?.p.kill("SIGKILL"); } catch {} },
    worker: () => w,
  };
}

/** A project's document as its library worker reads it. */
const projectOf = async (pc, id) => (await pc.call("projects.read", id)) ?? { timelineItems: [] };
const textOf = (doc) => doc.timelineItems.find((i) => i.type === "text");
const videoOf = (doc) => doc.timelineItems.find((i) => i.type === "video");

/** A GUI save through the worker, as the editor makes it: whole arrays, with the version the editor shows as its base. */
async function guiSave(pc, id, edit) {
  const doc = await projectOf(pc, id);
  const items = doc.timelineItems.map((it) => edit(it) ?? it);
  return pc.call("projects.updateScoped", { ...doc, timelineItems: items, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
}

const EDIT = 'export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n      <text name="Hello" start={0.5} end={2.5} fontSize={120} textContent="Hello" />\n    </track>\n  </timeline>\n);\n';

/** A project with history: created, a clip, two agent edits (the second from the printed file). */
function seed(pc, b) {
  const must = (r, what) => { if (r.code !== 0) throw new Error(what + ": " + r.out + r.err); return r; };
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const edit = path.join(pc.home, "edit.tsx");
  fs.writeFileSync(edit, EDIT);
  must(pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "director/chat1/turn1" }), "apply 1");
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace("fontSize={120}", "fontSize={140}"));
  must(pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "director/chat1/turn2/sub-Explore-a1" }), "apply 2");
}

/** The built facade loaded in this process (as main loads it), with the sync half's globals. */
function facade(b) {
  require(path.join(b.carton, "carton-node.cjs"));
  return globalThis.__cartonSync;
}
/** Run fn with this process's app data set to a computer's, as main on that computer would have it. */
async function asComputer(pc, fn) {
  const keep = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  Object.assign(process.env, { XDG_DATA_HOME: pc.env.XDG_DATA_HOME, LOCALAPPDATA: pc.env.LOCALAPPDATA });
  try { return await fn(); } finally { for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
}
/** A media file's duration as ffprobe reads it (a path or a URL). */
const probeDuration = (input) => Number(execFileSync(process.env.CARDBOARD_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { encoding: "utf8", timeout: 60_000 }).trim());

module.exports = { skip, noBuild, TMP, ADMIN, sleep, until, proc, build, startHost, computer, projectOf, textOf, videoOf, guiSave, seed, facade, asComputer, probeDuration };
