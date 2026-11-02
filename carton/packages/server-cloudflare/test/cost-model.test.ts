// The /cost/ calculator's model (site/cost/model.js): hand-computed bills, the 20:1 WebSocket rule, Workers Free's daily
// limits and the team count where each breaks, and that missing or bad inputs never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "../site/cost/model.js";
import type { Prices, Settings } from "../site/cost/model.js";

const site = (f: string) => fileURLToPath(new URL(`../site/cost/${f}`, import.meta.url));
const prices = JSON.parse(readFileSync(site("prices.json"), "utf8")) as Prices;
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${msg ?? ""} ${a} ≠ ${b}`);
/** Every per-operation input at 0, then the ones a case needs. */
const only = (x: Partial<Record<keyof typeof M.INPUT_DEFAULTS, number>>) => ({ ...Object.fromEntries(Object.keys(M.INPUT_DEFAULTS).map((k) => [k, 0])), ...x });
const solo: Partial<Settings> = { ...M.PRESETS.solo.settings, storage: "r2" };

test("a solo editor on Workers Free with R2 pays only R2 storage past its 10 GB-month", () => {
  // 10 h of footage a month at 2 Mbit/s = 10 × 0.9 GB = 9 GB, kept 3 months = 27 GB-month; (27 - 10) × $0.015 = $0.255
  const b = M.bill({ ...solo, plan: "free" }, {}, prices);
  close(b.usage.totals.r2StorageGB, 27);
  close(b.total, 0.255);
  const line = Object.fromEntries(b.lines.map((l) => [l.key, l.cost]));
  close(line.storage!, 0.255);
  for (const k of ["fee", "edits", "presence", "connections", "segments", "originals", "playback"]) assert.equal(line[k], 0, k);
  // R2 operations stay inside their monthly free amounts: 18,000 segments × 3 Class A, and Class B
  const a = b.meters.find((m) => m.key === "r2ClassA")!;
  assert.ok(a.used < 1e6 && a.cost === 0);
  assert.ok(M.freeCheck({ ...solo, plan: "free" }, {}, prices).fits);
});

test("Workers Paid adds the $5 fee and nothing else while use stays inside the included amounts", () => {
  const free = M.bill({ ...solo, plan: "free" }, {}, prices);
  const paid = M.bill({ ...solo, plan: "paid" }, {}, prices);
  close(paid.total, 5.255);
  close(paid.total - free.total, 5);
  assert.equal(paid.lines.find((l) => l.key === "fee")!.cost, 5);
  for (const m of paid.meters) if (m.product !== "r2") assert.equal(m.cost, 0, m.key);
});

test("the vault keeps media in Durable Object storage: $0.20 a GB-month past 5, and it breaks Workers Free's 5 GB at once", () => {
  const b = M.bill({ ...solo, storage: "vault", plan: "paid" }, {}, prices);
  close(b.usage.totals.doStorageGB - b.usage.activities.edits.doStorageGB, 27);
  // 27 GB of media + 0.006 GB of change rows - 5 included = 22.006, rounded up to 23 GB-month × $0.20
  close(b.meters.find((m) => m.key === "doStorageGB")!.cost, 23 * 0.2);
  assert.equal(b.meters.find((m) => m.key === "r2StorageGB")!.used, 0);
  const fc = M.freeCheck({ ...solo, storage: "vault" }, {}, prices);
  assert.equal(fc.fits, false);
  assert.equal(fc.first!.key, "doStorageGB");
  assert.equal(fc.first!.breaksAt, 1);
  assert.equal(fc.maxTeams, 0);
});

test("incoming WebSocket messages bill 20:1 on Paid; connects and alarms bill in full", () => {
  // presence only: 10 teams × 20 days × 10 h × 3600 s × 100% dragging × 10 messages a second = 72M messages
  const s: Partial<Settings> = { people: 1, teams: 10, days: 20, hoursPerDay: 10, dragShare: 1, presenceRate: 10, footageHoursPerMonth: 0, plan: "paid", storage: "r2" };
  const ws = only({ presenceDoReq: 1 });
  const b = M.bill(s, ws, prices);
  const doReq = b.meters.find((m) => m.key === "doReq")!;
  close(doReq.wsMessages!, 72e6);
  close(doReq.used, 3.6e6); // 72M / 20
  close(doReq.billable, 3e6); // 2.6M past the included million, rounded up to the next million
  close(doReq.cost, 0.45);
  // add 1M connects (5,000 a day): a request to create a WebSocket connection is billed in full
  const b2 = M.bill({ ...s, connectsPerDay: 5000 }, { ...ws, connDoReq: 1 }, prices);
  const d2 = b2.meters.find((m) => m.key === "doReq")!;
  close(d2.used, 4.6e6);
  close(d2.cost, 0.6); // 3.6M past the included million → 4M × $0.15
  // the same 72M messages as plain requests would cost (72M - 1M) × $0.15/M
  const b3 = M.bill({ ...s, connectsPerDay: 72e6 / 200 }, only({ connDoReq: 1 }), prices);
  close(b3.meters.find((m) => m.key === "doReq")!.cost, ((72e6 - 1e6) * 0.15) / 1e6);
  // the cost lands on the line that sent the messages
  close(b.lines.find((l) => l.key === "presence")!.cost, doReq.cost);
});

test("Workers Free counts every WebSocket message against its 100,000 Durable Object requests a day", () => {
  // 1 person × (60 min × 1 save a minute + 40 agent edits) = 100 edits a day × 20 messages each = 2,000 a team a day,
  // so 50 teams use the 100,000 exactly (the 20:1 ratio is for billing only) and the 51st breaks it
  const s: Partial<Settings> = { people: 1, days: 20, hoursPerDay: 1, savesPerMinute: 1, agentEditsPerDay: 40, footageHoursPerMonth: 0, dragShare: 0, connectsPerDay: 0, plan: "free" };
  const inputs = only({ editDoReq: 20 });
  const fc = M.freeCheck({ ...s, teams: 50 }, inputs, prices);
  const d = fc.checks.find((c) => c.key === "doReq")!;
  close(d.perTeam, 2000);
  assert.equal(d.maxTeams, 50);
  assert.equal(d.breaksAt, 51);
  assert.equal(fc.fits, true);
  assert.equal(M.freeCheck({ ...s, teams: 51 }, inputs, prices).fits, false);
});

test("Workers Free: each daily limit's team threshold, and the first one named", () => {
  // Worker requests: 2 people × 50 connects a day = 100 a team a day → 1,000 teams fit, 1,001 break
  // rows written: 2 people × 50 connects × 4 rows = 400 a team a day → 250 teams fit, 251 break (the first)
  const s: Partial<Settings> = { people: 2, days: 20, connectsPerDay: 50, hoursPerDay: 0, agentEditsPerDay: 0, footageHoursPerMonth: 0, plan: "free" };
  const inputs = only({ connWorkerReq: 1, connRowsWritten: 4 });
  const fc = M.freeCheck({ ...s, teams: 250 }, inputs, prices);
  const w = fc.checks.find((c) => c.key === "workersReq")!;
  const r = fc.checks.find((c) => c.key === "doRowsWritten")!;
  close(w.perTeam, 100);
  assert.equal(w.breaksAt, 1001);
  close(r.perTeam, 400);
  assert.equal(r.breaksAt, 251);
  assert.equal(fc.first!.key, "doRowsWritten");
  assert.equal(fc.maxTeams, 250);
  assert.equal(fc.fits, true);
  const over = M.freeCheck({ ...s, teams: 251 }, inputs, prices);
  assert.equal(over.fits, false);
  assert.deepEqual(over.checks.filter((c) => c.over).map((c) => c.key), ["doRowsWritten"]);
  // on Free, nothing bills for Workers or Durable Objects, past a limit or not
  assert.equal(M.bill({ ...s, teams: 5000 }, inputs, prices).total, 0);
  // GB-s: 13,000 a day; rows read: 5M a day
  const g = M.freeCheck({ ...s, teams: 1 }, only({ connGBs: 13 }), prices).checks.find((c) => c.key === "doGBs")!;
  close(g.perTeam, 1300);
  assert.equal(g.maxTeams, 10);
  const rr = M.freeCheck({ ...s, teams: 1 }, only({ connRowsRead: 500 }), prices).checks.find((c) => c.key === "doRowsRead")!;
  assert.equal(rr.maxTeams, 100);
});

test("the 10 ms CPU limit per request on Free: an upload part over it fails Workers Free at any scale", () => {
  const s: Partial<Settings> = { ...solo, shareOriginals: true };
  const ok = M.freeCheck(s, {}, prices);
  assert.equal(ok.cpu.over, false); // 840 ms per GB over 140 requests = 6 ms
  const before = M.freeCheck(s, { gbWorkerCpuMs: 14_000 }, prices); // the lab's per-part CPU before fix/cf-stream-parts
  assert.equal(before.cpu.over, true);
  assert.equal(before.fits, false);
  assert.equal(before.maxTeams, 0);
});

test("rows read come straight from the per-edit input (no ×10)", () => {
  const s: Partial<Settings> = { people: 1, days: 10, hoursPerDay: 1, savesPerMinute: 1, agentEditsPerDay: 0, connectsPerDay: 0, footageHoursPerMonth: 0 };
  const u = M.usage(s, only({ editRowsRead: 0.9 }));
  close(u.derived.edits, 600);
  close(u.totals.doRowsRead, 540);
});

test("longer preview segments mean fewer storage writes and reads", () => {
  const base = M.usage({ ...M.PRESETS.team5.settings, segmentSeconds: 2 }, {});
  const longer = M.usage({ ...M.PRESETS.team5.settings, segmentSeconds: 6 }, {});
  close(base.derived.segments, 5 * 10 * 1800); // 5 people × 10 h × 1,800 two-second segments an hour
  // 3 writes a segment, plus 5 a stream (streams don't change with the segment length)
  const fixedA = base.derived.streams * 5;
  close(longer.activities.segments.r2ClassA - fixedA, (base.activities.segments.r2ClassA - fixedA) / 3);
  // before the fix, every read goes per segment
  const b2 = M.usage({ ...M.PRESETS.team5.settings, previewPath: "before" }, {});
  const b6 = M.usage({ ...M.PRESETS.team5.settings, previewPath: "before", segmentSeconds: 6 }, {});
  close(b6.activities.playback.r2ClassB, b2.activities.playback.r2ClassB / 3);
  close(longer.totals.r2StorageGB, base.totals.r2StorageGB); // the same bytes stored
});

test("playback: each person plays a share of every teammate's proxies; a solo editor plays none", () => {
  assert.equal(M.usage(solo, {}).derived.viewedMiB, 0);
  // 5 people × 4 teammates × 10 h × 900 MB × 50% = 90 GB read
  const u = M.usage({ ...M.PRESETS.team5.settings, viewShare: 0.5 }, {});
  close((u.derived.viewedMiB * 1024 * 1024) / 1e9, 90);
  // optimized reads: 2 GETs a segment (82% of the measured Class B at 0.618 MiB parts, scaled to 0.477 MiB ones) and the
  // reads' own (18%, per 2 MiB read)
  const perSeg = M.PV_REF_PART_MIB / u.derived.segMiB;
  void perSeg;
  // the release reads 1 MiB at a time: two 0.477 MiB segments a read, plus 1 read a stream (2-minute clips: 28.6 MiB)
  const segs = u.derived.viewedMiB / u.derived.segMiB;
  const streamsViewed = u.derived.viewedMiB / ((2 * 60 * 2e6) / 8 / 1024 / 1024);
  assert.equal(u.derived.segsPerRead, 2);
  close(u.derived.reads, segs / 2 + streamsViewed);
  close(u.activities.playback.workersReq, u.derived.reads);
  // Class B: each segment's list entry and bytes (2), and one more entry per read
  close(u.activities.playback.r2ClassB, segs * 2 + u.derived.reads);
});

test("connects, idle sessions and the room's alarms are their own line", () => {
  const s: Partial<Settings> = { people: 2, days: 10, hoursPerDay: 0, idleHoursPerDay: 4, connectsPerDay: 3, footageHoursPerMonth: 0, agentEditsPerDay: 0 };
  const u = M.usage(s, only({ connDoReq: 1, connWorkerReq: 1, idleDoReqPerHour: 2, idleRowsWrittenPerHour: 1 }));
  const c = u.activities.connections;
  close(c.workersReq, 60); // 2 × 10 × 3
  close(c.doReq, 60 + 2 * 10 * 4 * 2); // connects in full + idle hours × 2
  close(c.doRowsWritten, 80);
  assert.equal(c.doReqWs, 0);
});

test("missing, extra and malformed inputs and settings never throw; missing inputs fall back to the defaults", () => {
  const weird = { editDoReq: "x", gbWorkerReq: { value: Number.NaN }, pubSegClassA: -3, someNewKey: { value: 9 }, presenceDoReq: { value: 2, status: "measured" } };
  const r = M.compute({ people: Number.NaN, teams: -4, storage: "floppy" as never, plan: undefined, dragShare: 7 } as never, weird, prices);
  assert.ok(Number.isFinite(r.total));
  assert.equal(r.settings.people, M.DEFAULT_SETTINGS.people);
  assert.equal(r.settings.teams, 1);
  assert.equal(r.settings.storage, "r2");
  assert.equal(r.settings.dragShare, 1);
  const i = M.resolveInputs(weird);
  assert.equal(i.editDoReq, M.INPUT_DEFAULTS.editDoReq);
  assert.equal(i.gbWorkerReq, M.INPUT_DEFAULTS.gbWorkerReq);
  assert.equal(i.pubSegClassA, M.INPUT_DEFAULTS.pubSegClassA); // a negative value is refused
  assert.equal(i.presenceDoReq, 2);
  assert.ok(!("someNewKey" in i));
  assert.doesNotThrow(() => M.curve({}, undefined, prices));
});

test("presets give different bills, and the biggest driver comes with a priced way to lower it", () => {
  const totals = Object.values(M.PRESETS).map((p) => M.compute(p.settings, {}, prices).total);
  assert.equal(new Set(totals.map((t) => t.toFixed(4))).size, totals.length);
  // a vault that fits one object on Paid (5 people × 2 h × 0.9 GB = 9 GB) but not Free: the fee is the floor, so the
  // lever is the next line, media storage
  const r = M.compute({ ...M.PRESETS.team5.settings, footageHoursPerMonth: 2, retentionMonths: 1, storage: "vault", plan: "paid" }, {}, prices);
  assert.equal(r.capacity.ok, true);
  assert.equal(r.driver!.key, "fee");
  assert.equal(r.suggestion.lever, "storage");
  assert.match(r.suggestion.text, /R2/);
  assert.ok(r.suggestion.saving > 0 && r.suggestion.newTotal! < r.total);
  const blocked = M.compute({ ...M.PRESETS.studio20.settings, plan: "free" }, {}, prices);
  if (!blocked.free.fits) assert.equal(blocked.suggestion.driver, "limit");
});

test("the cost curve: Free stops where a Free limit breaks; Paid and R2 never stop", () => {
  const series = M.curve({ ...M.PRESETS.team5.settings }, {}, prices);
  const r2Free = series.find((x) => x.key === "r2-free")!;
  const r2Paid = series.find((x) => x.key === "r2-paid")!;
  for (const p of r2Free.points) assert.equal(p.total === null, p.teams > r2Free.maxTeams, `teams ${p.teams}`);
  assert.ok(r2Paid.points.every((p) => p.total !== null && p.total >= 5));
  // costs never fall as teams grow
  for (let i = 1; i < r2Paid.points.length; i++) assert.ok(r2Paid.points[i]!.total! >= r2Paid.points[i - 1]!.total!);
});

test("data.json (when built) carries every model input or the page shows it as not measured", () => {
  let data: { inputs?: Record<string, unknown>; prices?: unknown };
  try {
    data = JSON.parse(readFileSync(site("data.json"), "utf8"));
  } catch {
    return; // not built: the page falls back to the model's defaults
  }
  assert.ok(data.prices);
  const r = M.compute(M.PRESETS.team5.settings, data.inputs as never, data.prices as Prices);
  assert.ok(Number.isFinite(r.total));
});

test("Durable Objects and R2 round billable usage up to the next unit; Workers requests don't", () => {
  // R2: 27.27 GB-month - 10 free = 17.27, billed as 18 × $0.015 = $0.27 (Cloudflare's example: 1.1 GB-month bills as 2)
  const s: Partial<Settings> = { people: 1, footageHoursPerMonth: 10.1, retentionMonths: 3, plan: "free", storage: "r2" };
  const b = M.bill(s, {}, prices);
  close(b.usage.totals.r2StorageGB, 27.27);
  close(b.meters.find((m) => m.key === "r2StorageGB")!.cost, 0.27);
  // rows written: 50,000,001 on Paid → 1 row past the included 50M → a whole million, $1
  const one: Partial<Settings> = { people: 1, days: 1, hoursPerDay: 0, idleHoursPerDay: 0, agentEditsPerDay: 0, connectsPerDay: 1e6, footageHoursPerMonth: 0, plan: "paid" };
  const rows = M.bill(one, only({ connRowsWritten: 50.000001 }), prices);
  close(rows.meters.find((m) => m.key === "doRowsWritten")!.used, 50_000_001);
  close(rows.meters.find((m) => m.key === "doRowsWritten")!.cost, 1);
  // Worker requests: 10,500,000 → 0.5M past the included 10M → $0.15, not rounded to $0.30
  const wr = M.bill(one, only({ connWorkerReq: 10.5 }), prices);
  close(wr.meters.find((m) => m.key === "workersReq")!.cost, 0.15);
  // exactly the included amount bills nothing
  const exact = M.bill(one, only({ connDoReq: 1 }), prices);
  assert.equal(exact.meters.find((m) => m.key === "doReq")!.cost, 0);
});

test("the vault is one Durable Object per project: 1 GB on Free, 10 GB on Paid, whatever the team count", () => {
  // 1 person × 1 h × 0.9 GB × 2 months = 1.8 GB in one vault: under Free's 5 GB in all, over its 1 GB per object
  const small: Partial<Settings> = { people: 1, footageHoursPerMonth: 1, retentionMonths: 2, storage: "vault", plan: "free" };
  const fc = M.freeCheck(small, {}, prices);
  const obj = fc.checks.find((c) => c.key === "doObjectGB")!;
  close(obj.used, 1.8);
  assert.equal(obj.over, true);
  assert.equal(fc.fits, false);
  assert.equal(fc.maxTeams, 0);
  assert.equal(M.compute(small, {}, prices).suggestion.driver, "limit");
  assert.ok(M.freeCheck({ ...small, retentionMonths: 1 }, {}, prices).fits); // 0.9 GB fits
  // Paid: 1.8 GB fits its 10 GB; the solo default's 27 GB doesn't, and Paid isn't offered as the fix
  assert.equal(M.bill({ ...small, plan: "paid" }, {}, prices).capacity.ok, true);
  const big = M.compute({ ...solo, storage: "vault", plan: "paid" }, {}, prices);
  assert.equal(big.capacity.ok, false);
  close(big.capacity.objectGB, 27);
  assert.equal(big.suggestion.driver, "capacity");
  assert.equal(big.suggestion.alternative!.storage, "r2");
  const bigFree = M.compute({ ...solo, storage: "vault", plan: "free" }, {}, prices);
  assert.match(bigFree.suggestion.text, /Workers Paid can't either/);
  assert.equal(bigFree.suggestion.alternative!.storage, "r2");
  // and the curve has no vault-on-Paid line for it
  assert.ok(M.curve({ ...solo }, {}, prices).find((x) => x.key === "vault-paid")!.points.every((p) => p.total === null));
});

test("one object's duration never passes the month's wall-clock time", () => {
  // 500 people dragging 24 h a day at the web app's 10 a second: presence alone would be about 70,000 GB-s a day; one
  // room can be awake 86,400 s × 0.128 GB
  const u = M.usage({ people: 500, days: 30, hoursPerDay: 24, dragShare: 1, presenceRate: 10, footageHoursPerMonth: 0 }, {});
  const room = u.activities.edits.doGBs + u.activities.presence.doGBs + u.activities.connections.doGBs;
  close(room, 30 * 86_400 * 0.128);
  assert.equal(u.derived.roomCapped, true);
  assert.equal(M.usage(solo, {}).derived.roomCapped, false);
});

test("vault deletes count every row an expiring object took", () => {
  // solo, vault: 18,000 two-second segments a month; each is 3 objects × (record + one chunk) = 6 rows to delete
  const u = M.usage({ ...solo, storage: "vault" }, {});
  close(u.activities.storage.doRowsWritten, 18_000 * 6);
  close(u.activities.segments.doRowsWritten, 18_000 * 6);
  // a 6 s segment at 5 Mbit/s is 3.6 MiB: 4 chunk rows for its bytes, 5 more for its records and small objects
  const big = M.usage({ ...solo, storage: "vault", segmentSeconds: 6, previewMbps: 5 }, {});
  close(big.activities.segments.doRowsWritten / big.derived.segments, 9);
});

test("one boundary for 'fits': maxTeams, over and the curve agree, floating-point noise forgiven", () => {
  // 1 person × 1 connect a day × 0.1 requests over 3 days: 0.1 a team a day; 1M teams make 100,000.00000000001
  const s: Partial<Settings> = { people: 1, days: 3, connectsPerDay: 1, hoursPerDay: 0, agentEditsPerDay: 0, footageHoursPerMonth: 0, teams: 1_000_000 };
  const inputs = only({ connWorkerReq: 0.1 });
  const fc = M.freeCheck(s, inputs, prices);
  const w = fc.checks.find((c) => c.key === "workersReq")!;
  assert.equal(w.maxTeams, 1_000_000);
  assert.equal(w.over, false);
  assert.equal(fc.fits, true);
  assert.equal(M.freeCheck({ ...s, teams: 1_000_001 }, inputs, prices).fits, false);
});

test("CPU per request: typical for each kind; the preview's few slow requests are noted on Free", () => {
  // the release: a typical append 3.92 ms, read 3.18 ms; 8 of 255 at or over 10 ms (max 23 ms, a live viewer's first read)
  const fc = M.freeCheck({ ...M.PRESETS.team5.settings, shareOriginals: true }, {}, prices);
  assert.equal(fc.cpu.basis, "average");
  assert.equal(fc.cpu.worst!.what, "a preview append");
  close(fc.cpu.worst!.ms, 3.92);
  assert.equal(fc.cpu.over, false);
  assert.equal(fc.cpu.risk!.what, "preview append and preview read");
  close(fc.cpu.risk!.max!, 23);
  assert.deepEqual([fc.cpu.risk!.count, fc.cpu.risk!.of], [8, 255]);
  assert.ok(fc.fits);
  // before the fix: an upload part (the lab's CPU per GB over its requests per GB) is the most, no risk flagged
  const b = M.freeCheck({ ...solo, shareOriginals: true, previewPath: "before" }, {}, prices);
  close(b.cpu.worst!.ms, 381.9 / 126.7);
  assert.equal(b.cpu.risk, null);
});

test("the preview path: hand-computed requests and R2 operations, optimized against before the fix", () => {
  // team of 5: 5 × 10 h × 1,800 = 90,000 two-second segments a month, in 5 × 10 h × 60 / 2 min = 1,500 streams
  const s: Partial<Settings> = { ...M.PRESETS.team5.settings, clipMinutes: 2 };
  const opt = M.usage({ ...s, previewPath: "optimized" }, {});
  const old = M.usage({ ...s, previewPath: "before" }, {});
  close(opt.derived.segments, 90_000);
  close(opt.derived.streams, 1_500);
  // the release: one append a segment, plus a stream's lease and end; 7 setup requests a stream
  close(opt.derived.appendsPerSeg, 1);
  close(opt.derived.appends, 90_000 + 1_500 * 2);
  close(opt.activities.segments.workersReq, 90_000 + 1_500 * (2 + 7)); // 103,500
  // on the re-check's clip (40 segments a stream): (40 + 9) / 40 = 1.225 a segment, as the final runs counted (49)
  const clip = M.usage({ people: 1, footageHoursPerMonth: 80 / 3600, clipMinutes: 80 / 60, previewMbps: 2, segmentSeconds: 2, viewShare: 0 }, {});
  close(clip.activities.segments.workersReq / clip.derived.segments, 49 / 40);
  close(old.activities.segments.workersReq, 90_000 * 10 + 1_500 * 18); // 927,000
  close(opt.activities.segments.r2ClassB, 1_500 * 4); // 4 a stream
  close(old.activities.segments.r2ClassB, 90_000 * 4 + 1_500 * 9);
  close(opt.activities.segments.r2ClassA, 90_000 * 3 + 1_500 * 5); // the same writes on both paths
  close(old.activities.segments.r2ClassA, opt.activities.segments.r2ClassA);
  // shorter clips: more streams, more fixed costs
  const short = M.usage({ ...s, clipMinutes: 1 }, {});
  close(short.activities.segments.workersReq - opt.activities.segments.workersReq, 1_500 * (2 + 7)); // a stream's appends and setup
  // a segment over 1 MiB is read alone: 1080p (5 Mbit/s) in 6 s segments is 3.6 MiB
  assert.equal(M.usage({ ...s, previewMbps: 5, segmentSeconds: 6 }, {}).derived.segsPerRead, 1);
  // the bill: the fix makes the team-of-5 day fit Workers Free with room; before it, Worker requests ran out
  const free = M.freeCheck({ ...s, plan: "free" }, {}, prices);
  const freeOld = M.freeCheck({ ...s, plan: "free", previewPath: "before" }, {}, prices);
  assert.ok(free.fits && free.maxTeams >= 10);
  assert.equal(freeOld.checks.find((c) => c.key === "workersReq")!.maxTeams, 0);
  // with the write cap: one reserve a segment and 2 a stream (optimized: 42 for 40 segments), per write and 5 a stream (before)
  const capOpt = M.usage({ ...s, writeCap: true }, {});
  close(capOpt.activities.segments.doReq - opt.activities.segments.doReq, 90_000 + 1_500 * 2);
  const capOld = M.usage({ ...s, previewPath: "before", writeCap: true }, {});
  close(capOld.activities.segments.doReq - old.activities.segments.doReq, 90_000 * 3 + 1_500 * 5);
});

test("odd settings never throw or give a non-finite bill", () => {
  for (const s of [null, undefined, {}, { people: Number.MAX_VALUE }, { teams: Number.MAX_VALUE }, { footageHoursPerMonth: 1e300, shareOriginals: true, originalMbps: 1e300 }, { days: -5, hoursPerDay: Infinity, segmentSeconds: 0 }]) {
    const r = M.compute(s as never, { editDoReq: 1e300 }, prices);
    assert.ok(Number.isFinite(r.total) && Number.isFinite(r.perUser), JSON.stringify(s));
    assert.doesNotThrow(() => M.curve(s as never, undefined, prices));
  }
});

test("cursor updates: 1 a second from the Cardboard app by default, 10 from the web app", () => {
  const base: Partial<Settings> = { ...M.PRESETS.team5.settings };
  assert.equal(M.normalizeSettings(base).presenceRate, 1);
  const app = M.usage(base, {});
  const web = M.usage({ ...base, presenceRate: M.PRESENCE_RATES.web }, {});
  // 5 people × 20 days × 3 h × 3,600 s × 5% dragging × 1 a second = 54,000 frames a month
  close(app.derived.presenceMsgs, 54_000);
  close(web.derived.presenceMsgs, 540_000);
  close(web.activities.presence.doReqWs, 10 * app.activities.presence.doReqWs);
});

test("the daily write cap is off by default; on, it adds its counter's requests and rows", () => {
  const s: Partial<Settings> = { ...solo, shareOriginals: true, originalMbps: 100 };
  const off = M.usage(s, {});
  const on = M.usage({ ...s, writeCap: true }, {});
  assert.equal(off.activities.originals.doReq, 0); // gbDoReq is 0 for a default deployment
  close(on.activities.originals.doReq - off.activities.originals.doReq, off.derived.originalsGB * M.INPUT_DEFAULTS.writeCapDoReqPerGB);
  const reserves = off.derived.segments + off.derived.streams * 2; // the release: 1 a segment, 2 a stream
  close(on.activities.segments.doReq - off.activities.segments.doReq, reserves);
  close(on.activities.segments.doRowsWritten - off.activities.segments.doRowsWritten, reserves);
});

test("a newly shared project writes its one-off rows: the adoption, and 2 per person", () => {
  const s: Partial<Settings> = { people: 5, newProjectsPerMonth: 2, connectsPerDay: 0, hoursPerDay: 0, agentEditsPerDay: 0, footageHoursPerMonth: 0 };
  close(M.usage(s, only({ adoptRowsWritten: 64, replicaRowsWritten: 2 })).activities.connections.doRowsWritten, 2 * (64 + 5 * 2));
});

test("build-data: verdicts set each status; revised values replace the lab's; estimates are listed, never silent", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cost-build-"));
  const lab = (value: number, status = "measured") => ({ value, unit: "u", status, n: 3, min: value, max: value, runs: ["r1"], how: "how" });
  const measured = {
    schema: 1, generated: "2026-11-02T03:07:43Z", source: { commit: "3a02b402" },
    inputs: { editDoReq: lab(1.033), editRowsWritten: lab(1.188), gbWorkerCpuMs: lab(381.9), gbDoReq: lab(153.7), connGBs: lab(9, "estimated"), labOnly: lab(5) },
    speeds: [{ id: "sync-4g-5p-r2", what: "live sync", network: "4g", storage: "r2", parties: 5, metric: "convergence", p50: 154, p90: 167, p99: 255, unit: "ms", runs: 3, status: "measured" },
      { id: "sync-good-2p-nor2", what: "live sync", network: "good", storage: "nor2", parties: 2, metric: "convergence", p50: 103, p90: 110, p99: 123, unit: "ms", runs: 3, status: "measured" }],
    limits: [{ id: "worker-cpu-10ms", status: "measured", value: "10 ms", observed: "o", carton: "c", runs: [] }],
    networkProfiles: { good: "20 Mbit/s" },
  };
  const verified = {
    checked: { commit: "3a02b402" },
    inputs: {
      editDoReq: { verdict: "confirmed", theirs: 1.033, ours: 1, n: 9, min: 1, max: 1.033, note: "re-ran" },
      editRowsWritten: { verdict: "revised", theirs: 1.188, ours: 1.025, n: 9, min: 1.025, max: 1.025, note: "one-off rows per replica" },
      gbWorkerCpuMs: { verdict: "not-verified", theirs: 381.9, ours: null, n: 0, note: "no re-run" },
      gbDoReq: { verdict: "revised", theirs: 153.7, ours: 0, n: 0, note: "all write cap" },
    },
    speeds: {
      "sync-4g-5p-r2": { verdict: "confirmed", ours: { p50: 155, p90: 176, p99: 435 }, runs: 3, note: "p99 NOT confirmed: one retransmit" },
      "sync-good-2p-nor2": { verdict: "confirmed-from-data", ours: { p50: 103, p90: 110, p99: 123 }, runs: 3, note: "recomputed" },
    },
  };
  writeFileSync(join(dir, "m.json"), JSON.stringify(measured));
  writeFileSync(join(dir, "v.json"), JSON.stringify(verified));
  execFileSync(process.execPath, [site("build-data.mjs"), join(dir, "m.json"), site("prices.json"), "--verified", join(dir, "v.json"), "--out", join(dir, "d.json")], { stdio: "pipe" });
  const d = JSON.parse(readFileSync(join(dir, "d.json"), "utf8"));
  assert.equal(d.inputs.editDoReq.status, "verified");
  assert.equal(d.inputs.editDoReq.value, 1.033); // confirmed: the lab's value stands
  assert.equal(d.inputs.editRowsWritten.status, "verified");
  assert.equal(d.inputs.editRowsWritten.value, 1.025); // revised: the verifier's value…
  assert.equal(d.inputs.editRowsWritten.was, 1.188); // …and the lab's kept
  assert.equal(d.inputs.gbWorkerCpuMs.status, "measured");
  assert.equal(d.inputs.gbDoReq.value, 0);
  assert.equal(d.inputs.writeCapDoReqPerGB.value, 153.7); // the write cap's traffic, back for the setting
  assert.equal(d.inputs.connGBs.status, "estimated"); // the file says estimated: it stays visible as such
  assert.ok(d.estimatedInputs.includes("connGBs"));
  assert.ok(d.estimatedInputs.includes("pvSegWorkerReq")); // missing from the files: the model's figure, Estimated
  assert.equal(d.inputs.pvSegWorkerReq.source, "model");
  assert.deepEqual(d.extraInputs, ["labOnly"]);
  const s4g = d.speeds.find((x: { id: string }) => x.id === "sync-4g-5p-r2");
  assert.equal(s4g.status, "verified");
  assert.equal(s4g.unconfirmed.p99, "not confirmed (one slow edit decides it)");
  const sNor2 = d.speeds.find((x: { id: string }) => x.id === "sync-good-2p-nor2");
  assert.equal(sNor2.storage, "vault");
  assert.equal(sNor2.status, "verified");
  assert.ok(d.limits.some((l: { id: string }) => l.id === "do-object-storage")); // Cloudflare's documented limits are added
});

test("build-data: the preview-path re-check sets both paths' inputs, its speeds and the CPU line", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cost-build-pv-"));
  const measured = { schema: 1, generated: "2026-11-02T03:07:43Z", source: {}, inputs: {}, speeds: [], limits: [], networkProfiles: {} };
  const g = (x: object) => ({ good: x, "4g": x });
  const proxy = {
    meta: { verifier: "cf-verify2", at: "2026-11-02T09:05Z", subject: "fix/cf-proxy-path" },
    metrics: {
      "publish.workerRequestsPerSegment": g({ before: 10.45, after: 0.4, afterSmall: 0.55, verdict: "confirmed" }),
      "publish.r2ClassAPerSegment": g({ before: 3.125, after: 3.125, afterSmall: 3.125, verdict: "confirmed" }),
      "publish.r2ClassBPerSegment": g({ before: 4.225, after: 0.1, afterSmall: 0.1, verdict: "revised", claimed: { before: 4.05, after: 0.13 } }),
      "publish.writeCapDoRequestsPerSegment": g({ before: 3.125, after: 0.25, afterSmall: 0.4, verdict: "confirmed" }),
      "publish.workerCpuMsPerSegment": g({ before: 23.78, beforeRange: [22.85, 27.59], after: 2.85, afterFinalBuild: 4.93, afterSmall: 4.01, afterSmallRange: [3.83, 4.19], verdict: "revised", claimed: { before: 18.41, after: 2.67 } }),
      "publish.speedXRealTime": { good: { before: 0.47, beforeRuns: [0.46, 0.47], after: 3.51, afterRuns: [3.37, 3.93], afterSmall: 2.58, afterSmallRuns: [2.57, 2.59], verdict: "confirmed" } },
      "play.workerRequestsPerMiB": g({ before: 9.87, after: 0.32, afterSmall: 0.59, verdict: "confirmed" }),
      "play.r2ClassBPerMiB": g({ before: 9.83, after: 3.63, afterSmall: 3.95, verdict: "confirmed" }),
      "play.workerCpuMsPerMiB": g({ before: 13.02, beforeRange: [12.08, 13.52], after: 2.62, afterSmall: 3.38, afterSmallRange: [2.93, 3.83], verdict: "revised", claimed: { before: 8.59, after: 2.21 } }),
      "cpu.perRequestMs": {
        append: { finalBuild_4parts2MiB: { n: 25, p50: 9.14, p90: 14.94, max: 20.55, mean: 9.76, over10ms: 10 }, finalBuild_1part: { n: 15, range: [3.01, 7.25] } },
        read: { finalBuild_2MiB: { n: 30, p50: 5.99, max: 9.15, mean: 5.7, over10ms: 0 } },
        exceededCpuOr1102: { count: 0 },
      },
    },
  };
  writeFileSync(join(dir, "m.json"), JSON.stringify(measured));
  writeFileSync(join(dir, "p.json"), JSON.stringify(proxy));
  const final = {
    runs: {
      r1: { publish_x: 1.521, play_x: 1.63, live_first_ms: 9571, append_cpu: { tail: { n: 42, max: 16, ge10: 1 }, exact: { p50: 3.915, max: 16.113 } }, read_cpu: { tail: { n: 43, max: 23, ge10: 2 }, exact: { p50: 3.182, max: 6.304 } } },
      r2: { publish_x: 1.545, play_x: 1.32, live_first_ms: 8684, append_cpu: { tail: { n: 42, max: 12, ge10: 2 }, exact: { p50: 5.264, max: 12.841 } }, read_cpu: { tail: { n: 43, max: 13, ge10: 1 }, exact: { p50: 3.724, max: 13.349 } } },
      cv4: { publish_x: 1.499, play_x: 1.373, live_first_ms: 9503, append_cpu: { tail: { n: 42, max: 10, ge10: 1 }, exact: { p50: 3.709, max: 10.599 } }, read_cpu: { tail: { n: 43, max: 10, ge10: 1 }, exact: { p50: 2.807, max: 5.4 } } },
    },
    no_1102: { verdict: "confirmed" },
  };
  writeFileSync(join(dir, "f.json"), JSON.stringify(final));
  const release = fileURLToPath(new URL("../bench/cost/proxy-release.json", import.meta.url));
  execFileSync(process.execPath, [site("build-data.mjs"), join(dir, "m.json"), site("prices.json"), "--proxy-verified", join(dir, "p.json"), "--proxy-release", release, "--proxy-final", join(dir, "f.json"), "--out", join(dir, "d.json")], { stdio: "pipe" });
  const d = JSON.parse(readFileSync(join(dir, "d.json"), "utf8"));
  const i = d.inputs;
  // before: 418 requests a stream = 10 a segment + 18; 169 Class B = 4 + 9; revised CPU keeps the claim
  assert.deepEqual([i.pvSegWorkerReq.value, i.pvStreamWorkerReq.value, i.pvSegClassB.value, i.pvStreamClassB.value], [10, 18, 4, 9]);
  assert.equal(i.pvSegWorkerReq.status, "verified");
  assert.equal(i.pvSegCpuMs.value, 23.78);
  assert.equal(i.pvSegCpuMs.was, 18.41);
  // the release: 1 append a segment + 2 a stream (42 for 40), 7 setup requests, 42 write-cap reserves, 41 reads
  assert.deepEqual([i.pvoAppendsPerSeg.value, i.pvoStreamAppends.value, i.pvoStreamWorkerReq.value, i.pvoStreamClassB.value], [1, 2, 7, 4]);
  assert.deepEqual([i.pvoSegCapReserves.value, i.pvoStreamCapReserves.value, i.pvoStreamReads.value], [1, 2, 1]);
  assert.equal(i.pvoAppendsPerSeg.status, "verified");
  // per-segment CPU: the median of cf-verify3's 4 runs; per read: its CPU per MiB over its reads per MiB
  assert.equal(i.pvoSegCpuMs.value, 4.905);
  close(i.pvoReadCpuMs.value, 5.375 / 1.58);
  // per-request CPU from cf-verify4: typical append 3.915 ms, slowest read 23 ms, 8 of 255 at or over 10 ms
  assert.deepEqual([i.pvoAppendCpuMsTypical.value, i.pvoReadCpuMsMax.value, i.pvoOver10Count.value, i.pvoOver10Of.value], [3.915, 23, 8, 255]);
  assert.equal(i.pvoOver10Count.status, "verified");
  assert.deepEqual([i.pubSegClassA.value, i.pubStreamClassA.value], [3, 5]);
  // speeds: before Verified; the release on 4G Verified (cf-verify4); the good link local-only, Measured
  const sp = Object.fromEntries(d.speeds.map((x: { id: string }) => [x.id, x]));
  assert.equal(sp["pvpublish-good-before"].status, "verified");
  assert.equal(sp["pvpublish-4g-release"].status, "verified");
  assert.equal(sp["pvpublish-4g-release"].p50, 1.521);
  assert.equal(sp["pvplay-4g-release"].p50, 1.373);
  assert.equal(sp["pvlive-4g-release"].p50, 9503);
  assert.equal(sp["pvpublish-good-release-local"].status, "measured");
  assert.equal(sp["pvpublish-good-release-pretail"].p50, 1.75);
  assert.equal(sp["pvpublish-4g-release"].unit, "x");
  assert.equal(d.limits[0].id, "worker-cpu-10ms-preview");
  assert.match(d.limits[0].observed, /8 of 255 were at or over 10 ms \(max 23 ms\), and none were refused/);
});
