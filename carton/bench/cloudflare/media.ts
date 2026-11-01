// Large media on the deployed Worker: upload time, resume after a cut link or a killed uploader (nothing re-sent that
// already landed), dedup (the same content twice), how soon a teammate can preview (the proxy's first 2 s segment)
// versus open the original, and downloads on slow links. The uploader runs in a shaped namespace (netns.sh, cfl0);
// the teammate in cfl1. Runs the guard first and purges the project's blobs after.
//
//   node bench/cloudflare/media.ts --host r2 --size 100M --profile good [--resume kill|hole] [--at 0.5] [--hole-sec 30]
//        [--dedup] [--preview] [--download 20M --down-profile 3g] [--keep]
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HOSTS, secrets, tokenFor, now, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({
  options: {
    host: { type: "string", default: "r2" },
    size: { type: "string", default: "100M" },
    profile: { type: "string", default: "none" },
    resume: { type: "string", default: "" },
    at: { type: "string", default: "0.5" },
    "hole-sec": { type: "string", default: "30" },
    dedup: { type: "boolean", default: false },
    preview: { type: "boolean", default: false },
    download: { type: "string", default: "" },
    "down-profile": { type: "string", default: "" },
    "teammate-profile": { type: "string", default: "" },
    concurrency: { type: "string", default: "" },
    "part-size": { type: "string", default: "" },
    seed: { type: "string", default: "" },
    keep: { type: "boolean", default: false },
    tag: { type: "string", default: "" },
    // the namespaces it uses: uploader cfl<base>, teammate cfl<base+1>
    "ns-base": { type: "string", default: "40" },
  },
});
const host = a.host as HostName;
const bytes = (s: string) => Math.round(Number(s.replace(/[KMG]i?B?$/i, "")) * ({ K: 1 << 10, M: 1 << 20, G: 1 << 30 } as Record<string, number>)[(/[KMG]/i.exec(s)?.[0] ?? "B").toUpperCase()]! || Number(s));
const size = bytes(a.size!);
const HERE = import.meta.dirname;
const netns = (...args: string[]) => execFileSync("bash", [join(HERE, "netns.sh"), ...args], { stdio: ["ignore", "ignore", "inherit"] });
const runId = `media-${host}-${a.size}-${a.profile}${a.resume ? `-resume-${a.resume}` : ""}${a.tag ? `-${a.tag}` : ""}-${Date.now().toString(36)}`;
const projectId = runId.replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 100);
const seed = a.seed || runId;
const MiB = 1 << 20;

// worst case: every part sent twice; R2 calls per part per blob-r2.ts (part + 3 Class A records + 1 Class B check),
// x2 for a resend; the vault: rows per MiB stored, copied on complete, dropped, and purged
const parts = Math.ceil(size / (8 * MiB)) + 2;
const downBytes = a.download ? bytes(a.download) : 0;
const mib = Math.ceil(size / MiB);
const est = host === "r2"
  ? { r2ClassA: parts * 8 * (a.dedup ? 1 : 1) + 50, r2ClassB: parts * 4 + Math.ceil(downBytes / MiB) + 100, r2StoredBytes: size + 2 * MiB, workersReq: parts * 3 + Math.ceil(downBytes / (4 * MiB)) + 60, doReq: parts * 3 + 40, doRowsWritten: parts * 2 + 50 }
  : { doStoredBytes: 2 * size + 2 * MiB, doRowsWritten: mib * 4 + parts * 4 + 100, doRowsRead: mib * 8 + 1000, workersReq: parts * 3 + Math.ceil(downBytes / (4 * MiB)) + 60, doReq: parts * 6 + Math.ceil(downBytes / (4 * MiB)) * 2 + 60 };
const g = await guard({ test: runId, ...est, uploadBytes: size * (a.resume ? 1.2 : 1) + 2 * MiB });

const UP = Number(a["ns-base"]), MATE = UP + 1;
netns("up", String(MATE + 1));
netns("profile", String(UP), a.profile!);
netns("profile", String(MATE), a["teammate-profile"] || a.profile!);
const ownerToken = await tokenFor(projectId, "uploader");
const mateToken = await tokenFor(projectId, "teammate");
const stateDir = mkdtempSync(join(tmpdir(), "cflab-upload-"));
const result: Record<string, any> = { runId, projectId, host, size, profile: a.profile, window: { start: new Date().toISOString() as string, end: "" } };
const events: any[] = [];

/** Runs media-client.ts in namespace `ns`; resolves with its lines. `watch` may kill it. */
function client(ns: number, cfg: Record<string, unknown>, watch?: (l: any, kill: () => void) => void): Promise<any[]> {
  return new Promise((ok) => {
    const p = spawn("bash", [join(HERE, "netns.sh"), "exec", String(ns === 0 ? UP : MATE), process.execPath, join(HERE, "media-client.ts"), JSON.stringify({ host, projectId, ...cfg })], { stdio: ["ignore", "pipe", "pipe"] });
    const lines: any[] = [];
    createInterface({ input: p.stdout! }).on("line", (s) => {
      let l: any;
      try { l = JSON.parse(s); } catch { return; }
      lines.push(l);
      if (l.ev !== "progress") events.push({ ns, ...l });
      watch?.(l, () => execFileSync("pkill", ["-KILL", "-f", `media-client.ts.*${projectId}`]));
    });
    createInterface({ input: p.stderr! }).on("line", (s) => { if (!/ExperimentalWarning|--trace-warnings/.test(s)) console.error(`[media ns${ns}] ${s}`); });
    p.on("close", () => ok(lines));
  });
}
const upCfg = { op: "upload", token: ownerToken, seed, size, stateDir, ...(a.concurrency ? { concurrency: Number(a.concurrency) } : {}), ...(a["part-size"] ? { partSize: bytes(a["part-size"]) } : {}) };
const last = (ls: any[], ev: string) => [...ls].reverse().find((l) => l.ev === ev);

// the proxy's first segment (2 s at the 720p profile's 2.5 Mbit/s peak, ≈ 625 KB): up from the uploader, then the
// teammate can play it. Measured before the original, as share.ts sends the proxy stream first.
if (a.preview) {
  const seg = 640 * 1024;
  const t0 = now();
  const put = await client(0, { op: "put", token: ownerToken, key: `lab/${projectId}/proxy-seg0`, seed: `${seed}-seg`, size: seg });
  const got = await client(1, { op: "download", token: mateToken, key: `lab/${projectId}/proxy-seg0`, bytes: seg, chunk: seg });
  result.preview = { segmentBytes: seg, uploadMs: last(put, "put")?.ms, teammateFetchMs: last(got, "downloaded")?.ms, totalMs: now() - t0, failed: last(put, "failed") ?? last(got, "failed") };
  console.log("preview", JSON.stringify(result.preview));
}

// the original
const tUp = now();
let killedAt: number | null = null, holeAt: number | null = null;
const at = Number(a.at);
let first = await client(0, upCfg, (l, kill) => {
  if (l.ev !== "progress" || l.done / l.total < at) return;
  if (a.resume === "kill" && killedAt === null) (killedAt = l.done), kill();
  if (a.resume === "hole" && holeAt === null) {
    holeAt = l.done;
    netns("hole", String(UP), "on");
    setTimeout(() => netns("hole", String(UP), "off"), Number(a["hole-sec"]) * 1000);
  }
});
const sessions = [first];
// a killed uploader is started again (the app reopened); a failed one (its retries ran out on a dead link) too
for (let i = 0; i < 5 && !last(sessions.at(-1)!, "uploaded"); i++) {
  if (a.resume === "hole") await new Promise((r) => setTimeout(r, 2000));
  sessions.push(await client(0, upCfg));
}
const done = last(sessions.at(-1)!, "uploaded");
const sent = sessions.map((s) => {
  const p = [...s].reverse().find((l) => l.ev === "progress");
  return { sent: last(s, "uploaded")?.result.bytesSent ?? p?.sent ?? 0, failed: last(s, "failed") ?? null, resumedParts: last(s, "uploaded")?.result.resumedParts ?? null };
});
result.upload = {
  ms: now() - tUp,
  hashMs: last(sessions[0]!, "hashed")?.ms,
  sessions: sent,
  bytesSentTotal: sent.reduce((s, x) => s + x.sent, 0),
  result: done?.result ?? null,
  mbps: done ? (size * 8) / 1e6 / ((now() - tUp) / 1000) : null,
  killedAtBytes: killedAt, holeAtBytes: holeAt,
  hash: done?.hash ?? last(sessions[0]!, "hashed")?.hash,
};
if (a.resume && done) {
  // what the second session sent beyond what was missing when the first stopped: re-sent bytes
  const before = killedAt ?? holeAt ?? 0;
  result.upload.resentBytes = result.upload.bytesSentTotal - size;
  result.upload.landedBeforeStop = before;
}
console.log("upload", JSON.stringify({ ms: Math.round(result.upload.ms), mbps: result.upload.mbps?.toFixed(1), sessions: sent, partSize: done?.result.partSize, resent: result.upload.resentBytes }));

// the teammate opens the original: its head, then its first 1 MiB (what a player asks for first)
if (done) {
  const key = `m/${done.hash}`;
  const h = await client(1, { op: "head", token: mateToken, key });
  const d = await client(1, { op: "download", token: mateToken, key, bytes: MiB, chunk: MiB });
  result.teammateOriginal = { headMs: last(h, "head")?.ms, firstMiBMs: last(d, "downloaded")?.ms, afterUploadStartMs: now() - tUp };
}

// dedup: the same content again, a fresh upload state (another machine sharing the same file)
if (a.dedup && done) {
  const t = now();
  const again = await client(0, { ...upCfg, stateDir: mkdtempSync(join(tmpdir(), "cflab-upload-")) });
  const r = last(again, "uploaded")?.result;
  result.dedup = { ms: now() - t, deduped: r?.deduped, bytesSent: r?.bytesSent, failed: last(again, "failed") ?? null };
  console.log("dedup", JSON.stringify(result.dedup));
}

// downloads on a (slower) profile
if (downBytes && done) {
  netns("profile", String(MATE), a["down-profile"] || a.profile!);
  const d = await client(1, { op: "download", token: mateToken, key: `m/${done.hash}`, bytes: Math.min(downBytes, size), chunk: 4 * MiB });
  const r = last(d, "downloaded");
  result.download = { profile: a["down-profile"] || a.profile, bytes: r?.bytes, ms: r?.ms, firstMs: r?.firstMs, mbps: r ? (r.bytes * 8) / 1e6 / (r.ms / 1000) : null, failed: last(d, "failed") ?? null };
  console.log("download", JSON.stringify(result.download));
}

// cleanup: every blob of the project (the lab's purge route), unless kept for the demo
let purged = 0;
if (!a.keep) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${HOSTS[host]}/api/lab/projects/${projectId}/purge`, { method: "POST", headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } });
    const j = (await r.json()) as { deleted: number; more: boolean };
    purged += j.deleted;
    if (!j.more) break;
  }
}
rmSync(stateDir, { recursive: true, force: true });
result.purged = purged;
result.events = events;
result.window.end = new Date().toISOString();
mkdirSync(RUNS_DIR, { recursive: true });
writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(result, null, 1));
const uploaded = result.upload.bytesSentTotal ?? size;
endTest(g.id, { uploaded }, host === "r2" ? { r2: a.keep ? size : 0, uploaded } : { doVault: a.keep ? size : 0, uploaded });
console.log(JSON.stringify({ runId, ok: !!done, purged }));
process.exit(done ? 0 : 3);
