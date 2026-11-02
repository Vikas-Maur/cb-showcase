// Every plain-words explanation on /cost/: the "?" tooltips for settings, bill lines, Cloudflare's meters, limits,
// metrics, network profiles and status badges, and the glossary. Written for a smart reader who isn't a cloud engineer:
// what it is, then one example or consequence.

export const STATUS = {
  verified: { label: "Verified", tip: "Re-checked by a second, independent run, which got the same answer." },
  measured: { label: "Measured", tip: "From our lab's runs against real Cloudflare deployments, read back from Cloudflare's own analytics. Not yet re-checked by a second run." },
  estimated: { label: "Estimated", tip: "Worked out from Carton's code and Cloudflare's docs, not measured yet. The lab is measuring it; the page updates when it lands." },
  assumed: { label: "Assumed", tip: "A usage setting: how you or your team would work. Change it to match yours." },
  documented: { label: "Documented", tip: "Cloudflare's published limit. The lab didn't push past it (it stayed under half of every daily limit), so this is what the docs say, not what we saw." },
  missing: { label: "Not measured", tip: "The measurement file has no value for this. The calculator uses the model's built-in estimate instead, shown here." },
};

export const SETTINGS = {
  people: "How many people share one project and edit it together. A team works in one live room, so a bigger team means more messages per room and more of teammates' footage to watch.",
  teams: "How many separate teams run on the same Cloudflare account. Cloudflare's free amounts and limits are per account, so every team shares them: 3 teams of 5 use the Free plan's daily allowance three times as fast.",
  days: "Days a month people edit. Workers Free's limits are per day, so the month's use is spread over these days: the same work in fewer days hits a daily limit sooner.",
  hoursPerDay: "Hours a day each person is editing in the shared project. Live edits, cursor sharing and the room's minute checks happen during these hours.",
  idleHoursPerDay: "Hours a day the project stays open with nobody editing, like Cardboard left open over lunch. The connection stays up with a small keepalive every 25 s, which Cloudflare answers without waking the room, so this should cost close to nothing.",
  savesPerMinute: "How often a person's changes are sent while they edit. Cardboard groups your changes into saves; each save is one message to the project's room. 2 a minute is a steady pace.",
  agentEditsPerDay: "Edits AI agents make for each person a day: the Director, subagents, Claude Code. Each one reaches the room exactly like a person's save.",
  dragShare: "The share of editing time someone drags the playhead or a clip. While they drag, Carton sends their cursor and playhead to teammates up to 10 times a second. 5% is about 9 minutes of a 3-hour session.",
  connectsPerDay: "How often a person's app connects to the project a day: opening it, waking the laptop, changing Wi-Fi. Each connect costs one Worker request and one full-price Durable Object request.",
  footageHoursPerMonth: "Hours of new footage each person adds to the shared project a month. Carton uploads a small preview copy of each clip (the proxy) so teammates can watch it without the original.",
  previewMbps: "How sharp the preview copy is. Carton encodes 720p at about 2 Mbit/s today, about 0.9 GB an hour of footage. A sharper preview means more to upload, store and read; the other choices show what that would cost.",
  shareOriginals: "Also upload the camera originals, the full-quality files. Off by default in Carton: originals only move when the owner opts in or a teammate asks. They're large: 4K at 100 Mbit/s is about 45 GB an hour.",
  originalMbps: "The camera files' bitrate: how much data a second of footage takes. Phones record 4K at about 50 Mbit/s, mirrorless cameras 100–200, ProRes several hundred.",
  retentionMonths: "How long shared media is kept before it's deleted. Storage bills for every month it's kept, so with 3 months you're always paying for about three months of footage.",
  viewShare: "How much of each teammate's footage each person actually plays. What you've played is cached on your disk, so a replay is free; only the first play reads from Cloudflare.",
  storage: "Where shared media lives. R2 is Cloudflare's file storage, made for this. Without R2, Carton keeps media inside a Durable Object (the vault): it works on any account, but storage costs about 13× more and Workers Free caps it at 5 GB.",
  plan: "Workers Free has no fee but daily limits: past one, requests fail until midnight UTC. Workers Paid is $5 a month, includes far more, and bills small amounts past that. R2 bills the same way on either plan.",
  segmentSeconds: "Carton uploads the preview in short pieces (segments) while it's still encoding, so a teammate can start watching before it's done. Each piece costs a few writes and reads, so longer pieces are cheaper, but the first one takes longer to arrive.",
};

export const LINES = {
  fee: "Workers Paid's monthly fee, once for the whole account. It includes 10 million Worker requests, 1 million Durable Object requests, 50 million rows written and more each month. Workers Free has no fee.",
  edits: "Each save or agent edit is a message to the project's room (a Durable Object), which stores it and sends it to everyone else. It costs Durable Object requests (20 messages for the price of 1 on Paid), rows written and a few milliseconds of room time.",
  presence: "While someone drags, their cursor and playhead go to teammates up to 10 times a second; these are never stored. While anyone's active, the room also checks every minute for people who went silent, so their cursor disappears. Each check is an alarm: one request and one row written.",
  connections: "Opening the project and reconnecting: a Worker request and a full-price Durable Object request each. Also the room's hourly upkeep (moving old changes into an archive), and any cost of sessions left open while nobody edits.",
  segments: "Uploading the preview copy in short segments. Each segment costs a few Worker requests, R2 writes (Class A) and checks (Class B). With the vault instead of R2: Durable Object requests and rows written.",
  originals: "Uploading camera originals, when you share them: resumable uploads in 8 MiB parts, each a Worker request and a few R2 writes. A dropped connection only costs the parts in flight.",
  storage: "Keeping the shared previews (and originals) for the months you chose. In R2: $0.015 a GB-month past 10 free. In the vault: $0.20 a GB-month past the 5 included on Paid; on Free, 5 GB in all.",
  playback: "Teammates watching each other's previews: each segment is a Worker request and an R2 read (Class B). R2 doesn't charge for the bytes going out (egress is free).",
};

export const METERS = {
  workersReq: "Each time a Worker runs: a connect, an upload request, a playback read. The page you're reading doesn't count (static files are free). Free: 100,000 a day. Paid: 10 million a month included, then $0.30 a million.",
  workersCpuMs: "Processor time the Worker uses, not counting time spent waiting on the network or storage. Paid: 30 million ms a month included, then $0.02 a million. Free: never billed, but at most 10 ms per request.",
  doReq: "Each request to a Durable Object: a connect, an alarm, a live message, a vault read or write. On Paid, 20 incoming WebSocket messages bill as 1 request (the shown amount is after that). 1 million a month included, then $0.15 a million, rounded up to a whole million. Free: 100,000 a day.",
  doGBs: "How long Durable Objects are awake, times the 128 MB each one is given. A room that sleeps between messages (hibernation) isn't billed while it sleeps, and work it does at the same moment shares the time, so one object is never billed for more than the hours in the month. Paid: 400,000 GB-s a month included, then $12.50 a million. Free: 13,000 a day.",
  doRowsRead: "Rows read from Durable Objects' databases. Paid: 25 billion a month included, then $0.001 a million. Free: 5 million a day.",
  doRowsWritten: "Rows written to Durable Objects' databases. Deletes count, and so does every alarm that's set. Paid: 50 million a month included, then $1 a million. Free: 100,000 a day.",
  doStorageGB: "Data kept in Durable Objects: each room's recent changes, and all media when there's no R2. Paid: 5 GB-month included, then $0.20 a GB-month. Free: 5 GB in total.",
  r2StorageGB: "Files kept in R2, averaged over the month. 10 GB-month free, then $0.015 a GB-month, rounded up to a whole GB-month, on either plan.",
  r2ClassA: "R2 operations that change something: uploading a file or a part, finishing an upload, listing. 1 million a month free, then $4.50 a million.",
  r2ClassB: "R2 operations that read: fetching a file or checking it's there. 10 million a month free, then $0.36 a million.",
};

export const FREE_CHECKS = {
  workersReq: "Workers Free allows 100,000 Worker requests a day for the whole account, reset at midnight UTC. Past it, Cloudflare refuses every request (error 1027) until then: nobody can connect or upload.",
  doReq: "Workers Free allows 100,000 Durable Object requests a day. Every live message is counted one for one here, to be safe: Cloudflare's 20-for-1 deal is documented for billing, not for this limit.",
  doGBs: "Workers Free allows 13,000 GB-s of Durable Object time a day: about 28 hours of one object awake.",
  doRowsRead: "Workers Free allows 5 million rows read a day.",
  doRowsWritten: "Workers Free allows 100,000 rows written a day. Each edit writes about 2 rows, plus one when it's archived; each alarm writes one.",
  doStorageGB: "Workers Free allows 5 GB in all Durable Objects together: what's kept, not a daily amount, so midnight doesn't reset it. Past it, writes fail until data is deleted. Media in the vault counts against it.",
  doObjectGB: "One Durable Object can hold at most 1 GB on Free and 10 GB on Paid. Without R2, a project's media all sits in one object (its vault), so the media you keep must fit, on either plan. Past it, writes fail until data is deleted.",
  cpu: "Workers Free stops any single request that uses more than 10 ms of processor time (error 1102), every time, at any hour. This shows each kind of request's average CPU from the model's inputs; a request above its average could still pass 10 ms, so under the limit here means likely, not certain.",
};

export const LIMITS = {
  "worker-cpu-10ms": {
    name: "10 ms CPU per request (Free)",
    tip: "On Cloudflare's free plan, the server code handling one request may use at most 10 milliseconds of processor time. Time spent waiting on the network or storage doesn't count. Go over it and Cloudflare stops the request (error 1102). Carton's upload chunks used far more before a fix, so big uploads failed; with the fix (in the lab build, not merged yet) they stream through and stay under it.",
    check: "cpu",
  },
  "worker-memory-128mb": { name: "128 MB memory per Worker", tip: "Each Worker gets 128 MB of memory, shared by the requests it's handling at that moment. Hold a big file in memory and a request can be killed, even one that would fit alone." },
  "request-body-100mb": { name: "100 MB per request", tip: "On Cloudflare's Free and Pro plans, one request can carry at most 100 MB. Bigger, and Cloudflare refuses it before the Worker even sees it (HTTP 413). That's why big files go up in parts." },
  "ws-message-32mib": { name: "32 MiB per WebSocket message", tip: "One message over a live connection (a WebSocket) can be at most 32 MiB. Send a bigger one and Cloudflare closes the connection." },
  subrequests: { name: "Subrequests per request", tip: "Calls one request makes to other services, like storage. Free allows 50 to the outside world and 1,000 to Cloudflare's own services per request. A request that checks thousands of files at once would run out." },
  "do-value-2mb": { name: "2 MB per database row", tip: "One row in a Durable Object's database can hold at most 2 MB, so bigger data has to be split across rows." },
  "daily-workers-requests": { name: "100,000 Worker requests a day (Free)", tip: FREE_CHECKS.workersReq, check: "workersReq" },
  "daily-do-requests": { name: "100,000 Durable Object requests a day (Free)", tip: FREE_CHECKS.doReq, check: "doReq" },
  "daily-do-duration": { name: "13,000 GB-s a day (Free)", tip: FREE_CHECKS.doGBs, check: "doGBs" },
  "daily-rows-written": { name: "100,000 rows written a day (Free)", tip: FREE_CHECKS.doRowsWritten, check: "doRowsWritten" },
  "do-object-storage": { name: "1 GB per Durable Object (10 GB on Paid)", tip: FREE_CHECKS.doObjectGB, check: "doObjectGB" },
  "do-storage-5gb": { name: "5 GB of Durable Object storage (Free)", tip: FREE_CHECKS.doStorageGB, check: "doStorageGB" },
  "r2-free-monthly": { name: "R2's monthly free allowance", tip: "R2 is free up to 10 GB-month of storage, 1 million writes (Class A) and 10 million reads (Class B) a month, on either Workers plan. Past that it bills; it never stops working." },
  "dead-link": { name: "A link that dies silently", tip: "A connection that dies without closing (Wi-Fi gone, a router hiccup) can look open for minutes. Not a Cloudflare limit, but it decides how soon edits arrive after an outage." },
};

export const METRICS = {
  p50: "The median: half of the measurements were at least this fast. What a typical edit or upload feels like.",
  p90: "9 in 10 were at least this fast; 1 in 10 took longer. A fair 'slow moment'.",
  p99: "99 in 100 were at least this fast: the rare worst case you'd still notice now and then.",
  runs: "How many separate test runs this row combines. One run is a first look, not a guarantee.",
  convergence: "From the moment one person makes an edit until every other party has it, confirmed by the server.",
  duration: "Wall-clock time from start to finish, as the person waiting would see it.",
};

export const NETWORKS = {
  none: { label: "Unshaped", tip: "No slowdown added: the lab's server in Mumbai, 1–2 ms from Cloudflare. The best case; shows the server's own speed." },
  good: { label: "Good", tip: "A decent home or office line." },
  "4g": { label: "4G", tip: "A phone hotspot on a fair 4G signal." },
  "3g": { label: "3G", tip: "A weak mobile signal." },
  bad: { label: "Bad", tip: "A poor connection: hotel Wi-Fi, a train." },
};

export const SCENARIOS = {
  sync: { name: "Live sync", tip: "Several people and agents editing one cut at once, each a real Carton client on its own simulated network. The number is how long an edit takes to show up for everyone else." },
  flap: { name: "Flapping link", tip: "The connection drops for 5 s every 30 s while people keep editing. Edits made in a gap wait for the link to come back; nothing is lost." },
  outage: { name: "5-minute outage", tip: "One person loses the connection for 5 minutes and keeps editing offline. The number is how long their edits took to reach the others once the link was back." },
  upload: { name: "Upload", tip: "Sharing a file: from starting the upload until teammates can fetch it. Uploads are resumable in parts." },
  preview: { name: "Preview ready", tip: "From a clip being shared until a teammate can start playing it: the first 2 s piece of the preview, uploaded and fetched." },
  download: { name: "Download", tip: "A teammate fetching a shared file." },
};

export const GLOSSARY = [
  ["Worker", "A small program Cloudflare runs in its data centres close to you, started fresh for each request. Carton's Worker checks who you are, then hands your connection to the project's room or streams a file to storage."],
  ["Durable Object", "A tiny server with its own database that Cloudflare keeps in one place, so everyone talking to it sees the same state. Each Carton project gets one, its room: it puts everyone's edits in one order and sends them to the others."],
  ["R2", "Cloudflare's file storage, like Amazon S3 but with no charge for downloads. Carton keeps shared previews and originals there."],
  ["The vault", "Carton's fallback when an account has no R2: media is kept inside a Durable Object's database, in 1 MiB rows. It works anywhere, but costs about 13× more per GB and counts against Workers Free's 5 GB."],
  ["Class A and Class B operations", "How R2 counts work. Class A changes something (upload a file or a part, finish an upload): $4.50 a million. Class B reads (fetch a file, check it exists): $0.36 a million. Deleting is free."],
  ["GB-month", "Storage over time: 1 GB kept for a whole month. 30 GB kept for 10 days is about 10 GB-month."],
  ["GB-second (GB-s)", "Memory over time: how long something was awake times the memory it held. A Durable Object holds 128 MB, so 1 second awake is 0.128 GB-s, and 13,000 GB-s is about 28 hours."],
  ["Rows read and written", "Durable Objects bill their database by rows touched. Saving an edit writes about 2 rows; deleting a row counts as a write too."],
  ["Hibernation", "A room with nobody sending anything goes to sleep while keeping everyone's connection open. A sleeping room isn't billed for time; the next message wakes it in milliseconds."],
  ["WebSocket", "A connection that stays open so the server can push updates the moment they happen, instead of the app asking over and over. Carton's live sync runs over one per person."],
  ["20:1 WebSocket billing", "On Workers Paid, Cloudflare bills 20 incoming WebSocket messages as 1 Durable Object request. Messages going out to teammates and keepalive pings are free."],
  ["Proxy and segment", "The proxy is a smaller copy of a clip for editing and previews (720p at about 2 Mbit/s). Carton uploads it in segments, short pieces of about 2 seconds, so a teammate can start watching before the whole thing is up."],
  ["Edge", "Cloudflare's data centre nearest to you. Your request reaches the edge first; a project's room may live a little further away."],
  ["Round trip (RTT)", "The time for a message to reach the server and an answer to come back. 30 ms is a good line; 400 ms feels laggy."],
  ["Packet loss", "The share of small chunks of data that never arrive and have to be sent again. 1% loss on a long upload adds noticeable delay."],
  ["p50, p90, p99", "Ways to summarise many timings. p50: half were at least this fast. p90: 9 in 10 were. p99: 99 in 100 were, the rare slow case."],
  ["Workers Free and Workers Paid", "Cloudflare's two plans for Workers and Durable Objects. Free: no fee, daily limits, requests fail past them. Paid: $5 a month, monthly included amounts, then pay for what you use."],
];

export const INPUT_LABELS = {
  editDoReq: "Durable Object requests per edit",
  editRowsWritten: "Rows written per edit",
  editRowsRead: "Rows read per edit",
  editGBs: "Room time per edit (GB-s)",
  editWorkerCpuMs: "Worker CPU per edit",
  editArchiveRowsWritten: "Rows written when an edit is archived",
  changeBytes: "Bytes per stored change",
  connWorkerReq: "Worker requests per connect",
  connWorkerCpuMs: "Worker CPU per connect",
  connDoReq: "Durable Object requests per connect",
  connRowsWritten: "Rows written per connect",
  connRowsRead: "Rows read per connect",
  connGBs: "Room time per connect (GB-s)",
  presenceMsgPerSecWhileDragging: "Presence messages a second while dragging",
  presenceDoReq: "Durable Object requests per presence message",
  presenceGBs: "Room time per presence message (GB-s)",
  presenceAlarmPerHour: "Presence checks an hour",
  upkeepAlarmPerHour: "Upkeep alarms an editing hour",
  alarmRowsWritten: "Rows written per alarm",
  alarmGBs: "Room time per alarm (GB-s)",
  idleDoReqPerHour: "Durable Object requests per idle hour",
  idleGBsPerHour: "Room time per idle hour (GB-s)",
  idleRowsWrittenPerHour: "Rows written per idle hour",
  gbWorkerReq: "Worker requests per GB uploaded",
  gbWorkerCpuMs: "Worker CPU per GB uploaded",
  gbR2ClassA: "R2 Class A per GB uploaded",
  gbR2ClassB: "R2 Class B per GB uploaded",
  gbDoReq: "Durable Object requests per GB uploaded (R2)",
  gbVaultDoReq: "Vault requests per GB uploaded",
  gbVaultRowsWritten: "Vault rows written per GB uploaded",
  gbVaultGBs: "Vault time per GB uploaded (GB-s)",
  segWorkerReq: "Worker requests per preview segment",
  segWorkerCpuMs: "Worker CPU per preview segment",
  segR2ClassA: "R2 Class A per preview segment",
  segR2ClassB: "R2 Class B per preview segment",
  segVaultDoReq: "Vault requests per preview segment",
  segVaultRowsWritten: "Vault rows written per preview segment",
  viewWorkerReqPerMiB: "Worker requests per MiB played",
  viewClassBPerMiB: "R2 Class B per MiB played",
  viewWorkerCpuMsPerMiB: "Worker CPU per MiB played",
  viewVaultRowsReadPerMiB: "Vault rows read per MiB played",
  viewVaultGBsPerMiB: "Vault time per MiB played (GB-s)",
};

/** Which bill line each input feeds, to group the inputs table. */
export const INPUT_GROUPS = [
  ["Live edits", ["editDoReq", "editRowsWritten", "editRowsRead", "editGBs", "editWorkerCpuMs", "editArchiveRowsWritten", "changeBytes"]],
  ["Cursors and playheads", ["presenceMsgPerSecWhileDragging", "presenceDoReq", "presenceGBs", "presenceAlarmPerHour", "alarmRowsWritten", "alarmGBs"]],
  ["Connections and idle time", ["connWorkerReq", "connWorkerCpuMs", "connDoReq", "connRowsWritten", "connRowsRead", "connGBs", "upkeepAlarmPerHour", "idleDoReqPerHour", "idleGBsPerHour", "idleRowsWrittenPerHour"]],
  ["Preview uploads", ["segWorkerReq", "segWorkerCpuMs", "segR2ClassA", "segR2ClassB", "segVaultDoReq", "segVaultRowsWritten"]],
  ["Camera originals", ["gbWorkerReq", "gbWorkerCpuMs", "gbR2ClassA", "gbR2ClassB", "gbDoReq", "gbVaultDoReq", "gbVaultRowsWritten", "gbVaultGBs"]],
  ["Playback", ["viewWorkerReqPerMiB", "viewClassBPerMiB", "viewWorkerCpuMsPerMiB", "viewVaultRowsReadPerMiB", "viewVaultGBsPerMiB"]],
];

export const CHART = {
  title: "Monthly cost against number of teams",
  tip: "Each line is the whole month's bill for that many teams, with your other settings. Both scales go up by ×10 per step, so a straight line means the cost grows in proportion. A Free line stops where the first Free limit is passed: past it, requests would fail.",
};
