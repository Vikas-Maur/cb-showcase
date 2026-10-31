// Build the gallery: gallery/dist/index.html (React) and preact.html (preact/compat). Classic scripts, so the pages
// open straight from disk (file://), with no server.
// Plain esbuild, no dev server. Geist (Cardboard's font) is used when a local copy is found (it is not ours to ship,
// so it is referenced, never copied): set CARTON_GALLERY_FONTS to a folder with Geist-Variable*.woff2.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });

const common = {
  entryPoints: [join(here, "gallery.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
};

const [r, p] = await Promise.all([
  build({ ...common, outfile: join(out, "gallery.react.js"), banner: { js: 'globalThis.__CARTON_RUNTIME__="react";' }, metafile: true }),
  build({
    ...common,
    outfile: join(out, "gallery.preact.js"),
    banner: { js: 'globalThis.__CARTON_RUNTIME__="preact";' },
    alias: { react: "preact/compat", "react-dom/client": "preact/compat/client", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    metafile: true,
  }),
]);

const fontDir = process.env.CARTON_GALLERY_FONTS;
let fonts = "";
if (fontDir && existsSync(fontDir)) {
  const files = readdirSync(fontDir);
  const pick = (re) => files.find((f) => re.test(f));
  const sans = pick(/^Geist-Variable.*\.woff2$/), mono = pick(/^GeistMono-Variable.*\.woff2$/);
  if (sans) fonts += `@font-face{font-family:Geist;src:url("${pathToFileURL(join(fontDir, sans))}") format("woff2");font-weight:100 900}`;
  if (mono) fonts += `@font-face{font-family:"Geist Mono";src:url("${pathToFileURL(join(fontDir, mono))}") format("woff2");font-weight:100 900}`;
}

const css = readFileSync(join(here, "gallery.css"), "utf8");
const page = (rt) => `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>@carton/react gallery (${rt})</title>
<style>${fonts}${css}</style></head>
<body><div id="root"></div><script src="./gallery.${rt}.js"></script></body></html>
`;
writeFileSync(join(out, "index.html"), page("react"));
writeFileSync(join(out, "preact.html"), page("preact"));

const size = (m) => Object.values(m.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`gallery built: ${out}/index.html and preact.html  (react bundle ${(size(r) / 1024).toFixed(0)} KB, preact bundle ${(size(p) / 1024).toFixed(0)} KB, fonts: ${fonts ? "Geist" : "system"})`);
