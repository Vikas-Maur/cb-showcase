// Acceptance test for H8's per-agent views and the shared timeline.tsx freeze (PLAN §6.4, R3-02, R4-03, R5-04, R8-01),
// written before the wiring as its target (e2e-qa; windows-sync owns this folder, e2e-qa this file). One Director turn
// on one computer, as the Windows app runs it: Cardboard 1.4.0's real library worker and cb, patched and built as
// build-windows.js builds them (support.js), and main's Carton bridge (main-bridge.js, the text patch-carton.js puts
// into dist/main.js) giving the Director its environment and running its PreToolUse and Stop hooks. The agent's
// commands run through bash, as Claude Code's Bash tool runs them, after the hook rewrote them.
//   1. a project with Carton on;
//   2. a Director turn starts: its hooks fire, and it prints its own view (`cb source print --view <name>`);
//   3. while the turn runs, the person edits the project in the GUI;
//   4. the agent edits and saves its view, and reads the view's `.status`;
//   5. all through the turn, timeline.tsx stays unchanged for the agent (frozen against the person's edits);
//   6. the turn stops: its work folds into the cut (head, History, and timeline.tsx back to head);
//   7. a deliberate clash (agent and person both change the title's text) is a conflict card in the agent's notices
//      (cb conflicts, the Stop hook) and, left unresolved, in the pages' cards (the History panel);
//   8. credits name the Director turn and the person.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/director-turn.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild };
const CHAT = "chatT", TURN = "turnT1", ACTOR = `director/${CHAT}/${TURN}`, VIEW = "director_chatT_turnT1";
const PROMPT = "Tighten the title. Then add more.", LABEL = "Tighten the title";
// What the person does in the GUI during the turn; none of it may reach the agent's timeline.tsx before the turn ends.
const GUI = { text: "GUI words", fontSize: 160, clip: "GUI clip" };
const guiIn = (tsx) => tsx.includes(GUI.text) || tsx.includes(`fontSize={${GUI.fontSize}}`) || tsx.includes(GUI.clip);

let b, pc, id, m, ctx, chat, env, bin, tsxFile, panel, sampler, frozenAt = null, viewFile, statusFile, card;
const seen = [];

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("turn-alice", b);
});
test.after(async () => {
  if (sampler) clearInterval(sampler);
  await pc?.stopWorker();
  S.killHelpers();
});

/** Main's Carton bridge as dist/main.js runs it (the same text patch-carton.js injects), Carton on. */
function mainBridge() {
  const saved = process.env.CARDBOARD_CARTON;
  process.env.CARDBOARD_CARTON = "1";
  try { return new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require); }
  finally { if (saved === undefined) delete process.env.CARDBOARD_CARTON; else process.env.CARDBOARD_CARTON = saved; }
}

/** `cb` on PATH for the agent's shell, as the app's agents find it, on this computer's library. */
function cbOnPath() {
  const dir = path.join(pc.home, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const slash = (p) => p.replace(/\\/g, "/");
  fs.writeFileSync(path.join(dir, "cb"), `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(path.join(b.cli, "cardboard.mjs"))}" --root "${slash(pc.root)}" --json "$@"\n`, { mode: 0o755 });
  return dir;
}

// Claude Code's Bash tool on Windows runs Git Bash (CLAUDE_CODE_GIT_BASH_PATH, else Git's own): never WSL's bash.exe,
// which can come first on PATH.
const BASH = process.platform !== "win32" ? "bash" : process.env.CLAUDE_CODE_GIT_BASH_PATH
  ?? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")].find((f) => fs.existsSync(f)) ?? "bash";

/** One Bash tool call of the Director: the PreToolUse hook (credit gate stand-in: allow) decides, then bash runs it. */
async function agentBash(command, input = {}) {
  const hook = m.directorHook(ctx, async () => ({}));
  const r = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...input });
  const run = r?.hookSpecificOutput?.updatedInput?.command ?? command;
  const x = spawnSync(BASH, ["-c", run], { env, cwd: path.join(pc.root, "Demo.cardboard"), encoding: "utf8", timeout: 120_000 });
  const out = (x.stdout ?? "").replace(/^\[carton\][^\n]*\n/gm, "");
  return { code: x.status, out, err: x.stderr, ran: run, json: () => JSON.parse(out) };
}

/** The editor's History panel, as a page reads it (remoteUi's protocol over the worker's `carton.ui`). */
async function openPanel(client) {
  let calls = 0;
  // the worker posts `{kind, change}` to main; main hands a `carton` change to the page that asked
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const state = () => {
    const s = { conflicts: [], history: [] };
    for (const x of msgs()) {
      if (x.t === "init") { s.conflicts = x.topics.conflicts ?? []; s.history = x.history.slice(); }
      if (x.t === "topic" && x.topic === "conflicts") s.conflicts = x.value ?? [];
      if (x.t === "history") { for (const [i, v] of x.rows) s.history[i] = v; s.history.length = x.length; }
    }
    return s;
  };
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  const r = await send({ t: "hello" });
  assert.equal(r?.status, "ok", "the History panel opens: " + JSON.stringify(r));
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  return {
    state,
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 20_000, "the panel's " + method);
      if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
      return ret.value;
    },
  };
}

const text = async () => S.textOf(await S.projectOf(pc, id));
const video = async () => S.videoOf(await S.projectOf(pc, id));
const need = (x, what) => assert.ok(x, "needs an earlier step: " + what);

test("1. A project with Carton on: Cardboard's worker opens it, with History", t, async () => {
  S.seed(pc, b);
  await pc.startWorker();
  id = (await pc.call("projects.list"))[0]?.id;
  assert.ok(id, "the library lists the project");
  assert.equal((await text()).textContent, "Hello");
  m = mainBridge();
  m.library({ call: (method, ...args) => pc.call(method, ...args) });
  bin = cbOnPath();
  tsxFile = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  panel = await openPanel("page-1");
  assert.ok(panel.state().history.length >= 3, "History shows the seed's versions: " + panel.state().history.length);
});

test("2. A Director turn starts: its hooks fire, and it prints its own view (cb source print --view)", t, async () => {
  need(m, "1");
  // main: the turn starts (turnStarted), the Director's process gets its actor (directorEnv), its Bash calls the hook
  chat = { chatId: CHAT, turn: { id: TURN, state: "running", text: PROMPT } };
  ctx = { chatId: CHAT, project: { id, bundlePath: path.join(pc.root, "Demo.cardboard") } };
  m.turnStarted(chat, id, ctx.project.bundlePath, chat.turn, "director");
  env = m.directorEnv({ ...pc.env, PATH: bin + path.delimiter + process.env.PATH }, ctx, () => (chat.turn?.state === "running" ? TURN : null));
  const r = await agentBash(`cb source print Demo --view ${VIEW}`);
  assert.match(r.ran, new RegExp(`^export CARDBOARD_ACTOR='${ACTOR}'; `), "the hook names the turn");
  // the snapshot the freeze is measured against: timeline.tsx as the agent sees it at its first print
  frozenAt = fs.existsSync(tsxFile) ? fs.readFileSync(tsxFile, "utf8") : null;
  sampler = setInterval(() => { try { seen.push(fs.readFileSync(tsxFile, "utf8")); } catch {} }, 50);
  assert.equal(r.code, 0, "print --view: " + r.out + r.err);
  viewFile = path.join(ctx.project.bundlePath, ".scratch", "views", VIEW + ".tsx");
  statusFile = path.join(ctx.project.bundlePath, ".scratch", "views", VIEW + ".status");
  assert.ok(fs.existsSync(viewFile), "the view is printed at .scratch/views/<name>.tsx: " + r.out);
  const v = fs.readFileSync(viewFile, "utf8");
  // a cut's name can have spaces (core's first cut is "Main cut")
  assert.match(v, /cardboard:rev .+@\d+~[0-9a-f]{8} b:/, "the view's header is Carton's rev line");
  assert.match(v, /textContent="Hello"/);
});

test("3. While the turn runs, the person edits the project in the GUI", t, async () => {
  need(chat, "2 (the turn)");
  const r = await S.guiSave(pc, id, (it) =>
    it.type === "text" ? { ...it, textContent: GUI.text, fontSize: GUI.fontSize } : it.type === "video" ? { ...it, name: GUI.clip } : null);
  assert.ok(r, "the GUI save answers");
  const x = await text();
  assert.deepEqual([x.textContent, x.fontSize, (await video()).name], [GUI.text, GUI.fontSize, GUI.clip], "the person's edit is head");
});

test("4. The agent edits and saves its view, and reads the view's .status", t, async () => {
  need(viewFile && fs.existsSync(viewFile), "2 (the printed view)");
  const before = fs.readFileSync(viewFile, "utf8");
  // the title starts later (no clash) and gets new words (clashes with the person's, step 7)
  const after = before.replace("start={0.5}", "start={0.75}").replace('textContent="Hello"', 'textContent="Agent words"');
  assert.notEqual(after, before, "the view has the title to edit");
  fs.writeFileSync(viewFile, after);
  const st = await S.until(() => { try { const s = JSON.parse(fs.readFileSync(statusFile, "utf8")); return s.status !== "pending" && s; } catch { return null; } }, 20_000, "the view's .status");
  assert.equal(st.status, "conflicts", "the clash is in the status: " + JSON.stringify(st));
  assert.match(st.ref, /^.+@\d+~[0-9a-f]{8}/, "the status names the version it landed as");
  card = st.conflicts.find((c) => JSON.stringify(c).includes("Agent words"));
  assert.ok(card, "the status's card is the title's text: " + JSON.stringify(st.conflicts));
  assert.match(JSON.stringify(card), /GUI words/);
  assert.deepEqual(st.diagnostics ?? [], [], "no diagnostics");
  const x = await text();
  assert.equal(x.startTime, 0.75, "the agent's edit that doesn't clash landed");
  assert.equal(x.textContent, GUI.text, "the clash keeps what is there (the person's words) until resolved");
  assert.equal(x.fontSize, GUI.fontSize, "the person's other edit stays");
  assert.equal(fs.readFileSync(viewFile, "utf8"), after, "Carton never rewrites the agent's view");
});

test("5. All through the turn, timeline.tsx stays unchanged for the agent (frozen against the person's edits)", t, async () => {
  need(sampler, "2 (the turn's start)");
  await S.sleep(1500); // the worker's regeneration (1.4.0's ~300 ms debounce) has had its chance
  seen.push(fs.readFileSync(tsxFile, "utf8"));
  assert.ok(frozenAt, "timeline.tsx was there at the turn's first print");
  const leaked = seen.filter(guiIn);
  assert.equal(leaked.length, 0, `the person's edit reached timeline.tsx during the turn (${leaked.length} of ${seen.length} reads)`);
  // what may change it during the freeze: only this agent's own applied saves (the freeze view, R8-01)
  for (const s of seen) if (s !== frozenAt) assert.match(s, /start=\{0\.75\}/, "a rewrite during the freeze carries only the agent's saves");
});

test("7a. The clash is a card in the agent's notices: cb conflicts, as the agent", t, async () => {
  need(card, "4 (the view's clash)");
  const r = await agentBash("cb conflicts Demo");
  assert.equal(r.code, 0, r.out + r.err);
  const cards = r.json().cards;
  assert.equal(cards.length, 1, JSON.stringify(cards));
  assert.match(JSON.stringify(cards[0]), /Agent words/);
  assert.match(JSON.stringify(cards[0]), /GUI words/);
});

let blocked;
test("6. The turn stops: the Stop hook hands back the clash once, then its work folds into the cut", t, async () => {
  need(chat, "2 (the turn)");
  const stop = m.stopHooks(ctx).Stop[0].hooks[0];
  blocked = await stop({ hook_event_name: "Stop", stop_hook_active: false });
  // the agent leaves the card; the second stop goes through, and the card becomes the person's (step 7b)
  assert.deepEqual(await stop({ hook_event_name: "Stop", stop_hook_active: true }), {}, "a stop the hook already blocked goes through");
  m.turnEnded(chat);
  chat.turn.state = "done";
  if (sampler) clearInterval(sampler), (sampler = null);
  // the turn's work is on the cut: head, History (named after the prompt), and timeline.tsx back to head
  const x = await text();
  assert.equal(x.startTime, 0.75, "the agent's edit is head: " + JSON.stringify(x));
  assert.equal(x.fontSize, GUI.fontSize, "with the person's");
  const named = await S.until(() => pc.cb(["history", "Demo", "--limit", "50"]).json().versions.find((v) => v.name === LABEL), 20_000, "the turn's version named");
  assert.equal(named.by?.id, ACTOR, "the named version is the turn's");
  const tsx = await S.until(() => { const s = fs.readFileSync(tsxFile, "utf8"); return s.includes(GUI.text) && s.includes("start={0.75}") && s; }, 20_000, "timeline.tsx back to head after the turn");
  assert.match(tsx, new RegExp(`fontSize=\\{${GUI.fontSize}\\}`));
});

test("7b. The clash: the Stop hook handed it to the agent, and, left unresolved, it is a card in the pages", t, async () => {
  need(blocked, "6 (the Stop hook)");
  assert.equal(blocked.decision, "block", "the Stop hook hands the clash back to the agent: " + JSON.stringify(blocked));
  // @carton/local's Stop hook words: "1 of your changes conflicted after your turn … 1 conflict card on your change …"
  assert.match(blocked.reason, /conflict/);
  const cards = await S.until(() => { const c = panel.state().conflicts; return c.length && c; }, 20_000, "a card in the pages");
  const c = cards.find((x) => JSON.stringify(x).includes("Agent words"));
  assert.ok(c, "the pages' card is the title's text: " + JSON.stringify(cards));
  assert.match(JSON.stringify(c), /GUI words/);
});

test("8. Credits name the Director turn and the person", t, async () => {
  need(id, "1");
  const [x, v] = [await text(), await video()];
  // the title: last changed by the turn's view save; the clip: by the person, in the GUI
  const title = pc.cb(["credits", "Demo", x.id]).json().by;
  const clip = pc.cb(["credits", "Demo", v.id]).json().by;
  assert.equal(clip?.id, "person", "the clip's credit is the person: " + JSON.stringify(clip));
  assert.equal(title?.id, ACTOR, "the title's credit is the Director turn: " + JSON.stringify(title));
  // the pages' History: the turn's version, named after its prompt, and the person's
  const h = panel.state().history;
  assert.ok(h.some((r) => r.author?.key?.includes(TURN) && r.name === LABEL), "History has the turn's named version: " + JSON.stringify(h.map((r) => [r.author?.key, r.name])));
  assert.ok(h.some((r) => r.author?.kind === "human"), "and the person's: " + JSON.stringify(h.map((r) => r.author?.key)));
});

// windows-sync (H8, local-cli's hook path): the agents' file tools reach the worker's Materializer. On Windows the same
// path runs over the control socket's named pipe, with case-insensitive paths and history in app data: the laptop run.
const tsxNow = () => fs.readFileSync(tsxFile, "utf8");
/** The person edits the title's text in the GUI; timeline.tsx is read every 50 ms for 1.5 s after. */
async function guiEditWhileFrozen(words) {
  const before = tsxNow();
  await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: words } : null));
  const reads = [];
  for (let i = 0; i < 30; i++) { reads.push(tsxNow()); await S.sleep(50); }
  assert.equal((await text()).textContent, words, "the person's edit is head");
  assert.equal(reads.filter((x) => x.includes(words)).length, 0, `the person's edit reached timeline.tsx (of ${reads.length} reads)`);
  assert.ok(reads.every((x) => x === before), "timeline.tsx unchanged");
}
const atHead = (words, what) => S.until(() => tsxNow().includes(`textContent="${words}"`), 20_000, what);

test("9. The Director's file tools (the app's own hooks): a Read of timeline.tsx freezes it for the turn, a Write of project.json is refused, and the turn's end lets go", t, async () => {
  need(m && ctx, "2 (the Director's context)");
  await atHead(GUI.text, "timeline.tsx at head before the turn");
  const chat2 = { chatId: CHAT, turn: { id: "turnT2", state: "running", text: "Make it pop." } };
  m.turnStarted(chat2, id, ctx.project.bundlePath, chat2.turn, "director");
  m.directorEnv({ ...pc.env }, ctx, () => (chat2.turn.state === "running" ? "turnT2" : null));
  const [files] = m.fileHooks(ctx);
  assert.equal(files.matcher, "Read|Write|Edit|MultiEdit");
  assert.deepEqual(await files.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: tsxFile } }), {}, "a Read goes on");
  await guiEditWhileFrozen("GUI two");
  const denied = await files.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(ctx.project.bundlePath, "project.json"), content: "{}" } });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny", "a Write of project.json is refused: " + JSON.stringify(denied));
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /cb source print --view/);
  assert.deepEqual(await m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", stop_hook_active: false }), {}, "nothing to hand back: the turn stops");
  m.turnEnded(chat2);
  chat2.turn.state = "done";
  await atHead("GUI two", "timeline.tsx back to head once the turn stopped");
});

test("10. Host Claude Code's hooks through cb carton-hook (as --settings runs them): a Read freezes timeline.tsx, a Write of project.json is refused, the Stop lets go", t, async () => {
  need(id && bin, "1");
  const hook = (event, input) => {
    const x = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, "carton-hook", event], { input: JSON.stringify(input), cwd: path.join(pc.root, "Demo.cardboard"), env: { ...pc.env, CARDBOARD_ACTOR: "claude/chatH" }, encoding: "utf8", timeout: 60_000 });
    assert.equal(x.status, 0, `cb carton-hook ${event}: ${x.stdout}${x.stderr}`);
    return JSON.parse(x.stdout.replace(/^\[carton\][^\n]*\n/gm, "") || "{}");
  };
  const session = { session_id: "hostsession1", cwd: path.join(pc.root, "Demo.cardboard") };
  await atHead("GUI two", "timeline.tsx at head before the host agent's turn");
  assert.deepEqual(hook("pre-tool-use", { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: tsxFile } }), {}, "a Read goes on");
  await guiEditWhileFrozen("GUI three");
  const denied = hook("pre-tool-use", { ...session, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "project.json", old_string: "a", new_string: "b" } });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny", "an Edit of project.json is refused: " + JSON.stringify(denied));
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /cb source print --view/);
  assert.deepEqual(hook("stop", { ...session, hook_event_name: "Stop", stop_hook_active: false }), {}, "nothing to hand back: the agent stops");
  await atHead("GUI three", "timeline.tsx back to head once the host agent stopped");
});
