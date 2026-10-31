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
// The editor and the watch page in one build with code splitting (ESM): shared code (Preact, core, the skin) is one
// chunk both use, and the editor's heavy part (core, the panels) is a chunk the join screen doesn't wait for.
const pages = await build({ ...common, entryPoints: { app: join(here, "src/main.ts"), watch: join(here, "src/watch.ts") }, outdir: out, format: "esm", splitting: true, chunkNames: "chunks/[name]-[hash]" });
const results = [pages];
if (existsSync(join(here, "src/sw.ts"))) results.push(await build({ ...common, entryPoints: [join(here, "src/sw.ts")], outfile: join(out, "sw.js"), format: "iife" }));
cpSync(join(here, "public"), out, { recursive: true });

// modulepreload every chunk a page loads (static and dynamic imports), so the browser fetches them in parallel with
// the entry instead of discovering them one level at a time
const outputs = pages.metafile.outputs;
const rel = (f) => "/" + f.slice(f.indexOf(out.split("/").pop() + "/") + out.split("/").pop().length + 1);
function closure(file, seen = new Set()) {
  for (const i of outputs[file]?.imports ?? []) if (!seen.has(i.path)) (seen.add(i.path), closure(i.path, seen));
  return seen;
}
for (const [page, entry] of [["index.html", "app.js"], ["watch.html", "watch.js"]]) {
  const file = Object.keys(outputs).find((f) => f.endsWith("/" + entry));
  const links = [...closure(file)].map((f) => `<link rel="modulepreload" href="${rel(f)}">`).join("\n");
  const html = join(out, page);
  writeFileSync(html, readFileSync(html, "utf8").replace("<!--preload-->", links));
}

const rows = [];
for (const r of results)
  for (const [file, o] of Object.entries(r.metafile.outputs)) {
    if (file.endsWith(".map")) continue;
    const bytes = readFileSync(file);
    rows.push({ file: rel(file).slice(1), min: o.bytes, gzip: gzipSync(bytes, { level: 9 }).length });
  }
writeFileSync(join(out, "sizes.json"), JSON.stringify(rows, null, 2));
for (const r of rows) console.log(`${r.file.padEnd(28)} ${(r.min / 1024).toFixed(1).padStart(7)} KB min  ${(r.gzip / 1024).toFixed(1).padStart(6)} KB min+gz`);
console.log(`built ${out}`);
