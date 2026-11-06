// Checks the changelog's "See what happens" buttons and dialogs in a real browser (Playwright's Chromium), the
// page served from carton/apps/web/public as the site serves it (/changelog/…).
// - Loading the page makes no request for the dialogs' media (img/cb/), and logs no console error.
// - Every "i" button opens its dialog, which loads its media then (and only its own); Esc closes it and the
//   keyboard is back on the button. The close button and a click outside close it the same way.
// - At 375 px the two sides stack; with reduced motion nothing plays until Play is pressed; without script no "i"
//   shows.
// - A dialog closed before its clips have loaded leaves nothing to play: with the names clips held back (as on a
//   slow connection), names is opened and closed, playhead opened and closed; no video, in the page or removed
//   from it, may be playing while playhead is open or after.
// - Screenshots: the page at 1280 and 375 px wide, and every dialog open at both widths.
// Usage: [PLAYWRIGHT=<path to playwright>] [CHROME=<chromium binary>] [CHANGELOG_ROOT=<a public/ folder to serve
//        instead of carton/apps/web/public>] node scripts/changelog/check-visuals.js [out dir] [--only=closed-early]
// Exits 1 on any failure.
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const ROOT = path.resolve(process.env.CHANGELOG_ROOT || path.join(__dirname, "..", "..", "carton", "apps", "web", "public"));
const OUT = process.argv.slice(2).find((a) => !a.startsWith("--")) || path.join(os.tmpdir(), "cb-changelog-check");
// --only=closed-early runs just that test
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const TYPES = { ".html": "text/html", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const ORIGIN = "http://changelog.test";

let failed = false;
const fail = (what) => { failed = true; console.log("  FAIL: " + what); };

// every video the page makes or plays, kept even after it is removed from the page
const trackVideos = () => {
  const all = (window.__cbVideos = new Set());
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { all.add(this); return play.apply(this, a); };
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { n.tagName === "VIDEO" && all.add(n); n.querySelectorAll?.("video").forEach((v) => all.add(v)); } }).observe(document, { childList: true, subtree: true });
};
const playing = (page) => page.evaluate(() => [...window.__cbVideos].filter((v) => !v.paused).map((v) => `${(v.currentSrc || v.querySelector("source")?.src || "?").split("/").pop()}${v.isConnected ? "" : " (removed from the page)"}`));

// hold: paths whose answers are held back that many ms (a slow connection)
const open = async (browser, { width, height, dpr = 1, reducedMotion = "no-preference", mobile = false, script = true, hold = null }) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, reducedMotion, isMobile: mobile, hasTouch: mobile, javaScriptEnabled: script });
  const page = await context.newPage(), requests = [], errors = [];
  await page.addInitScript(trackVideos);
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    requests.push(u.pathname);
    if (hold && hold.test.test(u.pathname)) await new Promise((r) => setTimeout(r, hold.ms));
    let f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: "" }).catch(() => {});
    // ranges, as a static host answers them (video elements ask for them)
    const body = fs.readFileSync(f), range = route.request().headers().range, type = TYPES[path.extname(f)] ?? "application/octet-stream";
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const a = +m[1], z = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
      return route.fulfill({ status: 206, contentType: type, headers: { "content-range": `bytes ${a}-${z}/${body.length}`, "accept-ranges": "bytes" }, body: body.subarray(a, z + 1) }).catch(() => {});
    }
    // (a held-back request the page has since dropped can't be answered)
    return route.fulfill({ status: 200, contentType: type, headers: { "accept-ranges": "bytes" }, body }).catch(() => {});
  });
  await page.goto(`${ORIGIN}/changelog/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return { context, page, requests, errors };
};

// the dialog's media all loaded (images decoded, videos able to play), up to 10 s
const mediaReady = (page) => page.waitForFunction(() => {
  const d = document.querySelector("dialog.cbv");
  const imgs = [...d.querySelectorAll("img")], vids = [...d.querySelectorAll("video")];
  return imgs.every((i) => i.complete && i.naturalWidth > 0) && vids.every((v) => v.readyState >= 3 || (v.poster && v.preload === "none"));
}, null, { timeout: 10000 }).then(() => true, () => false);

const state = (page) => page.evaluate(() => {
  const d = document.querySelector("dialog.cbv"), a = document.activeElement;
  const figs = [...d.querySelectorAll(".cbv-side")].map((f) => f.getBoundingClientRect());
  return {
    open: d.open, title: d.querySelector("h2")?.textContent ?? null,
    focus: a?.dataset?.see ? `${a.dataset.see}@${a.closest(".cbtoo") ? "top" : "entry"}` : a?.tagName,
    stacked: figs.length === 2 ? figs[1].top >= figs[0].bottom - 1 : null,
    videos: [...d.querySelectorAll("video")].map((v) => ({ paused: v.paused, t: +v.currentTime.toFixed(2), src: v.currentSrc.split("/").pop() })),
    play: d.querySelector(".cbv-play")?.hidden === false ? d.querySelector(".cbv-play").textContent.trim() : null,
    inView: (() => { const r = d.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; })(),
  };
});

const run = async (browser, label, opts) => {
  console.log(`${label} (${opts.width} px${opts.reducedMotion === "reduce" ? ", reduced motion" : ""})`);
  const { context, page, requests, errors } = await open(browser, opts);
  const media = () => requests.filter((p) => p.startsWith("/changelog/img/cb/"));
  if (media().length) fail(`${label}: the page asked for dialog media at load: ${media().join(", ")}`);
  if (opts.shots) await page.screenshot({ path: path.join(OUT, `page-${opts.width}.png`), fullPage: true });
  const buttons = await page.$$eval("button.cbi", (bs) => bs.map((b, i) => ({ i, see: b.dataset.see, where: b.closest(".cbtoo") ? "top" : "entry", hidden: b.hidden, name: b.getAttribute("aria-label") })));
  console.log(`  ${buttons.length} buttons: ${buttons.map((b) => `${b.see}@${b.where}`).join(" ")}`);
  if (!(await page.$$eval("button.cbi", (bs) => bs.every((b) => b.offsetWidth > 0)))) fail(`${label}: a button isn't shown`);
  if (buttons.some((b) => !/^See what happens/.test(b.name ?? ""))) fail(`${label}: a button has no "See what happens" name`);
  const seen = new Set();
  for (const b of buttons) {
    const loc = page.locator("button.cbi").nth(b.i), before = media().length;
    // the keyboard to the button, Enter to open (as a keyboard user), or a click
    if (b.where === "entry") { await loc.focus(); await page.keyboard.press("Enter"); } else await loc.click();
    await page.waitForTimeout(300);
    let s = await state(page);
    if (!s.open) { fail(`${label} ${b.see}@${b.where}: no dialog`); continue; }
    const ready = await mediaReady(page);
    if (!ready) fail(`${label} ${b.see}@${b.where}: media didn't load`);
    await page.waitForTimeout(opts.reducedMotion === "reduce" ? 1500 : 1200);
    s = await state(page);
    const asked = media().slice(before);
    // (opened a second time, its stills may come from the browser's memory cache, with no request)
    if (!media().some((p) => p.includes(`/${b.see.replace(/^cb-/, "")}-`))) fail(`${label} ${b.see}: its media never loaded`);
    if (asked.some((p) => !p.includes(`/${b.see.replace(/^cb-/, "")}-`))) fail(`${label} ${b.see}: it loaded another visual's media: ${asked.join(", ")}`);
    if (!s.inView) fail(`${label} ${b.see}: the dialog isn't inside the window`);
    if (opts.width <= 400 && s.stacked === false) fail(`${label} ${b.see}: the two sides aren't stacked`);
    if (opts.reducedMotion === "reduce" && s.videos.some((v) => !v.paused)) fail(`${label} ${b.see}: a video plays with reduced motion`);
    if (opts.reducedMotion !== "reduce" && s.videos.some((v) => v.paused)) fail(`${label} ${b.see}: a video isn't playing`);
    if (s.videos.length && s.play === null) fail(`${label} ${b.see}: no Play/Pause button`);
    if (opts.shots && !seen.has(b.see)) await page.screenshot({ path: path.join(OUT, `dialog-${b.see}-${opts.width}.png`) });
    seen.add(b.see);
    // close: Esc (every one); the close button and a click outside on the top list's buttons
    const how = b.where === "entry" ? "esc" : b.i % 2 ? "button" : "outside";
    if (how === "esc") await page.keyboard.press("Escape");
    else if (how === "button") await page.locator("dialog.cbv .cbv-x").click();
    else await page.mouse.click(4, 4);
    await page.waitForTimeout(250);
    const after = await state(page);
    const want = `${b.see}@${b.where}`;
    console.log(`  ${want.padEnd(22)} "${s.title}" media ${asked.length} (${asked.map((p) => path.basename(p)).join(" ")}) ${s.videos.length ? `videos ${s.videos.map((v) => `${v.src} ${v.paused ? "paused" : "playing"} @${v.t}`).join(", ")} button "${s.play}"` : "stills"}${s.stacked !== null ? ` stacked ${s.stacked}` : ""} | ${how} -> open ${after.open}, focus ${after.focus}`);
    if (after.open) fail(`${label} ${want}: ${how} didn't close it`);
    if (after.focus !== want) fail(`${label} ${want}: after ${how} the focus is on ${after.focus}`);
  }
  // reduced motion: Play plays
  if (opts.reducedMotion === "reduce") {
    const loc = page.locator('button.cbi[data-see="cb-names"]').last();
    await loc.click();
    await mediaReady(page);
    await page.locator("dialog.cbv .cbv-play").click();
    await page.waitForTimeout(1500);
    const s = await state(page);
    console.log(`  reduced motion, after Play: ${s.videos.map((v) => `${v.paused ? "paused" : "playing"} @${v.t}`).join(", ")}, button "${s.play}"`);
    if (s.videos.some((v) => v.paused)) fail(`${label}: Play didn't play`);
    await page.keyboard.press("Escape");
  }
  if (errors.length) fail(`${label}: console errors: ${errors.join("; ")}`);
  const left = await playing(page);
  if (left.length) fail(`${label}: videos still playing at the end: ${left.join(", ")}`);
  await context.close();
  return seen;
};

// A dialog closed before its clips load, then another opened: the first one's clips must never start. The names
// clips are held back 6 s; the dialog gives up waiting for its clips after 4 s.
const closedEarly = async (browser) => {
  console.log("closed early (names clips held back 6 s)");
  const { context, page, errors } = await open(browser, { width: 1280, height: 860, hold: { test: /\/img\/cb\/names-[a-z]+\.(mp4|webm)$/, ms: 6000 } });
  const t0 = Date.now(), at = (ms) => page.waitForTimeout(Math.max(0, t0 + ms - Date.now()));
  await page.locator('button.cbi[data-see="cb-names"]').last().click();
  await at(500);
  await page.keyboard.press("Escape");
  await at(800);
  await page.locator('button.cbi[data-see="cb-playhead"]').last().click();
  // past the 4 s names would have waited
  await at(5200);
  const during = await playing(page);
  const shown = await page.evaluate(() => [...document.querySelectorAll("dialog.cbv video")].map((v) => v.currentSrc.split("/").pop()));
  await page.keyboard.press("Escape");
  // past the held names clips' answers
  await at(7500);
  const after = await playing(page), tracked = await page.evaluate(() => window.__cbVideos.size);
  console.log(`  while playhead is open, playing: ${during.join(", ") || "none"} | after it closed: ${after.join(", ") || "none"} (${tracked} videos tracked)`);
  const stray = during.filter((v) => !shown.includes(v.split(" ")[0]) || v.includes("removed"));
  if (stray.length) fail(`closed early: videos that aren't playhead's played while it was open: ${stray.join(", ")}`);
  if (after.length) fail(`closed early: videos still playing after every dialog closed: ${after.join(", ")}`);
  if (!during.length) fail("closed early: playhead's own clips didn't play");
  if (errors.length) fail(`closed early: console errors: ${errors.join("; ")}`);
  await context.close();
};

// without script: no "i" shows (it would do nothing), and nothing of the dialogs loads
const noScript = async (browser) => {
  const { context, page, requests } = await open(browser, { width: 1280, height: 860, script: false });
  const shown = await page.$$eval("button.cbi", (bs) => bs.filter((b) => b.offsetWidth > 0).length);
  console.log(`no script: ${shown} "i" shown, dialog media asked for: ${requests.filter((p) => p.startsWith("/changelog/img/cb/")).length}`);
  if (shown || requests.some((p) => p.startsWith("/changelog/img/cb/"))) fail("without script, an \"i\" shows or dialog media load");
  await context.close();
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  try {
    if (ONLY !== "closed-early") {
      await run(browser, "desktop", { width: 1280, height: 860, shots: true });
      await run(browser, "phone", { width: 375, height: 812, dpr: 2, mobile: true, shots: true });
      await run(browser, "reduced", { width: 1280, height: 860, reducedMotion: "reduce" });
    }
    await closedEarly(browser);
    if (ONLY !== "closed-early") await noScript(browser);
  } finally { await browser.close(); }
  console.log(failed ? "FAIL" : ONLY ? "PASS" : `PASS (screenshots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
