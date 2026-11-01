// The production cost table: measured per-operation use (the lab's runs, read back from Cloudflare's analytics) ×
// a stated usage profile × Cloudflare's published prices (fetched 2026-11-01, URLs below). Every input is printed with
// the table, so a reader can change one and recompute.
//
//   node bench/cloudflare/costmodel.ts [measured.json]     markdown on stdout
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------- prices (2026-11-01)
// https://developers.cloudflare.com/workers/platform/pricing/
// https://developers.cloudflare.com/durable-objects/platform/pricing/
// https://developers.cloudflare.com/r2/pricing/
export const PRICE = {
  workersPaidBase: 5, // $/month, account
  workersReq: { included: 10e6, per: 0.3 / 1e6 },
  workersCpuMs: { included: 30e6, per: 0.02 / 1e6 },
  doReq: { included: 1e6, per: 0.15 / 1e6 }, // inbound WebSocket messages billed 20:1
  doGBs: { included: 400e3, per: 12.5 / 1e6 },
  doRowsRead: { included: 25e9, per: 0.001 / 1e6 },
  doRowsWritten: { included: 50e6, per: 1.0 / 1e6 },
  doStorageGBMonth: { included: 5, per: 0.2 },
  r2StorageGBMonth: { included: 10, per: 0.015 },
  r2ClassA: { included: 1e6, per: 4.5 / 1e6 },
  r2ClassB: { included: 10e6, per: 0.36 / 1e6 },
};
// Free plans: per day (Workers, DO) or month (R2); a free account errors past these, it never bills (except R2).
export const FREE = { workersReqDay: 100e3, doReqDay: 100e3, doGBsDay: 13e3, doRowsReadDay: 5e6, doRowsWrittenDay: 100e3, doStorageGB: 5, r2StorageGBMonth: 10, r2ClassAMonth: 1e6, r2ClassBMonth: 10e6 };

// ---------------------------------------------------------------- measured per operation (lab defaults; overridden by measured.json)
export const MEASURED = {
  // live sync, per edit (median of the good-profile runs: cost.ts)
  editDoReq: 1.5, // the push, plus withdraws/re-pushes and the room's alarm share
  editRowsWritten: 2.2,
  editRowsRead: 0.9,
  editGBs: 0.0025, // the room's active time per edit × 128 MB
  editWorkerCpuMs: 0, // pushes go straight to the room over the socket: no Worker invocation
  // a connection: one Worker request (the upgrade) and one DO request
  connWorkerReq: 1,
  connDoReq: 1,
  // presence, per message (a cursor or playhead being dragged, at most 10 a second)
  presenceDoReq: 1,
  presenceGBs: 0.0002,
  // the presence-check alarm: every 60 s while someone shows presence, one DO request and one row written each
  presenceAlarmPerHour: 60,
  // media, per GB uploaded through the media API (8 MiB parts)
  gbWorkerReq: 140,
  gbWorkerCpuMs: 14_000,
  gbR2ClassA: 520, // UploadPart + the adapter's per-part records (lock, marker, release) + create/complete
  gbR2ClassB: 130,
  gbDoReq: 130, // the daily write cap's counter, one per part (only when the cap is on)
  // the vault (no R2): rows written per GB stored (1 per MiB, copied once on complete, and its parts dropped)
  gbVaultRowsWritten: 3072,
  gbVaultDoReq: 260,
  // a proxy segment (2 s of the 720p proxy, ≈ 0.5 MB): a signed PUT, so 2 Worker requests and 1 Class A
  segWorkerReq: 2,
  segR2ClassA: 1,
  // a teammate playing media: one ranged GET (Class B) per ~2 MiB read
  viewMiBPerGet: 2,
};

// ---------------------------------------------------------------- the usage profile (assumptions, stated)
export const PROFILE = {
  days: 20, // editing days a month
  hoursPerDay: 3, // live, connected editing per person
  editsPerMinute: 2, // saves a person makes while editing (Cardboard saves in batches)
  agentEditsPerDay: 150, // Director turns and subagents, per person
  presenceDutyCycle: 0.05, // share of editing time someone drags (presence at 10 Hz)
  connectsPerDay: 6, // opening the project, sleep/wake, network changes
  footageHoursPerMonth: 10, // per person, shared as the 720p proxy stream (2 Mbit/s ≈ 0.9 GB/h)
  proxyGBPerHour: 0.9,
  originalsShared: false, // T3 originals only on opt-in
  originalGBPerHour: 30, // a camera original, if shared
  retentionMonths: 3, // media kept this long: storage = monthly upload × retention
  viewsPerProxyGB: 2, // each teammate plays about this much of each proxy (×, per teammate)
};

type Plan = { workersReq: number; workersCpuMs: number; doReq: number; doGBs: number; doRowsRead: number; doRowsWritten: number; doStorageGB: number; r2StorageGB: number; r2ClassA: number; r2ClassB: number };

/** Monthly use of a team of `people`, with or without R2. */
export function usage(people: number, withR2: boolean, m = MEASURED, p = PROFILE): Plan {
  const editMinutes = p.days * p.hoursPerDay * 60 * people;
  const edits = editMinutes * p.editsPerMinute + p.days * p.agentEditsPerDay * people;
  const presenceMsgs = editMinutes * 60 * 10 * p.presenceDutyCycle;
  const alarms = (editMinutes / 60) * m.presenceAlarmPerHour; // per person-hour shown (rooms ≈ people sharing one: an upper bound)
  const connects = p.days * p.connectsPerDay * people;
  const gbUp = p.footageHoursPerMonth * people * (p.proxyGBPerHour + (p.originalsShared ? p.originalGBPerHour : 0));
  const segments = (p.footageHoursPerMonth * people * 3600) / 2;
  const stored = gbUp * p.retentionMonths;
  const viewedMiB = p.footageHoursPerMonth * people * p.proxyGBPerHour * 1024 * p.viewsPerProxyGB * Math.max(0, people - 1);
  const media = withR2
    ? { r2StorageGB: stored, r2ClassA: gbUp * m.gbR2ClassA + segments * m.segR2ClassA, r2ClassB: gbUp * m.gbR2ClassB + viewedMiB / m.viewMiBPerGet, doStorageGB: 0, doRowsWrittenMedia: 0, doReqMedia: 0 }
    : { r2StorageGB: 0, r2ClassA: 0, r2ClassB: 0, doStorageGB: stored, doRowsWrittenMedia: gbUp * m.gbVaultRowsWritten + segments * 2, doReqMedia: gbUp * m.gbVaultDoReq + segments + viewedMiB / 16 };
  return {
    workersReq: connects * m.connWorkerReq + gbUp * m.gbWorkerReq + segments * m.segWorkerReq + viewedMiB / m.viewMiBPerGet,
    workersCpuMs: gbUp * m.gbWorkerCpuMs + segments * 2 + viewedMiB,
    // inbound WebSocket messages are billed at 20:1 on Workers Paid; the Free plan's daily cap is checked 1:1 below
    doReq: connects * m.connDoReq + edits * m.editDoReq + presenceMsgs * m.presenceDoReq + alarms + media.doReqMedia,
    doGBs: edits * m.editGBs + presenceMsgs * m.presenceGBs,
    doRowsRead: edits * m.editRowsRead * 10,
    doRowsWritten: edits * m.editRowsWritten + alarms + media.doRowsWrittenMedia,
    doStorageGB: media.doStorageGB + (edits * 600) / 1e9, // change rows ≈ 600 B until archived
    r2StorageGB: media.r2StorageGB,
    r2ClassA: media.r2ClassA,
    r2ClassB: media.r2ClassB,
  };
}

/** Workers Paid bill for `teams` teams of this use (WebSocket inbound messages at 20:1). */
export function bill(u: Plan, teams: number, wsShare: number) {
  const over = (x: number, p: { included: number; per: number }) => Math.max(0, x * teams - p.included) * p.per;
  // DO requests: the WebSocket share bills at 1/20
  const doBilled = u.doReq * (1 - wsShare) + (u.doReq * wsShare) / 20;
  const lines = {
    base: PRICE.workersPaidBase,
    workersReq: over(u.workersReq, PRICE.workersReq),
    workersCpu: over(u.workersCpuMs, PRICE.workersCpuMs),
    doReq: over(doBilled, PRICE.doReq),
    doGBs: over(u.doGBs, PRICE.doGBs),
    doRowsRead: over(u.doRowsRead, PRICE.doRowsRead),
    doRowsWritten: over(u.doRowsWritten, PRICE.doRowsWritten),
    doStorage: over(u.doStorageGB, PRICE.doStorageGBMonth),
    r2Storage: over(u.r2StorageGB, PRICE.r2StorageGBMonth),
    r2ClassA: over(u.r2ClassA, PRICE.r2ClassA),
    r2ClassB: over(u.r2ClassB, PRICE.r2ClassB),
  };
  const total = Object.values(lines).reduce((s, x) => s + x, 0);
  const driver = Object.entries(lines).filter(([k]) => k !== "base").sort((a, b) => b[1] - a[1])[0]!;
  return { lines, total, driver };
}

/** Does it fit the free plans (per day: busiest day = monthly / days)? */
export function freeFits(u: Plan, teams: number, days: number) {
  const day = (x: number) => (x * teams) / days;
  const why: string[] = [];
  if (day(u.workersReq) > FREE.workersReqDay) why.push(`Workers ${Math.round(day(u.workersReq))} req/day`);
  if (day(u.doReq) > FREE.doReqDay) why.push(`DO ${Math.round(day(u.doReq))} req/day`);
  if (day(u.doGBs) > FREE.doGBsDay) why.push(`DO ${Math.round(day(u.doGBs))} GB-s/day`);
  if (day(u.doRowsWritten) > FREE.doRowsWrittenDay) why.push(`DO ${Math.round(day(u.doRowsWritten))} rows written/day`);
  if (u.doStorageGB * teams > FREE.doStorageGB) why.push(`DO storage ${(u.doStorageGB * teams).toFixed(1)} GB`);
  if (u.r2StorageGB * teams > FREE.r2StorageGBMonth) why.push(`R2 storage ${(u.r2StorageGB * teams).toFixed(1)} GB-month (billed past 10)`);
  if (u.r2ClassA * teams > FREE.r2ClassAMonth) why.push(`R2 Class A ${Math.round(u.r2ClassA * teams)}/month (billed past 1M)`);
  return why;
}

if (import.meta.main) {
  const f = process.argv[2];
  if (f && existsSync(f)) Object.assign(MEASURED, JSON.parse(readFileSync(f, "utf8")));
  const cases: [string, number, number][] = [["Solo editor", 1, 1], ["Team of 5", 5, 1], ["1,000 teams of 5", 5, 1000], ["10,000 teams of 5", 5, 10_000]];
  console.log("| Case | Storage | Fits Free? (why not) | Workers Paid $/month | per active user | biggest driver |");
  console.log("|---|---|---|---|---|---|");
  for (const [name, people, teams] of cases)
    for (const withR2 of [true, false]) {
      const u = usage(people, withR2);
      const presenceShare = 0.8; // most DO requests are WebSocket messages (edits, presence); upgrades and alarms aren't
      const b = bill(u, teams, presenceShare);
      const why = freeFits(u, teams, PROFILE.days);
      console.log(`| ${name} | ${withR2 ? "R2" : "no R2 (DO vault)"} | ${why.length ? `no: ${why.join("; ")}` : "yes"} | $${b.total.toFixed(2)} | $${(b.total / (people * teams)).toFixed(3)} | ${b.driver[0]} ($${b.driver[1].toFixed(2)}) |`);
    }
  console.log("\nInputs:", JSON.stringify({ MEASURED, PROFILE }, null, 1));
}
