// Carton's part of Cardboard's main process (dist/main.js), patched in by patch-carton.js:
// - H9: who is acting. Every agent main starts gets CARDBOARD_ACTOR (and CARDBOARD_CARTON, so its cb calls agree).
//   The Director's Bash hook adds the running turn and, inside a subagent, the subagent (Claude Code puts agent_id
//   and agent_type in the hook input). Stop and SubagentStop hand a late conflict back to the agent, once per conflict
//   set (§6.2). Host Claude Code gets the same hooks through --settings, run by `cb carton-hook`.
// - H8: the Director's hook events reach the library worker's Materializer for the project (sync/views.js, the
//   `carton.agentHook` service): a Read of timeline.tsx (or a Bash command naming it) freezes the shared file for the
//   turn, a Write/Edit of it is credited to the turn, and a stop the late-conflict hook lets through, or the turn's
//   end, lets go of the freeze and the turn's pins.
// - carton:call from the pages forwards to the library worker's `carton` namespace. (cb finds Carton's lease holder
//   through carton.db's lease row, so Cardboard's control socket needs no Carton method.) A method main itself must
//   answer (the live-sync half, scripts/carton/sync: a dialog, a link) is added with handle(name, fn); fn gets the
//   call's arguments and can reach the worker with forward(name, args).
// With Carton off, each function hands back what it was given and adds nothing.
module.exports = String.raw`var __cartonMain = (() => {
  const on = process.env.CARDBOARD_CARTON === "1";
  let library = null;
  // The Director's running turn per chat, asked when a hook runs (the chat's process outlives its turns).
  const turns = new Map();
  const shQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
  // Actor ids as @carton/local writes them (identity.ts): safe characters only, and a subagent's own id with "_" for
  // "-", so "sub-<type>-<id>" splits one way.
  const safe = (x) => String(x).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64);
  const directorActor = (ctx, input) => {
    const turn = turns.get(ctx.chatId)?.();
    return "director/" + safe(ctx.chatId) + (turn ? "/" + safe(turn) : "") + (input?.agent_id ? "/sub-" + safe(input.agent_type || "agent") + "-" + safe(input.agent_id).replace(/-/g, "_") : "");
  };
  // Commands that reach Carton: cb, cardboard, or a script under the bundle that runs them. Others keep the actor
  // main gave the process (director/<chat>), so a script that calls cb is still the Director's, just without the turn.
  const reachesCarton = (cmd) => /(^|[\s;&|(\x60])(cb|cardboard)(\.cmd)?(\s|$)/.test(cmd);
  const notices = async (ctx, input) => {
    try { return await library?.call("carton.notices", { bundlePath: ctx.project.bundlePath, actor: directorActor(ctx, input), take: true }) ?? []; }
    catch { return []; }
  };
  // H8: a hook event for the worker's Materializer, waited for up to 3 s (the agent's tool call waits on it; a worker
  // that doesn't answer in time leaves the file as it is, never the agent stuck).
  const agentHook = (ctx, actor, event, input) => {
    if (!library || !ctx?.project?.bundlePath) return Promise.resolve();
    const call = library.call("carton.agentHook", { bundlePath: ctx.project.bundlePath, actor, event, input }).catch(() => {});
    return Promise.race([call, new Promise((r) => setTimeout(r, 3000).unref?.())]);
  };
  const stop = (ctx) => async (input) => {
    // Block once per conflict set: whatever the agent leaves unresolved becomes a card for the person. A stop that
    // goes through ends the agent's hold on the shared file (a blocked one goes on with the turn).
    if (input?.stop_hook_active) return await agentHook(ctx, directorActor(ctx, input), "stop"), {};
    const list = await notices(ctx, input);
    if (!list.length) return await agentHook(ctx, directorActor(ctx, input), "stop"), {};
    return { decision: "block", reason: list.map((n) => n.text ?? String(n)).join("\n") };
  };
  // Gate G2 (§6.2): with CARDBOARD_CARTON_TIMING=<file>, every GUI save's round trip to the library worker (the
  // commit and the write) is appended to <file> as a JSON line, Carton on or off, for comparing the two.
  const timing = process.env.CARDBOARD_CARTON_TIMING;
  // The Director's running turn per chat session, so its last version can be named when it ends (History shows
  // turns as the chat's checkpoints). The prompt goes only to the worker, into the project's own history: never logged.
  const running = new WeakMap();
  const handlers = new Map();
  const forward = (method, args) => {
    if (!library) throw new Error("The library is not open yet");
    return library.call("carton." + method, ...args);
  };
  return {
    on,
    turnStarted(chat, projectId, bundlePath, turn, provider) {
      if (on && provider === "director") running.set(chat, { projectId, bundlePath, turn: turn.id, prompt: turn.text });
    },
    turnEnded(chat) {
      const t = on ? running.get(chat) : null;
      if (!t) return;
      running.delete(chat);
      // H8: the turn and its subagents stop holding the shared file, however the turn ended (a stop, an interrupt).
      void agentHook({ project: { bundlePath: t.bundlePath } }, "director/" + safe(chat.chatId) + "/" + safe(t.turn), "endTurn");
      if (chat.turn?.state === "running" && library) library.call("carton.nameTurn", { projectId: t.projectId, chat: chat.chatId, turn: t.turn, prompt: t.prompt }).catch(() => {});
    },
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
      if (handlers.has(method)) return handlers.get(method)(...args);
      return forward(method, args);
    },
    handle(name, fn) {
      if (!/^[a-zA-Z]+$/.test(name) || name === "enabled") throw new Error("A Carton method name is letters only, and not enabled: " + name);
      handlers.set(name, fn);
    },
    forward,
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
        // H8: a command that reads the shared file freezes it for the turn, as a Read of it does.
        if (typeof tool.command === "string" && /timeline\.tsx/i.test(tool.command)) await agentHook(ctx, directorActor(ctx, input), "pre-tool-use", { ...input, tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: ctx.project?.bundlePath });
        if (typeof tool.command !== "string" || !reachesCarton(tool.command)) return r;
        return { ...r, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...out, updatedInput: { ...tool, command: "export CARDBOARD_ACTOR=" + shQuote(directorActor(ctx, input)) + "; " + tool.command } } };
      };
    },
    stopHooks(ctx) {
      return on ? { Stop: [{ hooks: [stop(ctx)] }], SubagentStop: [{ hooks: [stop(ctx)] }] } : {};
    },
    // H8 (item 4): every agent's appended system prompt (Cardboard's ju: the Director, host Claude Code, Codex, the
    // others) gains Carton's view flow with Carton on; with Carton off nothing is added.
    viewPrompt(project) {
      if (!on) return [];
      const q = (x) => "\x60" + x + "\x60", id = project?.id ?? "<project>";
      return ["Other people may edit this project while you work (Carton is on). Edit your own copy of the timeline: " + q("cb source print " + id + " --view <name>") +
        " prints it and answers with the file to edit and its status file. Save it as you would " + q("timeline.tsx") + "; each save is applied as your change, and the status file says how it landed: " +
        q("confirmed") + ", " + q("conflicts") + " (someone else changed the same thing: what is there was kept, and the cards say what) or " + q("rejected") + " (with why). " +
        q("timeline.tsx") + " keeps showing the state your turn started from until your turn ends. " + q("cb conflicts " + id) + " lists your cards and " + q("cb resolve") + " picks one; the ones you leave go to the person."];
    },
    // H8: the Director's file tools, beside its Bash hook: a Read of timeline.tsx, a Write/Edit of it or of project.json
    // (the worker maps them as host Claude Code's hooks are mapped, @carton/local's hookEventFor). Never a decision.
    fileHooks(ctx) {
      if (!on) return [];
      return [{ matcher: "Read|Write|Edit|MultiEdit", hooks: [async (input) => {
        if (input?.hook_event_name === "PreToolUse") await agentHook(ctx, directorActor(ctx, input), "pre-tool-use", { ...input, cwd: input.cwd ?? ctx.project?.bundlePath });
        return {};
      }] }];
    },
    hostSettings() {
      if (!on) return [];
      const hook = (event) => [{ type: "command", command: "cb carton-hook " + event }];
      return ["--settings", JSON.stringify({ hooks: {
        // the Bash prefixer, and (H8) the file tools the holder's Materializer hears of (freeze, credit)
        PreToolUse: [{ matcher: "Bash", hooks: hook("pre-tool-use") }, { matcher: "Read|Write|Edit|MultiEdit", hooks: hook("pre-tool-use") }],
        Stop: [{ hooks: hook("stop") }],
        SubagentStop: [{ hooks: hook("subagent-stop") }],
      } })];
    },
  };
})();
`;
