// Put each build shot beside its mockup (or several shots side by side) in one PNG, labelled, for the QA.
//   node pair.mjs <pairs.json> <out dir>
// pairs.json: [{ "name": "history-default-384", "items": [["Build (React)", "/abs/a.png"], ["Mockup", "/abs/b.png"]] }]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.CARTON_PLAYWRIGHT, "playwright"));
const [list, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const pairs = JSON.parse(readFileSync(list, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
let n = 0;
for (const p of pairs) {
  const items = p.items.filter(([, f]) => f && existsSync(f));
  if (!items.length) { console.log("skip (no files):", p.name); continue; }
  const scale = p.scale ?? 0.5; // shots and mockups are DPR 2
  const html = `<!doctype html><html><body style="margin:0;background:#2b2b2b;font:13px system-ui,sans-serif;color:#ddd">
<div id="w" style="display:inline-flex;gap:16px;padding:12px;align-items:flex-start">${items.map(([label, f]) => `<figure style="margin:0"><figcaption style="margin:0 0 6px;font-weight:600">${label}</figcaption><img src="${pathToFileURL(f).href}" style="display:block;outline:1px solid #555" onload="this.style.width=(this.naturalWidth*${scale})+'px'"></figure>`).join("")}</div></body></html>`;
  const tmp = join(out, ".pair.html"); writeFileSync(tmp, html); await page.goto(pathToFileURL(tmp).href);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.style.width));
  await page.locator("#w").screenshot({ path: join(out, `${p.name}.png`) });
  n++;
}
await browser.close();
console.log(`${n} pairs in ${out}`);
