// A recording stand-in for carton-node.cjs (the facade): it proves each hook fires with the right arguments. It is not
// Carton: commits change nothing, installs are plain renames. Each call is appended to $FAKE_CARTON_LOG as a JSON line.
const fs = require("fs");
const LOG = process.env.FAKE_CARTON_LOG;
const log = (what, o) => fs.appendFileSync(LOG, JSON.stringify({ what, pid: process.pid, ...o }) + "\n");
let seq = 0;
exports.cardboard14 = {
  attach: ({ root }) => log("attach", { root }),
  commit: async ({ bundlePath, base, doc, actor, meta }) => {
    log("commit", { bundle: bundlePath?.split("/").pop(), baseRev: base?.stateUpdatedAt ?? null, docRev: doc.stateUpdatedAt, items: doc.timelineItems?.length ?? 0, actor, meta });
    return { doc, status: "confirmed", seq: ++seq, ref: "main@" + seq };
  },
  install: async (tmp, file) => { log("install", { file: file.split("/").slice(-2).join("/") }); fs.renameSync(tmp, file); },
  sawDisk: async ({ doc }) => log("sawDisk", { rev: doc.stateUpdatedAt }),
  revisions: async ({ files }) => { const r = await files(); log("revisions", { n: r.length }); return r; },
  revision: async ({ rev, file }) => { log("revision", { rev }); return file(); },
  history: async ({ rows }) => rows.map((r) => ({ ...r, who: "fake-actor", cut: "Main" })),
  merge3: async ({ base, current, file, prefer, rn }) => { log("merge3", { prefer: prefer ?? null }); return rn(base, current, file, { prefer }); },
  undoTurn: async ({ turn, actor }) => { log("undoTurn", { turn, actor }); return { status: "confirmed", seq: 99, ref: "main@99" }; },
  run: async (argv, io) => { log("run", { argv, bundle: io.bundlePath.split("/").pop(), json: io.json }); io.stdout("fake run " + argv.join(" ") + "\n"); return 0; },
  mcpTools: () => [{ name: "timeline_cuts", description: "Cuts (fake)", inputSchema: { properties: { project: { type: "string" } }, required: ["project"] }, readOnly: true, call: async (a, io) => ({ text: "Main", result: { cuts: ["Main"], bundle: io.bundlePath } }) }],
  hook: async ({ event, input, env }) => { log("hook", { event, actor: env.CARDBOARD_ACTOR, input }); return event === "pre-tool-use" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } : null; },
  worker: ({ library }) => ({ ping: async () => "pong" }),
};
