// measured.json, the cost calculator's inputs: each per-operation cost the lab measured (the median of its runs' values,
// with n, min, max and the run files), the speeds of every run (yesterday's included), the limits found, and the
// network profiles. An input the lab has no runs for keeps costmodel.ts's value with status "estimated" and says why.
// Reads the run records and their `.c2.json` (analyze.ts) in the runs folder.
//
//   node bench/cloudflare/measured.ts [out.json]      default: bench/cloudflare/results/measured.json
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { RUNS_DIR } from "./paths.ts";
import { MEASURED } from "./costmodel.ts";

const out = process.argv[2] ?? join(import.meta.dirname, "results", "measured.json");
// runs tagged `cfv` are the independent verifier's (it reuses this harness and folder): never mixed into these medians
const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json") && !/\.(cost|c2|note)\.json$/.test(f) && !/-cfv/.test(f));
const runs = new Map<string, any>();
for (const f of files) runs.set(f, JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")));
const c2 = new Map<string, any>();
for (const f of files) {
  const p = join(RUNS_DIR, f.replace(/\.json$/, ".c2.json"));
  if (existsSync(p)) c2.set(f, JSON.parse(readFileSync(p, "utf8")));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
};
const round = (x: number, d = 4) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : x);

// first guesses for inputs costmodel.ts has no value for, used only until runs measure them
const ESTIMATES: Record<string, number> = { connWorkerCpuMs: 0.5, connRowsRead: 1, connGBs: 0.01, adoptRowsWritten: 64, presenceFanoutPerMsg: 1, presenceAlarmDoReqPerHour: 60, presenceAlarmRowsWritten: 1, presenceAlarmGBs: 0.01, presenceRowsWritten: 0, idleDoReqPerHour: 0, idleGBsPerHour: 0, idleRowsWrittenPerHour: 0, gbVaultWorkerReq: 140, gbVaultWorkerCpuMs: 1000, gbVaultGBs: 50, segR2ClassB: 2, segWorkerCpuMs: 2, viewWorkerReqPerMiB: 0.5, viewClassBPerMiB: 0.5, viewWorkerCpuMsPerMiB: 1, editRoomCpuMs: 1.3 };
type Input = { value: number; unit: string; status: "measured" | "estimated"; n: number; min?: number; max?: number; runs: string[]; values?: number[]; how: string };
const inputs: Record<string, Input> = {};

/** An input from the runs `pick` selects: `get` gives each run's value (null: not usable). */
function input(key: string, unit: string, how: string, pick: (run: any, c: any, f: string) => boolean, get: (c: any, run: any) => number | null | undefined, minRuns = 3) {
  const vals: number[] = [], used: string[] = [];
  for (const [f, run] of runs) {
    const c = c2.get(f);
    if (!c || c.error || !pick(run, c, f)) continue;
    const v = get(c, run);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    vals.push(v);
    used.push(f);
  }
  if (vals.length < minRuns) {
    const old = (MEASURED as Record<string, number>)[key];
    inputs[key] = { value: old ?? (ESTIMATES[key] ?? null), unit, status: "estimated", n: vals.length, runs: used, ...(vals.length ? { values: vals.map((v) => round(v)) } : {}), how: `not measured yet (${vals.length} of ${minRuns} runs); costmodel.ts's estimate. ${how}` };
    return;
  }
  inputs[key] = { value: round(median(vals)), unit, status: "measured", n: vals.length, min: round(Math.min(...vals)), max: round(Math.max(...vals)), runs: used, values: vals.map((v) => round(v)), how };
}

// what one adoption and one connect cost (the connect runs), to take them out of the per-edit and presence figures
const connC2 = [...c2.values()].filter((c) => c.kind === "connect" && !c.error);
const adoptRows = connC2.length ? median(connC2.map((c) => c.per.adoptRowsWritten)) : 64;
const connRows = connC2.length ? median(connC2.map((c) => c.per.rowsWrittenPerConn)) : 0;
const connGbs = connC2.length ? median(connC2.map((c) => c.per.gbsPerConn)) : 0;

const isEdit = (r: any, c: any) => c.kind === "edits" && !r.chaos && !/smoke/.test(r.runId);
// ---------------------------------------------------------------- live sync, per edit
input("editDoReq", "DO requests per edit", "Edit runs with no link chaos (good/4g/3g/bad, 2-20 parties, both hosts): the room's hibernation events (one per WebSocket frame it is handed) less the hellos, closes and adoption, over the edits committed; read per room from durableObjectsInvocationsAdaptiveGroups by type.", isEdit, (c) => c.per.doReqPerEditNet);
input("editRowsWritten", "DO rows written per edit", "Same runs: the room's rows written less the adoption's (median of the connect runs) and each connect's, over the edits.", isEdit, (c) => (c.room.rowsWritten - adoptRows - c.per.reconnects * connRows) / c.per.edits);
input("editRowsRead", "DO rows read per edit", "Same runs: the room's rows read over the edits (gross: includes the run's connects and adoption, about 1 row each).", isEdit, (c) => c.per.rowsReadPerEditGross);
input("editGBs", "DO GB-s per edit", "Same runs: the room's active time (durableObjectsPeriodicGroups activeTime) x 128 MB over the edits, gross (it includes the run's connects: they arrive together, in the same wakes, so a connect run's per-connect figure can't be taken out); a room with hibernatable sockets is billed only while it handles an event.", isEdit, (c) => c.per.gbsPerEdit);
input("editRoomCpuMs", "DO CPU ms per edit", "Same runs: the room's CPU time over the edits (gross).", isEdit, (c) => c.per.cpuMsPerEdit);

// ---------------------------------------------------------------- connects
const isConn = (_r: any, c: any) => c.kind === "connect";
input("connWorkerReq", "Worker requests per connect", "20 connects per run, one at a time, each a real SyncClient that opens, waits until up to date and closes (fresh replica or the same replica reconnecting): the project's requests in wrangler tail over the connects.", isConn, (c) => c.per.workerReqPerConn);
input("connWorkerCpuMs", "Worker CPU ms per connect", "Same runs: the Worker CPU of those requests (wrangler tail cpuTime).", isConn, (c) => c.per.workerCpuMsPerConn);
input("connDoReq", "DO requests per connect", "Same runs: the room's requests in the connect minutes (they start on a fresh minute after the adoption): the upgrade, the hello, the close.", isConn, (c) => c.per.doReqPerConn);
input("connRowsWritten", "DO rows written per connect", "Same runs: the room's rows written in the connect minutes over the connects.", isConn, (c) => c.per.rowsWrittenPerConn);
input("connRowsRead", "DO rows read per connect", "Same runs: rows read in the connect minutes over the connects (an empty cut: a long catch-up reads more).", isConn, (c) => c.per.rowsReadPerConn);
input("connGBs", "DO GB-s per connect", "Same runs: the room's active time in the connect minutes x 128 MB over the connects.", isConn, (c) => c.per.gbsPerConn);
input("adoptRowsWritten", "DO rows written per project adoption", "Same runs: the room's rows written in the minutes before the connects (the cut's adoption: 4 tracks, 40 clips).", isConn, (c) => c.per.adoptRowsWritten);

// ---------------------------------------------------------------- presence
const isDrag = (r: any, c: any) => c.kind === "presence" && !/smoke/.test(r.runId);
input("presenceMsgPerSecWhileDragging", "presence frames per second on the wire while dragging", "The Carton web app's PresenceSender fed a drag ghost at 60 Hz (pointermove) for 60 s with 1 and with 4 watchers: frames the transport sent, over 60 s. The sender asks for 20 Hz and SyncClient caps it at PRESENCE_PER_SEC = 10. The Cardboard desktop integration sends at most 1 a second (on pointerdown/keydown/wheel, not while dragging).", isDrag, (c) => c.per.msgsPerSec);
input("presenceDoReq", "DO requests per presence frame", "Same runs: the room's hibernation events less every other frame, the adoption and the closes, over the presence frames.", isDrag, (c) => c.per.doReqPerMsg);
input("presenceGBs", "DO GB-s per presence frame", "Same runs: the room's active time x 128 MB over the frames, gross (it includes the run's connects and adoption).", isDrag, (c) => c.per.gbsPerMsg);
input("presenceRowsWritten", "DO rows written per presence frame", "Same runs: the room's rows written less the adoption's and the connects', over the frames (presence is never stored).", isDrag, (c) => (c.room.rowsWritten - adoptRows - c.parties * connRows) / c.per.msgs);
input("presenceFanoutPerMsg", "frames delivered per presence frame (per watcher)", "Same runs: presence events the watchers received over the frames sent, per watcher (outbound frames are not billed).", isDrag, (c) => c.per.fanoutPerMsg / Math.max(1, c.per.watchers));
const isAlarm = (_r: any, c: any) => c.kind === "alarm";
input("presenceAlarmPerHour", "presence-check alarms per room-hour while someone shows presence", "One party shows presence once and stays connected, silent but for its keepalive pings, for 15 min (3 rooms at once): the room's alarm invocations in the whole minutes from 90 s after, per hour.", isAlarm, (c) => c.per.alarmsPerHour);
input("presenceAlarmDoReqPerHour", "DO requests per room-hour while someone shows presence (no edits)", "Same runs: every request of the room in those minutes, per hour (the alarms; pings are answered by the runtime).", isAlarm, (c) => c.per.doReqPerHour);
input("presenceAlarmRowsWritten", "DO rows written per presence-check alarm", "Same runs: the room's rows written in those minutes over its alarms.", isAlarm, (c) => c.per.rowsWrittenPerAlarm);
input("presenceAlarmGBs", "DO GB-s per presence-check alarm", "Same runs: the room's active time in those minutes x 128 MB over its alarms.", isAlarm, (c) => c.per.gbsPerAlarm);

// ---------------------------------------------------------------- idle sessions
const isIdle = (_r: any, c: any) => c.kind === "idle";
input("idleDoReqPerHour", "DO requests per connected idle party-hour", "2 and 5 parties connected to one room, nobody editing or showing presence, for 10 min (3 rooms each, at once): the room's requests in the whole minutes from 30 s after all were up, per party-hour.", isIdle, (c) => c.per.doReqPerPartyHour);
input("idleGBsPerHour", "DO GB-s per connected idle party-hour", "Same runs: the room's active time x 128 MB in those minutes, per party-hour.", isIdle, (c) => c.per.gbsPerPartyHour);
input("idleRowsWrittenPerHour", "DO rows written per connected idle party-hour", "Same runs: the room's rows written in those minutes, per party-hour.", isIdle, (c) => c.per.rowsWrittenPerPartyHour);

// ---------------------------------------------------------------- media upload, per GB (1e9 bytes)
const isUp = (host: string) => (r: any, c: any) => c.kind === "upload" && r.host === host && /-cost-/.test(r.runId) && r.upload?.result;
input("gbR2ClassA", "R2 Class A operations per GB uploaded", "1 GiB uploads with the client's defaults (8 MiB parts, 2 in flight) after fix/cf-stream-parts, unshaped: R2 operations in the upload phase on the project's keys and its uploads' records (r2OperationsAdaptiveGroups by objectName and actionType), Class A per R2's pricing page, per 1e9 bytes. The analytics are sampled (estimates per group, about +/-10% per run); the code path gives 4 per 8 MiB part (UploadPart, and the adapter's lock, record and release objects) + 3 per upload, about 480 per GB.", isUp("r2"), (c) => c.per.r2ClassAPerGB);
input("gbR2ClassB", "R2 Class B operations per GB uploaded", "Same runs: Class B (HeadObject, GetObject) per 1e9 bytes, sampled; the code path gives 1 per part (a head of the upload's meta record) plus the dedup checks, about 120 per GB.", isUp("r2"), (c) => c.per.r2ClassBPerGB);
input("gbWorkerReq", "Worker requests per GB uploaded (R2)", "Same runs: the project's requests in wrangler tail during the upload phase, per 1e9 bytes.", isUp("r2"), (c) => c.per.workerReqPerGB);
input("gbWorkerCpuMs", "Worker CPU ms per GB uploaded (R2)", "Same runs: those requests' CPU time (wrangler tail), per 1e9 bytes.", isUp("r2"), (c) => c.per.workerCpuMsPerGB);
input("gbDoReq", "DO requests per GB uploaded (R2; the daily write cap's counter)", "Same runs: requests to the deployment's write-cap counter room (one reserve per write call) in the upload phase's minutes, per 1e9 bytes; an upper bound (the counter is shared, and other runs' keyframe writes in those minutes count too; the code path gives 1 per part + 2, about 121 per GB); 0 without the cap.", isUp("r2"), (c) => c.per.writeCapDoReqPerGB);
input("gbVaultRowsWritten", "DO rows written per GB uploaded (no R2: the vault)", "1 GiB uploads to the no-R2 deployment (blobs in the BlobVault DO), client defaults, unshaped: the project's vault object's rows written in the upload phase, per 1e9 bytes.", isUp("nor2"), (c) => c.per.vaultRowsWrittenPerGB);
input("gbVaultDoReq", "DO requests per GB uploaded (no R2), vault and write cap", "Same runs: requests to the vault object and the write-cap counter, per 1e9 bytes.", isUp("nor2"), (c) => c.per.doReqPerGB);
input("gbVaultWorkerReq", "Worker requests per GB uploaded (no R2)", "Same runs: the project's requests in wrangler tail during the upload, per 1e9 bytes.", isUp("nor2"), (c) => c.per.workerReqPerGB);
input("gbVaultWorkerCpuMs", "Worker CPU ms per GB uploaded (no R2)", "Same runs: their CPU time (wrangler tail), per 1e9 bytes.", isUp("nor2"), (c) => c.per.workerCpuMsPerGB);
input("gbVaultGBs", "DO GB-s per GB uploaded (no R2)", "Same runs: the vault object's active time x 128 MB in the upload phase, per 1e9 bytes.", isUp("nor2"), (c) => c.per.vaultGbsPerGB);

// ---------------------------------------------------------------- preview proxy and playback
const isSeg = (r: any, c: any) => c.kind === "proxy" && r.host === "r2" && r.segments > 0;
input("segWorkerReq", "Worker requests per proxy segment published", "A 10-minute 1280x720 source shared as the app does (shareMedia: libx264 cuts the 720p collab proxy into 2 s CMAF segments, each uploaded as made): the project's requests in wrangler tail over the share, per segment.", isSeg, (c) => c.per.workerReqPerSeg);
input("segR2ClassA", "R2 Class A per proxy segment published", "Same runs: Class A on the project's keys over the share, per segment.", isSeg, (c) => c.per.r2ClassAPerSeg);
input("segR2ClassB", "R2 Class B per proxy segment published", "Same runs: Class B over the share, per segment (dedup checks).", isSeg, (c) => c.per.r2ClassBPerSeg);
input("segWorkerCpuMs", "Worker CPU ms per proxy segment published", "Same runs: those requests' CPU (wrangler tail), per segment.", isSeg, (c) => c.per.workerCpuMsPerSeg);
const isPlay = (r: any, c: any) => c.kind === "playback" && r.host === "r2" && r.bytes > 0;
input("viewWorkerReqPerMiB", "Worker requests per MiB played", "A teammate plays the whole proxy from the start as the app's player does (ProxyStreamReader over MediaReader, empty leaf cache): the project's requests in wrangler tail over the play, per MiB.", isPlay, (c) => c.per.workerReqPerMiB);
input("viewClassBPerMiB", "R2 Class B per MiB played", "Same runs: Class B on the project's keys over the play, per MiB.", isPlay, (c) => c.per.r2ClassBPerMiB);
input("viewWorkerCpuMsPerMiB", "Worker CPU ms per MiB played", "Same runs: those requests' CPU (wrangler tail), per MiB.", isPlay, (c) => c.per.workerCpuMsPerMiB);
input("viewMiBPerGet", "MiB per R2 GetObject while playing", "Same runs: MiB played over GetObject operations.", isPlay, (c) => c.per.mibPerGet);

// R2 per GB uploaded, by action type (the median of each action over the same runs): which operations make the classes
for (const key of ["gbR2ClassA", "gbR2ClassB"]) {
  const inp = inputs[key];
  if (!inp || inp.status !== "measured") continue;
  const per: Record<string, number[]> = {};
  for (const f of inp.runs) for (const [a, v] of Object.entries<number>(c2.get(f)?.per?.r2ByActionPerGB ?? {})) (per[a] ??= []).push(v);
  (inp as any).byAction = Object.fromEntries(Object.entries(per).map(([a, vs]) => [a, round(median(vs))]));
}

// pushes go to the room over the socket: the Worker sees only each connect's upgrade
inputs.editWorkerCpuMs = { value: 0, unit: "Worker CPU ms per edit", status: inputs.connWorkerReq?.status === "measured" ? "measured" : "estimated", n: inputs.connWorkerReq?.n ?? 0, runs: inputs.connWorkerReq?.runs ?? [], how: "Edits go to the room over the open WebSocket, never through the Worker: in wrangler tail the only Worker requests of a sync run are each connect's upgrade (see connWorkerReq)." };

// ---------------------------------------------------------------- speeds
const speeds: any[] = [];
const groups = new Map<string, any[]>();
for (const [f, r] of runs) {
  if (!r.runId?.startsWith("sync-") || !(r.commits > 0) || /smoke/.test(r.runId)) continue;
  const tag = /-\d+p-r\d+-(.+)-[a-z0-9]+$/.exec(r.runId)?.[1] ?? "";
  const key = `${r.host}|${r.profile}|${r.chaos ?? ""}|${r.parties}|${tag}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push({ f, r });
}
for (const [key, list] of [...groups].sort()) {
  const [host, profile, chaos, parties, tag] = key.split("|");
  const conv = list.map((x) => x.r.convergenceMs);
  // lost: never answered (see the outage block); runs before the log-check fix counted keyframe placeholders too
  const lostOf = (r: any) => (r.logs || !r.chaos ? r.lost : r.commits - r.confirmed - r.absorbed - r.rejectedByValidation);
  const lost = list.reduce((s, x) => s + lostOf(x.r), 0);
  const id = `sync-${profile}${chaos ? `-${chaos}` : ""}-${parties}p-${host}${tag ? `-${tag}` : ""}`;
  speeds.push({
    id, what: chaos === "outage" ? "live sync through a link outage: an edit visible to every party (commit to held confirmed everywhere)" : "live sync: an edit visible to every party (commit to held confirmed everywhere)",
    network: profile, storage: host, parties: Number(parties), sizeMB: null, metric: "convergence",
    p50: Math.round(median(conv.map((c) => c.p50))), p90: Math.round(median(conv.map((c) => c.p90))), p99: Math.round(median(conv.map((c) => c.p99))), unit: "ms",
    runs: list.length, status: "measured",
    note: `medians of the runs' own p50/p90/p99; per run p50/p90/p99: ${list.map((x) => `${x.r.convergenceMs.p50}/${x.r.convergenceMs.p90}/${x.r.convergenceMs.p99}`).join(", ")}; edits ${list.reduce((s, x) => s + x.r.commits, 0)}, lost ${lost}, duplicates ${list.reduce((s, x) => s + x.r.duplicates, 0)}, same final state in ${list.filter((x) => x.r.sameState).length}/${list.length}; confirm p50 ${Math.round(median(list.map((x) => x.r.confirmMs.p50)))} ms; loop lag p99 max ${Math.round(Math.max(...list.map((x) => x.r.loopLagMs?.p99max ?? 0)))} ms`,
    runFiles: list.map((x) => x.f),
  });
}
// outages: how soon the party cut off shows offline, how soon after the link is back its offline edits are confirmed,
// lost edits and conflict cards (sync.ts's timeline and commitsByParty, ms after the edits began)
const outageRuns = [...runs].filter(([, r]) => r.chaos === "outage" && Array.isArray(r.timeline) && Array.isArray(r.chaosLog) && r.chaosLog.length && r.chaosLog[0].t < 1e9);
const outageGroups = new Map<string, [string, any][]>();
for (const x of outageRuns) {
  const tag = /-\d+p-r\d+-(.+)-[a-z0-9]+$/.exec(x[1].runId)?.[1] ?? "";
  const k = `${x[1].host}|${x[1].profile}|${x[1].parties}|${tag}`;
  (outageGroups.get(k) ?? outageGroups.set(k, []).get(k)!).push(x);
}
for (const [k, list] of outageGroups) {
  const [host, profile, parties, tag] = k.split("|");
  const per = list.map(([f, r]) => {
    const on = r.chaosLog.find((c: any) => c.i === 0 && c.hole === "on")?.t, off = r.chaosLog.find((c: any) => c.i === 0 && c.hole === "off")?.t;
    const tl: any[] = r.timeline[0];
    const shown = tl.find(([t, ev, d]: any) => t >= on && (ev === "offline" || (ev === "status" && d === "offline")));
    const back = tl.find(([t, ev, d]: any) => t >= off && (ev === "online" || (ev === "status" && (d === "syncing" || d === "up-to-date"))));
    const offlineCommits = (r.commitsByParty[0] as any[]).filter(([t]) => t >= on && t <= off);
    const lastConfirm = Math.max(...offlineCommits.map(([t, c]) => (c === null ? Infinity : t + c)));
    // lost: committed and never answered (confirmed, absorbed or rejected). Runs before the log check was fixed
    // (sync.ts, 2026-11-02 01:50) also counted a reconnected party's keyframe placeholders as lost; their outcome
    // count is what holds.
    const lost = r.logs ? r.lost : r.commits - r.confirmed - r.absorbed - r.rejectedByValidation;
    return { f, offlineMs: shown ? shown[0] - on : null, reconnectMs: back ? back[0] - off : null, catchUpMs: lastConfirm - off, offlineEdits: offlineCommits.length, lost, cards: r.conflictCards, settleMs: r.timing.settleMs, sameState: r.sameState };
  });
  const base = { network: profile, storage: host, parties: Number(parties), sizeMB: null, unit: "ms", runs: list.length, status: "measured", runFiles: list.map(([f]) => f) };
  const tail = `lost ${per.map((p) => p.lost).join("/")}, conflict cards ${per.map((p) => p.cards).join("/")}, edits made offline ${per.map((p) => p.offlineEdits).join("/")}, same final state ${per.filter((p) => p.sameState).length}/${per.length}`;
  const add = (id: string, what: string, xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
    speeds.push({ id: `outage-${id}-${parties}p-${host}${tag ? `-${tag}` : ""}`, what, ...base, metric: id, p50: v.length ? Math.round(median(v)) : null, p90: v.length ? Math.round(pct(v, 0.9)) : null, p99: v.length ? Math.round(pct(v, 0.99)) : null, note: `per run: ${xs.map((x) => (x === null || !Number.isFinite(x) ? "never" : Math.round(x))).join(", ")}; ${tail}` });
  };
  add("offline-shown", "a 5-minute outage: from the link going dead to the client showing offline", per.map((p) => p.offlineMs));
  add("reconnect", "a 5-minute outage: from the link coming back to the client connected again", per.map((p) => p.reconnectMs));
  add("catch-up", "a 5-minute outage: from the link coming back to every edit made offline confirmed", per.map((p) => p.catchUpMs));
}

// media: uploads, dedup, preview, teammate's first MiB, downloads
const mediaGroups = new Map<string, any[]>();
for (const [f, r] of runs) {
  if (!r.runId?.startsWith("media-") || /smoke|tune|tail\d/.test(r.runId)) continue;
  const fixed = Date.parse(r.window?.start) > Date.parse("2026-11-01T18:55:00Z");
  // runs on either side of a fix that changes their outcome are kept apart: the R2 part lock (fix/cf-part-lock, deployed
  // 02:14:37) for a killed upload's resume, and Node's connect attempt time (fix/cf-slow-link-connect) on the bad profile
  const variant = /-partlock-/.test(r.runId) ? "after-part-lock-fix" : r.host === "r2" && /-resume-kill-m2-/.test(r.runId) ? "before-part-lock-fix" : /-b5fix-/.test(r.runId) ? "after-connect-fix" : r.profile === "bad" && /-b5-/.test(r.runId) ? "before-connect-fix" : "";
  const key = `${r.host}|${r.size}|${r.profile}|${/-resume-(kill|hole)/.exec(r.runId)?.[1] ?? ""}|${fixed ? "after" : "before"}|${variant}`;
  (mediaGroups.get(key) ?? mediaGroups.set(key, []).get(key)!).push({ f, r });
}
const MBof = (b: number) => Math.round(b / 1e6);
for (const [key, list] of [...mediaGroups].sort()) {
  const [host, size, profile, resume, when, variant] = key.split("|");
  const ok = list.filter((x) => x.r.upload?.result);
  const base = { network: profile, storage: host, parties: null, sizeMB: MBof(Number(size)), status: "measured" };
  const note = (xs: number[]) => `per run: ${xs.map((v) => Math.round(v)).join(", ")}`;
  const sp = (id: string, what: string, metric: string, xs: number[], unit: string, extra = "") => {
    if (!xs.length) return;
    speeds.push({ id, what, ...base, metric, p50: round(median(xs)), p90: round(pct(xs, 0.9)), p99: round(pct(xs, 0.99)), unit, runs: xs.length, note: `${note(xs)}${extra ? `; ${extra}` : ""}`, runFiles: list.map((x) => x.f) });
  };
  const tagId = `${MBof(Number(size))}MB-${profile}-${host}${resume ? `-resume-${resume}` : ""}${when === "before" ? "-before-fix" : ""}${variant ? `-${variant}` : ""}`;
  const failed = list.length - ok.length;
  sp(`upload-${tagId}`, `upload of the original (uploadMedia, client defaults)${resume ? `, ${resume === "kill" ? "uploader killed" : "link cut"} mid-way and resumed` : ""}`, "time", ok.map((x) => x.r.upload.ms), "ms", `${failed ? `${failed} of ${list.length} did not complete; ` : ""}Mbit/s ${ok.map((x) => (x.r.upload.mbps ?? 0).toFixed(1)).join(", ")}${resume ? `; re-sent bytes ${ok.map((x) => x.r.upload.resentBytes ?? "?").join(", ")}` : ""}`);
  if (!ok.length && list.length) speeds.push({ id: `upload-${tagId}`, what: "upload of the original (uploadMedia, client defaults)", ...base, metric: "time", p50: null, p90: null, p99: null, unit: "ms", runs: list.length, status: "measured", note: `none of ${list.length} completed: ${list.map((x) => x.r.upload?.sessions?.map((s: any) => s.failed?.error?.slice(0, 60)).filter(Boolean)[0] ?? "?").join(" | ")}`, runFiles: list.map((x) => x.f) });
  sp(`dedup-${tagId}`, "the same file shared again (dedup: nothing sent)", "time", list.filter((x) => x.r.dedup?.deduped).map((x) => x.r.dedup.ms), "ms");
  sp(`preview-${tagId}`, "a teammate can preview: the proxy's first 2 s segment (640 KiB) up and fetched", "time", list.filter((x) => x.r.preview?.totalMs && !x.r.preview.failed).map((x) => x.r.preview.totalMs), "ms");
  sp(`full-original-${tagId}`, "a teammate has the full original (upload done, head and first MiB fetched)", "time", ok.filter((x) => x.r.teammateOriginal).map((x) => x.r.teammateOriginal.afterUploadStartMs), "ms");
  const dl = list.filter((x) => x.r.download);
  for (const dp of new Set(dl.map((x) => x.r.download.profile))) {
    const d = dl.filter((x) => x.r.download.profile === dp);
    const good = d.filter((x) => !x.r.download.failed);
    speeds.push({ id: `download-${MBof(d[0].r.download.bytes ?? Number(size))}MB-${dp}-${host}${when === "before" ? "-before-fix" : ""}`, what: `a teammate downloads the media (${d[0].r.download.via ?? "ranged GETs, no retry"})`, network: dp, storage: host, parties: null, sizeMB: MBof(good[0]?.r.download.bytes ?? Number(size)), metric: "time", p50: good.length ? round(median(good.map((x) => x.r.download.ms))) : null, p90: good.length ? round(pct(good.map((x) => x.r.download.ms), 0.9)) : null, p99: good.length ? round(pct(good.map((x) => x.r.download.ms), 0.99)) : null, unit: "ms", runs: d.length, status: "measured", note: `${d.length - good.length} failed${d.length - good.length ? ` (${d.filter((x) => x.r.download.failed).map((x) => x.r.download.failed.code ?? x.r.download.failed.error).join(", ")})` : ""}; Mbit/s ${good.map((x) => (x.r.download.mbps ?? 0).toFixed(2)).join(", ")}`, runFiles: d.map((x) => x.f) });
  }
}
// proxy publishing and playback
for (const kind of ["share", "play"]) {
  const list = [...runs].filter(([, r]) => r.runId?.startsWith(`proxy-r2-${kind}-`) || r.runId?.startsWith(`proxy-nor2-${kind}-`));
  for (const host of ["r2", "nor2"]) {
    const l = list.filter(([, r]) => r.host === host && !r.failed);
    if (!l.length) continue;
    const xs = l.map(([, r]) => r.ms);
    speeds.push({ id: `proxy-${kind}-10min-${host}`, what: kind === "share" ? "publish a 10-minute 720p proxy (encode + upload, 2 s segments)" : "a teammate plays the whole 10-minute proxy (fetch + verify, as fast as it can)", network: "none", storage: host, parties: null, sizeMB: MBof(l[0]![1].bytes), metric: "time", p50: round(median(xs)), p90: round(pct(xs, 0.9)), p99: round(pct(xs, 0.99)), unit: "ms", runs: l.length, status: "measured", note: `per run: ${xs.map((x) => Math.round(x)).join(", ")}${kind === "play" ? `; first part after ${l.map(([, r]) => Math.round(r.firstMs)).join(", ")} ms` : `; segments ${l.map(([, r]) => r.segments).join(", ")}`}`, runFiles: l.map(([f]) => f) });
  }
}

// ---------------------------------------------------------------- limits
const limits = JSON.parse(readFileSync(join(import.meta.dirname, "results", "limits.json"), "utf8"));

let commit = "";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname }).toString().trim(); } catch {}
const doc = {
  schema: 1,
  generated: new Date().toISOString(),
  source: { branch: "lab/cloudflare", commit, runsDir: "_inspect/carton-build/cf-lab/runs" },
  inputs,
  speeds,
  limits,
  networkProfiles: {
    none: "unshaped: the lab box (AWS Mumbai) to Cloudflare's BOM edge, TCP handshake 1-2 ms",
    good: "20 Mbit/s each way, 15 ms each way (30 ms RTT added); measured handshake RTT 32 ms",
    "4g": "5 Mbit/s each way, 40 ms each way, 0.5% loss each way (80 ms RTT added); measured handshake RTT 82 ms",
    "3g": "1 Mbit/s each way, 100 ms each way, 1% loss each way (200 ms RTT added); measured handshake RTT 203-208 ms",
    bad: "256 kbit/s each way, 200 ms +/- 50 ms (normal) each way, 3% loss each way (~400 ms RTT added); measured handshake RTT 313-464 ms",
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
const st = Object.values(inputs);
console.log(`${out}: ${st.filter((i) => i.status === "measured").length} inputs measured, ${st.filter((i) => i.status === "estimated").length} estimated; ${speeds.length} speeds; ${limits.length} limits`);
for (const [k, v] of Object.entries(inputs)) console.log(`${k.padEnd(32)} ${String(v.value).padStart(12)} ${v.status.padEnd(9)} n=${v.n}${v.min !== undefined ? ` [${v.min} .. ${v.max}]` : ""}  ${v.unit}`);
