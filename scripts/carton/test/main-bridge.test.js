// Main's bridge (scripts/carton/main-bridge.js): who is acting for each agent, the Director's Bash hook (turn and
// subagent, composed with the credit gate), the Stop hooks, host Claude Code's settings, the forwarder, the G2 timing
// log, and nothing at all with Carton off.
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

test("Stop blocks once per conflict set with the actor's notices", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), [{ text: "W2's size was changed by Bob meanwhile" }]) });
  const { Stop, SubagentStop } = m.stopHooks({ chatId: "c1", project: { bundlePath: "/b" } });
  assert.deepEqual(await Stop[0].hooks[0]({ hook_event_name: "Stop" }), { decision: "block", reason: "W2's size was changed by Bob meanwhile" });
  assert.deepEqual(await SubagentStop[0].hooks[0]({ hook_event_name: "SubagentStop", stop_hook_active: true }), {});
  assert.deepEqual(asked, [["carton.notices", { bundlePath: "/b", actor: "director/c1", take: true }]]);
});

test("host Claude Code gets the hooks through --settings; carton:call forwards to the worker", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const [flag, json] = m.hostSettings();
  assert.equal(flag, "--settings");
  const h = JSON.parse(json).hooks;
  assert.deepEqual([h.PreToolUse[0].matcher, h.PreToolUse[0].hooks[0].command, h.Stop[0].hooks[0].command, h.SubagentStop[0].hooks[0].command], ["Bash", "cb carton-hook pre-tool-use", "cb carton-hook stop", "cb carton-hook subagent-stop"]);
  m.library({ call: async (method, ...args) => [method, ...args] });
  assert.deepEqual(await m.call("undo", [{ projectId: "p1" }]), ["carton.undo", { projectId: "p1" }]);
  assert.throws(() => m.call("../x", []), /Unknown Carton method/);
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
  assert.deepEqual(asked, [["carton.nameTurn", { projectId: "p1", chat: "c1", turn: "t9", prompt: "Make the intro tighter, then add a title." }]]);
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
