// Each run's cost per unit (an edit, a presence frame, a party-hour idle, an alarm, a connect, a GB uploaded, a proxy
// segment, a MiB played), read per object from the analytics (objcost.ts) once they have caught up (6 minutes after
// the run), written next to the run as `<run>.c2.json`. measured.ts turns these into measured.json.
//
//   node bench/cloudflare/analyze.ts [run-id-substring]       FORCE=1 to redo
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.ts";
import { doUse, minutesBetween, r2Use, workerUse, workerScriptUse, idsOf } from "./objcost.ts";

const LAG_MS = 6 * 60_000;
const MIN = 60_000;
const floorMin = (t: number) => Math.floor(t / MIN) * MIN;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Which kind of run a record is. */
export function kindOf(run: any): string | null {
  const id: string = run.runId ?? "";
  if (id.startsWith("conn-")) return "connect";
  if (id.startsWith("proxy-")) return run.op === "play" ? "playback" : "proxy";
  // only runs that recorded their phases and upload ids (from 2026-11-02) can be told apart from others at the time
  if (id.startsWith("media-")) return run.phases?.upload ? "upload" : null;
  if (!id.startsWith("sync-")) return null;
  if (run.presenceMode === "drag") return "presence";
  if (run.presenceMode === "once") return "alarm";
  if (/-idle-/.test(id)) return "idle";
  if (run.commits > 0) return "edits";
  return null;
}

async function roomOf(run: any): Promise<string | null> {
  if (run.ids?.room) return run.ids.room;
  // yesterday's runs didn't record it: the id is the project name's (idFromName), so ask for it now; this replaces
  // cost.ts's guess (the busiest new room in the window), which runs sharing the clock could fool
  if (run.projectId && run.host) return (await idsOf(run.host, run.projectId)).room;
  return null;
}

/** The frames every party put on the wire (sync runs from today record them). */
const frames = (run: any) => (run.sentByType ?? []).reduce((acc: Record<string, number>, s: Record<string, number> | undefined) => {
  for (const [k, v] of Object.entries(s ?? {})) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}, {});

/**
 * Whether an R2 object (as the analytics name it) is this run's: the project's keys, or the R2 adapter's records of
 * its multipart uploads (`.carton-uploads/<uploadId>/meta|p<n>|l<n>`). The analytics keep only the last ~256
 * characters of a name and upload ids are ~340, so a record's name is matched as a suffix of `.carton-uploads/<id>`.
 */
export const ownedBy = (projectId: string, uploadIds: string[]) => (name: string) => {
  if (name.startsWith(`projects/${projectId}/`)) return true;
  const i = name.lastIndexOf("/");
  const dir = i > 0 ? name.slice(0, i) : "";
  return dir.length >= 32 && uploadIds.some((id) => `.carton-uploads/${id}`.endsWith(dir));
};

export async function analyze(run: any): Promise<any | null> {
  const kind = kindOf(run);
  if (!kind) return null;
  const start = Date.parse(run.window.start), end = Date.parse(run.window.end);
  const out: any = { runId: run.runId, kind, host: run.host, profile: run.profile ?? null, parties: run.parties ?? null };

  if (kind === "presence" || kind === "idle" || kind === "alarm" || kind === "edits") {
    const room = await roomOf(run);
    if (!room) return { ...out, error: "no room id" };
    const u = (await doUse([room], start, end))[room]!;
    const f = frames(run);
    const N = run.parties;
    out.room = { id: room, requests: u.requests, types: u.types, statuses: u.statuses, activeSec: u.activeSec, gbs: u.gbs, cpuMs: u.cpuMs, rowsRead: u.rowsRead, rowsWritten: u.rowsWritten, wsOut: u.wsOut };
    out.frames = f;
    if (kind === "presence") {
      const msgs = f.presence ?? 0;
      // every hibernation event but the presence frames: the other frames, the adoption's message, and one close per
      // socket (the parties' and the adopting owner's)
      const other = sum(Object.entries(f).filter(([k]) => k !== "presence").map(([, v]) => v as number)) + 1 + (N + 1);
      out.per = {
        msgs,
        msgsPerSec: msgs / (run.presenceSec || 60),
        doReqPerMsg: ((u.types.hibernation ?? 0) - other) / msgs,
        doReqPerMsgGross: u.requests / msgs,
        gbsPerMsg: u.gbs / msgs,
        rowsWrittenRun: u.rowsWritten,
        rowsReadRun: u.rowsRead,
        alarms: u.types.alarm ?? 0,
        fanoutPerMsg: sum(run.presenceRecv ?? []) / msgs,
        watchers: N - 1,
      };
    } else if (kind === "idle") {
      // whole minutes from 30 s after every party was up until the idle time ended
      const m = minutesBetween(u, run.phases.up + 30_000, run.phases.idleEnd);
      const partyHours = (N * m.minutes) / 60;
      out.idle = m;
      out.per = { partyHours, doReqPerPartyHour: m.requests / partyHours, gbsPerPartyHour: m.gbs / partyHours, rowsWrittenPerPartyHour: m.rowsWritten / partyHours, rowsReadPerPartyHour: m.rowsRead / partyHours, roomHours: m.minutes / 60 };
    } else if (kind === "alarm") {
      // the presence check runs every 60 s from the first presence: whole minutes from 90 s after it
      const m = minutesBetween(u, run.phases.go + 90_000, run.phases.idleEnd);
      const alarms = m.types.alarm ?? 0;
      out.idle = m;
      out.per = { alarms, hours: m.minutes / 60, alarmsPerHour: alarms / (m.minutes / 60), doReqPerHour: m.requests / (m.minutes / 60), rowsWrittenPerAlarm: m.rowsWritten / Math.max(1, alarms), rowsReadPerAlarm: m.rowsRead / Math.max(1, alarms), gbsPerAlarm: m.gbs / Math.max(1, alarms), rowsWrittenPerHour: m.rowsWritten / (m.minutes / 60), gbsPerHour: m.gbs / (m.minutes / 60) };
    } else {
      const edits = run.commits;
      // net of the connects and the adoption: hibernation events less hellos, closes and the adoption's message
      // every connect (the client's `reconnects` counts the first too) sends one hello and ends in one close; yesterday's
      // runs didn't count frames
      const reconnects = sum((run.clientStats ?? []).map((s: any) => s?.reconnects ?? 1));
      const hellos = f.hello ?? reconnects;
      const closes = reconnects + 1; // and the adopting owner's
      out.per = {
        edits,
        doReqPerEditGross: u.requests / edits,
        doReqPerEditNet: ((u.types.hibernation ?? 0) - hellos - closes - 1) / edits,
        rowsWrittenPerEditGross: u.rowsWritten / edits,
        rowsReadPerEditGross: u.rowsRead / edits,
        gbsPerEdit: u.gbs / edits,
        cpuMsPerEdit: u.cpuMs / edits,
        reconnects, hellos,
      };
    }
  } else if (kind === "connect") {
    const room = run.ids.room;
    const u = (await doUse([room], start, end + 2 * MIN))[room]!;
    const from = floorMin(run.phases.connects), to = floorMin(run.phases.connectsEnd) + 2 * MIN;
    const m = minutesBetween(u, from, to);
    const adopt = minutesBetween(u, floorMin(start), from);
    const w = workerUse(run.host, run.projectId, run.phases.connects, run.phases.connectsEnd + 5000);
    const n = run.n;
    out.connect = m;
    out.adopt = adopt;
    out.worker = w;
    out.per = { n, doReqPerConn: m.requests / n, typesPerConn: Object.fromEntries(Object.entries(m.types).map(([k, v]) => [k, v / n])), rowsWrittenPerConn: m.rowsWritten / n, rowsReadPerConn: m.rowsRead / n, gbsPerConn: m.gbs / n, workerReqPerConn: w.gap ? null : w.requests / n, workerCpuMsPerConn: w.gap ? null : w.cpuMs / n, adoptRowsWritten: adopt.rowsWritten, adoptDoReq: adopt.requests };
  } else if (kind === "upload") {
    const p = run.projectId;
    const ids = run.ids?.room ? run.ids : await idsOf(run.host, p);
    const [s, e] = run.phases?.upload ?? [start, end];
    const uploads: string[] = run.uploadIds ?? [];
    const mine = ownedBy(p, uploads);
    const r2 = run.host === "r2" ? await r2Use(s, e, mine) : null;
    let w: any = workerUse(run.host, p, s, e + 2000);
    // the tail missed part of it: the script's analytics instead, when the run had that Worker to itself (vault rep 1)
    if (w.gap && process.env.SCRIPT_FALLBACK?.split(",").includes(run.runId)) w = { ...(await workerScriptUse(run.host, s, e + 2000)), gap: false, source: "graphql-script" };
    const objs = [ids.vault, ids.writeCap, ids.room].filter(Boolean);
    const d = await doUse(objs, s, e);
    const gb = run.size / 1e9;
    out.phase = [s, e];
    out.r2 = r2;
    out.worker = w;
    out.do = Object.fromEntries(Object.entries(d).map(([k, v]) => [k === ids.vault ? "vault" : k === ids.writeCap ? "writeCap" : "room", { requests: v.requests, types: v.types, rowsWritten: v.rowsWritten, rowsRead: v.rowsRead, gbs: v.gbs, cpuMs: v.cpuMs }]));
    out.per = {
      gb,
      sessions: run.upload?.sessions?.length,
      r2ClassAPerGB: r2 ? r2.classA / gb : null,
      r2ClassBPerGB: r2 ? r2.classB / gb : null,
      r2ByActionPerGB: r2 ? Object.fromEntries(Object.entries(r2.byAction).map(([k, v]) => [k, (v as number) / gb])) : null,
      workerReqPerGB: w.gap ? null : w.requests / gb,
      workerCpuMsPerGB: w.gap ? null : w.cpuMs / gb,
      doReqPerGB: sum(Object.values(d).map((v) => v.requests)) / gb,
      writeCapDoReqPerGB: (d[ids.writeCap]?.requests ?? 0) / gb,
      vaultDoReqPerGB: ids.vault && run.host === "nor2" ? (d[ids.vault]?.requests ?? 0) / gb : null,
      vaultRowsWrittenPerGB: ids.vault && run.host === "nor2" ? (d[ids.vault]?.rowsWritten ?? 0) / gb : null,
      vaultGbsPerGB: ids.vault && run.host === "nor2" ? (d[ids.vault]?.gbs ?? 0) / gb : null,
    };
  } else if (kind === "proxy" || kind === "playback") {
    const p = run.projectId;
    const [s, e] = run.phases?.[kind === "proxy" ? "share" : "play"] ?? [start, end];
    const uploads: string[] = run.uploadIds ?? [];
    const mine = ownedBy(p, uploads);
    const r2 = run.host === "r2" ? await r2Use(s, e, mine) : null;
    const w = workerUse(run.host, p, s, e + 2000);
    const ids = run.ids;
    const d = await doUse([ids.vault, ids.writeCap, ids.room].filter(Boolean), s, e);
    out.r2 = r2;
    out.worker = w;
    out.do = d && Object.fromEntries(Object.entries(d).map(([k, v]) => [k === ids.vault ? "vault" : k === ids.writeCap ? "writeCap" : "room", { requests: v.requests, rowsWritten: v.rowsWritten, rowsRead: v.rowsRead }]));
    // the client counts every request it makes (each is one Worker request): exact when the tail missed some
    const clientReq = run.requests ? sum(Object.values(run.requests as Record<string, number>)) : null;
    out.clientRequests = clientReq;
    if (kind === "proxy") {
      const segs = run.segments;
      out.per = { segments: segs, workerReqPerSeg: w.gap ? (clientReq !== null ? clientReq / segs : null) : w.requests / segs, workerReqSource: w.gap ? "client" : "tail", workerCpuMsPerSeg: w.gap ? null : w.cpuMs / segs, r2ClassAPerSeg: r2 ? r2.classA / segs : null, r2ClassBPerSeg: r2 ? r2.classB / segs : null, doReqPerSeg: sum(Object.values(d).map((v) => v.requests)) / segs, bytesPerSeg: run.bytes / segs };
    } else {
      const mib = run.bytes / (1 << 20);
      out.per = { mib, workerReqPerMiB: w.gap ? (clientReq !== null ? clientReq / mib : null) : w.requests / mib, workerReqSource: w.gap ? "client" : "tail", workerCpuMsPerMiB: w.gap ? null : w.cpuMs / mib, r2ClassBPerMiB: r2 ? r2.classB / mib : null, r2ClassAPerMiB: r2 ? r2.classA / mib : null, mibPerGet: r2 ? mib / Math.max(1, r2.byAction.GetObject ?? 0) : null };
    }
  }
  return out;
}

if (import.meta.main) {
  const filter = process.argv[2] ?? "";
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json") && !/\.(cost|c2)\.json$/.test(f) && f.includes(filter)).sort();
  for (const f of files) {
    const run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8"));
    if (!run.window?.end || !kindOf(run)) continue;
    const dest = join(RUNS_DIR, f.replace(/\.json$/, ".c2.json"));
    if (existsSync(dest) && !process.env.FORCE) continue;
    if (Date.now() - Date.parse(run.window.end) < LAG_MS) { console.log(`${run.runId}: waiting for the analytics`); continue; }
    try {
      const r = await analyze(run);
      if (!r) continue;
      writeFileSync(dest, JSON.stringify(r, null, 1));
      console.log(run.runId, JSON.stringify(r.per ?? r.error));
    } catch (e) {
      console.log(`${run.runId}: ${(e as Error).message}`);
    }
  }
}
