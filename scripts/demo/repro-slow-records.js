// FINDINGS.md §6.4: a teammate's sounds, fully shared, reported "still on their way" when the server is slow to answer.
// On a project set up with `skit/rehearse-skit.js --setup-only` (Vikas shares it, Claude joined, the local host):
//   1. Claude sends sounds (imported, shared, placed: the rig's speakAll), checks them on the server, and leaves.
//   2. The host restarts with each read of a clip's shared record held back --delay ms (host.mjs
//      DEMO_HOST_RECORD_DELAY_MS), and Vikas's worker restarts (nothing cached), as the laptop reopening the project.
//   3. What Vikas's editor asks when the project opens (carton.liveMediaHere, the "on their way" notice's source), and
//      what streaming one of them asks (carton.liveMediaSource, no deadline): their answers and how long they took.
//   4. The same with the host answering at once.
//   DEMO_DIR=~/gfv-scratch/carton/demo-skit node repro-slow-records.js [--delay 2500] [--port 8795]
const path = require("path"), { spawnSync } = require("child_process");
const lib = require("./lib.js");

const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const DELAY = Number(opt("delay", 2500)), PORT = String(opt("port", 8795));
const V = path.join(lib.TTS, "skit-voices");
const peer = (args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "peer"), ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  const out = (r.stdout + r.stderr).trim();
  if (r.status !== 0) throw new Error(`peer ${args.join(" ")}: ${out}`);
  return out;
};
const t = () => new Date().toISOString().slice(11, 23);
const say = (s) => console.log(`${t()}  ${s}`);
const vikas = lib.peerDir("Vikas"), claude = lib.peerDir("Claude");
const cfg = lib.readJson(path.join(vikas, "peer.json"));
const timed = async (f) => { const t0 = Date.now(); const r = await f(); return { r, ms: Date.now() - t0 }; };

(async () => {
  // 1. Claude's sounds
  const parts = [
    { file: path.join(V, "r2", "Reply 1.wav"), at: 33.7, name: "Reply 1" },
    { file: path.join(V, "r2b", "Reply 1 (2).wav"), at: 38.5, name: "Reply 1 (2)" },
    { file: path.join(V, "r3", "Reply 2.wav"), at: 48.7, name: "Reply 2" },
    { file: path.join(V, "r4", "Reply 3.wav"), at: 63.1, name: "Reply 3" },
  ];
  const sent = await lib.request(claude, "speakAll", { parts, track: "Voiceover" });
  say(`Claude: ${sent.parts.length} sounds placed (shared in ${(sent.sharedMs / 1000).toFixed(2)} s)`);
  say(peer(["--peer", "Claude", "status"]).split("\n").filter((l) => /sound|pending|server/i.test(l)).join("\n") || "(status)");
  say(peer(["--peer", "Claude", "leave"]));
  await new Promise((r) => setTimeout(r, 1500));
  const doc = await lib.request(vikas, "worker", { method: "projects.read", args: [cfg.projectId] });
  const theirs = (doc.media ?? []).filter((m) => m.data?.type === "audio");
  const ids = theirs.map((m) => m.id);
  for (const m of theirs) say(`Vikas's project: ${m.data.fileName}: contentHash ${m.contentHash ? "yes" : "no"}, shared ${JSON.stringify(m.shared ?? null)}`);

  const reopen = async (delay) => {
    say(peer(["host", "stop"]));
    say(peer(["host", "start", "--port", PORT], delay ? { DEMO_HOST_RECORD_DELAY_MS: String(delay) } : {}) + (delay ? `  (each record read held back ${delay} ms)` : ""));
    say(peer(["--peer", "Vikas", "restart"]).split("\n")[0]);
    await new Promise((r) => setTimeout(r, 2000));
    const here = await timed(() => lib.request(vikas, "worker", { method: "carton.liveMediaHere", args: [{ projectId: cfg.projectId, mediaIds: ids }] }));
    const counts = {};
    for (const id of ids) counts[here.r?.clips?.[id]] = (counts[here.r?.clips?.[id]] ?? 0) + 1;
    say(`liveMediaHere (what the editor asks on open): ${JSON.stringify(counts)} in ${here.ms} ms`);
    const one = await timed(() => lib.request(vikas, "worker", { method: "carton.liveMediaSource", args: [{ mediaId: ids[0] }] }));
    say(`liveMediaSource for ${theirs[0].data.fileName} (what streaming it asks): ${one.r ? "playable" : "null"} (${one.r?.mime ?? ""}, ${one.r?.size ?? ""} bytes) in ${one.ms} ms`);
    return counts;
  };
  say(`--- reopened, the server slow (${DELAY} ms a record)`);
  const slow = await reopen(DELAY);
  say("--- reopened, the server answering at once");
  const fast = await reopen(0);
  console.log(JSON.stringify({ delay: DELAY, sounds: ids.length, slow, fast }));
  process.exit(0);
})().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
