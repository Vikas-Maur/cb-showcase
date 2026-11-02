// Regress prod4, director-hold (merge/prod-2 @ 3b2407c3, and 0cc587f1 with the same recipe: a gap, not a regression).
// In a real in-app Claude Code turn on the laptop the agent ran `cb source print`, then `ping -n 31 127.0.0.1` in the
// foreground, then `cb source apply` and read timeline.tsx. 15 s into the turn, during the ping, the person muted a
// clip: the mute reached timeline.tsx 0.4 s later, mid-turn, and the agent read it ("the file is supposed to hold back
// other people's edits until my turn ends"). Two gaps:
//   - nothing held the file until the agent's first Carton write or read of timeline.tsx: `cb source print` is a read
//     of Carton that held nothing, and on Windows the agent ran it and the ping in Claude Code's PowerShell tool, which
//     the transport didn't hook at all (only Bash and the file tools);
//   - once held, the worker let go of a hooked agent it hadn't heard from for a minute (its quiet bound: a Stop can be
//     lost), so any tool call past that with no hook (a long render, a ping, a backgrounded command the agent waits on)
//     let the person's edits in mid-turn.
// The turn, as Cardboard 1.4.0 runs the person's own Claude Code (the Agent SDK transport, provider "claude", its hook
// table as patch-carton.js builds it: the credit gate on Bash wrapped by main-bridge's directorHook, fileHooks, the
// Stop hooks), on Cardboard's real (patched) library worker and cb. Each tool call goes through the hooks Claude Code
// would run for it, then runs. The person's edit is a GUI save during the long call; timeline.tsx is read every 50 ms
// from the agent's first print to its Stop.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/turn-hold.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
// the laptop's `ping -n 31 127.0.0.1` (about 30 s), the person's edit 15 s into it, and a call past the worker's
// one-minute quiet bound
const LONG_MS = 30_000, EDIT_AT = 15_000, PAST_QUIET_MS = 75_000;
const CHAT = "7a09b6cc-8553-4fe8-9942-0cf44eec39e2", SESSION = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", ACTOR = "claude-code/787d66ff";

let b, pc, id, m, bin, bundle, tsxFile, env, hooks, ctx, chat, n = 0;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("turn-hold", b);
  S.seed(pc, b);
  await pc.startWorker();
  id = (await pc.call("projects.list"))[0]?.id;
  bundle = path.join(pc.root, "Demo.cardboard");
  tsxFile = path.join(bundle, "timeline.tsx");
  m = mainBridge();
  m.library({ call: (method, ...args) => pc.call(method, ...args) });
  bin = cbOnPath();
  // the person's own Claude Code: Cardboard gives it its binary's environment (no CARDBOARD_ACTOR); Claude Code's
  // shells set CLAUDECODE
  env = { ...pc.env, PATH: bin + path.delimiter + process.env.PATH, CLAUDECODE: "1" };
  // the launch context oH gets from v_e (dist/main.js), and the transport's hooks as patch-carton.js builds them
  ctx = { project: { id, name: "Demo", bundlePath: bundle }, chatId: CHAT, binary: { path: "claude", environment: {} }, launch: { provider: "claude", model: "default" }, sessionId: null };
  hooks = { PreToolUse: [{ matcher: "Bash", hooks: [m.directorHook(ctx, async () => ({}))] }, ...m.fileHooks(ctx)], ...m.stopHooks(ctx) };
  // the project's View starts once the worker opens its history; a probe actor's Read shows it is there, then lets go
  await S.projectOf(pc, id);
  const probe = "director/probe/p1";
  await S.until(async () => (await pc.call("carton.agentHook", { bundlePath: bundle, actor: probe, event: "pre-tool-use", input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: tsxFile } } })).delivered, 20_000, "the project's View in the worker");
  await pc.call("carton.agentHook", { bundlePath: bundle, actor: probe, event: "endTurn" });
}, { timeout: S.SETUP_MS });
test.after(async () => {
  if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, "turn-hold-worker.log"), pc.worker().stderr());
  await pc?.stopWorker();
  S.killHelpers();
}, { timeout: S.STOP_MS });

/** Main's Carton bridge as dist/main.js runs it (the same text patch-carton.js injects), Carton on. */
function mainBridge() {
  const saved = process.env.CARDBOARD_CARTON;
  process.env.CARDBOARD_CARTON = "1";
  try { return new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require); }
  finally { if (saved === undefined) delete process.env.CARDBOARD_CARTON; else process.env.CARDBOARD_CARTON = saved; }
}

/** `cb` on PATH for the agent's shells, as the app's agents find it, on this computer's library. */
function cbOnPath() {
  const dir = path.join(pc.home, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const cli = [process.execPath, path.join(b.cli, "cardboard.mjs")];
  fs.writeFileSync(path.join(dir, "cb"), `#!/bin/sh\nexec "${cli[0]}" "${cli[1]}" --root "${pc.root}" --json "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "cb.cmd"), `@"${cli[0]}" "${cli[1]}" --root "${pc.root}" --json %*\r\n`);
  return dir;
}

// Claude Code's Bash tool on Windows runs Git Bash; its PowerShell tool runs PowerShell: CARTON_PWSH (a pwsh, e.g.
// PowerShell 7 for Linux), else Windows' own. With neither, the command runs in sh, after the one PowerShell form a
// hook adds (`$env:NAME='value'; `) becomes environment.
const BASH = process.platform !== "win32" ? "bash" : process.env.CLAUDE_CODE_GIT_BASH_PATH ?? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
const PWSH = process.env.CARTON_PWSH || (process.platform === "win32" ? "powershell.exe" : null);
function shell(tool, command) {
  if (tool === "Bash") return { file: BASH, args: ["-c", command], env };
  if (PWSH) return { file: PWSH, args: ["-NoProfile", "-NonInteractive", "-Command", command], env };
  const more = {};
  let rest = command, x;
  while ((x = /^\$env:([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'')*)';\s*/.exec(rest))) more[x[1]] = x[2].replace(/''/g, "'"), (rest = rest.slice(x[0].length));
  assert.ok(!rest.includes("$env:"), "the PowerShell shim runs only what a hook adds: " + command);
  return { file: "sh", args: ["-c", rest], env: { ...env, ...more } };
}
function run(tool, command) {
  const s = shell(tool, command);
  return new Promise((resolve) => {
    const p = spawn(s.file, s.args, { env: s.env, cwd: bundle });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.replace(/^\[carton\][^\n]*\n/gm, ""), err }));
  });
}

/**
 * One tool call of the agent, as Claude Code makes it: each PreToolUse hook whose matcher matches the tool's name runs
 * (a rewritten input is what runs; a denial stops it), then the tool. A shell call in the background (Bash's
 * run_in_background) returns at once, with the command's run.
 */
async function toolCall(tool, input) {
  let tool_input = input;
  for (const entry of hooks.PreToolUse) {
    if (!new RegExp(`^(?:${entry.matcher})$`).test(tool)) continue;
    for (const h of entry.hooks) {
      const o = (await h({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: tool, tool_input, cwd: bundle }))?.hookSpecificOutput;
      if (o?.permissionDecision === "deny") return { denied: o.permissionDecisionReason };
      if (o?.updatedInput) tool_input = o.updatedInput;
    }
  }
  if (tool !== "Bash" && tool !== "PowerShell") return { ran: null };
  const r = run(tool, tool_input.command);
  return tool_input.run_in_background ? { ran: tool_input.command, background: r } : { ran: tool_input.command, ...(await r) };
}

const tsxNow = () => fs.readFileSync(tsxFile, "utf8");
const fontOf = (tsx) => Number(/fontSize=\{(\d+)\}/.exec(tsx)?.[1]);
const LONG_CALL = (ms) => (process.platform === "win32" ? `ping -n ${Math.round(ms / 1000) + 1} 127.0.0.1` : `sleep ${ms / 1000}`);

/**
 * One in-app turn: the agent's first `cb source print` (`printTool`; `first`: another first call), a long call that isn't cb (`long`: its tool, how
 * long, in the background or not), during which the person edits the clip in the GUI (the laptop's M on the Mine clip,
 * `editAt` ms into it), then, in Bash as on the laptop, a copy of timeline.tsx with the title's new font size, its
 * `cb source apply`, timeline.tsx read at once, and the Stop. Returns what the turn saw.
 */
async function turn({ printTool, first = "cb source print Demo", long, editAt = EDIT_AT }) {
  const k = ++n, marker = `Person ${k}`, font = 320 + k;
  chat = { chatId: CHAT, sessionIds: { claude: SESSION }, turn: { id: `turn-${k}`, state: "running", text: `First run cb source print (${k}).` } };
  m.turnStarted(chat, id, bundle, chat.turn, "claude");
  const seen = [];
  let sampler = null;
  try {
    const before = tsxNow();
    assert.ok(!before.includes(marker), "the person's edit isn't there before the turn");
    const print = await toolCall(printTool, { command: first, description: "Print timeline" });
    assert.equal(print.code, 0, first + ": " + print.out + print.err);
    assert.match(print.out, /cardboard:rev /, "the print is Carton's");
    sampler = setInterval(() => { try { seen.push(tsxNow()); } catch {} }, 50);
    // the long call that isn't cb; the person edits during it
    const t0 = Date.now();
    const call = toolCall(long.tool, { command: LONG_CALL(long.ms), description: "Wait", ...(long.background ? { run_in_background: true } : {}) });
    await S.sleep(editAt);
    await S.guiSave(pc, id, (it) => (it.type === "video" ? { ...it, name: marker, ...(k === 1 ? { muted: true } : {}) } : null));
    assert.equal(S.videoOf(await S.projectOf(pc, id)).name, marker, "the person's edit is head");
    const done = await call;
    if (long.background) {
      // the agent waits on its backgrounded command, polling its output (BashOutput: no Carton hook matches it)
      while (Date.now() - t0 < long.ms) { await toolCall("BashOutput", { bash_id: "bg1" }); await S.sleep(Math.min(10_000, Math.max(0, long.ms - (Date.now() - t0)))); }
      assert.equal((await done.background).code, 0);
    } else assert.equal(done.code, 0, "the long call: " + done.err);
    // the apply, as the laptop's agent made it (Bash): a copy of timeline.tsx with the new size, applied, then the file
    const edit = await toolCall("Bash", { command: `mkdir -p .scratch && cp timeline.tsx .scratch/w2.tsx && sed -i 's/fontSize={[0-9]*}/fontSize={${font}}/' .scratch/w2.tsx` });
    assert.equal(edit.code, 0, edit.err);
    const apply = await toolCall("Bash", { command: `cb source apply Demo .scratch/w2.tsx; echo "---"; cat timeline.tsx` });
    assert.equal(apply.code, 0, "cb source apply: " + apply.out + apply.err);
    const read = apply.out.slice(apply.out.indexOf("\n---\n") + 5);
    seen.push(tsxNow());
    const stop = await hooks.Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: SESSION, stop_hook_active: false });
    assert.deepEqual(stop, {}, "nothing to hand back: the turn stops");
    clearInterval(sampler);
    sampler = null;
    return { marker, font, print, apply, read, seen, t0 };
  } finally {
    if (sampler) clearInterval(sampler);
    // Cardboard's closeTurn: the turn's end, then its state
    m.turnEnded(chat, "result");
    chat.turn = { state: "idle" };
  }
}

/** The turn held the person's edit back all through, showed the agent its own apply, and let go at its end. */
async function heldThrough(r, what) {
  const leaked = r.seen.filter((s) => s.includes(r.marker));
  assert.equal(leaked.length, 0, `${what}: the person's edit reached timeline.tsx during the turn (${leaked.length} of ${r.seen.length} reads)`);
  assert.equal(fontOf(r.read), r.font, `${what}: the agent reads its own apply at once`);
  assert.ok(!r.read.includes(r.marker), `${what}: the agent's read after its apply holds the person's edit back`);
  const at = Date.now();
  await S.until(() => { const s = tsxNow(); return s.includes(r.marker) && fontOf(s) === r.font; }, 20_000, `${what}: timeline.tsx at head once the turn ended`);
  return Date.now() - at;
}

test("the laptop's recipe: cb source print and a 30 s ping in PowerShell, the person's mute during it, then the apply and the read in Bash: the mute stays out of timeline.tsx until the turn ends", t, async () => {
  const r = await turn({ printTool: "PowerShell", long: { tool: "PowerShell", ms: LONG_MS } });
  // a PowerShell cb call runs as the turn's actor, as a Bash one does (its version, its credits, its own writes shown)
  await heldThrough(r, "PowerShell");
  assert.match(tsxNow(), /\bmuted\b/, "the person's mute is in timeline.tsx after the turn");
});

test("the same turn in Bash: the first cb source print holds timeline.tsx, through a 30 s foreground call", t, async () => {
  const r = await turn({ printTool: "Bash", long: { tool: "Bash", ms: LONG_MS } });
  await heldThrough(r, "Bash");
});

test("a backgrounded long call the agent waits on (Bash run_in_background, then BashOutput polls): the hold lasts", t, async () => {
  const r = await turn({ printTool: "Bash", long: { tool: "Bash", ms: LONG_MS, background: true } });
  await heldThrough(r, "background");
});

// The turn's first call is a read of timeline.tsx in Bash, which held the file before the fix too: this case is the
// lapse alone (the worker let go of a hooked agent it hadn't heard from for a minute).
test("a foreground call longer than the worker's one-minute quiet bound (the person's edit after it has passed): the hold lasts the whole turn", t, async () => {
  const r = await turn({ printTool: "Bash", first: "cat timeline.tsx", long: { tool: "Bash", ms: PAST_QUIET_MS }, editAt: 65_000 });
  await heldThrough(r, "past the quiet bound");
});

test("no stuck holds: an interrupted turn (no Stop) lets go at its end; a turn main stops hearing from (the app gone) lets go at the worker's quiet bound", t, async () => {
  const marker = "Person interrupted";
  chat = { chatId: CHAT, sessionIds: { claude: SESSION }, turn: { id: "turn-int", state: "running", text: "Interrupted." } };
  m.turnStarted(chat, id, bundle, chat.turn, "claude");
  assert.equal((await toolCall("Bash", { command: "cb source print Demo" })).code, 0);
  await S.guiSave(pc, id, (it) => (it.type === "video" ? { ...it, name: marker } : null));
  await S.sleep(1500);
  assert.ok(!tsxNow().includes(marker), "held while the turn runs");
  // the person interrupts: Cardboard's closeTurn, no Stop hook
  m.turnEnded(chat, "stopped");
  chat.turn = { state: "idle" };
  await S.until(() => tsxNow().includes(marker), 20_000, "timeline.tsx at head once the interrupted turn ended");

  // main goes away mid-turn (no Stop, no end): nothing reaches the worker any more, which lets go on its own
  const gone = "Person app gone";
  chat = { chatId: CHAT, sessionIds: { claude: SESSION }, turn: { id: "turn-gone", state: "running", text: "Gone." } };
  m.turnStarted(chat, id, bundle, chat.turn, "claude");
  assert.equal((await toolCall("Bash", { command: "cb source print Demo" })).code, 0);
  const from = Date.now();
  m.library({ call: () => Promise.reject(new Error("main is gone")) });
  try {
    await S.guiSave(pc, id, (it) => (it.type === "video" ? { ...it, name: gone } : null));
    await S.until(() => tsxNow().includes(gone), 90_000, "timeline.tsx at head once the worker stopped hearing from the turn");
    const after = Date.now() - from;
    assert.ok(after >= 50_000, `held until the worker's quiet bound, not let go early (${after} ms)`);
  } finally {
    m.library({ call: (method, ...args) => pc.call(method, ...args) });
    m.turnEnded(chat, "error");
    chat.turn = { state: "idle" };
  }
});
