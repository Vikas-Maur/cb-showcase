// A scripted stand-in for the Anthropic Messages API, for the demo's "Claude 1" (scripts/demo/skit/README.md). The real
// Claude Code that Cardboard runs as the person's own agent (provider "claude": ANTHROPIC_BASE_URL reaches it, unlike the
// Director's, which Cardboard points at its own gateway) talks to this instead of a model. The chat panel, its thinking
// rows, the tool runs (real `cb`), History: all real; only the model's answers come from a scene file.
//   node actor.js --scene <scene.json> [--port 8787] [--log <file>] [--cb '<json array: how to run cb>']
// On Windows with Cardboard's own Node: set ELECTRON_RUN_AS_NODE=1, then "<Cardboard>\Cardboard.exe" actor.js …
//
// It never talks to Anthropic or anywhere else, and it never reads, logs or keeps request headers (an API key or a
// sign-in the client sends stays unread). Its log keeps, per request: the time, the path, what kind of request it was,
// and what it answered.
//
// Requests:
//   POST /v1/messages with tools: the scene's next message, streamed as the API streams it (thinking, partial text, a
//     tool call). Which message is next comes from the conversation itself: the tool calls the scene made carry ids
//     `toolu_actor_<n>`; the next message is the one after the newest of those (so a retry gets the same answer).
//   POST /v1/messages without tools (Cardboard's naming calls: "Name this conversation…", "Name a video editing
//     project…", Carton's "Title this change…"; Claude Code's own side calls): the scene's `names`, else a short word.
//   POST /v1/messages/count_tokens: a count. Anything else: 404, logged.
//
// The scene (JSON): {project, cut, names: {conversation, project, turn, other}, steps: [...]}, each step one of
//   {think: "<words>", ms: 1500}            a thinking row, streamed over ms
//   {say: "<words>", cps: 40}               a chat message, typed at cps characters a second
//   {tool: "Bash", command: "…"}           a tool call (ends the message); also Read {file_path}, Edit {file_path,
//   {tool: "Read", file_path: "{{view}}"}    old_string, new_string}. {{view}}: the view file the last `cb source print
//                                            --view` printed; {{project}}; {{<name>}} saved by a wait
//   {pause: <ms>}                           nothing for that long (before the next block)
//   {wait: {by: "Claude", words: "Added audio 'Hello?'", save: "before_claude", timeout: 900}}
//                                           held until `cb history` on the cut shows a version by that author (a person
//                                           named exactly so; without `by`, anyone) whose change, in `cb compare` words,
//                                           contains `words`; `save` keeps "<cut>@<the version before that author's first
//                                           change since the wait began>" as {{save}} (Claude 2 shares a line's sound
//                                           before its title: the version before the title would hold that sound)
//   {wait: {cue: "gone", timeout: 30}}      held until GET /cue/gone (the operator), or the timeout
//   {wait: {played: 29.9, timeout: 20}}     held until the running app has played up to that timeline second (`cb app
//                                           context`: playing, playhead at or past it), or played and stopped (the
//                                           timeline's end), or the timeout. In place of a fixed pause after `cb app
//                                           play`: a voice that just arrived can load for seconds before playback starts
//                                           (6 s on the Windows laptop), and a `cb app pause` sent before then is lost
//   {wait: {app: {duration: 29.5, items: 11, itemsAtMost: 9}, timeout: 15}}
//                                           held until the running app's editor (`cb app context`) has a timeline at
//                                           least that long, with at least (or at most) that many items, or the timeout.
//                                           A change is in `cb history` before the editor shows it: a seek before then
//                                           stops at the editor's old end (and Play from the end plays from 0), a Play
//                                           before the line's clip is in the editor plays no voice
//   {end: "<words or nothing>"}             the turn's last message (end_turn). Held behind a {wait: {cue: "end"}},
//                                           the turn stays open (the chat panel shows it working) until the operator
//                                           ends it: at the turn's end the panel folds the turn into "Worked for …"
// A message is the blocks up to and including the next tool call. Waits and pauses hold the message's stream (pings
// keep it open) before its next block, so the chat shows nothing new until the other side has acted.
// Quiet scenes ({quiet: true, as: "claude-code/skit"}): the tool calls are the stand-in's own, not Claude Code's (the user,
// take 5: the chat's status line flipped between "Thinking" and a phrase per tool call every 0.5-1 s, and its activity
// row counted commands up; they want it still, "Thinking"). The whole scene is then one message of thinking and lines,
// and each tool step is done here, in its place in the stream: a `cb …` Bash command run with CARDBOARD_ACTOR = `as` (an
// agent of the person's, credited as Claude Code: its view's saves too), an Edit made in the view file on disk (what
// Claude Code's Edit tool does), a Read nothing. Carton applies the view's save as it does Claude Code's.
const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const SCENE_FILE = arg("scene"), PORT = Number(arg("port", 8787)), LOG = arg("log", path.join(process.cwd(), "actor.log"));
if (!SCENE_FILE) { console.error("usage: node actor.js --scene <scene.json> [--port 8787] [--log <file>] [--cb '<json array>']"); process.exit(2); }
const scene = JSON.parse(fs.readFileSync(SCENE_FILE, "utf8"));
const CB = JSON.parse(arg("cb", process.env.ACTOR_CB ?? '["cb"]'));
const vars = { project: scene.project ?? "", ...(scene.vars ?? {}) };
const cues = new Map(); // operator cues: name → resolve

const logf = fs.openSync(LOG, "a");
const log = (o) => { const line = JSON.stringify({ at: new Date().toISOString(), ...o }); fs.writeSync(logf, line + "\n"); if (process.env.ACTOR_QUIET !== "1") process.stdout.write(line.slice(0, 300) + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the scene, as messages
// A message: {holds: [wait|pause before each block], blocks: [{think}|{say}|{tool}], end: bool}
const messages = [];
{
  let cur = { blocks: [] };
  for (const s of scene.steps) {
    if (s.wait !== undefined || s.pause !== undefined) cur.blocks.push({ hold: s });
    else if (s.think !== undefined) cur.blocks.push({ think: s.think, ms: s.ms ?? 1500 });
    else if (s.say !== undefined) cur.blocks.push({ say: s.say, cps: s.cps ?? scene.cps ?? 45 });
    else if (s.tool !== undefined && scene.quiet) cur.blocks.push({ do: s });
    else if (s.tool !== undefined) { cur.blocks.push({ tool: s }); messages.push(cur); cur = { blocks: [] }; }
    else if (s.end !== undefined) { cur.blocks.push({ say: s.end, cps: scene.cps ?? 45 }); cur.end = true; messages.push(cur); cur = null; break; }
    else throw new Error("unknown step: " + JSON.stringify(s));
  }
  if (cur && cur.blocks.length) { cur.end = true; messages.push(cur); }
}
log({ event: "scene", file: SCENE_FILE, messages: messages.length, port: PORT, ...(scene.quiet ? { quiet: true, as: scene.as ?? "claude-code/skit" } : {}) });

// ------------------------------------------------------------------ cb, for the waits
function cb(args) {
  return new Promise((resolve) => {
    const p = spawn(CB[0], [...CB.slice(1), ...args], { env: { ...process.env, CARDBOARD_ACTOR: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }));
    p.on("exit", (code) => resolve({ code, out: out.replace(/^\[carton\][^\n]*\n/gm, ""), err }));
  });
}
// A quiet scene's tool step, done here (see the top): a `cb …` Bash command (its words split as a shell would, for the
// scene's simple quoting), an Edit in the view file, a Read nothing. Logged as "did".
const AS = scene.as ?? "claude-code/skit";
function doTool(t, index) {
  const t0 = Date.now();
  if (t.tool === "Read") { log({ event: "did", index, tool: "Read", file: fill(t.file_path) }); return Promise.resolve(); }
  if (t.tool === "Edit") {
    const file = fill(t.file_path), oldS = fill(t.old_string), newS = fill(t.new_string);
    try {
      const text = fs.readFileSync(file, "utf8"), n = text.split(oldS).length - 1;
      if (n !== 1) { log({ event: "did-error", index, tool: "Edit", file, found: n, old: oldS.slice(0, 60) }); return Promise.resolve(); }
      fs.writeFileSync(file, text.replace(oldS, () => newS));
      log({ event: "did", index, tool: "Edit", file, old: oldS.slice(0, 60), new: newS.slice(0, 80), ms: Date.now() - t0 });
    } catch (e) { log({ event: "did-error", index, tool: "Edit", file, error: e.message }); }
    return Promise.resolve();
  }
  const words = [...fill(t.command).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  if (t.tool !== "Bash" || words[0] !== "cb") { log({ event: "did-error", index, tool: t.tool, error: "only cb commands are done here", command: t.command }); return Promise.resolve(); }
  return new Promise((resolve) => {
    const p = spawn(CB[0], [...CB.slice(1), ...words.slice(1)], { env: { ...process.env, CARDBOARD_ACTOR: AS }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const done = (code) => {
      out = out.replace(/^\[carton\][^\n]*\n/gm, "");
      // the view file a print names (cb source print --view: "Your view "x" is at <path> (version …)")
      const v = /Your view "[^"]*" is at (.+?) \(version /.exec(out);
      if (v) vars.view = v[1].trim();
      log({ event: code === 0 ? "did" : "did-error", index, tool: "Bash", command: fill(t.command), code, ms: Date.now() - t0, out: (out || err).trim().slice(0, 160) });
      resolve();
    };
    p.on("error", (e) => { err = String(e); done(-1); });
    p.on("exit", done);
  });
}
const words = new Map(); // "<cut>|<seq>" → its change in words
async function changeWords(cut, version) {
  const [kind, seq] = [version.split("@")[0], Number(version.split("@")[1])];
  const key = cut + "|" + version;
  if (!words.has(key)) {
    const r = await cb(["compare", vars.project, `${kind}@${seq - 1}`, version, "--json"]);
    if (r.code !== 0) return null;
    try { words.set(key, JSON.parse(r.out).changes.join("\n")); } catch { return null; }
  }
  return words.get(key);
}
// words compared as they read (a title wrapped onto lines still matches its words in one line)
const flatWords = (s) => String(s).replace(/\s+/g, " ");
let lastMatchSeq = null; // a wait looks at versions after the one the previous wait matched
// A wait that matched on one comparison of several versions (below) answers at once, and takes the head for its match;
// the version that held its words is found before the next wait looks (each version's words, cached): else a change
// that landed in the same few seconds (a line's sound, right after its title) would be behind the next wait's start,
// and that wait would never see it.
let unsettled = null;
async function settle() {
  if (!unsettled) return;
  const { versions, words: want, cut } = unsettled;
  unsettled = null;
  for (const v of versions) {
    const said = await changeWords(cut, v.version);
    if (flatWords(said ?? "").includes(flatWords(want))) { lastMatchSeq = Number(v.version.split("@")[1]); return; }
  }
}
async function waitFor(w, alive) {
  const t0 = Date.now(), cut = w.cut ?? scene.cut ?? "Main cut", timeout = (w.timeout ?? 900) * 1000;
  if (w.cue) {
    log({ event: "wait", cue: w.cue });
    await Promise.race([new Promise((r) => cues.set(w.cue, r)), sleep(timeout)]);
    cues.delete(w.cue);
    return;
  }
  if (w.played !== undefined) {
    // (`cb app context` keeps the playhead where playback began until it stops: the time played is counted from the
    // first answer that says "playing", which is at most one answer, ~0.35 s on the laptop, after playback began; when
    // less than one more answer's time is left, the rest is slept, so the pause comes on time however slow cb is)
    log({ event: "wait", played: w.played });
    let started = null, from = null, last = null, polls = 0, unread = 0, unreadSample = null, pollMs = 400;
    while (alive() && Date.now() - t0 < timeout) {
      const p0 = Date.now();
      const r = await cb(["app", "context", vars.project, "--json"]);
      polls++; pollMs = Date.now() - p0;
      try { const c = JSON.parse(r.out); last = { playing: !!c.playing, playhead: c.playhead }; }
      catch { last = null; unread++; unreadSample ??= (r.out + r.err).trim().slice(0, 160); }
      if (last?.playing && started === null) { started = Date.now(); from = last.playhead; }
      if (last && !last.playing && started !== null) break; // stopped (the timeline's end)
      if (started !== null) {
        const left = (w.played - from) * 1000 - (Date.now() - started);
        if (left <= pollMs + 150) { if (left > 0) await sleep(left); break; }
      }
      await sleep(100);
    }
    log({ event: Date.now() - t0 < timeout ? "waited" : "wait-timeout", played: w.played, playbackStartedMs: started && started - t0, from, state: last, ms: Date.now() - t0, polls, pollMs, ...(unread ? { unread, unreadSample } : {}) });
    return;
  }
  if (w.app) {
    const want = w.app, ok = (c) => c && (want.duration === undefined || c.duration >= want.duration - 0.01) && (want.items === undefined || c.items >= want.items) && (want.itemsAtMost === undefined || c.items <= want.itemsAtMost);
    log({ event: "wait", app: want });
    let last = null, polls = 0;
    while (alive() && Date.now() - t0 < timeout) {
      const r = await cb(["app", "context", vars.project, "--json"]);
      polls++;
      try { const c = JSON.parse(r.out); last = { duration: c.duration, items: c.items }; } catch { last = null; }
      if (ok(last)) break;
      await sleep(150);
    }
    log({ event: ok(last) ? "waited" : "wait-timeout", app: want, state: last, polls, ms: Date.now() - t0 });
    return;
  }
  await settle(); // (only before a wait on History: a cue or a play isn't held up by it)
  log({ event: "wait", by: w.by, words: w.words ?? null });
  let from = lastMatchSeq;
  if (from === null) { // the first wait: from the head as the scene began (vars.startSeq, set at the first request)
    from = vars._startSeq ?? 0;
  }
  while (alive()) {
    const r = await cb(["history", vars.project, "--cut", cut, "--limit", "40", "--json"]);
    // words without `save`: one comparison of everything since the last match (one cb call, not one per version), and
    // a version by that author among them
    if (r.code === 0 && w.words && !w.save) {
      let versions = [];
      try { versions = JSON.parse(r.out).versions; } catch {}
      const head = versions[0], theirs = versions.filter((v) => Number(v.version.split("@")[1]) > from && (!w.by || (v.by?.kind === "human" && (v.by.name === w.by || v.by.id === w.by))));
      if (head && theirs.length) {
        const kind = head.version.split("@")[0], top = Number(head.version.split("@")[1]);
        const c = await cb(["compare", vars.project, `${kind}@${from}`, head.version, "--json"]);
        let said = "";
        try { said = JSON.parse(c.out).changes.join("\n"); } catch {}
        if (flatWords(said).includes(flatWords(w.words))) {
          lastMatchSeq = top;
          unsettled = { versions: theirs.slice().reverse(), words: w.words, cut };
          log({ event: "waited", by: w.by, version: head.version, ms: Date.now() - t0 });
          return;
        }
      }
      if (Date.now() - t0 > timeout) { log({ event: "wait-timeout", by: w.by, words: w.words }); return; }
      await sleep(400);
      continue;
    }
    if (r.code === 0) {
      let versions = [];
      try { versions = JSON.parse(r.out).versions; } catch {}
      let first = null; // that author's first version since the wait began
      for (const v of versions.slice().reverse()) {
        const seq = Number(v.version.split("@")[1]);
        if (seq <= from) continue;
        const a = v.by ?? {};
        if (w.by && !(a.kind === "human" && (a.name === w.by || a.id === w.by))) continue;
        first ??= seq;
        const said = w.words ? await changeWords(cut, v.version) : "";
        if (w.words && !flatWords(said ?? "").includes(flatWords(w.words))) continue;
        lastMatchSeq = seq;
        if (w.save) vars[w.save] = `${v.version.split("@")[0]}@${first - 1}`;
        log({ event: "waited", by: a.name ?? a.id, version: v.version, ms: Date.now() - t0, ...(w.save ? { saved: { [w.save]: vars[w.save] } } : {}) });
        return;
      }
    }
    if (Date.now() - t0 > timeout) { log({ event: "wait-timeout", by: w.by, words: w.words }); return; }
    await sleep(600);
  }
}

// ------------------------------------------------------------------ the conversation's state, read from the request
const fill = (s) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
function readRequest(body) {
  let n = -1, lastResult = "";
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use" && /^toolu_actor_(\d+)$/.test(c.id)) n = Math.max(n, Number(/(\d+)$/.exec(c.id)[1]));
      if (c.type === "tool_result") lastResult = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
    }
  }
  // the view file the last print named (cb source print --view: "Your view "x" is at <path> (version …)")
  const v = /Your view "[^"]*" is at (.+?) \(version /.exec(lastResult);
  if (v) vars.view = v[1].trim();
  return { next: n + 1, lastResult };
}

// ------------------------------------------------------------------ streaming as the API does
function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ev = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
  return ev;
}
const usage = { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const newId = (p) => p + Math.random().toString(36).slice(2, 12);
function chunks(text, n) { const out = []; for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n)); return out; }

async function streamMessage(req, res, body, msg, index) {
  // the client gone (a request's own `close` comes once its body is read: never taken for that)
  let open = true;
  res.on("close", () => { open = false; });
  req.socket?.on("close", () => { open = false; });
  const alive = () => open && !res.destroyed;
  // a non-streaming request (Claude Code's retry of a failed stream) gets the same message whole, holds included
  if (!body.stream) return wholeMessage(res, body, msg, index, alive);
  const ev = sse(res);
  const model = body.model ?? "claude-opus-5-5";
  ev("message_start", { message: { id: newId("msg_actor_"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  const ping = setInterval(() => ev("ping", {}), 5000);
  let i = 0, outTokens = 0, stop = "end_turn";
  // A quiet scene's lines: Cardboard's chat shows only a message's newest text block (separate lines replaced each other,
  // take 5), so each line's block holds every line so far; between lines a thinking block stays open (see below)
  let openThink = null;
  const said = [];
  const closeThink = () => {
    if (openThink === null) return;
    ev("content_block_delta", { index: openThink, delta: { type: "signature_delta", signature: "actor-" + index + "-" + openThink } });
    ev("content_block_stop", { index: openThink });
    openThink = null;
  };
  try {
    for (const b of msg.blocks) {
      if (!alive()) return;
      if (b.hold) {
        if (b.hold.pause !== undefined) { log({ event: "pause", ms: b.hold.pause }); await sleep(b.hold.pause); }
        else await waitFor(b.hold.wait, alive);
        continue;
      }
      if (b.do) { await doTool(b.do, index); continue; }
      if (b.think !== undefined && scene.quiet) {
        // (quiet: one thinking block stays open from a line to the next, through the waits and tool steps, so the chat's
        // status line reads "Thinking" the whole time: Cardboard drops it while a text block streams, take 6)
        if (openThink === null) { ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "" , signature: "" } }); ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: fill(b.think) } }); openThink = i++; }
        await sleep(b.ms);
        continue;
      }
      if (b.think !== undefined) {
        ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        const parts = chunks(fill(b.think), 12), step = Math.max(20, Math.floor(b.ms / Math.max(1, parts.length)));
        for (const p of parts) { if (!alive()) return; ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: p } }); await sleep(step); }
        ev("content_block_delta", { index: i, delta: { type: "signature_delta", signature: "actor-" + index + "-" + i } });
        ev("content_block_stop", { index: i++ });
      } else if (b.say !== undefined) {
        const text = fill(b.say);
        if (!text) continue;
        const per = Math.max(2, Math.round(b.cps / 10));
        if (scene.quiet) {
          // (each line a new text block holding every line so far, a paragraph each, whole at once: the chat shows a
          // message's newest text block, so the lines list up; then thinking again at once, so "Thinking" stays put)
          closeThink();
          said.push(text);
          ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index: i, delta: { type: "text_delta", text: said.join("\n\n") } });
          ev("content_block_stop", { index: i++ });
          ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
          ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: "Checking what comes next." } });
          openThink = i++;
          outTokens += Math.ceil(text.length / 4);
          continue;
        }
        ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
        for (const p of chunks(text, per)) { if (!alive()) return; ev("content_block_delta", { index: i, delta: { type: "text_delta", text: p } }); await sleep(100); }
        ev("content_block_stop", { index: i++ });
        outTokens += Math.ceil(text.length / 4);
      } else if (b.tool) {
        const tools = new Set((body.tools ?? []).map((t) => t.name));
        let name = b.tool.tool;
        // a Windows Claude Code without Git Bash offers PowerShell in place of Bash: the same command line
        if (!tools.has(name) && name === "Bash" && tools.has("PowerShell")) name = "PowerShell";
        const input = {};
        for (const [k, v] of Object.entries(b.tool)) if (k !== "tool" && k !== "powershell") input[k] = typeof v === "string" ? fill(v) : v;
        if (name === "PowerShell" && b.tool.powershell) input.command = fill(b.tool.powershell);
        const id = `toolu_actor_${index}`;
        ev("content_block_start", { index: i, content_block: { type: "tool_use", id, name, input: {} } });
        ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        ev("content_block_stop", { index: i++ });
        stop = "tool_use";
        log({ event: "tool", index, name, input: name === "Edit" ? { file_path: input.file_path, old: String(input.old_string).slice(0, 60), new: String(input.new_string).slice(0, 80) } : input });
      }
    }
    closeThink();
    if (stop === "end_turn" && !outTokens) {
      // a message with no text and no tool call reads as a broken stream to Claude Code, and only spaces as an empty answer
      // it asks again for: a zero-width space, which shows as nothing
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: i, delta: { type: "text_delta", text: "\u200b" } });
      ev("content_block_stop", { index: i++ });
    }
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: Math.max(1, outTokens) } });
    ev("message_stop", {});
  } finally {
    clearInterval(ping);
    res.end();
  }
}

// the same message as one JSON answer (no partial text: a non-streaming request)
async function wholeMessage(res, body, msg, index, alive) {
  const content = [];
  let stop = "end_turn";
  for (const b of msg.blocks) {
    if (b.hold) { if (b.hold.pause !== undefined) await sleep(b.hold.pause); else await waitFor(b.hold.wait, alive); continue; }
    if (b.do) { await doTool(b.do, index); continue; }
    if (b.think !== undefined) { await sleep(b.ms); content.push({ type: "thinking", thinking: fill(b.think), signature: "actor-" + index }); }
    else if (b.say !== undefined) {
      const t = fill(b.say), last = content.at(-1);
      if (t && scene.quiet && last?.type === "text") last.text += "\n\n" + t;
      else if (t) content.push({ type: "text", text: t });
    }
    else if (b.tool) {
      const { tool: name, powershell: _p, ...rest } = b.tool;
      const input = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === "string" ? fill(v) : v]));
      content.push({ type: "tool_use", id: `toolu_actor_${index}`, name, input });
      stop = "tool_use";
    }
  }
  if (!content.some((c) => c.type === "text" || c.type === "tool_use")) content.push({ type: "text", text: "\u200b" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: newId("msg_actor_"), type: "message", role: "assistant", model: body.model ?? "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, usage }));
}

// a short answer, streamed or not, for a request that isn't the scene's
function answerText(res, body, text) {
  const model = body.model ?? "claude-haiku-5-5";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: newId("msg_actor_"), type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
  }
  const ev = sse(res);
  ev("message_start", { message: { id: newId("msg_actor_"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
  ev("message_stop", {});
  res.end();
}

const systemText = (body) => (typeof body.system === "string" ? body.system : (body.system ?? []).map((s) => s.text ?? "").join("\n"));
function naming(body) {
  const s = systemText(body), names = scene.names ?? {};
  if (/Name this conversation/i.test(s)) return { kind: "name-conversation", text: names.conversation ?? "Tidy up the promo" };
  if (/Name a video editing project/i.test(s)) return { kind: "name-project", text: names.project ?? "Morning Brew Promo" };
  if (/Title this change/i.test(s)) return { kind: "title-turn", text: names.turn ?? "Tidy up the promo" };
  return null;
}

let started = false;
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname.startsWith("/cue/")) {
    const name = decodeURIComponent(url.pathname.slice(5)), go = cues.get(name);
    log({ event: "cue", name, waiting: !!go });
    if (go) go();
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(go ? "ok\n" : "nobody waits for it\n");
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    if (req.method === "POST" && /\/v1\/messages\/count_tokens/.test(url.pathname)) {
      log({ event: "request", path: url.pathname, kind: "count_tokens" });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 1200 }));
    }
    if (req.method !== "POST" || !/\/v1\/messages$/.test(url.pathname)) {
      log({ event: "request", method: req.method, path: url.pathname, kind: "unknown", answered: 404 });
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not here" } }));
    }
    const nm = naming(body);
    const tools = (body.tools ?? []).map((t) => t.name);
    if (nm || !tools.length) {
      const text = nm?.text ?? (scene.names?.other ?? "OK");
      log({ event: "request", path: url.pathname, kind: nm?.kind ?? "side", model: body.model ?? null, stream: !!body.stream, answered: text });
      return answerText(res, body, text);
    }
    const st = readRequest(body);
    if (!started) {
      started = true;
      // the cut's head as the scene starts: the first wait looks only at versions after it
      const r = await cb(["history", vars.project, "--cut", scene.cut ?? "Main cut", "--limit", "1", "--json"]);
      try { vars._startSeq = Number(JSON.parse(r.out).versions[0].version.split("@")[1]); } catch { vars._startSeq = 0; }
      log({ event: "start", tools, model: body.model ?? null, thinking: body.thinking ?? null, startSeq: vars._startSeq });
    }
    const msg = messages[st.next];
    log({ event: "request", path: url.pathname, kind: "scene", message: st.next, of: messages.length, lastResult: st.lastResult.slice(0, 160) });
    if (!msg) return answerText(res, body, scene.after ?? "Done.");
    await streamMessage(req, res, body, msg, st.next);
  });
}).listen(PORT, "127.0.0.1", () => log({ event: "listening", url: `http://127.0.0.1:${PORT}` }));
