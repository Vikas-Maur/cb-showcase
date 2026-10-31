// Carton's part of Cardboard's main process (dist/main.js), patched in by patch-carton.js:
// - H9: who is acting. Every agent main starts gets CARDBOARD_ACTOR (and CARDBOARD_CARTON, so its cb calls agree).
//   The Director's Bash hook adds the running turn and, inside a subagent, the subagent (Claude Code puts agent_id
//   and agent_type in the hook input). Stop and SubagentStop hand a late conflict back to the agent, once per conflict
//   set (§6.2). Host Claude Code gets the same hooks through --settings, run by `cb carton-hook`.
// - carton:call from the pages forwards to the library worker's `carton` namespace. (cb finds Carton's lease holder
//   through carton.db's lease row, so Cardboard's control socket needs no Carton method.)
// With Carton off, each function hands back what it was given and adds nothing.
module.exports = String.raw`var __cartonMain = (() => {
  const on = process.env.CARDBOARD_CARTON === "1";
  let library = null;
  // The Director's running turn per chat, asked when a hook runs (the chat's process outlives its turns).
  const turns = new Map();
  const shQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
  const directorActor = (ctx, input) => {
    const turn = turns.get(ctx.chatId)?.();
    return "director/" + ctx.chatId + (turn ? "/" + turn : "") + (input?.agent_id ? "/sub-" + (input.agent_type || "agent") + "-" + input.agent_id : "");
  };
  // Commands that reach Carton: cb, cardboard, or a script under the bundle that runs them. Others keep the actor
  // main gave the process (director/<chat>), so a script that calls cb is still the Director's, just without the turn.
  const reachesCarton = (cmd) => /(^|[\s;&|(\x60])(cb|cardboard)(\.cmd)?(\s|$)/.test(cmd);
  const notices = async (ctx, input) => {
    try { return await library?.call("carton.notices", { bundlePath: ctx.project.bundlePath, actor: directorActor(ctx, input), take: true }) ?? []; }
    catch { return []; }
  };
  const stop = (ctx) => async (input) => {
    // Block once per conflict set: whatever the agent leaves unresolved becomes a card for the person.
    if (input?.stop_hook_active) return {};
    const list = await notices(ctx, input);
    if (!list.length) return {};
    return { decision: "block", reason: list.map((n) => n.text ?? String(n)).join("\n") };
  };
  // Gate G2 (§6.2): with CARDBOARD_CARTON_TIMING=<file>, every GUI save's round trip to the library worker (the
  // commit and the write) is appended to <file> as a JSON line, Carton on or off, for comparing the two.
  const timing = process.env.CARDBOARD_CARTON_TIMING;
  return {
    on,
    time(p) {
      if (!timing) return p;
      const t0 = performance.now();
      return p.finally(() => require("node:fs").appendFile(timing, JSON.stringify({ at: Date.now(), ms: +(performance.now() - t0).toFixed(2), carton: on }) + "\n", () => {}));
    },
    library(lib) { library = lib; },
    call(method, args) {
      // The pages ask once, at start, whether to take Carton's paths.
      if (method === "enabled") return on;
      if (!on) throw new Error("Carton is off (CARDBOARD_CARTON=1 turns it on)");
      if (!/^[a-zA-Z]+$/.test(method)) throw new Error("Unknown Carton method " + method);
      if (!library) throw new Error("The library is not open yet");
      return library.call("carton." + method, ...args);
    },
    agentEnv(env, provider, chatId) {
      return on ? { ...env, CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: provider + "/" + chatId } : env;
    },
    directorEnv(env, ctx, turn) {
      if (!on) return env;
      turns.set(ctx.chatId, turn);
      return { ...env, CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "director/" + ctx.chatId };
    },
    // Wraps the Director's PreToolUse Bash hook (the credit gate): after it decides, a command that reaches Carton
    // runs with the turn's (and subagent's) actor. A denied command is left alone; a rewritten one is prefixed.
    directorHook(ctx, inner) {
      if (!on) return inner;
      return async (input) => {
        const r = await inner(input);
        if (input?.hook_event_name !== "PreToolUse") return r;
        const out = r?.hookSpecificOutput;
        if (out?.permissionDecision === "deny") return r;
        const tool = { ...input.tool_input, ...out?.updatedInput };
        if (typeof tool.command !== "string" || !reachesCarton(tool.command)) return r;
        return { ...r, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...out, updatedInput: { ...tool, command: "export CARDBOARD_ACTOR=" + shQuote(directorActor(ctx, input)) + "; " + tool.command } } };
      };
    },
    stopHooks(ctx) {
      return on ? { Stop: [{ hooks: [stop(ctx)] }], SubagentStop: [{ hooks: [stop(ctx)] }] } : {};
    },
    hostSettings() {
      if (!on) return [];
      const hook = (event) => [{ type: "command", command: "cb carton-hook " + event }];
      return ["--settings", JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: hook("pre-tool-use") }],
        Stop: [{ hooks: hook("stop") }],
        SubagentStop: [{ hooks: hook("subagent-stop") }],
      } })];
    },
  };
})();
`;
