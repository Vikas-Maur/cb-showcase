// Build the web client into dist/: the editor (app.js), the watch page (watch.js) and the media Service Worker
// (sw.js), plus the HTML. Plain esbuild, no dev server. `react` is aliased to preact/compat (PLAN §3: the web client
// is @carton/react on a Preact root), so the same components ship at Preact's size.
//   node build.mjs [--out <dir>] [--dev]   (default out: ./dist; --dev keeps names and adds sourcemaps)
// Prints the size of each file, minified and gzipped (deterministic; the numbers go to notes as UNVERIFIED).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(here, "dist"));
const dev = args.includes("--dev");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const alias = { react: "preact/compat", "react-dom/client": "preact/compat/client", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };
const common = {
  bundle: true,
  minify: !dev,
  sourcemap: dev,
  target: "es2022",
  platform: "browser",
  logLevel: "warning",
  legalComments: "none",
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  alias,
  metafile: true,
};
const entries = [
  { in: "src/main.ts", out: "app.js", format: "esm" },
  { in: "src/watch.ts", out: "watch.js", format: "esm" },
  { in: "src/sw.ts", out: "sw.js", format: "iife" },
].filter((e) => existsSync(join(here, e.in)));
const results = await Promise.all(entries.map((e) => build({ ...common, entryPoints: [join(here, e.in)], outfile: join(out, e.out), format: e.format })));
cpSync(join(here, "public"), out, { recursive: true });

const rows = [];
for (const r of results)
  for (const [file, o] of Object.entries(r.metafile.outputs)) {
    if (file.endsWith(".map")) continue;
    const bytes = readFileSync(file);
    rows.push({ file: file.split("/").pop(), min: o.bytes, gzip: gzipSync(bytes, { level: 9 }).length });
  }
writeFileSync(join(out, "sizes.json"), JSON.stringify(rows, null, 2));
for (const r of rows) console.log(`${r.file.padEnd(10)} ${(r.min / 1024).toFixed(1).padStart(7)} KB min  ${(r.gzip / 1024).toFixed(1).padStart(6)} KB min+gz`);
console.log(`built ${out}`);
