// Design QA: dump every visible Carton string (panel, stage layer, dialogs, the title bar's chip, tooltips and aria-labels)
// across the main states, then flag the standing word rules: ids/hashes, system or tool names, retired words.
//   node words.mjs <react pkg dir> <out.json>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.CARTON_PLAYWRIGHT, "playwright"));
const [reactDir, outFile] = process.argv.slice(2);
const page0 = pathToFileURL(join(reactDir, "gallery", "dist", "capture-qa", "capture.react.html")).href;
const vrow = (p, t) => p.locator(".carton-version", { hasText: t }).first();
const menuItem = (p, t) => p.locator(".carton-menu-item", { hasText: t }).first();
async function card(p, t) { await vrow(p, t).click(); await p.waitForTimeout(400); }
async function menu(p, t) { const r = vrow(p, t); await r.hover(); await r.locator(".carton-version-more").click(); await p.waitForTimeout(200); }
const STATES = [
  ["ux-history", null], ["ux-history", (p) => card(p, "Tighten the intro")], ["ux-history", (p) => card(p, "Add captions to the interview")],
  ["ux-history", (p) => menu(p, "Add captions to the interview")], ["ux-history", (p) => menu(p, "Folded in")],
  ["ux-history", async (p) => { await menu(p, "Add captions to the interview"); await menuItem(p, "Compare with your edit").click(); await p.waitForTimeout(400); }],
  ["ux-history", async (p) => { await card(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(500); }],
  ["ux-history", async (p) => { await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(200); }],
  ["ux-history", async (p) => { await p.locator(".carton-version-group").first().click(); await p.waitForTimeout(200); }],
  ["ux-working", null], ["ux-offline", null], ["ux-empty", null], ["ux-clip", async (p) => { await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Only").click(); await p.waitForTimeout(400); }],
  ["ux-many", null], ["ws6-cuts", async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(200); }],
  ["ws6-cuts-turn", async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(150); await p.locator(".carton-cut-item", { hasText: "30s Instagram cut" }).click(); await p.waitForTimeout(200); }],
  ["ws6-teammate", null],
  ...["ws6-fold-all", "ws6-fold-conflict", "ws6-fold-rest", "ws6-fold-nothing"].map((s) => [s, async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(150); await menuItem(p, "Fold in changes from a cut…").click(); await p.waitForTimeout(500); }]),
  ["qa-conflict", null], ["qa-conflict-twice", null], ["qa-conflict-turn", null], ["qa-conflict-old", null], ["qa-conflict-panel", null],
  ["qa-share-first", null], ["qa-share-owner", null], ["qa-share-offline", null], ["qa-share-update", null], ["qa-share-editor", null],
  ["join", null], ["ws59-comments", async (p) => { await p.locator('[role=tab][aria-label="Comments"]').click(); await p.waitForTimeout(300); }],
  ["qa-live-media", null], ["stage-toast-warning", null], ["qa-shared", null], ["qa-offline", null],
];
const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM });
const out = [];
for (const [s, steps] of STATES) {
  const page = await browser.newPage({ viewport: { width: 1694, height: 900 } });
  try {
    await page.goto(`${page0}?s=${s}&w=384`);
    await page.waitForFunction(() => window.__cap?.ready, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    if (steps) await steps(page);
    await page.waitForTimeout(300);
    const texts = await page.evaluate(() => {
      const roots = [...document.querySelectorAll("aside.carton-sidebar, [data-carton-stage-host], .carton-dialog, .carton-join-dialog, [data-carton-cut-chip], [data-carton-strip], .carton-menu-pop, .carton-toast")];
      const seen = new Set();
      for (const r of roots) {
        const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode());) { const t = n.textContent.trim(); const el = n.parentElement; if (t && el && el.offsetParent !== null && !el.closest(".sr-only")) seen.add(t); }
        for (const el of r.querySelectorAll("[title],[aria-label],[placeholder]")) for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v) seen.add(`[${a}] ${v}`); }
      }
      return [...seen];
    });
    out.push({ s, step: steps ? steps.toString().slice(0, 80) : null, texts });
  } catch (e) { out.push({ s, error: e.message.split("\n")[0] }); }
  await page.close();
}
await browser.close();
writeFileSync(outFile, JSON.stringify(out, null, 1));
const all = new Set(out.flatMap((o) => o.texts ?? []));
const RULES = [
  ["id or hash", /[0-9a-f]{10,}|@\d+|main@|items\/|timelineItems|\bref\b/i],
  ["system/tool word", /\b(cb|carton|worker|bridge|sync(ing)?|checkpoint|commit|record|snapshot|merge|branch|HEAD|schema|undefined|null|NaN|error:|ECONN|fetch failed)\b/i],
  ["retired word", /read-only|previewing|return to current|section \d|unchanged shot|shown in the player|watch the changes|showing now|set aside|show again|waiting to sync|preview\b|current\b/i],
  ["straight quotes around a name", /'[^']{2,}'/],
  ["decimal timecode", /\b\d+:\d\d\.\d\b|\d+\.\d s\b/],
  ["bare clock (no am/pm) beside words", /\b(at|from|since) \d{1,2}:\d\d(?!\s?(am|pm))/i],
];
for (const [name, re] of RULES) {
  const hits = [...all].filter((t) => re.test(t));
  console.log(`\n## ${name}: ${hits.length}`);
  for (const h of hits) console.log("  " + h);
}
const errs = out.filter((o) => o.error);
if (errs.length) console.log("\nstates that failed:", errs.map((e) => `${e.s}: ${e.error}`).join("\n"));
