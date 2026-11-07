// `peer run <cues.yaml>`: a cue sheet, one step at a time (sample-cues.yaml says what each step can be). A step acts on
// this side (say, speak, edit, clear, presence), or waits for something on the other side, read from the participant's
// live stream (`peer watch`): an edit by someone else whose words or titles contain something, a person or agent
// arriving or leaving, a new cut. Each step is printed as it starts and ends, with the time, and the run's log is kept
// (gfv-scratch/carton/demo/runs/). A rehearsal sheet can also play the app's side from this box (`as: <participant>`,
// and `agent_say` / `cb` steps, which run Cardboard's own cb on that participant's library as its agent would).
const fs = require("fs"), path = require("path"), readline = require("readline");
const { execFileSync, spawn } = require("child_process");
const lib = require("./lib.js");

function load(file) {
  if (!file || !fs.existsSync(file)) throw new Error("peer run <cues.yaml>: no such file " + file);
  const text = fs.readFileSync(file, "utf8");
  if (/\.json$/i.test(file)) return JSON.parse(text);
  // YAML through the box's python3 (PyYAML): the sheet is the user's to write, so a full YAML reader
  let json;
  try { json = execFileSync("python3", ["-I", "-c", "import sys, json, yaml; json.dump(yaml.safe_load(open(sys.argv[1], encoding='utf-8')), sys.stdout)", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`${path.basename(file)} isn't valid YAML: ` + String(e.stderr ?? e.message).trim().split("\n").slice(-3).join(" ")); }
  return JSON.parse(json);
}

// words compared as they read: a title wrapped onto lines ("I'll tell\nhim") still matches "tell him"
const low = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ");
const has = (s, w) => low(s).includes(low(w));
/** Does `ev` (one of the stream's events) meet `w` (a step's `wait`)? */
function meets(ev, w) {
  if (ev.type === "edit" && !ev.mine) {
    const texts = [ev.what, ...ev.rows.map((r) => `${r.text} ${r.name ?? ""} ${r.words ?? ""}`)];
    if (w.title !== undefined && ev.rows.some((r) => r.kind !== "remove" && r.type === "text" && (has(r.words, w.title) || has(r.name, w.title) || has(r.text, w.title)))) return byOk(ev, w);
    if (w.words !== undefined && texts.some((x) => has(x, w.words))) return byOk(ev, w);
    if (w.removed !== undefined && ev.rows.some((r) => r.kind === "remove" && (has(r.name, w.removed) || has(r.text, w.removed)))) return byOk(ev, w);
    if (w.any_edit) return byOk(ev, w);
    if (w.by !== undefined && w.title === undefined && w.words === undefined && w.removed === undefined && has(ev.by, w.by)) return true;
  }
  if (ev.type === "presence") {
    if (w.here !== undefined && ev.change !== "left" && has(ev.who, w.here) && (w.activity === undefined || has(ev.activity, w.activity))) return true;
    if (w.left !== undefined && ev.change === "left" && has(ev.who, w.left)) return true;
  }
  if (ev.type === "cuts") {
    if (w.new_cut && ev.added.length) return true;
    if (w.cut !== undefined && [...ev.added.map((c) => c.name), ...ev.renamed.map((c) => c.to)].some((n) => has(n, w.cut))) return true;
  }
  return false;
}
const byOk = (ev, w) => w.by === undefined || has(ev.by, w.by);

const fmt = (o) => Object.entries(o).filter(([k]) => k !== "timeout" && k !== "since").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");

async function run(file, { from = 1, dry = false, peer } = {}) {
  const sheet = load(file);
  const steps = Array.isArray(sheet) ? sheet : sheet?.cues;
  if (!Array.isArray(steps)) throw new Error("A cue sheet is a list of steps (or {cues: [...]})");
  const dflt = peer || (!Array.isArray(sheet) && sheet?.as) || (fs.existsSync(path.join(lib.DEMO, "current-peer")) ? fs.readFileSync(path.join(lib.DEMO, "current-peer"), "utf8").trim() : null);
  const runs = path.join(lib.DEMO, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const base = path.join(runs, `${path.basename(file).replace(/\.\w+$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const logf = fs.openSync(base + ".log", "a"), jsonl = fs.openSync(base + ".jsonl", "a");
  const out = (s) => { process.stdout.write(s + "\n"); fs.writeSync(logf, s + "\n"); };
  const rec = (o) => fs.writeSync(jsonl, JSON.stringify({ at: Date.now(), ...o }) + "\n");
  const t0 = Date.now();
  const stamp = () => `${lib.clock()} +${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

  // each participant's stream, kept from the start of the run
  const streams = new Map();
  const streamOf = (name) => {
    if (!streams.has(name)) {
      const dir = lib.peerDir(name), events = [], waiters = new Set();
      const s = lib.subscribe(dir, (ev) => {
        events.push(ev);
        rec({ stream: name, event: ev });
        const l = lib.line(ev);
        if (l) out(`${stamp()}   [${name} sees] ${l.split("\n")[0].slice(13)}`);
        for (const w of waiters) w(ev);
      }, { since: t0 - 1000 });
      streams.set(name, { dir, events, waiters, close: s.close });
    }
    return streams.get(name);
  };
  const dirOf = (name) => {
    const dir = lib.peerDir(name);
    if (!fs.existsSync(path.join(dir, "peer.json"))) throw new Error(`No participant "${name}" (peer list)`);
    return dir;
  };
  // every participant the sheet names is running before the first step (a dry run only lists the steps)
  if (!dry) for (const who of new Set([dflt, ...steps.map((s) => s.as)].filter(Boolean))) {
    await lib.request(dirOf(who), "status", {}, { timeout: 5000 }).catch((e) => { throw new Error(`${who}: ${e.message}`); });
    streamOf(who);
  }
  out(`${stamp()}  ▶ ${path.basename(file)}: ${steps.length} steps${dry ? " (dry run: nothing is done)" : ""}, as ${dflt ?? "?"}  log: ${base}.log`);

  // Every spoken line made before the first step (speech takes seconds: never on a recording's clock), kept by its words,
  // voice and speed, so a sheet run again makes none
  const voices = new Map();
  if (!dry) {
    const lines = steps.slice(from - 1).filter((s) => s.speak && !s.file && !s.parts);
    if (lines.length) out(`${stamp()}  making ${lines.length} spoken line${lines.length === 1 ? "" : "s"}…`);
    for (const s of lines) {
      const key = require("crypto").createHash("sha256").update(JSON.stringify([s.speak, s.voice ?? "ryan", s.speed ?? 1])).digest("hex").slice(0, 12);
      const file = path.join(lib.DEMO, "voice-cache", key, voiceName(s.speak));
      if (!fs.existsSync(file)) await require("./tts.js").synth(s.speak, { voice: s.voice ?? "ryan", speed: s.speed ?? 1, out: file });
      voices.set(s, file);
    }
    if (lines.length) out(`${stamp()}  spoken lines ready`);
  }

  let ok = true;
  for (let i = from - 1; i < steps.length; i++) {
    const s = steps[i], n = i + 1, who = s.as ?? dflt;
    if (!who) throw new Error("Which participant? Set `as:` at the top of the sheet, or --peer");
    const label = s.label ? ` ${s.label}:` : "";
    const kind = ["say", "speak", "edit", "clear", "presence", "wait", "pause", "prompt", "cb", "agent_say", "agent_clear", "agent_hide", "note", "leave"].find((k) => k in s);
    if (!kind) { out(`${stamp()}  ✗ ${n}. unknown step ${JSON.stringify(s)}`); ok = false; break; }
    out(`${stamp()}  ${n}.${label} ${who}: ${kind} ${typeof s[kind] === "object" ? fmt(s[kind]) : JSON.stringify(s[kind])}`);
    if (dry) continue;
    const dir = dirOf(who);
    streamOf(who);
    const started = Date.now();
    try {
      let r;
      switch (kind) {
        case "note": r = null; break;
        case "pause": await new Promise((res) => setTimeout(res, Number(s.pause) * 1000)); break;
        case "prompt": {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await new Promise((res) => rl.question(`               ${s.prompt} [Enter] `, () => { rl.close(); res(); }));
          break;
        }
        case "say": r = await lib.request(dir, "say", { text: s.say, at: s.at, dur: s.for, style: s.style, name: s.name, track: s.track, color: s.color, size: s.size, y: s.y }); break;
        case "speak": {
          // a line in parts (each its own file and spot): imported, shared and placed together
          if (Array.isArray(s.parts)) { r = await lib.request(dir, "speakAll", { parts: s.parts, track: s.track, volume: s.volume }); break; }
          let file = s.file ?? voices.get(s), made = null;
          if (!file) { made = await require("./tts.js").synth(s.speak, { voice: s.voice ?? "ryan", speed: s.speed ?? 1, out: path.join(dir, "voice", voiceName(s.speak)) }); file = made.file; }
          r = await lib.request(dir, "speak", { file, text: s.speak, at: s.at, name: s.name, track: s.track, volume: s.volume });
          if (made) r.voiceMs = made.ms;
          break;
        }
        case "edit": r = await lib.request(dir, "edit", { clip: s.edit, text: s.text, at: s.at, dur: s.for, style: s.style }); break;
        case "clear": r = await lib.request(dir, "clear", { clip: s.clear, all: !!s.all }); break;
        case "presence": r = await lib.request(dir, "presence", s.presence === "idle" ? { idle: true } : s.presence === "gone" ? { gone: true } : { activity: s.presence }); break;
        case "leave": r = await lib.request(dir, "leave"); break;
        case "cb": r = cbStep(dir, s, out, stamp); break;
        case "agent_say": r = agentSay(dir, s); break;
        case "agent_clear": r = agentClear(dir, s); break;
        case "agent_hide": r = await agentHide(dir, s, out, stamp); break;
        case "wait": {
          const w = typeof s.wait === "number" ? null : s.wait;
          if (!w) { await new Promise((res) => setTimeout(res, s.wait * 1000)); break; }
          const st = streamOf(w.on ?? who);
          const since = w.since === "start" ? t0 : started;
          const hit = st.events.find((ev) => ev.at >= since && meets(ev, w));
          r = hit ?? (await new Promise((res, rej) => {
            const f = (ev) => { if (meets(ev, w)) { st.waiters.delete(f); clearTimeout(tm); res(ev); } };
            const tm = setTimeout(() => { st.waiters.delete(f); rej(new Error(`waited ${w.timeout ?? 300} s: ${fmt(w)}`)); }, (w.timeout ?? 300) * 1000);
            st.waiters.add(f);
          }));
          r = { matched: r.type, by: r.by ?? r.who, what: r.what ?? r.activity ?? null, lagMs: r.madeAt ? r.seenAt - r.madeAt : null };
          break;
        }
      }
      rec({ step: n, as: who, kind, cue: s, result: r ?? null, ms: Date.now() - started });
      out(`${stamp()}  ✓ ${n}. ${summary(kind, r)} (${((Date.now() - started) / 1000).toFixed(2)} s)`);
    } catch (e) {
      rec({ step: n, as: who, kind, cue: s, error: String(e?.message ?? e) });
      out(`${stamp()}  ✗ ${n}. ${e?.message ?? e}`);
      if (s.on_fail !== "continue") { ok = false; out(`${stamp()}  stopped. Go on from here with: peer run ${file} --from ${n}`); break; }
    }
  }
  await new Promise((res) => setTimeout(res, 1500)); // the last edits' echoes, into the log
  for (const st of streams.values()) st.close();
  out(`${stamp()}  ${ok ? "■ done" : "■ stopped"}  log: ${base}.log`);
  if (!ok) process.exitCode = 1;
}

const clip = (t) => { const x = String(t).replace(/\s+/g, " ").trim(); return x.length > 40 ? x.slice(0, 39) + "…" : x; };
const voiceName = (text) => (String(text).replace(/[^\p{L}\p{N} '-]+/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ") || "line") + ".wav";
function summary(kind, r) {
  if (!r) return kind;
  if (kind === "say" || kind === "speak" || kind === "edit") return `“${r.name}” ${r.start?.toFixed(1)}–${r.end?.toFixed(1)} s on ${r.track ?? "its track"} (${kind === "speak" ? `imported in ${(r.importedMs / 1000).toFixed(2)} s, on the server in ${((r.sharedMs ?? 0) / 1000).toFixed(2)} s, on the timeline at` : "saved in"} ${(r.savedMs / 1000).toFixed(2)} s${r.voiceMs ? `, voice made in ${(r.voiceMs / 1000).toFixed(2)} s` : ""})`;
  if (kind === "clear") return `removed ${r.removed.map((x) => `“${x}”`).join(", ")}`;
  if (kind === "wait" && r.matched) return `seen: ${r.by} ${r.what ?? ""}${r.lagMs !== null ? ` (${(r.lagMs / 1000).toFixed(2)} s after it was made)` : ""}`;
  if (kind === "cb" || kind === "agent_say" || kind === "agent_clear" || kind === "agent_hide") return r.text;
  return kind;
}

// ------------------------------------------------------------------ the app's agent, played from this box (rehearsals)
// Cardboard's own cb on the participant's library, under the agent's name (CARDBOARD_ACTOR, as the app's Director hook
// sets it), each command printed with its answer.
const ACTOR = (s) => s.actor ?? "director/rehearsal/turn1";
function cbStep(dir, s, out, stamp) {
  const cmds = Array.isArray(s.cb[0]) ? s.cb : [s.cb];
  const texts = [];
  for (const c of cmds) {
    const args = c.map((x) => (x === "$version_before_chat" ? versionBefore(dir, s) : String(x)));
    const r = lib.cb(dir, args, { actor: ACTOR(s), json: false });
    for (const l of (r.out + r.err).trim().split("\n").filter(Boolean).slice(0, 14)) out(`${stamp()}      $ cb ${args.slice(0, 3).join(" ")}… │ ${l}`);
    if (r.code !== 0 && s.on_fail !== "continue") throw new Error(`cb ${args.join(" ")} failed: ${(r.out + r.err).trim().split("\n").slice(-2).join(" ")}`);
    texts.push(`cb ${args.slice(0, 2).join(" ")}: exit ${r.code} in ${(r.ms / 1000).toFixed(2)} s`);
  }
  return { text: texts.join("; ") };
}
/**
 * The version just before the chat began: walking the cut's history from its start, each version's own change in
 * words (cb compare <previous> <version>), the one before the first that touches a chat track (`chat_tracks`, default
 * Talk and Voice: "Added track 'Talk'", "Added title '…' on 'Talk' at 3.5 s").
 */
function versionBefore(dir, s) {
  const cut = s.cut_from ?? "Main cut", tracks = s.chat_tracks ?? ["Talk", "Voice"];
  // the whole history, oldest first (cb history lists the newest first, 1000 at most): a shorter list began mid-chat
  // once the cut had more versions than it held, and the person's cut was then made from a version with chat in it
  if (s.before) return s.before;
  const h = lib.cb(dir, ["history", s.project, "--cut", cut, "--limit", "1000"], { actor: ACTOR(s) }).json().versions.slice().reverse();
  if (h.length >= 1000 && h[0].ref?.seq > 0) throw new Error(`${cut} has more than 1000 versions: say which is the last before the chat (before: <cut>@<seq>)`);
  for (let i = 1; i < h.length; i++) {
    const r = lib.cb(dir, ["compare", s.project, h[i - 1].version, h[i].version], { actor: ACTOR(s) }).json();
    if (r.changes.some((c) => tracks.some((t) => c.includes(`'${t}'`)))) return h[i - 1].version;
  }
  throw new Error(`no chat on ${cut} yet (nothing on ${tracks.join(" or ")})`);
}
// The agent's line: its own view of the timeline (cb source print --view), a <text> added on the chat's track, applied
// with cb source apply, as Cardboard's agents edit.
function agentSay(dir, s) {
  const p = lib.cb(dir, ["source", "print", s.project, "--view", "rehearsal"], { actor: ACTOR(s) });
  if (p.code !== 0) throw new Error("print --view: " + (p.out + p.err).slice(0, 400));
  const file = p.json().view.file;
  let tsx = fs.readFileSync(file, "utf8");
  const track = s.track ?? "Talk";
  const look = s.look ?? 'zIndex={100} fontSize={52} color="#16181d" textAlign="right" backgroundColor="#f2f2f2" backgroundOpacity={0.92} backgroundPadding={28} transform={{ x: 420, y: 300, scale: 1, rotation: 0 }}';
  // braces: a JS string literal, so quotes and line breaks in the words survive (cb docs source: "Escapes need braces")
  const text = `      <text name={${JSON.stringify(s.name ?? clip(s.agent_say))}} start={${s.at}} end={${s.at + (s.for ?? 3)}} textContent={${JSON.stringify(String(s.agent_say))}} ${look} />\n`;
  const open = new RegExp(`(<track[^>]*name="${track}"[^>]*>\\n)`);
  tsx = open.test(tsx) ? tsx.replace(open, `$1${text}`) : tsx.replace(/(<timeline[^>]*>\n)/, `$1    <track name="${track}">\n${text}    </track>\n`);
  const f2 = file.replace(/\.tsx$/, `.say-${Date.now()}.tsx`);
  fs.writeFileSync(f2, tsx);
  const a = lib.cb(dir, ["source", "apply", s.project, f2], { actor: ACTOR(s) });
  fs.rmSync(f2, { force: true });
  if (a.code !== 0) throw new Error("apply: " + (a.out + a.err).slice(0, 600));
  return { text: `the agent's “${s.agent_say}” applied at ${s.at} s on ${track} (print + apply ${((p.ms + a.ms) / 1000).toFixed(2)} s)` };
}
function agentClear(dir, s) {
  const r = lib.cb(dir, ["restore", s.project, s.from ?? "now", "--clip", s.agent_clear, ...(s.remove ? ["--remove"] : [])], { actor: ACTOR(s), json: false });
  if (r.code !== 0) throw new Error((r.out + r.err).slice(0, 400));
  return { text: r.out.trim().split("\n")[0] };
}

/**
 * The agent hides the chat from the person (FINDINGS.md §4), with Cardboard's own cb only, as the laptop's agent would:
 *   1. the version just before the chat began (versionBefore);
 *   2. `cb cut new <cut> --from <it>`: a cut of the person's own, on this computer only (the editor doesn't follow);
 *   3. `cb source print --view`: the shared cut as it is now, at an exact version (its header); from that one print, what
 *      to keep out: the chat's tracks, every clip on them, those clips' media (a title's text entry from project.json),
 *      and a teammate's media no clip uses yet (a sound whose clip isn't placed yet);
 *   4. `cb fold <that version> --into <cut> --reject …`: exactly that version, so a line that lands on the shared cut
 *      meanwhile can't come in (folding the cut's moving head did, in the first cross-machine rehearsal: a line landed
 *      between the reading and the fold, on a "Missing track");
 *   5. `cb compare <version before> <cut>`: nothing of the chat there (no line naming its tracks, clips or media);
 *   6. `cb cut switch <cut>`, last: the person's editor shows it, and the teammate sees them leave the shared cut only
 *      now, after the fold.
 * If step 5 finds something anyway, the cut is switched to and each such clip taken out at once with `cb restore <version
 * before> --clip <id> --remove` (cb writes to the current cut only), and the answer says so.
 */
async function agentHide(dir, s, out, stamp) {
  const cut = s.agent_hide, tracks = s.chat_tracks ?? ["Talk", "Voice"], from = s.cut_from ?? "Main cut";
  const run = (a, { json = false, quiet = false } = {}) => {
    const r = lib.cb(dir, a, { actor: ACTOR(s), json });
    if (!quiet) out(`${stamp()}      $ cb ${a.slice(0, 5).join(" ")}${a[0] === "fold" ? ` … (${a.filter((x) => x === "--reject").length} kept out)` : a.length > 5 ? " " + a.slice(5).join(" ") : ""} │ ${(r.out + r.err).trim().split("\n")[0].slice(0, 160)}`);
    if (r.code !== 0) throw new Error(`cb ${a.slice(0, 3).join(" ")} failed: ${(r.out + r.err).trim().slice(0, 300)}`);
    return r;
  };
  // A cut's name can be taken twice, and `--into <name>` then means the first cut with it (cli-mcp refs.ts resolveCut):
  // a second hide under the same name would fold into the old cut. So a taken name is refused, and the new cut is
  // named by its id from here on.
  const taken = run(["cut", "list", s.project], { json: true, quiet: true }).json().cuts.find((c) => c.name.toLowerCase() === String(cut).toLowerCase());
  if (taken) throw new Error(`a cut named “${taken.name}” is already there (${taken.id.slice(0, 8)}): name the person's cut something else`);
  const before = versionBefore(dir, { ...s, cut_from: from, chat_tracks: tracks });
  const made = run(["cut", "new", s.project, cut, "--from", before]);
  const id = /\(([0-9a-f]{8})\)\s*$/.exec(made.out.trim())?.[1]; // New cut "Vikas's cut" (df2006ff): enough of its id for cb
  if (!id) throw new Error("cb cut new answered no cut: " + made.out.slice(0, 200));
  // (race-hide.js --old-flow only: the first cross-machine rehearsal's order, the switch before the fold, and the shared
  // cut's moving head folded; it shows the leak and the safety net)
  const old = !!s.old_flow;
  // the shared cut now, at one exact version, from one print (the editor is still on it)
  const view = run(["source", "print", s.project, "--view", "hide"], { json: true, quiet: true }).json().view;
  const v = readView(view.file);
  // a title's text entry is in project.json (the print names only file media); read off disk, as the agent reads it,
  // once it holds every chat clip of the print (the worker writes it a moment after each change)
  const file = path.join(lib.readJson(path.join(dir, "peer.json")).root, `${s.project}.cardboard`, "project.json");
  const printed = v.tracks.filter((t) => tracks.includes(t.name)).flatMap((t) => t.items.map((i) => i.id));
  let onDisk = new Map();
  for (let i = 0; i < 60; i++) {
    try { onDisk = new Map((JSON.parse(fs.readFileSync(file, "utf8")).project?.timelineItems ?? []).map((x) => [x.id, x.mediaItemId])); } catch {}
    if (printed.every((x) => onDisk.has(x))) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  if (old) run(["cut", "switch", s.project, id]);
  const at = view.ref; // "Main cut@12~6d7f0548 b:5f7fb7b0"
  const chatTracks = v.tracks.filter((t) => tracks.includes(t.name));
  const chatItems = chatTracks.flatMap((t) => t.items), others = v.tracks.filter((t) => !tracks.includes(t.name)).flatMap((t) => t.items);
  const usedBy = (items) => new Set(items.flatMap((i) => [i.src ? v.media.get(i.src) : null, onDisk.get(i.id)]).filter(Boolean));
  const keep = usedBy(others), chatMedia = [...usedBy(chatItems)].filter((m) => !keep.has(m));
  // media added since the version before the chat that no clip uses: a teammate's sound still waiting for its clip
  const added = run(["compare", s.project, before, at], { json: true, quiet: true }).json().changes.map((c) => /^Added media '(.+)'$/.exec(c)?.[1]).filter(Boolean);
  const loose = added.map((n) => v.media.get(n)).filter((m) => m && !keep.has(m) && !chatMedia.includes(m));
  const reject = [...chatTracks.map((t) => "tracks/" + t.id), ...chatItems.map((i) => "timelineItems/" + i.id), ...[...chatMedia, ...loose].map((m) => "media/" + m)];
  out(`${stamp()}      (the shared cut at ${at.split(" ")[0]}: ${chatItems.length} chat clips on ${chatTracks.map((t) => t.name).join(", ") || "no chat track"}, ${chatMedia.length + loose.length} media of theirs)`);
  // (race-hide.js only: `_beforeFold` lands a teammate's line right here, after the reading)
  if (s._debug) fs.writeFileSync(s._debug, JSON.stringify({ at, view: view.file, viewText: fs.readFileSync(view.file, "utf8"), reject, chatItems, chatTracks: chatTracks.map((t) => ({ id: t.id, name: t.name, n: t.items.length })) }, null, 1));
  if (typeof s._beforeFold === "function") s._beforeFold();
  // The version as `cb history` names it (main@N): exactly what was printed. A fold that refuses saves nothing ("Not
  // folded in: N cards"): in the race rehearsal (race-hide.js) it refused now and then, with "(parent)" cards for the
  // chat's tracks, when a teammate's line had landed on the shared cut a moment before, and the same fold went through
  // moments later; so it is tried again after a pause, the same version and the same list.
  const version = `${(await cutKind(dir, s, from)) ?? "main"}@${/@(\d+)~/.exec(at)?.[1]}`;
  for (let tries = 1; ; tries++) {
    try { run(["fold", s.project, old ? from : version, "--into", id, ...reject.flatMap((r) => ["--reject", r])]); break; }
    catch (e) {
      if (!/Not folded in: \d+ cards?/.test(e.message) || tries >= 4) throw e;
      out(`${stamp()}      (the fold refused with cards, nothing saved; again in ${tries} s)`);
      await new Promise((res) => setTimeout(res, tries * 1000));
    }
  }
  // Nothing of the chat in the person's cut: compared with the version before the chat, it may only have gained tracks,
  // clips and media from outside the chat in the version folded in. Anything else is a leak: a chat track or clip, a
  // clip whose track isn't there ("on another track"), media of theirs. (cb compare cuts long names with "…".)
  const fits = (name, allowed) => [...allowed].some((n) => n === name || (name.endsWith("…") && n.startsWith(name.slice(0, -1))));
  const okTracks = new Set(v.tracks.filter((t) => !tracks.includes(t.name)).map((t) => t.name));
  const okClips = new Set(others.map((i) => i.name).filter(Boolean));
  const okMedia = new Set([...v.media].filter(([, id]) => keep.has(id)).map(([n]) => n));
  const leaked = (l) => {
    if (/ on another track\b|'Missing track'/.test(l) || tracks.some((t) => l.includes(`'${t}'`))) return true;
    let m;
    if ((m = /^Added track '(.+?)'/.exec(l))) return !fits(m[1], okTracks);
    if ((m = /^Added media '(.+)'$/.exec(l))) return !fits(m[1], okMedia);
    if ((m = /^Added (?!track |media )\S+ '(.+?)'(?: on | at |$)/.exec(l))) return !fits(m[1], okClips);
    return false;
  };
  const lines = run(["compare", s.project, before, id], { json: true, quiet: true }).json().changes;
  const leaks = lines.filter(leaked);
  if (!old) run(["cut", "switch", s.project, id]);
  let fixed = [];
  if (leaks.length) {
    // the safety net: cb writes only to the current cut, so this shows for a moment
    out(`${stamp()}      ✗ leaked into “${cut}”: ${leaks.join("; ")}`);
    const now = readView(run(["source", "print", s.project, "--view", "hide"], { json: true, quiet: true }).json().view.file);
    const theirs = new Set(chatItems.map((i) => i.id));
    // a chat clip by its id, anything on a chat track, or a clip a leaked line names
    const suspect = (t, i) => theirs.has(i.id) || tracks.includes(t.name) || leaks.some((l) => i.name && l.includes(`'${i.name}'`));
    for (const t of now.tracks) for (const i of t.items) {
      if (!suspect(t, i)) continue;
      run(["restore", s.project, before, "--clip", i.id, "--remove"]);
      fixed.push(i.name ?? i.id);
    }
  }
  return { text: `the person's editor is on “${cut}” (from ${before}, ${at.split(" ")[0]} folded in); ${chatItems.length} chat clips, ${chatTracks.length} tracks and ${chatMedia.length + loose.length} media kept out${fixed.length ? `; ${fixed.length} leaked clip${fixed.length === 1 ? "" : "s"} taken out after the switch: ${fixed.map((n) => `“${n}”`).join(", ")}` : leaks.length ? `; leaks seen, none could be taken out: ${leaks.join("; ")}` : "; nothing of the chat came in"}`, at, before, reject, leaks, fixed };
}

/** How `cb history` names a cut's versions ("main" for the Main cut: main@12). */
async function cutKind(dir, s, cut) {
  const h = lib.cb(dir, ["history", s.project, "--cut", cut, "--limit", "1"], { actor: ACTOR(s) }).json().versions[0];
  return h?.version?.split("@")[0] ?? null;
}

/** An agent's view file (cb source print --view): its tracks with their clips (id, name, src), and its media by name. */
function readView(file) {
  const text = fs.readFileSync(file, "utf8");
  const media = new Map();
  for (const m of text.matchAll(/^\/\/ {3}(.+?) {2,}.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/gm)) media.set(m[1].trim(), m[2]);
  const tracks = [];
  for (const block of text.split(/\n\s*<track\b/).slice(1)) {
    const head = /^([^>]*)>/.exec(block)?.[1] ?? "";
    const attr = (src, k) => new RegExp(`\\b${k}=(?:"([^"]*)"|\\{"((?:[^"\\\\]|\\\\.)*)"\\})`).exec(src)?.slice(1).find((x) => x !== undefined);
    const items = [];
    for (const el of block.split(/<\/track>/)[0].split(/\n\s*<(?=[a-z])/).slice(1)) {
      const tag = /^([a-z]+)/.exec(el)?.[1];
      if (!tag || tag === "track") continue;
      items.push({ tag, id: attr(el, "id"), name: attr(el, "name") ?? null, src: attr(el, "src") ?? null });
    }
    tracks.push({ id: attr(head, "id"), name: attr(head, "name"), items: items.filter((i) => i.id) });
  }
  return { tracks, media };
}

module.exports = { run, meets, load, voiceName, agentHide, versionBefore, readView };
