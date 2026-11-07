// The hide under fire (FINDINGS.md §4.1): while the app's agent hides the chat (cues.js agentHide, Cardboard's own cb),
// the remote keeps talking: chat lines and a spoken line spread over the whole hide, and one more line the moment the
// person leaves the shared cut (as in the first cross-machine rehearsal, where such a line leaked into the person's cut
// on a "Missing track"). Then the person's cut is checked on its own, from the app side's worker (not the hide's own
// check): no clip on a chat track or on a track the cut doesn't have, no chat track, none of the chat's media, and the
// remote's real work from before the fold there.
// One more line is landed exactly between the agent's reading of the shared cut and its fold (the window that leaked).
//   node race-hide.js [--runs 5] [--app Vikas] [--remote Sam] [--project "Demo rehearsal"] [--old-flow]
// Two running participants of one shared project with a chat on "Talk"/"Voice" already (rehearse.sh's, or by hand).
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const lib = require("./lib.js"), cues = require("./cues.js");

const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const OLD = a.includes("--old-flow"); // the first rehearsal's hide: switch, then fold the shared cut's moving head (shows the leak)
const RUNS = Number(opt("runs", 5)), APP = opt("app", "Vikas"), REMOTE = opt("remote", "Sam"), P = opt("project", "Demo rehearsal");
const VIK = lib.peerDir(APP), SAM = lib.peerDir(REMOTE);
const CHAT = ["Talk", "Voice"];
const SESSION = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const t0 = Date.now(), stamp = () => `${lib.clock()} +${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const OUT = path.join(lib.DEMO, "runs", `race-hide-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });
const logf = fs.openSync(path.join(OUT, "race-hide.log"), "a");
const out = (s) => { process.stdout.write(s + "\n"); fs.writeSync(logf, s + "\n"); };
const peer = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(__dirname, "peer"), ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let o = ""; p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (o += x));
  p.on("exit", (code) => resolve({ code, out: o }));
});

(async () => {
  const results = [];
  for (let r = 1; r <= RUNS; r++) {
    out(`${stamp()} ── run ${r}`);
    const sw = lib.cb(VIK, ["cut", "switch", P, "Main cut"], { actor: "director/race/setup", json: false });
    if (sw.code !== 0) throw new Error("switch to Main: " + sw.out + sw.err);
    // before the hide: real work, and the chat going on
    await lib.request(SAM, "say", { text: `Lower third ${r}`, at: 30 + r * 3, dur: 2, style: "caption", track: "Titles", name: `Lower third ${r}` });
    await lib.request(SAM, "say", { text: `Chat line ${r}`, at: 3 + r * 3, dur: 2, style: "chat", track: "Talk" });
    await new Promise((res) => setTimeout(res, 800));
    // the remote's lines during the hide, from its own process (the hide's cb calls block this one)
    const sheet = path.join(OUT, `sam-${r}.yaml`);
    fs.writeFileSync(sheet, [
      "cues:",
      `  - say: "Racing line ${r}.1"\n    at: ${50 + r * 10}\n    for: 1\n    style: chat`,
      `  - speak: "Racing sound ${r}"\n    at: ${51 + r * 10}\n    voice: lessac\n    on_fail: continue`,
      `  - pause: 0.4`,
      `  - say: "Racing line ${r}.2"\n    at: ${52 + r * 10}\n    for: 1\n    style: chat`,
      `  - pause: 1.2`,
      `  - say: "Racing line ${r}.3"\n    at: ${53 + r * 10}\n    for: 1\n    style: chat`,
      `  - pause: 1.5`,
      `  - say: "Racing line ${r}.4"\n    at: ${54 + r * 10}\n    for: 1\n    style: chat`,
      `  - wait: {left: ${APP}, timeout: 90}`,
      `  - say: "Gone ${r}. They can't see us now."\n    at: ${55 + r * 10}\n    for: 1\n    style: chat`,
      "",
    ].join("\n"));
    const remote = peer(["run", sheet, "--peer", REMOTE]);
    await new Promise((res) => setTimeout(res, 1500)); // its spoken line made, its first lines going out
    const cut = `Hide ${SESSION} run ${r}`, hideAt = Date.now(); // a name never used (a taken one is refused)
    let hide;
    // the window: a line from the remote lands on the shared cut after the agent read it, before the fold
    const between = () => {
      const x = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "peer"), "--peer", REMOTE, "say", `Between line ${r}`, "--at", String(56 + r * 10), "--for", "1", "--style", "chat"], { env: process.env, encoding: "utf8" });
      out(`${stamp()}      (the remote, between the reading and the fold: ${(x.stdout + x.stderr).trim()})`);
    };
    try { hide = await cues.agentHide(VIK, { agent_hide: cut, project: P, actor: `director/race/turn${r}`, _beforeFold: between, _debug: path.join(OUT, `hide-${r}.json`), ...(OLD ? { old_flow: true } : {}) }, out, stamp); }
    catch (e) { out(`${stamp()}   ✗ hide failed: ${e.message}`); results.push({ run: r, error: e.message }); continue; }
    const doneAt = Date.now();
    const rr = await remote;
    fs.writeFileSync(path.join(OUT, `sam-${r}.out`), rr.out);
    // the person's cut, read on its own
    const c = await lib.request(VIK, "cutDoc", { name: cut });
    const main = await lib.request(SAM, "read");
    const chatTracks = new Set((main.tracks ?? []).filter((t) => CHAT.includes(t.name)).map((t) => t.id));
    const chatMedia = new Set((main.timelineItems ?? []).filter((i) => chatTracks.has(i.trackId)).map((i) => i.mediaItemId));
    for (const m of lib.readJson(path.join(SAM, "peer.json")).mine ?? []) if (m.mediaId) chatMedia.add(m.mediaId);
    const tracksHere = new Set(c.tracks.map((t) => t.id));
    const leaks = [
      ...c.tracks.filter((t) => CHAT.includes(t.name)).map((t) => `track “${t.name}”`),
      ...c.items.filter((i) => chatTracks.has(i.trackId) || !tracksHere.has(i.trackId)).map((i) => `clip “${i.name ?? i.id}”${tracksHere.has(i.trackId) ? "" : " on a missing track"}`),
      ...c.media.filter((m) => chatMedia.has(m.id)).map((m) => `media “${m.fileName}”`),
    ];
    // the remote's lines that landed on Main while the hide ran (from the app side's stream journal)
    const landed = fs.readFileSync(path.join(VIK, "watch.jsonl"), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === "edit" && !e.mine && e.seenAt >= hideAt && e.seenAt <= doneAt && e.cut === "Main cut").map((e) => e.what);
    const realWork = c.items.some((i) => i.name === `Lower third ${r}`);
    const res = { run: r, oldFlow: OLD, cut, folded: hide.at.split(" ")[0], landedDuringHide: landed.length, leaks, realWorkIn: realWork, hideOwnCheck: hide.leaks, takenOut: hide.fixed, hideMs: doneAt - hideAt, remoteSteps: (rr.out.match(/ ✓ /g) ?? []).length };
    results.push(res);
    out(`${stamp()}   ${leaks.length ? "✗ LEAK: " + leaks.join(", ") : "✓ no leak"}; folded ${res.folded}; ${landed.length} remote edit(s) landed on Main during the hide (${landed.map((w) => w.slice(0, 40)).join(" | ")}); real work in: ${realWork}; hide ${(res.hideMs / 1000).toFixed(1)} s; remote ${res.remoteSteps} steps ok`);
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const bad = results.filter((x) => x.error || x.leaks.length || !x.realWorkIn);
  out(`${stamp()} ${results.length - bad.length}/${results.length} runs with no leak and the real work in; ${results.reduce((n, x) => n + (x.landedDuringHide ?? 0), 0)} remote edits landed during the hides. ${OUT}`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
