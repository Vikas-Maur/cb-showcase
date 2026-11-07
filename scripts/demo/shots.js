// Real-browser shots of the app's side of a rehearsal: Cardboard 1.4.0's editor pages, patched as the Windows build is
// (the staged build's renderer, carton-ui.js included), in headless Chromium at the laptop's 125% (1536x864 at device
// scale 1.25). main is played in the page as scripts/carton/test/browser/stage-hover.js plays it, except that every
// library and Carton call goes to the app's participant (its real library worker, holding the shared project), and the
// worker's posts come back as main sends them (carton:event, project:changed). So the timeline, the preview, History
// and Share show what that computer has, as the person would see it.
// For each state asked: the editor (at a time on the timeline), History open (Ctrl+Shift+H), Share open.
//   node shots.js --app Vikas --out <dir> [--state "Main cut@7" --state "Vikas's cut@7"]   (a cut, and the playhead)
// Run it through gfv-scratch/carton/slot.sh (one Chromium at a time on the dev box).
const fs = require("fs"), path = require("path"), os = require("os");
const lib = require("./lib.js");

const a = process.argv.slice(2), opts = (k) => a.flatMap((x, i) => (x === "--" + k ? [a[i + 1]] : []));
const APP = lib.peerDir(opts("app")[0] ?? "Vikas"), OUT = opts("out")[0] ?? path.join(lib.DEMO, "shots", new Date().toISOString().replace(/[:.]/g, "-"));
const STATES = (opts("state").length ? opts("state") : ["Main cut@7"]).map((s) => { const m = /^(.*)@([\d.]+)$/.exec(s); return { cut: m ? m[1] : s, at: m ? Number(m[2]) : 5 }; });
const { chromium } = require(process.env.PLAYWRIGHT || "/home/ubuntu/job-finder/node_modules/playwright");
const CHROME = process.env.CHROME || path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1248", "chrome-linux-arm64", "chrome");
const b = lib.build(), RENDERER = path.dirname(b.assets);
const cfg = lib.readJson(path.join(APP, "peer.json"));
const PID = cfg.projectId, PROJECT = cfg.projectName;

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
    if (channel === "library:call" || channel === "carton:call") return window.__demoMain(channel, data);
    if (channel === "project:patch") return { ok: true }; // a shot never saves
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
    set: (x) => { const own = x.store; x.store = function (s) { window.__demoSeek = (t) => s.state().setPlaybackPosition(t); return own.call(this, s); }; bridge = x; },
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
const worker = (method, args) => lib.request(APP, "worker", { method, args });

async function shoot(browser, state, n) {
  // the person's cut, as Cardboard's agent would switch it (the editor follows)
  const sw = lib.cb(APP, ["cut", "switch", PROJECT, state.cut], { actor: "director/shots/turn1", json: false });
  if (sw.code !== 0) throw new Error("cut switch: " + sw.out + sw.err);
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.text().slice(0, 300)); });
  await page.exposeBinding("__demoMain", async (_src, channel, data) => {
    if (channel === "library:call") {
      if (data.method === "projects.list") { const d = await worker("projects.read", [PID]); return d ? [d] : []; }
      return worker(data.method, data.args ?? []);
    }
    // main answers this one itself (main-bridge.js call): Carton is on; the rest go to the worker's carton namespace
    if (data.method === "enabled") return true;
    return worker("carton." + data.method, data.args ?? []);
  });
  const raw = require("net").connect(path.join(APP, "ctl.sock"));
  let buf = "";
  raw.on("connect", () => raw.write(JSON.stringify({ id: 1, op: "raw" }) + "\n"));
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
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/media/")) {
      const id = decodeURIComponent(u.pathname.slice("/media/".length));
      const at = (await worker("media.locate", [[id]]).catch(() => ({})))?.[id]?.nativePath;
      if (at && fs.existsSync(at)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(at).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(at) });
      const live = await worker("carton.liveMediaUrl", [{ mediaId: id }]).catch(() => null);
      if (live?.url) { const r = await fetch(live.url); return route.fulfill({ status: 200, contentType: r.headers.get("content-type") ?? "application/octet-stream", body: Buffer.from(await r.arrayBuffer()) }); }
      return route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "localhost") return route.fulfill({ status: 404, body: "" });
    let f = path.join(RENDERER, decodeURIComponent(u.pathname));
    if (!f.startsWith(RENDERER) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(RENDERER, "index.html");
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", body: fs.readFileSync(f) });
  });
  await page.addInitScript(fakeMain);
  await page.goto(`http://localhost:5199/app/editor/${PID}`);
  try { await page.waitForSelector("canvas[data-preview-canvas]", { timeout: 60000 }); }
  catch (e) { await page.screenshot({ path: path.join(OUT, "failed.png") }); throw new Error("the editor didn't open: " + [...errors, ...logs].slice(-12).join("\n")); }
  await page.waitForTimeout(4000);
  await page.evaluate((t) => window.__demoSeek?.(t), state.at);
  await page.waitForTimeout(1500);
  const tag = `${n}-${lib.slug(state.cut)}`;
  const files = [];
  const snap = async (what) => { const f = path.join(OUT, `${tag}-${what}.png`); await page.screenshot({ path: f }); files.push(f); };
  await snap("editor");
  // History, as the person opens it (Ctrl+Shift+H)
  await page.keyboard.press("Control+Shift+KeyH");
  await page.waitForSelector(".carton-sidebar", { timeout: 15000 }).catch(() => errors.push("History didn't open"));
  await page.waitForTimeout(2500);
  await snap("history");
  await page.keyboard.press("Control+Shift+KeyH");
  await page.waitForTimeout(800);
  // Share, as the title bar's Share icon opens it (main's carton:command)
  await page.evaluate(() => window.__demoEmit("carton:command", { action: "carton-share" }));
  await page.waitForSelector(".carton-share-dialog", { timeout: 15000 }).catch(() => errors.push("Share didn't open"));
  await page.waitForTimeout(1500);
  await snap("share");
  const text = await page.evaluate(() => ({ share: document.querySelector(".carton-share-dialog")?.innerText ?? null, history: null }));
  raw.destroy();
  await context.close();
  return { state, files, errors, share: text.share };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
  const results = [];
  try { let n = 1; for (const s of STATES) results.push(await shoot(browser, s, n++)); } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.state.cut} @${r.state.at}s: ${r.files.map((f) => path.basename(f)).join(", ")}${r.errors.length ? "  errors: " + r.errors.join("; ") : ""}\n  Share: ${(r.share ?? "").replace(/\n+/g, " | ").slice(0, 300)}`);
})().catch((e) => { console.error(e); process.exit(1); });
