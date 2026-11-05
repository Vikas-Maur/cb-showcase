// Regress 2026-11-05 (the laptop at 125%: "see the text overlapping in this timeline"): a clip's name drawn twice on
// the timeline, once at the clip's start (cut by the view's left edge) and again at that edge, overlapping, whenever
// the clip started less than its name's width off screen. Cardboard's own drawing (patch-renderer.js 22): its pristine
// 1.4.0 pages do it at every scale. Our patched pages show one name: the clip's own, cut by the edge, until it has
// wholly left the view, then the one at the edge.
//
// Cardboard's real editor pages in headless Chromium, a fake main answering window.desktop (as stage-hover.js), one
// project: two music tracks whose clips start together (at 4 s and again at 70 s, the second pair where the tracks'
// base canvas no longer starts at 0), a track of 2 s sound effects, and above them a track with one clip (2 to 12 s)
// that has opacity keyframes, empty after it. At 60 px/s. A music row is "right" when it shows one name: the same pixels as the row with the name at
// its clip's start (40 px before the clips' start, moved by the scroll) while that name is in view, else the same
// pixels as the row with the name at the edge (the clips' start 400 px off screen). Pixels count as different 16 levels
// apart in a channel (the clips' gradient is dithered by where it lands on the canvas; a name's letters are some 150
// levels off the clip's colour); a clip's own rounded edge isn't compared; a step's scroll must move the row by whole
// device pixels for the name at the clip's start to be compared (steps of 4 px).
// At device pixel ratios 1, 1.25 and 2, for each build:
// - still: screenshots (Chromium's own compositing) with the music clips starting 20, 52, 88 and 140 px left of the
//   view. Pristine is expected to show two names (unlike both rows), patched one.
// - sweep: 4 px a step from 40 px before the clips' start to 300 px past it and back, near the start and near 70 s,
//   each step checked once the editor has drawn; every 8th step the whole view against a full redraw of the base canvas
//   at the same place (patch-renderer 11's contextrestored redraw).
// - frames: the same, the scroll moved inside an animation frame as Cardboard's wheel does, and every painted frame
//   read after it (a task after the frame). Only the first frame of a run can be painted before the editor redraws
//   the names (no scroll event pending yet); it is counted, and must be one name or none, never two.
// - wheel: real sideways wheel notches, 20 each way, with the pointer on the empty end of the keyframes' track (no
//   music clip lit under it), every painted frame from a notch's first until 8 frames without a scroll read the same
//   way and classed by where the letters are (a notch's positions aren't whole device pixels): the name at the clip's
//   start (no letters past its end), the name at the edge (its exact pixels), none, or two. No frame may be none or
//   two (a notch's first frame is drawn with the names of where the view is: patch 22's wheel update).
// At 1.25, against pristine, pixel for pixel (Cardboard's own drawing must be untouched there):
// - a marquee from the keyframes' track's empty end, and a keyframe moved in its lane (dragged 30 px and back), with
//   the clips' start 52 px (the name at the clip's
//   start, cut) and 200 px (no name: Cardboard clears the edge names during a drag) off screen;
// - a cold jump: after a still redraw, the view jumps from 40 px before the clips' start to 200 px past it, in a task
//   (the next frame must show the edge name) and inside an animation frame (that frame as pristine's, then the edge
//   name);
// - export: while Cardboard's export suspends the timeline (its canvases emptied), the page holds no canvas pixels of
//   ours (canvases made: as many as pristine), and the names come back after it.
// It exits 1 if the patched build fails any of these, or if pristine 1.4.0 doesn't show two names in the still cases
// and the sweeps (then this test no longer tests the fix).
//
// Usage: CARDBOARD_PRISTINE=<_inspect/cardboard-1.4.0> [PLAYWRIGHT=<path to playwright>] [CHROME=<chromium binary>]
//        node scripts/carton/test/browser/timeline-labels.js [out dir]
// Takes about half an hour on a busy 4-core box (it stages the Windows build first). Screenshots go to the out dir.
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
  for (const hook of ["__cbNameEnd=(g,n,cache)=>", "__cbEdgeNames=(c,list,sl,g,cache)=>", "entries:Q.canvas.__cbNat=me?", "const Qe=__cbEdgeNames(I.current,v1(", "Q.__cbSync=()=>", "__k||Ie(R.current)", "Je.__cbSync()"])
    if (editor.split(hook).length !== 2) throw new Error(`the patched editor should have ${hook} once`);
  return { pristine: expose(shipped), patched: expose(patched) };
};

const PID = "11111111-2222-4333-8444-555555555555", now = "2026-11-05T10:00:00.000Z";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001", A2 = "aaaaaaaa-0000-4000-8000-000000000002", A3 = "aaaaaaaa-0000-4000-8000-000000000003";
const SFX = "bbbbbbbb-0000-4000-8000-000000000000", M1 = "bbbbbbbb-0000-4000-8000-000000000001", M2 = "bbbbbbbb-0000-4000-8000-000000000002";
const FADE = "bbbbbbbb-0000-4000-8000-000000000003";
const audio = (id, fileName) => ({ id, createdAt: now, addedAt: now, data: { type: "audio", src: "cardboard-media://media/" + id, fileName, format: "mp3", size: 1000, duration: 600, metadataStatus: "complete" } });
let n = 0;
const clip = (trackId, mediaItemId, name, start, end, more = {}) => ({ id: `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, "0")}`, trackId, type: "audio", startTime: start, endTime: end, trimStart: 0, trimEnd: end - start, mediaItemId, name, volume: 1, ...more });
const project = {
  id: PID, name: "Labels", createdAt: now, updatedAt: now, stateUpdatedAt: 1793900000000, aspectRatio: "16:9",
  media: [audio(A1, "Arctic Reverie (light score).mp3"), audio(A2, "Old Cinema (light score).mp3"), audio(A3, "Whoosh.mp3")],
  // (the timeline shows about 170 px of tracks: the keyframes' track with its lane open, then the music rows)
  tracks: [
    { id: FADE, name: "Fade", order: 0, locked: false, visible: true, muted: false, type: "audio" },
    { id: M1, name: "Music 1", order: 1, locked: false, visible: true, muted: false, type: "audio" },
    { id: M2, name: "Music 2", order: 2, locked: false, visible: true, muted: false, type: "audio" },
    { id: SFX, name: "SFX", order: 3, locked: false, visible: true, muted: false, type: "audio" },
  ],
  timelineItems: [
    ...Array.from({ length: 60 }, (_, i) => clip(SFX, A3, `Whoosh ${String(i + 1).padStart(2, "0")}`, i * 2.2, i * 2.2 + 2)),
    clip(M1, A1, "Arctic Reverie (light score)", 4, 40), clip(M2, A2, "Old Cinema (light score)", 4, 40),
    clip(M1, A1, "Northern Lights (light score)", 70, 130), clip(M2, A2, "Harbour Fog (light score)", 70, 130),
    // its keyframe at 10 s (2 s + 8 s) is what the keyframe case drags
    clip(FADE, A3, "Room tone", 2, 12, { keyframeTracks: [{ property: "opacity", keyframes: [{ time: 1, value: 1 }, { time: 8, value: 0.3 }] }] }),
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
  // every canvas the page makes, for the export case
  const make = Document.prototype.createElement;
  window.__cbCanvases = 0;
  Document.prototype.createElement = function (tag, ...rest) { /^canvas$/i.test(tag) && window.__cbCanvases++; return make.call(this, tag, ...rest); };
};

// In the page: the timeline's canvases composed as shown, and the probes.
const probes = () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // after the next frame has been drawn: a task queued from inside it runs after its other callbacks and its paint
  const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const els = () => ({ sc: document.querySelector("[data-timeline-scroll]"), base: document.querySelector("canvas[data-timeline-canvas-layer=base]"), ov: document.querySelector("canvas[data-timeline-canvas-layer=titles]") });
  // rows [y0, y1) in device pixels of the tracks surface, as the view shows them: the base canvas under the names
  const compose = (y0, y1) => {
    const { sc, base, ov } = els(), dpr = devicePixelRatio, w = ov.width, h = y1 - y0;
    const offsetX = parseFloat(/translate3d\((-?[\d.]+)px/.exec(base.style.transform)[1]);
    const sx = Math.round((sc.scrollLeft - offsetX) * dpr);
    const b = base.getContext("2d").getImageData(sx, y0, w, h).data, o = ov.getContext("2d").getImageData(0, y0, w, h).data, out = new Uint8ClampedArray(b.length);
    for (let i = 0; i < b.length; i += 4) { const a = o[i + 3] / 255; for (let c = 0; c < 3; c++) out[i + c] = Math.round(o[i + c] * a + b[i + c] * (1 - a)); out[i + 3] = 255; }
    return { w, h, px: out };
  };
  const TOL = 16;
  // how many pixels differ by more than TOL in a channel; b moved left by dx device pixels first (columns from x0 on)
  const diff = (a, b, dx = 0, x0 = 0) => {
    let bad = 0;
    for (let y = 0; y < a.h; y++) for (let x = x0; x < a.w; x++) {
      const bx = x + dx; if (bx < 0 || bx >= b.w) continue;
      const i = (y * a.w + x) * 4, j = (y * b.w + bx) * 4;
      if (Math.abs(a.px[i] - b.px[j]) > TOL || Math.abs(a.px[i + 1] - b.px[j + 1]) > TOL || Math.abs(a.px[i + 2] - b.px[j + 2]) > TOL) bad++;
    }
    return bad;
  };
  // the columns to compare at d px past the clips' start: from 7 px into the clip (its rounded edge left out)
  const from0 = (d) => Math.max(0, Math.ceil((Math.max(0, -d) + 7) * devicePixelRatio));
  // the first and last column with letters (a name is near white on the clips' dark green), or null
  const ink = (img) => {
    let lo = -1, hi = -1;
    for (let x = 0; x < img.w; x++) for (let y = 0; y < img.h; y++) if (img.px[(y * img.w + x) * 4] > 110) { lo < 0 && (lo = x); hi = x; break; }
    return lo < 0 ? null : [lo, hi];
  };
  const hash = (img) => { let h = 2166136261; for (let i = 0; i < img.px.length; i += 4) for (let c = 0; c < 3; c++) h = Math.imul(h ^ (img.px[i + c] >> 4), 16777619); return h >>> 0; };
  const scrollTo = async (s) => { els().sc.scrollLeft = s; await frame(); await frame(); await frame(); };
  // Cardboard puts off loading thumbnails and waveforms while the view scrolls (180 ms, 1 s after it stops) and redraws
  // when they come: let that happen first, so that only the names change from one step to the next
  const settle = () => new Promise((r) => setTimeout(r, 1500));
  const stillRedraw = async () => { els().base.dispatchEvent(new Event("contextrestored")); await frame(); await frame(); await frame(); };
  const trackRect = (id) => document.querySelector(`[data-timeline-scroll] [data-track-id="${id}"]`).getBoundingClientRect();
  // each music track's name row (device rows of the surface): where the fixed canvas has letters with the names stuck
  const rows = () => {
    const { ov, base } = els(), dpr = devicePixelRatio, top = base.getBoundingClientRect().top, w = Math.min(ov.width, Math.round(300 * dpr)), d = ov.getContext("2d").getImageData(0, 0, w, ov.height).data;
    return ["bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"].map((id) => {
      const t = trackRect(id), a = Math.floor((t.top - top) * dpr), z = Math.ceil((t.bottom - top) * dpr);
      let lo = Infinity, hi = -1;
      for (let y = a; y < z; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
      if (hi < 0) throw new Error("no name drawn at the view's edge on " + id);
      return [lo - 3, hi + 4];
    });
  };
  const P = window.__cbProbe = {
    pps: () => window.__cbTestStore().pixelsPerSecond,
    zoom: (z) => window.__cbTestStore().setZoomLevel(z),
    scrollTo, settle, stillRedraw,
    view: () => {
      const r = els().sc.getBoundingClientRect(), m1 = trackRect("bbbbbbbb-0000-4000-8000-000000000001"), m2 = trackRect("bbbbbbbb-0000-4000-8000-000000000002"), fade = trackRect("bbbbbbbb-0000-4000-8000-000000000003");
      // the keyframes' track: its row (40 px) and, under it when open, its lane (28 px)
      return { left: r.left, width: r.width, scrollLeft: els().sc.scrollLeft, music: { top: m1.top, bottom: m2.bottom }, fadeRow: fade.top + 20, fadeBottom: fade.bottom };
    },
    // the references for the music clips starting at `start` px: the rows with the names at the edge and at their
    // clips' starts, and where each name at its clip's start ends (content px)
    async refs(start, from = -40) {
      await scrollTo(start + 400);
      const band = rows(), pinned = band.map(([a, z]) => compose(a, z));
      await scrollTo(start + from);
      await settle();
      await stillRedraw();
      const natural = band.map(([a, z]) => compose(a, z));
      const natEnd = natural.map((img) => start + from + (ink(img)[1] + 1) / devicePixelRatio);
      this.ref = { start, from, band, pinned, natural, natEnd };
      return { natEnd };
    },
    // what a music row must show at scroll position s: the name at its clip's start while it is in view, then the one
    // at the edge; within 3 px of the switch either
    expect(k, s) { const left = this.ref.natEnd[k] - s; return left > 3 ? "natural" : left < -3 ? "pinned" : "either"; },
    // exact check of a row (s: whole device pixels from the reference)
    exact(k, img, s) {
      const { start, from, pinned, natural } = this.ref, d = s - start, dpr = devicePixelRatio, e = this.expect(k, s);
      const nat = () => Number.isInteger(Math.round((d - from) * dpr * 1000) / 1000) && diff(img, natural[k], Math.round((d - from) * dpr), from0(d)) === 0;
      const pin = () => diff(img, pinned[k], 0, from0(d)) === 0;
      return e === "natural" ? nat() : e === "pinned" ? pin() : nat() || pin();
    },
    // a row classed by its letters (any scroll position): "natural" (none past the name at its clip's start), "pinned"
    // (the edge name's exact pixels), "none", or "two"
    classify(k, img, s) {
      const { start, pinned, natEnd } = this.ref, d = s - start, dpr = devicePixelRatio, e = this.expect(k, s), at = ink(img);
      if (!at) return "none";
      const natOk = at[1] <= (natEnd[k] - s) * dpr + 3, pinOk = diff(img, pinned[k], 0, from0(d)) === 0;
      if (e === "natural") return natOk ? "natural" : "two";
      if (e === "pinned") return pinOk ? "pinned" : "two";
      return pinOk ? "pinned" : natOk ? "natural" : "two";
    },
    rowsNow() { return this.ref.band.map(([a, z]) => compose(a, z)); },
    // steps of 4 px, each checked once the editor has drawn; every 8th the whole view against a full redraw
    async sweep(start, { step = 4, from = -40, to = 300 } = {}) {
      await this.refs(start, from);
      const ds = [];
      for (let d = from; d <= to; d += step) ds.push(d);
      for (let d = to - step; d >= from; d -= step) ds.push(d);
      const res = { steps: 0, bad: 0, full: 0, fullBad: 0, examples: [] };
      let i = 0;
      for (const d of ds) {
        await scrollTo(start + d);
        const s = els().sc.scrollLeft, rowsNow = this.rowsNow();
        res.steps++;
        if (rowsNow.some((img, k) => !this.exact(k, img, s))) { res.bad++; res.examples.length < 6 && res.examples.push(d); }
        if (++i % 8 === 0) {
          const all = [0, els().ov.height], before = compose(...all);
          await stillRedraw();
          const n = diff(before, compose(...all));
          res.full++;
          if (n) { res.fullBad++; res.examples.length < 6 && res.examples.push(`full@${d}:${n}px`); }
        }
      }
      return res;
    },
    // the scroll moved inside an animation frame (as Cardboard's wheel does), every painted frame read after it
    async frames(start, { step = 4, from = -40, to = 300 } = {}) {
      await this.refs(start, from);
      const res = { frames: 0, bad: 0, first: [], examples: [] };
      for (const [a, z, dir] of [[from, to, 1], [to, from, -1]]) {
        await scrollTo(start + a);
        await settle();
        for (let d = a + dir * step, first = true; dir > 0 ? d <= z : d >= z; d += dir * step, first = false) {
          await new Promise((r) => requestAnimationFrame(() => { els().sc.scrollLeft = start + d; setTimeout(r, 0); }));
          const s = els().sc.scrollLeft, now = this.rowsNow();
          res.frames++;
          if (first) { res.first.push(now.map((img, k) => this.classify(k, img, s)).join("/")); continue; }
          if (now.some((img, k) => !this.exact(k, img, s))) { res.bad++; res.examples.length < 6 && res.examples.push(d); }
        }
      }
      return res;
    },
    // every painted frame while the test gives real input, classed: from the first that moved (waiting up to 2 s for
    // it) until `quiet` frames without a scroll
    async record(quiet = 8) {
      const out = [], t0 = performance.now();
      let last = els().sc.scrollLeft, still = 0;
      while (out.length ? still < quiet : performance.now() - t0 < 2000) {
        await painted();
        const s = els().sc.scrollLeft;
        still = s === last ? still + 1 : 0;
        if (s !== last || out.length) out.push({ d: s - this.ref.start, moved: s - last, cls: this.rowsNow().map((img, k) => this.classify(k, img, s)) });
        last = s;
      }
      return out;
    },
    // the music rows (and the overlay's emptiness) now, as hashes for comparing two builds
    snapshot() { const r = this.rowsNow(); const { ov } = els(); return { rows: r.map(hash), overlayBlank: !ov.getContext("2d").getImageData(0, 0, ov.width, ov.height).data.some((x, i) => i % 4 === 3 && x), exact: r.map((img, k) => this.exact(k, img, els().sc.scrollLeft)), feedback: window.__cbTestStore().timelineInteractionFeedback?.message ?? null }; },
    // a jump from `from` to `to` px past the clips' start, after a still redraw: in a task, or inside a frame
    async jump(to, inFrame) {
      const { start, from } = this.ref;
      await scrollTo(start + from); await settle(); await stillRedraw();
      if (inFrame) await new Promise((r) => requestAnimationFrame(() => { els().sc.scrollLeft = start + to; r(); }));
      else els().sc.scrollLeft = start + to;
      const out = [];
      for (let i = 0; i < 3; i++) { if (!(inFrame && i === 0)) await painted(); else await new Promise((r) => setTimeout(r, 0)); const s = els().sc.scrollLeft; out.push(this.rowsNow().map((img, k) => this.classify(k, img, s)).join("/")); }
      return out;
    },
    // export: the timeline suspended (Cardboard empties its canvases), what the page holds then, and the names after
    async exportCase() {
      const st = () => window.__cbTestStore(), made = window.__cbCanvases;
      st().setExportState(!0, 0, !1);
      await frame(); await frame(); await frame();
      const { base, ov } = els(), during = { base: base.width * base.height, titles: ov.width * ov.height, made: window.__cbCanvases - made };
      st().setExportState(!1);
      await frame(); await frame(); await frame(); await frame();
      const s = els().sc.scrollLeft;
      return { during, after: this.rowsNow().map((img, k) => this.exact(k, img, s)) };
    },
    canvases: () => window.__cbCanvases,
  };
};

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const open = async (browser, name, renderer, dpr) => {
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
  return { context, page, errors, pps };
};

// still, sweep, frames and wheel at one scale
const runCase = async (browser, name, renderer, dpr) => {
  const { context, page, errors, pps } = await open(browser, name, renderer, dpr);
  const out = { name, dpr, still: {}, sweep: {}, frames: {}, wheel: {}, errors };
  for (const at of [4, 70]) {
    const start = at * pps, shots = {};
    for (const d of [-40, 400, 20, 52, 88, 140]) {
      await page.evaluate((s) => window.__cbProbe.scrollTo(s), start + d);
      const v = await page.evaluate(() => window.__cbProbe.view());
      const file = path.join(OUT, `${name}-x${dpr}-${at}s-${d}px.png`);
      await page.screenshot({ path: file, clip: { x: v.left, y: v.music.top, width: 320, height: v.music.bottom - v.music.top } });
      shots[d] = file;
    }
    out.still[at] = shots;
  }
  for (const at of [4, 70]) out.sweep[at] = await page.evaluate((s) => window.__cbProbe.sweep(s), at * pps);
  for (const at of [4, 70]) out.frames[at] = await page.evaluate((s) => window.__cbProbe.frames(s), at * pps);
  // wheel: real sideways notches with the pointer on the keyframes' track's empty end (600 px into the view, past its
  // clip), from 60 px before the clips' start, 20 notches right then 20 left, every painted frame recorded
  for (const at of [4, 70]) {
    await page.evaluate((s) => window.__cbProbe.refs(s, -60), at * pps);
    const v = await page.evaluate(() => window.__cbProbe.view());
    await page.mouse.move(v.left + 600, v.fadeRow);
    const frames = [];
    for (const dir of [1, -1]) for (let i = 0; i < 20; i++) {
      const rec = page.evaluate(() => window.__cbProbe.record());
      await page.mouse.wheel(dir * 25, 0);
      frames.push(...(await rec).map((f, j) => ({ ...f, first: j === 0 })));
    }
    const odd = frames.filter((f) => f.cls.some((c) => c === "none" || c === "two"));
    out.wheel[at] = { frames: frames.length, odd: odd.length, oddNotFirst: odd.filter((f) => !f.first).length, examples: odd.slice(0, 6).map((f) => `${Math.round(f.d)}${f.first ? "(first)" : ""}:${f.cls.join("/")}`) };
  }
  await context.close();
  return out;
};

// marquee, keyframe drag, cold jump and export at 1.25: what the page shows, for comparing with pristine
const runInteractions = async (browser, name, renderer) => {
  const { context, page, errors, pps } = await open(browser, name, renderer, 1.25);
  const start = 4 * pps, out = { name, errors };
  // a marquee from the keyframes' track's empty end, then a keyframe moved in its lane, with the clips' start 52 and
  // 200 px off screen (the lane open, which moves the music rows down: the references taken again)
  await page.evaluate(() => window.__cbTestStore().toggleKeyframeLanes("bbbbbbbb-0000-4000-8000-000000000003"));
  await page.waitForTimeout(800);
  await page.evaluate((s) => window.__cbProbe.refs(s), start);
  for (const d of [52, 200]) {
    await page.evaluate((s) => window.__cbProbe.scrollTo(s), start + d);
    await page.waitForTimeout(1600);
    let v = await page.evaluate(() => window.__cbProbe.view());
    await page.mouse.move(v.left + 600, v.fadeRow);
    await page.mouse.down();
    await page.mouse.move(v.left + 700, v.fadeRow + 4, { steps: 6 });
    await page.waitForTimeout(300);
    out[`marquee${d}`] = await page.evaluate(() => window.__cbProbe.snapshot());
    await page.mouse.up();
    await page.waitForTimeout(500);
    // the keyframe at 10 s, in the lane under the Fade track's clip (a lane is 28 px, its keyframes on its middle),
    // dragged 30 px and back before the release, so that it stays where it was
    v = await page.evaluate(() => window.__cbProbe.view());
    const kx = v.left + 10 * pps - v.scrollLeft, ky = v.fadeBottom - 14;
    await page.mouse.move(kx, ky);
    await page.mouse.down();
    await page.mouse.move(kx + 30, ky, { steps: 6 });
    await page.waitForTimeout(300);
    out[`keyframe${d}`] = await page.evaluate(() => window.__cbProbe.snapshot());
    await page.mouse.move(kx, ky, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await page.mouse.move(5, 5);
  await page.evaluate(() => window.__cbTestStore().toggleKeyframeLanes("bbbbbbbb-0000-4000-8000-000000000003"));
  await page.waitForTimeout(800);
  await page.evaluate((s) => window.__cbProbe.refs(s), start);
  out.jumpTask = await page.evaluate(() => window.__cbProbe.jump(200, false));
  out.jumpFrame = await page.evaluate(() => window.__cbProbe.jump(200, true));
  await page.evaluate((s) => window.__cbProbe.scrollTo(s), start + 52);
  out.exportCase = await page.evaluate(() => window.__cbProbe.exportCase());
  out.canvases = await page.evaluate(() => window.__cbProbe.canvases());
  await context.close();
  return out;
};

// a screenshot's music rows against the references' (PNGs decoded in a page): pixels unlike the edge name's row and
// unlike the clip-start name's row moved by the scroll
const compareShots = async (browser, files, dpr) => {
  const page = await browser.newPage();
  const load = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");
  const res = await page.evaluate(async ([pin, nat, others, dpr]) => {
    const read = async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height); };
    const unlike = (a, b, dx) => { let bad = 0; for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) { const bx = x + dx; if (bx >= b.width) continue; const i = (y * a.width + x) * 4, j = (y * b.width + bx) * 4; if ([0, 1, 2].some((c) => Math.abs(a.data[i + c] - b.data[j + c]) > 16)) bad++; } return bad; };
    const p = await read(pin), n = await read(nat), out = [];
    for (const [d, src] of others) { const o = await read(src); out.push([d, unlike(o, p, 0), unlike(o, n, Math.round((d + 40) * dpr))]); }
    return out;
  }, [load(files[400]), load(files[-40]), [20, 52, 88, 140].map((d) => [d, load(files[d])]), dpr]);
  await page.close();
  return Object.fromEntries(res.map(([d, pin, nat]) => [d, { pin, nat }]));
};

(async () => {
  const dirs = builds();
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const results = [], inter = {};
  try {
    for (const dpr of [1.25, 1, 2]) for (const [name, dir] of Object.entries(dirs)) results.push(await runCase(browser, name, dir, dpr));
    for (const r of results) for (const at of Object.keys(r.still)) r.still[at] = await compareShots(browser, r.still[at], r.dpr);
    for (const [name, dir] of Object.entries(dirs)) inter[name] = await runInteractions(browser, name, dir);
  } finally { await browser.close(); }
  let failed = false;
  const fail = (why) => { failed = true; console.log("  FAIL: " + why); };
  // the name to expect in a still case: the clip-start one while it is in view (the music names end 124 and 108 px
  // past their clips' starts, so at 20, 52 and 88 px), the edge one after (140 px)
  for (const r of results) {
    const still = Object.entries(r.still).map(([at, x]) => `${at} s: ${Object.entries(x).map(([d, v]) => `${d} px ${v.nat}|${v.pin}`).join(", ")}`).join("; ");
    const sweep = Object.entries(r.sweep).map(([at, x]) => `${at} s: ${x.bad}/${x.steps} steps wrong, full redraw differs ${x.fullBad}/${x.full}${x.examples.length ? " e.g. at " + x.examples.join(" ") : ""}`).join("; ");
    const frames = Object.entries(r.frames).map(([at, x]) => `${at} s: ${x.bad}/${x.frames} frames wrong (first frames ${x.first.join(", ")})${x.examples.length ? " e.g. at " + x.examples.join(" ") : ""}`).join("; ");
    const wheel = Object.entries(r.wheel).map(([at, x]) => `${at} s: ${x.odd}/${x.frames} frames with no name or two (${x.oddNotFirst} not a notch's first)${x.examples.length ? " e.g. " + x.examples.join(" ") : ""}`).join("; ");
    console.log(`${r.name.padEnd(8)} x${r.dpr} | still (pixels unlike clip-start|edge row): ${still}\n${" ".repeat(14)}sweep: ${sweep}\n${" ".repeat(14)}frames: ${frames}\n${" ".repeat(14)}wheel: ${wheel}${r.errors.length ? "\n  errors: " + r.errors.join("; ") : ""}`);
    if (r.errors.length) fail(`page errors at x${r.dpr}`);
    if (r.name === "patched") {
      for (const x of Object.values(r.still)) for (const [d, v] of Object.entries(x)) if ((+d < 120 ? v.nat : v.pin) !== 0) fail(`still ${d} px isn't one name at x${r.dpr}`);
      if (Object.values(r.sweep).some((x) => x.bad || x.fullBad)) fail(`sweep at x${r.dpr}`);
      if (Object.values(r.frames).some((x) => x.bad || x.first.some((f) => f.includes("two")))) fail(`painted frames at x${r.dpr}`);
      if (Object.values(r.wheel).some((x) => x.odd)) fail(`wheel frames at x${r.dpr}`);
    } else if (!(Object.values(r.still).every((x) => [20, 52, 88].every((d) => x[d].nat > 0 && x[d].pin > 0)) && Object.values(r.sweep).every((x) => x.bad > 0))) fail(`pristine 1.4.0 didn't show two names at x${r.dpr}: the test no longer shows the bug`);
  }
  const [P0, P1] = [inter.pristine, inter.patched];
  for (const k of ["marquee52", "marquee200", "keyframe52", "keyframe200"]) {
    const a = P0[k], b = P1[k], same = a.rows.join() === b.rows.join() && a.overlayBlank === b.overlayBlank;
    console.log(`${k}: pristine ${a.feedback} rows ${a.rows.join(",")} blank names canvas ${a.overlayBlank} | patched ${b.feedback} rows ${b.rows.join(",")} blank ${b.overlayBlank}${same ? " (same)" : " DIFFERENT"}`);
    if (!same) fail(`${k}: the patched build draws otherwise than Cardboard during the drag`);
    if (!/Selecting|keyframe/i.test(b.feedback ?? "")) fail(`${k}: no ${k.startsWith("marquee") ? "marquee" : "keyframe move"} under way (${b.feedback})`);
  }
  console.log(`cold jump in a task: pristine ${P0.jumpTask.join(" > ")} | patched ${P1.jumpTask.join(" > ")}`);
  console.log(`cold jump inside a frame: pristine ${P0.jumpFrame.join(" > ")} | patched ${P1.jumpFrame.join(" > ")}`);
  if (P1.jumpTask.some((f) => f !== "pinned/pinned")) fail("cold jump in a task: the edge names didn't show at once");
  if (P1.jumpFrame[0] !== P0.jumpFrame[0] || P1.jumpFrame.slice(1).some((f) => f !== "pinned/pinned")) fail("cold jump inside a frame: not as Cardboard's first frame, then the edge names");
  const ex0 = P0.exportCase, ex1 = P1.exportCase;
  console.log(`export: pristine during ${JSON.stringify(ex0.during)} after ${ex0.after.join("/")}, canvases made ${P0.canvases} | patched during ${JSON.stringify(ex1.during)} after ${ex1.after.join("/")}, canvases made ${P1.canvases}`);
  if (ex1.during.base || ex1.during.titles || ex1.during.made !== ex0.during.made || P1.canvases !== P0.canvases || ex1.after.some((x) => !x)) fail("export: canvases kept or made, or the names didn't come back");
  for (const [k, x] of Object.entries(inter)) if (x.errors.length) fail(`${k}: page errors ${x.errors.join("; ")}`);
  console.log(failed ? "FAIL" : "PASS: pristine 1.4.0 draws the names twice; the patched build shows one name in every case, and draws as Cardboard does during drags, jumps and export");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
