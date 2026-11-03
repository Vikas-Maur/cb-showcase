// MCP tools (kept 1.4.0 names and meanings, plus the new ones) and the registration on Cardboard's commander program
// and MCP table, each with a minimal stand-in for Cardboard's commander and zod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpTools, registerMcp, MCP_TOOLS } from "../src/mcp.ts";
import { register } from "../src/commander.ts";
import { project, director, human } from "./support/project.ts";

const setName = (id: string, v: string) => ({ kind: "commit" as const, ops: [{ op: "set", path: ["timelineItems", id, "name"], value: v }] });

test("MCP: tool names and JSON schemas; timeline_history keeps 1.4.0's text shape and adds who", async () => {
  const tools = mcpTools();
  assert.deepEqual(tools.map((t) => t.name), ["timeline_history", "check_timeline", "undo_timeline", "timeline_cuts", "timeline_fold", "timeline_credits", "timeline_publish", "timeline_find", "timeline_landmarks", "timeline_restore_clip", "timeline_compare"]);
  const fold = tools.find((t) => t.name === "timeline_fold")!;
  assert.deepEqual((fold.inputSchema as any).required, ["cut"]);
  assert.deepEqual((fold.inputSchema as any).properties.reject, { type: "array", items: { type: "string" }, description: "record paths to keep out, e.g. timelineItems/c3" });
  const { ctx } = project();
  await ctx(director("t1")).project.write(setName("c1", "x"));
  const h = await tools[0].call(ctx(), {});
  assert.match(h.text, /^main@1  \d{4}-\d\d-\d\dT[\d:.]+Z  2 tracks  3 items  30\.0s  by Director$/);
  assert.equal((h.result as any).revisions[0].by.turn, "t1");
});

test("MCP undo_timeline: restores a rev, undoes a turn, or the caller's newest change; nothing to undo", async () => {
  const tools = mcpTools();
  const undo = tools.find((t) => t.name === "undo_timeline")!;
  const { ctx, fake } = project();
  const n = await undo.call(ctx(), {});
  assert.equal(n.text, "Nothing to undo");
  assert.equal((n.result as any).restored, null);
  await ctx(director("t2")).project.write(setName("c1", "x"));
  const r = await undo.call(ctx(director("t2")), { turn: "t2" });
  assert.equal(r.isError, false);
  assert.equal(((await fake.head()).doc as any).timelineItems[0].name, "Intro");
  const back = await undo.call(ctx(), { rev: "main@1" });
  assert.notEqual((back.result as any).restored, null);
  assert.equal(((await fake.head()).doc as any).timelineItems[0].name, "x");
});

test("MCP timeline_cuts / timeline_credits / timeline_publish", async () => {
  const t = Object.fromEntries(mcpTools().map((x) => [x.name, x]));
  const { ctx } = project();
  assert.match((await t.timeline_cuts.call(ctx(), { action: "new", name: "Short" })).text, /^New cut "Short"/);
  assert.match((await t.timeline_cuts.call(ctx(), {})).text, /Short\s+variant/);
  assert.equal((await t.timeline_cuts.call(ctx(), { action: "new" })).isError, true);
  await ctx(director("t5", ["captioner", "q"])).project.write(setName("m1", "s"));
  assert.match((await t.timeline_credits.call(ctx(), { clip: "m1" })).text, /Director › captioner \(turn t5\)/);
  assert.match((await t.timeline_publish.call(ctx(), {})).text, /^Published head as "Published \d{4}-\d\d-\d\d"$/);
});

// ---- a stand-in for the bits of commander and zod Cardboard's program uses
class Cmd {
  _name: string; _desc = ""; args: string[] = []; options: { long: string; flags: string }[] = []; commands: Cmd[] = []; _action: ((...a: any[]) => unknown) | null = null; _opts: Record<string, unknown> = {};
  constructor(name: string) { this._name = name; }
  name() { return this._name; }
  command(n: string) { const c = new Cmd(n); this.commands.push(c); return c; }
  description(d: string) { this._desc = d; return this; }
  argument(a: string) { this.args.push(a); return this; }
  option(flags: string) { this.options.push({ flags, long: flags.split(" ")[0] }); return this; }
  action(f: (...a: any[]) => unknown) { this._action = f; return this; }
  opts() { return this._opts; }
  async run(positional: unknown[], opts: Record<string, unknown> = {}) { this._opts = opts; return this._action!(...positional, opts, this); }
}

test("commander: commands next to 1.4.0's; history/undo extended in place; git words; output through Cardboard's writer", async () => {
  const program = new Cmd("cb");
  const oldHistory = program.command("history").description("1.4.0").argument("<project>");
  program.command("save-as");
  const { ctx, fake } = project();
  const printed: { json: any; text: string }[] = [];
  register(program, { open: async (_p, o) => ({ ...ctx(o.as ? director("t1") : human) }), out: (json, text) => printed.push({ json, text: text() }) });
  const names = program.commands.map((c) => c.name());
  for (const n of ["history", "cut", "fold", "credits", "restore", "undo", "compare", "publish", "conflicts", "resolve", "activity", "branch", "merge", "log", "blame", "revert"]) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => n === "history").length, 1, "1.4.0's history is extended, not duplicated");
  assert.ok(oldHistory.options.some((o) => o.long === "--cut"), "it gained --cut");
  assert.ok(oldHistory.options.some((o) => o.long === "--as"), "and --as, as every Carton command has");
  const cut = program.commands.find((c) => c.name() === "cut")!;
  assert.deepEqual(cut.commands.map((c) => c.name()), ["list", "new", "switch"]);
  assert.deepEqual(cut.commands[1].args, ["<project>", "<name>"]);
  await fake.commit({ id: "x.1", ops: [{ op: "set", path: ["timelineItems", "c1", "name"], value: "y" }], author: human });
  await oldHistory.run(["Demo"], {});
  assert.match(printed.at(-1)!.text, /^VERSION/);
  await program.commands.find((c) => c.name() === "credits")!.run(["Demo", "c1"], {});
  assert.equal(printed.at(-1)!.text, "c1: last changed by me");
  const branch = program.commands.find((c) => c.name() === "branch")!;
  await branch.run(["Demo", "Alt"], {});
  assert.match(printed.at(-1)!.text, /^New cut "Alt"/);
  await branch.run(["Demo", undefined], {});
  assert.match(printed.at(-1)!.text, /Alt\s+variant/);
  process.exitCode = 0;
  await program.commands.find((c) => c.name() === "restore")!.run(["Demo", "nonsense"], {});
  assert.equal(process.exitCode, 2, "a usage error sets the exit code, as Cardboard's commands do");
  process.exitCode = 0;
});

test("commander: 1.4.0's `undo <project> [rev]` hands its rev over as a number; 0 is a version (refused when it can't be restored), never no version", async () => {
  // laptop, merge/prod-2 P3: `cb undo <project> 0` undid the newest change, silently (1.4.0 parses [rev] as an integer)
  const program = new Cmd("cb");
  program.command("undo").description("1.4.0").argument("<project>").argument("[rev]");
  const { ctx, fake } = project();
  const printed: { json: any; text: string }[] = [];
  register(program, { open: async () => ctx(human), out: (json, text) => printed.push({ json, text: text() }) });
  await ctx(human).project.write(setName("c1", "Mine"));
  await ctx(human).project.write(setName("c2", "Mine too"));
  const head = (await fake.head()).ref.seq;
  const undo = program.commands.find((c) => c.name() === "undo")!;
  process.exitCode = 0;
  await undo.run(["Demo", 99], {});
  assert.equal(process.exitCode, 2, "a version that isn't there is a usage error");
  assert.match(printed.at(-1)!.text, /^main@99 doesn't exist yet/);
  process.exitCode = 0;
  await undo.run(["Demo", 0], {});
  assert.equal((await fake.head()).ref.seq, head + 1, "0 restored main@0 (the fake's root holds the project): no undo of the newest change");
  assert.match(printed.at(-1)!.text, /^Restored 0/);
  assert.equal(((await fake.head()).doc as any).timelineItems[0].name, "Intro", "the older edit is undone too: a restore, not an undo of the newest");
  process.exitCode = 0;
});

const z = {
  string: () => zt("string"), number: () => zt("number"), boolean: () => zt("boolean"), unknown: () => zt("unknown"),
  enum: (v: string[]) => zt(`enum(${v.join("|")})`), array: (i: any) => zt(`array<${i.t}>`), record: (_k: any, v: any) => zt(`record<${v.t}>`),
};
function zt(t: string): any { return { t, int: () => zt(`${t}.int`), describe: (d: string) => ({ ...zt(t), d }), optional() { return { ...this, opt: true }; } }; }

test("registerMcp: Cardboard's tool(name, description, shape, readOnly, handler) with its z; check_timeline left to Cardboard", async () => {
  const added: { name: string; shape: any; readOnly: boolean; handler: (a: any) => Promise<any> }[] = [];
  const { ctx } = project();
  registerMcp((name, _d, shape, readOnly, handler) => added.push({ name, shape, readOnly, handler }), {
    z, projectParam: "PROJECT", open: async () => ctx(), result: (structured, text) => ({ structuredContent: structured, content: [{ type: "text", text }] }),
  });
  assert.deepEqual(added.map((a) => a.name), MCP_TOOLS.map((t) => t.name).filter((n) => n !== "check_timeline"));
  const fold = added.find((a) => a.name === "timeline_fold")!;
  assert.equal(fold.shape.project, "PROJECT");
  assert.equal(fold.shape.cut.t, "string");
  assert.equal(fold.shape.reject.t, "array<string>");
  assert.equal(fold.shape.reject.opt, true);
  assert.equal(added.find((a) => a.name === "timeline_history")!.shape.limit.t, "number.int");
  assert.equal(added.find((a) => a.name === "timeline_credits")!.readOnly, true);
  const r = await added.find((a) => a.name === "timeline_cuts")!.handler({ project: "Demo", action: "new" });
  assert.equal(r.isError, true, "a failed call is marked isError for the agent");
  const ok = await added.find((a) => a.name === "timeline_cuts")!.handler({ project: "Demo" });
  assert.match(ok.content[0].text, /^\s+CUT/);
});
