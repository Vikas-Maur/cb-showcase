// Build the capture page (gallery/capture/entry.js) for React and for preact/compat: dist/capture/capture.react.html and
// capture.preact.html. Cardboard's stylesheet, fonts and the tab strip's button class come from a local copy of the app
// (CARTON_CARDBOARD_ASSETS: its dist/renderer/assets folder), referenced by file URL, never copied: they're not ours.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const carton = join(here, "..", "..", "..", "..");
const out = join(here, "..", "dist", "capture");
mkdirSync(out, { recursive: true });

const assets = process.env.CARTON_CARDBOARD_ASSETS ?? process.env.CARTON_GALLERY_FONTS;
if (!assets || !existsSync(assets)) throw new Error("set CARTON_CARDBOARD_ASSETS to Cardboard 1.4.0's dist/renderer/assets folder");
const files = readdirSync(assets);
const pick = (re) => files.find((f) => re.test(f));
const css = pick(/^styles-.*\.css$/), tabs = pick(/^tabs-.*\.js$/);
const sans = pick(/^Geist-Variable.*\.woff2$/), mono = pick(/^GeistMono-Variable.*\.woff2$/);
if (!css) throw new Error(`no styles-*.css in ${assets}`);
// The strip's button class (`C` in tabs-*.js), which strip-buttons.js builds its icons on.
const stripClass = (tabs && readFileSync(join(assets, tabs), "utf8").match(/,C="(flex h-7 cursor-pointer[^"]*)"/)?.[1]) ?? "flex h-7 cursor-pointer items-center rounded-ui-sm text-ui-sm font-medium outline-none select-none transition-colors";

// Every states/*.js (a feature's scenarios, beside its states/*.shots.mjs): entry.js imports them all as "capture-states",
// so a feature adds its states in files of its own, never by editing a shared list.
const statesDir = join(here, "states");
const statesPlugin = {
  name: "capture-states",
  setup(b) {
    b.onResolve({ filter: /^capture-states$/ }, () => ({ path: "capture-states", namespace: "capture-states" }));
    b.onLoad({ filter: /.*/, namespace: "capture-states" }, () => {
      const files = existsSync(statesDir) ? readdirSync(statesDir).filter((f) => /^[\w-]+\.js$/.test(f)).sort() : [];
      const imports = files.map((f, i) => `import * as m${i} from ${JSON.stringify(join(statesDir, f))};`).join("\n");
      return { contents: `${imports}\nexport default [${files.map((f, i) => `{ file: ${JSON.stringify(f)}, ...m${i} }`).join(", ")}];`, resolveDir: statesDir, watchFiles: files.map((f) => join(statesDir, f)), watchDirs: [statesDir] };
    });
  },
};

const common = {
  entryPoints: [join(here, "entry.js")],
  plugins: [statesPlugin],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome140",
  logLevel: "warning",
  absWorkingDir: carton,
  nodePaths: [join(carton, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"', __STRIP_BUTTON_CLASS__: JSON.stringify(stripClass) },
};
// The fixed clock runs first, ahead of every module (a banner: the package's sideEffects:false would drop an import).
const clock = readFileSync(join(here, "clock.js"), "utf8");
const preact = { react: "preact/compat", "react-dom/client": "preact/compat/client", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };
await Promise.all([
  build({ ...common, outfile: join(out, "capture.react.js"), banner: { js: 'globalThis.__CARTON_RUNTIME__="react";\n' + clock } }),
  build({ ...common, outfile: join(out, "capture.preact.js"), banner: { js: 'globalThis.__CARTON_RUNTIME__="preact";\n' + clock }, alias: preact }),
]);

const fonts = [sans && `@font-face{font-family:Geist;src:url("${pathToFileURL(join(assets, sans))}") format("woff2");font-weight:100 900}`, mono && `@font-face{font-family:"Geist Mono";src:url("${pathToFileURL(join(assets, mono))}") format("woff2");font-weight:100 900}`].filter(Boolean).join("");
const own = readFileSync(join(here, "capture.css"), "utf8");
for (const rt of ["react", "preact"])
  writeFileSync(join(out, `capture.${rt}.html`), `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Carton capture (${rt})</title>
<link rel="stylesheet" href="${pathToFileURL(join(assets, css))}">
<style>${fonts}${own}</style></head>
<body><div id="root"></div><script src="./capture.${rt}.js"></script></body></html>
`);
console.log(`capture built: ${out} (Cardboard CSS ${css}, strip class ${tabs ? "from " + tabs : "fallback"})`);
