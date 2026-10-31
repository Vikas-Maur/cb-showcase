// Bundles the Service Worker (src/sw.ts) into one classic script for /sw.js. The app's own build calls this too, so
// the tests and the demo serve the same file.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const SW_ENTRY = fileURLToPath(new URL("../src/sw.ts", import.meta.url));

export async function buildServiceWorker(outfile: string, opts: { minify?: boolean } = {}): Promise<void> {
  await build({
    entryPoints: [SW_ENTRY],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: opts.minify ?? true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
}
