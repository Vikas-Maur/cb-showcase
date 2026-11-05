// Regress 2026-11-05 (the laptop at 125%: "see the text overlapping in this timeline"): a clip's name drawn twice on
// the timeline, once at the clip's start (cut by the view's left edge) and again at that edge, overlapping, whenever
// the clip started less than its name's width off screen. Cardboard's own drawing (patch-renderer.js 22): its pristine
// 1.4.0 pages do it at every scale, and our patched pages must draw each name once.
//
// Cardboard's real editor pages in headless Chromium, a fake main answering window.desktop (as stage-hover.js), one
// project: two music tracks whose clips start together (at 4 s and again at 70 s, the second pair where the tracks'
// base canvas no longer starts at 0), and a track of 2 s sound effects, so that the scrolling hands many names over.
// At 60 px/s, at device pixel ratios 1, 1.25 and 2, for each build:
// - still: the timeline scrolled so the music clips start 20, 53 and 90 px left of the view, as screenshots
//   (Chromium's own compositing): each music track's name row against the same row with the clips' starts far off
//   screen (one name, at the edge). Pristine is expected to differ (Cardboard's bug), patched to be the same.
// - sweep: the scroll moved 4 px a frame, from 40 px before the clips' start to 300 px past it and back, near the start
//   and near 70 s. Each frame the base canvas and the fixed names canvas are composed as the page shows them, both
//   right after the scroll (the names not handed over yet: that frame is on screen too) and once the editor has
//   redrawn: a music row must then be one name, the same pixels as the row with one name at the edge, or the name at
//   its clip's start (the row at 40 px before, moved by the scroll). Every 8th frame the whole view is compared with
//   a full redraw of the base canvas at the same scroll position (patch-renderer 11's contextrestored redraw): the
//   names handed over a crossing at a time must leave exactly what drawing them all again draws, on every track.
// - wheel: real sideways wheel notches, Cardboard's own horizontal scroll (its wheel handler moves the view in a frame),
//   20 each way: once a notch settles with the clips' start off screen, a music row is the one name at the edge.
// Pixels count as different 16 levels apart in a channel (the clips' gradient is dithered by where it lands on the
// canvas; a name's letters are some 150 levels off the clip's colour), and a clip's own rounded edge isn't compared.
// It exits 1 if a patched build fails anything, or if pristine 1.4.0 doesn't show the overlap (then this test no
// longer tests the fix).
//
// Usage: CARDBOARD_PRISTINE=<_inspect/cardboard-1.4.0> [PLAYWRIGHT=<path to playwright>] [CHROME=<chromium binary>]
//        node scripts/carton/test/browser/timeline-labels.js [out dir]
// Takes a few minutes (it stages the Windows build first). Screenshots of the still cases go to the out dir.
const fs = require("fs"), os = require("os"), path = require("path");
const { stage } = require("../stage");

const pristine = process.env.CARDBOARD_PRISTINE;
if (!pristine) throw new Error("CARDBOARD_PRISTINE must name Cardboard 1.4.0's unpacked app (app-asar/, cli/)");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const OUT = process.argv[2] || path.join(os.tmpdir(), "carton-timeline-labels");

// The builds: Cardboard as shipped, and with our Windows patches. Both get the editor store exposed at the anchor
// stage-hover.js uses (the editor store's own hook).
const STORE_ANCHOR = "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});";
const expose = (renderer) => {
  const f = path.join(renderer, "assets", "installErrorTelemetry-DxKId8tA.js"), src = fs.readFileSync(f, "utf8");
  if (src.split(STORE_ANCHOR).length !== 2) throw new Error("the editor store's anchor isn't there once");
  fs.writeFileSync(f, src.replace(STORE_ANCHOR, STORE_ANCHOR + "window.__cbTestStore=()=>ne.getState();"));
  return renderer;
};
const builds = () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const shipped = path.join(OUT, "pristine", "renderer");
  fs.cpSync(path.join(pristine, "app-asar", "dist", "renderer"), shipped, { recursive: true });
  const patched = path.dirname(stage(pristine, path.join(OUT, "patched")).assets);
  const editor = fs.readFileSync(path.join(patched, "assets", "EditorRoute-CuIqwZKP.js"), "utf8");
  for (const hook of ["__cbLbl={", "__cbLbl.base(de,ie,_e,Q,", "__cbLbl.off(de),We(ie,ne,Q,Y)", "__cbLbl.sync(I.current,_e,"])
    if (editor.split(hook).length !== 2) throw new Error(`the patched editor should have ${hook} once`);
  return { pristine: expose(shipped), patched: expose(patched) };
};

const PID = "11111111-2222-4333-8444-555555555555", now = "2026-11-05T10:00:00.000Z";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001", A2 = "aaaaaaaa-0000-4000-8000-000000000002", A3 = "aaaaaaaa-0000-4000-8000-000000000003";
const SFX = "bbbbbbbb-0000-4000-8000-000000000000", M1 = "bbbbbbbb-0000-4000-8000-000000000001", M2 = "bbbbbbbb-0000-4000-8000-000000000002";
const audio = (id, fileName) => ({ id, createdAt: now, addedAt: now, data: { type: "audio", src: "cardboard-media://media/" + id, fileName, format: "mp3", size: 1000, duration: 600, metadataStatus: "complete" } });
let n = 0;
const clip = (trackId, mediaItemId, name, start, end) => ({ id: `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, "0")}`, trackId, type: "audio", startTime: start, endTime: end, trimStart: 0, trimEnd: end - start, mediaItemId, name, volume: 1 });
const project = {
  id: PID, name: "Labels", createdAt: now, updatedAt: now, stateUpdatedAt: 1793900000000, aspectRatio: "16:9",
  media: [audio(A1, "Arctic Reverie (light score).mp3"), audio(A2, "Old Cinema (light score).mp3"), audio(A3, "Whoosh.mp3")],
  tracks: [
    { id: SFX, name: "SFX", order: 0, locked: false, visible: true, muted: false, type: "audio" },
    { id: M1, name: "Music 1", order: 1, locked: false, visible: true, muted: false, type: "audio" },
    { id: M2, name: "Music 2", order: 2, locked: false, visible: true, muted: false, type: "audio" },
  ],
  timelineItems: [
    ...Array.from({ length: 60 }, (_, i) => clip(SFX, A3, `Whoosh ${String(i + 1).padStart(2, "0")}`, i * 2.2, i * 2.2 + 2)),
    clip(M1, A1, "Arctic Reverie (light score)", 4, 40), clip(M2, A2, "Old Cinema (light score)", 4, 40),
    clip(M1, A1, "Northern Lights (light score)", 70, 130), clip(M2, A2, "Harbour Fog (light score)", 70, 130),
  ],
};

// main, in the page (only what the editor needs to open one project)
const fakeMain = ({ project }) => {
  const responses = new Set(), later = (f) => setTimeout(f, 0);
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
      if (data.method === "media.locate") return Object.fromEntries((data.args?.[0] ?? []).map((id) => [id, { nativePath: "/media/" + id + ".mp3", ownedByBundle: true }]));
      return null;
    }
    if (channel === "carton:call") return data.method === "undoState" ? { undo: false, redo: false } : null;
    return channel in BOOT ? BOOT[channel] : channel === "project:patch" ? { ok: true } : null;
  };
  window.desktop = {
    platform: "win32",
    getPathForFile: () => "",
    send: (ch, req) => {
      if (ch !== "main:request") return;
      Promise.resolve().then(() => handle(req)).then((data) => later(() => { for (const f of responses) f({ id: req.id, ok: true, data }); }), (e) => later(() => { for (const f of responses) f({ id: req.id, ok: false, error: String(e?.message ?? e) }); }));
    },
    on: (ch, f) => { if (ch !== "main:response") return () => {}; responses.add(f); return () => responses.delete(f); },
  };
};

// In the page: the timeline's canvases composed as shown, and the probes.
const probes = () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const els = () => ({ sc: document.querySelector("[data-timeline-scroll]"), base: document.querySelector("canvas[data-timeline-canvas-layer=base]"), ov: document.querySelector("canvas[data-timeline-canvas-layer=titles]") });
  // rows [y0, y1) in device pixels of the tracks surface; the view: what the scroll area shows, base under names
  const compose = (y0, y1) => {
    const { sc, base, ov } = els(), dpr = devicePixelRatio, w = ov.width, h = y1 - y0;
    const offsetX = parseFloat(/translate3d\((-?[\d.]+)px/.exec(base.style.transform)[1]);
    const sx = Math.round((sc.scrollLeft - offsetX) * dpr);
    const b = base.getContext("2d").getImageData(sx, y0, w, h).data, o = ov.getContext("2d").getImageData(0, y0, w, h).data, out = new Uint8ClampedArray(b.length);
    for (let i = 0; i < b.length; i += 4) { const a = o[i + 3] / 255; for (let c = 0; c < 3; c++) out[i + c] = Math.round(o[i + c] * a + b[i + c] * (1 - a)); out[i + 3] = 255; }
    return { w, h, px: out };
  };
  // how many pixels differ, by more than TOL in a channel; b moved left by dx device pixels first (columns from x0
  // on). TOL: the clips' gradient is dithered by where it lands on the base canvas, a few levels apart from one
  // scroll position to another; a name's letters are some 150 levels off the clip's colour.
  const TOL = 16;
  const diff = (a, b, dx = 0, x0 = 0) => {
    let bad = 0;
    for (let y = 0; y < a.h; y++) for (let x = x0; x < a.w; x++) {
      const bx = x + dx; if (bx < 0 || bx >= b.w) continue;
      const i = (y * a.w + x) * 4, j = (y * b.w + bx) * 4;
      if (Math.abs(a.px[i] - b.px[j]) > TOL || Math.abs(a.px[i + 1] - b.px[j + 1]) > TOL || Math.abs(a.px[i + 2] - b.px[j + 2]) > TOL) bad++;
    }
    return bad;
  };
  // the columns to compare at d px past the clips' start: from 7 px into the clip (its rounded edge left out; a name
  // starts 8 px in)
  const from0 = (d) => Math.max(0, Math.ceil((Math.max(0, -d) + 7) * devicePixelRatio));
  const scrollTo = async (s) => { els().sc.scrollLeft = s; await frame(); await frame(); await frame(); };
  // Cardboard puts off loading thumbnails and waveforms while the view scrolls (180 ms, 1 s after it stops) and redraws
  // when they come: let that happen before a sweep, so that the base canvas only changes by the names handed over
  const settle = () => new Promise((r) => setTimeout(r, 1500));
  // each music track's name row (device rows of the surface): where the fixed canvas has ink with the names stuck
  const rows = () => {
    const { ov, base } = els(), dpr = devicePixelRatio, top = base.getBoundingClientRect().top, d = ov.getContext("2d").getImageData(0, 0, Math.min(ov.width, Math.round(300 * dpr)), ov.height).data, w = Math.min(ov.width, Math.round(300 * dpr));
    return ["bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"].map((id) => {
      const t = document.querySelector(`[data-timeline-scroll] [data-track-id="${id}"]`).getBoundingClientRect();
      const a = Math.floor((t.top - top) * dpr), z = Math.ceil((t.bottom - top) * dpr);
      let lo = Infinity, hi = -1;
      for (let y = a; y < z; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
      if (hi < 0) throw new Error("no name drawn at the view's edge on " + id);
      return [lo - 3, hi + 4];
    });
  };
  window.__cbProbe = {
    pps: () => window.__cbTestStore().pixelsPerSecond,
    zoom: (z) => window.__cbTestStore().setZoomLevel(z),
    scrollTo,
    view: () => {
      const r = els().sc.getBoundingClientRect(), at = (id) => document.querySelector(`[data-timeline-scroll] [data-track-id="${id}"]`).getBoundingClientRect();
      const m1 = at("bbbbbbbb-0000-4000-8000-000000000001"), m2 = at("bbbbbbbb-0000-4000-8000-000000000002"), fx = at("bbbbbbbb-0000-4000-8000-000000000000");
      return { left: r.left, width: r.width, scrollLeft: els().sc.scrollLeft, music: { top: m1.top, bottom: m2.bottom }, sfx: (fx.top + fx.bottom) / 2 };
    },
    // one sweep at the clips starting at `start` px: per frame, both moments, every music row; full-redraw checks
    async sweep(start, { step = 4, from = -40, to = 300 } = {}) {
      const dpr = devicePixelRatio;
      await scrollTo(start + 400);
      const band = rows(), sticky = band.map(([a, z]) => compose(a, z));
      await scrollTo(start + from);
      await settle();
      const natural = band.map(([a, z]) => compose(a, z));
      const res = { frames: 0, overlap: 0, settledBad: 0, betweenBad: 0, full: 0, fullBad: 0, examples: [] };
      // a row is right if it shows one name: at the edge, or at the clip's start (the row at `from`, moved)
      const one = (k, img, d) => {
        if (d >= 0 && diff(img, sticky[k], 0, from0(d)) === 0) return true;
        return d < 8 && Number.isInteger((d - from) * dpr) && diff(img, natural[k], Math.round((d - from) * dpr), from0(d)) === 0;
      };
      const ds = [];
      for (let d = from; d <= to; d += step) ds.push(d);
      for (let d = to - step; d >= from; d -= step) ds.push(d);
      let i = 0;
      for (const d of ds) {
        const sc = els().sc;
        sc.scrollLeft = start + d;
        const between = band.map(([a, z]) => compose(a, z));
        await frame(); await frame();
        const settled = band.map(([a, z]) => compose(a, z));
        res.frames++;
        let bad = false;
        for (let k = 0; k < band.length; k++) {
          const okSettled = one(k, settled[k], d);
          // right after the scroll the names may not be handed over yet: the name at the clip's start (cut), or
          // the one at the edge from the frame before
          const okBetween = one(k, between[k], d) || diff(between[k], sticky[k], 0, from0(d)) === 0 || (d > 0 && Number.isInteger((d - from) * dpr) && diff(between[k], natural[k], Math.round((d - from) * dpr), 0) === 0);
          if (!okSettled) res.settledBad++;
          if (!okBetween) res.betweenBad++;
          if (!okSettled || !okBetween) bad = true;
        }
        if (bad) { res.overlap++; res.examples.length < 6 && res.examples.push(d); }
        if (++i % 8 === 0) {
          // the whole view, against a full redraw of the base canvas at this scroll position
          const all = [0, els().ov.height], before = compose(...all);
          els().base.dispatchEvent(new Event("contextrestored"));
          await frame(); await frame(); await frame();
          const after = compose(...all);
          res.full++;
          const n = diff(before, after);
          if (n !== 0) {
            // where: the box round the pixels that differ (device pixels of the view)
            let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
            for (let y = 0; y < before.h; y++) for (let x = 0; x < before.w; x++) { const j = (y * before.w + x) * 4; if (Math.max(...[0, 1, 2].map((c) => Math.abs(before.px[j + c] - after.px[j + c]))) > TOL) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
            res.fullBad++; res.examples.length < 6 && res.examples.push(`full@${d}:${n}px in ${x0},${y0}..${x1},${y1}`);
          }
        }
      }
      return res;
    },
    // the wheel check: its reference (the music rows with one name at the edge), then 60 px before the clips' start;
    // after each notch, where the view is and, with the clips' start off screen, how far each row is from that
    async wheelStart(start) {
      await scrollTo(start + 400);
      const band = rows();
      this.wheelRef = { start, band, sticky: band.map(([a, z]) => compose(a, z)) };
      await scrollTo(start - 60);
      await settle();
    },
    wheelNow() {
      const { start, band, sticky } = this.wheelRef, d = els().sc.scrollLeft - start;
      return { d, bad: d > 0 ? band.map(([a, z], k) => diff(compose(a, z), sticky[k], 0, from0(d))) : [] };
    },
  };
};

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const runCase = async (browser, name, renderer, dpr) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "localhost" || u.pathname.startsWith("/media/")) return route.fulfill({ status: 404, body: "" });
    let f = path.join(renderer, decodeURIComponent(u.pathname));
    if (!f.startsWith(renderer) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(renderer, "index.html");
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", body: fs.readFileSync(f) });
  });
  await page.addInitScript(fakeMain, { project });
  await page.addInitScript(probes);
  await page.goto(`http://localhost:5199/app/editor/${PID}`);
  await page.waitForSelector("[data-timeline-scroll] canvas[data-timeline-canvas-layer=base]", { timeout: 90000 }).catch(async (e) => {
    await page.screenshot({ path: path.join(OUT, `${name}-x${dpr}-no-editor.png`) });
    throw new Error(`${name} x${dpr}: the editor didn't open (${e.message.split("\n")[0]}); page errors: ${errors.join("; ") || "none"}`);
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__cbProbe.zoom(1.2));
  await page.waitForTimeout(1000);
  const pps = await page.evaluate(() => window.__cbProbe.pps());
  if (pps !== 60) throw new Error(`zoom: ${pps} px/s`);
  const out = { name, dpr, still: {}, sweep: {}, wheel: {}, errors };
  // still: screenshots of the view's left part, the music rows against the ones with the clips' start far off screen
  for (const at of [4, 70]) {
    const start = at * pps, shots = {};
    for (const d of [400, 20, 53, 90]) {
      await page.evaluate((s) => window.__cbProbe.scrollTo(s), start + d);
      const v = await page.evaluate(() => window.__cbProbe.view());
      const file = path.join(OUT, `${name}-x${dpr}-${at}s-${d}px.png`);
      await page.screenshot({ path: file, clip: { x: v.left, y: v.music.top, width: 320, height: v.music.bottom - v.music.top } });
      shots[d] = file;
    }
    out.still[at] = shots;
  }
  for (const at of [4, 70]) out.sweep[at] = await page.evaluate((s) => window.__cbProbe.sweep(s), at * pps);
  // wheel: real wheel notches (sideways) with the pointer on the SFX row (its clips light up under the pointer, the
  // music rows don't), right then left, each settled music row against the edge's name
  for (const at of [4, 70]) {
    await page.evaluate((s) => window.__cbProbe.wheelStart(s), at * pps);
    const v = await page.evaluate(() => window.__cbProbe.view());
    await page.mouse.move(v.left + v.width / 2, v.sfx);
    const res = { notches: 0, stuckAndWrong: 0, examples: [] };
    for (const dir of [1, -1]) for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(dir * 25, 0);
      await page.waitForTimeout(80);
      // with the clips' start off screen the name is stuck at the edge: the same pixels as the reference
      const { d, bad } = await page.evaluate(() => window.__cbProbe.wheelNow());
      res.notches++;
      if (bad.some((x) => x !== 0)) { res.stuckAndWrong++; res.examples.length < 6 && res.examples.push(`${Math.round(d)}:${bad.join("/")}px`); }
    }
    out.wheel[at] = res;
  }
  await context.close();
  return out;
};

// compare a screenshot's music rows with the reference's (PNG decoded in a page)
const compareShots = async (browser, files) => {
  const page = await browser.newPage();
  const load = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");
  const res = await page.evaluate(async ([ref, others]) => {
    const read = async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height); };
    const r = await read(ref), out = [];
    for (const o of others) {
      const d = await read(o);
      let bad = 0;
      for (let i = 0; i < r.data.length; i += 4) if (Math.abs(r.data[i] - d.data[i]) > 16 || Math.abs(r.data[i + 1] - d.data[i + 1]) > 16 || Math.abs(r.data[i + 2] - d.data[i + 2]) > 16) bad++;
      out.push(bad);
    }
    return out;
  }, [load(files[400]), [20, 53, 90].map((d) => load(files[d]))]);
  await page.close();
  return Object.fromEntries([20, 53, 90].map((d, i) => [d, res[i]]));
};

(async () => {
  const dirs = builds();
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const results = [];
  try {
    for (const dpr of [1.25, 1, 2]) for (const [name, dir] of Object.entries(dirs)) results.push(await runCase(browser, name, dir, dpr));
    for (const r of results) for (const at of Object.keys(r.still)) r.still[at] = await compareShots(browser, r.still[at]);
  } finally { await browser.close(); }
  let failed = false;
  for (const r of results) {
    const still = Object.entries(r.still).map(([at, x]) => `${at} s: ${Object.entries(x).map(([d, n]) => `${d} px ${n}`).join(", ")}`).join("; ");
    const sweep = Object.entries(r.sweep).map(([at, x]) => `${at} s: ${x.overlap}/${x.frames} frames wrong (settled ${x.settledBad}, between ${x.betweenBad}), full redraw differs ${x.fullBad}/${x.full}${x.examples.length ? " e.g. at " + x.examples.join(" ") : ""}`).join("; ");
    const wheel = Object.entries(r.wheel).map(([at, x]) => `${at} s: ${x.stuckAndWrong}/${x.notches} notches wrong${x.examples.length ? " e.g. at " + x.examples.join(" ") : ""}`).join("; ");
    console.log(`${r.name.padEnd(8)} x${r.dpr} | still (pixels unlike the one-name row): ${still}\n${" ".repeat(14)}sweep: ${sweep}\n${" ".repeat(14)}wheel: ${wheel}${r.errors.length ? "\n  errors: " + r.errors.join("; ") : ""}`);
    if (r.errors.length) failed = true;
    const stillBad = Object.values(r.still).some((x) => Object.values(x).some((n) => n > 0));
    const sweepBad = Object.values(r.sweep).some((x) => x.overlap > 0 || x.fullBad > 0);
    const wheelBad = Object.values(r.wheel).some((x) => x.stuckAndWrong > 0);
    if (r.name === "patched" && (stillBad || sweepBad || wheelBad)) { failed = true; console.log(`  FAIL: the patched build drew a name twice (or not as a full redraw does) at x${r.dpr}`); }
    // pristine 1.4.0 overlaps in the still cases (each of them) and in the sweep: else this test tests nothing
    if (r.name === "pristine" && !(Object.values(r.still).every((x) => Object.values(x).every((n) => n > 0)) && Object.values(r.sweep).every((x) => x.settledBad > 0))) { failed = true; console.log(`  FAIL: pristine 1.4.0 didn't overlap at x${r.dpr}: the test no longer shows the bug`); }
  }
  console.log(failed ? "FAIL" : "PASS: pristine 1.4.0 draws the names twice; the patched build draws each once, by frame, by wheel and as a full redraw does");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
