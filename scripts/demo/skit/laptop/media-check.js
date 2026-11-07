// Whether a teammate's sounds are on the sharing server, as the demo Cardboard sees them (FINDINGS.md §6.4), over
// DevTools in its editor (read only: asks the library worker, changes nothing):
//   node media-check.js <DevTools port> <project id> [--rounds 3]
// Each round (3 s apart, longer than the worker keeps a sound's record): what the editor asks when the project opens
// (carton.liveMediaHere: "playable", or "waiting", the "still on their way" notice, when a record isn't read within
// 2 s) and what streaming each sound asks (carton.liveMediaSource, no deadline), with how long each took. A sound
// "waiting" in the first while every liveMediaSource answers "playable" is on the server: the notice came from a slow
// read, not from a sound that never arrived.
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const ROUNDS = Number(opt("rounds", 3));
const [port, id] = argv;
if (!port || !id) { console.error("usage: node media-check.js <DevTools port> <project id> [--rounds 3]"); process.exit(2); }
process.env.CDP_PORT = port;
const h = require("./lib/cdp-helpers");
const E = "app/editor/" + id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the timeline's sounds, from the editor's React state (as go.js reads its items)
const SOUNDS = `(() => { const root = document.getElementById("root"); const key = Object.keys(root).find((k) => k.startsWith("__reactContainer")); const stack = [root[key]]; let tl = null;
  while (stack.length && !tl) { const f = stack.pop(); if (!f) continue; for (let s = f.memoizedState, n = 0; s && n < 60; s = s.next, n++) { const c = s.memoizedState; if (c && typeof c === "object" && !Array.isArray(c) && "selectedTimelineItemIds" in c && "timelineItems" in c) { tl = c; break; } } if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
  return tl ? [...new Map(tl.timelineItems.filter((i) => i.type === "audio" && i.mediaItemId).map((i) => [i.mediaItemId, i.name ?? i.mediaItemId])).entries()] : null; })()`;
const ROUND = (ids) => `(async () => {
  const b = window.__carton, ids = ${JSON.stringify(ids)}, out = { here: null, hereMs: 0, sources: [] };
  let t = performance.now();
  try { out.here = (await b.call("liveMediaHere", [{ projectId: ${JSON.stringify(id)}, mediaIds: ids }]))?.clips ?? null; } catch (e) { out.here = "error: " + (e?.message ?? e); }
  out.hereMs = Math.round(performance.now() - t);
  await new Promise((r) => setTimeout(r, 2500)); // past the worker's 2 s for a sound's record
  await Promise.all(ids.map(async (mediaId) => { const t0 = performance.now(); let r; try { r = await b.call("liveMediaSource", [{ mediaId }]); } catch (e) { r = "error: " + (e?.message ?? e); } out.sources.push({ mediaId, playable: !!r && typeof r === "object", ms: Math.round(performance.now() - t0), ...(typeof r === "string" ? { error: r } : {}) }); }));
  return out;
})()`;
(async () => {
  const sounds = await h.ev(E, SOUNDS);
  if (!sounds?.length) throw new Error("no sounds on this project's timeline (is its editor open on DevTools port " + port + "?)");
  const ids = sounds.map(([m]) => m), name = Object.fromEntries(sounds);
  console.log(`${sounds.length} sounds: ${sounds.map(([, n]) => n).join(", ")}`);
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await h.ev(E, ROUND(ids));
    const counts = {};
    if (r.here && typeof r.here === "object") for (const m of ids) counts[r.here[m]] = (counts[r.here[m]] ?? 0) + 1;
    const waiting = r.here && typeof r.here === "object" ? ids.filter((m) => r.here[m] === "waiting").map((m) => name[m]) : [];
    console.log(`round ${i}: on open (liveMediaHere, 2 s deadline): ${typeof r.here === "string" ? r.here : JSON.stringify(counts)} in ${r.hereMs} ms${waiting.length ? `; "on their way": ${waiting.join(", ")}` : ""}`);
    console.log(`         streaming (liveMediaSource, each): ${r.sources.map((s) => `${name[s.mediaId]} ${s.playable ? "playable" : s.error ?? "not on the server"} ${s.ms} ms`).join("; ")}`);
    if (i < ROUNDS) await sleep(3000);
  }
  h.forget(); process.exit(0);
})().catch((e) => { console.error(e?.stack ?? e); h.forget(); process.exit(1); });
