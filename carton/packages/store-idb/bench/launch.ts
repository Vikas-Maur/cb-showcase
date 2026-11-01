// A persistent headless Chromium profile serving the workspace (same routing as the tests' browser.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { cartonRoot, ORIGIN } from "../test/browser.ts";

const BOX_PLAYWRIGHT = "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const BOX_CHROMIUM = "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";

export async function launchPersistent(profile: string) {
  const pwDir = process.env.CARTON_PLAYWRIGHT || BOX_PLAYWRIGHT;
  const pw = await import(pathToFileURL(path.join(pwDir, "index.mjs")).href);
  const exe = process.env.CARTON_CHROMIUM || (fs.existsSync(BOX_CHROMIUM) ? BOX_CHROMIUM : undefined);
  fs.mkdirSync(profile, { recursive: true });
  const ctx = await pw.chromium.launchPersistentContext(profile, { headless: true, ...(exe ? { executablePath: exe } : {}) });
  const imports: Record<string, string> = {};
  for (const dir of fs.readdirSync(path.join(cartonRoot, "packages"))) {
    const pj = path.join(cartonRoot, "packages", dir, "package.json");
    if (!fs.existsSync(pj)) continue;
    const { name, exports } = JSON.parse(fs.readFileSync(pj, "utf8"));
    for (const [sub, t] of Object.entries(exports ?? {})) if (typeof t === "string") imports[sub === "." ? name : `${name}/${sub.slice(2)}`] = `/carton/packages/${dir}/${t.slice(2)}`;
  }
  const html = `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports })}</script>`;
  await ctx.route(`${ORIGIN}/**`, async (route: { request(): { url(): string }; fulfill(r: object): Promise<void> }) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    const file = path.resolve(cartonRoot, "." + decodeURIComponent(url.pathname).replace(/^\/carton/, ""));
    if (!file.startsWith(cartonRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const src = fs.readFileSync(file, "utf8");
    return route.fulfill({ contentType: "text/javascript", body: file.endsWith(".ts") ? stripTypeScriptTypes(src, { mode: "strip" }) : src });
  });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`);
  return { ctx, page, close: () => ctx.close() };
}
