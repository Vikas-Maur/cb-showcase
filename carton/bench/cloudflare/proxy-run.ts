// A real preview proxy, published and played the way the app does it: the owner shares a local video (shareMedia: the
// encoder chain, here libx264, cuts the 720p collab proxy into 2 s CMAF segments, and each goes up as soon as ffmpeg
// finishes it), then a teammate plays the whole stream from the start (ProxyStreamReader over MediaReader, the app's
// player path, with the on-disk leaf cache). Two run records: `proxy-<host>-share-…` (per segment) and
// `proxy-<host>-play-…` (per MiB played); analyze.ts reads their cost per object. Unshaped (from the box); purges after.
//
//   node bench/cloudflare/proxy-run.ts --host r2 --file <video> [--rep 1]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HOSTS, secrets, tokenFor, now, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { idsOf } from "./objcost.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({ options: { host: { type: "string", default: "r2" }, file: { type: "string" }, rep: { type: "string", default: "1" }, tag: { type: "string", default: "" } } });
const host = a.host as HostName;
const file = a.file!;
const id = Date.now().toString(36);
const projectId = `proxy-${host}-r${a.rep}${a.tag ? `-${a.tag}` : ""}-${id}`;
// worst case for a 10-minute proxy at the profile's 2.5 Mbit/s cap: ~300 segments of ~0.7 MB, each a manifest, its
// bytes and an entry (sign + PUT each, a head check), and the teammate reading all of it back
const segs = 320, bytes = 260e6;
const g = await guard({ test: projectId, workersReq: segs * 12 + 600, r2ClassA: segs * 6 + 50, r2ClassB: segs * 8 + 400, r2StoredBytes: bytes, doReq: segs * 4 + 100, doRowsWritten: segs * 4 + 100, uploadBytes: bytes });
const ids = await idsOf(host, projectId);
mkdirSync(RUNS_DIR, { recursive: true });

function client(cfg: Record<string, unknown>): Promise<any[]> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(import.meta.dirname, "media-client.ts"), JSON.stringify({ host, projectId, ...cfg })], { stdio: ["ignore", "pipe", "pipe"] });
    const lines: any[] = [];
    createInterface({ input: p.stdout! }).on("line", (s) => { try { lines.push(JSON.parse(s)); } catch {} });
    createInterface({ input: p.stderr! }).on("line", (s) => { if (!/ExperimentalWarning|--trace-warnings/.test(s)) console.error(`[proxy] ${s}`); });
    p.on("close", () => ok(lines));
  });
}
const last = (ls: any[], ev: string) => [...ls].reverse().find((l) => l.ev === ev);

// the owner shares
const t0 = now();
const share = await client({ op: "proxy-share", token: await tokenFor(projectId, "owner"), file });
const t1 = now();
const shared = last(share, "shared");
const stream = shared?.proxy?.stream ?? last(share, "streaming")?.stream;
const segments: number = shared?.end?.segments ?? 0;
const shareRun = {
  runId: `proxy-${host}-share-r${a.rep}-${id}`, op: "share", projectId, host, window: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString() }, ids,
  phases: { share: [Math.round(t0), Math.round(t1)] }, file, fileBytes: statSync(file).size,
  stream, segments, durationSec: shared?.end?.durationSec ?? null, bytes: shared?.end?.size ?? shared?.proxy?.size ?? null, ms: shared?.ms, firstUploadMs: shared?.firstUploadMs, streamingAtMs: last(share, "streaming")?.ms,
  requests: shared?.requests, uploadIds: share.filter((l) => l.ev === "upload-id").map((l) => l.id), failed: last(share, "failed") ?? null, events: share.filter((l) => l.ev === "share-event").slice(0, 20),
};
writeFileSync(join(RUNS_DIR, `${shareRun.runId}.json`), JSON.stringify(shareRun, null, 1));
console.log("share", JSON.stringify({ segments, bytes: shareRun.bytes, ms: Math.round(shared?.ms ?? 0), firstUploadMs: Math.round(shared?.firstUploadMs ?? 0), requests: shared?.requests, failed: shareRun.failed }));

// a teammate plays it all, from the start
let playRun: any = null;
if (stream) {
  const p0 = now();
  const play = await client({ op: "proxy-play", token: await tokenFor(projectId, "teammate"), stream });
  const p1 = now();
  const played = last(play, "played");
  playRun = { runId: `proxy-${host}-play-r${a.rep}-${id}`, op: "play", projectId, host, window: { start: new Date(p0).toISOString(), end: new Date(p1).toISOString() }, ids, phases: { play: [Math.round(p0), Math.round(p1)] }, stream, bytes: played?.bytes ?? 0, parts: played?.parts, ms: played?.ms, firstMs: played?.firstMs, requests: played?.requests, failed: last(play, "failed") ?? null };
  writeFileSync(join(RUNS_DIR, `${playRun.runId}.json`), JSON.stringify(playRun, null, 1));
  console.log("play", JSON.stringify({ bytes: playRun.bytes, parts: playRun.parts, ms: Math.round(playRun.ms ?? 0), requests: playRun.requests, failed: playRun.failed }));
}

// cleanup: every blob of the project
let purged = 0;
for (let i = 0; i < 100; i++) {
  const r = await fetch(`${HOSTS[host]}/api/lab/projects/${projectId}/purge`, { method: "POST", headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } });
  const j = (await r.json()) as { deleted: number; more: boolean };
  purged += j.deleted;
  if (!j.more) break;
}
endTest(g.id, { segments }, { uploaded: shareRun.bytes ?? 0 });
console.log(JSON.stringify({ projectId, segments, purged }));
process.exit(shareRun.failed || !playRun || playRun.failed ? 3 : 0);
