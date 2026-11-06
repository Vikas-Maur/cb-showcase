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
// - The "Still in Cardboard" bar: its count is the page's bugs (its red cards, each listed item of a card that lists
//   several); it shows only the red cards, each under its update's date, number and title, and back; the reader's
//   place is kept; ?only=cardboard, #cardboard-too and #cb-… addresses work in both views; it is one tab stop whose
//   arrows, Home and End move the choice, with a focus ring; nothing moves with reduced motion; and at the page's end
//   no text is under it, at 1280 and 375 px.
// - Screenshots: the page at 1280 and 375 px wide, every dialog open at both widths, and the page's top and end in both
//   views at both widths (filter-<width>-<all|cardboard>-<top|bottom>.png).
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
const open = async (browser, { width, height, dpr = 1, reducedMotion = "no-preference", mobile = false, script = true, hold = null, suffix = "" }) => {
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
  await page.goto(`${ORIGIN}/changelog/${suffix}`, { waitUntil: "load" });
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
    focus: a?.dataset?.see ?? a?.tagName,
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
  const buttons = await page.$$eval("button.cbi", (bs) => bs.map((b, i) => ({ i, see: b.dataset.see, inEntry: !!b.closest("article section.also"), name: b.getAttribute("aria-label") })));
  console.log(`  ${buttons.length} buttons: ${buttons.map((b) => b.see).join(" ")}`);
  if (buttons.length !== 8 || buttons.some((b) => !b.inEntry) || new Set(buttons.map((b) => b.see)).size !== 8) fail(`${label}: expected 8 "i" buttons, one per visual, all in the entries' red cards`);
  if (!(await page.$$eval("button.cbi", (bs) => bs.every((b) => b.offsetWidth > 0)))) fail(`${label}: a button isn't shown`);
  if (buttons.some((b) => !/^See what happens/.test(b.name ?? ""))) fail(`${label}: a button has no "See what happens" name`);
  const seen = new Set();
  // close it one way, then check it's closed and the keyboard is back on its "i"
  const close = async (b, how) => {
    if (how === "esc") await page.keyboard.press("Escape");
    else if (how === "button") await page.locator("dialog.cbv .cbv-x").click();
    else await page.mouse.click(4, 4);
    await page.waitForTimeout(250);
    const after = await state(page);
    if (after.open) fail(`${label} ${b.see}: ${how} didn't close it`);
    if (after.focus !== b.see) fail(`${label} ${b.see}: after ${how} the focus is on ${after.focus}`);
    return `${how} -> open ${after.open}, focus ${after.focus}`;
  };
  for (const b of buttons) {
    const loc = page.locator("button.cbi").nth(b.i), before = media().length;
    // the keyboard to the button and Enter to open (as a keyboard user)
    await loc.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    let s = await state(page);
    if (!s.open) { fail(`${label} ${b.see}: no dialog`); continue; }
    const ready = await mediaReady(page);
    if (!ready) fail(`${label} ${b.see}: media didn't load`);
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
    // Esc for every one; then opened again with a click, and closed by the close button or a click outside
    const r1 = await close(b, "esc");
    await loc.click();
    await page.waitForTimeout(300);
    const r2 = (await state(page)).open ? await close(b, b.i % 2 ? "button" : "outside") : (fail(`${label} ${b.see}: a click didn't open it`), "no dialog");
    console.log(`  ${b.see.padEnd(14)} "${s.title}" media ${asked.length} (${asked.map((p) => path.basename(p)).join(" ")}) ${s.videos.length ? `videos ${s.videos.map((v) => `${v.src} ${v.paused ? "paused" : "playing"} @${v.t}`).join(", ")} button "${s.play}"` : "stills"}${s.stacked !== null ? ` stacked ${s.stacked}` : ""} | ${r1} | ${r2}`);
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
    await page.waitForTimeout(300);
  }
  if (errors.length) fail(`${label}: console errors: ${errors.join("; ")}`);
  const left = await playing(page);
  if (left.length) fail(`${label}: videos still playing at the end: ${left.join(", ")}`);
  await context.close();
  return seen;
};

// ---------------------------------------------------------------------------------------------------------------
// The "Still in Cardboard" filter bar
const view = (page) => page.evaluate(() => {
  const vis = (e) => !!e && e.getClientRects().length > 0;
  const arts = [...document.querySelectorAll("main article")], cards = [...document.querySelectorAll("main section.also")];
  const bugs = cards.reduce((n, c) => n + (c.querySelectorAll("li[id^='cb-']").length || 1), 0);
  // each bug's own address: a card's, or each item's of a card that lists several
  const ids = [...document.querySelectorAll("main [id^='cb-']")].filter((e) => !e.querySelector("li[id^='cb-']")).map((e) => e.id);
  const opts = [...document.querySelectorAll(".cbf-opt")], a = document.activeElement, g = document.querySelector(".cbf-group");
  return {
    on: document.documentElement.classList.contains("only-cb"), url: location.pathname + location.search + location.hash, y: Math.round(scrollY),
    note: vis(document.getElementById("cardboard-too")),
    articles: arts.filter(vis).map((x) => x.id).join(","), withCards: arts.filter((x) => x.querySelector("section.also")).map((x) => x.id).join(","), all: arts.map((x) => x.id).join(","),
    // in a shown update, what shows besides its title and its red cards
    extra: arts.filter(vis).flatMap((x) => [...x.querySelectorAll(":scope > div > *")].filter((e) => vis(e) && e.tagName !== "H2" && !e.matches("section.also")).map((e) => `${x.id}:${e.tagName.toLowerCase()}`)),
    headers: arts.filter(vis).every((x) => vis(x.querySelector("aside time")) && vis(x.querySelector("aside .tag")) && vis(x.querySelector(":scope > div > h2"))),
    cards: cards.length, cardsShown: cards.filter(vis).length, bugs, ids: ids.length, idsShown: ids.filter((id) => vis(document.getElementById(id))).length,
    count: document.querySelector(".cbf-n")?.textContent ?? null, name: opts[1]?.getAttribute("aria-label") ?? null,
    checked: opts.map((o) => o.getAttribute("aria-checked")).join(","), tabs: opts.map((o) => o.tabIndex).join(","),
    live: document.getElementById("cbf-live")?.textContent ?? null,
    focus: a?.dataset?.view ?? a?.tagName, focusRing: !!a?.matches?.(".cbf-opt:focus-visible") && getComputedStyle(a).outlineStyle !== "none",
    bar: vis(g) ? (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(g.getBoundingClientRect()) : null,
    animations: document.getAnimations().length, thumbTransition: g ? getComputedStyle(g.querySelector(".cbf-thumb")).transitionDuration : null,
  };
});
const inView = (page, id) => page.evaluate((id) => { const e = document.getElementById(id); if (!e || !e.getClientRects().length) return false; const r = e.getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight - 60; }, id);
// at the page's end: any text under the bar, and the space between the last text and the bar
const atEnd = async (page) => {
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const bar = document.querySelector(".cbf-group").getBoundingClientRect(), hits = [];
    let last = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) {
      if (!n.textContent.trim() || n.parentElement.closest(".cbf, dialog, template, script, style, .vh")) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) {
        if (!q.width || !q.height) continue;
        last = Math.max(last, q.bottom);
        if (q.bottom > bar.top && q.top < bar.bottom && q.right > bar.left && q.left < bar.right) hits.push(n.textContent.trim().slice(0, 40));
      }
    }
    return { hits, gap: Math.round(bar.top - last) };
  });
};
const checkAll = (label, v) => {
  if (v.on || v.note || v.articles !== v.all || !v.extra.length || v.cardsShown !== v.cards || v.idsShown !== v.ids || v.checked !== "true,false" || v.tabs !== "0,-1" || /only=/.test(v.url)) fail(`${label}: not the whole page: ${JSON.stringify(v)}`);
};
const checkCardboard = (label, v) => {
  if (!v.on || !v.note || v.articles !== v.withCards || v.extra.length || !v.headers || v.cardsShown !== v.cards || v.idsShown !== v.ids || v.checked !== "false,true" || v.tabs !== "-1,0") fail(`${label}: not only the Cardboard bugs under their updates: ${JSON.stringify(v)}`);
};

const filterBar = async (browser, opts) => {
  const W = opts.width;
  console.log(`filter bar (${W} px)`);
  const { context, page, errors } = await open(browser, opts);
  let v = await view(page);
  console.log(`  count "${v.count}" (${v.cards} red cards, ${v.bugs} bugs, ${v.ids} bug addresses), name "${v.name}", ${v.articles.split(",").length} updates shown`);
  if (!v.bar) fail(`${W}: no bar`);
  if (v.count !== String(v.bugs) || v.bugs !== v.ids || v.bugs < v.cards || v.name !== `Still in Cardboard: ${v.bugs} bugs`) fail(`${W}: the count isn't the page's: ${JSON.stringify(v)}`);
  checkAll(`${W} at load`, v);
  if (opts.shots) await page.screenshot({ path: path.join(OUT, `filter-${W}-all-top.png`) });
  let end = await atEnd(page);
  console.log(`  whole page, at its end: ${end.hits.length} text under the bar, ${end.gap} px between the last text and the bar`);
  if (end.hits.length || end.gap < 8) fail(`${W}: the bar covers the page's end: ${JSON.stringify(end)}`);
  if (opts.shots) await page.screenshot({ path: path.join(OUT, `filter-${W}-all-bottom.png`) });
  // from the top: the page stays still
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.locator('.cbf-opt[data-view="cardboard"]').click();
  await page.waitForTimeout(400);
  v = await view(page);
  console.log(`  "Still in Cardboard": ${v.url}, updates ${v.articles}, ${v.cardsShown}/${v.cards} cards, ${v.idsShown}/${v.ids} bugs shown, other text shown ${v.extra.length}, scroll ${v.y}, live "${v.live}"`);
  checkCardboard(`${W} after a click`, v);
  if (!/[?&]only=cardboard\b/.test(v.url) || v.y !== 0 || !v.live?.includes(String(v.bugs)) || v.focus !== "cardboard") fail(`${W}: after the click: ${JSON.stringify(v)}`);
  if (opts.shots) await page.screenshot({ path: path.join(OUT, `filter-${W}-cardboard-top.png`) });
  end = await atEnd(page);
  console.log(`  "Still in Cardboard", at its end: ${end.hits.length} text under the bar, ${end.gap} px between the last text and the bar`);
  if (end.hits.length || end.gap < 8) fail(`${W}: the bar covers the filtered page's end: ${JSON.stringify(end)}`);
  if (opts.shots) await page.screenshot({ path: path.join(OUT, `filter-${W}-cardboard-bottom.png`) });
  // the reader's place: a red card in view stays where it is on screen, both ways
  for (const [to, id] of [["all", "cb-saves"], ["cardboard", "cb-saves"]]) {
    await page.evaluate((id) => { const e = document.getElementById(id); scrollBy(0, e.getBoundingClientRect().top - innerHeight / 3); }, id);
    await page.waitForTimeout(150);
    const before = await page.evaluate((id) => Math.round(document.getElementById(id).getBoundingClientRect().top), id);
    await page.locator(`.cbf-opt[data-view="${to}"]`).click();
    await page.waitForTimeout(400);
    const after = await page.evaluate((id) => Math.round(document.getElementById(id).getBoundingClientRect().top), id);
    console.log(`  to "${to}" with #${id} on screen: its top ${before} -> ${after} px`);
    if (Math.abs(after - before) > 2) fail(`${W}: switching to ${to} moved #${id} on screen (${before} -> ${after})`);
  }
  // reading an update with no red card (#5): the list starts at the top of the window
  await page.locator('.cbf-opt[data-view="all"]').click();
  await page.evaluate(() => document.getElementById("5").scrollIntoView());
  await page.waitForTimeout(150);
  await page.locator('.cbf-opt[data-view="cardboard"]').click();
  await page.waitForTimeout(400);
  const top = await page.evaluate(() => Math.round(document.getElementById("cardboard-too").getBoundingClientRect().top));
  console.log(`  to "cardboard" while reading #5 (no red card): the view's note at ${top} px`);
  if (top < 0 || top > 60) fail(`${W}: from #5 the list doesn't start at the top (note at ${top} px)`);
  // the keyboard: Shift+Tab from the page's start reaches the chosen option (the group is one tab stop); the arrows,
  // Home and End move the choice and the keyboard together, with a visible focus ring
  await page.locator('.cbf-opt[data-view="all"]').click();
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.keyboard.press("Shift+Tab");
  const keys = [];
  v = await view(page);
  keys.push(`Shift+Tab: ${v.focus}${v.focusRing ? " (ring)" : ""}`);
  if (v.focus !== "all" || !v.focusRing) fail(`${W}: Shift+Tab didn't reach the chosen option with a ring (${v.focus}, ${v.focusRing})`);
  for (const [k, want] of [["ArrowRight", "cardboard"], ["ArrowLeft", "all"], ["End", "cardboard"], ["Home", "all"], ["ArrowDown", "cardboard"], ["ArrowDown", "all"]]) {
    await page.keyboard.press(k);
    await page.waitForTimeout(200);
    v = await view(page);
    keys.push(`${k}: ${v.focus}/${v.on ? "cardboard" : "all"}${v.focusRing ? " (ring)" : ""}`);
    if (v.focus !== want || v.on !== (want === "cardboard") || !v.focusRing) fail(`${W}: ${k} gave ${v.focus}, view ${v.on ? "cardboard" : "all"}, ring ${v.focusRing}; expected ${want}`);
    want === "cardboard" ? checkCardboard(`${W} after ${k}`, v) : checkAll(`${W} after ${k}`, v);
  }
  console.log(`  keys: ${keys.join(" | ")}`);
  // a link to #cardboard-too on the page turns the view on
  await page.evaluate(() => { location.hash = "#cardboard-too"; });
  await page.waitForTimeout(400);
  v = await view(page);
  if (!v.on || !(await inView(page, "cardboard-too"))) fail(`${W}: going to #cardboard-too didn't turn the view on (${JSON.stringify(v)})`);
  // the motion: the switch fades in (here), the reduced-motion run checks there is none
  await page.locator('.cbf-opt[data-view="all"]').click();
  const moving = await page.evaluate(() => document.getAnimations().length);
  if (!moving) fail(`${W}: no fade when switching (so the reduced-motion check proves nothing)`);
  if (errors.length) fail(`${W}: console errors: ${errors.join("; ")}`);
  await context.close();
};

// addresses: each loaded fresh
const filterUrls = async (browser) => {
  console.log("filter addresses");
  for (const [suffix, on, target] of [["?only=cardboard", true, null], ["#cardboard-too", true, "cardboard-too"], ["?only=cardboard#cb-gpu", true, "cb-gpu"], ["#cb-gpu", false, "cb-gpu"], ["?only=cardboard#cb-idle", true, "cb-idle"], ["?only=cardboard#5", false, "5"]]) {
    const { context, page, errors } = await open(browser, { width: 1280, height: 860, suffix });
    await page.waitForTimeout(300);
    const v = await view(page), seen = target ? await inView(page, target) : null;
    console.log(`  ${suffix.padEnd(26)} -> view ${v.on ? "cardboard" : "all"}${target ? `, #${target} ${seen ? "in view" : "NOT in view"}` : ""}, address ${v.url}`);
    on ? checkCardboard(suffix, v) : checkAll(suffix, v);
    if (target && !seen) fail(`${suffix}: #${target} isn't in view`);
    if (errors.length) fail(`${suffix}: console errors: ${errors.join("; ")}`);
    await context.close();
  }
};

// reduced motion: no fade, no sliding, no entrance
const filterCalm = async (browser) => {
  const { context, page } = await open(browser, { width: 1280, height: 860, reducedMotion: "reduce" });
  await page.locator('.cbf-opt[data-view="cardboard"]').click();
  const v = await view(page);
  console.log(`filter with reduced motion: ${v.animations} animations right after a switch, the thumb's transition ${v.thumbTransition}`);
  if (v.animations || v.thumbTransition !== "0s") fail(`reduced motion: something moves (${v.animations} animations, transition ${v.thumbTransition})`);
  checkCardboard("reduced motion", v);
  await context.close();
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
  const v = await view(page);
  console.log(`no script: ${shown} "i" shown, dialog media asked for: ${requests.filter((p) => p.startsWith("/changelog/img/cb/")).length}, bar ${v.bar ? "shown" : "not shown"}, ${v.articles.split(",").length} updates and ${v.cardsShown} red cards shown, the view's note ${v.note ? "shown" : "not shown"}`);
  if (shown || requests.some((p) => p.startsWith("/changelog/img/cb/"))) fail("without script, an \"i\" shows or dialog media load");
  if (v.bar || v.note || v.articles !== v.all || v.cardsShown !== v.cards) fail(`without script: not the whole page, or a bar (${JSON.stringify(v)})`);
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
    if (ONLY !== "closed-early") {
      await filterBar(browser, { width: 1280, height: 860, shots: true });
      await filterBar(browser, { width: 375, height: 812, dpr: 2, mobile: true, shots: true });
      await filterUrls(browser);
      await filterCalm(browser);
      await noScript(browser);
    }
  } finally { await browser.close(); }
  console.log(failed ? "FAIL" : ONLY ? "PASS" : `PASS (screenshots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
