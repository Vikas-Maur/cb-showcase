// Size budgets (PLAN §19, P4): each entry is bundled with esbuild (minified, ESM, platform-neutral) and gzipped at
// level 9. A budget over its limit fails the run. Entries without a budget are reported only.
// The engine + history budget comes from the verified prototype: core-v5 measured 19.3 KB min+gz by bundling
// history.mjs, so the engine parts history doesn't use were tree-shaken; "history bundle" measures the same way.
// "engine + history (all exports)" keeps every engine export (shots, describe, assignKeys...) for reference.
//   node scripts/size.mjs [--json]
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KB = 1000;
const ENTRIES = [
  { name: "history bundle (P4 method)", code: `export * from "./packages/core/src/history/index.ts";`, budget: 22 * KB },
  { name: "engine + history (all)", code: `export * from "./packages/core/src/engine/index.ts"; export * from "./packages/core/src/history/index.ts";`, budget: null },
  { name: "engine only", code: `export * from "./packages/core/src/engine/index.ts";`, budget: null },
  { name: "core (all)", code: `export * from "./packages/core/src/index.ts";`, budget: null },
  { name: "core + cardboard adapter", code: `export * from "./packages/core/src/index.ts"; export * from "./packages/cardboard/src/index.ts";`, budget: null },
  { name: "store-memory", code: `export * from "./packages/store-memory/src/index.ts";`, budget: null },
  { name: "store-idb", code: `export * from "./packages/store-idb/src/index.ts";`, budget: null },
  { name: "react", code: `export * from "./packages/react/src/index.ts";`, budget: null, external: ["react", "react-dom", "preact"] },
];

const rows = [];
let over = false;
for (const e of ENTRIES) {
  const r = await build({
    stdin: { contents: e.code, resolveDir: root, loader: "ts", sourcefile: "size-entry.ts" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    write: false,
    logLevel: "silent",
    external: e.external ?? [],
  });
  const bytes = r.outputFiles[0].contents;
  const gz = gzipSync(bytes, { level: 9 }).length;
  const ok = e.budget == null || gz <= e.budget;
  if (!ok) over = true;
  rows.push({ name: e.name, min: bytes.length, gz, budget: e.budget, ok });
}
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else for (const r of rows) console.log(`${r.ok ? "ok  " : "OVER"} ${r.name.padEnd(28)} ${(r.min / KB).toFixed(1).padStart(7)} KB min  ${(r.gz / KB).toFixed(1).padStart(6)} KB min+gz${r.budget ? `  (budget ${(r.budget / KB).toFixed(1)} KB)` : ""}`);
if (over) process.exitCode = 1;
