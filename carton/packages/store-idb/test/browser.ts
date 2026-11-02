// Runs store-idb's tests in headless Chromium: real IndexedDB, Web Locks, BroadcastChannel and OPFS, with several
// tabs of one origin. The workspace's TypeScript is served straight from disk with its types stripped
// (node:module stripTypeScriptTypes), behind an import map for the @carton/* packages, so there is no build step.
//
// Playwright and Chromium are not dependencies of the package. They are found through CARTON_PLAYWRIGHT (the
// playwright package folder) and CARTON_CHROMIUM (the browser binary), else a normal `import("playwright")` and its
// own browser. Without them the browser tests skip and say why.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The `carton/` workspace folder, served at http://carton.localhost/carton/. */
export const cartonRoot = path.resolve(here, "../../..");
export const ORIGIN = "http://carton.localhost"; // *.localhost is a secure context: Web Locks and OPFS work

// Defaults for the shared dev box, used only when they exist.
const BOX_PLAYWRIGHT = "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const BOX_CHROMIUM = "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";

// Minimal shapes of the Playwright API used here (it is not a dependency, so its types are not either).
export interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  close(): Promise<void>;
  on(ev: "console", fn: (msg: { type(): string; text(): string }) => void): void;
  on(ev: "pageerror", fn: (err: Error) => void): void;
}
export interface Context {
  newPage(): Promise<Page>;
  route(url: string, fn: (route: Route) => unknown): Promise<void>;
  close(): Promise<void>;
}
interface Route {
  request(): { url(): string };
  fulfill(r: { status?: number; contentType?: string; body: string }): Promise<void>;
}
interface Browser {
  newContext(): Promise<Context>;
  close(): Promise<void>;
}

export async function launch(): Promise<{ browser: Browser; skip?: undefined } | { skip: string; browser?: undefined }> {
  let pw: { chromium: { launch(o: object): Promise<Browser> } };
  const pwDir = process.env.CARTON_PLAYWRIGHT || (fs.existsSync(BOX_PLAYWRIGHT) ? BOX_PLAYWRIGHT : "");
  try {
    pw = pwDir ? await import(pathToFileURL(path.join(pwDir, "index.mjs")).href) : await import("playwright" as string);
  } catch (e) {
    return { skip: `Playwright not found (set CARTON_PLAYWRIGHT): ${(e as Error).message}` };
  }
  const exe = process.env.CARTON_CHROMIUM || (fs.existsSync(BOX_CHROMIUM) ? BOX_CHROMIUM : undefined);
  try {
    return { browser: await pw.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) }) };
  } catch (e) {
    return { skip: `headless Chromium did not start (set CARTON_CHROMIUM): ${(e as Error).message}` };
  }
}

/** A browser context serving the workspace. Every page of one context shares IndexedDB, locks and channels. */
export async function serve(browser: Browser): Promise<Context> {
  const ctx = await browser.newContext();
  const html = `<!doctype html><meta charset="utf-8"><title>carton test</title><script type="importmap">${JSON.stringify({ imports: importMap() })}</script>`;
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/" || url.pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: html });
    const file = path.resolve(cartonRoot, "." + decodeURIComponent(url.pathname).replace(/^\/carton/, ""));
    if (!file.startsWith(cartonRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    const src = fs.readFileSync(file, "utf8");
    if (file.endsWith(".ts")) return route.fulfill({ contentType: "text/javascript", body: stripTypeScriptTypes(src, { mode: "strip" }) });
    return route.fulfill({ contentType: file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : "application/octet-stream", body: src });
  });
  return ctx;
}

export async function openPage(ctx: Context): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** URL of a workspace file, for `import()` inside a page. */
export const urlOf = (fileInCarton: string) => `/carton/${fileInCarton.split(path.sep).join("/")}`;

// "@carton/<pkg>" and "@carton/<pkg>/<sub>" -> the package's source entry, from each package.json's exports.
function importMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const pkgs = path.join(cartonRoot, "packages");
  for (const dir of fs.readdirSync(pkgs)) {
    const pj = path.join(pkgs, dir, "package.json");
    if (!fs.existsSync(pj)) continue;
    const { name, exports } = JSON.parse(fs.readFileSync(pj, "utf8")) as { name: string; exports?: Record<string, string | Record<string, string>> };
    for (const [sub, target] of Object.entries(exports ?? {})) {
      const t = typeof target === "string" ? target : target.import ?? target.default;
      if (!t) continue;
      map[sub === "." ? name : `${name}/${sub.replace(/^\.\//, "")}`] = `/carton/packages/${dir}/${t.replace(/^\.\//, "")}`;
    }
  }
  return map;
}
