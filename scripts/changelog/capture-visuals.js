// Captures the changelog's "See what happens" visuals: Cardboard's own editor pages next to this build's, doing the
// same thing, for the bugs in the changelog's "Fixed here, still in Cardboard" list that can be shown on screen.
//
// What runs: Cardboard's whole editor (its renderer pages: index, EditorRoute and the editor store) in headless
// Chromium, from two copies of the same files:
// - "cardboard": Cardboard 1.4.0's renderer exactly as it ships (CARDBOARD_PRISTINE), none of our patches;
// - "ours": the same files after this repo's scripts/patch-*.js, applied by scripts/carton/test/stage.js as the
//   Windows build does (Carton's own patches not applied: the visuals compare only the fix).
// Both get one test-only line, the editor store's handle (window.__cbTestStore), so a step can set the timeline's
// zoom or wait for playback. A fake main in the page answers the editor's requests (one project, written as
// `cb` writes it), as the browser tests in scripts/carton/test/browser/ do. Every pixel of the editor is drawn by
// Cardboard's code; the only things added afterwards are clearly marked overlays (a red ring, a key label).
// Nothing is drawn to look like Cardboard. Pictures in the sample projects are our own drawings (SVG).
//
// The cases (each one runs the same steps on both builds and checks that Cardboard shows the bug and ours doesn't,
// else it stops):
// - fullscreen: the preview zoomed out a step (Ctrl+wheel), the Fullscreen button; a code graphic over a picture.
// - names: the timeline's scroll moved 2 px a frame past two music clips' start; a screenshot after each move.
// - playhead: → (next frame) pressed 45 times with the playhead near the right edge, real key presses.
// - focus: text typed in the prompt box, a real click on the ruler, then Space.
// - badges: a clip picked with @ in the prompt box, ← twice, then "the " typed.
// - enter: an agent question in the chat (the fake main's transcript); a click on an option, then Enter. The fake
//   main settles an answer when it gets one, as main does once it hands it to the agent.
// - tooltips: the pointer on the left rail's Audio icon.
// - gpu: the GPU process crashed through DevTools (Browser.crashGpuProcess), as a driver reset does; the timeline
//   a few seconds later.
// Cardboard 1.4.1 is only ever read for evidence (EVIDENCE.md), never run here.
//
// The patches must be the ones with the fixes: CB_PATCHES names a checkout of feat/carton-ux at 44152b44 (or later),
// whose scripts/ are used for "ours".
//
// Usage (one Chromium at a time on a shared box; takes a few minutes):
//   CARDBOARD_PRISTINE=<_inspect/cardboard-1.4.0> CB_PATCHES=<checkout of 44152b44> \
//   PLAYWRIGHT=<path to playwright> CHROME=<chromium binary> \
//   node scripts/changelog/capture-visuals.js [--work=<scratch dir>] [--only=fullscreen,names,…]
// Writes the encoded media into carton/apps/web/public/changelog/img/cb/ (ffmpeg on PATH or FFMPEG=…), and the raw
// screenshots into the work dir.
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");

const PRISTINE = process.env.CARDBOARD_PRISTINE, PATCHES = process.env.CB_PATCHES;
if (!PRISTINE || !PATCHES) throw new Error("set CARDBOARD_PRISTINE (Cardboard 1.4.0's unpacked app) and CB_PATCHES (a checkout of feat/carton-ux 44152b44)");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { stage } = require(path.join(PATCHES, "scripts", "carton", "test", "stage.js"));
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const WORK = arg("work") || path.join(os.tmpdir(), "cb-changelog-visuals");
const ONLY = arg("only")?.split(",");
const DEST = path.join(__dirname, "..", "..", "carton", "apps", "web", "public", "changelog", "img", "cb");
const SIDES = ["cardboard", "ours"];

// ---------------------------------------------------------------------------------------------------------------
// The two builds
const STORE_ANCHOR = "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});";
const expose = (renderer) => {
  const f = path.join(renderer, "assets", "installErrorTelemetry-DxKId8tA.js"), src = fs.readFileSync(f, "utf8");
  if (src.split(STORE_ANCHOR).length !== 2) throw new Error("the editor store's anchor isn't there once");
  fs.writeFileSync(f, src.replace(STORE_ANCHOR, STORE_ANCHOR + "window.__cbTestStore=()=>ne.getState();"));
  return renderer;
};
const builds = () => {
  const root = path.join(WORK, "builds");
  fs.rmSync(root, { recursive: true, force: true });
  const shipped = path.join(root, "cardboard", "renderer");
  fs.cpSync(path.join(PRISTINE, "app-asar", "dist", "renderer"), shipped, { recursive: true });
  const patched = path.dirname(stage(PRISTINE, path.join(root, "ours")).assets);
  // the fixes shown here must be in "ours"
  const editor = fs.readFileSync(path.join(patched, "assets", "EditorRoute-CuIqwZKP.js"), "utf8");
  for (const hook of ["__cbEdgeNames=(", "__cbTip", "H1({playheadTime:H,pixelsPerSecond:"]) if (!editor.includes(hook)) throw new Error(`CB_PATCHES doesn't have the fixes (${hook} missing): use feat/carton-ux 44152b44`);
  return { cardboard: expose(shipped), ours: expose(patched) };
};

// ---------------------------------------------------------------------------------------------------------------
// The editor in a page
const now = "2026-11-05T10:00:00.000Z", PID = "11111111-2222-4333-8444-555555555555";
const track = (id, name, order, type) => ({ id, name, order, locked: false, visible: true, muted: false, ...(type ? { type } : {}) });

// main, in the page: the editor's boot, one project, its media answered from /media/<id>, and the agent chat's
// transcript (`transcript`). An answer to an agent question is settled at once, as main does when it hands the
// answer to the agent. Requests are kept in window.__cbRequests.
const fakeMain = ({ project, transcript }) => {
  const responses = new Set(), events = new Set(), later = (f) => setTimeout(f, 0);
  window.__cbRequests = [];
  const BOOT = {
    "update:status": { phase: "unsupported", fraction: null }, "update:recall-get": null, "library:status": { state: "ready" },
    "welcome:get": { seen: true, agentSetupPending: false }, "thanks:get": { channel: null },
    "account:get": { status: { signedIn: true, user: { id: "u1", email: "t@example.com", name: "Tester" }, apiBase: "http://localhost:5199" } },
    "access:get": { allowed: true, argonAgentEnabled: false, chatSkillsEnabled: false },
    // no local agents: the prompt box uses Cardboard's cloud Director
    "local-agent:status": { claude: { enabled: false, install: null }, codex: { enabled: false, install: null } },
    // one empty chat, open
    "local-agent:chats": { activeId: "c1", chats: [{ id: "c1", title: null, openedAt: "2026-11-05T10:00:00.000Z", createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z" }] },
    "local-agent:transcript": transcript ?? { events: [], busy: false, asking: null },
  };
  const emit = (channel, data) => later(() => { for (const f of events) f({ channel, data }); });
  const handle = ({ channel, data }) => {
    window.__cbRequests.push(channel);
    if (channel === "local-agent:answer") { emit("local-agent:event", { projectId: project.id, chatId: "c1", event: { type: "question-settled", id: data.id, answers: data.answers } }); return null; }
    if (channel === "library:call") {
      if (data.method === "projects.list") return [project];
      if (data.method === "projects.read") return project;
      if (data.method === "media.locate") return Object.fromEntries((data.args?.[0] ?? []).map((id) => [id, { nativePath: "/media/" + id, ownedByBundle: true }]));
      return null;
    }
    if (channel === "carton:call") return data.method === "enabled" ? false : null;
    return channel in BOOT ? BOOT[channel] : channel === "project:patch" ? { ok: true } : null;
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

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const launch = () => chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: CHROME_ARGS });

const openEditor = async (browser, renderer, { project, transcript, viewport, dpr = 1, media = {}, ready = "canvas[data-preview-canvas]" }) => {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/media/")) {
      const m = media[u.pathname.slice(7)];
      return m ? route.fulfill({ status: 200, contentType: m.type, body: m.body }) : route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "localhost") return route.fulfill({ status: 404, body: "" });
    let f = path.join(renderer, decodeURIComponent(u.pathname));
    if (!f.startsWith(renderer) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(renderer, "index.html");
    // a code graphic's page is sandboxed (an opaque origin): it loads the runtime and its font cross-origin
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(f) });
  });
  await page.addInitScript(fakeMain, { project, transcript });
  await page.goto(`http://localhost:5199/app/editor/${project.id}`);
  await page.waitForSelector(ready, { timeout: 90000 });
  await page.waitForTimeout(3000);
  return { context, page, errors };
};
const frames = (page, n = 3) => page.evaluate((n) => new Promise((r) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : r()); f(n); }), n);

// A picture made in the browser (our own drawing, not Cardboard's): an SVG rendered to PNG.
const renderSvg = async (browser, svg, width, height) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<style>html,body{margin:0;background:#000}</style>${svg}`);
  const png = await page.screenshot({ type: "png" });
  await page.close();
  return png;
};
// An overlay layer: transparent PNG of the given device size (only marks: a ring, a label)
const renderOverlay = async (browser, html, width, height) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}*{box-sizing:border-box}</style>${html}`);
  const png = await page.screenshot({ type: "png", omitBackground: true });
  await page.close();
  return png;
};

// ---------------------------------------------------------------------------------------------------------------
// Encoding
const ff = (...a) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: ["ignore", "inherit", "inherit"] });
// Overlays: [{ png, from, to }] (frame numbers, inclusive; a still has frame 0), laid over the capture before scaling
const overlayChain = (overlays, extra) => {
  if (!overlays?.length) return extra;
  const parts = overlays.map((o, i) => `${i ? `[o${i}]` : "[0]"}[${i + 1}]overlay=0:0:enable='between(n,${o.from},${o.to})'${i < overlays.length - 1 ? `[o${i + 1}]` : ""}`);
  return parts.join(";") + "," + extra;
};
// a clip from numbered PNG frames: MP4 (H.264, no sound, starts at once), WebM, and its poster (WebP, frame `poster`)
const clip = (pattern, dest, width, { fps = 30, overlays = [], poster = 0, crf = 26 } = {}) => {
  ff("-framerate", String(fps), "-i", pattern, ...overlays.flatMap((o) => ["-i", o.png]), "-filter_complex", overlayChain(overlays, `scale=${width}:-2:flags=lanczos,format=yuv420p`),
    "-an", "-c:v", "libx264", "-preset", "veryslow", "-crf", String(crf), "-tune", "animation", "-movflags", "+faststart", dest + ".mp4");
  // WebM (VP9) too, for browsers without H.264 (Chromium as built from source)
  ff("-framerate", String(fps), "-i", pattern, ...overlays.flatMap((o) => ["-i", o.png]), "-filter_complex", overlayChain(overlays, `scale=${width}:-2:flags=lanczos,format=yuv420p`),
    "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1", "-deadline", "good", "-cpu-used", "1", dest + ".webm");
  const p = pattern.replace("%04d", String(poster).padStart(4, "0"));
  const on = overlays.filter((o) => o.from <= poster && poster <= o.to).map((o) => ({ ...o, from: 0, to: 0 }));
  ff("-i", p, ...on.flatMap((o) => ["-i", o.png]), "-filter_complex", overlayChain(on, `scale=${width}:-2:flags=lanczos`), "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", dest + ".webp");
};
// a still (WebP) from one screenshot, with overlays
const still = (src, dest, width, overlays = []) => {
  const on = overlays.map((o) => ({ ...o, from: 0, to: 0 }));
  ff("-i", src, ...on.flatMap((o) => ["-i", o.png]), "-filter_complex", overlayChain(on, `scale=${width}:-2:flags=lanczos`), "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", dest);
};
// numbered frames: save the next one; hold the last one for n more
const framer = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const name = (i) => path.join(dir, `${String(i).padStart(4, "0")}.png`);
  return {
    get n() { return n; },
    pattern: path.join(dir, "%04d.png"),
    async shot(page, clipRect) { await page.screenshot({ path: name(n++), clip: clipRect, caret: "initial" }); return n - 1; },
    add(file) { fs.copyFileSync(file, name(n++)); },
    hold(k) { for (let i = 0; i < k; i++) { fs.copyFileSync(name(n - 1), name(n)); n++; } },
  };
};
// an overlay's marks: a red ring around a rect, a key label ("←", "Space"); device px of the capture
const RED = "#f87171";
const ringHtml = (r, dpr, pad = 6) => `<div style="position:absolute;left:${(r.x - pad) * dpr}px;top:${(r.y - pad) * dpr}px;width:${(r.width + 2 * pad) * dpr}px;height:${(r.height + 2 * pad) * dpr}px;border:${2.5 * dpr}px solid ${RED};border-radius:${Math.min(r.width, r.height) * dpr}px"></div>`;
const keyHtml = (text, dpr, where = "right:12px;top:10px") => `<div style="position:absolute;${where.replace(/(\d+)px/g, (_, v) => `${v * dpr}px`)};padding:${3 * dpr}px ${9 * dpr}px;border-radius:${7 * dpr}px;background:${RED};color:#160404;font:600 ${13 * dpr}px/1.35 system-ui,sans-serif">${text}</div>`;
const dims = (file) => {
  const out = execFileSync(FFMPEG.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,duration", "-of", "json", file]).toString();
  return JSON.parse(out).streams[0];
};

// ---------------------------------------------------------------------------------------------------------------
// The cases. Each runs both builds the same way and writes img/cb/<case>-<side>.*
const CASES = {};

// Code graphics in full screen with the preview zoomed out a step (Ctrl+wheel to 0.9): Cardboard draws the graphic
// 1/0.9 too large from the top-left corner, ours over the picture. Stills, in full screen.
CASES.fullscreen = async (browser, dirs, raw) => {
  const W = 1920, H = 1080;
  // the picture: a coast at sunrise (our own drawing)
  const picture = await renderSvg(browser, `<svg width="${W}" height="${H}" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f3358"/><stop offset=".62" stop-color="#e9946a"/><stop offset=".66" stop-color="#f6c48f"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#37587c"/><stop offset="1" stop-color="#0e1a2c"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#ffe2b0" stop-opacity=".9"/><stop offset="1" stop-color="#ffe2b0" stop-opacity="0"/></radialGradient></defs>
    <rect width="1920" height="1080" fill="url(#sky)"/>
    <circle cx="1340" cy="600" r="260" fill="url(#glow)"/><circle cx="1340" cy="600" r="96" fill="#ffe7bf"/>
    <path d="M0 640 L180 560 L320 610 L470 520 L640 600 L820 540 L980 630 L1920 650 L1920 720 L0 720Z" fill="#4a4566"/>
    <rect y="700" width="1920" height="380" fill="url(#sea)"/>
    <g fill="#ffe2b0" opacity=".55"><rect x="1250" y="730" width="180" height="6" rx="3"/><rect x="1210" y="770" width="260" height="6" rx="3"/><rect x="1270" y="815" width="140" height="6" rx="3"/><rect x="1180" y="865" width="320" height="7" rx="3"/><rect x="1240" y="925" width="200" height="7" rx="3"/></g>
    <path d="M0 860 L260 790 L520 880 L760 980 L760 1080 L0 1080Z" fill="#141826"/>
  </svg>`, W, H);
  // the graphic, as a person would write one for this picture: a frame at its edges, a ring on the sun, a title
  const SOURCE = `export default function Graphic({ width, height }) {
  return (
    <svg width={width} height={height} viewBox="0 0 1920 1080">
      <rect x="48" y="48" width="1824" height="984" rx="24" fill="none" stroke="#ffffff" strokeWidth="10" />
      <circle cx="1340" cy="600" r="150" fill="none" stroke="#ffffff" strokeWidth="8" />
      <text x="1340" y="400" textAnchor="middle" fill="#ffffff" fontSize="44" fontWeight="600" fontFamily="sans-serif">Sunrise, 6:42</text>
      <rect x="120" y="840" width="780" height="132" rx="16" fill="rgba(8,10,18,0.78)" />
      <text x="160" y="900" fill="#ffffff" fontSize="52" fontWeight="700" fontFamily="sans-serif">Morning on the coast</text>
      <text x="160" y="946" fill="#ffd9a6" fontSize="32" fontFamily="sans-serif">Day one</text>
    </svg>
  );
}
`;
  const IMG = "aaaaaaaa-0000-4000-8000-000000000001", CODE = "aaaaaaaa-0000-4000-8000-000000000002";
  const FX = "bbbbbbbb-0000-4000-8000-000000000001", V1 = "bbbbbbbb-0000-4000-8000-000000000002";
  const project = {
    id: PID, name: "Coast", createdAt: now, updatedAt: now, stateUpdatedAt: 1793899934269, aspectRatio: "16:9",
    media: [
      { id: IMG, createdAt: now, addedAt: now, data: { type: "image", src: "cardboard-media://media/" + IMG, fileName: "coast.png", format: "png", size: picture.length, width: W, height: H, thumbnailGenerationStatus: "complete", metadataStatus: "complete" } },
      { id: CODE, createdAt: now, addedAt: now, data: { type: "code", fileName: "Title and sun", format: "code", size: 0, code: { source: SOURCE, width: W, height: H } } },
    ],
    tracks: [track(FX, "Graphics", 0), track(V1, "Video", 1)],
    timelineItems: [
      { id: "cccccccc-0000-4000-8000-000000000001", trackId: FX, type: "code", startTime: 0, endTime: 60, trimStart: 0, trimEnd: 60, name: "Title and sun", codeComposition: { width: W, height: H }, mediaItemId: CODE },
      { id: "cccccccc-0000-4000-8000-000000000002", trackId: V1, type: "image", startTime: 0, endTime: 60, trimStart: 0, trimEnd: 60, mediaItemId: IMG, autoReframe: true },
    ],
  };
  const out = {};
  for (const side of SIDES) {
    const dpr = 1.5, { context, page, errors } = await openEditor(browser, dirs[side], { project, viewport: { width: 1280, height: 720 }, dpr, media: { [IMG]: { type: "image/png", body: picture } } });
    await page.evaluate(() => window.__cbTestStore().setPlaybackPosition(1));
    const cb = await (await page.$("canvas[data-preview-canvas]")).boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    // Ctrl+wheel over the preview, as a person zooms it: Cardboard scales by 1 - deltaY*0.004 (CSS px), so 25 px is 0.9
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 25 * dpr);
    await page.keyboard.up("Control");
    await page.mouse.move(4, 4);
    await page.waitForTimeout(1500);
    const zoom = await page.evaluate(() => +window.__cbTestStore().canvasTransform.scale.toFixed(3));
    if (zoom !== 0.9) throw new Error(`${side}: the preview's zoom is ${zoom}, not 0.9`);
    await page.screenshot({ path: path.join(raw, `${side}-editor.png`) });
    await page.locator('button[aria-label="Fullscreen"]').first().click();
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.mouse.move(4, 4);
    await page.waitForTimeout(3500);
    const fs0 = await page.evaluate(() => !!document.fullscreenElement);
    if (!fs0) throw new Error(`${side}: not in full screen`);
    await page.screenshot({ path: path.join(raw, `${side}-full.png`) });
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    still(path.join(raw, `${side}-full.png`), path.join(DEST, `fullscreen-${side}.webp`), 960);
    out[side] = { zoom };
  }
  return out;
};

// Clip names: the timeline scrolled a few pixels a frame so that two music clips' start passes its left edge and
// back. Cardboard draws a name twice while its clip starts less than the name's width off screen; ours, once.
const audio = (id, fileName) => ({ id, createdAt: now, addedAt: now, data: { type: "audio", src: "cardboard-media://media/" + id, fileName, format: "mp3", size: 1000, duration: 600, metadataStatus: "complete" } });
const audioClip = (n, trackId, mediaItemId, name, start, end) => ({ id: `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`, trackId, type: "audio", startTime: start, endTime: end, trimStart: 0, trimEnd: end - start, mediaItemId, name, volume: 1 });
CASES.names = async (browser, dirs, raw) => {
  const A1 = "aaaaaaaa-0000-4000-8000-000000000001", A2 = "aaaaaaaa-0000-4000-8000-000000000002", A3 = "aaaaaaaa-0000-4000-8000-000000000003";
  const M1 = "bbbbbbbb-0000-4000-8000-000000000001", M2 = "bbbbbbbb-0000-4000-8000-000000000002", SFX = "bbbbbbbb-0000-4000-8000-000000000003";
  const project = {
    id: PID, name: "Score", createdAt: now, updatedAt: now, stateUpdatedAt: 1793900000000, aspectRatio: "16:9",
    media: [audio(A1, "Arctic Reverie (light score).mp3"), audio(A2, "Old Cinema (light score).mp3"), audio(A3, "Whoosh.mp3")],
    tracks: [track(M1, "Music 1", 0, "audio"), track(M2, "Music 2", 1, "audio"), track(SFX, "SFX", 2, "audio")],
    timelineItems: [
      audioClip(1, M1, A1, "Arctic Reverie (light score)", 4, 40), audioClip(2, M2, A2, "Old Cinema (light score)", 4, 40),
      ...Array.from({ length: 16 }, (_, i) => audioClip(10 + i, SFX, A3, `Whoosh ${i + 1}`, 1 + i * 2.5, 3 + i * 2.5)),
    ],
  };
  // the clips' start from 40 px before the view's left edge to 180 px past it and back, 2 px a frame (60 px a
  // second at 30 frames a second), resting 0.7 s at each end
  const ds = [], step = 2, from = -40, to = 180, rest = 21;
  for (let d = from; d <= to; d += step) ds.push(d);
  for (let i = 0; i < rest; i++) ds.push(to);
  for (let d = to - step; d >= from; d -= step) ds.push(d);
  for (let i = 0; i < rest; i++) ds.push(from);
  const out = {};
  for (const side of SIDES) {
    const dir = path.join(raw, side);
    fs.mkdirSync(dir, { recursive: true });
    const { context, page, errors } = await openEditor(browser, dirs[side], { project, viewport: { width: 1440, height: 900 }, dpr: 2, ready: "[data-timeline-scroll] canvas[data-timeline-canvas-layer=base]" });
    // 60 px a second
    await page.evaluate(() => window.__cbTestStore().setZoomLevel(1.2));
    await page.waitForTimeout(1000);
    const pps = await page.evaluate(() => window.__cbTestStore().pixelsPerSecond);
    if (pps !== 60) throw new Error(`${side}: ${pps} px a second`);
    const start = 4 * pps;
    const box = await page.evaluate(() => {
      const sc = document.querySelector("[data-timeline-scroll]").getBoundingClientRect();
      const rows = [...document.querySelectorAll("[data-timeline-scroll] [data-track-id]")].map((e) => e.getBoundingClientRect());
      return { left: sc.left, top: sc.top, bottom: Math.max(...rows.map((r) => r.bottom)) };
    });
    // the track names, the timeline's left edge and 340 px of the view; the ruler and the tracks
    const clipRect = { x: 0, y: Math.round(box.top), width: Math.round(box.left) + 340, height: Math.round(box.bottom - box.top) + 2 };
    await page.screenshot({ path: path.join(raw, `${side}-editor.png`) });
    let i = 0, poster = 0;
    for (const d of ds) {
      await page.evaluate((s) => { document.querySelector("[data-timeline-scroll]").scrollLeft = s; }, start + d);
      await frames(page, 3);
      if (d === 52 && !poster) poster = i;
      await page.screenshot({ path: path.join(dir, `${String(i++).padStart(4, "0")}.png`), clip: clipRect });
    }
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    clip(path.join(dir, "%04d.png"), path.join(DEST, `names-${side}`), clipRect.width * 2, { poster });
    out[side] = { frames: ds.length, poster, clip: clipRect };
  }
  return out;
};

// The left rail's tooltips: the pointer rests on its Audio icon. Cardboard shows no name; ours shows "Audio".
const simpleProject = () => {
  const A1 = "aaaaaaaa-0000-4000-8000-000000000001", M1 = "bbbbbbbb-0000-4000-8000-000000000001", M2 = "bbbbbbbb-0000-4000-8000-000000000002";
  return {
    id: PID, name: "Score", createdAt: now, updatedAt: now, stateUpdatedAt: 1793900000000, aspectRatio: "16:9",
    media: [audio(A1, "Arctic Reverie.mp3")],
    tracks: [track(M1, "Music 1", 0, "audio"), track(M2, "Music 2", 1, "audio")],
    timelineItems: [audioClip(1, M1, A1, "Arctic Reverie", 0, 40), audioClip(2, M2, A1, "Arctic Reverie", 2, 30)],
  };
};
const TIMELINE = "[data-timeline-scroll] canvas[data-timeline-canvas-layer=base]";
CASES.tooltips = async (browser, dirs, raw) => {
  const out = {}, dpr = 2;
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project: simpleProject(), viewport: { width: 1440, height: 900 }, dpr, ready: TIMELINE });
    const button = page.locator('button[aria-label="Audio"]').first();
    await button.hover();
    await page.waitForTimeout(1500);
    const r = await button.boundingBox();
    const tip = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"],[data-radix-popper-content-wrapper]')].map((e) => e.textContent.trim()).filter(Boolean));
    // the rail's top icons, the tooltip's place beside them and the Library panel's edge
    const clipRect = { x: 0, y: 0, width: 240, height: 210 };
    const file = path.join(raw, `${side}.png`);
    await page.screenshot({ path: file, clip: clipRect });
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    const ring = path.join(raw, `${side}-ring.png`);
    fs.writeFileSync(ring, await renderOverlay(browser, ringHtml({ x: r.x + r.width / 2 - 17, y: r.y + r.height / 2 - 17, width: 34, height: 34 }, dpr, 0), clipRect.width * dpr, clipRect.height * dpr));
    still(file, path.join(DEST, `tooltips-${side}.webp`), 480, [{ png: ring }]);
    out[side] = { tooltip: tip };
  }
  if (out.cardboard.tooltip.length || !out.ours.tooltip.includes("Audio")) throw new Error("tooltips: expected none in Cardboard and Audio in ours");
  return out;
};

// Next frame (→), pressed again and again with the playhead near the timeline's right edge. Cardboard's playhead
// walks off the visible part; ours keeps it in view.
CASES.playhead = async (browser, dirs, raw) => {
  const out = {}, dpr = 2, presses = 45, fps = 15;
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project: simpleProject(), viewport: { width: 1200, height: 760 }, dpr, ready: TIMELINE });
    await page.evaluate(() => window.__cbTestStore().setZoomLevel(4));
    await page.waitForTimeout(800);
    const v = await page.evaluate(() => {
      const sc = document.querySelector("[data-timeline-scroll]"), r = sc.getBoundingClientRect();
      const rows = [...sc.querySelectorAll("[data-track-id]")].map((e) => e.getBoundingClientRect());
      sc.scrollLeft = 0;
      return { left: r.left, top: r.top, right: r.left + sc.clientWidth, width: sc.clientWidth, bottom: Math.max(...rows.map((x) => x.bottom)), pps: window.__cbTestStore().pixelsPerSecond };
    });
    // the playhead 130 px from the right edge, on a whole frame (30 a second)
    const t0 = Math.round(((v.width - 130) / v.pps) * 30) / 30;
    await page.evaluate((t) => { window.__cbTestStore().setPlaybackPosition(t); document.activeElement?.blur?.(); }, t0);
    await page.mouse.move(600, 200);
    await page.waitForTimeout(1500);
    // the timeline's toolbar (the time), ruler and tracks
    const clipRect = { x: 0, y: Math.round(v.top - 38), width: Math.round(v.right), height: Math.round(v.bottom - v.top + 40) };
    const f = framer(path.join(raw, side));
    await f.shot(page, clipRect);
    f.hold(fps - 1);
    const at = () => page.evaluate(() => { const s = window.__cbTestStore(), sc = document.querySelector("[data-timeline-scroll]"); const t = s.currentTime ?? s.playbackPosition; return { t, x: t * s.pixelsPerSecond - sc.scrollLeft, scrollLeft: sc.scrollLeft }; });
    const before = await at();
    const k0 = f.n;
    for (let i = 0; i < presses; i++) { await page.keyboard.press("ArrowRight"); await frames(page, 2); await f.shot(page, clipRect); }
    const k1 = f.n - 1;
    f.hold(fps * 2);
    const after = await at();
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    const key = path.join(raw, `${side}-key.png`);
    fs.writeFileSync(key, await renderOverlay(browser, keyHtml("→ pressed again and again", dpr, "left:300px;bottom:12px"), clipRect.width * dpr, clipRect.height * dpr));
    clip(f.pattern, path.join(DEST, `playhead-${side}`), 1100, { fps, overlays: [{ png: key, from: k0, to: k1 }], poster: k1 });
    out[side] = { before, after, inView: after.x >= 0 && after.x <= v.width, frames: f.n };
  }
  if (out.cardboard.inView || !out.ours.inView) throw new Error("playhead: expected Cardboard's out of view and ours in view");
  return out;
};

// A badge in the prompt box: the caret after it (and the space Cardboard adds), ← twice, then "the ". Cardboard's caret goes into the badge
// and the typing breaks it into loose text; ours steps over it and the badge stays whole.
CASES.badges = async (browser, dirs, raw) => {
  const out = {}, dpr = 2, fps = 30;
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project: simpleProject(), viewport: { width: 1440, height: 900 }, dpr, ready: TIMELINE });
    const box = page.getByPlaceholder("Describe the edit");
    await box.click();
    await page.keyboard.type("Make ");
    await page.keyboard.type("@");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const state = () => page.evaluate(() => { const t = document.activeElement; return { value: t?.value, caret: t?.selectionStart, codes: [...(t?.value ?? "")].map((c) => c.charCodeAt(0)).filter((c) => c > 127 || c === 32) }; });
    const picked = await state();
    const clipRect = await page.evaluate(() => {
      let e = document.activeElement;
      while (e && !/desktop-composer/.test(e.className)) e = e.parentElement;
      const r = (e ?? document.activeElement).getBoundingClientRect();
      return { x: Math.floor(r.left - 8), y: Math.floor(r.top - 8), width: Math.ceil(r.width + 16), height: Math.ceil(r.height + 16) };
    });
    const f = framer(path.join(raw, side));
    await f.shot(page, clipRect);
    f.hold(fps - 1);
    const k0 = f.n;
    for (let i = 0; i < 2; i++) { await page.keyboard.press("ArrowLeft"); await frames(page, 2); await f.shot(page, clipRect); f.hold(Math.round(fps * 0.4) - 1); }
    f.hold(Math.round(fps * 0.3));
    const k1 = f.n;
    for (const ch of "the ") { await page.keyboard.type(ch); await frames(page, 2); await f.shot(page, clipRect); f.hold(5); }
    const k2 = f.n - 1;
    f.hold(fps * 2);
    const typed = await state();
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    const o1 = path.join(raw, `${side}-k1.png`), o2 = path.join(raw, `${side}-k2.png`);
    fs.writeFileSync(o1, await renderOverlay(browser, keyHtml("← ←", dpr, "right:14px;top:12px"), clipRect.width * dpr, clipRect.height * dpr));
    fs.writeFileSync(o2, await renderOverlay(browser, keyHtml("typing “the ”", dpr, "right:14px;top:12px"), clipRect.width * dpr, clipRect.height * dpr));
    clip(f.pattern, path.join(DEST, `badges-${side}`), Math.min(800, clipRect.width * dpr), { fps, overlays: [{ png: o1, from: k0, to: k1 - 1 }, { png: o2, from: k1, to: k2 }], poster: f.n - 1 });
    out[side] = { picked, typed };
  }
  return out;
};

// An agent's question: a click on an option picks it, then Enter. Cardboard's Enter clicks the focused option
// again, which un-picks it, so nothing is sent; ours sends the picked answer.
CASES.enter = async (browser, dirs, raw) => {
  const out = {}, dpr = 2, fps = 30, at = "2026-11-05T10:00:05.000Z";
  const transcript = {
    busy: false, asking: ["q1"],
    events: [
      { type: "user", id: "m1", text: "Cut a 30-second trailer from the harbour footage", at },
      { type: "question", id: "q1", questions: [{ header: "Opening shot", question: "Which shot should open the trailer?", multiSelect: false, options: [
        { label: "The harbour at dawn", description: "Wide, slow, quiet" },
        { label: "The captain's close-up", description: "Starts on a face" },
        { label: "Drone over the cliffs", description: "Big and fast" },
      ] }] },
    ],
  };
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project: simpleProject(), transcript, viewport: { width: 1440, height: 900 }, dpr, ready: TIMELINE });
    const option = page.locator('button[data-analytics="director-question-option"]').nth(1);
    await option.waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(raw, `${side}-editor.png`) });
    // the chat panel, from the question's card down
    const clipRect = await page.evaluate(() => {
      const opts = [...document.querySelectorAll('button[data-analytics="director-question-option"]')].map((b) => b.getBoundingClientRect());
      const box = document.querySelector('textarea[aria-label="Answer the agent"]')?.getBoundingClientRect();
      const left = Math.min(...opts.map((r) => r.left)) - 22, right = Math.max(...opts.map((r) => r.right)) + 22;
      const top = Math.min(...opts.map((r) => r.top)) - 78, bottom = (box ? box.bottom : Math.max(...opts.map((r) => r.bottom))) + 62;
      return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(Math.min(bottom, innerHeight) - top) };
    });
    const state = () => page.evaluate(() => ({ pressed: [...document.querySelectorAll('button[data-analytics="director-question-option"]')].map((b) => b.getAttribute("aria-pressed")), sent: window.__cbRequests.filter((c) => c === "local-agent:answer").length }));
    const f = framer(path.join(raw, side));
    await f.shot(page, clipRect);
    f.hold(fps - 1);
    const r = await option.boundingBox();
    const k0 = f.n;
    await option.click();
    await page.mouse.move(r.x + r.width - 30, r.y + r.height / 2);
    await frames(page, 4);
    await f.shot(page, clipRect);
    f.hold(Math.round(fps * 1.1) - 1);
    const clicked = await state();
    const k1 = f.n;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await f.shot(page, clipRect);
    f.hold(fps * 2);
    const entered = await state();
    await page.screenshot({ path: path.join(raw, `${side}-after.png`) });
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    const ring = path.join(raw, `${side}-click.png`), key = path.join(raw, `${side}-enter.png`);
    const rel = { x: r.x - clipRect.x, y: r.y - clipRect.y, width: r.width, height: r.height };
    fs.writeFileSync(ring, await renderOverlay(browser, ringHtml(rel, dpr, 3).replace(/border-radius:[^"]*"/, `border-radius:${14 * dpr}px"`) + keyHtml("Click", dpr, "right:12px;top:10px"), clipRect.width * dpr, clipRect.height * dpr));
    fs.writeFileSync(key, await renderOverlay(browser, keyHtml("Enter", dpr, "right:12px;top:10px"), clipRect.width * dpr, clipRect.height * dpr));
    clip(f.pattern, path.join(DEST, `enter-${side}`), Math.min(760, clipRect.width * dpr), { fps, overlays: [{ png: ring, from: k0, to: k1 - 1 }, { png: key, from: k1, to: f.n - 1 }], poster: f.n - 1 });
    out[side] = { clicked, entered, clip: clipRect };
  }
  const c = out.cardboard, o = out.ours;
  if (!c.clicked.pressed.includes("true") || c.entered.pressed.includes("true") || c.entered.sent || !o.clicked.pressed.includes("true") || o.entered.sent !== 1) throw new Error("enter: expected Cardboard to un-pick and send nothing, ours to send");
  return out;
};

// Clicking the timeline with the prompt box focused, then Space. Cardboard keeps the keyboard in the box: Space
// types a space and nothing plays. Ours moves the keyboard to the timeline: Space plays.
CASES.focus = async (browser, dirs, raw) => {
  const out = {}, dpr = 2, fps = 10;
  // a picture to play (our own drawing)
  const picture = await renderSvg(browser, `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f3358"/><stop offset="1" stop-color="#e9946a"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="900" cy="400" r="70" fill="#ffe7bf"/><rect y="470" width="1280" height="250" fill="#26405f"/></svg>`, 1280, 720);
  const IMG = "aaaaaaaa-0000-4000-8000-000000000009", V1 = "bbbbbbbb-0000-4000-8000-000000000009";
  const project = {
    id: PID, name: "Intro", createdAt: now, updatedAt: now, stateUpdatedAt: 1793900000000, aspectRatio: "16:9",
    media: [{ id: IMG, createdAt: now, addedAt: now, data: { type: "image", src: "cardboard-media://media/" + IMG, fileName: "intro.png", format: "png", size: picture.length, width: 1280, height: 720, thumbnailGenerationStatus: "complete", metadataStatus: "complete" } }],
    tracks: [track(V1, "Video", 0)],
    timelineItems: [{ id: "cccccccc-0000-4000-8000-000000000009", trackId: V1, type: "image", startTime: 0, endTime: 30, trimStart: 0, trimEnd: 30, mediaItemId: IMG, name: "Intro", autoReframe: true }],
  };
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project, viewport: { width: 1200, height: 760 }, dpr, media: { [IMG]: { type: "image/png", body: picture } }, ready: TIMELINE });
    const box = page.getByPlaceholder("Describe the edit");
    await box.click();
    await page.keyboard.type("Make the intro shorter");
    await page.waitForTimeout(500);
    const v = await page.evaluate(() => {
      const sc = document.querySelector("[data-timeline-scroll]"), r = sc.getBoundingClientRect(), t = document.activeElement.getBoundingClientRect();
      return { left: r.left, top: r.top, pps: window.__cbTestStore().pixelsPerSecond, scrollLeft: sc.scrollLeft, prompt: t.top };
    });
    await page.screenshot({ path: path.join(raw, `${side}-editor.png`) });
    // from the timeline's toolbar (or the prompt box, if higher) to the window's bottom
    const y0 = Math.floor(Math.min(v.top - 38, v.prompt - 40));
    const clipRect = { x: 0, y: y0, width: 1200, height: 760 - y0 };
    const state = () => page.evaluate(() => ({ value: document.querySelector('textarea[aria-label="Message the agent"]')?.value, playing: window.__cbTestStore().isPlaying, focus: document.activeElement?.tagName }));
    const f = framer(path.join(raw, side));
    await f.shot(page, clipRect);
    f.hold(fps - 1);
    // a click on the ruler at 2 s
    const cx = v.left + 2 * v.pps - v.scrollLeft, cy = v.top + 12;
    const k0 = f.n;
    await page.mouse.click(cx, cy);
    await frames(page, 3);
    await f.shot(page, clipRect);
    f.hold(fps - 1);
    const k1 = f.n;
    // 2.5 s after Space as it happens: the page's own painted frames (Chromium's screencast, each with the time it
    // was drawn); frame k of the clip (k × 100 ms) is the newest frame drawn by then, so the clip runs in real time
    // however busy the box is
    const cdp = await context.newCDPSession(page), live = path.join(raw, `${side}-live`), shots = [];
    fs.mkdirSync(live, { recursive: true });
    cdp.on("Page.screencastFrame", (e) => {
      const file = path.join(live, `${shots.length}.jpg`);
      fs.writeFileSync(file, Buffer.from(e.data, "base64"));
      shots.push({ t: e.metadata.timestamp * 1000, file, w: e.metadata.deviceWidth, sx: e.metadata.deviceWidth });
      cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1200 * dpr, maxHeight: 760 * dpr });
    await page.waitForTimeout(400);
    const t0 = Date.now();
    await page.keyboard.press("Space");
    await page.waitForTimeout(2500);
    await cdp.send("Page.stopScreencast");
    const pressed = await state();
    const pick = (k) => shots.filter((x) => x.t <= t0 + k * 100).pop() ?? shots[0];
    for (let k = 0; k < 25; k++) {
      const s = pick(k), png = s.file.replace(/\.jpg$/, ".png");
      // the frame is the whole view, in device pixels: crop it as the screenshots are
      if (!fs.existsSync(png)) ff("-i", s.file, "-vf", `scale=${1200 * dpr}:-1,crop=${clipRect.width * dpr}:${clipRect.height * dpr}:${clipRect.x * dpr}:${clipRect.y * dpr}`, png);
      f.add(png);
    }
    out[side] = { live: shots.filter((x) => x.t >= t0 && x.t <= t0 + 2500).length };
    const k2 = f.n - 1;
    f.hold(fps);
    if (pressed.playing) await page.keyboard.press("Space");
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    const o1 = path.join(raw, `${side}-click.png`), o2 = path.join(raw, `${side}-space.png`);
    fs.writeFileSync(o1, await renderOverlay(browser, ringHtml({ x: cx - 9, y: cy - clipRect.y - 9, width: 18, height: 18 }, dpr, 0) + keyHtml("Click on the timeline", dpr, "left:340px;top:150px"), clipRect.width * dpr, clipRect.height * dpr));
    fs.writeFileSync(o2, await renderOverlay(browser, keyHtml("Space", dpr, "left:340px;top:150px"), clipRect.width * dpr, clipRect.height * dpr));
    clip(f.pattern, path.join(DEST, `focus-${side}`), 1100, { fps, overlays: [{ png: o1, from: k0, to: k1 - 1 }, { png: o2, from: k1, to: k2 }], poster: k2 });
    out[side] = { ...out[side], pressed, frames: f.n };
  }
  // the editor draws its preview in software here: on a busy box a playing editor paints only a few frames a second
  if (out.ours.live < 6) console.log(`focus: WARNING only ${out.ours.live} frames painted in 2.5 s of playback; the clip will be jerky (run again on a quieter box)`);
  const c = out.cardboard.pressed, o = out.ours.pressed;
  if (c.playing || !c.value?.endsWith("shorter ") || !o.playing || o.value !== "Make the intro shorter") throw new Error(`focus: expected Cardboard to type a space and not play, ours to play: ${JSON.stringify(out)}`);
  return out;
};

// The timeline after the GPU process restarts (Chromium's DevTools Browser.crashGpuProcess, as a driver reset or a
// GPU process crash does): Chromium gives the 2D canvases back blank. Cardboard's ruler and tracks stay black until
// something else redraws them; ours redraw at once.
CASES.gpu = async (browser, dirs, raw) => {
  const out = {}, dpr = 2;
  for (const side of SIDES) {
    const { context, page, errors } = await openEditor(browser, dirs[side], { project: simpleProject(), viewport: { width: 1200, height: 760 }, dpr, ready: TIMELINE });
    await page.mouse.move(600, 200);
    await page.waitForTimeout(1000);
    const v = await page.evaluate(() => {
      const sc = document.querySelector("[data-timeline-scroll]"), r = sc.getBoundingClientRect();
      const rows = [...sc.querySelectorAll("[data-track-id]")].map((e) => e.getBoundingClientRect());
      window.__cbEvents = [];
      for (const c of document.querySelectorAll("canvas")) for (const t of ["contextlost", "contextrestored"]) c.addEventListener(t, () => window.__cbEvents.push(t));
      return { top: r.top, right: r.left + sc.clientWidth, bottom: Math.max(...rows.map((x) => x.bottom)) };
    });
    const clipRect = { x: 0, y: Math.round(v.top - 38), width: Math.round(v.right), height: Math.round(v.bottom - v.top + 40) };
    // a pixel of the first clip on the tracks' canvas (a clip is green, an empty canvas black)
    const sample = () => page.evaluate(() => { const c = document.querySelector("canvas[data-timeline-canvas-layer=base]"); const d = c.getContext("2d").getImageData(Math.round(60 * devicePixelRatio), Math.round(20 * devicePixelRatio), 1, 1).data; return [...d.slice(0, 3)]; });
    const before = await sample();
    await page.screenshot({ path: path.join(raw, `${side}-before.png`), clip: clipRect });
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.crashGpuProcess");
    await cdp.detach();
    await page.waitForTimeout(4000);
    const after = await sample(), events = await page.evaluate(() => window.__cbEvents);
    const file = path.join(raw, `${side}-after.png`);
    await page.screenshot({ path: file, clip: clipRect });
    if (errors.length) throw new Error(`${side}: page errors ${errors.join("; ")}`);
    await context.close();
    still(file, path.join(DEST, `gpu-${side}.webp`), 1100);
    out[side] = { before, after, restored: events.filter((e) => e === "contextrestored").length };
  }
  const dark = (p) => p.every((x) => x < 16);
  if (!dark(out.cardboard.after) || dark(out.ours.after) || dark(out.cardboard.before) || !out.cardboard.restored) throw new Error("gpu: expected Cardboard's tracks black after the restart and ours drawn");
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(DEST, { recursive: true });
  const dirs = builds();
  const browser = await launch();
  const report = {};
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (ONLY && !ONLY.includes(name)) continue;
      const raw = path.join(WORK, "raw", name);
      fs.rmSync(raw, { recursive: true, force: true });
      fs.mkdirSync(raw, { recursive: true });
      const t0 = Date.now();
      report[name] = await run(browser, dirs, raw);
      console.log(`${name}: ${JSON.stringify(report[name])} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  } finally { await browser.close(); }
  for (const f of fs.readdirSync(DEST).sort()) {
    const p = path.join(DEST, f), d = dims(p);
    console.log(`${f.padEnd(28)} ${String(fs.statSync(p).size).padStart(8)} B  ${d.width}x${d.height}${f.endsWith(".mp4") ? `  ${d.nb_frames} frames, ${(+d.duration).toFixed(2)} s` : ""}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
