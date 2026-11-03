// Screenshot every Carton state in the capture page (gallery/capture/entry.js), driven like a person would: clicks,
// hovers, typing. Panel states at each panel width, stage and title-bar states once. Writes the PNGs, shots.json (what
// each shows and how it was made) and the page errors seen.
//   CARTON_PLAYWRIGHT=<dir with node_modules/playwright>  CARTON_CHROMIUM=<chrome>  CARTON_SHOTS=<out dir>
//   node gallery/capture/shoot.mjs [--runtime react|preact] [--only <regex>] [--widths 384,300] [--timeout <ms>] [--list]
// Adding a state: see states/README.md (a scenario in states/<feature>.js, its shot in states/<feature>.shots.mjs; no
// shared list to edit).
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ws59Shots } from "./ws59-shots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pw = process.env.CARTON_PLAYWRIGHT;
const { chromium } = require(pw ? join(pw, pw.endsWith("node_modules") ? "" : "node_modules", "playwright") : "playwright");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const runtime = arg("--runtime", "react");
const only = arg("--only") ? new RegExp(arg("--only")) : null;
const WIDTHS = arg("--widths", "384,300").split(",").map(Number);
// how long one step may wait for what it expects (Playwright's default is 30 s: a state whose page changed under it
// then costs half a minute before it says so)
const TIMEOUT = Number(arg("--timeout", 10_000));
const out = process.env.CARTON_SHOTS ?? join(here, "..", "dist", "capture", "shots", runtime);
mkdirSync(out, { recursive: true });
const page0 = pathToFileURL(join(here, "..", "dist", "capture", `capture.${runtime}.html`)).href;

// Window: rail + library (290) + stage (640) + panel + chat (380), 900 tall, like a 1080p window at 125 %.
const viewport = (w) => ({ width: 290 + 640 + w + 380, height: 900 });

// ------------------------------------------------------------------ helpers for the steps
// A row by its title: exact for a short one ("Rough cut" is also inside "Restored 'Rough cut'"), else by substring.
const row = (p, text, exact = false) => (exact ? p.locator(".carton-version").filter({ has: p.locator(".carton-version-text", { hasText: new RegExp(`^${text}$`) }) }) : p.locator(".carton-version", { hasText: text })).first();
async function rowMenu(p, text, exact = text === "Rough cut") {
  const r = row(p, text, exact);
  await r.hover();
  await r.locator(".carton-version-more").click();
  await p.waitForTimeout(150);
}
const menuItem = (p, text) => p.locator(".carton-menu-item", { hasText: text }).first();
const tab = (p, name) => p.locator(`[role=tab][aria-label="${name}"]`).click();
async function cutsMenu(p) { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(150); }
async function foldFromIg(p) { await cutsMenu(p); await menuItem(p, "Fold in changes from a cut…").click(); await p.locator(".carton-fold .carton-fold-box, .carton-fold .carton-fold-nothing").first().waitFor(); await p.waitForTimeout(150); }
async function scrollList(p, y) { await p.locator(".carton-history-list").evaluate((e, y) => { e.scrollTop = Math.min(y, e.scrollHeight); e.dispatchEvent(new Event("scroll")); }, y); await p.waitForTimeout(300); }
// Workstream 4: the Changes view from a row's menu, Play all, Before held (a press with no release yet)
async function changes(p, text = "Add captions to the interview") { await rowMenu(p, text); await menuItem(p, "Compare with your edit").click(); await p.locator(".carton-changes-view").first().waitFor(); await p.waitForTimeout(250); }
async function playAll(p, ms = 1300) { await p.locator(".carton-changes-view .carton-play-all .carton-btn").click(); await p.waitForTimeout(ms); }
async function holdBefore(p, scope = ".carton-changes-view") { const b = p.locator(`${scope} .carton-before`).first(); const box = await b.boundingBox(); await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(300); }

// ------------------------------------------------------------------ the shots
// target: panel (the side panel, full height), stage (the layer over the preview), window, titlebar, join (the dialog).
// perWidth: shot at each panel width. how: the steps in words, for INDEX.md.
const P = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "panel", perWidth: true, ...o });
// Stage shots with the side panel closed: a window whose stage is 700 px wide (the panel's room goes to the stage).
const T = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "stage", perWidth: false, viewport: o.panelOpen || o.perWidth ? undefined : { width: 290 + 700 + 380, height: 900 }, ...o });
// The redesign's History (docs/carton-ux workstream 3): the after shots, one per mockup (after/history-*.png).
const vrow = (p, text) => p.locator(".carton-version", { hasText: text }).first();
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
const AFTER = [
  P("after-history-default", "ux-history", "The story: Claude Code's turn Now, your six changes as one row, the Director's turn, Sent to client, a fold, a restore, Codex; older days folded.", foldOlder),
  P("after-history-expanded", "ux-history", "after-history-default, then a click on Claude Code's turn (the newest): its card, with the first change hovered.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-change").first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
  P("after-history-older", "ux-history", "A click on the Director's older turn: \"Your edit has 7 changes since this\", its map and rows, Play all, Restore….", async (p) => { await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-change").first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
  P("after-history-restore", "ux-history", "⋯ on your six changes → Restore…: the confirmation in the card.", async (p) => { await foldOlder(p); await uxMenu(p, "Moved “Interview B” 2 s later"); await menuItem(p, "Restore…").click(); await p.locator(".carton-card-confirm").waitFor(); await p.waitForTimeout(250); }),
  P("after-history-menu", "ux-history", "⋯ on the Director's turn: Play its changes, Compare with your edit, Name, New cut, Restore….", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Play its changes").hover(); await p.waitForTimeout(120); }, { keepHover: true }),
  P("after-history-filter", "ux-history", "The filter menu, with \"Interview B\" selected on the timeline (Only “Interview B”).", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Agent turns").hover(); await p.waitForTimeout(120); }, { keepHover: true }),
  P("after-history-clip", "ux-clip", "Filter → Only “Interview B”: the chip, the clip's credits, the versions that touched it.", async (p) => { await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Only “Interview B”").click(); await p.waitForTimeout(400); }),
  P("after-history-many", "ux-many", "430 versions over five days: the older days folded with their counts; scrolled a little, ↑ Newest docked at the bottom.", async (p) => { await p.locator(".carton-day", { hasText: "Yesterday" }).click(); await p.waitForTimeout(200); await scrollList(p, 900); }),
  P("after-history-working", "ux-working", "The Director working (a turn holding the timeline): the live row on top with its line.", foldOlder),
  P("after-history-offline", "ux-offline", "Offline: your three changes not sent yet, Leo's, the Director's.", null),
  P("after-history-empty", "ux-empty", "Nothing of yours yet, only the project's start.", null),
  P("after-history-loading", "ux-loading", "The worker hasn't answered yet: three grey rows.", null),
  P("after-history-viewing", "ux-history", "The Director's card → Play all: viewing it (the row's \"Viewing ✕\").", async (p) => { await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(300); }),
  P("after-history-cuts-rename", "ws6-cuts", "The cuts menu in History's cut bar → Rename “Main cut”: the form inside the menu, across the bar.", async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(150); await p.locator(".carton-menu-item", { hasText: "Rename" }).first().click(); await p.waitForTimeout(150); }),
  P("after-history-newcut", "ux-history", "⋯ on the Director's turn → New cut from this version…: the name field in the card.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "New cut from this version").click(); await p.keyboard.type("30s Instagram cut"); await p.waitForTimeout(150); }),
];
// workstreams 5 and 9 (toasts with Undo, Comments), beside after/toasts.png and comments-*.png
const WS59 = ws59Shots({ P, T, menuItem, foldOlder, uxMenu, openCard, cutsMenu, tab });
// Viewing without banners (docs/carton-ux workstream 1): beside after/editor-viewing.png, editor-edit-attempt.png,
// editor-conflict-theirs.png, editor-other-cut.png, titlebar-viewing.png (history-viewing-*.png: after-history-viewing).
const W = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "window", perWidth: false, ...o });
// The title bar (its rightmost `crop` px, default 560; 0: all of it; `q: "&win=1"` adds Windows' caption buttons) and a
// dialog (the shot waits for it to open, then runs the steps). ED: the mockups' editor size (1920 × 1020 at 125 %).
const ED = { width: 1522, height: 810 };
const B = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "titlebar", perWidth: false, viewport: ED, crop: 900, ...o });
const D = (name, s, how, steps, o = {}) => ({ name, s, how, steps: async (p) => { await p.locator(".carton-dialog").first().waitFor(); await p.waitForTimeout(250); if (steps) await steps(p); }, target: "dialog", perWidth: false, viewport: ED, ...o });
async function playDirector(p) { await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(400); }
async function seeTheirs(p) { await p.locator(".carton-stack .carton-see, .carton-stack button", { hasText: "See it" }).nth(1).click(); await p.waitForTimeout(400); }
const WS1 = [
  W("ws1-editor-viewing", "ux-history", "History open; the Director's older turn → Play all: the chip, the stage's frame, the timeline's frame (clips muted) and the row's “Viewing ✕”, one label; nothing over the picture.", playDirector),
  W("ws1-editor-before", "ux-history", "ws1-editor-viewing, then Before held on the card: how it was before the Director's turn, the same marks, the chip and the row saying Before.", async (p) => { await playDirector(p); const b = p.locator(".carton-card-version .carton-before"); const box = await b.boundingBox(); await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(400); }, { keepHover: true }),
  W("ws1-editor-edit-attempt", "ux-history", "ws1-editor-viewing, then an edit tried (the bridge's blocked(), as Cardboard's refusal asks it): one line with Back to my edit and Esc; the frame pulses (shot mid-pulse).", async (p) => { await playDirector(p); await p.evaluate(() => window.__carton.blocked()); await p.waitForTimeout(150); }, { keepAnimations: true }),
  W("ws1-editor-conflict-theirs", "ws1-conflict", "Panel closed; the “Interview B” card → See it on Claude Code's side: the frame's label tab names it (History's list isn't on screen).", seeTheirs),
  W("ws1-editor-other-cut", "ws1-other-cut", "Panel closed, on 30s Instagram cut: the chip's dot, and the cut's name and dot in the timeline's toolbar beside the zoom.", null),
  W("ws1-editor-comments-see", "ux-history", "Comments open, a version viewed without a row (as Comments' See it as it was views one): the frame's label tab.", async (p) => { await p.locator('[role=tab][aria-label="Comments"]').click(); await p.waitForTimeout(200); await p.evaluate(() => window.__cap.ui.view({ kind: "version", ref: "main@20", label: "Your edit from 11:02 am" })); await p.waitForTimeout(300); }),
  { name: "ws1-titlebar-viewing", s: "ux-history", how: "The title bar while viewing the Director's turn: the chip's second part, 👁 label ✕.", target: "titlebar", steps: playDirector },
];
// Workstream 4: the Changes view, Play and Before (after/changes-384.png, changes-300.png, changes-playing-384.png, changes-none-384.png)
const WS4 = [
  P("changes", "changes-story", "History, ⋯ → Compare with your edit on the Director's “Add captions to the interview”: the Changes view in place of the list.", (p) => changes(p)),
  P("changes-playing", "changes-story", "changes, then Play all, shot 1.3 s into playback (on your edit: nothing viewed).", async (p) => { await changes(p); await playAll(p); }),
  P("changes-before", "changes-story", "changes-playing, then Before pressed and held.", async (p) => { await changes(p); await playAll(p); await holdBefore(p); }, { keepHover: true }),
  P("changes-none", "changes-story", "⋯ → Compare with your edit on the newest version (Claude Code's turn): no differences.", (p) => changes(p, "Tighten the intro and add a lower third")),
  P("changes-two", "changes-story", "A click on “Sent to client”, then Shift+click on the Director's turn: the Changes view between two versions.", async (p) => { await row(p, "Sent to client").click(); await row(p, "Add captions to the interview").click({ modifiers: ["Shift"] }); await p.locator(".carton-changes-view").first().waitFor(); await p.waitForTimeout(250); }),
];
// Workstream 6: the cuts menu and Fold in, redesigned (PLAN 6.1–6.3)
const WS6 = [
  P("ws6-cuts-menu", "ws6-cuts", "History's cut button → the cuts menu: who and when per cut, dots, From teammates (View only), one Fold entry, the agents line.", (p) => cutsMenu(p)),
  P("ws6-cuts-menu-turn", "ws6-cuts-turn", "Claude Code working on Main cut; the cuts menu, then a click on 30s Instagram cut: it opens in place with Switch when it finishes / Switch now.", async (p) => { await cutsMenu(p); await p.locator(".carton-cut-item", { hasText: "30s Instagram cut" }).click(); await p.waitForTimeout(150); }),
  P("ws6-cuts-queued", "ws6-cuts-turn", "ws6-cuts-menu-turn, then Switch when it finishes: the queued line under the cut bar.", async (p) => { await cutsMenu(p); await p.locator(".carton-cut-item", { hasText: "30s Instagram cut" }).click(); await p.waitForTimeout(100); await p.getByRole("menuitem", { name: "Switch when it finishes" }).click(); await p.waitForTimeout(150); }),
  P("ws6-cuts-many", "ws6-cuts-many", "15 cuts: the menu's list scrolls (past 8) and has a search (past 12).", (p) => cutsMenu(p)),
  P("ws6-cuts-search", "ws6-cuts-many", "ws6-cuts-many, then \"trail\" typed in the search.", async (p) => { await cutsMenu(p); await p.locator(".carton-cuts-find").fill("trail"); await p.waitForTimeout(150); }),
  P("ws6-cuts-new", "ws6-cuts", "The cuts menu → New cut from your edit: the name field.", async (p) => { await cutsMenu(p); await menuItem(p, "New cut from your edit").click(); await p.keyboard.type("30s Instagram cut v2"); await p.waitForTimeout(100); }),
  P("ws6-teammate-cut", "ws6-teammate", "Leo's Main cut on screen: its dot and Viewing ✕ in the cut bar, Fold into Main cut… and New cut from it above its History.", null),
  P("ws6-fold-all", "ws6-fold-all", "The cuts menu → Fold in changes from a cut…: From 30s Instagram cut into Main cut, 4 changes, the aspect ratio locked.", (p) => foldFromIg(p), { target: "dialog", perWidth: false }),
  P("ws6-fold-some", "ws6-fold-all", "ws6-fold-all, then “Removed “Product close-up”” unticked.", async (p) => { await foldFromIg(p); await p.locator(".carton-fold-change input").nth(2).click(); await p.waitForTimeout(120); }, { target: "dialog", perWidth: false }),
  P("ws6-fold-conflict", "ws6-fold-conflict", "A fold with a conflict to pick inline (both cuts moved “Interview B”), then 30s Instagram cut's picked.", async (p) => { await foldFromIg(p); await p.locator(".carton-fold [role=radio]").nth(1).click(); await p.waitForTimeout(120); }, { target: "dialog", perWidth: false }),
  P("ws6-fold-conflict-unpicked", "ws6-fold-conflict", "The same, before the pick: the button waits and says why.", (p) => foldFromIg(p), { target: "dialog", perWidth: false }),
  P("ws6-fold-rest", "ws6-fold-rest", "Only what a partial fold on Oct 30 left out: Fold in the rest.", (p) => foldFromIg(p), { target: "dialog", perWidth: false }),
  P("ws6-fold-nothing", "ws6-fold-nothing", "Nothing to fold: Main cut already has everything.", (p) => foldFromIg(p), { target: "dialog", perWidth: false }),
  P("ws6-fold-into", "ws6-fold-all", "ws6-fold-all, the Into picker opened: only your own cuts.", async (p) => { await foldFromIg(p); await p.locator(".carton-fold-cut").nth(1).click(); await p.waitForTimeout(150); }, { target: "dialog", perWidth: false }),
];
// States from before the redesign that still show today's UI: the stage's live chip and footage notice, a long
// History, long cut names, the title bar's icons. (The rest of the old capture was dropped with the redesign: its
// selectors are gone, and the states above show what replaced them.)
const KEPT = [
  P("history-many", "history-many", "Mock with 3,000 versions over about four days: day headers; older days folded (only named versions and turns stay).", null),
  P("history-many-scrolled", "history-many", "history-many, list scrolled down 1500 px (the list's top edge once scrolled).", (p) => scrollList(p, 1500)),
  P("history-many-bottom", "history-many", "history-many, scrolled to the end: the older days, folded to their named versions and turns.", (p) => scrollList(p, 1e9)),
  P("history-many-day-open", "history-many", "history-many-bottom, then a click on the last folded day's header: it opens.", async (p) => { await scrollList(p, 1e9); await p.locator(".carton-day[data-collapsed]").last().click(); await p.waitForTimeout(250); await scrollList(p, 1e9); }),
  P("cuts-closed-long", "cuts-long", "Current cut with a long name (\"Director's cut: punchier open with the drone shot and the new music\"): the switcher cuts it off.", null),
  P("cuts-open-long", "cuts-long", "cuts-long, the switcher opened (long names in the menu).", (p) => cutsMenu(p)),
  T("stage-live-offline", "stage-live-offline", "Shared project offline with 3 edits waiting: the live chip, bottom-left.", null),
  T("stage-live-syncing", "stage-live-syncing", "Shared project sending 2 edits: the chip says Syncing (its icon spins).", null),
  T("stage-media-waiting-one", "stage-media-waiting-one", "Joined project, one teammate clip not here yet: the media notice.", null),
  T("stage-media-waiting-many", "stage-media-waiting-many", "Four clips not here yet.", null),
  T("stage-media-arrived", "stage-media-arrived", "The check found the clip: \"has arrived\" (the page checks every 150 ms instead of 15 s).", async (p) => { await p.locator(".carton-media-notice", { hasText: "arrived" }).waitFor(); await p.waitForTimeout(100); }),
  T("stage-media-copies", "stage-media-copies", "Everything here, playing from preview copies.", null),
  T("stage-media-unchecked", "stage-media-unchecked", "Clips that couldn't be checked.", null),
  { name: "titlebar-normal", s: "titlebar", how: "The title bar's History and Share icons, no panel open, project not shared.", target: "titlebar", steps: (p) => p.evaluate(() => window.__cap.setStrip(null, null)) },
  { name: "titlebar-hover", s: "titlebar", how: "The same, mouse over History (tooltip not shown: native title).", target: "titlebar", keepHover: true, steps: async (p) => { await p.evaluate(() => window.__cap.setStrip(null, null)); await p.locator('[data-carton-strip="history"]').hover(); await p.waitForTimeout(150); } },
  { name: "titlebar-history-pressed", s: "titlebar", how: "History open: its icon pressed.", target: "titlebar", steps: (p) => p.evaluate(() => window.__cap.setStrip("history", null)) },
  { name: "titlebar-share-pressed", s: "titlebar", how: "Share open: its icon pressed.", target: "titlebar", steps: (p) => p.evaluate(() => window.__cap.setStrip("share", null)) },
  { name: "titlebar-syncing", s: "titlebar", how: "Shared, sending 2 edits, one teammate here: white dot and an avatar.", target: "titlebar", steps: (p) => p.evaluate(() => window.__cap.setStrip("history", window.__cap.liveSamples.syncing)) },
  { name: "titlebar-peers", s: "titlebar", how: "Shared, up to date, four teammates here: three avatars and +1.", target: "titlebar", steps: (p) => p.evaluate(() => window.__cap.setStrip(null, window.__cap.liveSamples.peers)) },
  { name: "titlebar-narrow", s: "titlebar", how: "Window 1100 px wide (≤ 1180): History only, Share open shows as History pressed, the status on History's icon.", target: "titlebar", viewport: { width: 1100, height: 120 }, steps: (p) => p.evaluate(() => window.__cap.setStrip("share", window.__cap.liveSamples.offline)) },
];

// Every states/*.shots.mjs (a feature's shots, beside its states/*.js scenarios): one file per feature, so features
// add states side by side without editing this list (states/README.md).
const HELPERS = { P, T, W, B, D, ED, WIDTHS, row, vrow, rowMenu, menuItem, tab, cutsMenu, foldFromIg, scrollList, changes, playAll, holdBefore, foldOlder, openCard, uxMenu, playDirector, seeTheirs };
const states = join(here, "states");
const FEATURES = [];
for (const f of readdirSync(states).filter((x) => x.endsWith(".shots.mjs")).sort()) FEATURES.push(...(await import(pathToFileURL(join(states, f)).href)).shots(HELPERS).map((x) => ({ ...x, from: `states/${f}` })));
const SHOTS = [...AFTER, ...WS1, ...WS59, ...WS4, ...WS6, ...KEPT, ...FEATURES];
// a name shot twice would overwrite its PNG: say which file added it
const seen = new Map();
for (const x of SHOTS) {
  if (seen.has(x.name)) throw new Error(`shot "${x.name}" is listed twice (${seen.get(x.name)} and ${x.from ?? "shoot.mjs"})`);
  seen.set(x.name, x.from ?? "shoot.mjs");
}
if (process.argv.includes("--list")) {
  for (const x of SHOTS) if (!only || only.test(x.name)) console.log(`${x.name}\t${x.s}\t${x.target}${x.perWidth ? " ×" + WIDTHS.length : ""}\t${x.from ?? "shoot.mjs"}`);
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
const manifest = [], errors = [];
try {
  for (const shot of SHOTS) {
    if (only && !only.test(shot.name)) continue;
    for (const w of shot.perWidth ? WIDTHS : [WIDTHS[0]]) {
      const file = shot.perWidth ? `${shot.name}-${w}.png` : `${shot.name}.png`;
      const vp = shot.viewport ?? viewport(w);
      const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2 });
      page.setDefaultTimeout(TIMEOUT);
      const errs = [];
      page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
      // Cardboard's stylesheet asks for its fonts at /assets/… (the app's own origin): Geist comes from the page's own
      // @font-face instead, so those misses are expected.
      page.on("console", (m) => m.type() === "error" && !/ERR_FILE_NOT_FOUND/.test(m.text()) && errs.push(`console: ${m.text()}`));
      try {
        await page.goto(`${page0}?s=${shot.s}&w=${w}${shot.q ?? ""}`);
        await page.waitForFunction(() => window.__cap?.ready, null, { timeout: Math.max(8000, TIMEOUT) });
        await page.evaluate(() => document.fonts.ready);
        if (shot.target === "panel" || shot.name.startsWith("window-") || shot.name.startsWith("fold-") || shot.name.startsWith("comments")) await page.locator("aside.carton-sidebar").waitFor({ timeout: TIMEOUT });
        if (shot.steps) await shot.steps(page);
        if (!shot.keepHover) await page.mouse.move(vp.width - 5, vp.height - 5);
        await page.waitForTimeout(150);
        const path = join(out, file);
        const animations = shot.keepAnimations || shot.anim ? "allow" : "disabled";
        if (shot.target === "window") await page.screenshot({ path, animations });
        else if (shot.target === "dialog") await page.locator(".carton-dialog").first().screenshot({ path, animations: "disabled" });
        else if (shot.target === "titlebar") {
          const bar = await page.locator(".cap-titlebar").boundingBox();
          const crop = shot.crop ?? 560;
          const x = crop ? Math.max(0, bar.width - crop) : 0;
          await page.screenshot({ path, animations: "disabled", clip: { x, y: bar.y, width: bar.width - x, height: bar.height } });
        } else {
          const sel = shot.target === "panel" ? "aside.carton-sidebar" : "[data-carton-stage-host]";
          await page.locator(sel).first().screenshot({ path, animations });
        }
        manifest.push({ file, name: shot.name, width: shot.perWidth ? w : null, scenario: shot.s, target: shot.target, how: shot.how, errors: errs });
      } catch (e) {
        errs.push(`capture failed: ${e.message.split("\n")[0]}`);
        manifest.push({ file: null, name: shot.name, width: shot.perWidth ? w : null, scenario: shot.s, target: shot.target, how: shot.how, errors: errs });
      }
      if (errs.length) errors.push(`${file}: ${errs.join(" | ")}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "shots.json"), JSON.stringify({ runtime, widths: WIDTHS, shots: manifest }, null, 2));
console.log(`${manifest.filter((m) => m.file).length} shots in ${out}`);
if (errors.length) { console.log("problems:\n" + errors.join("\n")); process.exitCode = 1; }
