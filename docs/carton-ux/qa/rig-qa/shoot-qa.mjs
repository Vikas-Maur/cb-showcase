// Design QA shots (2026-11-03) on the QA page (make.mjs): the states the integrated rig doesn't shoot, plus editor
// compositions at the mockups' size (1522 × 810). Same conventions as gallery/capture/shoot.mjs: DPR 2, animations off
// unless asked, the mouse parked unless the shot keeps a hover.
//   CARTON_PLAYWRIGHT=… CARTON_CHROMIUM=… node shoot-qa.mjs <react pkg dir> <out dir> [--runtime react|preact] [--only re]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pw = process.env.CARTON_PLAYWRIGHT;
const { chromium } = require(join(pw, "playwright"));
const [reactDir, outDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const runtime = arg("--runtime", "react");
const only = arg("--only") ? new RegExp(arg("--only")) : null;
const out = runtime === "react" ? outDir : join(outDir, "preact");
mkdirSync(out, { recursive: true });
const page0 = pathToFileURL(join(reactDir, "gallery", "dist", "capture-qa", `capture.${runtime}.html`)).href;

const ED = { width: 1522, height: 810 }; // the mockups' editor size (1920 × 1020 at 125 %, title bar included)
const PANEL = (w) => ({ width: 290 + 640 + w + 380, height: 900 });
const STAGE = { width: 290 + 700 + 380, height: 900 };

// ------------------------------------------------------------------ helpers
const vrow = (p, text) => p.locator(".carton-version", { hasText: text }).first();
const menuItem = (p, text) => p.locator(".carton-menu-item", { hasText: text }).first();
async function foldOlder(p) {
  for (let i = 0; i < 6; i++) {
    const open = p.locator('.carton-day[aria-expanded="true"]').filter({ hasNotText: /^Today$/ });
    if (!(await open.count())) break;
    await open.first().click();
    await p.waitForTimeout(120);
  }
}
async function openCard(p, text) { await vrow(p, text).click(); await p.locator(".carton-card-version .carton-change, .carton-card-version .carton-card-confirm").first().waitFor(); await p.waitForTimeout(250); }
async function uxMenu(p, text) { const r = vrow(p, text); await r.hover(); await r.locator(".carton-version-more").click(); await p.waitForTimeout(150); }
async function playDirector(p) { await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(400); }
async function holdBefore(p, scope = ".carton-card-version") { const b = p.locator(`${scope} .carton-before`).first(); const box = await b.boundingBox(); await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(400); }
const side = (p, s) => p.locator(`.carton-conflict-side[data-side=${s}]`).first();
async function seeTheirs(p) { await side(p, "theirs").click(); await side(p, "theirs").locator(".carton-see").click(); await p.waitForTimeout(350); }
async function cutsFromChip(p) { await p.locator("[data-carton-cut]").first().click(); await p.locator(".carton-menu-pop").first().waitFor(); await p.waitForTimeout(250); }
async function dialog(p) { await p.locator(".carton-dialog").first().waitFor(); await p.waitForTimeout(250); }
async function changes(p, text = "Add captions to the interview") { await uxMenu(p, text); await menuItem(p, "Compare with your edit").click(); await p.locator(".carton-changes-view").first().waitFor(); await p.waitForTimeout(250); }

// target: window | panel | stage | dialog | titlebar (crop: the bar's rightmost `crop` px, or all) | sel (a selector)
const SHOTS = [];
const add = (name, s, how, steps, o = {}) => SHOTS.push({ name, s, how, steps, target: "window", viewport: ED, ...o });
const panel = (name, s, how, steps, o = {}) => { for (const w of [384, 300]) SHOTS.push({ name: `${name}-${w}`, s, w, how, steps, target: "panel", viewport: PANEL(w), ...o }); };
const stage = (name, s, how, steps, o = {}) => SHOTS.push({ name, s, how, steps, target: "stage", viewport: STAGE, ...o });
const dlg = (name, s, how, steps, o = {}) => SHOTS.push({ name, s, how, steps: async (p) => { await dialog(p); if (steps) await steps(p); }, target: "dialog", viewport: ED, ...o });
const bar = (name, s, how, steps, o = {}) => SHOTS.push({ name, s, how, steps, target: "titlebar", viewport: ED, crop: 900, ...o });

// ---------------------------------------------------------------- editor compositions (beside after/editor-*.png)
add("editor-default", "ux-history", "History open, Claude Code's newest turn opened (after/editor-default.png).", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); });
add("editor-play-newest", "ux-history", "The newest turn's card → Play all: plays on your edit, so no frame, no chip label.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(600); });
add("editor-viewing", "ux-history", "The Director's older turn → Play all (after/editor-viewing.png).", playDirector);
add("editor-before", "ux-history", "editor-viewing, then Before held (after/editor-before.png).", async (p) => { await playDirector(p); await holdBefore(p); }, { keepHover: true });
add("editor-edit-attempt", "ux-history", "editor-viewing, then an edit tried (the bridge's blocked()) (after/editor-edit-attempt.png).", async (p) => { await playDirector(p); await p.evaluate(() => window.__carton.blocked()); await p.waitForTimeout(150); });
add("editor-export-viewing", "ux-history", "editor-viewing, then Export opened (the bridge's beforeExport()): back to your edit first, with its toast.", async (p) => { await playDirector(p); await p.evaluate(() => window.__carton.beforeExport()); await p.waitForTimeout(400); });
add("editor-conflict-card", "qa-conflict", "Panel closed, two conflicts: the first card, yours picked.", null);
add("editor-conflict-theirs", "qa-conflict", "Claude Code's side → See it (after/editor-conflict-theirs.png).", seeTheirs);
add("editor-conflict-pill", "qa-conflict-panel", "History open with two conflicts: the pill (after/editor-conflict-pill.png).", foldOlder);
add("editor-other-cut", "ws1-other-cut", "On 30s Instagram cut, panel closed (after/editor-other-cut.png).", null);
add("editor-teammate-cut", "qa-teammate-window", "Leo's Main cut on screen with History open (after/history-teammate-cut + titlebar-teammate-cut).", null);
add("editor-chip-menu", "ws1-other-cut", "The chip clicked with the panel closed: History opens with its cuts menu (PLAN 2.2 v1).", cutsFromChip);
add("editor-comments-see", "ws59-comments", "Comments → See it as it was: the frame's label tab (History's list isn't on screen).", async (p) => { await p.locator('[role=tab][aria-label="Comments"]').click(); await p.waitForTimeout(250); await p.getByRole("button", { name: /See it as it was/ }).first().click(); await p.waitForTimeout(400); });
add("editor-play-fail", "ux-history", "Play all on an older version that can't load (the bridge's preview rejects): what the chip, frame and row say.", async (p) => { await p.evaluate(() => { window.__carton.preview = () => Promise.reject(new Error("load failed")); }); await playDirector(p); await p.waitForTimeout(800); });
add("editor-play-slow", "ux-history", "Play all on an older version that takes 3 s to load: shot at 1 s (the spinner after 300 ms).", async (p) => { await p.evaluate(() => { const orig = window.__carton.preview; window.__carton.preview = (...a) => new Promise((r) => setTimeout(() => r(orig(...a)), 3000)); }); await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(1000); });
add("editor-viewing-esc", "ux-history", "editor-viewing, then Esc: back to your edit (the marks go).", async (p) => { await playDirector(p); await p.keyboard.press("Escape"); await p.waitForTimeout(400); });
add("editor-viewing-close", "ux-history", "editor-viewing, then History closed with its ✕: back to your edit.", async (p) => { await playDirector(p); await p.locator("aside.carton-sidebar button[aria-label^=Close]").first().click(); await p.waitForTimeout(400); });
add("editor-shared", "qa-shared", "Shared, Leo and Mia here, panel closed.", null);
add("editor-live-media", "qa-live-media", "Offline with 3 changes, two clips arriving from Leo (after/stage-live-media.png).", null);
add("editor-narrow-1100", "ux-history", "A 1100 px window: Share joins History's head; the chip at 150 px.", foldOlder, { viewport: { width: 1100, height: 810 } });
add("editor-960", "ux-history", "A 960 px window with History open.", foldOlder, { viewport: { width: 960, height: 700 } });

// ---------------------------------------------------------------- title bar (the real page's report → the chip)
bar("titlebar-default", "qa-one-cut", "Main cut, nothing open (after/titlebar-default.png).", null);
bar("titlebar-other-cut", "ws1-other-cut", "30s Instagram cut (after/titlebar-other-cut.png).", null);
bar("titlebar-viewing", "ux-history", "Viewing the Director's turn (after/titlebar-viewing.png).", playDirector);
bar("titlebar-before", "ux-history", "Before held (the chip reads Before …).", async (p) => { await playDirector(p); await holdBefore(p); }, { keepHover: true });
bar("titlebar-teammate", "qa-teammate-window", "Leo's Main cut (after/titlebar-teammate-cut.png).", null);
bar("titlebar-shared", "qa-shared", "Shared, Leo and Mia here (after/titlebar-shared.png).", null);
bar("titlebar-offline", "qa-offline", "Offline, 3 changes not sent (after/titlebar-offline.png).", null);
bar("titlebar-conflict-see", "qa-conflict", "A conflict side seen: the chip's label.", seeTheirs);
for (const [n, s, steps] of [["main", "qa-shared", null], ["other", "ws1-other-cut", null], ["long-viewing", "qa-long-cut", null]])
  bar(`titlebar-960-${n}`, s, "A 960 px window with Windows' caption buttons: nothing overlaps (PLAN 2.3).", steps, { viewport: { width: 960, height: 700 }, crop: 0, q: "&win=1" });
bar("titlebar-960-viewing", "ux-history", "A 960 px window, viewing the Director's turn, caption buttons.", playDirector, { viewport: { width: 960, height: 700 }, crop: 0, q: "&win=1" });
bar("titlebar-1100", "qa-long-cut", "1100 px (< 1180): a long cut name cut at 150 px, Share gone from the bar (after/titlebar-narrow.png).", null, { viewport: { width: 1100, height: 700 }, crop: 0, q: "&win=1" });

// ---------------------------------------------------------------- stage (panel closed)
stage("conflict-card", "qa-conflict", "You and Claude Code both moved “Interview B”; a second card behind (after/conflict-card.png).", null);
stage("conflict-picked", "qa-conflict", "Claude Code's side picked: the stage doesn't change; Keep names the pick.", async (p) => { await side(p, "theirs").click(); await p.waitForTimeout(150); });
stage("conflict-theirs", "qa-conflict", "Claude Code's side → See it.", seeTheirs);
stage("conflict-both", "qa-conflict", "› to the second card, Both picked (after/conflict-keep-both.png).", async (p) => { await p.locator(".carton-conflict-next").first().click(); await p.waitForTimeout(150); await side(p, "both").click(); await p.waitForTimeout(150); });
stage("conflict-twice", "qa-conflict-twice", "Two of your own changes (after/conflict-same-person.png).", null);
stage("conflict-turn", "qa-conflict-turn", "Claude Code still working (after/conflict-during-turn.png).", null);
stage("conflict-again", "qa-conflict-again", "Claude Code changed it again after a pick: Pick again.", async (p) => { await side(p, "theirs").click(); await p.waitForTimeout(100); await p.evaluate(() => window.__again()); await p.waitForTimeout(250); });
stage("conflict-pill", "qa-conflict", "Not now: the pill (after/conflict-pill.png).", async (p) => { await p.getByRole("button", { name: "Not now" }).first().click(); await p.waitForTimeout(150); });
stage("conflict-old-words", "qa-conflict-old", "Cards built from today's engine summaries ('Intro' timing, 'W6' timing): how they read.", null);
stage("conflict-focus", "qa-conflict", "Keyboard: Tab into the card (focus ring), then ↓ to Claude Code's side.", async (p) => { await p.locator(".carton-conflict [role=radio]").first().focus(); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(150); });
stage("conflict-narrow", "qa-conflict", "A 360 px stage.", null, { viewport: { width: 290 + 360 + 380, height: 900 } });
stage("toast-warning", "stage-toast-warning", "A save that failed: the warning toast.", async (p) => { await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(100); });
stage("live-media", "qa-live-media", "The footage notice and the offline chip (after/stage-live-media.png).", null);

// ---------------------------------------------------------------- panel states the rig doesn't shoot
panel("history-group-open", "ux-history", "Your six changes' group opened: each one indented.", async (p) => { await foldOlder(p); await p.locator(".carton-version-group").first().click(); await p.waitForTimeout(200); });
panel("history-filter-on", "ux-history", "Filter → Agent turns: the removable chip under the cut bar.", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Agent turns").click(); await p.waitForTimeout(250); });
panel("history-filter-empty", "ux-empty", "Filter → Named versions on a history with none: the empty text.", async (p) => { await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Named versions").click(); await p.waitForTimeout(250); });
panel("history-card-more", "ux-history", "The Director's card → \"and N more\" clicked: all its rows.", async (p) => { await foldOlder(p); await openCard(p, "Add captions to the interview"); const more = p.locator(".carton-card-version").getByText(/more/).first(); if (await more.count()) { await more.click(); await p.waitForTimeout(200); } });
panel("history-restore-error", "qa-errors", "Restore… → Restore, and it fails: the card says so.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Restore…").click(); await p.locator(".carton-card-confirm").waitFor(); await p.locator(".carton-card-confirm .carton-btn", { hasText: "Restore" }).first().click(); await p.waitForTimeout(400); });
panel("history-undo-turn-error", "qa-errors", "Undo this turn fails: the card says so.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Undo this turn" }).click(); await p.waitForTimeout(400); });
panel("history-play-fail", "ux-history", "Play all on an older version, and the version can't load: the card says so.", async (p) => { await p.evaluate(() => { window.__carton.preview = () => Promise.reject(new Error("load failed")); }); await playDirector(p); await p.waitForTimeout(500); });
panel("history-offline-menu", "ux-offline", "⋯ on a change not sent yet.", async (p) => { await uxMenu(p, "Trimmed “Outro”"); });
panel("history-keyboard", "ux-history", "Keyboard: focus in the list, ↓ ↓ (the focus ring on a row).", async (p) => { await foldOlder(p); await p.locator(".carton-history-list").focus(); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(150); });
panel("history-keyboard-card", "ux-history", "Keyboard: ↓ to the Director's turn, Enter: its card.", async (p) => { await foldOlder(p); await p.locator(".carton-history-list").focus(); for (let i = 0; i < 4; i++) await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.waitForTimeout(300); });
panel("history-name", "ux-history", "⋯ → Name this version, \"Sent to client, Monday\" typed.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Name this version").click(); await p.keyboard.type("Sent to client, Monday"); await p.waitForTimeout(150); });
panel("history-start-row", "ux-history", "Scrolled to the bottom: the single start row.", async (p) => { await foldOlder(p); await p.locator(".carton-history-list").evaluate((e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll")); }); await p.waitForTimeout(300); });
panel("history-fold-row-menu", "ux-history", "⋯ on the partial fold: Fold in the rest.", async (p) => { await foldOlder(p); await uxMenu(p, "Folded in"); });
panel("cuts-one", "qa-one-cut", "One cut: the cuts menu.", async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(200); });
panel("teammate-fold", "ws6-teammate", "Leo's Main cut → Fold into Main cut…: the dialog.", async (p) => { await p.getByRole("button", { name: /Fold into/ }).first().click(); await p.locator(".carton-dialog").first().waitFor(); await p.waitForTimeout(300); }, { target: "window" });
panel("changes-play-older", "ux-history", "Changes view on the Director's turn, Play all, Before held.", async (p) => { await foldOlder(p); await changes(p); await p.locator(".carton-changes-view .carton-play-all .carton-btn").click(); await p.waitForTimeout(800); await holdBefore(p, ".carton-changes-view"); }, { keepHover: true });
panel("history-viewing-300-window", "ux-history", "Viewing, the window at the 300 px panel.", playDirector, { target: "window" });

panel("tip-undo-turn", "ux-history", "Hover on Undo this turn: its tooltip.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Undo this turn" }).hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true });
panel("tip-before", "ux-history", "Playing, hover on Before: its tooltip.", async (p) => { await playDirector(p); await p.locator(".carton-card-version .carton-before").first().hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true });
panel("tip-filter", "ux-history", "Hover on the filter button at the panel's right edge.", async (p) => { await p.locator(".carton-filter-btn").hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true });
panel("tip-viewing-x", "ux-history", "Viewing, hover on the row's ✕.", async (p) => { await playDirector(p); await p.locator(".carton-version-back").first().hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true });
// ---------------------------------------------------------------- dialogs
dlg("share-first", "qa-share-first", "Share, not shared yet: server and name typed (after/share-first.png).", async (p) => { await p.fill("#carton-share-host", "share.northlight.studio"); await p.fill("#carton-share-name", "Vikas"); await p.waitForTimeout(700); });
dlg("share-first-empty", "qa-share-first", "Share, not shared yet, nothing typed.", null);
dlg("share-submitted", "qa-share-first", "Share project pressed with nothing filled: the field errors.", async (p) => { await p.locator(".carton-dialog .carton-btn", { hasText: "Share project" }).first().click(); await p.waitForTimeout(250); });
dlg("share-known", "qa-share-known", "Not shared, the server and name known: one line with Change.", null);
dlg("share-code", "qa-share-code", "The server asks for an invite code.", async (p) => { await p.fill("#carton-share-host", "https://share.example.com"); await p.waitForTimeout(800); });
dlg("share-unreachable", "qa-share-unreachable", "The server can't be reached (after/share-unreachable.png).", async (p) => { await p.fill("#carton-share-host", "https://share.nowhere.test"); await p.waitForTimeout(800); });
dlg("share-owner", "qa-share-owner", "Shared, owner, Leo here with his Director working, Mia idle (after/share-owner.png).", null);
dlg("share-owner-link", "qa-share-owner", "share-owner, then Copy link.", async (p) => { await p.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true })); const b = p.locator(".carton-dialog .carton-btn", { hasText: /Copy link|Create link/ }).first(); if (await b.count()) { await b.click(); await p.waitForTimeout(300); } });
dlg("share-offline", "qa-share-offline", "Shared and offline, 3 changes waiting (after/share-offline.png).", null);
dlg("share-editor", "qa-share-editor", "Joined as an editor: no invite.", null);
dlg("share-update", "qa-share-update", "The server needs an update.", null);
add("join", "join", "The Dashboard's Join dialog (after/join-dialog.png).", null, { viewport: { width: 1280, height: 800 } });
add("join-errors", "join", "Join and open pressed with nothing filled in.", async (p) => { await p.locator(".carton-join-dialog .carton-btn").last().click(); await p.waitForTimeout(250); }, { viewport: { width: 1280, height: 800 } });
add("join-filled", "join", "The invite link pasted.", async (p) => { await p.fill("#carton-join-link", "https://share.example.com/p/7f3a9c#join=ct1.editor.Zk9QmV2xL0aT8bWn4RjYc"); await p.waitForTimeout(200); }, { viewport: { width: 1280, height: 800 } });

// ------------------------------------------------------------------ run
const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
const manifest = [];
try {
  for (const shot of SHOTS) {
    if (only && !only.test(shot.name)) continue;
    const vp = shot.viewport;
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/ERR_FILE_NOT_FOUND/.test(m.text()) && errs.push(`console: ${m.text()}`));
    const file = `${shot.name}.png`;
    try {
      await page.goto(`${page0}?s=${shot.s}&w=${shot.w ?? 384}${shot.q ?? ""}`);
      await page.waitForFunction(() => window.__cap?.ready, null, { timeout: 8000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      if (shot.steps) await shot.steps(page);
      if (!shot.keepHover) await page.mouse.move(vp.width - 5, vp.height - 5);
      await page.waitForTimeout(200);
      const path = join(out, file);
      if (shot.target === "window") await page.screenshot({ path, animations: "disabled" });
      else if (shot.target === "dialog") await page.locator(".carton-dialog").first().screenshot({ path, animations: "disabled" });
      else if (shot.target === "titlebar") {
        const b = await page.locator(".cap-titlebar").boundingBox();
        const x = shot.crop ? Math.max(0, b.width - shot.crop) : 0;
        await page.screenshot({ path, animations: "disabled", clip: { x, y: b.y, width: b.width - x, height: b.height } });
      } else {
        const sel = shot.target === "panel" ? "aside.carton-sidebar" : "[data-carton-stage-host]";
        await page.locator(sel).first().screenshot({ path, animations: shot.anim ? "allow" : "disabled" });
      }
      manifest.push({ file, name: shot.name, scenario: shot.s, how: shot.how, errors: errs });
    } catch (e) {
      errs.push(`capture failed: ${e.message.split("\n")[0]}`);
      manifest.push({ file: null, name: shot.name, scenario: shot.s, how: shot.how, errors: errs });
    }
    if (errs.length) console.log(`${file}: ${errs.join(" | ")}`);
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(join(out, "qa-shots.json"), JSON.stringify({ runtime, shots: manifest }, null, 2));
console.log(`${manifest.filter((m) => m.file).length} of ${manifest.length} QA shots in ${out}`);
