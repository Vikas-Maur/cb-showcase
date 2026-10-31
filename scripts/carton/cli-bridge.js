// Carton's part of the `cb` command line (resources/cli/cardboard.mjs), patched in by patch-carton.js: @carton/cli-mcp's
// commands and MCP tools on Cardboard's own program and tool table (its `history` and `undo` become Carton's, with
// --cut, --stats and --turn), the git words, and the hook command host Claude Code runs (§6.2, §10). After a Carton
// write changes head, head goes into project.json through Cardboard's own store, as any cb write does.
// With Carton off (CARDBOARD_CARTON is not "1"), nothing is registered and `cb` is Cardboard's.
module.exports = String.raw`var __cartonCli = (() => {
  const on = process.env.CARDBOARD_CARTON === "1";
  const path = require("node:path");
  let api;
  // resources/cli → resources/carton
  // If carton-node.cjs can't load, cb is Cardboard's, as with Carton off.
  const carton = () => {
    if (api === undefined) {
      try { api = require(path.join(process.env.CARTON_DIR || require("node:url").fileURLToPath(new URL("../carton/", import.meta.url)), "carton-node.cjs")).cardboard14; }
      catch (e) { api = null; console.warn("[carton] Carton didn't load; cb runs without it:", e?.message ?? e); }
    }
    return api;
  };
  // Where a project named as every cb command names it (an id, a name or a bundle path) lives.
  const target = async (lib, resolve, ref) => {
    const p = await resolve(lib, ref);
    return { id: p.id, bundlePath: lib.projects?.bundlePathFor?.(p.id) ?? path.dirname(lib.timeline.pathFor(p.id)), lib };
  };
  // Head into project.json through the store (the store bridge writes it without committing a second change).
  // (R4: description, and media through Cardboard's media scope: the facade's headScope.) head: the state the write
  // made when it is still pending on a shared cut (the holder's, which this process can't read itself).
  const after = async ({ id, bundlePath, lib }, head) => {
    const current = await lib.projects.read(id);
    const next = await carton().headProject(bundlePath, current, head);
    if (next) await lib.projects.updateScoped(next, carton().headScope(current, next));
  };
  // Tools Carton serves in place of Cardboard's own when on.
  const CARTON_TOOLS = new Set(["timeline_history", "undo_timeline"]);
  return {
    on,
    own: (name) => !on || !carton() || !CARTON_TOOLS.has(name),
    commands(program, ctx) {
      if (!on || !carton()) return;
      carton().registerCommands(program, { open: async (ref) => target(await ctx.open(), ctx.resolve, ref), out: (json, text) => ctx.out().result(json, text), after });
      // Host Claude Code's hooks (main passes them with --settings): name the subagent on every cb call, and hand a
      // late conflict back to the agent before it stops.
      program.command("carton-hook", { hidden: true }).argument("<event>").option("--project <dir>").action(async (event, o) => {
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        let out = {};
        try { out = await carton().hook({ event, input: input ? JSON.parse(input) : {}, env: process.env, bundlePath: o.project ?? process.cwd() }); } catch {}
        process.stdout.write(JSON.stringify(out ?? {}));
      });
    },
    // cb undo --turn <id> with Carton off says it needs Carton (with it on, Carton's undo answers).
    async undoTurn() {
      throw new Error(on ? "Carton didn't load, so a turn can't be undone" : "Undoing a turn needs Carton (CARDBOARD_CARTON=1)");
    },
    // MCP: Carton's tools (timeline_history, undo_timeline, timeline_cuts, timeline_fold, timeline_credits,
    // timeline_publish) in Cardboard's table; Cardboard's own check_timeline stays and goes through Carton (H3).
    mcp(tool, { z, project, resolve, lib, result }) {
      if (!on || !carton()) return;
      carton().registerMcp(tool, { z, projectParam: project, result, open: (ref) => target(lib, (l, r) => resolve(r), ref), after, skip: ["check_timeline"] });
    },
  };
})();
`;
