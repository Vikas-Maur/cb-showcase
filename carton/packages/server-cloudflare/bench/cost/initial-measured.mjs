// Makes the cost calculator's first measured.json (site/cost/) from the cf-lab run records of 2026-11-01, until the
// lab's own `carton/bench/cloudflare/results/measured.json` (branch lab/cloudflare) replaces it. Per-edit costs are
// medians of the clean good-profile live-sync runs (read back from Cloudflare's analytics, `*.cost.json`); everything
// else the lab hadn't measured yet is an estimate from the code and Cloudflare's docs, and says so. No number here was
// re-checked by a second run (AGENTS.md rule 6), so nothing is "verified".
//
//   node bench/cost/initial-measured.mjs <runsDir> [--until <ISO>] > bench/cost/measured.initial.json
//
// Only the runs of CF-REPORT.md: a run id ends in its start time (Date.now() in base 36), and runs started after
// --until (default 2026-11-01T19:05Z, the report's end) are left out, so the lab's later runs in the same folder don't
// change this file. Cost re-reads (`*.cost.json`, `*.c2.json`) aren't runs.
//   node site/cost/build-data.mjs bench/cost/measured.initial.json            (from packages/server-cloudflare)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const untilAt = args.indexOf("--until");
const until = Date.parse(untilAt >= 0 ? args.splice(untilAt, 2)[1] : "2026-11-01T19:05:00Z");
const dir = args[0];
if (!dir || !existsSync(dir) || !Number.isFinite(until)) {
  console.error("usage: node initial-measured.mjs <runsDir> [--until <ISO>]");
  process.exit(2);
}
const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const RUN = /^(sync|media|limits|refused)-.+-([a-z0-9]{8})\.json$/;
const files = readdirSync(dir)
  .filter((f) => RUN.test(f) && parseInt(RUN.exec(f)[2], 36) <= until)
  .sort();
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// sync-<host>-<profile>[-<chaos>]-<N>p-r<rep>[-<tag>]-<id>
const SYNC = /^sync-(r2|nor2)-(none|good|4g|3g|bad)(?:-(flap|outage))?-(\d+)p-r(\d+)(?:-(.+))?-([a-z0-9]{8})$/;
const sync = [];
for (const f of files.filter((f) => f.startsWith("sync-"))) {
  const id = basename(f, ".json");
  const m = SYNC.exec(id);
  if (!m) continue;
  const run = read(f);
  const costFile = `${id}.cost.json`;
  const cost = existsSync(join(dir, costFile)) ? read(costFile) : null;
  sync.push({ id, host: m[1], profile: m[2], chaos: m[3] ?? null, parties: Number(m[4]), tag: m[6] ?? null, run, cost });
}

// ---- per-edit inputs: good profile, no chaos, real runs (not the smoke runs), both hosts. The 3g/4g runs overlapped
// another runner, so their cost columns may be mis-attributed (CF-REPORT) and are left out.
const clean = sync.filter((s) => s.profile === "good" && !s.chaos && !s.tag && s.cost);
const per = (fn) => clean.map(fn);
const input = (values, unit, how, status = "measured") => ({
  value: round(median(values), 5),
  unit,
  status,
  n: values.length,
  min: round(Math.min(...values), 5),
  max: round(Math.max(...values), 5),
  runs: clean.map((s) => s.id),
  how,
});
const est = (value, unit, how) => ({ value, unit, status: "estimated", how });

const inputs = {
  editDoReq: input(per((s) => s.cost.per.doRequestsPerEdit), "DO requests per edit",
    "Cloudflare's analytics for the room, divided by the edits in the run; includes each party's connect and the room's alarms, so it slightly over-counts."),
  editRowsWritten: input(per((s) => s.cost.per.rowsWrittenPerEdit), "rows written per edit",
    "Rows the room wrote (Cloudflare's analytics), divided by the edits in the run."),
  editRowsRead: input(per((s) => s.cost.per.rowsReadPerEdit), "rows read per edit",
    "Rows the room read (Cloudflare's analytics), divided by the edits in the run."),
  editGBs: input(per((s) => s.cost.per.gbSeconds / s.run.commits), "GB-s per edit",
    "The room's active time in the run (Cloudflare's analytics) × 128 MB, divided by the edits; the room hibernates between messages."),
  editWorkerCpuMs: est(0, "Worker CPU ms per edit", "Edits travel over the open WebSocket straight to the room: no Worker runs for them."),
  editArchiveRowsWritten: est(1, "rows written per edit", "Once a project passes 10,000 changes, each old change is moved to a compressed archive file and its row deleted; Cloudflare bills a delete as a row written."),
  connWorkerReq: est(1, "Worker requests per connect", "One Worker request: the WebSocket upgrade, after the token check."),
  connWorkerCpuMs: est(3, "Worker CPU ms per connect", "The Worker's median CPU per request in the live-sync runs was about 3 ms (token check and hand-off to the room)."),
  connDoReq: est(1, "DO requests per connect", "Cloudflare: \"A request is needed to create a WebSocket connection.\" Billed in full, not 20:1."),
  connRowsWritten: est(2, "rows written per connect", "A hello arms the room's upkeep alarm: its due time is one row, and Cloudflare bills each setAlarm as one row written."),
  connGBs: est(0.002, "GB-s per connect", "A hello wakes the room for about as long as an edit does (≈ 15 ms × 128 MB)."),
  connRowsRead: est(20, "rows read per connect", "The hello reads the project's branches, people and the changes the client missed; a short absence reads a few dozen rows."),
  presenceMsgPerSecWhileDragging: est(10, "messages a second", "Carton's client sends at most 10 presence messages a second (PRESENCE_PER_SEC); the Cardboard app's pages send at most 1 a second while you click or type, so 10 is the upper bound."),
  presenceDoReq: est(1, "DO requests per message", "Each presence message is one incoming WebSocket message to the room; it's relayed to the others and never stored."),
  presenceGBs: est(0.0002, "GB-s per message", "About 1.6 ms of room time per message (no storage write) × 128 MB."),
  presenceAlarmPerHour: est(60, "alarms an hour", "While someone shows presence, the room checks every 60 s (half the 120 s timeout) for sockets gone silent; counted per person-hour, an upper bound when teammates overlap."),
  upkeepAlarmPerHour: est(1, "alarms an hour", "The room's upkeep (archiving old changes, sweeping expired envelopes) is due an hour after an edit or a hello, so at most one an editing hour per project."),
  alarmRowsWritten: est(1, "rows written per alarm", "Cloudflare bills each setAlarm() as one row written."),
  alarmGBs: est(0.0003, "GB-s per alarm", "An alarm wakes the room for a few milliseconds × 128 MB."),
  idleDoReqPerHour: est(0, "DO requests an hour", "Keepalive pings are answered by Cloudflare's auto-response without waking the room, and Cloudflare's pricing page says those aren't charged."),
  idleGBsPerHour: est(0, "GB-s an hour", "An idle room hibernates; Cloudflare doesn't bill duration while it does."),
  idleRowsWrittenPerHour: est(0, "rows written an hour", "Nothing is stored while nobody edits."),
  gbWorkerReq: est(140, "Worker requests per GB", "8 MiB parts: 128 part uploads plus the checks, manifest, start and finish of the upload."),
  gbWorkerCpuMs: est(840, "Worker CPU ms per GB", "After fix/cf-stream-parts the lab measured 3–9 ms of CPU per part (32 parts, one 256 MB run): about 6 ms × 140 requests. Before the fix: 61–359 ms per part."),
  gbR2ClassA: est(520, "Class A per GB", "Per 8 MiB part: the upload itself and three small records (lock, marker, release); plus starting and finishing the upload."),
  gbR2ClassB: est(130, "Class B per GB", "About one read per part (the upload's lock), plus the checks before it starts."),
  gbDoReq: est(0, "DO requests per GB", "None with R2. With the optional daily write cap switched on, one per part (its counter)."),
  gbVaultDoReq: est(260, "DO requests per GB", "Without R2, each part goes to the vault Durable Object, plus the copy when the upload finishes."),
  gbVaultRowsWritten: est(3072, "rows written per GB", "The vault stores 1 MiB per row: each MiB written as a part, copied once when the upload completes, and the part rows deleted."),
  gbVaultGBs: est(30, "GB-s per GB", "The vault was active about 26 s for a 100 MB upload on the good profile (Cloudflare's analytics, one run)."),
  segWorkerReq: est(6, "Worker requests per segment", "Per preview segment the client checks the object, any damage report and the manifest, then writes the manifest, the bytes and the stream's list entry (upload.ts, stream.ts)."),
  segWorkerCpuMs: est(2, "Worker CPU ms per segment", "Small requests that stream through: about 2 ms in all (estimate)."),
  segR2ClassA: est(3, "Class A per segment", "Three writes per segment: the manifest, the bytes and the list entry."),
  segR2ClassB: est(3, "Class B per segment", "Three checks per segment: the object, a damage report and the manifest."),
  segVaultDoReq: est(6, "DO requests per segment", "Without R2, each of the segment's six calls is a request to the vault."),
  segVaultRowsWritten: est(4, "rows written per segment", "The bytes (one 1 MiB row), the manifest, the list entry and the object's record."),
  viewWorkerReqPerMiB: est(4.2, "Worker requests per MiB", "A teammate reads each 2 s segment (≈ 0.48 MiB at 2 Mbit/s) and its list entry: two requests per segment. Played media is cached on their disk, so replays are free."),
  viewClassBPerMiB: est(4.2, "Class B per MiB", "One R2 read per request."),
  viewWorkerCpuMsPerMiB: est(6, "Worker CPU ms per MiB", "About 1.5 ms per streamed read (estimate)."),
  viewVaultRowsReadPerMiB: est(2.1, "rows read per MiB", "Without R2, the vault reads one 1 MiB row per segment."),
  viewVaultGBsPerMiB: est(0.01, "GB-s per MiB", "Without R2, the vault is awake about 80 ms per MiB it serves (estimate)."),
  changeBytes: est(600, "bytes per stored change", "A change row in the room's database until it's archived; the newest 10,000 stay in the room."),
};

// ---- speeds
const storageOf = (host) => (host === "r2" ? "r2" : "vault");
const speeds = [];
const groups = new Map();
for (const s of sync) {
  if (s.tag && (s.tag.startsWith("smoke") || s.tag.startsWith("smoke-"))) continue;
  if (s.profile === "none") continue;
  const kind = s.chaos ?? "sync";
  const key = `${kind}-${s.profile}-${s.parties}p-${storageOf(s.host)}${s.tag ? `-${s.tag}` : ""}`;
  if (!groups.has(key)) groups.set(key, { s, runs: [] });
  groups.get(key).runs.push(s);
}
const WHAT = {
  sync: "live sync: an edit visible to every party",
  flap: "flapping link (5 s down every 30 s): an edit visible to every party",
  outage: "5-minute outage: an edit made offline visible to every party",
};
for (const [id, { s, runs }] of groups) {
  const c = (k) => median(runs.map((r) => r.run.convergenceMs[k]));
  const note = [];
  if (s.tag === "old") note.push("old client (before fix/cf-dead-link)");
  if (s.tag === "fixed") note.push("client with fix/cf-dead-link");
  if (s.tag === "baseline-old-client") note.push("old client: never noticed the link was dead and resumed on TCP's retransmission timer; the fixed client's outage runs weren't run yet");
  if (s.profile === "3g" || s.profile === "4g") note.push("one run only");
  speeds.push({
    id,
    what: WHAT[s.chaos ?? "sync"],
    network: s.profile,
    storage: storageOf(s.host),
    parties: s.parties,
    sizeMB: null,
    metric: "convergence",
    p50: Math.round(c("p50")),
    p90: Math.round(c("p90")),
    p99: Math.round(c("p99")),
    unit: "ms",
    runs: runs.length,
    status: "measured",
    note: note.join("; "),
    runIds: runs.map((r) => r.id),
  });
}

// media: one run per row, so p50 = p90 = the run's own number
for (const f of files.filter((f) => f.startsWith("media-"))) {
  const id = basename(f, ".json");
  const r = read(f);
  if (/tune|tail/.test(id)) continue; // part-size tuning runs: in the report, not a user scenario
  const storage = storageOf(r.host);
  const mb = Math.round(r.size / 1e6);
  const before = !/streamfix/.test(id) && r.size > 300e6;
  const sessions = r.upload?.sessions ?? [];
  const failed = sessions.filter((x) => x.failed).length;
  const done = r.upload?.result && !r.upload.result.deduped ? true : r.upload?.result?.deduped && r.upload.result.resumedParts > 0;
  const capped = sessions.some((x) => x.failed?.code === "DailyWriteCap");
  if (!capped && !/resume-kill/.test(id)) {
    const ok = r.upload?.result != null;
    speeds.push({
      id: `upload-${r.profile}-${mb}MB-${storage}${before ? "-before-fix" : ""}`,
      what: "upload: sharing a file until teammates can fetch it",
      network: r.profile,
      storage,
      parties: null,
      sizeMB: mb,
      metric: "duration",
      p50: ok ? Math.round(r.upload.ms) : null,
      p90: ok ? Math.round(r.upload.ms) : null,
      p99: null,
      unit: "ms",
      runs: 1,
      status: "measured",
      note: ok
        ? `${r.upload.mbps.toFixed(1)} Mbit/s${failed ? `; finished only after ${sessions.length} sessions (${failed} stopped by error 1102, before fix/cf-stream-parts)` : ""}${/streamfix/.test(id) ? "; with fix/cf-stream-parts" : ""}`
        : `never completed: every session ended with error 1102 (CPU limit), before fix/cf-stream-parts`,
      runIds: [id],
    });
    void done;
  }
  if (r.preview?.totalMs) {
    speeds.push({
      id: `preview-${r.profile}-${storage}-${id.slice(-8)}`,
      what: "time until a teammate can preview (the first 2 s proxy segment)",
      network: r.profile,
      storage,
      parties: 2,
      sizeMB: Math.round(r.preview.segmentBytes / 1e4) / 100,
      metric: "duration",
      p50: Math.round(r.preview.totalMs),
      p90: Math.round(r.preview.totalMs),
      p99: null,
      unit: "ms",
      runs: 1,
      status: "measured",
      note: `uploader's PUT ${Math.round(r.preview.uploadMs)} ms, teammate's fetch ${Math.round(r.preview.teammateFetchMs)} ms`,
      runIds: [id],
    });
  }
  if (r.download?.profile) {
    const ok = r.download.mbps != null;
    // the lab's slow-profile download fetched 5 MB (media.ts --download 5M); a full one records its bytes
    const dlMB = Math.round((r.download.bytes ?? 5 * 2 ** 20) / 1e6);
    speeds.push({
      id: `download-${r.download.profile}-${dlMB}MB-${storage}`,
      what: "download: a teammate fetching a shared file",
      network: r.download.profile,
      storage,
      parties: null,
      sizeMB: dlMB,
      metric: "duration",
      p50: ok ? Math.round(r.download.ms) : null,
      p90: ok ? Math.round(r.download.ms) : null,
      p99: null,
      unit: "ms",
      runs: 1,
      status: "measured",
      note: ok ? `${r.download.mbps.toFixed(1)} Mbit/s; first byte after ${(r.download.firstMs / 1000).toFixed(1)} s` : "failed: the request timed out (the lab's ranged download has no retry)",
      runIds: [id],
    });
  }
}
// dedupe preview rows per (network, storage): keep the first, count runs
const seen = new Map();
for (const s of speeds.filter((x) => x.id.startsWith("preview-"))) {
  const k = `${s.network}-${s.storage}`;
  if (!seen.has(k)) seen.set(k, []);
  seen.get(k).push(s);
}
for (const [k, list] of seen) {
  const keep = list[0];
  keep.id = `preview-${k}`;
  keep.p50 = Math.round(median(list.map((x) => x.p50)));
  keep.p90 = Math.max(...list.map((x) => x.p90));
  keep.runs = list.length;
  keep.runIds = list.flatMap((x) => x.runIds);
  if (list.length > 1) keep.note = `${list.length} runs`;
  for (const x of list.slice(1)) speeds.splice(speeds.indexOf(x), 1);
}

const refused = files.find((f) => f.startsWith("refused-"));
const refusedRun = refused ? read(refused) : null;

const limits = [
  { id: "worker-cpu-10ms", status: "measured", value: "10 ms of CPU per request on Workers Free (5 minutes on Paid)",
    observed: "Upload parts were read whole into memory: 61–359 ms of CPU each. After a burst Cloudflare stopped them with error 1102 (HTTP 503), so a 1 GB upload never finished. With fix/cf-stream-parts: 3–9 ms per part, 32 of 32 parts ok.",
    carton: "A clear error, 4 retries with backoff, then a stop the upload can resume from. The fix streams each part straight to storage (branch fix/cf-stream-parts, not yet merged).",
    runs: ["media-r2-1G-none-mvy6i8d7", "media-r2-256M-none-streamfix-mvy709f7"] },
  { id: "worker-memory-128mb", status: "measured", value: "128 MB of memory per Worker isolate",
    observed: "A 96 MiB part failed (HTTP 503) while another upload shared the isolate; a 99 MiB part alone passed.",
    carton: "The same retry path. Streaming parts (fix/cf-stream-parts) never holds a part in memory.",
    runs: ["limits-r2-body-96MiB-mvy6m258", "limits-r2-body-99MiB-mvy6mfbr"] },
  { id: "request-body-100mb", status: "measured", value: "100 MB per request body (Free and Pro plans)",
    observed: "A 101 MiB part was refused at Cloudflare's edge with HTTP 413; 64, 96 and 99 MiB passed.",
    carton: "Upload parts are 8–64 MiB, so a file would need to be over 640 GiB (10,000 parts) to come near it.",
    runs: ["limits-r2-body-101MiB-mvy6mqxe", "limits-r2-body-64MiB-mvy6lrsn", "limits-r2-body-99MiB-mvy6mfbr"] },
  { id: "ws-message-32mib", status: "measured", value: "32 MiB per incoming WebSocket message",
    observed: "A raw 33 MiB frame: Cloudflare closed the socket (code 1009). The room closes 1009 above its own 24 MiB cap.",
    carton: "Changes over 1 MiB travel as uploaded envelopes (5 MiB: 2.0–3.5 s, 20 MiB: 3.9–5.1 s). A 30 MiB change is refused on your machine as \"too large\" in 215 ms, and the next edit still goes through.",
    runs: ["limits-r2-frame-33MiB-mvy6py7c", "limits-r2-change-20MiB-mvy6njph", "limits-r2-change-30MiB-mvy6ns89"] },
  { id: "subrequests", status: "measured", value: "50 subrequests per request on Free (1,000 to Cloudflare's own services); 10,000 on Paid",
    observed: "R2 calls count against the 1,000, not the 50. Checking 200 files at once worked (4.1 s); asked for 1,000, the server answered 200 per call (9.4 s).",
    carton: "The server checks at most 200 files per request (BLOB_HEADS_PER_REQUEST) and the client asks again for the rest.",
    runs: ["limits-r2-heads-200-mvy6l2ig", "limits-r2-heads-1000-mvy6lh4l"] },
  { id: "do-value-2mb", status: "documented", value: "2 MB per database row in a Durable Object",
    observed: "Not hit: the vault stores media in 1 MiB rows.",
    carton: "Media without R2 is cut into 1 MiB rows; changes over 1 MiB go as envelopes.", runs: [] },
  { id: "daily-workers-requests", status: "documented", value: "100,000 Worker requests a day on Free (resets 00:00 UTC)",
    observed: refusedRun
      ? `Not tested directly (it needed a late-night window and approval). A client whose session was refused retried ${refusedRun.perMinute} times a minute, about 2 requests per try: ≈ 245,000 a day from one stuck client, 2.5× the limit.`
      : "Not tested directly.",
    carton: "Past it, Cloudflare answers error 1027 until midnight UTC and nobody can connect. fix/cf-reconnect-backoff slows retries to 15 s, or 5 minutes while the session is refused (not yet merged).",
    runs: refused ? [basename(refused, ".json")] : [] },
  { id: "daily-do-requests", status: "documented", value: "100,000 Durable Object requests a day on Free",
    observed: "Not tested (the lab stayed under 50% of every daily limit; it used 5,409 on its busiest day).",
    carton: "Past it, edits and uploads fail until midnight UTC; Carton keeps them on your machine and sends them when it can.", runs: [] },
  { id: "daily-do-duration", status: "documented", value: "13,000 GB-s of Durable Object time a day on Free",
    observed: "Not tested (the lab used 28 GB-s on its busiest day).", carton: "As above: requests fail until midnight UTC.", runs: [] },
  { id: "daily-rows-written", status: "documented", value: "100,000 rows written a day on Free (5 million read)",
    observed: "Not tested (the lab wrote 14,983 rows on its busiest day).",
    carton: "The room archives old changes in batches from an alarm, never on an edit, because each archived row costs one more row written.", runs: [] },
  { id: "do-storage-5gb", status: "documented", value: "5 GB of Durable Object storage in total on Free",
    observed: "Not hit (12.7 MB used). The vault has no sweep for abandoned uploads, so their parts stay and count against it.",
    carton: "Without R2, all media sits in Durable Objects, so a solo editor's footage alone can pass 5 GB. Keep media in R2.", runs: [] },
  { id: "r2-free-monthly", status: "documented", value: "R2: 10 GB-month of storage, 1 million Class A and 10 million Class B a month free",
    observed: "The lab used 993 Class A and 698 Class B this month. A bucket lifecycle rule deletes test files and aborts unfinished uploads after a day.",
    carton: "Past it, R2 bills (it never stops). Its free amounts are monthly, not daily.", runs: [] },
  { id: "dead-link", status: "measured", value: "Not a Cloudflare limit: a link that dies without closing",
    observed: "Through a 5-minute outage the socket stayed \"open\": status \"Syncing\", no offline event. 66 edits made offline, 0 lost; they all arrived 66.5 s after the link came back, on TCP's retransmission timer.",
    carton: "fix/cf-dead-link closes a link whose keepalive goes unanswered for 15 s, so the app shows offline and reconnects at once (not yet merged).",
    runs: ["sync-r2-good-outage-2p-r1-baseline-old-client-mvy5o78o"] },
];

const out = {
  schema: 1,
  generated: new Date().toISOString(),
  source: {
    branch: "lab/cloudflare",
    commit: "716af880",
    runsDir: "_inspect/carton-build/cf-lab/runs",
    note: "Initial file made by bench/cost/initial-measured.mjs from the 2026-11-01 runs (CF-REPORT.md); none re-checked yet.",
  },
  inputs,
  speeds,
  limits,
  networkProfiles: {
    none: "Unshaped: the lab's server in Mumbai, 1–2 ms from Cloudflare's edge",
    good: "20 Mbit/s each way, 30 ms round trip, no loss",
    "4g": "5 Mbit/s, 80 ms round trip, 0.5% packet loss",
    "3g": "1 Mbit/s, 200 ms round trip, 1% packet loss",
    bad: "256 kbit/s, 400 ms round trip (± 50 ms jitter), 3% packet loss",
  },
};
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
