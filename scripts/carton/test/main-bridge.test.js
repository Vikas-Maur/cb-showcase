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
  // a Bash command that reads the shared file freezes it as a Read does, and so does one that runs cb (regress prod4:
  // the turn's first cb call, a `cb source print` too, held nothing); one that does neither sends nothing
  const holdRead = (actor) => ["carton.agentHook", { bundlePath: "/b", actor, event: "pre-tool-use", input: { hook_event_name: "PreToolUse", tool_input: { file_path: "timeline.tsx" }, tool_name: "Read", cwd: "/b" } }];
  await m.directorHook(ctx, gate({}))({ hook_event_name: "PreToolUse", tool_input: { command: "cat timeline.tsx" } });
  assert.deepEqual(asked.pop(), holdRead("director/c1/t7"));
  await m.directorHook(ctx, gate({}))({ hook_event_name: "PreToolUse", tool_input: { command: "cb source print Demo" } });
  assert.deepEqual(asked.pop(), holdRead("director/c1/t7"));
  await m.directorHook(ctx, gate({}))({ hook_event_name: "PreToolUse", tool_input: { command: "ping -n 31 127.0.0.1" } });
  assert.equal(asked.length, 0);
  // a command the credit gate refuses holds nothing
  await m.directorHook(ctx, gate({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no credits" } }))({ hook_event_name: "PreToolUse", tool_input: { command: "cb generate video" } });
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

test("laptop #8: the person's own Claude Code, as Cardboard 1.4.0 runs it (the Agent SDK transport's in-process hooks, a \"claude\" launch, no directorEnv), is claude-code/<session>, and its turn's end tells and names exactly that", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), method === "carton.stopHook" ? {} : { delivered: true }) });
  // main's launch context, as oH gets it from v_e (dist/main.js: {project, chatId, binary, launch, sessionId, text})
  const chatId = "7a09b6cc-8553-4fe8-9942-0cf44eec39e2", session = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", me = "claude-code/787d66ff";
  const ctx = { project: { id: "p1", name: "Demo", bundlePath: "/b" }, chatId, binary: { path: "claude", environment: {} }, launch: { provider: "claude", model: "default" }, sessionId: null, text: "x" };
  const chat = { chatId, sessionIds: {}, turn: { id: "t1", state: "running", text: "Set W2 to 321." } };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  // every hook input carries the session (Claude Code's); the chat learns it from the stream's init
  const bash = m.directorHook(ctx, gate({}));
  const r = await bash({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: 'cb docs 2>&1 | head -50; grep -n "W2" timeline.tsx' } });
  assert.equal(r.hookSpecificOutput.updatedInput.command, `export CARDBOARD_ACTOR='${me}'; cb docs 2>&1 | head -50; grep -n "W2" timeline.tsx`, "Claude Code, never director/<chat>");
  assert.deepEqual(asked.pop(), ["carton.agentHook", { bundlePath: "/b", actor: me, event: "pre-tool-use", input: { hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: "/b" } }]);
  const sub = await bash({ hook_event_name: "PreToolUse", session_id: session, agent_id: "a-1", agent_type: "Explore", tool_input: { command: "cb history Demo" } });
  assert.match(sub.hookSpecificOutput.updatedInput.command, new RegExp(`^export CARDBOARD_ACTOR='${me}/sub-Explore-a_1'; `));
  // (its cb call holds timeline.tsx for the subagent: regress prod4)
  assert.equal(asked.pop()[1].actor, me + "/sub-Explore-a_1");
  const [files] = m.fileHooks(ctx);
  await files.hooks[0]({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: "/b/timeline.tsx" } });
  assert.equal(asked.pop()[1].actor, me);
  // its Stop: the worker's stopHook names it so too (@carton/local's actorIdForHook without a turn)
  assert.deepEqual(await m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session }), {});
  assert.deepEqual(asked.splice(0).map(([method, a]) => [method, a.actor, a.event]), [["carton.stopHook", me, undefined], ["carton.agentHook", me, "stop"]]);
  // the turn's end (Cardboard's closeTurn on the stream's result, or an interrupt): the actors its hooks used
  m.turnEnded(chat, "result");
  await new Promise((r) => setImmediate(r));
  const ends = asked.filter(([method, a]) => method === "carton.agentHook" && a.event === "endTurn").map(([, a]) => a.actor);
  assert.ok(ends.includes(me), "the turn's end lets go of what its hooks held: " + ends);
  const named = asked.find(([method]) => method === "carton.nameTurn")[1];
  assert.ok(named.actors.includes(me), "its version is found by its hooks' actor: " + named.actors);
  assert.equal(named.prompt, "Set W2 to 321.");
  // the next turn starts afresh; a hook with another session (a reset chat) is that turn's
  asked.splice(0);
  const chat2 = { chatId, sessionIds: { claude: session }, turn: { id: "t2", state: "running", text: "Again." } };
  m.turnStarted(chat2, "p1", "/b", chat2.turn, "claude");
  await bash({ hook_event_name: "PreToolUse", session_id: "11112222-new", tool_input: { command: "cb history Demo" } });
  m.turnEnded(chat2, "result");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.find(([method]) => method === "carton.nameTurn")[1].actors, ["claude/" + chatId, me, "claude-code/11112222"]);
  // the Director, as 1.4.0 launches it (provider "director"), keeps its turn's ids
  asked.splice(0);
  const dctx = { ...ctx, chatId: "c9", launch: { provider: "director", model: "x" } };
  m.directorEnv({}, dctx, () => "t5");
  const d = await m.directorHook(dctx, gate({}))({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "cb history Demo" } });
  assert.match(d.hookSpecificOutput.updatedInput.command, /^export CARDBOARD_ACTOR='director\/c9\/t5'; /);
  await m.stopHooks(dctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session });
  // its cb call's hold, then its Stop (the worker's stopHook, the release)
  assert.deepEqual(asked.map(([, a]) => a.actor), ["director/c9/t5", "director/c9/t5", "director/c9/t5"]);
});

/** A promise and the function that settles it, for a worker answer the test lets through when it chooses. */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const settle = () => new Promise((r) => setImmediate(r));

test("review P2 (lap2): a Stop still asking the worker when its turn ends (an interrupt) never lets go of the next turn's hold; the Director's shares it, and a Stop inside its turn still lets go", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [], held = [];
  // the worker's stopHook answers only when the test says (a slow worker, the reviewer's case)
  m.library({ call: (method, arg) => {
    asked.push([method, arg]);
    if (method !== "carton.stopHook") return Promise.resolve({ delivered: true });
    const d = deferred();
    held.push(d);
    return d.promise;
  } });
  const chatId = "7a09b6cc-8553-4fe8-9942-0cf44eec39e2", session = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", me = "claude-code/787d66ff";
  const ctx = { project: { id: "p1", name: "Demo", bundlePath: "/b" }, chatId, binary: { path: "claude", environment: {} }, launch: { provider: "claude", model: "default" }, sessionId: null };
  const chat = { chatId, sessionIds: { claude: session }, turn: { id: "t1", state: "running", text: "One." } };
  const [files] = m.fileHooks(ctx);
  const read = { hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: "/b/timeline.tsx" } };
  const releases = () => asked.filter(([method, a]) => method === "carton.agentHook" && a.event === "stop").map(([, a]) => a.actor);
  // turn 1 reads the shared file; its Stop asks the worker, which is slow to answer
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await files.hooks[0](read);
  const stop1 = m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session });
  await settle();
  assert.equal(held.length, 1, "the Stop is waiting on the worker");
  // the person interrupts: the turn's end lets go of what it held; they resume the same session, and turn 2 reads
  m.turnEnded(chat, "stopped");
  chat.turn = { id: "t2", state: "running", text: "Two." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await files.hooks[0](read);
  assert.deepEqual(asked.filter(([, a]) => a.event === "endTurn").map(([, a]) => a.actor), ["claude/" + chatId, me], "turn 1's end let go");
  // turn 1's Stop comes back: the hold is turn 2's now (the same claude-code/<session>), so it lets nothing go
  held.shift().resolve({});
  assert.deepEqual(await stop1, {});
  await settle();
  assert.deepEqual(releases(), [], "a stale Stop released the next turn's hold");
  // turn 2's own Stop, answered in its turn, lets go
  const stop2 = m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session });
  await settle();
  held.shift().resolve({});
  assert.deepEqual(await stop2, {});
  assert.deepEqual(releases(), [me], "the turn's own Stop lets go");
  m.turnEnded(chat, "result");
  // a Stop that comes back after its turn ended with no next turn yet: the end let go already, nothing more is sent
  asked.splice(0);
  chat.turn = { id: "t3", state: "running", text: "Three." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  const stop3 = m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session });
  await settle();
  m.turnEnded(chat, "error");
  held.shift().resolve({});
  await stop3;
  assert.deepEqual(releases(), [], "the errored turn's end let go; its Stop sends nothing after");
  assert.deepEqual(asked.filter(([, a]) => a.event === "endTurn").map(([, a]) => a.actor), ["claude/" + chatId, me], "the errored turn still ends");
  // the Director (the same hook code): its Stop in its turn lets go of the turn; one that outlives the turn does not
  asked.splice(0);
  const dctx = { ...ctx, chatId: "c9", launch: { provider: "director", model: "x" } };
  const dchat = { chatId: "c9", turn: { id: "d1", state: "running", text: "Cut it." } };
  let dturn = "d1";
  m.directorEnv({}, dctx, () => dturn);
  m.turnStarted(dchat, "p1", "/b", dchat.turn, "director");
  const ds1 = m.stopHooks(dctx).Stop[0].hooks[0]({ hook_event_name: "Stop" });
  await settle();
  m.turnEnded(dchat, "stopped");
  dchat.turn = { id: "d2", state: "running", text: "Again." };
  dturn = "d2";
  m.turnStarted(dchat, "p1", "/b", dchat.turn, "director");
  held.shift().resolve({});
  await ds1;
  assert.deepEqual(releases(), [], "the Director's stale Stop sends nothing");
  const ds2 = m.stopHooks(dctx).Stop[0].hooks[0]({ hook_event_name: "Stop" });
  await settle();
  held.shift().resolve({});
  await ds2;
  assert.deepEqual(releases(), ["director/c9/d2"], "the Director's own Stop lets go of its turn");
});

test("review P2 (lap2): a Bash hook whose credit gate answers after its turn ended (an interrupt) starts no hold on timeline.tsx", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { delivered: true }) });
  const chatId = "c1", session = "787d66ff-b5c3", ctx = { project: { id: "p1", bundlePath: "/b" }, chatId, launch: { provider: "claude" } };
  const chat = { chatId, sessionIds: { claude: session }, turn: { id: "t1", state: "running", text: "One." } };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  const gate = deferred();
  const pending = m.directorHook(ctx, () => gate.promise)({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "grep W2 timeline.tsx" } });
  m.turnEnded(chat, "stopped");
  asked.splice(0);
  gate.resolve({});
  await pending;
  await settle();
  assert.deepEqual(asked, [], "a read from an ended turn would hold timeline.tsx with no turn left to let go");
  // in its turn, the same command holds it
  chat.turn = { id: "t2", state: "running", text: "Two." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await m.directorHook(ctx, async () => ({}))({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "grep W2 timeline.tsx" } });
  assert.deepEqual(asked.map(([, a]) => [a.actor, a.event]), [["claude-code/787d66ff", "pre-tool-use"]]);
});

test("review P2 (lap2): a turn's name request carries the turn's end, so a late answer can't take the next turn's version", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { status: "named" }) });
  const chat = { chatId: "c2", sessionIds: { claude: "abcd1234-5678" }, turn: { id: "t1", state: "running", text: "One." } };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await new Promise((r) => setTimeout(r, 5));
  const before = Date.now();
  m.turnEnded(chat, "result");
  const after = Date.now();
  const named = asked.find(([method]) => method === "carton.nameTurn")[1];
  assert.ok(typeof named.until === "number" && named.until >= before && named.until <= after, "until is the turn's end: " + JSON.stringify(named));
  assert.ok(named.since <= named.until);
});

// Regress prod4 (director-hold): on the laptop the person's own Claude Code ran its first `cb source print` and a 30 s
// ping in Claude Code's PowerShell tool, which the transport hooked nowhere, so nothing held timeline.tsx until a
// later Bash command, and the person's mute reached the file mid-turn.
test("regress prod4: PowerShell commands get the Bash hook's Carton part: a cb command runs as the turn's actor (PowerShell's form) and holds timeline.tsx, a read of it holds, anything else is left alone; no decision is ever given", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { delivered: true }) });
  const session = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", me = "claude-code/787d66ff";
  const ctx = { project: { id: "p1", bundlePath: "/b" }, chatId: "c1", launch: { provider: "claude" } };
  const ps = m.fileHooks(ctx).find((h) => h.matcher === "PowerShell");
  assert.ok(ps, "a PowerShell entry among the transport's hooks");
  const call = (command, more = {}) => ps.hooks[0]({ hook_event_name: "PreToolUse", session_id: session, tool_name: "PowerShell", tool_input: { command, description: "x", timeout: 60000 }, ...more });
  const print = await call("cb source print 6288cf04");
  assert.deepEqual(print, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: `$env:CARDBOARD_ACTOR='${me}'; cb source print 6288cf04`, description: "x", timeout: 60000 } } }, "the actor in PowerShell's form; no permission decision");
  assert.deepEqual(asked.splice(0), [["carton.agentHook", { bundlePath: "/b", actor: me, event: "pre-tool-use", input: { hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: "/b" } }]], "the print holds timeline.tsx");
  // a subagent's call is its own
  const sub = await call("& cb history Demo", { agent_id: "a-1", agent_type: "Explore" });
  assert.equal(sub.hookSpecificOutput.updatedInput.command, `$env:CARDBOARD_ACTOR='${me}/sub-Explore-a_1'; & cb history Demo`);
  assert.equal(asked.pop()[1].actor, me + "/sub-Explore-a_1");
  // a read of the file holds it, unchanged; anything else is left alone and sends nothing
  assert.deepEqual(await call("Get-Content timeline.tsx | Select-String W2"), {});
  assert.equal(asked.pop()[1].event, "pre-tool-use");
  assert.deepEqual(await call("ping -n 31 127.0.0.1"), {});
  assert.deepEqual(await ps.hooks[0]({ hook_event_name: "PostToolUse", tool_name: "PowerShell", tool_input: { command: "cb history Demo" } }), {});
  assert.deepEqual(asked, [], "a call that touches neither cb nor timeline.tsx tells the worker nothing");
});

test("regress prod4: while the turn runs, each actor holding timeline.tsx is told again every 20 s (a long tool call with no hook never outlasts the worker's quiet bound); its Stop, a subagent's own, its end and Cardboard's closeTurn stop the beats first", async (tt) => {
  tt.mock.timers.enable({ apis: ["setInterval"] });
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [];
  let stopAnswer = {};
  m.library({ call: async (method, arg) => (asked.push([method, arg]), method === "carton.stopHook" ? stopAnswer : { delivered: true }) });
  const session = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", me = "claude-code/787d66ff", sub = me + "/sub-Explore-a_1";
  const ctx = { project: { id: "p1", bundlePath: "/b" }, chatId: "c1", launch: { provider: "claude" } };
  const bash = m.directorHook(ctx, gate({}));
  const [files] = m.fileHooks(ctx);
  const stop = m.stopHooks(ctx);
  const beats = () => asked.splice(0).filter(([method, a]) => method === "carton.agentHook" && a.event === "pre-tool-use").map(([, a]) => a.actor).sort();
  // a chat whose turn main doesn't track: its holds last until the worker's quiet bound, as before (no beats)
  await bash({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "cb source print Demo" } });
  asked.splice(0);
  tt.mock.timers.tick(60_000);
  assert.deepEqual(beats(), [], "no beats without a running turn");
  // the turn: its first cb call holds; a long call with no hook follows
  const chat = { chatId: "c1", sessionIds: { claude: session }, turn: { id: "t1", state: "running", text: "One." } };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await bash({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "cb source print Demo" } });
  await bash({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "ping -n 121 127.0.0.1" } });
  asked.splice(0);
  tt.mock.timers.tick(19_999);
  assert.deepEqual(beats(), []);
  tt.mock.timers.tick(1);
  assert.deepEqual(asked[0], ["carton.agentHook", { bundlePath: "/b", actor: me, event: "pre-tool-use", input: { tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: "/b" } }], "the beat is the hold's own event");
  assert.deepEqual(beats(), [me]);
  tt.mock.timers.tick(100_000);
  assert.deepEqual(beats(), [me, me, me, me, me], "every 20 s, for as long as the turn runs");
  // a subagent's Read of the file holds too (a Read of another file doesn't); its SubagentStop stops its own beats only
  await files.hooks[0]({ hook_event_name: "PreToolUse", session_id: session, agent_id: "a-1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/b/notes.md" } });
  assert.equal(asked.splice(0).length, 1, "(the Read itself goes to the worker, which decides)");
  tt.mock.timers.tick(20_000);
  assert.deepEqual(beats(), [me]);
  await files.hooks[0]({ hook_event_name: "PreToolUse", session_id: session, agent_id: "a-1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/b/timeline.tsx" } });
  tt.mock.timers.tick(20_000);
  assert.deepEqual(beats(), [me, sub, sub].sort(), "(its Read, then its beat)");
  assert.deepEqual(await stop.SubagentStop[0].hooks[0]({ hook_event_name: "SubagentStop", session_id: session, agent_id: "a-1", agent_type: "Explore" }), {});
  asked.splice(0);
  tt.mock.timers.tick(20_000);
  assert.deepEqual(beats(), [me], "a stopped subagent holds no longer");
  // a Stop the late-conflict hook blocks: the turn goes on, and so does its hold
  stopAnswer = { decision: "block", reason: "resolve" };
  assert.equal((await stop.Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session })).decision, "block");
  tt.mock.timers.tick(20_000);
  assert.deepEqual(beats(), [me]);
  // the turn's Stop: the beats stop before it lets go, and none comes after
  stopAnswer = {};
  assert.deepEqual(await stop.Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session, stop_hook_active: true }), {});
  assert.deepEqual(asked.splice(0).map(([method, a]) => [method, a.event]), [["carton.stopHook", undefined], ["carton.agentHook", "stop"]]);
  tt.mock.timers.tick(60_000);
  assert.deepEqual(beats(), [], "no beat after the Stop");
  m.turnEnded(chat, "result");
  chat.turn = { state: "idle" };
  // an interrupted turn (no Stop): its end stops the beats
  chat.turn = { id: "t2", state: "running", text: "Two." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await files.hooks[0]({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: "/b/timeline.tsx" } });
  tt.mock.timers.tick(20_000);
  assert.deepEqual(beats(), [me, me]);
  m.turnEnded(chat, "stopped");
  chat.turn = { state: "idle" };
  asked.splice(0);
  tt.mock.timers.tick(60_000);
  assert.deepEqual(beats(), [], "no beat after the turn's end");
  // a turn Cardboard closed without the end reaching the bridge: its own turn state stops the beats
  chat.turn = { id: "t3", state: "running", text: "Three." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  await bash({ hook_event_name: "PreToolUse", session_id: session, tool_input: { command: "cb history Demo" } });
  chat.turn = { state: "idle" };
  asked.splice(0);
  tt.mock.timers.tick(60_000);
  assert.deepEqual(beats(), [], "a turn Cardboard no longer runs holds nothing");
  // the next turn holds afresh, and a hold of the ended turn's never comes back
  chat.turn = { id: "t4", state: "running", text: "Four." };
  m.turnStarted(chat, "p1", "/b", chat.turn, "claude");
  tt.mock.timers.tick(60_000);
  assert.deepEqual(beats(), [], "nothing held until the new turn's first cb call");
  m.turnEnded(chat, "result");
});

test("H8: every agent's appended prompt gains the view flow with Carton on", () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const [line] = m.viewPrompt({ id: "p1" });
  assert.match(line, /`cb source print p1 --view <name>`/);
  // apply-ryw: the file holds back others' changes, never the agent's own (an agent read the old wording as "the file
  // shows my turn's start" and told the user its own apply would show only after its turn)
  assert.match(line, /`timeline\.tsx` holds back the person's and teammates' changes/);
  assert.match(line, /shows your own: a `cb` write's \(`cb source apply` and the others\) by the time it returns/);
  assert.doesNotMatch(line, /started from|until your turn ends/);
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

test("an in-app turn's end asks the worker to name its last version (the Director's, and laptop #8 any other provider's by its actors since the turn began); the prompt is never logged", async () => {
  const m = load({ CARDBOARD_CARTON: "1" });
  const asked = [], logged = [];
  m.library({ call: async (method, arg) => (asked.push([method, arg]), { status: "named" }) });
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(original)) console[k] = (...a) => logged.push(a.join(" "));
  try {
    const chat = { chatId: "c1", turn: { state: "running" } };
    m.turnStarted(chat, "p1", "/b", { id: "t9", text: "Make the intro tighter, then add a title." }, "director");
    m.turnEnded(chat, "result");
    const host = { chatId: "c2", sessionIds: { claude: "abcd1234-5678" }, turn: { state: "running" } };
    m.turnStarted(host, "p1", "/b", { id: "t1", text: "secret words" }, "claude");
    m.turnEnded(host, "result");
    await new Promise((r) => setImmediate(r));
  } finally { Object.assign(console, original); }
  // (H8: first the turn lets go of the shared timeline.tsx; the prompt goes only to nameTurn)
  const { since, until } = asked.find(([method, a]) => method === "carton.nameTurn" && a.chat === "c2")?.[1] ?? {};
  assert.ok(typeof since === "number" && since <= until && until <= Date.now());
  assert.deepEqual(asked, [
    ["carton.agentHook", { bundlePath: "/b", actor: "director/c1/t9", event: "endTurn", input: undefined }],
    ["carton.nameTurn", { projectId: "p1", chat: "c1", turn: "t9", prompt: "Make the intro tighter, then add a title." }],
    // host Claude Code: its cb calls' actor (agentEnv) and its hooks' (claude-code/<session>)
    ["carton.agentHook", { bundlePath: "/b", actor: "claude/c2", event: "endTurn", input: undefined }],
    ["carton.agentHook", { bundlePath: "/b", actor: "claude-code/abcd1234", event: "endTurn", input: undefined }],
    ["carton.nameTurn", { projectId: "p1", chat: "c2", turn: "t1", prompt: "secret words", actors: ["claude/c2", "claude-code/abcd1234"], since, until }],
  ]);
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
