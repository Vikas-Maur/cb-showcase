// No re-render storm under live sync (for the verification phase; don't run on a busy box): Alice's editor is open
// while a Node replica pushes a burst of edits (one commit every few ms, as fast as the sequencer confirms them). In
// her page we count
//   - head reads (LiveDoc.reads: at most one per animation frame, whatever the number of rows),
//   - clip renders (a counter on the timeline's memoized Clip component, through Preact's options.diffed hook),
//   - long tasks (PerformanceObserver "longtask", > 50 ms),
//   - frames (requestAnimationFrame callbacks) over the burst.
// Expected: reads ≤ frames and ≪ edits; clip renders ≈ edits that touched clips (only the touched clip redraws),
// never edits × clips; no long task on an idle box.
//   node bench/burst.ts [--edits 200] [--host node|cloudflare] [--out <file.jsonl>]
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "../src/ws-transport.ts";
import { buildClient, joinAs, launchChromium, newPerson, startHost } from "../../../e2e/web/harness.ts";
import { seedDemo } from "../scripts/seed.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const edits = Number(arg("--edits", "200"));
const kind = arg("--host", "node") as "node" | "cloudflare";
const out = arg("--out", join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "bench", `burst-${kind}.jsonl`));

mkdirSync(dirname(out), { recursive: true });
await buildClient();
const host = await startHost(kind, "bench-burst");
const browser = await launchChromium();
try {
  const seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 })) } });
  const alice = await joinAs(await newPerson(browser), seed.alice, "Alice");
  await alice.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number; longTasks: number; reads0: number }; __carton: { live: { reads: number } } };
    w.__bench = { frames: 0, longTasks: 0, reads0: w.__carton.live.reads };
    (window as unknown as { __cartonRenders: { clip: number } }).__cartonRenders = { clip: 0 };
    const tick = () => (w.__bench.frames++, requestAnimationFrame(tick));
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => (w.__bench.longTasks += l.getEntries().length)).observe({ type: "longtask", buffered: false });
  });
  const clips = await alice.locator("[data-clip-id]").count();
  const j = parseJoinHash(new URL(seed.bob).hash)!;
  const session = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, account: "burst", keys: memoryKeys() });
  const { carton } = await openProject({ session, me: { kind: "human", id: "burst" }, store: createMemoryStore(), transport: webSocketTransport() });
  const t0 = Date.now();
  for (let i = 0; i < edits; i++) await carton.commit({ ops: [{ op: "set", path: ["timelineItems", `cap-${(i % 4) + 1}`, "captionText"], value: `burst ${i}` }] });
  await carton.sync!.waitFor((await carton.commit({ ops: [{ op: "set", path: ["timelineItems", "cap-1", "captionText"], value: "done" }] }) as { id: string }).id, 30_000);
  await alice.waitForFunction(() => document.querySelector('[data-clip-id="cap-1"] .cb-clip-label')?.textContent === "done", null, { timeout: 30_000 });
  const ms = Date.now() - t0;
  const m = await alice.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number; longTasks: number; reads0: number }; __carton: { live: { reads: number } } };
    const r = (window as unknown as { __cartonRenders: { clip: number } }).__cartonRenders;
    return { frames: w.__bench.frames, longTasks: w.__bench.longTasks, reads: w.__carton.live.reads - w.__bench.reads0, clipRenders: r.clip };
  });
  const line = { host: kind, edits: edits + 1, ms, ...m, clips, uptime: execFileSync("uptime").toString().trim() };
  appendFileSync(out, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line));
  await carton.close();
} finally {
  await browser.close();
  await host.close();
}
