// Bundle sizes (esbuild, minified, gzip level 9), for the React-or-Preact decision and the renderer's budget.
//   node bench/size.mjs [--json]
// Entries:
// - renderer: what Cardboard's renderer loads: every component + remoteUi + the skin (the engine stays in the worker).
// - in-process: every component + fromCarton (pulls in @carton/core's engine): the web client's case.
// Each is measured with the UI runtime external (as a host that already has React would load it), with preact/compat
// bundled in (our Windows build), and the runtimes alone for scale.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = `export * from "./src/components/HistoryPanel.ts"; export * from "./src/components/CutsMenu.ts"; export * from "./src/components/FoldInDialog.ts";
export * from "./src/components/ConflictCard.ts"; export * from "./src/components/ChangesView.ts"; export * from "./src/components/status.ts";
export * from "./src/components/Presence.ts"; export * from "./src/components/Play.ts"; export { CartonProvider } from "./src/hooks.ts";
export { remoteUi } from "./src/remote.ts"; export { injectCardboardSkin } from "./src/skin/cardboard.ts";`;
const PREACT = { react: "preact/compat", "react-dom": "preact/compat", "react-dom/client": "preact/compat/client", "react/jsx-runtime": "preact/jsx-runtime" };
const entries = [
  { name: "renderer, React external", code: RENDERER, external: ["react", "react-dom", "react-dom/client"] },
  { name: "renderer + preact/compat (Windows build)", code: RENDERER + `\nexport { render } from "preact"; export { createRoot } from "preact/compat/client";`, alias: PREACT },
  { name: "in-process (+ fromCarton, core), React external", code: `export * from "./src/index.ts";`, external: ["react", "react-dom", "react-dom/client"] },
  { name: "skin CSS only", code: `export { baseCss, cardboardSkin } from "./src/skin/cardboard.ts";` },
  { name: "preact + hooks + compat alone", code: `export * from "preact/compat"; export { createRoot } from "preact/compat/client";` },
  { name: "react + react-dom/client alone", code: `export * from "react"; export { createRoot } from "react-dom/client";` },
];
const rows = [];
for (const e of entries) {
  const r = await build({
    stdin: { contents: e.code, resolveDir: root, loader: "ts", sourcefile: "size-entry.ts" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    external: e.external ?? [],
    alias: e.alias ?? {},
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const bytes = r.outputFiles[0].contents;
  rows.push({ name: e.name, min: bytes.length, gz: gzipSync(bytes, { level: 9 }).length });
}
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else for (const r of rows) console.log(`${r.name.padEnd(48)} ${(r.min / 1000).toFixed(1).padStart(7)} KB min  ${(r.gz / 1000).toFixed(1).padStart(6)} KB min+gz`);
