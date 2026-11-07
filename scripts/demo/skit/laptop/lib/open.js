// The laptop tooling's helpers for a Cardboard started by unseen\start-unseen.ps1 (desktop 2, never activated):
//  ready(h, port): waits for the home page and runs the first-run screens (onboard.js) until the tab strip is up;
//  open(h, cb, id, name): `cb project open` (no --focus: it would take the foreground), waits for the editor page, then
//    selects the project's tab with a DevTools click (without --focus the Dashboard tab stays selected and the title bar
//    draws no project controls). Returns the editor's URL part.
const { spawnSync } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.ready = async (h, port) => {
  for (let i = 0; i < 120; i++) { try { if ((await h.urls()).some((u) => /app\/home/.test(u))) break; } catch {} await sleep(500); }
  await sleep(2500);
  for (let i = 0; i < 6; i++) {
    spawnSync(process.execPath, [path.join(__dirname, "onboard.js")], { env: { ...process.env, CDP_PORT: String(port) }, timeout: 120e3 });
    if ((await h.ev("tabs.html", "innerWidth").catch(() => 0)) > 0) break;
    await sleep(2000);
  }
};
exports.open = async (h, cb, id, name) => {
  console.log("open:", cb("project", "open", id).split("\n").pop());
  const E = "app/editor/" + id;
  for (let i = 0; i < 60; i++) { if ((await h.urls()).some((u) => u.includes(E))) break; await sleep(500); }
  await sleep(4000);
  let picked = false;
  for (let i = 0; i < 20 && !picked; i++) {
    const q = await h.ev("tabs.html", `(() => { const t = [...document.querySelectorAll("button,[role=tab]")].find((b) => b.offsetParent && !/^Close /.test(b.getAttribute("aria-label") || "") && (b.innerText || "").trim() === ${JSON.stringify(name)}); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (q) { await h.mouse(await h.page("tabs.html"), q.x, q.y); picked = true; } else await sleep(500);
  }
  console.log("project tab selected:", picked);
  await sleep(2500);
  return E;
};
