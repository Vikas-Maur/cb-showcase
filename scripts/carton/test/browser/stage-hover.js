// Regress 2026-11-02 N-2 ("with Carton on, the paused preview stays black after deselecting a title"): Cardboard's
// patched pages in headless Chromium, Carton on, Carton off and a build without Carton, on the same steps. A fake main
// answers window.desktop's requests (the editor's boot, one project, Carton's "enabled", and its History view model
// from @carton/react's mock, so the stage's Carton layer is live).
//
// The project: a picture (colour bars) 0-3 s on "Mine", titles W1-W6 on "Agents", W5 at 4-5 s. Paused at 1 s, the
// pointer moves onto W5 on the timeline and clicks it, then Esc (or Delete), then the pointer leaves the timeline for
// the stage. After each step: the stage's mean luma (a screenshot of the preview canvas) and the editor store's times.
//
// What it showed (2026-11-02): the three builds agree at every step. The black stage is Cardboard's own hover preview:
// while the pointer is over the timeline, the stage shows the frame under the pointer (the store's currentTime is the
// hover time, 4.5 s, where there is no picture), selected or not, after Esc and after Delete; when the pointer leaves
// the timeline the stage shows the playhead's frame again. Pristine 1.4.0's renderer does the same.
// Carton on runs twice: once with its own saves echoed, once with each save announced as a newer head (as when Carton
// merged it), so the bridge fetches and adopts head (renderer-bridge.js receive) during the steps.
// It exits 1 if any build doesn't do what Cardboard does on these steps (W5 selected, hovered 4.5 s, nothing selected
// and W5 gone after Delete, the picture back once the pointer leaves), or if Carton on differs from Carton off or from
// the build without Carton at any step.
//
// Usage: CARDBOARD_PRISTINE=<_inspect/cardboard-1.4.0> [PLAYWRIGHT=<path to playwright>] [CHROME=<chromium binary>]
//        node scripts/carton/test/browser/stage-hover.js [out dir]
// Needs the carton workspace installed (cd carton && npm ci) for carton-ui.js. Takes a few minutes.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { stage } = require("../stage");

const pristine = process.env.CARDBOARD_PRISTINE;
if (!pristine) throw new Error("CARDBOARD_PRISTINE must name Cardboard 1.4.0's unpacked app (app-asar/, cli/)");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const OUT = process.argv[2] || path.join(os.tmpdir(), "carton-stage-hover");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const CARTON = path.join(ROOT, "carton");
const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));

// The bundles: Carton's (on and off at run time) and one without Carton. The editor store is exposed to the test the
// way patch-carton.js hands it to the bridge; the build without Carton gets the same two handles at the same place.
const STORE_ANCHOR = "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});";
const builds = async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const withCarton = stage(pristine, path.join(OUT, "carton"), { carton: true });
  await require("../../build").build(path.join(OUT, "carton", "res"), withCarton.assets);
  const without = stage(pristine, path.join(OUT, "none"));
  const f = path.join(without.assets, "installErrorTelemetry-DxKId8tA.js"), src = fs.readFileSync(f, "utf8");
  if (src.split(STORE_ANCHOR).length !== 2) throw new Error("the editor store's anchor isn't there once");
  fs.writeFileSync(f, src.replace(STORE_ANCHOR, STORE_ANCHOR + "window.__cbTestStore=()=>ne.getState();window.__cbTestSeek=t=>ne.getState().setPlaybackPosition(t);"));
  return { carton: path.dirname(withCarton.assets), none: path.dirname(without.assets) };
};

// The worker's History view model, served in the page (@carton/react's mock, no conflicts).
const uiServer = () => esbuild.buildSync({
  stdin: { contents: 'import { serveUi } from "@carton/react"; import { createMockUi } from "@carton/react/mock"; globalThis.__cbTestUiServer = (send) => { const ui = createMockUi({ versions: 3 }); ui.setConflicts([]); return serveUi(ui, send); };', resolveDir: CARTON, loader: "ts" },
  bundle: true, format: "iife", write: false, absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")], logLevel: "warning",
}).outputFiles[0].text;

// 640x360 colour bars
const png = (() => {
  const w = 640, h = 360, rows = [], bars = [[200, 200, 200], [200, 200, 0], [0, 200, 200], [0, 200, 0], [200, 0, 200], [200, 0, 0], [0, 0, 200], [120, 120, 120]];
  for (let y = 0; y < h; y++) { const r = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { const c = bars[Math.floor(x / (w / 8))]; r.set(c, 1 + x * 3); } rows.push(r); }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
})();

const PID = "11111111-2222-4333-8444-555555555555", IMG = "aaaaaaaa-0000-4000-8000-000000000001", now = "2026-11-02T03:29:40.796Z";
const MINE = "bbbbbbbb-0000-4000-8000-000000000001", AGENTS = "cccccccc-0000-4000-8000-000000000002";
const titles = [[0.2, 0.8], [0.9, 1.4], [1.5, 2], [2.1, 2.9], [4, 5], [5.1, 5.9]].map(([s, e], i) => ({ n: i + 1, s, e }));
const project = {
  id: PID, name: "N2 Healthy", createdAt: now, updatedAt: now, stateUpdatedAt: 1793425009835, aspectRatio: "16:9",
  media: [
    { id: IMG, createdAt: now, addedAt: now, data: { type: "image", src: "cardboard-media://media/" + IMG, fileName: "bars.png", format: "png", size: png.length, width: 640, height: 360, thumbnailGenerationStatus: "complete", metadataStatus: "complete" } },
    ...titles.map((t) => ({ id: `dddddddd-0000-4000-8000-00000000000${t.n}`, createdAt: now, addedAt: now, data: { type: "text", presetId: "custom", content: "W" + t.n, fileName: "Text: W" + t.n, format: "text", size: 0 } })),
  ],
  tracks: [{ id: AGENTS, name: "Agents", order: 0, locked: false, visible: true, muted: false }, { id: MINE, name: "Mine", order: 1, locked: false, visible: true, muted: false }],
  timelineItems: [
    { id: "eeeeeeee-0000-4000-8000-000000000000", trackId: MINE, type: "image", startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, mediaItemId: IMG, name: "bars" },
    ...titles.map((t) => ({ id: `eeeeeeee-0000-4000-8000-00000000000${t.n}`, trackId: AGENTS, type: "text", startTime: t.s, endTime: t.e, trimStart: 0, trimEnd: +(t.e - t.s).toFixed(3), name: "W" + t.n, textContent: "W" + t.n, fontSize: 48, color: "#ffffff", mediaItemId: `dddddddd-0000-4000-8000-00000000000${t.n}`, transform: { x: -600 + t.n * 150, y: -300, scale: 1, rotation: 0 } })),
  ],
};

// main, in the page
const fakeMain = ({ project, carton, merge }) => {
  const events = new Set(), responses = new Set();
  let doc = JSON.parse(JSON.stringify(project));
  const later = (f) => setTimeout(f, 0);
  const emit = (channel, data) => later(() => { for (const f of events) f({ channel, data }); });
  const servers = {};
  const BOOT = {
    "update:status": { phase: "unsupported", fraction: null }, "update:recall-get": null, "library:status": { state: "ready" },
    "welcome:get": { seen: true, agentSetupPending: false }, "thanks:get": { channel: null },
    "account:get": { status: { signedIn: true, user: { id: "u1", email: "t@example.com", name: "Tester" }, apiBase: "http://localhost:5199" } },
    "access:get": { allowed: true, argonAgentEnabled: false, chatSkillsEnabled: false },
  };
  const handle = ({ channel, data }) => {
    if (channel === "library:call") {
      if (data.method === "projects.list") return [doc];
      if (data.method === "projects.read") return doc;
      if (data.method === "media.locate") return Object.fromEntries((data.args?.[0] ?? []).map((id) => [id, { nativePath: "/media/" + id + ".png", ownedByBundle: true }]));
      return null;
    }
    if (channel === "carton:call") {
      if (data.method === "enabled") return carton;
      if (data.method === "undoState") return { undo: false, redo: false };
      if (data.method === "ui") {
        const { client, message } = data.args[0];
        (servers[client] ??= window.__cbTestUiServer((m) => emit("carton:event", { client, message: m }))).receive(message);
      }
      return null;
    }
    if (channel in BOOT) return BOOT[channel];
    if (channel === "project:patch") {
      // the store's scoped write (the library worker's updateScoped): the document carries only what the scope owns
      const d = data.document, sc = data.scope ?? {}, removed = new Set(sc.removedMediaIds ?? []), owned = new Set(sc.ownedMediaIds ?? []);
      const theirs = new Map((d.media ?? []).filter((m) => !removed.has(m.id)).map((m) => [m.id, m]));
      const media = (doc.media ?? []).filter((m) => !removed.has(m.id)).map((m) => {
        const t = theirs.get(m.id), fields = sc.ownedMediaDataFields?.[m.id];
        return owned.has(m.id) && t ? t : fields && t ? { ...m, data: { ...m.data, ...Object.fromEntries(fields.filter((f) => f in t.data).map((f) => [f, t.data[f]])) } } : m;
      });
      for (const [id, m] of theirs) if (owned.has(id) && !media.some((x) => x.id === id)) media.push(m);
      doc = { ...doc, ...Object.fromEntries((sc.ownedFields ?? []).filter((f) => f in d).map((f) => [f, d[f]])), media, updatedAt: d.updatedAt ?? doc.updatedAt, stateUpdatedAt: Math.max(doc.stateUpdatedAt ?? 0, d.stateUpdatedAt ?? 0) };
      // merge: as when Carton merged the save into a head that had moved: head is written under a newer revision and
      // announced, so the page's bridge doesn't take it for its own save's echo and adopts it (receive's fetch, adopt)
      if (merge) doc = { ...doc, stateUpdatedAt: doc.stateUpdatedAt + 1 };
      window.__cbTestAnnounced = doc.stateUpdatedAt;
      emit("project:changed", { id: doc.id, stateUpdatedAt: doc.stateUpdatedAt, ...(carton ? { carton: true } : {}) });
      return { ok: true };
    }
    return null;
  };
  // cardboard-media:// is main's protocol: here the page's own origin serves it
  const fix = (u) => (typeof u === "string" && u.startsWith("cardboard-media://") ? "http://localhost:5199/" + u.slice("cardboard-media://".length) : u);
  for (const C of [HTMLImageElement, HTMLMediaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, "src");
    Object.defineProperty(C.prototype, "src", { configurable: true, get: d.get, set(v) { d.set.call(this, fix(v)); } });
  }
  const fetch0 = window.fetch;
  window.fetch = (u, o) => fetch0(fix(u), o);
  // the editor store's handles, as patch-carton.js gives them to the bridge (Carton on or off)
  let bridge;
  Object.defineProperty(window, "__carton", {
    configurable: true, get: () => bridge,
    set: (b) => { const own = b.store; b.store = function (s) { window.__cbTestStore = () => s.state(); window.__cbTestSeek = (t) => s.state().setPlaybackPosition(t); return own.call(this, s); }; bridge = b; },
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

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const runCase = async (browser, { name, renderer, carton, merge = false, key, ui }) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/media/")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (u.hostname !== "localhost") return route.fulfill({ status: 404, body: "" });
    let f = path.join(renderer, decodeURIComponent(u.pathname));
    if (!f.startsWith(renderer) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(renderer, "index.html");
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] ?? "application/octet-stream", body: fs.readFileSync(f) });
  });
  await page.addInitScript({ content: ui });
  await page.addInitScript(fakeMain, { project, carton, merge });
  await page.goto(`http://localhost:5199/app/editor/${PID}`);
  await page.waitForSelector("canvas[data-preview-canvas]", { timeout: 90000 });
  const settle = () => page.waitForTimeout(1500);
  await page.waitForTimeout(4000);
  const read = async (step) => {
    const box = await (await page.$("canvas[data-preview-canvas]")).boundingBox();
    const shot = await page.screenshot({ clip: box, path: path.join(OUT, `${name}-${key}-${step}.png`) });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const g = cv.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const s = window.__cbTestStore();
      return { luma: +(sum / (d.length / 4)).toFixed(1), currentTime: s.currentTime, playheadTime: s.playheadTime, hover: s.isHoverScrubberVisible ? s.hoverTime : null, selected: s.selectedTimelineItemIds.join(","), w5: s.timelineItems.some((i) => i.id === "eeeeeeee-0000-4000-8000-000000000005"), base: s.cartonBase ?? null, announced: window.__cbTestAnnounced ?? null };
    }, shot.toString("base64"));
  };
  const steps = {};
  await page.evaluate(() => window.__cbTestSeek(1));
  await settle();
  steps.before = await read("before");
  // W5's middle (4.5 s) on the Agents row: the timeline is a canvas, so by its scale
  const at = await page.evaluate(() => {
    const sc = document.querySelector("[data-timeline-scroll]"), st = window.__cbTestStore();
    const label = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent?.trim() === "Agents");
    const r = sc.getBoundingClientRect(), l = label.getBoundingClientRect();
    return { x: r.left + 4.5 * st.pixelsPerSecond - sc.scrollLeft, y: l.top + l.height / 2 };
  });
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await settle();
  steps.selected = await read("selected");
  await page.keyboard.press(key);
  await settle();
  steps[key] = await read(key);
  // the pointer leaves the timeline for the middle of the stage
  const stageBox = await (await page.$("canvas[data-preview-canvas]")).boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2, { steps: 4 });
  await settle();
  steps.away = await read("away");
  steps.layer = await page.evaluate(() => !!document.querySelector(".carton-stage"));
  await context.close();
  return { name, key, steps, errors };
};

(async () => {
  const dirs = await builds();
  const ui = uiServer();
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const results = [];
  try {
    for (const key of ["Escape", "Delete"])
      for (const c of [{ name: "carton-on", renderer: dirs.carton, carton: true }, { name: "carton-on-merged", renderer: dirs.carton, carton: true, merge: true }, { name: "carton-off", renderer: dirs.carton, carton: false }, { name: "no-carton", renderer: dirs.none, carton: false }])
        results.push(await runCase(browser, { ...c, key, ui }));
  } finally { await browser.close(); }
  let failed = false;
  for (const r of results) {
    const row = Object.entries(r.steps).filter(([k]) => k !== "layer").map(([k, s]) => `${k} ${s.luma} (t ${s.currentTime}, playhead ${s.playheadTime}, hover ${s.hover ?? "-"}, sel ${s.selected ? "W" + s.selected.slice(-1) : "-"}, W5 ${s.w5 ? "on" : "gone"}${s.base !== null ? `, base ${s.base}` : ""})`);
    console.log(`${r.name.padEnd(16)} ${r.key.padEnd(6)} layer=${r.steps.layer} | ${row.join(" | ")}${r.errors.length ? " | errors: " + r.errors.join("; ") : ""}`);
    if (r.errors.length) failed = true;
  }
  // What Cardboard does on these steps, in every build: the picture at the playhead; the hovered time (4.5 s, no
  // picture) while the pointer is on the timeline, W5 selected; after the key, nothing selected (and W5 gone after
  // Delete), still the hovered time; the playhead's picture again once the pointer leaves.
  const W5 = "eeeeeeee-0000-4000-8000-000000000005";
  const expect = (r) => {
    const { before, selected, away } = r.steps, after = r.steps[r.key], bad = [];
    const check = (ok, what) => { if (!ok) bad.push(what); };
    check(before.luma > 50 && before.currentTime === 1 && before.playheadTime === 1 && before.hover === null && before.selected === "", "before: the picture at 1 s");
    check(selected.selected === W5 && selected.hover === 4.5 && selected.currentTime === 4.5 && selected.playheadTime === 1 && selected.luma < 20, "selected: W5, the hovered 4.5 s");
    check(after.selected === "" && after.hover === 4.5 && after.currentTime === 4.5 && after.playheadTime === 1 && after.luma < 20 && after.w5 === (r.key !== "Delete"), `${r.key}: nothing selected${r.key === "Delete" ? ", W5 gone" : ""}, still the hovered 4.5 s`);
    check(away.luma > 50 && away.currentTime === 1 && away.playheadTime === 1 && away.hover === null && away.w5 === (r.key !== "Delete"), "pointer away: the picture at 1 s");
    // Carton on: its stage layer is there; merged: the editor adopted the announced head (its base is that revision)
    if (r.name.startsWith("carton-on")) check(r.steps.layer, "Carton's stage layer");
    if (r.name === "carton-on-merged") check(away.announced !== null && away.base === away.announced, "the merged head adopted");
    return bad;
  };
  for (const r of results) for (const b of expect(r)) { failed = true; console.log(`${r.name}, ${r.key}: not as expected: ${b}`); }
  // and Carton on does at every step what Carton off and the build without Carton do
  const same = (a, b) => Math.abs(a.luma - b.luma) <= 2 && a.currentTime === b.currentTime && a.playheadTime === b.playheadTime && a.hover === b.hover && a.selected === b.selected && a.w5 === b.w5;
  for (const key of ["Escape", "Delete"]) {
    const of = (n) => results.find((r) => r.name === n && r.key === key);
    for (const on of [of("carton-on"), of("carton-on-merged")])
      for (const other of [of("carton-off"), of("no-carton")])
        for (const step of ["before", "selected", key, "away"])
          if (!same(on.steps[step], other.steps[step])) { failed = true; console.log(`${key}, ${step}: ${on.name} differs from ${other.name}`); }
  }
  console.log(failed ? "FAIL" : "PASS: every build does what Cardboard does, and Carton on (also adopting a merged head) matches Carton off and the build without Carton at every step");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
