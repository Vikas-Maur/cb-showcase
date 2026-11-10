// Where a stream append's Worker CPU goes (cf-proxy-path): the real Worker in local workerd (`wrangler dev`, R2 and the
// daily write cap on), sent appends of real-sized parts through the real client, with V8's CPU profiler on over the
// inspector. Prints the profiled time per append and per part, and the functions with the most self time. In-Worker
// clocks don't move while code runs, so the profiler is the only way to see this locally; its absolute numbers are this
// machine's, not Cloudflare's: compare runs, not against the 10 ms limit.
//   node bench/append-profile.ts [--parts 4] [--appends 12] [--part-kb 650] [--top 25]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createHmacAuth } from "@carton/server";
import { hostMediaBlobs } from "@carton/host-http/client";
import { mediaHash, webCryptoHasher, type StreamAppendPart } from "@carton/media";

const { values: a } = parseArgs({ options: { parts: { type: "string", default: "4" }, appends: { type: "string", default: "12" }, "part-kb": { type: "string", default: "650" }, top: { type: "string", default: "25" }, label: { type: "string", default: "" } } });
const PARTS = Number(a.parts), APPENDS = Number(a.appends), PART = Number(a["part-kb"]) * 1024;
const SECRET = "bench-only-secret-bench-only-secret-0123";
// this package's own wrangler (a devDependency)
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

const state = mkdtempSync(join(process.env.CARTON_SCRATCH ?? tmpdir(), "append-profile-"));
mkdirSync(join(state, "tmp"));
const port = await freePort(), inspector = await freePort();
const child = spawn(process.execPath, [WRANGLER, "dev", "--config", join(import.meta.dirname, "..", "test", "wrangler.r2.dev.toml"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", join(state, "wrangler"), "--log-level", "warn", "--show-interactive-dev-session=false",
  "--var", `AUTH_SECRET:${SECRET}`, "--var", "WRITE_CAP_BYTES_PER_DAY:100000000000", "--var", "WRITE_CAP_OPS_PER_DAY:10000000"], {
  cwd: join(import.meta.dirname, "..", "test"), env: { ...process.env, TMPDIR: join(state, "tmp"), WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let log = "";
child.stdout!.on("data", (d) => (log += d));
child.stderr!.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} rmSync(state, { recursive: true, force: true }); };
process.on("exit", stop);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(1));
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
  if (i > 300) throw new Error("wrangler dev didn't come up:\n" + log);
  await new Promise((r) => setTimeout(r, 300));
}

console.error("[profile] worker up");
// the Worker's isolate through wrangler's inspector proxy (it takes an Origin of localhost; workerd's own inspector
// serves the one session the proxy holds)
const targets = (await (await fetch(`http://127.0.0.1:${inspector}/json`)).json()) as { webSocketDebuggerUrl: string }[];
const ws = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(targets[0]!.webSocketDebuggerUrl, { headers: { origin: "http://localhost" } });
await new Promise((r, no) => (ws.addEventListener("open", r, { once: true }), ws.addEventListener("error", () => no(new Error("inspector socket failed")), { once: true })));
console.error("[profile] connected", targets[0]!.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
ws.binaryType = "arraybuffer";
let seenMsgs = 0;
ws.addEventListener("message", (e) => {
  const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
  if (seenMsgs++ < 3) console.error("[profile] cdp <", text.slice(0, 200));
  const m = JSON.parse(text);
  if (m.id && pending.has(m.id)) (pending.get(m.id)!(m), pending.delete(m.id));
});
const cdp = (method: string, params: object = {}) => new Promise<any>((ok, no) => { const id = nextId++; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => no(new Error(`cdp ${method}: no answer`)), 30_000).unref(); });

// parts: random bytes (incompressible, as video), real manifests
const hasher = webCryptoHasher();
const parts: StreamAppendPart[] = [];
for (let i = 0; i < PARTS * APPENDS; i++) {
  const bytes = crypto.getRandomValues(new Uint8Array(PART > 65536 ? 65536 : PART));
  const full = new Uint8Array(PART);
  for (let o = 0; o < PART; o += bytes.length) full.set(bytes.subarray(0, Math.min(bytes.length, PART - o)), o), crypto.getRandomValues(bytes);
  const m = await mediaHash(full, hasher);
  parts.push({ kind: "segment", hash: m.hash, size: m.size, manifest: m.bytes, bytes: full, index: i, durationSec: 2, at: Date.now() });
}
const token = await createHmacAuth({ secret: SECRET }).issue({ account: "a", credential: "a/dev", role: "editor", projectId: "bench", ttlMs: 600_000 });
const media = hostMediaBlobs({ origin, projectId: "bench", token });
const stream = "ab".repeat(32);
// warm the isolate (first-call compilation is not the steady state)
await media.appendStream("cd".repeat(32), { parts: parts.slice(0, 1).map((p) => ({ ...p, index: 0 })) });

await cdp("Profiler.enable");
await cdp("Profiler.setSamplingInterval", { interval: 50 });
await cdp("Profiler.start");
const t0 = performance.now();
for (let k = 0; k < APPENDS; k++) await media.appendStream(stream, { parts: parts.slice(k * PARTS, (k + 1) * PARTS) });
const wall = performance.now() - t0;
const { result } = await cdp("Profiler.stop");
const profile = result.profile as { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] };

// self time per node, from the samples
const self = new Map<number, number>();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const byFn = new Map<string, number>();
let busy = 0;
for (const n of profile.nodes) {
  const us = self.get(n.id) ?? 0;
  const name = n.callFrame.functionName || "(anonymous)";
  if (name === "(idle)" || name === "(program)" && false) continue;
  if (name !== "(idle)") busy += us;
  const where = n.callFrame.url ? `${n.callFrame.url.replace(/^.*\/(packages|node_modules)\//, "$1/")}:${n.callFrame.lineNumber + 1}` : "";
  const key = `${name} ${where}`.trim();
  byFn.set(key, (byFn.get(key) ?? 0) + us);
}
const idle = [...profile.nodes].filter((n) => n.callFrame.functionName === "(idle)").reduce((s, n) => s + (self.get(n.id) ?? 0), 0);
const ms = (us: number) => (us / 1000).toFixed(2);
console.log(JSON.stringify({ label: a.label, parts: PARTS, partKB: PART / 1024, appends: APPENDS, wallMs: Math.round(wall), busyMsPerAppend: +(busy / 1000 / APPENDS).toFixed(2), busyMsPerPart: +(busy / 1000 / APPENDS / PARTS).toFixed(2), idleMs: Math.round(idle / 1000) }));
for (const [k, us] of [...byFn].sort((x, y) => y[1] - x[1]).slice(0, Number(a.top))) console.log(`${ms(us).padStart(9)} ms  ${k}`);
ws.close();
stop();
process.exit(0);
