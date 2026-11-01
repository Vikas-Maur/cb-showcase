// Main's bridge (scripts/carton/main-bridge.js): who is acting for each agent, the Director's Bash hook (turn and
// subagent, composed with the credit gate), the Stop hooks, host Claude Code's settings, the forwarder and the methods
// main answers itself, the G2 timing log, and nothing at all with Carton off.
//   node --test scripts/carton/test/main-bridge.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const load = (env) => {
  const saved = { ...process.env };
  Object.assign(process.env, { CARDBOARD_CARTON: "", CARDBOARD_CARTON_TIMING: "" }, env);
  try { return new Function("require", require("../main-bridge.js") + "return __cartonMain;")(require); }
  finally { process.env = saved; }
};
const gate = (out) => async () => out;

test("off: everything passes through", async () => {
  const m = load({});
  const env = { A: "1" };
  assert.equal(m.agentEnv(env, "claude", "c1"), env);
  assert.equal(m.directorEnv(env, { chatId: "c1" }, () => "t"), env);
  const inner = gate({});
  assert.equal(m.directorHook({ chatId: "c1" }, inner), inner);
  assert.deepEqual(m.stopHooks({}), {});
  assert.deepEqual(m.hostSettings(), []);
  assert.deepEqual(m.fileHooks({}), []);
  assert.deepEqual(m.viewPrompt({ id: "p1" }), [], "Cardboard's prompt, unchanged");
  assert.equal(m.call("enabled", []), false);
  assert.throws(() => m.call("undo", []), /Carton is off/);
});

test("every agent process is told who it is", () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  assert.deepEqual(m.agentEnv({ A: "1" }, "codex", "c9"), { A: "1", CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "codex/c9" });
  assert.deepEqual(m.directorEnv({}, { chatId: "c1" }, () => "t1"), { CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "director/c1" });
});

test("the Director's hook names the turn and the subagent, after the credit gate, and only for cb", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  m.directorEnv({}, { chatId: "c1" }, () => "turn-7");
  const hook = m.directorHook({ chatId: "c1" }, gate({}));
  const r = await hook({ hook_event_name: "PreToolUse", tool_input: { command: "cd x && cb source apply Demo f.tsx" }, agent_id: "a1", agent_type: "Explore" });
  assert.equal(r.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(r.hookSpecificOutput.updatedInput.command, "export CARDBOARD_ACTOR='director/c1/turn-7/sub-Explore-a1'; cd x && cb source apply Demo f.tsx");
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_input: { command: "ls -la" } }), {});
  // The credit gate's rewrite is kept and prefixed; its deny stays a deny.
  const rewritten = m.directorHook({ chatId: "c1" }, gate({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "cb generate video --confirm" }, additionalContext: "ok" } }));
  const rr = await rewritten({ hook_event_name: "PreToolUse", tool_input: { command: "cb generate video" } });
  assert.equal(rr.hookSpecificOutput.updatedInput.command, "export CARDBOARD_ACTOR='director/c1/turn-7'; cb generate video --confirm");
  assert.equal(rr.hookSpecificOutput.additionalContext, "ok");
  const denied = m.directorHook({ chatId: "c1" }, gate({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no credits" } }));
  assert.equal((await denied({ hook_event_name: "PreToolUse", tool_input: { command: "cb generate video" } })).hookSpecificOutput.permissionDecision, "deny");
});

test("Stop blocks once per conflict set (the worker's stopHook decides), and a stop that goes through lets go", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  const answers = [{ decision: "block", reason: "1 of your changes conflicted after your turn" }, {}];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), method === "carton.stopHook" ? answers.shift() : { delivered: true }) });
  const { Stop, SubagentStop } = m.stopHooks({ chatId: "c1", project: { bundlePath: "/b" } });
  assert.deepEqual(await Stop[0].hooks[0]({ hook_event_name: "Stop" }), { decision: "block", reason: "1 of your changes conflicted after your turn" });
  const second = { hook_event_name: "SubagentStop", stop_hook_active: true, agent_id: "a1", agent_type: "Explore" };
  assert.deepEqual(await SubagentStop[0].hooks[0](second), {});
  // H8: the blocked stop goes on with the turn (the agent keeps its hold on timeline.tsx); the one that goes through
  // lets go of it in the worker's Materializer
  assert.deepEqual(asked, [
    ["carton.stopHook", { bundlePath: "/b", actor: "director/c1", input: { hook_event_name: "Stop" } }],
    ["carton.stopHook", { bundlePath: "/b", actor: "director/c1/sub-Explore-a1", input: second }],
    ["carton.agentHook", { bundlePath: "/b", actor: "director/c1/sub-Explore-a1", event: "stop", input: undefined }],
  ]);
  // a worker that fails to answer never holds the agent
  m.library({ call: async () => { throw new Error("gone"); } });
  assert.deepEqual(await Stop[0].hooks[0]({ hook_event_name: "Stop" }), {});
});

test("H8: the Director's file tools, a Bash read of timeline.tsx and the turn's end reach the worker's Materializer", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), method === "carton.stopHook" ? {} : { delivered: true }) });
  const ctx = { chatId: "c1", project: { id: "p1", bundlePath: "/b" } };
  m.directorEnv({}, ctx, () => "t7");
  const [files] = m.fileHooks(ctx);
  assert.equal(files.matcher, "Read|Write|Edit|MultiEdit");
  const read = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/b/timeline.tsx" }, agent_id: "a1", agent_type: "Explore" };
  assert.deepEqual(await files.hooks[0](read), {}, "never a decision");
  assert.deepEqual(asked.pop(), ["carton.agentHook", { bundlePath: "/b", actor: "director/c1/t7/sub-Explore-a1", event: "pre-tool-use", input: { ...read, cwd: "/b" } }]);
  // the worker's one decision, a refused Write of project.json, is the hook's answer (anything else is not)
  const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "use your view" } };
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { delivered: false, output: deny }) });
  assert.deepEqual(await files.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/b/project.json" } }), deny);
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { delivered: true, output: { hookSpecificOutput: { permissionDecision: "allow" } } }) });
  assert.deepEqual(await files.hooks[0](read), {}, "never an allow");
  asked.splice(0);
  m.library({ call: async (method, arg) => (asked.push([method, arg]), method === "carton.stopHook" ? {} : { delivered: true }) });
  // a Bash command that reads the shared file freezes it as a Read does; one that doesn't name it sends nothing
  await m.directorHook(ctx, gate({}))({ hook_event_name: "PreToolUse", tool_input: { command: "cat timeline.tsx" } });
  assert.deepEqual(asked.pop(), ["carton.agentHook", { bundlePath: "/b", actor: "director/c1/t7", event: "pre-tool-use", input: { hook_event_name: "PreToolUse", tool_input: { file_path: "timeline.tsx" }, tool_name: "Read", cwd: "/b" } }]);
  await m.directorHook(ctx, gate({}))({ hook_event_name: "PreToolUse", tool_input: { command: "cb history Demo" } });
  assert.equal(asked.length, 0);
  // an allowed Stop lets go; the turn's end lets go of the turn and its subagents (however it ended)
  assert.deepEqual(await m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop" }), {});
  assert.deepEqual(asked.splice(0), [["carton.stopHook", { bundlePath: "/b", actor: "director/c1/t7", input: { hook_event_name: "Stop" } }], ["carton.agentHook", { bundlePath: "/b", actor: "director/c1/t7", event: "stop", input: undefined }]]);
  const chat = { chatId: "c1", turn: { id: "t7", state: "running", text: "Tighten it." } };
  m.turnStarted(chat, "p1", "/b", chat.turn, "director");
  m.turnEnded(chat);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.map(([method, a]) => [method, a.event ?? a.prompt]), [["carton.agentHook", "endTurn"], ["carton.nameTurn", "Tighten it."]]);
  assert.equal(asked[0][1].actor, "director/c1/t7");
});

test("H8: every agent's appended prompt gains the view flow with Carton on", () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const [line] = m.viewPrompt({ id: "p1" });
  assert.match(line, /`cb source print p1 --view <name>`/);
  assert.match(line, /`timeline\.tsx` keeps showing the state your turn started from until your turn ends/);
  assert.match(line, /`cb conflicts p1`/);
});

test("host Claude Code gets the hooks through --settings; carton:call forwards to the worker", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const [flag, json] = m.hostSettings();
  assert.equal(flag, "--settings");
  const h = JSON.parse(json).hooks;
  assert.deepEqual([h.PreToolUse[0].matcher, h.PreToolUse[0].hooks[0].command, h.Stop[0].hooks[0].command, h.SubagentStop[0].hooks[0].command], ["Bash", "cb carton-hook pre-tool-use", "cb carton-hook stop", "cb carton-hook subagent-stop"]);
  // H8: the file tools the holder's Materializer hears of, each only for its files (Claude Code's `if`: any other
  // file starts no process)
  const files = h.PreToolUse.slice(1).flatMap((e) => e.hooks.map((x) => [e.matcher, x.command, x.if]));
  const cmd = "cb carton-hook pre-tool-use";
  assert.deepEqual(files, [
    ["Read", cmd, "Read(**/timeline.tsx)"],
    ...["Write", "Edit", "MultiEdit"].flatMap((t) => [[t, cmd, `${t}(**/timeline.tsx)`], [t, cmd, `${t}(**/project.json)`]]),
  ]);
  m.library({ call: async (method, ...args) => [method, ...args] });
  assert.deepEqual(await m.call("undo", [{ projectId: "p1" }]), ["carton.undo", { projectId: "p1" }]);
  assert.throws(() => m.call("../x", []), /Unknown Carton method/);
});

test("a method main answers itself (the live-sync half) runs there, and can still reach the worker", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  m.library({ call: async (method, ...args) => [method, ...args] });
  m.handle("invite", async (a) => ["main", a, await m.forward("syncStatus", [a])]);
  assert.deepEqual(await m.call("invite", [{ projectId: "p1" }]), ["main", { projectId: "p1" }, ["carton.syncStatus", { projectId: "p1" }]]);
  assert.deepEqual(await m.call("undo", [{ projectId: "p1" }]), ["carton.undo", { projectId: "p1" }]);
  assert.throws(() => m.handle("enabled", () => true), /letters only/);
  assert.throws(() => m.handle("a.b", () => true), /letters only/);
  // Off, it is never reached.
  const off = load({});
  off.handle("invite", () => "main");
  assert.throws(() => off.call("invite", []), /Carton is off/);
});

test("G2's timing log records each save's round trip, on and off", async () => {
  const file = path.join(os.tmpdir(), `carton-timing-${process.pid}.jsonl`);
  fs.rmSync(file, { force: true });
  for (const on of ["1", ""]) {
    const m = load({ CARDBOARD_CARTON: on, CARDBOARD_CARTON_TIMING: file });
    assert.equal(await m.time(new Promise((r) => setTimeout(() => r(true), 20))), true);
  }
  await new Promise((r) => setTimeout(r, 50));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  fs.rmSync(file, { force: true });
  assert.deepEqual(lines.map((l) => l.carton), [true, false]);
  assert.ok(lines.every((l) => l.ms >= 15));
  // Without the variable, nothing is wrapped.
  const p = Promise.resolve(1);
  assert.equal(load({ CARDBOARD_CARTON: "1" }).time(p), p);
});

test("a Director turn's end asks the worker to name its last version; the prompt is never logged", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [], logged = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { status: "named" }) });
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(original)) console[k] = (...a) => logged.push(a.join(" "));
  try {
    const chat = { chatId: "c1", turn: { state: "running" } };
    m.turnStarted(chat, "p1", "/b", { id: "t9", text: "Make the intro tighter, then add a title." }, "director");
    m.turnEnded(chat, "result");
    const host = { chatId: "c2", turn: { state: "running" } };
    m.turnStarted(host, "p1", "/b", { id: "t1", text: "secret words" }, "claude");
    m.turnEnded(host, "result");
    await new Promise((r) => setImmediate(r));
  } finally { Object.assign(console, original); }
  // (H8: first the turn lets go of the shared timeline.tsx; the prompt goes only to nameTurn)
  assert.deepEqual(asked, [["carton.agentHook", { bundlePath: "/b", actor: "director/c1/t9", event: "endTurn", input: undefined }], ["carton.nameTurn", { projectId: "p1", chat: "c1", turn: "t9", prompt: "Make the intro tighter, then add a title." }]]);
  assert.ok(!logged.some((l) => /intro|secret/.test(l)), logged.join("\n"));
  // Off: nothing is remembered or asked.
  const off = load({});
  const offAsked = [];
  off.library({ call: async (...a) => offAsked.push(a) });
  const c = { chatId: "c3", turn: { state: "running" } };
  off.turnStarted(c, "p1", "/b", { id: "t2", text: "x" }, "director");
  off.turnEnded(c);
  assert.deepEqual(offAsked, []);
});
