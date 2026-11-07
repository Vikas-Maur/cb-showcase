// One demo participant, kept running: Cardboard 1.4.0's real library worker (patched as the Windows build is, staged by
// `peer setup`) under Node, through the harness the sync tests use in place of Electron's utility-process port
// (scripts/carton/test/worker-harness.js), with its own app data. It holds its projects' sync connections, as the
// Windows app's worker does, and answers on a Unix socket, one JSON object per line:
//   in   {id, op, args}            ops below
//   out  {id, ok, data | error}    the answer
//   out  {event}                   after {op: "watch"}: the participant's live stream (edits, presence, cuts, status)
//   node daemon.js <participant dir>          (peer.json there names the participant; `peer` starts this)
//
// Everything it writes into a project is what the person (or, with an agent label, their agent) did, as the editor
// saves it: whole arrays through the worker's `projects.updateScoped`, with the version it was made on as its base, so
// Carton records it as the person's (or the agent's) edit and sends it change by change. A title is Cardboard's own
// shape for one (an item and its text entry, as `cb source apply` writes a <text>); a sound is imported by Cardboard's
// own `cb media add` (handed to this worker, the lease holder), shared to the server, then placed as an audio clip
// (FINDINGS.md §6.1 and §6.2 say why not through the editor's own import, and why the wait).
//
// Agent label (`peer join --agent <label>`): the project's Carton handle in this process is opened as that agent (an
// extension registered here, in this process only: the facade's own extend(), whose open options later extensions
// override), and its presence is sent from the handle with no person attached, so the other computer's Share lists it as
// the person's agent ("Leo's Director · Working on …"). Nothing of Carton or Cardboard is changed for it.
const fs = require("fs"), path = require("path"), net = require("net");
const { randomUUID } = require("crypto");
const lib = require("./lib.js");

const DIR = path.resolve(process.argv[2] ?? "");
const CFG_FILE = path.join(DIR, "peer.json");
let cfg = lib.readJson(CFG_FILE);
if (!cfg) { process.stderr.write("no peer.json in " + DIR + "\n"); process.exit(2); }
const saveCfg = () => lib.writeJson(CFG_FILE, cfg);
const b = lib.build();
// The worker logs to stdout; this process's stdout and stderr both go to daemon.log.
const log = (...a) => process.stderr.write(`[${lib.clock()}] ` + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
console.log = console.info = (...a) => process.stderr.write(a.join(" ") + "\n");

// ------------------------------------------------------------------ the agent label (an extension in this process)
const facade = require(path.join(b.carton, "carton-node.cjs"));
const sync = globalThis.__cartonSync;
let api = null; // the facade's worker api, once the worker starts
const handles = new Map(); // bundlePath → LocalCarton, as the worker opens them
const agentActor = () => (cfg.agent ? { kind: "agent", id: cfg.agent.id, name: cfg.agent.name, group: cfg.group ?? undefined, app: true } : null);
facade.extend({
  name: "demo-peer",
  // a shared project's handle is the agent's (the sync extension made it the person's)
  openOptions: ({ bundlePath, projectId }) => (cfg.agent && projectId && sync?.store.readConfig(bundlePath, projectId) ? { actor: agentActor() } : {}),
  worker(a) {
    api = a;
    a.onOpen((bundlePath, lc) => { handles.set(bundlePath, lc); watchHandle(bundlePath, lc); });
    return {};
  },
});

// ------------------------------------------------------------------ the worker
let call = null, events = null;
const projectId = () => cfg.projectId ?? null;
const bundlePath = () => (projectId() && api ? api.bundleOf(projectId()) : null);
const handle = async () => {
  if (!projectId()) throw new Error("No project yet: join one (or create and share one)");
  const lc = await api.carton(projectId());
  if (!lc) throw new Error("The project's history isn't open");
  return lc;
};

// ------------------------------------------------------------------ the live stream
const watchers = new Set();
const rawWatchers = new Set(); // {op: "raw"}: the worker's carton posts and project changes, as main gets them
const recent = []; // the last 500 events, for a watch that starts late (`since`)
let journal = null;
function emit(ev) {
  ev = { at: Date.now(), ...ev };
  recent.push(ev);
  if (recent.length > 500) recent.shift();
  journal ??= fs.openSync(path.join(DIR, "watch.jsonl"), "a");
  try { fs.writeSync(journal, JSON.stringify(ev) + "\n"); } catch {}
  for (const w of watchers) w(ev);
}

const firstName = (n) => String(n ?? "").trim().split(/\s+/)[0] || String(n ?? "");
// Writers with no name of their own (a terminal's cb, the worker's own "app" writes, an outside save) are the person at
// that computer, as the app's History tells them (@carton/react from-carton.ts isPersonsWriter).
const personsWriter = (a) => a.kind === "external" || (a.kind === "agent" && (a.id === "cli" || a.id === "app" || String(a.id).startsWith("external:")));
/** An author as History words them on this computer: a person by first name, an agent as its person's. */
function labelOf(a, mine) {
  if (!a) return "Someone";
  if (a.kind === "system") return "Cardboard";
  if (personsWriter(a)) a = a.owner ? { kind: "human", id: a.owner.id, name: a.owner.name } : { kind: "human", id: "?", name: mine ? cfg.name : "A teammate" };
  if (a.kind === "human") return mine ? `${firstName(a.name ?? a.id)} (this computer)` : firstName(a.name ?? a.id);
  const owner = a.owner?.name ?? a.owner?.id;
  return owner ? `${firstName(owner)}'s ${a.name ?? a.id}` : a.name ?? a.id;
}

const watched = new WeakSet();
const lastSeq = new Map(); // cut → newest seq told
const localIds = new Set(); // change ids made on this computer (this worker, or cb through it)
let cutsKnown = null, pendingCuts = new Map(), readTimer = null;
function watchHandle(bp, lc) {
  if (watched.has(lc)) return;
  watched.add(lc);
  lc.carton.on((e) => {
    if (e.type === "change") {
      if (e.local) localIds.add(e.change?.id);
      const seen = pendingCuts.get(e.branchId) ?? [];
      seen.push({ seq: e.seq, seenAt: Date.now(), local: e.local });
      pendingCuts.set(e.branchId, seen);
      readTimer ??= setTimeout(() => { readTimer = null; void readChanges(lc); }, 30);
    } else if (e.type === "cuts") void readCuts(lc);
    else if (e.type === "sync") {
      emit({ type: "status", status: e.status, waiting: e.waiting });
      // presence said while the connection was coming up went nowhere: say it again once it is up
      if (e.status === "up-to-date" && presenceState && saidWhileDown) sendPresence().catch(() => {});
    }
    else if (e.type === "sync-error" && e.error) emit({ type: "status", status: "problem", code: e.error.code, message: e.error.message });
  });
  void readCuts(lc);
  void (async () => { for (const c of await lc.carton.cuts()) lastSeq.set(c.id, (await lc.carton.head(c.id).catch(() => null))?.ref.seq ?? 0); })().catch(() => {});
}
async function readChanges(lc) {
  const batch = pendingCuts;
  pendingCuts = new Map();
  const names = new Map((await lc.carton.cuts()).map((c) => [c.id, c.name]));
  for (const [cut, seen] of batch) {
    let versions;
    try { versions = await lc.carton.log({ cut, limit: 30, summary: true, rows: true }); } catch (e) { log("log failed", String(e?.message ?? e)); continue; }
    const from = lastSeq.get(cut) ?? -1;
    for (const v of versions.filter((x) => x.ref.seq > from).reverse()) {
      const hit = seen.find((s) => s.seq === v.ref.seq);
      const mine = !!(hit?.local || (v.change && localIds.has(v.change)));
      const rows = (v.rows ?? []).filter((r) => !r.minor).map((r) => ({ kind: r.kind, text: r.text, coll: r.coll, id: r.id, type: r.rec?.type ?? null, name: r.rec?.name ?? null, words: r.rec?.textContent ?? r.rec?.content ?? null, start: r.at ?? null, end: r.end ?? null }));
      emit({ type: "edit", cut: names.get(cut) ?? cut, cutId: cut, seq: v.ref.seq, by: labelOf(v.author, mine), author: v.author, mine, madeAt: v.at, seenAt: hit?.seenAt ?? Date.now(), what: v.summary ?? v.name ?? v.kind, name: v.name ?? null, kind: v.kind, rows });
      lastSeq.set(cut, v.ref.seq);
    }
  }
}
async function readCuts(lc) {
  const cuts = await lc.carton.cuts().catch(() => null);
  if (!cuts) return;
  const now = new Map(cuts.map((c) => [c.id, { name: c.name, where: c.tracking ? "read-only" : c.sequencer?.kind === "server" ? "shared" : c.sequencer?.kind === "local" ? "this computer only" : c.sequencer?.kind ?? "?" }]));
  if (cutsKnown) {
    const added = [...now].filter(([id]) => !cutsKnown.has(id)).map(([id, c]) => ({ id, ...c }));
    const removed = [...cutsKnown].filter(([id]) => !now.has(id)).map(([id, c]) => ({ id, ...c }));
    const renamed = [...now].filter(([id, c]) => cutsKnown.has(id) && cutsKnown.get(id).name !== c.name).map(([id, c]) => ({ id, from: cutsKnown.get(id).name, to: c.name }));
    const moved = [...now].filter(([id, c]) => cutsKnown.has(id) && cutsKnown.get(id).where !== c.where).map(([id, c]) => ({ id, name: c.name, where: c.where }));
    if (added.length || removed.length || renamed.length || moved.length) emit({ type: "cuts", added, removed, renamed, moved, current: now.get(lc.carton.cut)?.name ?? null });
  }
  for (const c of cuts) if (!lastSeq.has(c.id)) lastSeq.set(c.id, (await lc.carton.head(c.id).catch(() => null))?.ref.seq ?? 0);
  cutsKnown = now;
}

// Who is here, from the worker's own Share status (Live.view(), as the app's Share dialog gets it).
let peersKnown = new Map();
function takeLive(live) {
  const now = new Map();
  for (const p of live.peers ?? []) {
    const who = p.actor?.kind === "agent" && p.actor.owner ? `${firstName(p.actor.owner.name)}'s ${p.actor.name}` : firstName(p.actor?.name ?? p.actor?.id);
    // the cut by its name (a teammate's cut not on this computer: "another cut"), never its id
    now.set(p.actor?.key, { who, activity: p.activity ?? null, idle: !!p.idle, cut: cutsKnown?.get(p.cut)?.name ?? (p.cut ? "another cut" : null), role: p.role ?? null });
  }
  for (const [k, p] of now) {
    const was = peersKnown.get(k);
    if (!was) emit({ type: "presence", change: "here", ...p });
    else if (was.activity !== p.activity || was.idle !== p.idle || was.cut !== p.cut) emit({ type: "presence", change: p.idle ? "idle" : "activity", ...p });
  }
  for (const [k, p] of peersKnown) if (!now.has(k)) emit({ type: "presence", change: "left", ...p });
  peersKnown = now;
  liveNow = live;
}
let liveNow = null;

// ------------------------------------------------------------------ presence, kept alive
// The other computer's Share fades someone it hasn't heard from for 30 s (sync/live.js PEER_IDLE_MS): said again every
// 10 s while it holds.
let presenceState = null; // {activity} | {activity: null, idle: true} | null (gone)
let saidWhileDown = false; // the last presence went out while sync wasn't up to date (said again when it is)
async function sendPresence(state = presenceState) {
  presenceState = state;
  if (!projectId()) return;
  const lc = await handle();
  saidWhileDown = lc.carton.sync?.state().status !== "up-to-date";
  if (cfg.agent) lc.carton.sync?.presence(state ? { activity: state.activity ?? null, ...(state.idle ? { idle: true } : {}) } : null);
  else await call("carton.livePresence", { projectId: projectId(), state });
}
setInterval(() => { if (presenceState) sendPresence().catch((e) => log("presence", String(e?.message ?? e))); }, 10_000).unref();

// ------------------------------------------------------------------ edits, as the editor saves them
const actorId = () => (cfg.agent ? cfg.agent.id : "person");
const read = async () => {
  const doc = await call("projects.read", projectId());
  if (!doc) throw new Error("The project can't be read");
  return doc;
};
async function save(doc, next, { ownedMediaIds = [], removedMediaIds = [] } = {}) {
  return call("projects.updateScoped", { ...next, stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) }, { ownedFields: ["tracks", "timelineItems"], ownedMediaIds, removedMediaIds, carton: { base: doc.stateUpdatedAt, actor: actorId() } });
}
function trackFor(doc, name, audio) {
  const tracks = doc.tracks ?? [];
  const t = tracks.find((x) => x.name === name && !!(x.type === "audio") === audio);
  if (t) return { tracks, track: t };
  // A new track goes below the others, and no other track is touched: renumbering them all (to put titles on top) raced a
  // teammate's apply made from an older print, which merged its own orders back (the live rehearsal: Titles ended up
  // under Footage). A title is drawn on top by its own zIndex instead (say).
  const track = { id: randomUUID(), name, order: Math.max(-1, ...tracks.map((x) => x.order ?? 0)) + 1, locked: false, visible: true, muted: false, ...(audio ? { type: "audio" } : {}) };
  return { tracks: [...tracks, track], track };
}
// Looks for a title (Cardboard's text props, timeline.d.ts TextProps); `transform` is pixels from the frame's centre.
const STYLES = {
  title: { fontSize: 96, fontWeight: "bold", color: "#ffffff", textAlign: "center", shadowColor: "#000000", shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 4 },
  chat: { fontSize: 52, color: "#ffffff", textAlign: "left", backgroundColor: "#16181d", backgroundOpacity: 0.85, backgroundPadding: 28, transform: { x: -420, y: 300, scale: 1, rotation: 0 } },
  reply: { fontSize: 52, color: "#16181d", textAlign: "right", backgroundColor: "#f2f2f2", backgroundOpacity: 0.92, backgroundPadding: 28, transform: { x: 420, y: 300, scale: 1, rotation: 0 } },
  caption: { fontSize: 56, fontWeight: "bold", color: "#ffffff", textAlign: "center", strokeColor: "#000000", strokeWidth: 6, transform: { x: 0, y: 400, scale: 1, rotation: 0 } },
  whisper: { fontSize: 40, fontStyle: "italic", color: "#d8d8d8", textAlign: "center", backgroundColor: "#000000", backgroundOpacity: 0.5, backgroundPadding: 16, transform: { x: 0, y: -420, scale: 1, rotation: 0 } },
};
// how long the other side's worker keeps a "not shared yet" answer for a clip's record (sync/media.js sharedRecord), and a margin
const REASK_MS = Number(process.env.DEMO_REASK_MS ?? 2300);
const clipLabel = (text) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > 40 ? t.slice(0, 39) + "…" : t; };
const round = (x) => Math.round(x * 1000) / 1000;

async function say({ text, at, dur, style = "title", name, track = "Talk", color, size, y }) {
  if (!text || !String(text).trim()) throw new Error("Nothing to say");
  const look = STYLES[style];
  if (!look) throw new Error(`No look "${style}": ${Object.keys(STYLES).join(", ")}`);
  const doc = await read();
  const { tracks, track: tr } = trackFor(doc, track, false);
  const start = at ?? Math.max(0, ...(doc.timelineItems ?? []).filter((i) => i.trackId === tr.id).map((i) => i.endTime));
  const len = dur ?? Math.max(2.5, String(text).split(/\s+/).length / 2.6 + 1);
  const mediaId = randomUUID(), id = randomUUID();
  const now = new Date().toISOString();
  const entry = { id: mediaId, createdAt: now, addedAt: now, data: { type: "text", presetId: "custom", content: String(text), fileName: `Text: ${String(text)}`, format: "text", size: 0 } };
  // over the footage wherever its track is (cb docs source: "zIndex overrides track order")
  const props = { zIndex: 100, ...look, ...(color ? { color } : {}), ...(size ? { fontSize: Number(size) } : {}) };
  if (y !== undefined) props.transform = { x: 0, scale: 1, rotation: 0, ...(props.transform ?? {}), y: Number(y) };
  const item = { id, trackId: tr.id, type: "text", startTime: round(start), endTime: round(start + len), trimStart: 0, trimEnd: round(len), name: name ?? clipLabel(text), textContent: String(text), mediaItemId: mediaId, ...props };
  const t0 = Date.now();
  await save(doc, { ...doc, tracks, timelineItems: [...(doc.timelineItems ?? []), item], media: [...(doc.media ?? []), entry] }, { ownedMediaIds: [mediaId] });
  mine({ id, name: item.name, kind: "title" });
  const out = { id, name: item.name, start: item.startTime, end: item.endTime, track: tr.name, savedMs: Date.now() - t0, savedAt: Date.now() };
  emit({ type: "self", op: "say", ...out, text: String(text) });
  return out;
}

async function speak({ file, at, name, track = "Voice", text, volume, seconds, shareFirst = true, via = process.env.DEMO_IMPORT ?? "cb" }) {
  if (!file || !fs.existsSync(file)) throw new Error("No sound file: " + file);
  const t0 = Date.now();
  let mediaId, answered = null;
  if (via === "ingest") {
    // Cardboard's own import, as a file dropped on the editor (main's `ingest`): see FINDINGS.md §6 for what its
    // background derive does to a teammate's next change
    const r = await call("ingest", projectId(), [path.resolve(file)]);
    if (r?.failures?.length) throw new Error("Cardboard didn't take the sound: " + r.failures.map((f) => f.message ?? f.error ?? JSON.stringify(f)).join("; "));
    const media = r?.items?.[0];
    answered = media?.data?.duration ?? media?.probe?.duration ?? null;
    mediaId = media?.id ?? media?.mediaId;
    if (!mediaId) throw new Error("Cardboard's import answered no media: " + JSON.stringify(r).slice(0, 300));
    if (process.env.DEMO_SETTLE === "1") await settle(mediaId);
  } else {
    // Cardboard's own `cb media add`, handed to this worker (the lease holder) as any cb write: no background derive
    const had = new Set(((await read()).media ?? []).map((m) => m.id));
    // named as the person (or the agent): Carton's store bridge maps CARDBOARD_ACTOR=person to the app's own person, so
    // the import reads as them everywhere (`cb history` too); a cb with no actor is a nameless "Terminal" writer
    const r = await cbAsync(["media", "add", projectId(), path.resolve(file)], cfg.agent ? cfg.agent.id : "person");
    if (r.code !== 0) throw new Error("Cardboard didn't take the sound: " + (r.out + r.err).trim().split("\n").slice(-2).join(" "));
    for (let i = 0; i < 100 && !mediaId; i++) {
      mediaId = ((await read()).media ?? []).find((m) => !had.has(m.id) && m.data?.type === "audio")?.id;
      if (!mediaId) await new Promise((res) => setTimeout(res, 50));
    }
    if (!mediaId) throw new Error("The sound didn't reach the project");
  }
  const doc = await read();
  const m = (doc.media ?? []).find((x) => x.id === mediaId);
  // its length: the project's entry, else the import's answer, else ffprobe's reading of the file
  const dur = Number(seconds) || Number(m?.data?.duration) || Number(answered) || Number(require("child_process").execFileSync(process.env.CARDBOARD_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  if (!(dur > 0)) throw new Error("The sound's length isn't known yet");
  const importedMs = Date.now() - t0, importedAt = Date.now();
  // the sound goes up to the sharing server before its clip goes on the timeline, so the other side can play it the
  // moment it appears (Carton would share it 2 s after the last change; meanwhile the clip would be a teammate's clip
  // "still on its way")
  let sharedMs = null;
  if (shareFirst) {
    // (the worker shares a clip once project.json's manifest lists its file, a moment after the import)
    const s0 = Date.now();
    for (let i = 0; ; i++) {
      const r = await call("carton.liveShareMedia", { projectId: projectId(), mediaIds: [mediaId] });
      const got = (r ?? []).find((x) => x.mediaId === mediaId);
      if (got?.error) throw new Error("The sound didn't reach the sharing server: " + got.error);
      if (got?.hash) break;
      if (Date.now() - s0 > 15_000) { log("speak: the sound wasn't shared within 15 s; its clip goes on anyway"); break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    sharedMs = Date.now() - s0;
  }
  // The other side's worker asked the server for the sound's record when its media entry arrived (before this share), and
  // keeps that "none" for 2 s (sync/media.js sharedRecord); the editor asks again when the clip arrives. So the clip goes
  // on once that has passed, and the editor finds the sound there (FINDINGS.md §6).
  if (shareFirst) { const wait = importedAt + REASK_MS - Date.now(); if (wait > 0) await new Promise((res) => setTimeout(res, wait)); }
  const doc2 = shareFirst ? await read() : doc;
  const { tracks, track: tr } = trackFor(doc2, track, true);
  const start = at ?? Math.max(0, ...(doc2.timelineItems ?? []).filter((i) => i.trackId === tr.id).map((i) => i.endTime));
  const id = randomUUID();
  const item = { id, trackId: tr.id, type: "audio", startTime: round(start), endTime: round(start + dur), trimStart: 0, trimEnd: round(dur), mediaItemId: mediaId, name: name ?? clipLabel(text ?? path.basename(file)), ...(volume !== undefined ? { volume: Number(volume) } : {}) };
  await save(doc2, { ...doc2, tracks, timelineItems: [...(doc2.timelineItems ?? []), item] });
  mine({ id, name: item.name, kind: "sound", mediaId, file: path.resolve(file) });
  checkSoon(mediaId);
  const out = { id, mediaId, name: item.name, start: item.startTime, end: item.endTime, track: tr.name, importedMs, sharedMs, savedMs: Date.now() - t0, savedAt: Date.now() };
  emit({ type: "self", op: "speak", ...out, text: text ?? null });
  return out;
}


/**
 * Several sounds at once (a line in parts): one `cb media add` of every file, one share, one wait for the other side
 * (REASK_MS), and one save placing every clip, so a two-part line costs about what one does. parts: [{file, at, name}].
 * titles: [say's arguments], said once the sounds are on the sharing server and before their clips are placed: the
 * other computer's editor starts loading a project's new sounds when they arrive in its media (all of them, in idle
 * time), so the line's sound comes down while its titles are read, and plays at once when someone plays it (on the
 * laptop, a sound played as it arrived waited up to 6 s, "Loading audio…").
 */
async function speakAll({ parts, track = "Voice", volume, titles = [] }) {
  if (!Array.isArray(parts) || !parts.length) throw new Error("No parts");
  for (const p of parts) if (!p.file || !fs.existsSync(p.file)) throw new Error("No sound file: " + p.file);
  const t0 = Date.now();
  const had = new Set(((await read()).media ?? []).map((m) => m.id));
  const r = await cbAsync(["media", "add", projectId(), ...parts.map((p) => path.resolve(p.file))], cfg.agent ? cfg.agent.id : "person");
  if (r.code !== 0) throw new Error("Cardboard didn't take the sounds: " + (r.out + r.err).trim().split("\n").slice(-2).join(" "));
  const ids = new Map(); // part index → media id, by the file's name
  for (let i = 0; i < 100 && ids.size < parts.length; i++) {
    const fresh = ((await read()).media ?? []).filter((m) => !had.has(m.id) && m.data?.type === "audio");
    parts.forEach((p, k) => { const m = fresh.find((x) => x.data?.fileName === path.basename(p.file)); if (m) ids.set(k, m.id); });
    if (ids.size < parts.length) await new Promise((res) => setTimeout(res, 50));
  }
  if (ids.size < parts.length) throw new Error("The sounds didn't all reach the project");
  const importedMs = Date.now() - t0, importedAt = Date.now();
  const s0 = Date.now(), want = [...ids.values()];
  for (;;) {
    const got = await call("carton.liveShareMedia", { projectId: projectId(), mediaIds: want });
    const err = (got ?? []).find((x) => x.error);
    if (err) throw new Error("A sound didn't reach the sharing server: " + err.error);
    if (want.every((id) => (got ?? []).some((x) => x.mediaId === id && x.hash))) break;
    if (Date.now() - s0 > 15_000) { log("speakAll: not every sound was shared within 15 s; the clips go on anyway"); break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  const sharedMs = Date.now() - s0;
  const said = [];
  for (const t of titles) said.push(await say(t));
  { const wait = importedAt + REASK_MS - Date.now(); if (wait > 0) await new Promise((res) => setTimeout(res, wait)); }
  const doc = await read();
  const { tracks, track: tr } = trackFor(doc, track, true);
  const items = parts.map((p, k) => {
    const dur = Number(require("child_process").execFileSync(process.env.CARDBOARD_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p.file], { encoding: "utf8" }).trim());
    return { id: randomUUID(), trackId: tr.id, type: "audio", startTime: round(p.at), endTime: round(p.at + dur), trimStart: 0, trimEnd: round(dur), mediaItemId: ids.get(k), name: p.name ?? clipLabel(p.text ?? path.basename(p.file)), ...(volume !== undefined ? { volume: Number(volume) } : {}) };
  });
  await save(doc, { ...doc, tracks, timelineItems: [...(doc.timelineItems ?? []), ...items] });
  items.forEach((it, k) => { mine({ id: it.id, name: it.name, kind: "sound", mediaId: it.mediaItemId, file: path.resolve(parts[k].file) }); checkSoon(it.mediaItemId); });
  const out = { parts: items.map((it) => ({ id: it.id, name: it.name, start: it.startTime, end: it.endTime })), name: items.map((it) => it.name).join(" + "), start: items[0].startTime, end: items.at(-1).endTime, track: tr.name, importedMs, sharedMs, titles: said.map((x) => x.name), savedMs: Date.now() - t0, savedAt: Date.now() };
  emit({ type: "self", op: "speak", ...out });
  return out;
}

// Cardboard's cb on this participant's library, in its own process (never blocking this one: the worker answers the
// lease's pings and the editor's calls here).
function cbAsync(args, actor) {
  const env = lib.peerEnv(DIR, b, actor ? { CARDBOARD_ACTOR: actor } : {});
  return new Promise((resolve) => {
    const p = require("child_process").spawn(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", cfg.root, "--json", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("exit", (code) => resolve({ code, out, err }));
  });
}
/** Wait for Cardboard's background derive of a new media entry (waveform, album art), then save once (DEMO_SETTLE=1). */
async function settle(mediaId) {
  for (let i = 0; i < 200; i++) {
    const m = ((await read()).media ?? []).find((x) => x.id === mediaId);
    if (m && !Object.entries(m.data ?? {}).some(([k, v]) => /GenerationStatus$/.test(k) && v === "pending")) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const doc = await read();
  await save(doc, doc);
}

function mine(x) { cfg.mine = [...(cfg.mine ?? []).filter((m) => m.id !== x.id), { ...x, at: Date.now() }]; saveCfg(); }

// ------------------------------------------------------------------ the sounds this participant sent, on the server
// A teammate who opens the project later, or has it open when this participant has gone, gets a sound only from the
// sharing server. A sound counts as there once the server has its shared record and its bytes come back from the server
// whole and the same as the file sent (sha-256): read the way a teammate's tools read it (the worker's liveMediaUrl: the
// host's record, then its bytes, checked part by part against the record's hash; a part this computer has read before
// comes from its cache). Each is checked once its clip is placed, then every second until it passes, and shared again
// every third failed check (a share that failed or timed out: speakAll places the clips after 15 s regardless); `status`
// says which are still pending, `settle` waits for them: cue sheets end with it, and `peer leave` waits on it.
const onServer = new Map(); // mediaId → {bytes, ms}
const lastCheck = new Map(); // mediaId → the last failed check's reason
const sounds = () => (cfg.mine ?? []).filter((m) => m.kind === "sound" && m.mediaId);
async function checkSound(s) {
  const t0 = Date.now();
  let r;
  // (the worker reads the record from the server: its error is the server's, unreachable or failing)
  try { r = await call("carton.liveMediaUrl", { mediaId: s.mediaId }); } catch (e) { return { ok: false, why: "the sharing server didn't answer: " + (e?.message ?? e) }; }
  if (!r?.url) return { ok: false, why: "its shared record isn't on the server yet" };
  let body;
  try {
    const res = await fetch(r.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, why: `the server's copy didn't come (HTTP ${res.status})` };
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) { return { ok: false, why: "the server's copy didn't come: " + (e?.message ?? e) }; }
  const sha = (b) => require("crypto").createHash("sha256").update(b).digest("hex");
  if (s.file && fs.existsSync(s.file)) {
    const sent = fs.readFileSync(s.file);
    if (body.length !== sent.length || sha(body) !== sha(sent)) return { ok: false, why: `the server's copy (${body.length} bytes) isn't the file sent (${sent.length} bytes)` };
  } else if (typeof r.size === "number" && body.length !== r.size) return { ok: false, why: `the server's copy has ${body.length} of its ${r.size} bytes` };
  return { ok: true, bytes: body.length, ms: Date.now() - t0 };
}
const checking = new Set();
function checkSoon(mediaId) {
  if (checking.has(mediaId) || onServer.has(mediaId)) return;
  checking.add(mediaId);
  (async () => {
    const t0 = Date.now();
    let failed = 0;
    while (Date.now() - t0 < 600_000) {
      const s = sounds().find((m) => m.mediaId === mediaId);
      if (!s) break; // taken out
      const r = await checkSound(s);
      if (r.ok) { onServer.set(mediaId, r); lastCheck.delete(mediaId); log(`sound on the server: ${s.name} (${r.bytes} bytes, the same as sent; checked in ${r.ms} ms)`); break; }
      lastCheck.set(mediaId, r.why);
      if (++failed % 3 === 0) {
        log(`sound not on the server yet: ${s.name} (${r.why}); sharing it again`);
        await call("carton.liveShareMedia", { projectId: projectId(), mediaIds: [mediaId], force: /isn't the file sent|of its/.test(r.why) }).catch((e) => log(`sharing ${s.name} again failed: ${e?.message ?? e}`));
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    checking.delete(mediaId);
  })().catch(() => checking.delete(mediaId));
}
function soundsState() {
  const all = sounds(), pending = all.filter((s) => !onServer.has(s.mediaId));
  for (const s of pending) checkSoon(s.mediaId); // (after a restart: checked again)
  return { sent: all.length, onServer: all.length - pending.length, pending: pending.map((s) => ({ name: s.name, mediaId: s.mediaId, why: lastCheck.get(s.mediaId) ?? "being checked" })) };
}
async function settle({ timeout = 120 } = {}) {
  const t0 = Date.now();
  let st = soundsState();
  while (st.pending.length && Date.now() - t0 < timeout * 1000) { await new Promise((res) => setTimeout(res, 500)); st = soundsState(); }
  return { ...st, ms: Date.now() - t0 };
}
/** Clips by id, exact name, or (when that finds none) words in the name or text; `onlyMine`: the ones this participant added. */
function findClips(doc, ref, { onlyMine = false } = {}) {
  const items = (doc.timelineItems ?? []).filter((i) => !onlyMine || (cfg.mine ?? []).some((m) => m.id === i.id));
  if (ref === "--all-mine" || ref === "all-mine") return items.filter((i) => (cfg.mine ?? []).some((m) => m.id === i.id));
  const s = String(ref ?? "").toLowerCase();
  const exact = items.filter((i) => i.id === ref || (i.name ?? "").toLowerCase() === s);
  if (exact.length) return exact;
  return items.filter((i) => (i.name ?? "").toLowerCase().includes(s) || (i.textContent ?? "").toLowerCase().includes(s));
}
async function clear({ clip, all = false }) {
  const doc = await read();
  const hits = findClips(doc, clip);
  if (!hits.length) throw new Error(`No clip "${clip}"`);
  if (hits.length > 1 && !all && clip !== "--all-mine" && clip !== "all-mine") throw new Error(`"${clip}" is ${hits.length} clips (${hits.map((h) => `“${h.name}”`).join(", ")}): name one, or add --all`);
  const gone = new Set(hits.map((h) => h.id));
  const items = doc.timelineItems.filter((i) => !gone.has(i.id));
  // a title's own text entry goes with it, and so does a sound this participant brought in (nothing else uses them):
  // nothing of the chat stays in the media bin
  const ours = new Set((cfg.mine ?? []).map((m) => m.mediaId).filter(Boolean));
  const textIds = hits.filter((h) => h.mediaItemId && (h.type === "text" || ours.has(h.mediaItemId)) && !items.some((i) => i.mediaItemId === h.mediaItemId)).map((h) => h.mediaItemId);
  const t0 = Date.now();
  await save(doc, { ...doc, timelineItems: items, media: (doc.media ?? []).filter((m) => !textIds.includes(m.id)) }, { removedMediaIds: textIds });
  cfg.mine = (cfg.mine ?? []).filter((m) => !gone.has(m.id)); saveCfg();
  const out = { removed: hits.map((h) => h.name ?? h.id), savedMs: Date.now() - t0 };
  emit({ type: "self", op: "clear", ...out });
  return out;
}
async function edit({ clip, text, at, dur, style }) {
  const doc = await read();
  const hits = findClips(doc, clip);
  if (hits.length !== 1) throw new Error(hits.length ? `"${clip}" is ${hits.length} clips: name one` : `No clip "${clip}"`);
  const h = hits[0];
  const len = dur ?? h.endTime - h.startTime, start = at ?? h.startTime;
  const next = { ...h, startTime: round(start), endTime: round(start + len), trimEnd: round((h.trimStart ?? 0) + len), ...(style ? STYLES[style] ?? {} : {}) };
  let media = doc.media, owned = [];
  if (text !== undefined) {
    if (h.type !== "text") throw new Error(`“${h.name}” isn't a title`);
    next.textContent = String(text);
    media = (doc.media ?? []).map((m) => (m.id === h.mediaItemId ? { ...m, data: { ...m.data, content: String(text), fileName: `Text: ${String(text)}` } } : m));
    owned = [h.mediaItemId];
  }
  const t0 = Date.now();
  await save(doc, { ...doc, media, timelineItems: doc.timelineItems.map((i) => (i.id === h.id ? next : i)) }, { ownedMediaIds: owned });
  const out = { id: h.id, name: next.name, start: next.startTime, end: next.endTime, savedMs: Date.now() - t0 };
  emit({ type: "self", op: "edit", ...out });
  return out;
}

// ------------------------------------------------------------------ the control socket
const OPS = {
  async status() {
    const live = projectId() ? await call("carton.liveStatus", { projectId: projectId() }).catch((e) => ({ error: String(e?.message ?? e) })) : null;
    let cuts = null, cut = null, project = null;
    if (projectId()) {
      const lc = await handle().catch(() => null);
      if (lc) { cuts = (await lc.carton.cuts()).map((c) => ({ name: c.name, id: c.id, where: c.tracking ? "read-only" : c.sequencer?.kind === "server" ? "shared" : "this computer only" })); cut = cuts.find((c) => c.id === lc.carton.cut)?.name ?? null; }
      const doc = await call("projects.read", projectId()).catch(() => null);
      project = doc ? { id: doc.id, name: doc.name, items: doc.timelineItems?.length ?? 0, duration: Math.max(0, ...(doc.timelineItems ?? []).map((i) => i.endTime)) } : null;
    }
    return { name: cfg.name, as: cfg.agent ? `${firstName(cfg.name)}'s ${cfg.agent.name}` : firstName(cfg.name), agent: cfg.agent ?? null, pid: process.pid, project, cut, cuts, live, presence: presenceState, mine: cfg.mine ?? [], sounds: soundsState() };
  },
  /** Waits (up to `timeout` s) until every sound this participant sent is on the server, checked; says which aren't. */
  settle,
  async join({ link, name }) {
    if (projectId()) throw new Error("Already in a project; leave it first");
    const r = await call("carton.liveJoin", { link, name: name ?? cfg.name });
    cfg.projectId = r.projectId; cfg.projectName = r.name; cfg.joinedAt = Date.now(); saveCfg();
    const lc = await handle();
    watchHandle(r.bundlePath, lc);
    await sendPresence(cfg.agent ? { activity: cfg.activity ?? "Working on the edit" } : { activity: cfg.activity ?? "Editing" });
    emit({ type: "self", op: "join", project: r.name });
    return r;
  },
  async adopt({ projectId: id }) {
    // the app stand-in: a project made in this library by cb (create), before it is shared
    const list = await call("projects.list");
    const p = id ? list.find((x) => x.id === id) : list.length === 1 ? list[0] : null;
    if (!p) throw new Error("Which project? " + list.map((x) => `${x.name} (${x.id})`).join(", "));
    cfg.projectId = p.id; cfg.projectName = p.name; saveCfg();
    return { projectId: p.id, name: p.name };
  },
  async share({ host }) {
    const r = await call("carton.liveShare", { projectId: projectId(), host, name: cfg.name, withMedia: true });
    cfg.shared = true; cfg.host = host; saveCfg();
    const lc = await handle();
    watchHandle(api.bundleOf(projectId()), lc);
    await sendPresence({ activity: "Editing" });
    return r;
  },
  invite: ({ role = "editor" }) => call("carton.liveInvite", { projectId: projectId(), role }),
  say, speak, speakAll, clear, edit,
  async presence({ activity, idle, gone }) {
    await sendPresence(gone ? null : idle ? { activity: null, idle: true } : { activity: activity ?? (cfg.agent ? "Working on the edit" : "Editing") });
    return { presence: presenceState };
  },
  read: () => read(),
  async cuts() { const lc = await handle(); return { current: lc.carton.cut, cuts: await lc.carton.cuts() }; },
  // any cut's state as this computer holds it (rehearsal checks: race-hide.js reads the person's cut this way)
  async cutDoc({ name }) {
    const lc = await handle(), c = (await lc.carton.cuts()).find((x) => x.name === name || x.id === name);
    if (!c) throw new Error(`No cut “${name}” here`);
    const { doc, ref } = await lc.carton.head(c.id);
    return { cut: c.name, seq: ref.seq, tracks: doc.tracks ?? [], items: doc.timelineItems ?? [], media: (doc.media ?? []).map((m) => ({ id: m.id, type: m.data?.type ?? null, fileName: m.data?.fileName ?? null })) };
  },
  async log({ cut, limit = 20 }) { const lc = await handle(); return lc.carton.log({ cut, limit, summary: true }); },
  async sync() { const lc = await handle(); return { cut: lc.carton.cut, state: lc.carton.sync?.state() ?? null, error: lc.carton.sync?.error?.() ?? null }; },
  async media({ mediaId }) { return { source: await call("carton.liveMediaSource", { mediaId }), here: await call("carton.liveMediaHere", { projectId: projectId(), mediaIds: [mediaId] }) }; },
  async worker({ method, args = [] }) { return call(method, ...args); },
  // `peer leave` settles first (and says so): leaving with a sound not yet on the server would leave it nowhere
  async leave() {
    await sendPresence(null).catch(() => {});
    setTimeout(() => process.exit(0), 300);
    return { left: true };
  },
};

function serve() {
  const sock = path.join(DIR, "ctl.sock");
  fs.rmSync(sock, { force: true });
  const server = net.createServer((c) => {
    let buf = "", unwatch = null;
    c.on("error", () => {});
    c.on("close", () => unwatch?.());
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.op === "raw") {
          const send = (ev) => { if (!c.destroyed) c.write(JSON.stringify({ raw: ev }) + "\n"); };
          rawWatchers.add(send);
          unwatch = () => rawWatchers.delete(send);
          continue;
        }
        if (m.op === "watch") {
          const send = (ev) => { if (!c.destroyed) c.write(JSON.stringify({ event: ev }) + "\n"); };
          if (m.args?.since) for (const ev of recent) if (ev.at >= m.args.since) send(ev);
          watchers.add(send);
          unwatch = () => watchers.delete(send);
          continue;
        }
        const f = OPS[m.op];
        const t0 = Date.now();
        Promise.resolve().then(() => { if (!f) throw new Error("No such thing: " + m.op); return f(m.args ?? {}); })
          .then((data) => { log(m.op, "ok", Date.now() - t0 + " ms"); c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n"); },
            (e) => { log(m.op, "failed:", String(e?.message ?? e)); c.write(JSON.stringify({ id: m.id, ok: false, error: String(e?.message ?? e) }) + "\n"); });
      }
    });
  });
  server.listen(sock, () => log("listening", sock));
}

(async () => {
  log("starting", cfg.name, cfg.agent ? "as " + cfg.agent.name : "as a person", "build", b.commit);
  ({ call, events } = await require(path.join(lib.REPO, "scripts", "carton", "test", "worker-harness.js")).start(b.worker, cfg.root));
  // the worker's posts, each as it is posted (the harness pushes them into `events`; nothing waits for a poll, so a
  // `shown` is timed when the worker tells main, as main would hear it)
  const take = (e) => {
    // the worker's posts as main gets them (shots.js plays main for Cardboard's pages)
    if (e.kind === "change" && (e.change?.kind === "carton" || e.change?.kind === "changed")) for (const w of rawWatchers) w(e.change);
    // the Share status (who is here, sync) as the app's pages get it
    if (e.change?.kind === "carton" && e.change.topic === "live" && e.change.id === projectId()) takeLive(e.change.live);
    // project.json now shows head: the moment main tells the editor's pages to take it
    else if (e.kind === "change" && e.change?.kind === "changed" && e.change.id === projectId()) emit({ type: "shown" });
  };
  for (const e of events.splice(0)) take(e);
  events.push = (...xs) => { for (const e of xs) { try { take(e); } catch (err) { log("event", String(err?.message ?? err)); } } return 0; };
  if (projectId()) {
    // a participant started again (after a crash or a reboot of this box): its project goes live again, as in the app
    // (once the library has listed it and its history has opened)
    let lc = null;
    for (let i = 0; i < 100 && !lc; i++) {
      await call("projects.list").catch(() => {});
      lc = await handle().catch(() => null);
      if (!lc) await new Promise((r) => setTimeout(r, 100));
    }
    if (!lc) lc = await handle();
    watchHandle(api.bundleOf(projectId()), lc);
    await call("carton.liveStatus", { projectId: projectId() }).catch(() => {});
    if (cfg.joinedAt || cfg.shared) await sendPresence(cfg.agent ? { activity: cfg.activity ?? "Working on the edit" } : { activity: "Editing" }).catch(() => {});
  }
  serve();
  const bye = async () => { try { await sendPresence(null); } catch {} setTimeout(() => process.exit(0), 300); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
})().catch((e) => { log("fatal", String(e?.stack ?? e)); process.exit(1); });
