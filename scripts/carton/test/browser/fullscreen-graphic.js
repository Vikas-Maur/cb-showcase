// Regress 2026-11-05 ("in the full-screen preview, <code> graphics are drawn about 11% too large from the top-left
// corner"): Cardboard's editor in headless Chromium at Windows' 125% (deviceScaleFactor 1.25, a 1920x1080 screen is
// 1536x864), a fake main answering window.desktop as in stage-hover.js.
//
// The project, as cb writes it (60 s, so playback never reaches its end): a 1920x1080 reference picture on "V1"
// (dark grey, a yellow border and a yellow crosshair at the frame's centre) and, over it on "Web FX", the bug report's
// minimal <code> graphic (a red border at the frame's edges, a green crosshair at its centre, in a 1920x1080 viewBox).
// Each build starts at the preview's own zoom (1), zoomed out (0.9, the report's 1/1.11) and zoomed in (1.1), each set
// as a person does, with Ctrl+wheel over the preview. Steps: paused and playing in the editor; a click on its
// Fullscreen button, paused and playing in full screen; Ctrl+wheel in full screen (which zooms the editor's preview,
// out of sight, to 0.9 times what it was); out of full screen at that zoom. At every step: where the graphic's page is
// (its box over the canvas's) and where its green crosshair and the picture's yellow one are drawn (a screenshot of
// the canvas; not while the zoomed-in preview is cut off by its pane, where only the page's box is checked).
//
// Builds: "pristine" is Cardboard 1.4.0's renderer as shipped (none of our patches); "ours" is the Windows build's
// (scripts/patch-*.js, as stage.js runs them); "baseline" is ours without the speed changes (CB_BASELINE=1). Each
// gets one test-only line: the editor store's handle (window.__cbTestStore), to read the zoom.
//
// It exits 1 unless: ours and baseline draw the graphic over the picture at every step (its page the canvas's box,
// both crosshairs at the frame's centre); pristine shows Cardboard's own bug: right in the editor, but in full screen
// its page scaled by one over the zoom it came in with, from the canvas's top-left corner (1/0.9 too large, 1/1.1 too
// small, right at 1), and still so after zooming in full screen (its box doesn't move, so it isn't measured again),
// the green crosshair at 0.5 times that while the picture's stays at 0.5; and the fix (patch-renderer.js 21)
// reads the canvas's computed style only when the canvas moves: never in 2 s of a still editor, paused, in the
// editor or in full screen, and at least once when full screen comes in (so the count is counting it).
//
// Usage: CARDBOARD_PRISTINE=<_inspect/cardboard-1.4.0> [PLAYWRIGHT=<path to playwright>] [CHROME=<chromium binary>]
//        node scripts/carton/test/browser/fullscreen-graphic.js [out dir] [--builds=pristine,ours,baseline]
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { stage } = require("../stage");

const pristine = process.env.CARDBOARD_PRISTINE;
if (!pristine) throw new Error("CARDBOARD_PRISTINE must name Cardboard 1.4.0's unpacked app (app-asar/, cli/)");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const args = process.argv.slice(2), OUT = args.find((a) => !a.startsWith("--")) || path.join(os.tmpdir(), "cb-fullscreen-graphic");
const BUILDS = (args.find((a) => a.startsWith("--builds="))?.slice(9) ?? "pristine,ours,baseline").split(",");

const STORE_ANCHOR = "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});";
const withStore = (assets) => {
  const f = path.join(assets, "installErrorTelemetry-DxKId8tA.js"), src = fs.readFileSync(f, "utf8");
  if (src.split(STORE_ANCHOR).length !== 2) throw new Error("the editor store's anchor isn't there once");
  fs.writeFileSync(f, src.replace(STORE_ANCHOR, STORE_ANCHOR + "window.__cbTestStore=()=>ne.getState();"));
  return path.dirname(assets);
};
const builds = () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const dirs = {};
  for (const b of BUILDS) {
    if (b === "pristine") {
      const r = path.join(OUT, "pristine", "renderer");
      fs.cpSync(path.join(pristine, "app-asar", "dist", "renderer"), r, { recursive: true });
      dirs[b] = withStore(path.join(r, "assets"));
    } else {
      const was = process.env.CB_BASELINE;
      process.env.CB_BASELINE = b === "baseline" ? "1" : "";
      try { dirs[b] = withStore(stage(pristine, path.join(OUT, b)).assets); } finally { if (was === undefined) delete process.env.CB_BASELINE; else process.env.CB_BASELINE = was; }
    }
  }
  return dirs;
};

// 1920x1080: dark grey, a 16 px yellow border, a 24 px yellow crosshair at the centre (wider than the graphic's, so
// it shows on both sides of a graphic drawn right over it)
const png = (() => {
  const w = 1920, h = 1080, Y = [255, 255, 0], G = [48, 48, 48], rows = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) r.set(x < 16 || x >= w - 16 || y < 16 || y >= h - 16 || (x >= 948 && x < 972) || (y >= 528 && y < 552) ? Y : G, 1 + x * 3);
    rows.push(r);
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
})();

// The bug report's minimal composition, as given.
const SOURCE = `export default function Graphic({ width, height }) {
  return (
    <svg width={width} height={height} viewBox="0 0 1920 1080">
      <rect x="4" y="4" width="1912" height="1072" fill="none" stroke="#ff0040" strokeWidth="8" />
      <line x1="960" y1="0" x2="960" y2="1080" stroke="#00ff80" strokeWidth="4" />
      <line x1="0" y1="540" x2="1920" y2="540" stroke="#00ff80" strokeWidth="4" />
    </svg>
  );
}
`;
// The project as `cb media add` and `cb source apply` (a <code> on "Web FX" over an <image> on "V1") write it.
const PID = "11111111-2222-4333-8444-555555555555", IMG = "aaaaaaaa-0000-4000-8000-000000000001", CODE = "aaaaaaaa-0000-4000-8000-000000000002", now = "2026-11-05T17:32:14.268Z";
const FX = "bbbbbbbb-0000-4000-8000-000000000001", V1 = "bbbbbbbb-0000-4000-8000-000000000002";
const project = {
  id: PID, name: "Fullscreen graphic", createdAt: now, updatedAt: now, stateUpdatedAt: 1793899934269, aspectRatio: "16:9",
  media: [
    { id: IMG, createdAt: now, addedAt: now, data: { type: "image", src: "cardboard-media://media/" + IMG, fileName: "ref.png", format: "png", size: png.length, width: 1920, height: 1080, thumbnailGenerationStatus: "complete", metadataStatus: "complete" } },
    { id: CODE, createdAt: now, addedAt: now, data: { type: "code", fileName: "Frame check", format: "code", size: 0, code: { source: SOURCE, width: 1920, height: 1080 } } },
  ],
  tracks: [{ id: FX, name: "Web FX", order: 0, locked: false, visible: true, muted: false }, { id: V1, name: "V1", order: 1, locked: false, visible: true, muted: false }],
  timelineItems: [
    { id: "cccccccc-0000-4000-8000-000000000001", trackId: FX, type: "code", startTime: 0, endTime: 60, trimStart: 0, trimEnd: 60, name: "Frame check", codeComposition: { width: 1920, height: 1080 }, mediaItemId: CODE },
    { id: "cccccccc-0000-4000-8000-000000000002", trackId: V1, type: "image", startTime: 0, endTime: 60, trimStart: 0, trimEnd: 60, mediaItemId: IMG, autoReframe: true },
  ],
};

// main, in the page (stage-hover.js's, without Carton)
const fakeMain = ({ project }) => {
  const events = new Set(), responses = new Set();
  const later = (f) => setTimeout(f, 0);
  const BOOT = {
    "update:status": { phase: "unsupported", fraction: null }, "update:recall-get": null, "library:status": { state: "ready" },
    "welcome:get": { seen: true, agentSetupPending: false }, "thanks:get": { channel: null },
    "account:get": { status: { signedIn: true, user: { id: "u1", email: "t@example.com", name: "Tester" }, apiBase: "http://localhost:5199" } },
    "access:get": { allowed: true, argonAgentEnabled: false, chatSkillsEnabled: false },
  };
  const handle = ({ channel, data }) => {
    if (channel === "library:call") {
      if (data.method === "projects.list") return [project];
      if (data.method === "projects.read") return project;
      if (data.method === "media.locate") return Object.fromEntries((data.args?.[0] ?? []).map((id) => [id, { nativePath: "/media/" + id + ".png", ownedByBundle: true }]));
      return null;
    }
    if (channel === "carton:call") return data.method === "enabled" ? false : null;
    if (channel in BOOT) return BOOT[channel];
    if (channel === "project:patch") return { ok: true };
    return null;
  };
  const fix = (u) => (typeof u === "string" && u.startsWith("cardboard-media://") ? "http://localhost:5199/" + u.slice("cardboard-media://".length) : u);
  for (const C of [HTMLImageElement, HTMLMediaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, "src");
    Object.defineProperty(C.prototype, "src", { configurable: true, get: d.get, set(v) { d.set.call(this, fix(v)); } });
  }
  const fetch0 = window.fetch;
  window.fetch = (u, o) => fetch0(fix(u), o);
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

// In the page: where the shown graphic's page is over the canvas, and (from a screenshot of the canvas) where the
// green (graphic) and yellow (picture) crosshairs and the graphic's red border are, as fractions of the frame.
const measure = async (page, file) => {
  const canvas = await page.$("canvas[data-preview-canvas]"), box = await canvas.boundingBox();
  const shot = await page.screenshot({ clip: box, path: file });
  return page.evaluate(async (b64) => {
    const c = document.querySelector("canvas[data-preview-canvas]").getBoundingClientRect();
    const shown = (e) => { for (let x = e; x; x = x.parentElement) { const s = getComputedStyle(x); if (s.visibility === "hidden" || s.display === "none") return false; } return getComputedStyle(e).opacity === "1"; };
    const frames = [...document.querySelectorAll('iframe[title="JSX graphic"]')].filter(shown);
    const f = frames[0]?.getBoundingClientRect();
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data, W = img.width, H = img.height;
    const is = { green: (r, gg, b) => r < 90 && gg > 190 && b > 70 && b < 190, yellow: (r, gg, b) => r > 190 && gg > 190 && b < 90, red: (r, gg, b) => r > 190 && gg < 90 && b < 140 };
    // a line: the middle of the columns (rows) that are mostly its colour, the frame's outer 3% (the borders) left out
    const line = (k, axis) => {
      const n = axis === "x" ? W : H, m = axis === "x" ? H : W, count = new Array(n).fill(0);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (is[k](d[i], d[i + 1], d[i + 2])) count[axis === "x" ? x : y]++; }
      let sum = 0, num = 0;
      for (let i = Math.floor(n * 0.03); i < n - Math.floor(n * 0.03); i++) if (count[i] > m / 3) { sum += i + 0.5; num++; }
      return num ? +(sum / num / n).toFixed(3) : null;
    };
    const s = window.__cbTestStore?.();
    const fe = document.fullscreenElement;
    // the preview's pane cuts off a zoomed-in canvas (in full screen nothing does)
    const pane = fe ? null : document.querySelector("canvas[data-preview-canvas]").closest(".overflow-hidden.p-6")?.getBoundingClientRect();
    const clipped = !!pane && (c.left < pane.left - 0.5 || c.top < pane.top - 0.5 || c.right > pane.right + 0.5 || c.bottom > pane.bottom + 0.5);
    return {
      dpr: devicePixelRatio, zoom: s ? +s.canvasTransform.scale.toFixed(3) : null, playing: s?.isPlaying ?? null,
      fullscreen: !!fe && fe.contains(document.querySelector("canvas[data-preview-canvas]")),
      canvas: { w: +c.width.toFixed(1), h: +c.height.toFixed(1) },
      frames: frames.length,
      all: [...document.querySelectorAll('iframe[title="JSX graphic"]')].map((e) => { const r = e.getBoundingClientRect(), hid = []; for (let x = e; x; x = x.parentElement) { const st = getComputedStyle(x); st.visibility === "hidden" && hid.push(x.tagName + "." + (x.dataset.previewScene ?? "")); } return `opacity ${getComputedStyle(e).opacity} hidden-by ${hid.join(">") || "-"} box ${r.width.toFixed(0)}x${r.height.toFixed(0)}@${(r.left - c.left).toFixed(0)},${(r.top - c.top).toFixed(0)}`; }),
      page: f ? { scale: +(f.width / c.width).toFixed(3), left: +((f.left - c.left) / c.width).toFixed(3), top: +((f.top - c.top) / c.height).toFixed(3) } : null,
      clipped,
      green: clipped ? null : { x: line("green", "x"), y: line("green", "y") }, yellow: clipped ? null : { x: line("yellow", "x"), y: line("yellow", "y") },
    };
  }, shot.toString("base64"));
};

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };
// Ctrl+wheel over the preview: Cardboard zooms by scale*(1 - deltaY*0.004), deltaY in CSS px (Playwright's wheel is
// in device px: 31.25 at 1.25 is 25, so 0.9)
const wheelZoom = async (page, factor) => { await page.keyboard.down("Control"); await page.mouse.wheel(0, ((1 - factor) / 0.004) * 1.25); await page.keyboard.up("Control"); };
const runCase = async (browser, { build, renderer, zoom }) => {
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/media/")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (u.hostname !== "localhost") return route.fulfill({ status: 404, body: "" });
    let f = path.join(renderer, decodeURIComponent(u.pathname));
    if (!f.startsWith(renderer) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(renderer, "index.html");
    // the graphic's page is sandboxed (an opaque origin): it loads the runtime and font cross-origin
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(f) });
  });
  await page.addInitScript(fakeMain, { project });
  // how often the page reads the preview canvas's computed style (patch-renderer.js 21 does, when the canvas moves)
  await page.addInitScript(() => {
    const gcs = window.getComputedStyle;
    window.__cbTestCanvasReads = 0;
    window.getComputedStyle = function (el, ...rest) { if (el instanceof HTMLCanvasElement && el.hasAttribute("data-preview-canvas")) window.__cbTestCanvasReads++; return gcs.call(this, el, ...rest); };
  });
  await page.goto(`http://localhost:5199/app/editor/${PID}`);
  await page.waitForSelector("canvas[data-preview-canvas]", { timeout: 90000 });
  await page.waitForTimeout(4000);
  const settle = (ms = 1500) => page.waitForTimeout(ms);
  const name = (step) => path.join(OUT, `${build}-zoom${zoom}-${step}.png`);
  await page.evaluate(() => window.__cbTestStore().setPlaybackPosition(1));
  // the preview's own zoom, as a person sets it
  const cb = await (await page.$("canvas[data-preview-canvas]")).boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  if (zoom !== 1) await wheelZoom(page, zoom);
  // the pointer off the preview, so nothing is hovered
  await page.mouse.move(4, 4);
  await settle();
  const steps = {}, reads = {};
  const count = async (key, during) => { await page.evaluate(() => { window.__cbTestCanvasReads = 0; }); await during(); reads[key] = await page.evaluate(() => window.__cbTestCanvasReads); };
  await count("still", () => settle(2000));
  steps.paused = await measure(page, name("paused"));
  // Space plays, once playback has really started (Cardboard 1.4.0 first loads the audio ahead, and ignores a second
  // press meanwhile), and Space pauses
  const playing = (on) => page.waitForFunction((v) => window.__cbTestStore().isPlaying === v, on, { timeout: 15000 });
  const play = async (key) => { await page.keyboard.press("Space"); await playing(true); await settle(1000); steps[key] = await measure(page, name(key)); await page.keyboard.press("Space"); await playing(false); await settle(800); };
  await play("playing");
  // Full screen, by the preview's Fullscreen button (a click: requestFullscreen needs one); the button then gives
  // the keyboard back, so Space plays (on the focused button it would press it)
  await count("fsEnter", async () => {
    await page.locator('button[aria-label="Fullscreen"]').first().click();
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.mouse.move(4, 4);
    await settle();
  });
  await page.evaluate(() => window.__cbTestStore().setPlaybackPosition(1));
  await count("fsStill", () => settle(2000));
  steps.fsPaused = await measure(page, name("fs-paused"));
  await play("fsPlaying");
  // Ctrl+wheel in full screen: the wheel reaches the editor's handler (on the preview's pane, the full-screen
  // element's parent), so the editor's zoom changes, but full screen shows the preview without it
  await page.mouse.move(768, 432);
  await wheelZoom(page, 0.9);
  await page.mouse.move(4, 4);
  await settle();
  steps.fsZoomed = await measure(page, name("fs-zoomed"));
  // out of full screen (the full-screen controls' Exit fullscreen does the same), at the zoom now set
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => window.__cbTestStore().setPlaybackPosition(1));
  await settle();
  steps.after = await measure(page, name("after"));
  await context.close();
  return { build, zoom, steps, reads, errors };
};

(async () => {
  const dirs = builds();
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const results = [];
  try {
    for (const build of BUILDS) for (const zoom of [1, 0.9, 1.1]) results.push(await runCase(browser, { build, renderer: dirs[build], zoom }));
  } finally { await browser.close(); }
  const near = (a, b, tol = 0.002) => a !== null && Math.abs(a - b) <= tol;
  let failed = false;
  const fail = (r, what) => { failed = true; console.log(`  ${r.build} zoom ${r.zoom}: ${what}`); };
  for (const r of results) {
    console.log(`${r.build.padEnd(9)} zoom ${String(r.zoom).padEnd(3)}  canvas style reads: still ${r.reads.still}, entering full screen ${r.reads.fsEnter}, still in full screen ${r.reads.fsStill}${r.errors.length ? "  errors: " + r.errors.join("; ") : ""}`);
    for (const [k, s] of Object.entries(r.steps))
      console.log(`  ${k.padEnd(10)} fullscreen=${s.fullscreen ? "yes" : "no "} playing=${s.playing ? "yes" : "no "} zoom=${s.zoom} dpr=${s.dpr} canvas ${s.canvas.w}x${s.canvas.h} | page ${s.page ? `scale ${s.page.scale} at (${s.page.left}, ${s.page.top})` : "none"} (${s.frames} shown) | ${s.clipped ? "cut off by the pane" : `green + at (${s.green.x}, ${s.green.y}) | yellow + at (${s.yellow.x}, ${s.yellow.y})`}${s.page && s.frames === 1 ? "" : " | " + s.all.join(" ; ")}`);
  }
  console.log("");
  for (const r of results) {
    const z0 = r.zoom;
    if (r.errors.length) fail(r, "page errors");
    if (r.reads.still !== 0 || r.reads.fsStill !== 0) fail(r, `the canvas's style was read in a still editor (${r.reads.still}, in full screen ${r.reads.fsStill})`);
    if (r.build !== "pristine" && !(r.reads.fsEnter > 0)) fail(r, "the canvas's style wasn't read when full screen came in");
    for (const [k, s] of Object.entries(r.steps)) {
      // the zoom set: z0, then 0.9 times that from the wheel in full screen on
      const z = k === "fsZoomed" || k === "after" ? z0 * 0.9 : z0;
      if (!near(s.zoom, z, 0.001)) fail(r, `${k}: the preview's zoom is ${s.zoom}, not ${z}`);
      if (s.fullscreen !== k.startsWith("fs")) fail(r, `${k}: full screen is ${s.fullscreen}`);
      // the picture is always right: the canvas draws it
      if (!s.clipped && (!near(s.yellow.x, 0.5, 0.006) || !near(s.yellow.y, 0.5, 0.006))) fail(r, `${k}: the picture's crosshair isn't at the frame's centre`);
      if (!s.page) { fail(r, `${k}: no graphic shown`); continue; }
      // Cardboard 1.4.0's own renderer in full screen: the page scaled by one over the zoom full screen came in with,
      // from the top-left (zooming in full screen leaves the canvas's box as it is, so nothing measures it again)
      const want = r.build === "pristine" && k.startsWith("fs") ? 1 / z0 : 1;
      if (!near(s.page.scale, want) || !near(s.page.left, 0) || !near(s.page.top, 0)) fail(r, `${k}: the graphic's page is at scale ${s.page.scale} (${s.page.left}, ${s.page.top}), expected ${want.toFixed(3)} (0, 0)`);
      if (!s.clipped && (!near(s.green.x, 0.5 * want, 0.01) || !near(s.green.y, 0.5 * want, 0.01))) fail(r, `${k}: the graphic's crosshair is at (${s.green.x}, ${s.green.y}), expected (${(0.5 * want).toFixed(3)}, ${(0.5 * want).toFixed(3)})`);
    }
  }
  console.log(failed ? "FAIL" : "PASS: ours and baseline draw the graphic over the picture in the editor and in full screen, at zoom 1, 0.9 and 1.1, paused or playing, zoomed in full screen and after it; Cardboard 1.4.0's own renderer draws it at one over the zoom from the top-left in full screen; the fix reads the canvas's style only when it moves");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
