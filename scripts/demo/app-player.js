// The running app, for `cb app …` in the Linux rehearsal: the app participant's editor in headless Chromium
// (editor-page.js) behind a control socket served as Cardboard's main serves it (main.js kHt: auth with the token next
// to the socket, app.context, player.seek/play/pause), each request handed to the editor's own control handlers (main's
// control:request event; the editor answers with control:reply). So `cb app seek/play/pause/context` run Cardboard's
// real playback, as on the laptop: the store, the wait for audio before Play ("Loading audio…"), the audio graph and its
// clock. Every playback state the editor goes through goes to the trace, with the calls that caused it.
//   node app-player.js --app Vikas --socket <dir>/cardboard.sock [--media-delay <ms>] [--trace <file.jsonl>] [--stdin]
//   cb, then: CARDBOARD_SOCKET=<that socket> CARDBOARD_HOME=<the library> cb app play   (never with --root: cb doesn't
//   ask the app about a library under --root)
// --media-delay: the first fetch of each media file waits that long, as the laptop waits for a teammate's sound to come
// down from the sharing server. --stdin: it stops when its input closes (a script that started it ends it so).
// Run it through gfv-scratch/carton/slot.sh (one Chromium at a time on the dev box).
const fs = require("fs"), path = require("path"), net = require("net"), crypto = require("crypto");
const lib = require("./lib.js");
const editor = require("./editor-page.js");

const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const APP = lib.peerDir(opt("app", "Vikas"));
const SOCK = path.resolve(opt("socket", path.join(lib.DEMO, "app-sock", "cardboard.sock")));
const DELAY = Number(opt("media-delay", 0));
const TRACE = opt("trace", null);
const cfg = lib.readJson(path.join(APP, "peer.json"));

const t0 = Date.now();
const out = (s) => console.log(`${new Date().toISOString().slice(11, 23)} +${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
const trace = (x) => { if (TRACE) fs.appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), ...x }) + "\n"); };
const f2 = (n) => (typeof n === "number" ? n.toFixed(2) : String(n));

(async () => {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true });
  try { fs.unlinkSync(SOCK); } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(path.dirname(SOCK), "cardboard.sock.token"), token, { mode: 0o600 });

  const pending = new Map();
  let nextId = 1;
  const browser = await editor.launch();
  const ed = await editor.openEditor(browser, {
    app: APP, mediaDelay: DELAY, onMedia: (x) => { trace({ what: "media", ...x }); out(`editor fetched media ${x.id.slice(0, 8)} (${x.bytes} bytes${x.delayed ? `, after ${DELAY} ms` : ""})`); },
    onControlReply: (r) => { const p = pending.get(r.id); if (!p) return; pending.delete(r.id); r.ok ? p.resolve(r.data) : p.reject(r.error); },
  });
  const { page } = ed;
  await page.waitForSelector("canvas[data-preview-canvas]", { timeout: 60000 });
  await page.waitForFunction(() => !!window.__demoStore, null, { timeout: 30000 });
  await page.waitForTimeout(2000);
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = `demo-${nextId++}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the editor did not answer ${method}`)); }, 30000);
    pending.set(id, { resolve: (d) => { clearTimeout(timer); resolve(d); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    page.evaluate((req) => window.__demoEmit("control:request", req), { id, method, params }).catch(reject);
  });

  // the editor's playback, as it goes: Play waiting for audio ("loading"), a play waiting for that ("pending"),
  // playing, and the playhead jumping back while playing (the clock re-based)
  await page.exposeBinding("__demoTrace", (_s, x) => {
    trace(x);
    if (x.what === "state") out(`editor: ${x.loading ? "Loading audio…" : x.playing ? "playing" : "paused"}${x.pending && !x.playing ? " (play waiting)" : ""} at ${f2(x.t)}`);
    if (x.what === "jump") out(`editor: the playhead jumped back ${f2(x.from)} → ${f2(x.t)} while playing`);
    if (x.what === "timeline") out(`editor: the timeline has ${x.items} items, ${f2(x.duration)} s`);
    if (x.what === "ready") out(`editor: the sound at ${f2(x.t)} is ${x.ready ? "loaded: Play starts at once" : "not loaded: Play would wait (Loading audio…)"}`);
  });
  await page.evaluate(() => {
    const s = window.__demoStore, t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
    const snap = () => { const st = s.state(); return { playing: st.isPlaying, loading: !!st.isAudioPreloading, pending: !!st.pendingPlayback, t: Math.round(s.clock() * 1000) / 1000 }; };
    let last = snap(), lastT = last.t;
    window.__demoTrace({ what: "start", ms: 0, ...last });
    s.subscribe(() => { const x = snap(); if (x.playing !== last.playing || x.loading !== last.loading || x.pending !== last.pending) { last = x; window.__demoTrace({ what: "state", ms: ms(), ...x }); } });
    // the timeline the editor has (a change reaches History first, then the editor)
    let shape = "";
    s.subscribe(() => { const st = s.state(), now = `${st.timelineItems?.length ?? 0}|${st.duration}`; if (now !== shape) { shape = now; window.__demoTrace({ what: "timeline", ms: ms(), items: st.timelineItems?.length ?? 0, duration: st.duration }); } });
    const frame = () => { const x = snap(); if (x.playing && x.t < lastT - 0.05) window.__demoTrace({ what: "jump", ms: ms(), from: lastT, ...x }); lastT = x.t; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    setInterval(() => { const x = snap(); if (x.playing || x.loading) window.__demoTrace({ what: "tick", ms: ms(), ...x }); }, 250);
    // whether Play would start at once: the sound of the next seconds from the playhead is loaded (the editor's own
    // check, checkAudioReadyAtPlayhead, which Play asks before it waits with "Loading audio…")
    let ready = null;
    setInterval(() => { const st = s.state(); if (st.isPlaying || !st.checkAudioReadyAtPlayhead) return; const r = !!st.checkAudioReadyAtPlayhead(st.currentTime); if (r !== ready) { ready = r; window.__demoTrace({ what: "ready", ms: ms(), ready: r, t: Math.round(st.currentTime * 1000) / 1000 }); } }, 100);
  });

  const bundlePath = path.join(cfg.root, `${cfg.projectName}.cardboard`);
  const METHODS = {
    "app.context": async () => {
      const i = await ask("editor.context", {});
      return { ...i, project: i.project ? { ...i.project, bundlePath } : null, tabs: [{ projectId: cfg.projectId, name: cfg.projectName, active: true }], app: { version: "1.4.0", pid: process.pid, protocol: 1 } };
    },
    "player.seek": async (p) => ask("player.seek", { at: p.at }),
    "player.play": async () => ask("player.play", {}),
    "player.pause": async () => ask("player.pause", {}),
    // not Cardboard's: a look inside the page for a test (scripts/demo only; the socket takes the token as main's does)
    "demo.eval": async (p) => ({ value: await page.evaluate(p.expr) }),
  };
  const server = net.createServer((c) => {
    let buf = "", authed = false;
    c.setEncoding("utf8");
    c.on("error", () => {});
    c.on("data", async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req; try { req = JSON.parse(line); } catch { continue; }
        const answer = (x) => c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...x }) + "\n");
        if (req.method === "auth") { authed = req.params?.token === token; answer(authed ? { result: {} } : { error: { code: -32000, message: "Unauthorized" } }); continue; }
        if (!authed) { answer({ error: { code: -32000, message: "Unauthorized" } }); continue; }
        const f = METHODS[req.method];
        if (!f) { answer({ error: { code: -32601, message: `Unknown method ${req.method}` } }); continue; }
        const started = Date.now();
        try {
          const result = await f(req.params ?? {});
          trace({ what: "call", method: req.method, params: req.params ?? {}, result: { at: result.at ?? result.playhead, playing: result.playing }, took: Date.now() - started });
          out(`cb app ${req.method.replace(/^(player|app)\./, "")}${req.params?.at !== undefined ? " " + req.params.at : ""} → ${result.playing ? "playing" : "paused"} at ${f2(result.at ?? result.playhead)}`);
          answer({ result });
        } catch (e) { answer({ error: { code: -32603, message: String(e?.message ?? e) } }); }
      }
    });
  });
  await new Promise((r) => server.listen(SOCK, r));
  out(`ready: ${cfg.projectName} open in the editor; cb app on ${SOCK}${DELAY ? `; a media file's first fetch waits ${DELAY} ms` : ""}`);
  const stop = async () => { server.close(); try { fs.unlinkSync(SOCK); } catch {} await ed.close(); await browser.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  if (a.includes("--stdin")) { process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdin.resume(); }
})().catch((e) => { out("✗ " + (e?.stack ?? e)); process.exit(1); });
