// Runs bench/exp-values.ts (structured clones against JSON text, 10k changes, alternating rounds) in a fresh headless
// Chromium on a persistent profile and prints its JSON: {writeObj, writeStr, readObj, readStr, commitObj, commitStr},
// each {median, runs} in ms.
// usage: TMPDIR=<scratch> flock /tmp/gfv-race/cpu.lock node bench/exp-values-run.ts <profile dir>
import { launchPersistent } from "./launch.ts";

const { page, close } = await launchPersistent(process.argv[2]);
try {
  const api = "/carton/packages/store-idb/bench/exp-values.ts";
  console.log(JSON.stringify(await page.evaluate(async ({ api }: { api: string }) => (await import(api)).run(), { api })));
} finally {
  await close();
}
