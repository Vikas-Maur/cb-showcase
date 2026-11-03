// Render the v2 mockups: each element with data-shot="<name>" in v2/mockups/*.html becomes v2/after/<name>.png.
// They reuse the first design's skin and builders (../../mockups/*.js and skin.css), so they match the built UI.
//   CARTON_PLAYWRIGHT=/home/ubuntu/job-finder/node_modules node docs/carton-ux/v2/mockups/render.mjs [file.html…]
// DPR=1 (the default) gives the real CSS size: 1522 × 810 for the editor, 384 or 300 px wide for the panel.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.CARTON_PLAYWRIGHT ?? "/home/ubuntu/job-finder/node_modules", "playwright"));
const out = process.env.OUT ?? join(here, "..", "after");
mkdirSync(out, { recursive: true });
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here).filter((f) => f.endsWith(".html"));
const browser = await chromium.launch({
  executablePath: process.env.CARTON_CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome`,
  args: ["--force-color-profile=srgb", "--allow-file-access-from-files"],
});
const errors = [];
let n = 0;
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: Number(process.env.DPR ?? 1) });
  page.on("pageerror", (e) => errors.push(`${f}: ${e.message}`));
  await page.goto(pathToFileURL(join(here, f)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  for (const el of await page.$$("[data-shot]")) {
    const name = await el.getAttribute("data-shot");
    await el.screenshot({ path: join(out, `${name}.png`) });
    n++;
  }
  await page.close();
}
await browser.close();
console.log(`${n} shots in ${out}`);
if (errors.length) { console.log(errors.join("\n")); process.exitCode = 1; }
