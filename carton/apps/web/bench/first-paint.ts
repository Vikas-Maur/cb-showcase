// First paint of the web demo (for the verification phase; don't run on a busy box): for each run, a fresh browser
// profile opens an invite link over a throttled link (Chromium's network emulation), and we record
//   - fcp:    first-contentful-paint (the static shell in index.html),
//   - join:   the join screen is interactive (the name field is visible),
//   - editor: after Join, the editor's timeline is on screen (core + panels + catch-up),
//   - bytes:  bytes transferred before the join screen, and in total.
// Runs alternate between the link profiles; one JSON line per run, then medians per profile.
//   node bench/first-paint.ts [--runs 5] [--host node|cloudflare] [--out <file.jsonl>]
// Each run records `uptime` (load) so a loaded box shows in the data.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildClient, launchChromium, startHost } from "../../../e2e/web/harness.ts";
import { seedDemo } from "../scripts/seed.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const runs = Number(arg("--runs", "5"));
const kind = arg("--host", "node") as "node" | "cloudflare";
const out = arg("--out", join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "bench", `first-paint-${kind}.jsonl`));
const PROFILES = [
  { name: "cable", down: (20e6 / 8) | 0, up: (5e6 / 8) | 0, latency: 20 },
  { name: "slow-4g", down: (1.6e6 / 8) | 0, up: (0.75e6 / 8) | 0, latency: 150 },
];

mkdirSync(dirname(out), { recursive: true });
await buildClient();
const host = await startHost(kind, "bench-first-paint");
const browser = await launchChromium();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const results: Record<string, { fcp: number[]; join: number[]; editor: number[] }> = {};
try {
  const seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 })) } });
  for (let r = 0; r < runs; r++)
    for (const p of r % 2 ? [...PROFILES].reverse() : PROFILES) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: p.latency, downloadThroughput: p.down, uploadThroughput: p.up });
      let bytes = 0;
      cdp.on("Network.loadingFinished", (e: { encodedDataLength: number }) => (bytes += e.encodedDataLength));
      const t0 = Date.now();
      await page.goto(seed.bob);
      await page.getByTestId("join-name").waitFor();
      const join = Date.now() - t0;
      const joinBytes = bytes;
      const fcp = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1);
      await page.getByTestId("join-name").fill(`Bench ${r}`);
      const t1 = Date.now();
      await page.getByTestId("join").click();
      await page.getByTestId("timeline").waitFor({ timeout: 60_000 });
      const editor = Date.now() - t1;
      const line = { run: r, profile: p.name, host: kind, fcp, join, editor, joinBytes, totalBytes: bytes, uptime: execFileSync("uptime").toString().trim() };
      appendFileSync(out, JSON.stringify(line) + "\n");
      console.log(JSON.stringify(line));
      ((results[p.name] ??= { fcp: [], join: [], editor: [] }).fcp.push(fcp), results[p.name]!.join.push(join), results[p.name]!.editor.push(editor));
      await ctx.close();
    }
  for (const [name, x] of Object.entries(results)) console.log(JSON.stringify({ summary: name, runs: x.fcp.length, fcpMedian: median(x.fcp), joinMedian: median(x.join), editorMedian: median(x.editor) }));
} finally {
  await browser.close();
  await host.close();
}
