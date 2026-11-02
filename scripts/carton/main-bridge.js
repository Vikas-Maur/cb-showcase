// Carton's part of Cardboard's main process (dist/main.js), patched in by patch-carton.js:
// - H9: who is acting. Every agent main starts gets CARDBOARD_ACTOR (and CARDBOARD_CARTON, so its cb calls agree).
//   The Director's Bash hook adds the running turn and, inside a subagent, the subagent (Claude Code puts agent_id
//   and agent_type in the hook input). Stop and SubagentStop hand a late conflict back to the agent, once per conflict
//   set (§6.2). Cardboard 1.4.0 runs the person's own Claude Code (provider "claude") through the same Agent SDK
//   transport as the Director, with the same in-process hooks: there they name it claude-code/<session> (laptop #8,
//   hookActor), never the Director. A Claude Code Cardboard spawned as a process would get the hooks through
//   --settings, run by `cb carton-hook` (hostSettings); 1.4.0 spawns only Codex, which gets agentEnv's actor.
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
  const subOf = (input) => (input?.agent_id ? "/sub-" + safe(input.agent_type || "agent") + "-" + safe(input.agent_id).replace(/-/g, "_") : "");
  // Laptop #8: Cardboard 1.4.0 runs two agents through its Agent SDK transport (oH), with the same in-process hooks
  // (the ones directorHook, fileHooks and stopHooks extend): the Director (RVt, provider "director") and the person's own
  // Claude Code (v_e, provider "claude": the composer's Claude Code models). Only the Director gets directorEnv and a
  // turn id; the person's Claude Code is never started by deps.spawn, so agentEnv and hostSettings never reach it. Its
  // hooks name it as @carton/local names a hooked Claude Code without a Director turn (actorIdForHook; the worker's
  // stopHook too): claude-code/<session>[/sub-<type>-<id>], "Claude Code" in History and credits. Named director/<chat>
  // (the laptop's "Director (chat 7a09…)"), the turn's end told the wrong actors: its version went unnamed. A context
  // without a provider is the Director's, as before.
  const forDirector = (ctx) => !ctx?.launch?.provider || ctx.launch.provider === "director";
  // The ids the hooks gave each chat's running turn (claude-code/<session>), so its end tells exactly those (turnEnded).
  const hooked = new Map();
  const hookActor = (ctx, input) => {
    if (forDirector(ctx)) {
      const turn = turns.get(ctx.chatId)?.();
      return "director/" + safe(ctx.chatId) + (turn ? "/" + safe(turn) : "") + subOf(input);
    }
    const base = "claude-code/" + safe(String(input?.session_id ?? "session").slice(0, 8));
    if (ctx?.chatId !== undefined) (hooked.get(ctx.chatId) ?? hooked.set(ctx.chatId, new Set()).get(ctx.chatId)).add(base);
    return base + subOf(input);
  };
  // Review P2 (lap2): each chat's turn generation, one more at every turn's start and end (turnStarted, turnEnded). A
  // hook that waits (the worker's stopHook, the credit gate's question) can come back after its turn ended: an interrupt
  // ends it at once (closeTurn), and the person can resume the same session straight away. The person's own Claude Code
  // has the same id in every turn of a session (claude-code/<session>), so a late Stop's release would let go of the
  // next turn's hold on timeline.tsx (the person's edits in the file while that turn runs). Such a hook sends nothing
  // after its wait: the turn's end already let go of everything the turn held (endTurn). The Director's hooks share the
  // check (their ids carry the turn, so theirs could only release an ended turn's). Hook events go to the worker in the
  // order main sends them, so one sent before the turn's end is handled before anything the next turn sends.
  const gens = new Map();
  const genOf = (chatId) => gens.get(chatId) ?? 0;
  const nextGen = (chatId) => void gens.set(chatId, genOf(chatId) + 1);
  // Commands that reach Carton: cb, cardboard, or a script under the bundle that runs them. Others keep the actor
  // main gave the process (director/<chat>), so a script that calls cb is still the Director's, just without the turn.
  // (The person's own Claude Code has no actor of its own in its environment: a script's cb call there is cb's own
  // guess, claude-code@<host>, "Claude Code" without hooks.)
  const reachesCarton = (cmd) => /(^|[\s;&|(\x60])(cb|cardboard)(\.cmd)?(\s|$)/.test(cmd);
  // H8: a hook event for the worker's Materializer, waited for up to 3 s (the agent's tool call waits on it; a worker
  // that doesn't answer in time leaves the file as it is, never the agent stuck).
  const agentHook = (ctx, actor, event, input) => {
    if (!library || !ctx?.project?.bundlePath) return Promise.resolve();
    const call = library.call("carton.agentHook", { bundlePath: ctx.project.bundlePath, actor, event, input }).catch(() => {});
    return Promise.race([call, new Promise((r) => setTimeout(r, 3000).unref?.())]);
  };
  // Block once per conflict set: whatever the agent leaves unresolved becomes a card for the person (the worker's
  // stopHook: @carton/local's, as host Claude Code's cb carton-hook runs it, so the agent's own cards stay for cb
  // conflicts and cb resolve). A stop that goes through ends the agent's hold on the shared file (H8); a blocked one goes
  // on with the turn. Only within its turn (review P2, gens): one the worker answers after the turn ended lets go of
  // nothing.
  const stop = (ctx) => async (input) => {
    const gen = genOf(ctx?.chatId), actor = hookActor(ctx, input);
    let out = {};
    try { out = (await library?.call("carton.stopHook", { bundlePath: ctx.project.bundlePath, actor, input })) ?? {}; } catch {}
    if (out.decision === "block") return out;
    if (genOf(ctx?.chatId) === gen) await agentHook(ctx, actor, "stop");
    return {};
  };
  // Gate G2 (§6.2): with CARDBOARD_CARTON_TIMING=<file>, every GUI save's round trip to the library worker (the
  // commit and the write) is appended to <file> as a JSON line, Carton on or off, for comparing the two.
  const timing = process.env.CARDBOARD_CARTON_TIMING;
  // Each in-app agent's running turn per chat session (the Director's, the person's own Claude Code's, Codex's, the
  // others'), so its last version can be named when it ends (History shows turns as the chat's checkpoints) and its
  // hold on the shared timeline.tsx ends with it. The prompt goes only to the worker, into the project's own history:
  // never logged.
  const running = new WeakMap();
  // Laptop #8: who a turn's edits and holds are by. The Director's are its turn's (director/<chat>/<turn>). Another
  // provider's process outlives its turns, so its ids name no turn: agentEnv's <provider>/<chat> (the cb calls of an
  // agent Cardboard spawns: Codex), and for the person's own Claude Code the ids its hooks gave this turn
  // (claude-code/<session>: its Bash cb calls and its reads of timeline.tsx, hookActor) and the one from the session main
  // keeps for the chat. Its turn is told by time instead (nameTurn's since and until: the turn's start and end).
  const actorsOf = (chat, t) => {
    if (t.provider === "director") return ["director/" + safe(chat.chatId) + "/" + safe(t.turn)];
    const out = new Set([t.provider + "/" + chat.chatId]);
    const session = chat.sessionIds?.[t.provider];
    if (t.provider === "claude" && session) out.add("claude-code/" + safe(String(session).slice(0, 8)));
    for (const id of hooked.get(chat.chatId) ?? []) out.add(id);
    return [...out];
  };
  const handlers = new Map();
  const forward = (method, args) => {
    if (!library) throw new Error("The library is not open yet");
    return library.call("carton." + method, ...args);
  };
  return {
    on,
    turnStarted(chat, projectId, bundlePath, turn, provider) {
      if (!on || !provider) return;
      running.set(chat, { projectId, bundlePath, turn: turn.id, prompt: turn.text, provider, since: Date.now() });
      hooked.delete(chat.chatId);
      nextGen(chat.chatId);
    },
    turnEnded(chat) {
      const t = on ? running.get(chat) : null;
      if (!t) return;
      // review P2: the turn's hooks still waiting send nothing from here on (gens)
      nextGen(chat.chatId);
      running.delete(chat);
      const actors = actorsOf(chat, t), director = t.provider === "director";
      hooked.delete(chat.chatId);
      // H8: the turn and its subagents stop holding the shared file, however the turn ended (a stop, an interrupt).
      for (const actor of actors) void agentHook({ project: { bundlePath: t.bundlePath } }, actor, "endTurn");
      // Another provider's turn is told by its actors and its time, from its start to now (review P2: until): the request
      // can reach the worker after the next turn's edits, by the same actors.
      if (chat.turn?.state === "running" && library) library.call("carton.nameTurn", { projectId: t.projectId, chat: chat.chatId, turn: t.turn, prompt: t.prompt, ...(director ? {} : { actors, since: t.since, until: Date.now() }) }).catch(() => {});
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
    // An agent Cardboard spawns (deps.spawn: in 1.4.0, Codex).
    agentEnv(env, provider, chatId) {
      return on ? { ...env, CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: provider + "/" + chatId } : env;
    },
    directorEnv(env, ctx, turn) {
      if (!on) return env;
      turns.set(ctx.chatId, turn);
      return { ...env, CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "director/" + ctx.chatId };
    },
    // Wraps the PreToolUse Bash hook of Cardboard's Agent SDK transport (the credit gate; the Director's and, in 1.4.0,
    // the person's own Claude Code's): after it decides, a command that reaches Carton runs with the turn's (and
    // subagent's) actor, hookActor's. A denied command is left alone; a rewritten one is prefixed. A gate that answers
    // after its turn ended (its question waits on the person) adds nothing (review P2, gens): a read sent then would hold
    // timeline.tsx with no turn left to let go of it.
    directorHook(ctx, inner) {
      if (!on) return inner;
      return async (input) => {
        const gen = genOf(ctx?.chatId);
        const r = await inner(input);
        if (input?.hook_event_name !== "PreToolUse" || genOf(ctx?.chatId) !== gen) return r;
        const out = r?.hookSpecificOutput;
        if (out?.permissionDecision === "deny") return r;
        const tool = { ...input.tool_input, ...out?.updatedInput };
        const reads = typeof tool.command === "string" && /timeline\.tsx/i.test(tool.command), cb = typeof tool.command === "string" && reachesCarton(tool.command);
        if (!reads && !cb) return r;
        const actor = hookActor(ctx, input);
        // H8: a command that reads the shared file freezes it for the turn, as a Read of it does.
        if (reads) await agentHook(ctx, actor, "pre-tool-use", { ...input, tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: ctx.project?.bundlePath });
        if (!cb) return r;
        return { ...r, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...out, updatedInput: { ...tool, command: "export CARDBOARD_ACTOR=" + shQuote(actor) + "; " + tool.command } } };
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
        "While your turn runs, " + q("timeline.tsx") + " holds back the person's and teammates' changes, so it doesn't change under you, and shows your own: a " + q("cb") + " write's (" + q("cb source apply") + " and the others) by the time it returns (if it can't yet, its result says so), a view save's by the time its status file says how it landed. The others' changes reach it when your turn ends. " +
        q("cb conflicts " + id) + " lists your cards and " + q("cb resolve") + " picks one; the ones you leave go to the person."];
    },
    // H8: the file tools of the transport's agents (the Director, the person's own Claude Code), beside its Bash hook: a
    // Read or Write/Edit of timeline.tsx reaches the worker's Materializer, and a Write/Edit of project.json is refused
    // with a pointer to the agent's own view (PLAN §6.4). The worker decides as cb carton-hook decides (@carton/local's
    // preToolUse); its only decision is that deny.
    fileHooks(ctx) {
      if (!on) return [];
      return [{ matcher: "Read|Write|Edit|MultiEdit", hooks: [async (input) => {
        if (input?.hook_event_name !== "PreToolUse") return {};
        const r = await agentHook(ctx, hookActor(ctx, input), "pre-tool-use", { ...input, cwd: input.cwd ?? ctx.project?.bundlePath });
        return r?.output?.hookSpecificOutput?.permissionDecision === "deny" ? r.output : {};
      }] }];
    },
    // A Claude Code Cardboard spawns as a process (its args: --settings). 1.4.0 runs its Claude Code through the Agent
    // SDK transport instead (main's in-process hooks above), so this reaches it only if a build spawns it.
    hostSettings() {
      if (!on) return [];
      const hook = (event) => [{ type: "command", command: "cb carton-hook " + event }];
      // H8: the file tools the holder's Materializer hears of (a Read, Write or Edit of timeline.tsx: freeze, credit)
      // and the Write/Edit of project.json the hook refuses. Each behind Claude Code's "if" condition (permission-rule
      // syntax, checked inside Claude Code): a call on any other file starts no process, where a bare matcher started
      // cb for every Read and Edit an agent made. One entry per tool and file: a rule names one tool (Edit's covers
      // neither Write nor MultiEdit) and one pattern. "**/" matches the file at any depth, and outside the project too
      // (cb then answers nothing), in any case on Windows. A Claude Code without "if" runs them on every call: slower,
      // same answers.
      const files = (tool, names) => ({ matcher: tool, hooks: names.map((f) => ({ ...hook("pre-tool-use")[0], if: tool + "(**/" + f + ")" })) });
      return ["--settings", JSON.stringify({ hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: hook("pre-tool-use") },
          files("Read", ["timeline.tsx"]),
          ...["Write", "Edit", "MultiEdit"].map((tool) => files(tool, ["timeline.tsx", "project.json"])),
        ],
        Stop: [{ hooks: hook("stop") }],
        SubagentStop: [{ hooks: hook("subagent-stop") }],
      } })];
    },
  };
})();
`;
