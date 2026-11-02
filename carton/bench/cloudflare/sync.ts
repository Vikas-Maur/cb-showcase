// Live sync on the deployed Worker: N parties (people and agents) edit one cut at once, each a real client in its own
// process and network namespace (netns.sh), shaped to a profile. Measures convergence (an edit's commit to every other
// party holding it confirmed), confirm latency, lost edits, duplicates, order, conflict cards, rejects and reconnects.
// Runs the guard first.
//
//   node bench/cloudflare/sync.ts --host r2 --parties 5 --edits 24 --seconds 30 --profile good [--chaos flap|outage]
//        [--outage-sec 300] [--rep 1] [--transport '{"deadAfterMs":…}'] [--tag x]
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adopt, tokenFor, now, stats, type HostName } from "./common.ts";
import { guard, endTest } from "./guard.ts";
import { idsOf } from "./objcost.ts";
import { RUNS_DIR } from "./paths.ts";

const { values: a } = parseArgs({
  options: {
    host: { type: "string", default: "r2" },
    parties: { type: "string", default: "2" },
    edits: { type: "string", default: "30" },
    seconds: { type: "string", default: "30" },
    profile: { type: "string", default: "good" },
    chaos: { type: "string", default: "" },
    "outage-sec": { type: "string", default: "300" },
    "outage-parties": { type: "string", default: "1" },
    rep: { type: "string", default: "1" },
    transport: { type: "string", default: "" },
    backoff: { type: "string", default: "" },
    tag: { type: "string", default: "" },
    "settle-sec": { type: "string", default: "600" },
    // the first namespace this run uses (cfl<base>…), so two runs can go at once
    "ns-base": { type: "string", default: "0" },
    // presence updates a second per party while editing; seconds every party then sits connected and idle
    "presence-hz": { type: "string", default: "0" },
    "idle-sec": { type: "string", default: "0" },
    // SyncClient options under test (e.g. maxBackoffMs), passed to every party
    client: { type: "string", default: "" },
    // presence as the web app sends it (party.ts): "drag" (a dragged clip's ghost, fed at pointer-hz for presence-sec)
    // or "once" (one "Idle", then silence), by the first presence-parties parties
    "presence-mode": { type: "string", default: "" },
    "presence-sec": { type: "string", default: "0" },
    "presence-parties": { type: "string", default: "1" },
    "pointer-hz": { type: "string", default: "60" },
  },
});
const host = a.host as HostName;
const N = Number(a.parties), E = Number(a.edits), S = Number(a.seconds);
const profile = a.profile!;
const chaos = a.chaos!;
const outageSec = Number(a["outage-sec"]);
const HERE = import.meta.dirname;
mkdirSync(RUNS_DIR, { recursive: true });
const NB = Number(a["ns-base"]);
const netns = (...args: string[]) => execFileSync("bash", [join(HERE, "netns.sh"), ...args], { stdio: ["ignore", "ignore", "inherit"] });

const runId = `sync-${host}-${profile}${chaos ? `-${chaos}` : ""}-${N}p-r${a.rep}${a.tag ? `-${a.tag}` : ""}-${Date.now().toString(36)}`;
const projectId = runId.replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 100);
const branch = "main";
const total = N * E;

// worst case: each edit one push (and up to 3 again on rejects), a few connects per party per minute of chaos
const presenceSec = Number(a["presence-sec"]);
const minutes = (S + presenceSec + (chaos === "outage" ? outageSec : 0) + Number(a["idle-sec"]) + 120) / 60;
const reconnects = N * (chaos ? Math.ceil(minutes * 12) : 2);
const presenceMsgs = N * Number(a["presence-hz"]) * S + (a["presence-mode"] === "drag" ? Number(a["presence-parties"]) * presenceSec * 20 : 0);
const g = await guard({ test: runId, workersReq: reconnects + 10, doReq: total * 4 + reconnects + 20 + presenceMsgs, doRowsWritten: total * 6 + 50, doRowsRead: total * 200 + 5000, doGBs: minutes * 60 * 0.128 }); // one room: a DO is billed per object, never per socket; this is no hibernation at all
const t0 = Date.now();
netns("up", String(NB + N));
for (let i = 0; i < N; i++) netns("profile", String(NB + i), profile);

console.log(`${runId}: adopting the cut`);
await adopt(host, projectId, branch);

interface Party { i: number; who: string; proc: ChildProcess; lines: Record<string, any>[]; send(cmd: string): void; waitFor(p: (l: any) => boolean, ms: number, what: string): Promise<any> }
const parties: Party[] = [];
for (let i = 0; i < N; i++) {
  // people and agents: every third party is an agent (a Director subagent), as in a real session
  const kind = i % 3 === 2 ? "agent" : "human";
  const who = `${kind === "agent" ? "agent" : "person"}${i}`;
  const cfg = { host, projectId, branch, token: await tokenFor(projectId, who), who, kind, edits: E, intervalMs: (S * 1000) / E, seed: 1000 * Number(a.rep) + i + 1, ...(a.transport ? { transport: JSON.parse(a.transport) } : {}), ...(a.backoff ? { backoffMs: Number(a.backoff) } : {}), ...(a.client ? { client: JSON.parse(a.client) } : {}), presenceHz: Number(a["presence-hz"]), ...(a["presence-mode"] && i < Number(a["presence-parties"]) ? { presenceMode: a["presence-mode"], presenceSec, pointerHz: Number(a["pointer-hz"]) } : presenceSec ? { presenceSec } : {}) };
  const proc = spawn("bash", [join(HERE, "netns.sh"), "exec", String(NB + i), process.execPath, join(HERE, "party.ts"), JSON.stringify(cfg)], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: Record<string, any>[] = [];
  const waiters: { p: (l: any) => boolean; ok: (l: any) => void }[] = [];
  createInterface({ input: proc.stdout! }).on("line", (s) => {
    let l: any;
    try { l = JSON.parse(s); } catch { return; }
    lines.push(l);
    for (const w of waiters.splice(0)) (w.p(l) ? w.ok(l) : waiters.push(w));
  });
  createInterface({ input: proc.stderr! }).on("line", (s) => { if (!/ExperimentalWarning|--trace-warnings/.test(s)) console.error(`[${who}] ${s}`); });
  parties.push({
    i, who, proc, lines,
    send: (cmd) => proc.stdin!.write(cmd + "\n"),
    waitFor: (p, ms, what) => new Promise((ok, no) => {
      const hit = lines.find(p);
      if (hit) return ok(hit);
      const timer = setTimeout(() => no(new Error(`${who}: timed out waiting for ${what}`)), ms);
      waiters.push({ p, ok: (l) => (clearTimeout(timer), ok(l)) });
    }),
  });
}
await Promise.all(parties.map((p) => p.waitFor((l) => l.ev === "status" && l.status === "up-to-date", 90_000, "up-to-date")));
const tUp = now();
console.log(`${runId}: ${N} parties up to date; editing for ${S}s`);

// link chaos
const chaosLog: { t: number; i: number; hole: "on" | "off" }[] = [];
const timers: NodeJS.Timeout[] = [];
const hole = (i: number, on: boolean) => { netns("hole", String(NB + i), on ? "on" : "off"); chaosLog.push({ t: now(), i, hole: on ? "on" : "off" }); };
if (chaos === "flap") {
  // every party's link drops for 5 s every 30 s, each at its own phase
  for (const p of parties) {
    const phase = Math.floor(Math.random() * 30_000);
    const cycle = () => { hole(p.i, true); timers.push(setTimeout(() => hole(p.i, false), 5000)); };
    timers.push(setTimeout(() => { cycle(); timers.push(setInterval(cycle, 30_000)); }, phase));
  }
} else if (chaos === "outage") {
  // the first `outage-parties` parties lose their link 10 s in, for outage-sec, and keep editing meanwhile
  const k = Math.min(N, Number(a["outage-parties"]));
  timers.push(setTimeout(() => { for (let i = 0; i < k; i++) hole(i, true); }, 10_000));
  timers.push(setTimeout(() => { for (let i = 0; i < k; i++) hole(i, false); }, 10_000 + outageSec * 1000));
}
const tGo = now();
for (const p of parties) p.send("go");
await Promise.all(parties.map((p) => p.waitFor((l) => l.ev === "edits-done", (S + presenceSec + outageSec + 120) * 1000, "edits-done")));
// stop the chaos once the edits are made (an outage still running is waited out by the settle below)
if (chaos === "flap") { for (const t of timers) clearTimeout(t), clearInterval(t); for (const p of parties) netns("hole", String(NB + p.i), "off"); }
const tEdits = now();
const idleSec = Number(a["idle-sec"]);
if (idleSec > 0) { console.log(`${runId}: idle for ${idleSec}s`); await new Promise((r) => setTimeout(r, idleSec * 1000)); }
const tIdleEnd = now();

// settled: nothing pending anywhere and one head everywhere, twice in a row
let last = "";
const settleBy = Date.now() + Number(a["settle-sec"]) * 1000;
for (;;) {
  const st = await Promise.all(parties.map((p) => { const n0 = p.lines.length; p.send("state"); return p.waitFor((l) => l.ev === "state" && p.lines.indexOf(l) >= n0, 20_000, "state"); }));
  const key = JSON.stringify(st.map((s) => [s.head, s.pending]));
  if (st.every((s) => s.pending === 0 && s.head === st[0].head) && key === last) break;
  last = key;
  if (Date.now() > settleBy) { console.error(`${runId}: NOT SETTLED ${key}`); break; }
  await new Promise((r) => setTimeout(r, 1000));
}
const tSettled = now();
for (const t of timers) clearTimeout(t), clearInterval(t);
const finals = await Promise.all(parties.map((p) => { p.send("final"); return p.waitFor((l) => l.ev === "final", 20_000, "final"); }));
for (const p of parties) p.send("quit");
await new Promise((r) => setTimeout(r, 500));
for (const p of parties) p.proc.kill();
for (let i = 0; i < N; i++) netns("hole", String(NB + i), "off");

// ---------------------------------------------------------------- analysis
const commits = new Map<string, { party: number; t: number; online: boolean }>();
const outcome = new Map<string, { kind: string; t: number; seq?: number; cards?: number; rebase?: number }>();
let cards = 0, overwritten = 0, rejects = 0, rebases = 0, errors = 0, offlines = 0, keyframes = 0;
const errorSamples = new Set<string>();
for (const p of parties) for (const l of p.lines) {
  if (l.ev === "commit") commits.set(l.id, { party: p.i, t: l.t, online: l.online });
  else if (l.ev === "confirmed") { outcome.set(l.id, { kind: "confirmed", t: l.t, seq: l.seq, cards: l.cards, rebase: l.rebase }); cards += l.cards; }
  else if (l.ev === "absorbed") { outcome.set(l.id, { kind: "absorbed", t: l.t, cards: l.cards }); cards += l.cards; }
  else if (l.ev === "rejected") outcome.set(l.id, { kind: "rejected", t: l.t });
  else if (l.ev === "overwritten") overwritten++;
  else if (l.ev === "reject") rejects++;
  else if (l.ev === "rebase") rebases++;
  else if (l.ev === "error") (errors++, errorSamples.add(String(l.error).slice(0, 160)));
  else if (l.ev === "offline") offlines++;
  else if (l.ev === "keyframe") keyframes++;
}
// when each party first held each confirmed id: its remote row, or a keyframe at or past its seq
const seqOf = new Map<string, number>();
for (const [id, o] of outcome) if (o.seq !== undefined) seqOf.set(id, o.seq);
const conv: number[] = [], pair: number[] = [], confirm: number[] = [], convOnline: number[] = [];
let unseen = 0;
for (const [id, c] of commits) {
  const o = outcome.get(id);
  if (!o || o.kind !== "confirmed") continue;
  confirm.push(o.t - c.t);
  let worst = o.t - c.t;
  for (const p of parties) {
    if (p.i === c.party) continue;
    let t = p.lines.find((l) => l.ev === "remote" && l.id === id)?.t;
    if (t === undefined) t = p.lines.find((l) => l.ev === "keyframe" && l.seq >= o.seq!)?.t;
    if (t === undefined) { unseen++; continue; }
    pair.push(t - c.t);
    worst = Math.max(worst, t - c.t);
  }
  conv.push(worst);
  if (c.online) convOnline.push(worst);
}
// the server's log, as each party holds it. A party that caught up from a keyframe holds placeholders (null) for the
// rows before it, so the reference is every party's logs merged slot by slot: the first id any party holds there.
// (Taking one party's log as the reference counted a reconnected party's placeholders as lost edits: 2026-11-02.)
const logs = finals.map((f) => f.ids as (string | null)[]);
const ref: (string | null)[] = Array.from({ length: Math.max(...logs.map((l) => l.length)) }, (_, j) => logs.map((l) => l[j] ?? null).find((x) => x !== null) ?? null);
const refIds = ref.filter((x): x is string => x !== null);
const dupes = refIds.length - new Set(refIds).size;
const orderMismatch = logs.reduce((s, l) => s + l.reduce((k, id, j) => k + (id !== null && ref[j] !== null && id !== ref[j] ? 1 : 0), 0) + (l.length !== ref.length ? 1 : 0), 0);
const inLog = new Set(refIds);
const lost = [...commits.keys()].filter((id) => { const o = outcome.get(id); return !(o?.kind === "absorbed" || o?.kind === "rejected" || inLog.has(id)); });
// confirmed (the server gave it a seq) yet in no party's log, not even as a placeholder slot: should be none
const placeholders = logs.map((l) => l.filter((x) => x === null).length);
const absorbed = [...outcome.values()].filter((o) => o.kind === "absorbed").length;
const sameState = new Set(finals.map((f) => f.stateHash)).size === 1;
const ms = (x: ReturnType<typeof stats>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "n" ? v : Math.round(v as number)]));
const result = {
  runId, projectId, host, profile, chaos: chaos || null, parties: N, editsPerParty: E, seconds: S, rep: Number(a.rep),
  window: { start: new Date(t0).toISOString(), end: new Date().toISOString() },
  timing: { editingMs: Math.round(tEdits - tGo), settleMs: Math.round(tSettled - tEdits), idleSec },
  // the phases as epoch ms, so the analytics can be read per phase (objcost.ts minutesBetween)
  phases: { start: t0, up: Math.round(tUp), go: Math.round(tGo), editsDone: Math.round(tEdits), idleEnd: Math.round(tIdleEnd), settled: Math.round(tSettled) },
  ids: await idsOf(host, projectId).catch((e) => ({ error: String(e) })),
  presenceMode: a["presence-mode"] || null, presenceSec, presenceParties: a["presence-mode"] ? Number(a["presence-parties"]) : 0,
  sentByType: finals.map((f) => f.sentByType), presenceRecv: finals.map((f) => f.presenceRecv),
  presenceHz: Number(a["presence-hz"]), presenceSent: parties.reduce((s, p) => s + (p.lines.find((l) => l.ev === "edits-done")?.presenceSent ?? 0), 0),
  commits: commits.size,
  confirmed: [...outcome.values()].filter((o) => o.kind === "confirmed").length,
  absorbed, rejectedByValidation: [...outcome.values()].filter((o) => o.kind === "rejected").length,
  lost: lost.length, lostIds: lost.slice(0, 10), duplicates: dupes, orderMismatches: orderMismatch, sameState, unseenPairs: unseen,
  serverRows: ref.length, placeholdersPerParty: placeholders, logs,
  convergenceMs: ms(stats(conv)), convergenceOnlineCommitsMs: ms(stats(convOnline)), perObserverMs: ms(stats(pair)), confirmMs: ms(stats(confirm)),
  conflictCards: cards, overwritten, rejects, rebases, errors, errorSamples: [...errorSamples].slice(0, 5), offlineEvents: offlines, keyframes,
  clientStats: finals.map((f) => f.stats),
  loopLagMs: { p99max: Math.max(...finals.map((f) => f.loopLagMs?.p99 ?? 0)), max: Math.max(...finals.map((f) => f.loopLagMs?.max ?? 0)) },
  load: (await import("node:os")).loadavg(),
  chaosLog: chaosLog.map((c) => ({ ...c, t: Math.round(c.t - tGo) })),
  // per party: its connection's story (ms after the edits began), and how long its commits took to confirm, by when
  // they were made, so an outage's cost reads off directly
  timeline: parties.map((p) => p.lines.filter((l) => ["status", "offline", "online", "error", "keyframe"].includes(l.ev)).map((l) => [Math.round(l.t - tGo), l.ev, String(l.status ?? l.why ?? l.code ?? l.seq ?? "").slice(0, 80)])),
  commitsByParty: parties.map((p) => [...commits].filter(([, c]) => c.party === p.i).map(([id, c]) => { const o = outcome.get(id); return [Math.round(c.t - tGo), o ? Math.round(o.t - c.t) : null, o?.kind ?? "none"]; })),
};
writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(result, null, 1));
const pushes = finals.reduce((s, f) => s + f.stats.pushMsgs, 0), reconn = finals.reduce((s, f) => s + f.stats.reconnects, 0);
endTest(g.id, { pushes, reconnects: reconn, commits: commits.size });
console.log(JSON.stringify({ runId, commits: result.commits, lost: result.lost, dupes, orderMismatch, sameState, conv: result.convergenceMs, pair: result.perObserverMs, confirm: result.confirmMs, cards, rejects, rebases, reconnects: reconn, pushes, errors, settleMs: result.timing.settleMs, lagP99: result.loopLagMs.p99max, load: result.load[0] }));
process.exit(result.lost || dupes || orderMismatch || !sameState ? 3 : 0);
