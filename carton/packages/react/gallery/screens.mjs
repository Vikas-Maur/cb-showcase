// Screenshot every gallery section in headless Chromium, on React and on preact/compat.
//   CARTON_PLAYWRIGHT=<dir with playwright>  CARTON_CHROMIUM=<chrome binary>  CARTON_SCREENS=<out dir>  node gallery/screens.mjs
// Playwright is not a dependency of the package: point CARTON_PLAYWRIGHT at an installed copy.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.CARTON_PLAYWRIGHT ?? "playwright", process.env.CARTON_PLAYWRIGHT ? "playwright" : ""));
const out = process.env.CARTON_SCREENS ?? join(here, "dist", "screens");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM, args: ["--force-color-profile=srgb"] });
const errors = [];
try {
  for (const rt of ["react", "preact"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => errors.push(`[${rt}] ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`[${rt}] console: ${m.text()}`));
    await page.goto(pathToFileURL(join(here, "dist", rt === "react" ? "index.html" : "preact.html")).href);
    await page.waitForFunction(() => window.__carton?.ready);
    await page.evaluate(() => document.fonts.ready);
    const shot = async (name, sel = `[data-shot="${name}"]`, file = name) => {
      const el = await page.$(sel);
      if (!el) throw new Error(`no ${sel}`);
      await el.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(120);
      await el.screenshot({ path: join(out, `${rt}-${file}.png`), animations: "disabled" });
    };
    for (const name of ["topbar", "history", "conflicts", "changes", "credits", "status", "presence", "fold", "preview"]) await shot(name);

    // Cuts menu, open.
    await page.click('[data-shot="cuts"] .carton-menu-trigger');
    await shot("cuts");
    await page.keyboard.press("Escape");

    // History: hover a row and open its actions.
    const row = await page.$('[data-shot="history"] .carton-vrow:nth-child(5) .carton-version-more');
    await page.hover('[data-shot="history"] .carton-vrow:nth-child(5) [role=option]');
    await row.click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${rt}-history-menu.png`), clip: await page.$eval('[data-shot="history"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 420) }; }) });
    await page.keyboard.press("Escape");

    // The Changes view: Play all for a moment, then shoot mid-playback, with Before held.
    await page.click('[data-shot="changes"] .carton-play-all .carton-btn');
    await page.waitForTimeout(900);
    await shot("changes", '[data-shot="changes"]', "changes-playing");
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`screens in ${out}`);
if (errors.length) {
  console.log("page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
}
