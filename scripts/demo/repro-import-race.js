// FINDINGS.md §6, "an import's background derive deletes a teammate's next change": a repro, in Cardboard's real library
// worker (patched as the Windows build), two participants of one shared project on this box.
//   1. Sam imports a sound through Cardboard's own import (the worker's `ingest`, as main does for a file dropped on
//      the editor) and saves its clip on the timeline at once (DEMO_IMPORT=ingest; RACE_SECONDS=<the sound's length>
//      lets the save go without waiting for a probe, as the editor's does);
//   2. `delay` ms later, Vikas adds a title;
//   3. the new versions on Main, with who made each and what it did.
// Seen: "external:project.json (Sam's)  Deleted title 'Agent title at +2500 ms'": Sam's computer took the file its
// background derive (waveform) wrote for an outside save and committed it over head, deleting Vikas's title. Not seen
// with Sam's import through `cb media add` (the rig's default), or with a save after the derive finished
// (DEMO_SETTLE=1).
//   DEMO_IMPORT=ingest PEER=Sam scripts/demo/peer restart
//   RACE_SECONDS=4.93 node scripts/demo/repro-import-race.js 2500 <a 4.93 s .wav>
const lib = require("./lib.js");
const fs = require("fs"), path = require("path");
const P = process.env.RACE_PROJECT ?? "Demo rehearsal";
const SAM = lib.peerDir("Sam"), VIK = lib.peerDir("Vikas");
const wav = process.argv[3];
if (!wav) throw new Error("usage: node repro-import-race.js <delay ms> <a .wav>");
(async () => {
  const delay = Number(process.argv[2] ?? 500);
  const before = lib.cb(VIK, ["history", P, "--cut", "Main cut", "--limit", "1"]).json().versions[0].version;
  const copy = path.join(SAM, "voice", `race ${delay} ${Date.now()}.wav`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(wav, copy);
  const t0 = Date.now();
  const speak = lib.request(SAM, "speak", { file: copy, at: 20 + Math.random() * 5, name: `race ${delay}`, shareFirst: false, ...(process.env.RACE_SECONDS ? { seconds: Number(process.env.RACE_SECONDS) } : {}) });
  await new Promise((r) => setTimeout(r, delay));
  const vik = lib.request(VIK, "say", { text: `Agent title at +${delay} ms`, at: 30, dur: 2, style: "chat", track: "Talk" });
  const [s, v] = await Promise.all([speak, vik]);
  await new Promise((r) => setTimeout(r, 6000));
  const h = lib.cb(VIK, ["history", P, "--cut", "Main cut", "--limit", "8"]).json().versions;
  const seq = Number(before.split("@")[1]);
  const fresh = h.filter((x) => Number(x.version.split("@")[1]) > seq).reverse();
  for (const x of fresh) {
    const prev = `main@${Number(x.version.split("@")[1]) - 1}`;
    const c = lib.cb(VIK, ["compare", P, prev, x.version]).json();
    console.log(`${x.version}  ${x.by?.id}${x.by?.owner ? ` (${x.by.owner.name}'s)` : ""}  ${c.changes.join("; ")}`);
  }
  console.log(JSON.stringify({ delay, speakMs: s.savedMs, external: fresh.some((x) => /^external:/.test(x.by?.id ?? "")) }));
})().catch((e) => { console.error(e); process.exit(1); });
