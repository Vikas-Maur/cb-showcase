// How soon an edit from the remote teammate shows on the app's side (FINDINGS.md §2): for planning cues, not a claim.
// Two running participants of one shared project (the remote, and one playing the app; rehearse.sh starts both). Each
// round, on the remote: a title added (say), its words changed (edit), and it removed (clear); every `--sound-every`
// rounds, a sound (speak, a WAV made beforehand). Timed from just before the remote's call, on this box's one clock:
//   saved   the remote's call answered (its worker committed; the change is on its way)
//   seen    the app's worker has the change in its history (Carton's change event, as `peer watch` shows it)
//   shown   the app's project.json shows it (the worker tells the editor's pages then)
//   sound   (speak only) the app's worker can stream the sound from the server (liveMediaSource answers with its size)
// Writes every run and the medians to <out>.json and prints a table.
//   node bench-latency.js --remote Sam --app Vikas [--rounds 10] [--sound-every 3] [--out <file>]
const fs = require("fs"), path = require("path"), os = require("os");
const lib = require("./lib.js");

const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const REMOTE = lib.peerDir(opt("remote", "Sam")), APP = lib.peerDir(opt("app", "Vikas"));
const ROUNDS = Number(opt("rounds", 10)), SOUND_EVERY = Number(opt("sound-every", 3));
const OUT = opt("out", path.join(lib.DEMO, "runs", `latency-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = xs.filter((x) => x !== null).sort((p, q) => p - q); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

(async () => {
  const events = [];
  const sub = lib.subscribe(APP, (ev) => events.push(ev));
  await sleep(500);
  const appCfg = lib.readJson(path.join(APP, "peer.json"));
  const wav = path.join(lib.DEMO, "media", "bench-line.wav");
  if (!fs.existsSync(wav)) {
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    await require("./tts.js").synth("This is a short line for timing.", { voice: "lessac", out: wav });
  }
  const runs = [];
  // the app's first edit event after t0 whose rows mention `word`, then the first `shown` after it
  // (a clip's own row: the timeline's, never its media entry's)
  const waitSeen = async (t0, word, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) {
      const e = events.find((x) => x.type === "edit" && !x.mine && x.at >= t0 && x.rows.some((r) => r.coll === "timelineItems" && JSON.stringify(r).includes(word)));
      if (e) {
        for (const end2 = Date.now() + 5000; Date.now() < end2; await sleep(5)) {
          const s = events.find((x) => x.type === "shown" && x.at >= e.seenAt);
          if (s) return { seen: e.seenAt - t0, shown: s.at - t0 };
        }
        return { seen: e.seenAt - t0, shown: null };
      }
    }
    return { seen: null, shown: null };
  };
  const load = () => os.loadavg()[0].toFixed(2);
  for (let i = 1; i <= ROUNDS; i++) {
    const tag = `Timing ${i} ${Math.random().toString(36).slice(2, 6)}`;
    let t0 = Date.now();
    const s = await lib.request(REMOTE, "say", { text: tag, at: 40 + i * 4, dur: 3, style: "chat", track: "Bench" });
    runs.push({ round: i, op: "say", saved: Date.now() - t0, ...(await waitSeen(t0, tag)), load: load() });
    await sleep(300);
    t0 = Date.now();
    await lib.request(REMOTE, "edit", { clip: s.id, text: tag + " changed" });
    runs.push({ round: i, op: "edit", saved: Date.now() - t0, ...(await waitSeen(t0, tag + " changed")), load: load() });
    await sleep(300);
    t0 = Date.now();
    await lib.request(REMOTE, "clear", { clip: s.id });
    runs.push({ round: i, op: "clear", saved: Date.now() - t0, ...(await waitSeen(t0, tag)), load: load() });
    await sleep(300);
    if (SOUND_EVERY && i % SOUND_EVERY === 0) {
      const f = path.join(REMOTE, "voice", `Timing line ${i}.wav`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.copyFileSync(wav, f);
      t0 = Date.now();
      const sp = await lib.request(REMOTE, "speak", { file: f, at: 40 + i * 4, name: `Timing line ${i}`, track: "Bench sound" });
      const saved = Date.now() - t0;
      const seen = await waitSeen(t0, `Timing line ${i}`);
      // can the app stream it when its clip arrives? (asked once at once, then until it can)
      const atOnce = !!(await lib.request(APP, "worker", { method: "carton.liveMediaSource", args: [{ mediaId: sp.mediaId }] }).catch(() => null))?.size;
      let sound = null;
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(100)) {
        const src = await lib.request(APP, "worker", { method: "carton.liveMediaSource", args: [{ mediaId: sp.mediaId }] }).catch(() => null);
        if (src?.size) { sound = Date.now() - t0; break; }
      }
      runs.push({ round: i, op: "speak", saved, ...seen, sound, playableOnArrival: atOnce, importedMs: sp.importedMs, sharedMs: sp.sharedMs, load: load() });
      await lib.request(REMOTE, "clear", { clip: sp.id }).catch(() => {});
      await sleep(300);
    }
  }
  sub.close();
  const ops = [...new Set(runs.map((r) => r.op))];
  const medians = Object.fromEntries(ops.map((op) => { const rs = runs.filter((r) => r.op === op); return [op, { n: rs.length, saved: median(rs.map((r) => r.saved)), seen: median(rs.map((r) => r.seen)), shown: median(rs.map((r) => r.shown)), ...(op === "speak" ? { sound: median(rs.map((r) => r.sound)), playableOnArrival: `${rs.filter((r) => r.playableOnArrival).length}/${rs.length}` } : {}) }]; }));
  const meta = { at: new Date().toISOString(), host: lib.readJson(path.join(lib.DEMO, "host", "host.json"))?.origin ?? appCfg.host, cpus: os.cpus().length, node: process.version, rounds: ROUNDS };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + ".json", JSON.stringify({ meta, medians, runs }, null, 2));
  console.log("op     n   saved  seen  shown  sound   (median ms; every run in " + OUT + ".json)");
  for (const [op, m] of Object.entries(medians)) console.log(`${op.padEnd(6)} ${String(m.n).padStart(2)} ${String(m.saved).padStart(7)} ${String(m.seen).padStart(5)} ${String(m.shown).padStart(6)} ${m.sound !== undefined ? String(m.sound).padStart(6) + `  streamable when its clip arrived: ${m.playableOnArrival}` : ""}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
