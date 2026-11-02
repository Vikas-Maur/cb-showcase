// Step 4: a host Claude Code turn in the real app (Carton on). Picks "Opus 5.5" in the composer, sends a prompt that edits
// through cb and reads timeline.tsx, and meanwhile (15 s into the turn) the person mutes the Mine clip with M. A poller
// watches timeline.tsx (stat every 300 ms, read on change: its rev line, W2's font size, whether a clip is muted), so the
// freeze shows: the person's mute must not reach timeline.tsx until the turn ends. Then history, credits, the views.
//   node agent-path.js <port> <build> <profile> "<option in the picker>" [maxSeconds]
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const [, , port, build, profile, option = "Opus 5.5", maxS = "300"] = process.argv;
process.env.CDP_PORT = port;
const cb = require("./cb");
const NL = String.fromCharCode(10);
// AP_ID/AP_NAME: a project set up before the app started (setup cb writes from an agent without hooks hold
// timeline.tsx for a minute by design, which would mask the turn's own release).
const name = process.env.AP_NAME || "Agent path " + Date.now().toString(36);
const id = process.env.AP_ID || execFileSync(process.execPath, ["mkproj.js", build, profile, "on", name], { encoding: "utf8", cwd: __dirname }).trim();
cb.run(build, profile, "on", ["project", "open", id, "--focus"]);
process.env.CB_PROJECT = id;
const d = require("./drv");
const E = d.ED;
const bundle = JSON.parse(cb.run(build, profile, "on", ["project", "list", "--json"]).out).find((p) => p.id === id).bundlePath;
const tsx = path.join(bundle, "timeline.tsx");
const t0 = Date.now();
const log = [];
let last = "";
const look = () => {
  try {
    const st = fs.statSync(tsx); const key = st.mtimeMs + ":" + st.size;
    if (key === last) return; last = key;
    const s = fs.readFileSync(tsx, "utf8");
    log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s timeline.tsx: ${/cardboard:rev ([^\n]*)/.exec(s)?.[1]?.slice(0, 60)} | W2 font ${/name="W2"[\s\S]*?fontSize=\{(\d+)\}/.exec(s)?.[1]} | muted ${/\bmuted\b/.test(s)}`);
  } catch (e) { log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s stat failed ${e.code}`); }
};
const poll = setInterval(look, 300);
const busy = () => d.h.ev(E, `[...document.querySelectorAll("button")].some((b) => /^(Stop|Interrupt|Cancel)/i.test(b.getAttribute("aria-label") || b.textContent.trim()))`);
(async () => {
  await d.until(async () => (await d.h.urls()).some((u) => u.includes(id)), 15000);
  await d.sleep(2500);
  await d.front(name);
  for (let i = 0; i < 2; i++) { await d.rail("Zoom in"); await d.sleep(250); }
  look();
  // The agent picker.
  const picked = await d.h.ev(E, `document.querySelector("[data-analytics=director-picker]")?.textContent.trim()`);
  console.log("picker shows:", picked);
  if (picked !== option) throw new Error("picker is on " + picked);
  const prompt = process.env.AGENT_PROMPT || "Using the cb command line only, set the font size of the text item named W2 to 321. Then read timeline.tsx in the project folder and tell me W2's font size there. Be brief.";
  await d.h.click(E, 'textarea[aria-label$="the agent"]');
  await (await d.h.page(E)).send("Input.insertText", { text: prompt });
  await d.sleep(300);
  const sent = Date.now();
  log.push(`${((sent - t0) / 1000).toFixed(1)}s prompt sent`);
  await d.keys("Enter");
  let muted = false, firstBusy = null, idle = null;
  while (Date.now() - sent < +maxS * 1000) {
    const b = await busy();
    if (b && firstBusy == null) firstBusy = Date.now();
    if (!muted && firstBusy && Date.now() - firstBusy > +(process.env.MUTE_AFTER_MS || 15000) && b) {
      // The person's edit during the turn: select the Mine clip, M.
      const s = await d.state(); const yM = await d.trackY("Mine");
      await d.click(d.xOf(s, 0.5), yM); await d.sleep(300); await d.keys("m");
      log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s person muted the Mine clip (M) during the turn`);
      muted = true;
    }
    if (!b && firstBusy) { idle ??= Date.now(); if (Date.now() - idle > 5000) break; } else idle = null;
    await d.sleep(500);
  }
  log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s turn over (agent idle 5 s)`);
  const over = Date.now(); log.push(`${((over - t0) / 1000).toFixed(1)}s watching timeline.tsx for 100 s more`);
  await d.sleep(+(process.env.WATCH_MS || 8000));
  look();
  clearInterval(poll);
  console.log(log.join(NL));
  await d.shot("shots/26-agent-turn.png");
  console.log("chat tail:", (await d.h.ev(E, `(document.querySelector('textarea[aria-label$="the agent"]')?.closest("aside,section,div[class*=flex-col]")?.parentElement ?? document.body).innerText.slice(-1500)`)).split(NL).filter(Boolean).slice(-12).join(" | "));
  console.log("history:" + NL + cb.run(build, profile, "on", ["history", id]).out.split(NL).slice(0, 7).join(NL));
  console.log("credits W2:", cb.run(build, profile, "on", ["credits", id, "W2"]).out.trim());
  console.log("activity:" + NL + cb.run(build, profile, "on", ["activity", id]).out.trim().split(NL).slice(0, 10).join(NL));
  const views = path.join(bundle, ".scratch", "views");
  console.log("views:", fs.existsSync(views) ? fs.readdirSync(views).join(", ") : "(none)");
  const final = fs.readFileSync(tsx, "utf8");
  console.log("timeline.tsx now: W2 font", /name="W2"[\s\S]*?fontSize=\{(\d+)\}/.exec(final)?.[1], "| muted", /\bmuted\b/.test(final));
  d.h.forget();
})().catch((e) => { clearInterval(poll); console.log(log.join(NL)); console.error(e); process.exit(1); });
