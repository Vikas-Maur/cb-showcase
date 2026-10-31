// A recording stand-in for carton-node.cjs (the facade): it proves each hook fires with the right arguments. It is not
// Carton: commits change nothing, installs are plain renames. Each call is appended to $FAKE_CARTON_LOG as a JSON line.
const fs = require("fs"), path = require("path");
const LOG = process.env.FAKE_CARTON_LOG;
const log = (what, o) => fs.appendFileSync(LOG, JSON.stringify({ what, pid: process.pid, ...o }) + "\n");
let seq = 0;
exports.cardboard14 = {
  attach: ({ root }) => log("attach", { root }),
  commit: async ({ bundlePath, base, doc, actor, meta }) => {
    log("commit", { bundle: bundlePath ? path.basename(bundlePath) : undefined, baseRev: base?.stateUpdatedAt ?? null, docRev: doc.stateUpdatedAt, items: doc.timelineItems?.length ?? 0, actor, meta });
    return { doc, status: "confirmed", seq: ++seq, ref: "main@" + seq };
  },
  install: async (tmp, file) => { log("install", { file: path.basename(path.dirname(file)) + "/" + path.basename(file) }); fs.renameSync(tmp, file); },
  sawDisk: async ({ doc }) => log("sawDisk", { rev: doc.stateUpdatedAt }),
  revisions: async ({ files }) => { const r = await files(); log("revisions", { n: r.length }); return r; },
  revision: async ({ rev, file }) => { log("revision", { rev }); return file(); },
  history: async ({ rows }) => rows.map((r) => ({ ...r, who: "fake-actor", cut: "Main" })),
  merge3: async ({ base, current, file, prefer, rn }) => { log("merge3", { prefer: prefer ?? null }); return rn(base, current, file, { prefer }); },
  undoTurn: async ({ turn, actor }) => { log("undoTurn", { turn, actor }); return { status: "confirmed", seq: 99, ref: "main@99" }; },
  hasHistory: async () => true,
  headProject: async (bundlePath, current) => (log("headProject", { bundle: path.basename(bundlePath), rev: current?.stateUpdatedAt }), null),
  // cb: one probe command and one tool stand for @carton/cli-mcp's; they show what the bridge hands over.
  registerCommands: (program, { open, out, after }) => {
    program.command("carton-probe").argument("<project>").action(async (ref) => {
      const t = await open(ref);
      log("open", { id: t.id, bundle: path.basename(t.bundlePath) });
      await after(t);
      out({ probed: t.id }, () => "probed");
    });
  },
  registerMcp: (tool, { z, projectParam, open, result }) => tool("timeline_cuts", "Cuts (fake)", { project: projectParam }, true, async ({ project }) => {
    const t = await open(project);
    return result({ cuts: ["Main"], bundle: t.bundlePath }, "Main");
  }),
  run: async (argv, io) => { log("run", { argv, bundle: path.basename(io.bundlePath), json: io.json }); io.stdout("fake run " + argv.join(" ") + "\n"); return 0; },
  mcpTools: () => [{ name: "timeline_cuts", description: "Cuts (fake)", inputSchema: { properties: { project: { type: "string" } }, required: ["project"] }, readOnly: true, call: async (a, io) => ({ text: "Main", result: { cuts: ["Main"], bundle: io.bundlePath } }) }],
  hook: async ({ event, input, env }) => { log("hook", { event, actor: env.CARDBOARD_ACTOR, input }); return event === "pre-tool-use" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } : null; },
  worker: ({ library }) => ({ ping: async () => "pong" }),
};
