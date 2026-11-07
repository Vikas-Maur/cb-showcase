// One editor of the app's side in headless Chromium, as the person sees it: Cardboard 1.4.0's editor pages, patched as
// the Windows build is (the staged build's renderer, carton-ui.js included), at the laptop's 125% (1536x864 at device
// scale 1.25). main is played in the page as scripts/carton/test/browser/stage-hover.js plays it, except that every
// library and Carton call goes to the app's participant (its real library worker, holding the shared project), and the
// worker's posts come back as main sends them (carton:event, project:changed). So the timeline, the preview, History
// and Share show what that computer has. Used by shots.js (pictures) and app-player.js (the running app for `cb app`).
const fs = require("fs"), path = require("path"), os = require("os");
const lib = require("./lib.js");

const CHROME = process.env.CHROME || path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1248", "chrome-linux-arm64", "chrome");
const launch = () => {
  const { chromium } = require(process.env.PLAYWRIGHT || "/home/ubuntu/job-finder/node_modules/playwright");
  return chromium.launch({ executablePath: CHROME, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
};

// main, in the page: Cardboard's boot answers, and the rest handed to node (window.__demoMain)
const fakeMain = () => {
  const events = new Set(), responses = new Set();
  const later = (f) => setTimeout(f, 0);
  window.__demoEmit = (channel, data) => later(() => { for (const f of events) f({ channel, data }); });
  const BOOT = {
    "update:status": { phase: "unsupported", fraction: null }, "update:recall-get": null, "library:status": { state: "ready" },
    "welcome:get": { seen: true, agentSetupPending: false }, "thanks:get": { channel: null },
    "account:get": { status: { signedIn: true, user: { id: "u1", email: "vikas@example.com", name: "Vikas" }, apiBase: "http://localhost:5199" } },
    "access:get": { allowed: true, argonAgentEnabled: false, chatSkillsEnabled: false },
  };
  const handle = async ({ channel, data }) => {
    if (channel in BOOT) return BOOT[channel];
    // control:reply is the editor's answer to main's control:request (`cb app …`, see app-player.js)
    if (channel === "library:call" || channel === "carton:call" || channel === "control:reply") return window.__demoMain(channel, data);
    if (channel === "project:patch") return { ok: true }; // the page never saves: the worker holds the project
    return null;
  };
  const fix = (u) => (typeof u === "string" && u.startsWith("cardboard-media://") ? "http://localhost:5199/" + u.slice("cardboard-media://".length) : u);
  for (const C of [HTMLImageElement, HTMLMediaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, "src");
    Object.defineProperty(C.prototype, "src", { configurable: true, get: d.get, set(v) { d.set.call(this, fix(v)); } });
  }
  const fetch0 = window.fetch;
  window.fetch = (u, o) => fetch0(fix(u), o);
  let bridge;
  Object.defineProperty(window, "__carton", {
    configurable: true, get: () => bridge,
    set: (x) => { const own = x.store; x.store = function (s) { window.__demoStore = s; window.__demoSeek = (t) => s.state().setPlaybackPosition(t); return own.call(this, s); }; bridge = x; },
  });
  window.desktop = {
    platform: "win32",
    getPathForFile: () => "",
    send: (ch, req) => {
      if (ch !== "main:request") return;
      Promise.resolve().then(() => handle(req)).then((data) => later(() => { for (const f of responses) f({ id: req.id, ok: true, data }); }), (e) => later(() => { for (const f of responses) f({ id: req.id, ok: false, error: String(e?.message ?? e) }); }));
    },
    on: (ch, f) => { const set = ch === "main:response" ? responses : ch === "main:event" ? events : null; if (!set) return () => {}; set.add(f); return () => set.delete(f); },
  };
};

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };

// The editor of the app participant `app` (its folder), on its project, in a new context of `browser`.
//   mediaDelay: the first fetch of each media file waits this long (ms), as the laptop waits for a teammate's sound to
//     come down from the sharing server; onControlReply: the editor's control:reply answers.
async function openEditor(browser, { app, mediaDelay = 0, onControlReply = null, onMedia = null } = {}) {
  const b = lib.build(), RENDERER = path.dirname(b.assets);
  const cfg = lib.readJson(path.join(app, "peer.json"));
  const PID = cfg.projectId;
  const worker = (method, args) => lib.request(app, "worker", { method, args });
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage(), errors = [], logs = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.text().slice(0, 300)); });
  await page.exposeBinding("__demoMain", async (_src, channel, data) => {
    if (channel === "control:reply") { onControlReply?.(data); return null; }
    if (channel === "library:call") {
      if (data.method === "projects.list") { const d = await worker("projects.read", [PID]); return d ? [d] : []; }
      return worker(data.method, data.args ?? []);
    }
    // main answers this one itself (main-bridge.js call): Carton is on; the rest go to the worker's carton namespace
    if (data.method === "enabled") return true;
    return worker("carton." + data.method, data.args ?? []);
  });
  const raw = require("net").connect(path.join(app, "ctl.sock"));
  let buf = "";
  raw.on("connect", () => raw.write(JSON.stringify({ id: 1, op: "raw" }) + "\n"));
  raw.on("error", () => {});
  raw.on("data", (x) => {
    buf += x;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m.raw) continue;
      if (m.raw.kind === "carton") page.evaluate((ev) => window.__demoEmit?.("carton:event", ev), m.raw).catch(() => {});
      else if (m.raw.kind === "changed") worker("projects.read", [PID]).then((d) => page.evaluate((ev) => window.__demoEmit?.("project:changed", ev), { id: PID, stateUpdatedAt: d.stateUpdatedAt, carton: true })).catch(() => {});
    }
  });
  const delayed = new Set();
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/media/")) {
      const id = decodeURIComponent(u.pathname.slice("/media/".length));
      const delay = mediaDelay > 0 && !delayed.has(id);
      if (delay) { delayed.add(id); await new Promise((r) => setTimeout(r, mediaDelay)); }
      const at = (await worker("media.locate", [[id]]).catch(() => ({})))?.[id]?.nativePath;
      if (at && fs.existsSync(at)) { const body = fs.readFileSync(at); onMedia?.({ id, bytes: body.length, delayed: delay }); return route.fulfill({ status: 200, contentType: TYPES[path.extname(at).toLowerCase()] ?? "application/octet-stream", body }); }
      const live = await worker("carton.liveMediaUrl", [{ mediaId: id }]).catch(() => null);
      if (live?.url) { const r = await fetch(live.url); const body = Buffer.from(await r.arrayBuffer()); onMedia?.({ id, bytes: body.length, delayed: delay, live: true }); return route.fulfill({ status: 200, contentType: r.headers.get("content-type") ?? "application/octet-stream", body }); }
      return route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "localhost") return route.fulfill({ status: 404, body: "" });
    let f = path.join(RENDERER, decodeURIComponent(u.pathname));
    if (!f.startsWith(RENDERER) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(RENDERER, "index.html");
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", body: fs.readFileSync(f) });
  });
  await page.addInitScript(fakeMain);
  await page.goto(`http://localhost:5199/app/editor/${PID}`);
  const close = async () => { raw.destroy(); await context.close().catch(() => {}); };
  return { page, context, errors, logs, close, worker, projectId: PID, projectName: cfg.projectName };
}

module.exports = { CHROME, launch, openEditor };
