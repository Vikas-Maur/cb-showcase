// Carton's part of Cardboard's main process (dist/main.js), patched in by patch-carton.js:
// - H9: who is acting. Every agent main starts gets CARDBOARD_ACTOR (and CARDBOARD_CARTON, so its cb calls agree).
//   The Director's Bash hook adds the running turn and, inside a subagent, the subagent (Claude Code puts agent_id
//   and agent_type in the hook input). Stop and SubagentStop hand a late conflict back to the agent, once per conflict
//   set (§6.2). Cardboard 1.4.0 runs the person's own Claude Code (provider "claude") through the same Agent SDK
//   transport as the Director, with the same in-process hooks: there they name it claude-code/<session> (laptop #8,
//   hookActor), never the Director. A Claude Code Cardboard spawned as a process would get the hooks through
//   --settings, run by `cb carton-hook` (hostSettings); 1.4.0 spawns only Codex, which gets agentEnv's actor.
// - H8: the Director's hook events reach the library worker's Materializer for the project (sync/views.js, the
//   `carton.agentHook` service): a Read of timeline.tsx, or a Bash or PowerShell command naming it or running cb (a
//   `cb source print` too), freezes the shared file for the turn, a Write/Edit of it is credited to the turn, and a
//   stop the late-conflict hook lets through, or the turn's end, lets go of the freeze and the turn's pins. While the
//   turn runs, main tells the worker again every 20 s, so a long tool call with no hook (a ping, a render) never
//   outlasts the worker's one-minute quiet bound (regress prod4, director-hold).
// - carton:call from the pages forwards to the library worker's `carton` namespace. (cb finds Carton's lease holder
//   through carton.db's lease row, so Cardboard's control socket needs no Carton method.) A method main itself must
//   answer (the live-sync half, scripts/carton/sync: a dialog, a link) is added with handle(name, fn); fn gets the
//   call's arguments and can reach the worker with forward(name, args).
// Carton is on by default; CARDBOARD_CARTON=0 (or false / off / no) turns it off (the same rule in cli-bridge.js and
// store-bridge.js). With Carton off, each function hands back what it was given and adds nothing.
module.exports = String.raw`var __cartonMain = (() => {
  const on = !/^(?:0|false|off|no)$/i.test(String(process.env.CARDBOARD_CARTON ?? "").trim());
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
  // guess, claude-code@<host>, "Claude Code" without hooks.) Review of fix/turn-hold #2: any case (PowerShell's command
  // names are, and Windows finds CB.cmd for CB), and as a path's last part, quoted or not (& 'C:\...\cb.cmd' source
  // print). A command that only mentions the word is prefixed and holds the file too: harmless, an environment variable
  // and a hold that ends with the turn.
  const reachesCarton = (cmd) => /(^|[\s;&|(\x60'"\\/])(cb|cardboard)(\.cmd|\.exe)?(?=$|[\s;&|)\x60'"])/i.test(cmd);
  // H8: a hook event for the worker's Materializer, waited for up to 3 s (the agent's tool call waits on it; a worker
  // that doesn't answer in time leaves the file as it is, never the agent stuck).
  const agentHook = (ctx, actor, event, input) => {
    if (!library || !ctx?.project?.bundlePath) return Promise.resolve();
    const call = library.call("carton.agentHook", { bundlePath: ctx.project.bundlePath, actor, event, input }).catch(() => {});
    return Promise.race([call, new Promise((r) => setTimeout(r, 3000).unref?.())]);
  };
  // The hook event that holds timeline.tsx for an actor: a Read of the project's timeline.tsx (the worker's hookRead).
  const holdInput = (ctx, input) => ({ ...input, tool_name: "Read", tool_input: { file_path: "timeline.tsx" }, cwd: ctx.project?.bundlePath });
  // Regress prod4 (director-hold, the laptop): a turn's hold on timeline.tsx lasts the whole turn. The worker lets go
  // of a hooked actor it hasn't heard from for a minute (its quiet bound: a Stop can be lost), and a tool call that
  // isn't cb sends no hook (a 30 s ping in the foreground, a render, a backgrounded command the agent waits on): the
  // person's edits reached the file mid-turn. Main knows the turn still runs (Cardboard's own turn state): every
  // HOLD_BEAT_MS while it does, each actor that holds the file this turn is told again, with the same hold event. The
  // turn's Stop (a subagent's for itself) and its end stop the beats before they let go, so no beat holds after them;
  // a turn main stops hearing from (the app gone) is let go by the worker at its quiet bound, as before.
  const HOLD_BEAT_MS = 20_000;
  // The chat's turn as turnStarted saw it (Cardboard's chat object: closeTurn replaces its turn), and its generation.
  const live = new Map();
  // chatId → the chat's running turn's holds: its generation, the actors holding timeline.tsx, the ones whose Stop
  // went through (gone; stopped: the turn's own Stop), and the beat.
  const holds = new Map();
  const turnRuns = (chatId, gen) => {
    const l = live.get(chatId);
    return !!l && l.gen === gen && genOf(chatId) === gen && l.chat.turn?.state === "running" && l.chat.turn.id === l.turn;
  };
  // The turn's holds for generation gen, made if needed (another generation's are let go first).
  const holdsOf = (chatId, gen, ctx) => {
    let h = holds.get(chatId);
    if (h && h.gen !== gen) endHolds(chatId), (h = null);
    if (!h) holds.set(chatId, (h = { gen, ctx, actors: new Set(), gone: new Set(), stopped: false, timer: null }));
    return h;
  };
  // The turn started or ended: its beats stop and its holds are forgotten.
  const endHolds = (chatId) => {
    const h = holds.get(chatId);
    if (h?.timer) clearInterval(h.timer);
    holds.delete(chatId);
  };
  // A Stop that went through in generation gen: the subagent's own (actor), else the whole turn's. Kept, so a hook
  // of the turn's that answers after it (review of fix/turn-hold #1) can't hold again in this turn.
  const stopHolds = (chatId, gen, actor) => {
    const h = holdsOf(chatId, gen, null);
    if (actor) h.actors.delete(actor), h.gone.add(actor);
    else h.stopped = true, h.actors.clear();
    if (!h.actors.size && h.timer) clearInterval(h.timer), (h.timer = null);
  };
  const beat = (chatId) => {
    const h = holds.get(chatId);
    if (!h || !turnRuns(chatId, h.gen)) return endHolds(chatId);
    for (const actor of h.actors) void agentHook(h.ctx, actor, "pre-tool-use", holdInput(h.ctx, {}));
  };
  // The actor holds timeline.tsx from now on, while the chat's turn of generation gen (the one its hook was called
  // in, read before any wait: review of fix/turn-hold #1) runs and hasn't stopped. A chat whose turn main doesn't
  // track: until the worker's quiet bound, as before.
  const keepHolding = (ctx, actor, gen) => {
    const chatId = ctx?.chatId;
    if (!turnRuns(chatId, gen)) return;
    const h = holdsOf(chatId, gen, ctx);
    if (h.stopped || h.gone.has(actor)) return;
    h.ctx = ctx;
    h.actors.add(actor);
    if (!h.timer) (h.timer = setInterval(() => beat(chatId), HOLD_BEAT_MS)), h.timer.unref?.();
  };
  // H8, regress prod4: a shell command of the turn's (Bash, PowerShell) that reaches Carton (its first cb call: a print
  // too, which holds nothing in the worker) or names the shared file holds timeline.tsx for the turn from now on, as
  // a Read of it does. gen: the turn the hook was called in. Returns the actor a cb command must run as, or null.
  const shellHold = async (ctx, input, command, gen) => {
    if (typeof command !== "string") return null;
    const reads = /timeline\.tsx/i.test(command), cb = reachesCarton(command);
    if (!reads && !cb) return null;
    const actor = hookActor(ctx, input);
    keepHolding(ctx, actor, gen);
    await agentHook(ctx, actor, "pre-tool-use", holdInput(ctx, input));
    return cb ? actor : null;
  };
  const psQuote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
  // Review of fix/turn-hold #3: a PowerShell command whose opening must stay first (a using statement, a param block,
  // or the attribute before one, after any comments) breaks with an assignment in front (checked in PowerShell 7.4):
  // it runs as it is, its cb calls as cb's own guess (Claude Code). The hold is sent all the same.
  const psOpening = (cmd) => /^(?:\s|#[^\n]*|<#[\s\S]*?#>)*(?:using\s|param\s*\(|\[[\w.]+\s*\()/i.test(cmd);
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
    if (genOf(ctx?.chatId) !== gen) return {};
    // the beats stop first (a subagent's own; the turn's Stop, all of the turn's), so none holds after the stop
    stopHolds(ctx?.chatId, gen, input?.agent_id ? actor : null);
    await agentHook(ctx, actor, "stop");
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
  // Laptop, 2026-11-05: a turn's text (recordTurn's, Cardboard's s.text) is the prompt Cardboard composes for the agent,
  // not what the person typed. After a message that didn't reach an agent, a switch of agent or a fresh session it
  // starts with Cardboard's preamble and the earlier conversation (its KTe: "[Earlier messages in this conversation did
  // not reach an agent…" … "[End of earlier conversation. The user's next message follows.]"), and the message's
  // references and attached files follow it. History titled turns "[Earlier messages in this conver…". The person's
  // own words are the chat's user event with the turn's id (recordTurn records it just before it returns the turn):
  // the Working row and the version are titled from that. Without one, the composed prompt after Cardboard's preamble.
  // U+2007 marks a mention in Cardboard's text (its p5 strips it for the agent). Never logged: it is the person's text.
  const PREAMBLE_END = "[End of earlier conversation. The user's next message follows.]";
  const ownWords = (chat, turn) => {
    const evs = Array.isArray(chat?.events) ? chat.events : [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e && e.type === "user" && e.id === turn?.id && typeof e.text === "string") return e.text.replaceAll("\u2007", "");
    }
    const t = String(turn?.text ?? "");
    const at = t.startsWith("[") ? t.indexOf(PREAMBLE_END) : -1;
    return at >= 0 ? t.slice(at + PREAMBLE_END.length).trim() : t;
  };
  // Item 4 (laptop, 2026-11-05: "a title/summary would be more appropriate than raw messages"): once a turn that changed
  // the edit has ended, its version is titled in a few words saying what was done ("Split audio for J/L cuts"), made
  // the way Cardboard names its chats: one call to the person's own signed-in Claude Code (else Codex), the cheap
  // model, no tools, no hooks, no session kept (Cardboard's hke, through namer(); patch-carton.js). Built from the
  // person's request and the turn's worded changes (facts), so it says what actually changed. Until it comes, and
  // whenever it doesn't (no signed-in binary, offline, a failure, the timeout, an empty or long answer: Cardboard's zWt
  // gives null), the person's own words stay. Nothing waits for it. Neither the request nor the title is logged.
  let summarize = null;
  const TITLE_MS = 12000;
  const TITLE_INSTRUCTION = "Title this change to a video edit in 2 to 6 words, sentence case, saying what was done, built from what changed and what the editor asked for, so they recognise it in their edit history. Reply with the title alone: no quotes, no punctuation, no explanation.";
  const clip = (x, n) => (x.length > n ? x.slice(0, n - 1) + "…" : x);
  const titlePrompt = (asked, changes) => {
    const lines = changes.slice(0, 12).map((c) => "- " + clip(String(c).replace(/\s+/g, " ").trim(), 140));
    if (changes.length > 12) lines.push("- and " + (changes.length - 12) + " more changes");
    return "The editor asked: " + clip(String(asked).replace(/\s+/g, " ").trim(), 400) + "\n\nWhat changed in the edit:\n" + lines.join("\n");
  };
  const titleTurn = (t, named) => {
    if (!summarize || !library || named?.status !== "named" || !named.ref || typeof named.label !== "string" || !Array.isArray(named.changes) || !named.changes.length) return;
    Promise.resolve()
      .then(() => summarize(titlePrompt(t.prompt, named.changes), TITLE_INSTRUCTION, TITLE_MS))
      .then((title) => {
        if (typeof title !== "string" || !title.trim() || title.trim() === named.label || !library) return;
        // the worker keeps a name someone gave meanwhile (the person's rename): only its own label is replaced
        return library.call("carton.retitleTurn", { projectId: t.projectId, ref: named.ref, was: named.label, title: title.trim(), asked: t.prompt });
      })
      .catch(() => {});
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
      const since = Date.now(), prompt = ownWords(chat, turn);
      running.set(chat, { projectId, bundlePath, turn: turn.id, prompt, provider, since });
      hooked.delete(chat.chatId);
      nextGen(chat.chatId);
      endHolds(chat.chatId);
      live.set(chat.chatId, { chat, turn: turn.id, gen: genOf(chat.chatId) });
      // UX redesign 0.7: the project's History panels show the agent working while its turn holds the timeline, by the
      // ids its edits are recorded by (actorsOf); the prompt only goes to the worker, never logged
      const actors = actorsOf(chat, { provider, turn: turn.id });
      if (library) library.call("carton.working", { projectId, chat: chat.chatId, provider, actor: actors[0], actors, prompt, since }).catch(() => {});
    },
    turnEnded(chat) {
      const t = on ? running.get(chat) : null;
      if (!t) return;
      // review P2: the turn's hooks still waiting send nothing from here on (gens); its beats stop before its end lets go
      nextGen(chat.chatId);
      endHolds(chat.chatId);
      if (live.get(chat.chatId)?.chat === chat) live.delete(chat.chatId);
      running.delete(chat);
      const actors = actorsOf(chat, t), director = t.provider === "director";
      hooked.delete(chat.chatId);
      // the working row ends with the turn (0.7)
      if (library) library.call("carton.working", { projectId: t.projectId, chat: chat.chatId, done: true }).catch(() => {});
      // H8: the turn and its subagents stop holding the shared file, however the turn ended (a stop, an interrupt).
      for (const actor of actors) void agentHook({ project: { bundlePath: t.bundlePath } }, actor, "endTurn");
      // Another provider's turn is told by its actors and its time, from its start to now (review P2: until): the request
      // can reach the worker after the next turn's edits, by the same actors.
      // (the person's own words name it at once; with a namer, the worker answers the turn's worded changes, and a
      // short title replaces them when it comes: titleTurn)
      if (chat.turn?.state === "running" && library) library.call("carton.nameTurn", { projectId: t.projectId, chat: chat.chatId, turn: t.turn, prompt: t.prompt, ...(summarize ? { changes: true } : {}), ...(director ? {} : { actors, since: t.since, until: Date.now() }) }).then((r) => titleTurn(t, r)).catch(() => {});
    },
    time(p) {
      if (!timing) return p;
      const t0 = performance.now();
      return p.finally(() => require("node:fs").appendFile(timing, JSON.stringify({ at: Date.now(), ms: +(performance.now() - t0).toFixed(2), carton: on }) + "\n", () => {}));
    },
    library(lib) { library = lib; },
    // Item 4: Cardboard's own naming call (patch-carton.js hands it over where 1.4.0 defines its chat namer):
    // fn(prompt, instruction, timeoutMs) answers a cleaned title or null. With Carton off nothing is kept.
    namer(fn) { if (on && typeof fn === "function") summarize = fn; },
    call(method, args) {
      // The pages ask once, at start, whether to take Carton's paths.
      if (method === "enabled") return on;
      if (!on) throw new Error("Carton is off (CARDBOARD_CARTON=0 is set; without it, Carton is on)");
      if (!/^[a-zA-Z]+$/.test(method)) throw new Error("Unknown Carton method " + method);
      if (handlers.has(method)) return handlers.get(method)(...args);
      return forward(method, args);
    },
    handle(name, fn) {
      if (!/^[a-zA-Z]+$/.test(name) || name === "enabled") throw new Error("A Carton method name is letters only, and not enabled: " + name);
      handlers.set(name, fn);
    },
    forward,
    // The title bar (scripts/carton/strip-buttons.js): the editor page's report (carton:panel, scripts/carton/ui.js
    // CartonSide), as the strip draws it. Which side panel is open, a shared project's live summary, whether the Share
    // dialog is open, the cut the person is on ({name, dot}: a colour for any cut but Main) and what they are viewing
    // ({label}, with loading: true while it is slow to come) or comparing ({label}), each only in the shape the strip draws: text cut to a length, a colour only as #hex. An older page's
    // report (a bare panel name) is kept as it was.
    panel(t) {
      if (t == null || typeof t !== "object") return typeof t === "string" ? t : null;
      const text = (s, max) => (typeof s === "string" && s.trim() ? s.slice(0, max) : null);
      const cutName = text(t.cut?.name, 200), view = text(t.viewing?.label, 300), comparing = text(t.comparing?.label, 300);
      return {
        panel: t.panel === "history" || t.panel === "comments" || t.panel === "share" ? t.panel : null,
        live: t.live && typeof t.live === "object" ? t.live : null,
        share: t.share === true,
        cut: cutName ? { name: cutName, dot: typeof t.cut.dot === "string" && /^#[0-9a-f]{3,8}$/i.test(t.cut.dot) ? t.cut.dot : null } : null,
        viewing: view ? (t.viewing.loading === true ? { label: view, loading: true } : { label: view }) : null,
        // Compare in the editor (UX v2, N1): the chip's "⇆ Comparing … ✕" (only while comparing)
        ...(comparing ? { comparing: { label: comparing } } : {}),
        // the chip's cuts menu is open in the page (PLAN 2.2 v2): the chip's aria-expanded (only while it is)
        ...(t.cutsMenu === true ? { cutsMenu: true } : {}),
      };
    },
    // A strip command as the page hears it (carton:command): its action, and for the cut chip's click (PLAN 2.2 v2: the
    // page draws the cuts menu under the chip) where the chip is, "at" ({left, right, bottom} in the title bar's CSS px
    // and its devicePixelRatio "dpr", numbers only, or nothing), whether the menu is to open or close ("open": what the
    // chip showed when it was pressed) and whether a pointer clicked it ("pointer"). Nothing else from the strip passes.
    command(t) {
      const out = { action: t.action };
      if (t.action !== "carton-cuts") return out;
      const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
      const a = t.at;
      if (a && typeof a === "object" && num(a.left, -1e5, 1e5) && num(a.right, -1e5, 1e5) && num(a.bottom, -1e5, 1e5) && num(a.dpr, 0.05, 20))
        out.at = { left: a.left, right: a.right, bottom: a.bottom, dpr: a.dpr };
      if (typeof t.open === "boolean") out.open = t.open;
      if (t.pointer === true) out.pointer = true;
      return out;
    },
    // Strip commands that open something taking keys in the editor's page (the cuts menu, the Share dialog): main
    // focuses that page before it sends them, as a click there would (the chip's click that closes its menu too: focus
    // goes back to the page). History's icon and the chip's ✕ leave focus be.
    takesKeys: (action) => action === "carton-cuts" || action === "carton-share",
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
    // timeline.tsx with no turn left to let go of it. A command that reaches Carton or names timeline.tsx holds the
    // file for the turn (shellHold).
    directorHook(ctx, inner) {
      if (!on) return inner;
      return async (input) => {
        const gen = genOf(ctx?.chatId);
        const r = await inner(input);
        if (input?.hook_event_name !== "PreToolUse" || genOf(ctx?.chatId) !== gen) return r;
        const out = r?.hookSpecificOutput;
        if (out?.permissionDecision === "deny") return r;
        const tool = { ...input.tool_input, ...out?.updatedInput };
        const actor = await shellHold(ctx, input, tool.command, gen);
        if (!actor) return r;
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
        q("cb conflicts " + id) + " lists your cards and " + q("cb resolve") + " picks one; the ones you leave go to the person.",
        // Carton UX v2 (N0, DESIGN-V2 §5): finding a version the person means, bringing back one clip, showing a comparison
        "Every change is a version, so find the one the person means rather than reading the whole history: " + q("cb history " + id + " --find <words>") +
        " (a clip's name, words from a title or caption, a request, a version's name, a person, a day) and " + q("cb history " + id + " --landmarks") +
        " (what was exported, sent, named, each agent turn, how it was when they opened it, and before each restore). In place of a " + q("<cut>@<seq>") +
        " you can write sent, exported, today, now, a version's name or a cut's name. To bring back one clip as it was (\"bring back the old intro\"), " + q("cb restore " + id + " <version> --clip <name>") +
        ": only that clip changes. " + q("cb restore " + id + " <version>") + " rolls the whole edit back. When the person asks to show or compare something (\"show me what changed since I sent it\", \"compare the Instagram cut with Main\"), run " +
        q("cb compare " + id + " <left> [right] --show") + ": it opens in their editor; tell them what its first line says. Say names and times to the person, never a " + q("<cut>@<seq>") + "."];
    },
    // H8: the file tools of the transport's agents (the Director, the person's own Claude Code), beside its Bash hook: a
    // Read or Write/Edit of timeline.tsx reaches the worker's Materializer, and a Write/Edit of project.json is refused
    // with a pointer to the agent's own view (PLAN §6.4). The worker decides as cb carton-hook decides (@carton/local's
    // preToolUse); its only decision is that deny. A Read or Write/Edit of timeline.tsx holds the file for the turn.
    // Regress prod4 (director-hold): and Claude Code's PowerShell tool (Windows), which the transport hooked nowhere: on
    // the laptop the agent ran its first cb source print and a 30 s ping there, so nothing held the file until a later
    // Bash command, and the person's edit made meanwhile reached it mid-turn. Its commands get the Bash hook's Carton
    // part (shellHold; the actor in PowerShell's form, $env:CARDBOARD_ACTOR='…'; in front), and no decision: Cardboard's
    // credit gate is on Bash only, and this adds no permission.
    fileHooks(ctx) {
      if (!on) return [];
      return [{ matcher: "Read|Write|Edit|MultiEdit", hooks: [async (input) => {
        if (input?.hook_event_name !== "PreToolUse") return {};
        const gen = genOf(ctx?.chatId), actor = hookActor(ctx, input);
        const r = await agentHook(ctx, actor, "pre-tool-use", { ...input, cwd: input.cwd ?? ctx.project?.bundlePath });
        if (r?.delivered && /(^|[\\/])timeline\.tsx$/i.test(String(input.tool_input?.file_path ?? ""))) keepHolding(ctx, actor, gen);
        return r?.output?.hookSpecificOutput?.permissionDecision === "deny" ? r.output : {};
      }] }, { matcher: "PowerShell", hooks: [async (input) => {
        if (input?.hook_event_name !== "PreToolUse") return {};
        const tool = input.tool_input ?? {};
        const actor = await shellHold(ctx, input, tool.command, genOf(ctx?.chatId));
        if (!actor || psOpening(tool.command)) return {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...tool, command: "$env:CARDBOARD_ACTOR=" + psQuote(actor) + "; " + tool.command } } };
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
