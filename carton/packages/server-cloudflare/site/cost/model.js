// The cost model behind /cost/: what running Carton's sync backend on Cloudflare costs a month. Pure functions, no DOM:
// the page (app.js) and the tests (test/cost-model.test.ts) call the same code.
//
//   usage(settings, inputs)          one team's use for a month, by activity and by Cloudflare meter
//   bill(settings, inputs, prices)   the month's bill for `settings.teams` teams on the chosen plan
//   freeCheck(settings, inputs, prices)  does it fit Workers Free, and if not: the first daily limit and the team count
//   compute(...)                     all of it, plus the biggest cost driver and one way to lower it
//   curve(...)                       cost against number of teams, R2 vs vault, Free vs Paid
//
// Inputs are per-operation costs: measured by the lab where it could (data.json says which), estimated from the code
// and Cloudflare's docs otherwise. Settings are the usage profile, always assumptions. Prices come from prices.json.
//
// What it fixes in the lab's first script (bench/cloudflare/costmodel.ts on lab/cloudflare):
// - the plan is a choice: Workers Free has no fee and daily limits (past one, requests fail; nothing bills); Workers
//   Paid is $5 plus usage past the included amounts; R2 bills separately on either plan, against its own monthly
//   free amounts;
// - "fits Workers Free?" is checked per product per day, and names the first limit and the team count that crosses it;
// - rows read come from a per-edit input, without the old unexplained ×10;
// - Durable Object requests are split: incoming WebSocket messages (edits, presence) bill 20:1 on Paid, connects,
//   alarms and media requests bill in full (no fixed 80% share);
// - connects, idle open sessions and the room's alarms are their own line; so is playback; the preview segment length
//   is a setting (fewer, larger segments mean fewer storage writes and reads).
// And, from the review of this model (Cloudflare's pricing and limits pages, 2026-11-02):
// - Durable Objects and R2 round each meter's billable amount (past the included amount) up to the next unit: a
//   million requests, rows, GB-s or operations, a GB-month. Workers requests and CPU aren't documented as rounded.
// - one Durable Object holds at most 1 GB on Free and 10 GB on Paid: the vault is one object per project, so its
//   media must fit that on either plan;
// - a room's duration is wall-clock time shared by everything it does at once: never more than the month's hours.

/** One MiB, in bytes. */
const MIB = 1024 * 1024;
/** Memory a Durable Object is billed for, GB (Cloudflare bills the 128 MB allocation). */
const DO_MEMORY_GB = 0.128;
/** The segment the lab's per-MiB playback inputs were measured with: 2 s of the 720p proxy at 2 Mbit/s. */
export const REF_SEGMENT = { seconds: 2, mbps: 2 };
/** Rows the room keeps before archiving older changes (server §18 default, ARCHIVE_KEEP). */
export const ARCHIVE_KEEP = 10_000;
/**
 * Free plan: incoming WebSocket messages counted 1:1 against the 100,000 Durable Object requests a day. Cloudflare's
 * pricing page applies its 20:1 ratio "for compute requests billing-only"; whether the Free plan's daily cap counts
 * messages 1:1 or 20:1 isn't documented, so this stays on the safe side until the lab's daily-limit run says.
 */
export const FREE_WS_RATIO = 1;

/** Every per-operation input with its fallback value: used when data.json lacks a key ("not measured"). */
export const INPUT_DEFAULTS = Object.freeze({
  editDoReq: 1.225,
  editRowsWritten: 2.17,
  editRowsRead: 0.97,
  editGBs: 0.00156,
  editWorkerCpuMs: 0,
  editArchiveRowsWritten: 1,
  changeBytes: 600,
  connWorkerReq: 1,
  connWorkerCpuMs: 3,
  connDoReq: 1,
  connRowsWritten: 2,
  connRowsRead: 20,
  connGBs: 0.002,
  presenceMsgPerSecWhileDragging: 10,
  presenceDoReq: 1,
  presenceGBs: 0.0002,
  presenceAlarmPerHour: 60,
  upkeepAlarmPerHour: 1,
  alarmRowsWritten: 1,
  alarmGBs: 0.0003,
  idleDoReqPerHour: 0,
  idleGBsPerHour: 0,
  idleRowsWrittenPerHour: 0,
  gbWorkerReq: 125,
  gbWorkerCpuMs: 750,
  gbR2ClassA: 480,
  gbR2ClassB: 125,
  gbDoReq: 0,
  gbVaultDoReq: 240,
  gbVaultRowsWritten: 2861,
  gbVaultGBs: 30,
  segWorkerReq: 6,
  segWorkerCpuMs: 2,
  segR2ClassA: 3,
  segR2ClassB: 3,
  segVaultDoReq: 6,
  segVaultRowsWritten: 6,
  viewWorkerReqPerMiB: 4.2,
  viewClassBPerMiB: 4.2,
  viewWorkerCpuMsPerMiB: 6,
  viewVaultRowsReadPerMiB: 2.1,
  viewVaultGBsPerMiB: 0.01,
});

/** Preview (collab proxy) quality presets, Mbit/s. Carton encodes the 720p one today. */
export const PREVIEW_QUALITY = Object.freeze({ "540p": 1, "720p": 2, "1080p": 5 });

/** The usage profile's defaults (all assumptions). */
export const DEFAULT_SETTINGS = Object.freeze({
  people: 5,
  teams: 1,
  days: 20,
  hoursPerDay: 3,
  idleHoursPerDay: 5,
  savesPerMinute: 2,
  agentEditsPerDay: 150,
  dragShare: 0.05,
  connectsPerDay: 6,
  footageHoursPerMonth: 10,
  previewMbps: 2,
  shareOriginals: false,
  originalMbps: 100,
  retentionMonths: 3,
  viewShare: 0.5,
  storage: "r2",
  plan: "free",
  segmentSeconds: 2,
});

export const PRESETS = Object.freeze({
  solo: { label: "Solo editor", settings: { people: 1, teams: 1, plan: "free" } },
  team5: { label: "Team of 5", settings: { people: 5, teams: 1, plan: "free" } },
  studio20: { label: "Studio of 20", settings: { people: 20, teams: 1, plan: "paid" } },
  teams1k: { label: "1,000 teams of 5", settings: { people: 5, teams: 1000, plan: "paid" } },
  teams10k: { label: "10,000 teams of 5", settings: { people: 5, teams: 10000, plan: "paid" } },
});

/** Cloudflare's meters, in bill order. `product` groups them; `unit` is what the amount counts. */
export const METERS = Object.freeze([
  { key: "workersReq", product: "workers", name: "Worker requests", unit: "requests" },
  { key: "workersCpuMs", product: "workers", name: "Worker CPU time", unit: "CPU ms" },
  { key: "doReq", product: "do", name: "Durable Object requests", unit: "requests" },
  { key: "doGBs", product: "do", name: "Durable Object duration", unit: "GB-s" },
  { key: "doRowsRead", product: "do", name: "Rows read", unit: "rows" },
  { key: "doRowsWritten", product: "do", name: "Rows written", unit: "rows" },
  { key: "doStorageGB", product: "do", name: "Durable Object storage", unit: "GB-month" },
  { key: "r2StorageGB", product: "r2", name: "R2 storage", unit: "GB-month" },
  { key: "r2ClassA", product: "r2", name: "R2 Class A operations", unit: "operations" },
  { key: "r2ClassB", product: "r2", name: "R2 Class B operations", unit: "operations" },
]);

/** What the money is for, in bill order (the plan fee first). */
export const ACTIVITIES = Object.freeze([
  { key: "fee", name: "Workers Paid plan" },
  { key: "edits", name: "Live edits" },
  { key: "presence", name: "Cursors and playheads" },
  { key: "connections", name: "Connections and idle time" },
  { key: "segments", name: "Preview uploads" },
  { key: "originals", name: "Camera originals" },
  { key: "storage", name: "Media storage" },
  { key: "playback", name: "Playback" },
]);

const n = (x, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x : d);
/** A finite number in [lo, hi], or the default. Bounds keep every product finite (no Infinity or NaN bills). */
const within = (x, d, lo, hi) => Math.min(hi, Math.max(lo, n(x, d)));
/** Room for every product of settings and inputs to stay finite. */
const INPUT_MAX = 1e9;

/** Settings with every key present, numbers clamped to sane ranges, unknown keys dropped. */
export function normalizeSettings(sIn) {
  const s = sIn && typeof sIn === "object" ? sIn : {};
  const d = DEFAULT_SETTINGS;
  return {
    people: Math.round(within(s.people, d.people, 1, 100_000)),
    teams: Math.round(within(s.teams, d.teams, 1, 100_000_000)),
    days: within(s.days, d.days, 0, 31),
    hoursPerDay: within(s.hoursPerDay, d.hoursPerDay, 0, 24),
    idleHoursPerDay: within(s.idleHoursPerDay, d.idleHoursPerDay, 0, 24),
    savesPerMinute: within(s.savesPerMinute, d.savesPerMinute, 0, 600),
    agentEditsPerDay: within(s.agentEditsPerDay, d.agentEditsPerDay, 0, 1e6),
    dragShare: within(s.dragShare, d.dragShare, 0, 1),
    connectsPerDay: within(s.connectsPerDay, d.connectsPerDay, 0, 1e6),
    footageHoursPerMonth: within(s.footageHoursPerMonth, d.footageHoursPerMonth, 0, 10_000),
    previewMbps: within(s.previewMbps, d.previewMbps, 0.01, 1000),
    shareOriginals: typeof s.shareOriginals === "boolean" ? s.shareOriginals : d.shareOriginals,
    originalMbps: within(s.originalMbps, d.originalMbps, 0, 10_000),
    retentionMonths: within(s.retentionMonths, d.retentionMonths, 0, 1200),
    viewShare: within(s.viewShare, d.viewShare, 0, 1),
    storage: s.storage === "vault" ? "vault" : s.storage === "r2" ? "r2" : d.storage,
    plan: s.plan === "paid" ? "paid" : s.plan === "free" ? "free" : d.plan,
    segmentSeconds: within(s.segmentSeconds, d.segmentSeconds, 0.5, 3600),
  };
}

/** Input values: data.json's where it has a finite number, the defaults otherwise. */
export function resolveInputs(given) {
  const out = { ...INPUT_DEFAULTS };
  if (!given || typeof given !== "object") return out;
  for (const k of Object.keys(INPUT_DEFAULTS)) {
    const v = given[k];
    const x = typeof v === "number" ? v : v && typeof v === "object" ? v.value : undefined;
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) out[k] = Math.min(x, INPUT_MAX);
  }
  return out;
}

const emptyMeters = () => ({ workersReq: 0, workersCpuMs: 0, doReq: 0, doReqWs: 0, doGBs: 0, doRowsRead: 0, doRowsWritten: 0, doStorageGB: 0, r2StorageGB: 0, r2ClassA: 0, r2ClassB: 0 });

/**
 * One team's use for a month. `doReqWs` counts incoming WebSocket messages (20:1 on Paid); `doReq` every other
 * Durable Object request (connects, alarms, media to the vault), billed in full.
 */
export function usage(settingsIn, inputsIn) {
  const s = normalizeSettings(settingsIn);
  const m = resolveInputs(inputsIn);
  const vault = s.storage === "vault";
  const act = {};
  for (const a of ACTIVITIES) if (a.key !== "fee") act[a.key] = emptyMeters();

  const personDays = s.people * s.days;
  const editHours = personDays * s.hoursPerDay;

  // live edits: people's saves and agents' edits, each a WebSocket message to the project's room
  const edits = personDays * (s.hoursPerDay * 60 * s.savesPerMinute + s.agentEditsPerDay);
  const e = act.edits;
  e.doReqWs = edits * m.editDoReq;
  e.doGBs = edits * m.editGBs;
  e.doRowsRead = edits * m.editRowsRead;
  e.doRowsWritten = edits * (m.editRowsWritten + m.editArchiveRowsWritten);
  e.workersCpuMs = edits * m.editWorkerCpuMs;
  // the newest ARCHIVE_KEEP changes stay in the room's database; older ones go to compressed archive files
  e.doStorageGB = (Math.min(edits * Math.max(1, s.retentionMonths), ARCHIVE_KEEP) * m.changeBytes) / 1e9;
  const archiveFiles = edits / ARCHIVE_KEEP;
  if (vault) e.doRowsWritten += archiveFiles * 3;
  else e.r2ClassA = archiveFiles;

  // presence: cursors and playheads while someone drags, plus the room's minute check while anyone shows presence
  const presenceMsgs = editHours * 3600 * s.dragShare * m.presenceMsgPerSecWhileDragging;
  const presenceAlarms = editHours * m.presenceAlarmPerHour; // per person-hour: an upper bound when teammates overlap
  const p = act.presence;
  p.doReqWs = presenceMsgs * m.presenceDoReq;
  p.doGBs = presenceMsgs * m.presenceGBs + presenceAlarms * m.alarmGBs;
  p.doReq = presenceAlarms;
  p.doRowsWritten = presenceAlarms * m.alarmRowsWritten;

  // connections: opening the project, reconnects, open-but-idle sessions, the room's hourly upkeep alarm
  const connects = personDays * s.connectsPerDay;
  const idleHours = personDays * s.idleHoursPerDay;
  const upkeepAlarms = s.days * s.hoursPerDay * m.upkeepAlarmPerHour; // one room per team
  const c = act.connections;
  c.workersReq = connects * m.connWorkerReq;
  c.workersCpuMs = connects * m.connWorkerCpuMs;
  c.doReq = connects * m.connDoReq + idleHours * m.idleDoReqPerHour + upkeepAlarms;
  c.doGBs = connects * m.connGBs + idleHours * m.idleGBsPerHour + upkeepAlarms * m.alarmGBs;
  c.doRowsRead = connects * m.connRowsRead;
  c.doRowsWritten = connects * m.connRowsWritten + idleHours * m.idleRowsWrittenPerHour + upkeepAlarms * m.alarmRowsWritten;

  // preview uploads: the collab proxy, uploaded as segments of `segmentSeconds` while it encodes
  const footageHours = s.people * s.footageHoursPerMonth;
  const proxyBytesPerHour = (s.previewMbps * 1e6 * 3600) / 8;
  const proxyGB = (footageHours * proxyBytesPerHour) / 1e9;
  const segments = (footageHours * 3600) / s.segmentSeconds;
  const segMiB = (s.previewMbps * 1e6 * s.segmentSeconds) / 8 / MIB;
  // rows a segment takes in the vault: its three objects (bytes, manifest, list entry), each a record row and its 1 MiB
  // chunk rows; the input counts one chunk for the bytes
  const vaultSegRows = m.segVaultRowsWritten - 1 + Math.ceil(segMiB);
  const g = act.segments;
  g.workersReq = segments * m.segWorkerReq;
  g.workersCpuMs = segments * m.segWorkerCpuMs;
  if (vault) {
    g.doReq = segments * m.segVaultDoReq;
    // the vault keeps 1 MiB per row: a segment's bytes take ceil(size) rows; the input counts one
    g.doRowsWritten = segments * vaultSegRows;
    g.doGBs = proxyGB * m.gbVaultGBs;
  } else {
    g.r2ClassA = segments * m.segR2ClassA;
    g.r2ClassB = segments * m.segR2ClassB;
  }

  // camera originals: only when shared; resumable multipart uploads in 8 MiB parts
  const originalsGB = s.shareOriginals ? (footageHours * s.originalMbps * 1e6 * 3600) / 8 / 1e9 : 0;
  const o = act.originals;
  o.workersReq = originalsGB * m.gbWorkerReq;
  o.workersCpuMs = originalsGB * m.gbWorkerCpuMs;
  if (vault) {
    o.doReq = originalsGB * m.gbVaultDoReq;
    o.doRowsWritten = originalsGB * m.gbVaultRowsWritten;
    o.doGBs = originalsGB * m.gbVaultGBs;
  } else {
    o.r2ClassA = originalsGB * m.gbR2ClassA;
    o.r2ClassB = originalsGB * m.gbR2ClassB;
    o.doReq = originalsGB * m.gbDoReq;
  }

  // media storage: each month's media, kept `retentionMonths` (steady state). Deleting a month's media from the vault
  // deletes every row it took (a delete is a row written): each segment's objects with their chunk rows, and each MiB
  // of the originals. R2's deletes are free.
  const monthlyGB = proxyGB + originalsGB;
  const storedGB = monthlyGB * s.retentionMonths;
  const st = act.storage;
  if (vault) {
    st.doStorageGB = storedGB;
    st.doRowsWritten = s.retentionMonths > 0 ? segments * vaultSegRows + Math.ceil((originalsGB * 1e9) / MIB) : 0;
  } else st.r2StorageGB = storedGB;

  // playback: each person plays `viewShare` of every teammate's proxies once (played media is cached on disk); reads
  // go per segment, so the per-MiB inputs (measured with 2 s at 2 Mbit/s) scale with the segment's size
  const viewedMiB = (s.people * Math.max(0, s.people - 1) * s.footageHoursPerMonth * proxyBytesPerHour * s.viewShare) / MIB;
  const refSegMiB = (REF_SEGMENT.mbps * 1e6 * REF_SEGMENT.seconds) / 8 / MIB;
  const perSeg = refSegMiB / Math.max(segMiB, 1e-9);
  const v = act.playback;
  v.workersReq = viewedMiB * m.viewWorkerReqPerMiB * perSeg;
  v.workersCpuMs = viewedMiB * m.viewWorkerCpuMsPerMiB * perSeg;
  if (vault) {
    v.doReq = viewedMiB * m.viewWorkerReqPerMiB * perSeg;
    // one 1 MiB row per MiB of a segment, rounded up (the input is per MiB at the reference segment, one row)
    v.doRowsRead = viewedMiB * m.viewVaultRowsReadPerMiB * perSeg * Math.ceil(segMiB);
    v.doGBs = viewedMiB * m.viewVaultGBsPerMiB;
  } else v.r2ClassB = viewedMiB * m.viewClassBPerMiB * perSeg;

  // duration is wall-clock time, shared by everything an object does at once: the room (edits, presence, connections)
  // and the vault (media) are each awake at most the whole month, 128 MB
  const wallGBs = s.days * 86_400 * DO_MEMORY_GB;
  const capGBs = (keys) => {
    const sum = keys.reduce((t, k) => t + act[k].doGBs, 0);
    if (sum <= wallGBs) return false;
    for (const k of keys) act[k].doGBs *= wallGBs / sum;
    return true;
  };
  const roomCapped = capGBs(["edits", "presence", "connections"]);
  const vaultCapped = vault && capGBs(["segments", "originals", "playback"]);

  const totals = emptyMeters();
  for (const a of Object.values(act)) for (const k of Object.keys(totals)) totals[k] += a[k];
  return {
    settings: s,
    inputs: m,
    activities: act,
    totals,
    derived: {
      edits, presenceMsgs, presenceAlarms, connects, idleHours, upkeepAlarms, footageHours, proxyGB, segments, segMiB, originalsGB, storedGB, viewedMiB, editHours,
      // the largest single Durable Object: a project's vault (its media) or its room (recent changes)
      roomGB: e.doStorageGB, vaultGB: vault ? storedGB : 0, roomCapped, vaultCapped,
    },
  };
}

/** Billable units past the included amount; rounded up to the next unit where Cloudflare says so (`round`). */
const units = (used, p) => {
  const x = Math.max(0, used - p.included) / p.perUnit;
  return p.round ? Math.max(0, Math.ceil(x - 1e-9)) : x;
};
const over = (used, p) => units(used, p) * p.per;

/** Does the largest Durable Object fit what one object may hold on this plan (1 GB Free, 10 GB Paid)? */
export function capacity(u, prices, plan) {
  const limitGB = plan === "paid" ? prices.paid.doObjectGB ?? 10 : prices.free.doObjectGB ?? 1;
  const what = u.derived.vaultGB >= u.derived.roomGB ? "vault" : "room";
  const objectGB = Math.max(u.derived.vaultGB, u.derived.roomGB);
  return { ok: objectGB <= limitGB + 1e-12, what, objectGB, limitGB };
}

/** The month's bill for `settings.teams` teams: by Cloudflare meter and by what it's for. */
export function bill(settingsIn, inputsIn, prices) {
  const u = usage(settingsIn, inputsIn);
  const s = u.settings;
  const T = s.teams;
  const paid = s.plan === "paid";
  const P = prices.paid;
  const R = prices.r2;
  const ratio = P.wsMessagesPerRequest || 20;
  // billed Durable Object requests per activity: WebSocket messages at 1/ratio on Paid
  const doBilledOf = (a) => a.doReq + a.doReqWs / ratio;
  const used = {};
  for (const k of Object.keys(u.totals)) used[k] = u.totals[k] * T;
  const doBilled = (u.totals.doReq + u.totals.doReqWs / ratio) * T;

  const meterRows = [];
  const cost = {};
  const priceOf = { workersReq: P.workersReq, workersCpuMs: P.workersCpuMs, doReq: P.doReq, doGBs: P.doGBs, doRowsRead: P.doRowsRead, doRowsWritten: P.doRowsWritten, doStorageGB: P.doStorageGBMonth, r2StorageGB: R.storageGBMonth, r2ClassA: R.classA, r2ClassB: R.classB };
  for (const mt of METERS) {
    const p = priceOf[mt.key];
    const isR2 = mt.product === "r2";
    const amount = mt.key === "doReq" ? (paid ? doBilled : (u.totals.doReq + u.totals.doReqWs) * T) : used[mt.key];
    const billed = isR2 || paid;
    const c = billed ? over(amount, p) : 0;
    cost[mt.key] = c;
    meterRows.push({
      key: mt.key,
      product: mt.product,
      name: mt.name,
      unit: mt.unit,
      used: amount,
      wsMessages: mt.key === "doReq" ? u.totals.doReqWs * T : undefined,
      included: billed ? p.included : null,
      billable: billed ? units(amount, p) * p.perUnit : 0,
      price: p,
      cost: c,
    });
  }

  // attribute each meter's cost to activities in proportion to their (billing-weighted) use of it
  const lines = ACTIVITIES.map((a) => ({ key: a.key, name: a.name, cost: 0, byMeter: {} }));
  const line = Object.fromEntries(lines.map((l) => [l.key, l]));
  line.fee.cost = paid ? P.base : 0;
  for (const mt of METERS) {
    const c = cost[mt.key];
    if (!c) continue;
    const share = {};
    let sum = 0;
    for (const [k, a] of Object.entries(u.activities)) {
      const x = mt.key === "doReq" ? (paid ? doBilledOf(a) : a.doReq + a.doReqWs) : a[mt.key];
      share[k] = x;
      sum += x;
    }
    if (!sum) continue;
    for (const [k, x] of Object.entries(share)) {
      if (!x) continue;
      const part = (c * x) / sum;
      line[k].cost += part;
      line[k].byMeter[mt.key] = part;
    }
  }
  const total = lines.reduce((t, l) => t + l.cost, 0);
  const people = s.people * T;
  return { plan: s.plan, settings: s, usage: u, meters: meterRows, lines, total, perUser: total / people, people, capacity: capacity(u, prices, s.plan) };
}

const FREE_CHECKS = [
  { key: "workersReq", name: "Worker requests a day", limit: (f) => f.workersReqDay, perDay: (t, days) => t.workersReq / days },
  { key: "doReq", name: "Durable Object requests a day", limit: (f) => f.doReqDay, perDay: (t, days) => (t.doReq + t.doReqWs * FREE_WS_RATIO) / days },
  { key: "doGBs", name: "Durable Object duration a day", limit: (f) => f.doGBsDay, perDay: (t, days) => t.doGBs / days },
  { key: "doRowsRead", name: "Rows read a day", limit: (f) => f.doRowsReadDay, perDay: (t, days) => t.doRowsRead / days },
  { key: "doRowsWritten", name: "Rows written a day", limit: (f) => f.doRowsWrittenDay, perDay: (t, days) => t.doRowsWritten / days },
  { key: "doStorageGB", name: "Durable Object storage (5 GB in all)", limit: (f) => f.doStorageGB, perDay: (t) => t.doStorageGB, total: true },
];

/**
 * Does this fit Workers Free? Each daily limit is checked against an average editing day (the month's use over its
 * editing days); storage against the 5 GB total. For each: the most teams that fit and the count where it breaks (the
 * point where Workers Paid becomes necessary). Also a per-request check: the 10 ms CPU limit.
 */
export function freeCheck(settingsIn, inputsIn, prices) {
  const u = usage(settingsIn, inputsIn);
  const s = u.settings;
  const F = prices.free;
  const days = Math.max(1e-9, s.days);
  // one boundary for every answer: a team count fits when it is at most maxTeams (floating-point noise forgiven)
  const checks = FREE_CHECKS.map((c) => {
    const perTeam = c.perDay(u.totals, days);
    const limit = c.limit(F);
    const maxTeams = perTeam > 0 ? Math.floor(limit / perTeam + 1e-9) : Infinity;
    return { key: c.key, name: c.name, total: !!c.total, perTeam, used: perTeam * s.teams, limit, maxTeams, breaksAt: maxTeams === Infinity ? Infinity : maxTeams + 1, over: s.teams > maxTeams };
  });
  // one Durable Object holds at most 1 GB on Free: the vault (a project's media) or the room, whatever the team count
  const cap = capacity(u, prices, "free");
  checks.push({ key: "doObjectGB", name: `Storage in one Durable Object (${cap.limitGB} GB)`, total: true, perObject: true, perTeam: cap.objectGB, used: cap.objectGB, limit: cap.limitGB, maxTeams: cap.ok ? Infinity : 0, breaksAt: cap.ok ? Infinity : 1, over: !cap.ok });
  const m = u.inputs;
  // CPU per request: each kind's total CPU over its requests, an average (the limit applies to every single request)
  const cpu = [
    { what: "a connect", ms: m.connWorkerReq ? m.connWorkerCpuMs / m.connWorkerReq : 0, used: u.totals.workersReq > 0 && u.derived.connects > 0 },
    { what: "a preview-segment request", ms: m.segWorkerReq ? m.segWorkerCpuMs / m.segWorkerReq : 0, used: u.derived.segments > 0 },
    { what: "an upload part", ms: m.gbWorkerReq ? m.gbWorkerCpuMs / m.gbWorkerReq : 0, used: u.derived.originalsGB > 0 },
    { what: "a playback read", ms: m.viewWorkerReqPerMiB ? m.viewWorkerCpuMsPerMiB / m.viewWorkerReqPerMiB : 0, used: u.derived.viewedMiB > 0 },
  ].filter((x) => x.used);
  const cpuLimit = F.workersCpuMsPerRequest ?? 10;
  const cpuWorst = cpu.reduce((w, x) => (x.ms > (w?.ms ?? -1) ? x : w), null);
  const cpuOver = !!cpuWorst && cpuWorst.ms > cpuLimit;
  const sorted = [...checks].sort((a, b) => a.breaksAt - b.breaksAt);
  const first = sorted[0].breaksAt === Infinity ? null : sorted[0];
  const fits = !cpuOver && checks.every((c) => !c.over);
  return { fits, first, checks, sorted, cpu: { limit: cpuLimit, worst: cpuWorst, over: cpuOver, basis: "average" }, maxTeams: cpuOver ? 0 : first ? first.maxTeams : Infinity };
}

/** The biggest line (the plan fee included), and one way to lower it, priced by running the model again. */
function suggest(b, inputsIn, prices, fc) {
  const s = b.settings;
  const tryWith = (patch, inputsPatch) => bill({ ...s, ...patch }, { ...resolveInputs(inputsIn), ...(inputsPatch ?? {}) }, prices).total;
  const paidCap = capacity(b.usage, prices, "paid");
  // the vault can't hold a project's media even on Paid: R2 is the way, on the cheapest plan that fits
  const inR2 = () => {
    const free = freeCheck({ ...s, storage: "r2", plan: "free" }, inputsIn, prices);
    const plan = free.fits ? "free" : "paid";
    return { plan, total: tryWith({ storage: "r2", plan }) };
  };
  if (s.plan === "free" && !fc.fits) {
    const why = limitWhy(fc);
    if (!paidCap.ok) {
      const r2 = inR2();
      return { driver: "limit", text: `Workers Free can't run this: ${why}. Workers Paid can't either: ${capWhy(paidCap)}. With media in R2 it would cost $${r2.total.toFixed(2)} a month on Workers ${r2.plan === "free" ? "Free" : "Paid"}.`, saving: 0, paidTotal: null, alternative: { storage: "r2", ...r2 } };
    }
    const paidTotal = tryWith({ plan: "paid" });
    return { driver: "limit", text: `Workers Free can't run this: ${why}. On Workers Paid it would cost $${paidTotal.toFixed(2)} a month.`, saving: 0, paidTotal, alternative: { storage: s.storage, plan: "paid", total: paidTotal } };
  }
  if (s.plan === "paid" && !paidCap.ok) {
    const r2 = inR2();
    return { driver: "capacity", text: `The vault can't hold this: ${capWhy(paidCap)}. With media in R2 it would cost $${r2.total.toFixed(2)} a month on Workers ${r2.plan === "free" ? "Free" : "Paid"}.`, saving: 0, alternative: { storage: "r2", ...r2 } };
  }
  const ranked = b.lines.filter((l) => l.cost > 0).sort((x, y) => y.cost - x.cost);
  if (!ranked.length) return { driver: null, text: "Nothing bills at this scale.", saving: 0 };
  const longer = Math.max(6, s.segmentSeconds * 3);
  const optionsFor = (key) => {
    const options = [];
    switch (key) {
      case "fee":
        if (fc.fits) options.push({ text: `Workers Free fits this use (up to ${fmtTeams(fc.maxTeams)} like this), so the $${prices.paid.base} plan isn't needed yet.`, total: tryWith({ plan: "free" }) });
        break;
      case "storage":
        if (s.storage === "vault") options.push({ text: "Keep media in R2 instead of the Durable Object vault: R2 storage costs $0.015 a GB-month against $0.20.", total: tryWith({ storage: "r2" }) });
        if (s.retentionMonths > 1) options.push({ text: `Keep media ${s.retentionMonths - 1} month${s.retentionMonths - 1 === 1 ? "" : "s"} instead of ${s.retentionMonths}.`, total: tryWith({ retentionMonths: s.retentionMonths - 1 }) });
        if (s.shareOriginals) options.push({ text: "Share camera originals only when a teammate asks for one.", total: tryWith({ shareOriginals: false }) });
        if (s.previewMbps > PREVIEW_QUALITY["540p"]) options.push({ text: `Share previews at 540p (1 Mbit/s) instead of ${s.previewMbps} Mbit/s: fewer bytes to store, a softer picture.`, total: tryWith({ previewMbps: PREVIEW_QUALITY["540p"] }) });
        break;
      case "originals":
        options.push({ text: "Share camera originals only when a teammate asks for one (the preview is enough to edit with).", total: tryWith({ shareOriginals: false }) });
        if (s.storage === "vault") options.push({ text: "Keep media in R2 instead of the vault.", total: tryWith({ storage: "r2" }) });
        break;
      case "segments":
        options.push({ text: `Upload previews in ${longer} s segments instead of ${s.segmentSeconds} s: fewer writes, but a teammate waits a little longer for the first one.`, total: tryWith({ segmentSeconds: longer }) });
        if (s.storage === "vault") options.push({ text: "Keep media in R2 instead of the vault.", total: tryWith({ storage: "r2" }) });
        break;
      case "playback":
        if (s.previewMbps > PREVIEW_QUALITY["540p"]) options.push({ text: "Share previews at 540p (1 Mbit/s): fewer bytes and fewer reads.", total: tryWith({ previewMbps: PREVIEW_QUALITY["540p"] }) });
        options.push({ text: `Use ${longer} s preview segments: fewer, larger reads.`, total: tryWith({ segmentSeconds: longer }) });
        if (s.storage === "vault") options.push({ text: "Keep media in R2 instead of the vault.", total: tryWith({ storage: "r2" }) });
        break;
      case "presence": {
        const r = resolveInputs(inputsIn).presenceMsgPerSecWhileDragging;
        options.push({ text: `Send cursor and playhead updates ${r / 2} times a second instead of ${r} while dragging (a Carton client setting).`, total: tryWith({}, { presenceMsgPerSecWhileDragging: r / 2 }) });
        break;
      }
      case "edits":
        if (s.savesPerMinute > 0.5) options.push({ text: `Batch saves: ${s.savesPerMinute / 2} a minute instead of ${s.savesPerMinute}.`, total: tryWith({ savesPerMinute: s.savesPerMinute / 2 }) });
        options.push({ text: "Batch agent edits: half as many per person a day.", total: tryWith({ agentEditsPerDay: s.agentEditsPerDay / 2 }) });
        break;
      case "connections":
        options.push({ text: `Reconnect less: ${Math.max(1, Math.round(s.connectsPerDay / 2))} connects a day instead of ${s.connectsPerDay}.`, total: tryWith({ connectsPerDay: Math.max(1, Math.round(s.connectsPerDay / 2)) }) });
        break;
    }
    return options.filter((o) => o.total < b.total - 1e-9);
  };
  // the biggest line first; the plan fee when Workers Free can't run this has no lever, so the next line is used
  const top = ranked[0];
  for (const line of ranked) {
    const options = optionsFor(line.key);
    if (!options.length) continue;
    const best = options.reduce((x, y) => (y.total < x.total ? y : x));
    const lead = line.key === top.key ? "" : top.key === "fee" && !fc.fits ? `The $${prices.paid.base} plan is the floor here (on Workers Free, ${limitWhy(fc)}). Next biggest, ${line.name.toLowerCase()}: ` : "";
    return { driver: top.key, lever: line.key, text: lead + best.text, saving: Math.max(0, b.total - best.total), newTotal: best.total };
  }
  if (top.key === "fee" && !fc.fits) return { driver: "fee", text: `The $${prices.paid.base} plan is the floor here: on Workers Free, ${limitWhy(fc)}.`, saving: 0 };
  return { driver: top.key, text: "", saving: 0 };
}

function limitWhy(fc) {
  if (fc.cpu.over) return `${fc.cpu.worst.what} needs more than the ${fc.cpu.limit} ms of CPU a request may use`;
  if (fc.first.perObject) return `one Durable Object may hold ${fc.first.limit} GB on Free, and a project's ${fc.first.perTeam > 0.5 ? "vault" : "room"} would hold ${fmtGB(fc.first.perTeam)}`;
  return `the limit on ${fc.first.name} is passed at ${fmtTeams(fc.first.breaksAt)}`;
}

/** Why one Durable Object can't hold it (the vault is one object per project). */
function capWhy(cap) {
  return `a project's ${cap.what} is one Durable Object, which holds at most ${cap.limitGB} GB, and this would keep ${fmtGB(cap.objectGB)} in it`;
}

const fmtGB = (x) => `${x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString("en-US")} GB`;

function fmtTeams(x) {
  if (x === Infinity) return "any number of teams";
  return `${x.toLocaleString("en-US")} team${x === 1 ? "" : "s"}`;
}

/** Everything the page shows for one set of settings. */
export function compute(settingsIn, inputsIn, prices) {
  const b = bill(settingsIn, inputsIn, prices);
  const fc = freeCheck(settingsIn, inputsIn, prices);
  const driver = b.lines.filter((l) => l.cost > 0).sort((x, y) => y.cost - x.cost)[0] ?? null;
  return { ...b, free: fc, driver, suggestion: suggest(b, inputsIn, prices, fc) };
}

/** Team counts for the cost curve: 1, 2, 5, 10, … up to `max`. */
export function teamSteps(max = 100_000) {
  const out = [];
  for (let d = 1; d <= max; d *= 10) for (const k of [1, 2, 5]) if (k * d <= max) out.push(k * d);
  return out;
}

/**
 * Monthly cost against number of teams for the current settings: R2 and vault, on Paid, and on Free up to the team
 * count where a Free limit breaks (null past it: requests would fail there, so there is no Free price).
 */
export function curve(settingsIn, inputsIn, prices, steps = teamSteps()) {
  const s = normalizeSettings(settingsIn);
  const series = [];
  for (const storage of ["r2", "vault"])
    for (const plan of ["paid", "free"]) {
      const fc = freeCheck({ ...s, storage, plan, teams: 1 }, inputsIn, prices);
      // on Paid, a project's media must still fit one Durable Object when it's in the vault
      const cap = capacity(usage({ ...s, storage, plan, teams: 1 }, inputsIn), prices, plan);
      const points = steps.map((teams) => {
        if (plan === "free" && (fc.cpu.over || teams > fc.maxTeams)) return { teams, total: null };
        if (plan === "paid" && !cap.ok) return { teams, total: null };
        return { teams, total: bill({ ...s, storage, plan, teams }, inputsIn, prices).total };
      });
      series.push({ key: `${storage}-${plan}`, storage, plan, maxTeams: plan === "free" ? fc.maxTeams : cap.ok ? Infinity : 0, capacity: cap, points });
    }
  return series;
}
