// Real-browser shots of the app's side of a rehearsal: the app participant's editor in headless Chromium
// (editor-page.js: Cardboard 1.4.0's editor pages, patched as the Windows build is, on that participant's worker).
// For each state asked: the editor (at a time on the timeline), History open (Ctrl+Shift+H), Share open.
//   node shots.js --app Vikas --out <dir> [--state "Main cut@7" --state "Vikas's cut@7"]   (a cut, and the playhead)
// Run it through gfv-scratch/carton/slot.sh (one Chromium at a time on the dev box).
const fs = require("fs"), path = require("path"), os = require("os");
const lib = require("./lib.js");

const a = process.argv.slice(2), opts = (k) => a.flatMap((x, i) => (x === "--" + k ? [a[i + 1]] : []));
const APP = lib.peerDir(opts("app")[0] ?? "Vikas"), OUT = opts("out")[0] ?? path.join(lib.DEMO, "shots", new Date().toISOString().replace(/[:.]/g, "-"));
const STATES = (opts("state").length ? opts("state") : ["Main cut@7"]).map((s) => { const m = /^(.*)@([\d.]+)$/.exec(s); return { cut: m ? m[1] : s, at: m ? Number(m[2]) : 5 }; });
const editor = require("./editor-page.js");
const cfg = lib.readJson(path.join(APP, "peer.json"));
const PROJECT = cfg.projectName;

async function shoot(browser, state, n) {
  // the person's cut, as Cardboard's agent would switch it (the editor follows)
  const sw = lib.cb(APP, ["cut", "switch", PROJECT, state.cut], { actor: "director/shots/turn1", json: false });
  if (sw.code !== 0) throw new Error("cut switch: " + sw.out + sw.err);
  const { page, errors, logs, close } = await editor.openEditor(browser, { app: APP });
  try { await page.waitForSelector("canvas[data-preview-canvas]", { timeout: 60000 }); }
  catch (e) { await page.screenshot({ path: path.join(OUT, "failed.png") }); throw new Error("the editor didn't open: " + [...errors, ...logs].slice(-12).join("\n")); }
  await page.waitForTimeout(4000);
  await page.evaluate((t) => window.__demoSeek?.(t), state.at);
  await page.waitForTimeout(1500);
  const tag = `${n}-${lib.slug(state.cut)}`;
  const files = [];
  const snap = async (what) => { const f = path.join(OUT, `${tag}-${what}.png`); await page.screenshot({ path: f }); files.push(f); };
  await snap("editor");
  // History, as the person opens it (Ctrl+Shift+H)
  await page.keyboard.press("Control+Shift+KeyH");
  await page.waitForSelector(".carton-sidebar", { timeout: 15000 }).catch(() => errors.push("History didn't open"));
  await page.waitForTimeout(2500);
  await snap("history");
  await page.keyboard.press("Control+Shift+KeyH");
  await page.waitForTimeout(800);
  // Share, as the title bar's Share icon opens it (main's carton:command)
  await page.evaluate(() => window.__demoEmit("carton:command", { action: "carton-share" }));
  await page.waitForSelector(".carton-share-dialog", { timeout: 15000 }).catch(() => errors.push("Share didn't open"));
  await page.waitForTimeout(1500);
  await snap("share");
  const text = await page.evaluate(() => ({ share: document.querySelector(".carton-share-dialog")?.innerText ?? null, history: null }));
  await close();
  return { state, files, errors, share: text.share };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await editor.launch();
  const results = [];
  try { let n = 1; for (const s of STATES) results.push(await shoot(browser, s, n++)); } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.state.cut} @${r.state.at}s: ${r.files.map((f) => path.basename(f)).join(", ")}${r.errors.length ? "  errors: " + r.errors.join("; ") : ""}\n  Share: ${(r.share ?? "").replace(/\n+/g, " | ").slice(0, 300)}`);
})().catch((e) => { console.error(e); process.exit(1); });
