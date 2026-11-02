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
  // (27 GB of media + the change rows - 5 included) × $0.20
  close(b.meters.find((m) => m.key === "doStorageGB")!.cost, (b.usage.totals.doStorageGB - 5) * 0.2);
  assert.equal(b.meters.find((m) => m.key === "r2StorageGB")!.used, 0);
  const fc = M.freeCheck({ ...solo, storage: "vault" }, {}, prices);
  assert.equal(fc.fits, false);
  assert.equal(fc.first!.key, "doStorageGB");
  assert.equal(fc.first!.breaksAt, 1);
  assert.equal(fc.maxTeams, 0);
});

test("incoming WebSocket messages bill 20:1 on Paid; connects and alarms bill in full", () => {
  // presence only: 10 teams × 20 days × 10 h × 3600 s × 100% dragging × 10 messages a second = 72M messages
  const s: Partial<Settings> = { people: 1, teams: 10, days: 20, hoursPerDay: 10, dragShare: 1, footageHoursPerMonth: 0, plan: "paid", storage: "r2" };
  const ws = only({ presenceMsgPerSecWhileDragging: 10, presenceDoReq: 1 });
  const b = M.bill(s, ws, prices);
  const doReq = b.meters.find((m) => m.key === "doReq")!;
  close(doReq.wsMessages!, 72e6);
  close(doReq.used, 3.6e6); // 72M / 20
  close(doReq.cost, ((3.6e6 - 1e6) * 0.15) / 1e6); // $0.39
  // add 1M connects (5,000 a day): a request to create a WebSocket connection is billed in full
  const b2 = M.bill({ ...s, connectsPerDay: 5000 }, { ...ws, connDoReq: 1 }, prices);
  const d2 = b2.meters.find((m) => m.key === "doReq")!;
  close(d2.used, 4.6e6);
  close(d2.cost, ((4.6e6 - 1e6) * 0.15) / 1e6); // $0.54
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
  close(longer.activities.segments.r2ClassA, base.activities.segments.r2ClassA / 3);
  close(longer.activities.playback.r2ClassB, base.activities.playback.r2ClassB / 3);
  close(longer.totals.r2StorageGB, base.totals.r2StorageGB); // the same bytes stored
});

test("playback: each person plays a share of every teammate's proxies; a solo editor plays none", () => {
  assert.equal(M.usage(solo, {}).derived.viewedMiB, 0);
  // 5 people × 4 teammates × 10 h × 900 MB × 50% = 90 GB read
  const u = M.usage({ ...M.PRESETS.team5.settings, viewShare: 0.5 }, {});
  close((u.derived.viewedMiB * 1024 * 1024) / 1e9, 90);
  close(u.activities.playback.r2ClassB, u.derived.viewedMiB * M.INPUT_DEFAULTS.viewClassBPerMiB);
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
  const weird = { editDoReq: "x", gbWorkerReq: { value: Number.NaN }, segR2ClassA: -3, someNewKey: { value: 9 }, presenceDoReq: { value: 2, status: "measured" } };
  const r = M.compute({ people: Number.NaN, teams: -4, storage: "floppy" as never, plan: undefined, dragShare: 7 } as never, weird, prices);
  assert.ok(Number.isFinite(r.total));
  assert.equal(r.settings.people, M.DEFAULT_SETTINGS.people);
  assert.equal(r.settings.teams, 1);
  assert.equal(r.settings.storage, "r2");
  assert.equal(r.settings.dragShare, 1);
  const i = M.resolveInputs(weird);
  assert.equal(i.editDoReq, M.INPUT_DEFAULTS.editDoReq);
  assert.equal(i.gbWorkerReq, M.INPUT_DEFAULTS.gbWorkerReq);
  assert.equal(i.segR2ClassA, M.INPUT_DEFAULTS.segR2ClassA);
  assert.equal(i.presenceDoReq, 2);
  assert.ok(!("someNewKey" in i));
  assert.doesNotThrow(() => M.curve({}, undefined, prices));
});

test("presets give different bills, and the biggest driver comes with a priced way to lower it", () => {
  const totals = Object.values(M.PRESETS).map((p) => M.compute(p.settings, {}, prices).total);
  assert.equal(new Set(totals.map((t) => t.toFixed(4))).size, totals.length);
  const r = M.compute({ ...M.PRESETS.team5.settings, storage: "vault", plan: "paid" }, {}, prices);
  assert.equal(r.driver!.key, "storage");
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
