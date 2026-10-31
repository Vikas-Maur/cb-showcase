// Carton's part of the `cb` command line (resources/cli/cardboard.mjs): its commands, the WHO column of `cb history`,
// the result of `cb undo --turn`, its MCP tools, and the hook command host Claude Code runs (§6.2, §10).
// With Carton off (CARDBOARD_CARTON is not "1"), nothing is registered and `cb` is Cardboard's.
// The commands themselves are @carton/cli-mcp's, reached through carton-node.cjs (scripts/carton/carton-node.js).
module.exports = String.raw`var __cartonCli = (() => {
  const on = process.env.CARDBOARD_CARTON === "1";
  const path = require("node:path");
  let api = null;
  // resources/cli → resources/carton
  const carton = () => (api ??= require(path.join(process.env.CARTON_DIR || require("node:url").fileURLToPath(new URL("../carton/", import.meta.url)), "carton-node.cjs")).cardboard14);
  // Carton's words, with the git word each answers to (PLAN §0.1).
  const COMMANDS = [
    ["cut", "Cuts of a project's edit: list, new <name>, switch <cut>", ["branch"]],
    ["fold", "Fold another cut into this one; --check only reports", ["merge"]],
    ["credits", "Who last changed a clip, down to the subagent", ["blame"]],
    ["restore", "Restore a version, saved as a new version", ["revert"]],
    ["compare", "What changed between two versions", ["diff"]],
    ["conflicts", "Conflict cards waiting for a choice", []],
    ["resolve", "Choose a side of a conflict card", []],
    ["publish", "Publish a cut for the share link", ["tag"]],
  ];
  // Where a project named on the command line lives (an id, a name or a bundle path, as every cb command takes).
  const bundleOf = async (ctx, ref) => {
    const lib = await ctx.open(), p = await ctx.resolve(lib, ref);
    return { id: p.id, bundlePath: lib.projects?.bundlePathFor?.(p.id) ?? path.dirname(lib.timeline.pathFor(p.id)) };
  };
  const io = (ctx, extra) => ({ cwd: process.cwd(), env: process.env, json: ctx.options().json === true, stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), ...extra });
  return {
    on,
    commands(program, ctx) {
      if (!on) return;
      for (const [name, description, aliases] of COMMANDS) {
        const cmd = program.command(name).description(description + " (Carton)").argument("<project>", "project id, name or bundle path").argument("[args...]").allowUnknownOption().allowExcessArguments();
        for (const a of aliases) cmd.alias(a);
        cmd.action(async (project, args, _opts, c) => {
          const { bundlePath } = await bundleOf(ctx, project);
          process.exitCode = await carton().run([name, ...args, ...c.args.slice(1 + args.length)], io(ctx, { bundlePath }));
        });
      }
      // git's log is cb history.
      program.commands.find((c) => c.name() === "history")?.alias("log");
      // Host Claude Code's hooks (main passes them with --settings): name the subagent on every cb call, and hand a
      // late conflict back to the agent before it stops.
      program.command("carton-hook", { hidden: true }).argument("<event>").action(async (event) => {
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        const out = await carton().hook({ event, input: input ? JSON.parse(input) : {}, env: process.env });
        if (out) process.stdout.write(JSON.stringify(out));
      });
    },
    // cb undo --turn <id> and undo_timeline {turn}: every change one agent turn made, as one inverse change at head.
    async undoTurn(lib, id, turn) {
      if (!on) throw new Error("Undoing a turn needs Carton (CARDBOARD_CARTON=1)");
      const bundlePath = lib.projects?.bundlePathFor?.(id) ?? path.dirname(lib.timeline.pathFor(id));
      return carton().undoTurn({ bundlePath, turn, actor: process.env.CARDBOARD_ACTOR || "cli" });
    },
    // cb history: WHO and CUT columns when Carton supplies them.
    historyTable(rows, items) {
      if (!items.some((r) => r.who !== undefined)) return rows;
      return rows.map((row, i) => i === 0 ? [...row, "WHO", "CUT"] : [...row, items[i - 1].who ?? "", items[i - 1].cut ?? ""]);
    },
    // The result of a Carton write, in a line: confirmed@seq, pending, or conflicts.
    statusLine(r) {
      if (!r || r.status === undefined) return "Nothing to undo";
      if (r.status === "confirmed") return "Undone (confirmed" + (r.seq !== undefined ? "@" + r.seq : "") + ")";
      if (r.status === "pending") return "Undone (pending: not confirmed yet)";
      return "Undone with " + (r.conflicts?.length ?? 0) + " conflict card(s): cb conflicts <project>";
    },
    // MCP: Carton's tools (timeline_cuts, timeline_fold, timeline_credits, timeline_publish) in Cardboard's table.
    mcp(tool, { z, project, resolve, result }) {
      if (!on) return;
      const zodOf = (s) => {
        const t = s.type === "integer" ? z.number().int() : s.type === "number" ? z.number() : s.type === "boolean" ? z.boolean()
          : s.type === "array" ? z.array(s.items?.type === "number" ? z.number() : z.string()) : s.enum ? z.enum(s.enum) : z.string();
        return s.description ? t.describe(s.description) : t;
      };
      for (const t of carton().mcpTools()) {
        const props = t.inputSchema?.properties ?? {}, required = new Set(t.inputSchema?.required ?? []);
        const shape = { project };
        for (const [k, s] of Object.entries(props)) if (k !== "project") shape[k] = required.has(k) ? zodOf(s) : zodOf(s).optional();
        tool(t.name, t.description, shape, t.readOnly === true, async (args) => {
          const p = await resolve(args.project);
          const r = await t.call(args, { bundlePath: p.bundlePath, projectId: p.id, env: process.env, cwd: process.cwd(), stdout() {}, stderr() {} });
          return result(r.result ?? {}, r.text);
        });
      }
    },
  };
})();
`;
