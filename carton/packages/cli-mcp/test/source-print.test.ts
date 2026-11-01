// `cb source print --view <name>` (H8): the agent's own view, printed by the lease holder's materializer (cardboard-
// adapter's real Materializer on the engine thread, as the app runs it), answered with its path and its status file.
// Plain `source print` stays Cardboard's: in Cardboard's `cb`, the 1.4.0 command keeps its own action and gains
// `--view`; the standalone `carton` says it is Cardboard's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, Rec } from "@carton/core";
import { EngineThread, openLocal, parseActorId } from "@carton/local";
import type { LocalCarton } from "@carton/local";
import { runCb } from "../src/cb.ts";
import { register } from "../src/commander.ts";
import type { CbProject } from "../src/commands.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => unknown, ms: number, what: string) {
  for (const end = Date.now() + ms; !(await f()); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const codex: Actor = { kind: "agent", id: "codex/fix", name: "Codex (fix) (terminal)", provider: "codex" };

/** One `cb` command line, as the standalone `carton` runs it: exit code, stdout, stderr. */
async function cb(local: LocalCarton, actor: Actor, ...argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await runCb(argv, { cwd: local.projectDir, env: {}, stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, { open: async () => local as unknown as CbProject, actor: () => actor });
  return { code, out: out.join(""), err: err.join("") };
}

/** The app: the engine thread holds the lease and runs the materializer on the bundle. */
async function app(t: { after(f: () => Promise<void>): void }, name: string) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: codex });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/mz-factory.ts"), config: { projectDir: dir } });
  const local = await openLocal({ projectDir: dir, projectId, adapter, actor: codex });
  t.after(async () => { await local.close(); await th.stop(); });
  await until(() => existsSync(join(dir, "timeline.tsx")), 10_000, "the app's first print");
  return { dir, local };
}

test("source print --view <name>: the holder's materializer prints the agent's view; the answer has its file and status file", { timeout: 60_000 }, async (t) => {
  const { dir, local } = await app(t, "print-view");
  const r = await cb(local, codex, "source", "print", "--view", "mine", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.status, "confirmed");
  assert.deepEqual({ ...j.view, ref: undefined }, {
    name: "mine", path: ".scratch/views/mine.tsx", status: ".scratch/views/mine.status", ref: undefined,
    file: join(dir, ".scratch", "views", "mine.tsx"), statusFile: join(dir, ".scratch", "views", "mine.status"),
  });
  const text = readFileSync(j.view.file, "utf8");
  assert.ok(text.includes(`cardboard:rev ${j.view.ref}`), "the file is the print the answer names");
  const plain = await cb(local, codex, "source", "print", "--view", "mine");
  assert.match(plain.out, new RegExp(`Your view "mine" is at ${j.view.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(plain.out, /written to .*mine\.status/);

  // the agent edits its view and saves it: the save is applied, and the status file the answer named says so
  const body = readFileSync(j.view.file, "utf8");
  const at = body.indexOf("\n{") + 1;
  const edited = JSON.parse(body.slice(at));
  edited.timelineItems.find((i: Rec) => i.id === "c1").name = "edited in my view";
  writeFileSync(j.view.file, body.slice(0, at) + JSON.stringify(edited, null, 1) + "\n");
  await until(() => existsSync(j.view.statusFile), 10_000, "the status file");
  await until(() => JSON.parse(readFileSync(j.view.statusFile, "utf8")).status === "confirmed", 10_000, "the save confirmed");
  const head = (await local.carton.head()).doc.timelineItems as Rec[];
  assert.equal(head.find((i) => i.id === "c1")!.name, "edited in my view");
  assert.equal((await local.carton.log({ limit: 1 }))[0]?.author?.id, "codex/fix", "credited to the view's owner");
});

test("source print --view: a hooked agent's view is named after it, whatever it asks; plain source print is Cardboard's", { timeout: 60_000 }, async (t) => {
  const { dir, local } = await app(t, "print-view-hooked");
  const hooked = parseActorId("claude-code/abcdef12/sub-editor-q")!;
  const r = await cb(local, hooked, "source", "print", "--view", "anything", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.view.name, "claude-code_abcdef12_sub-editor-q");
  assert.equal(j.view.file, join(dir, ".scratch", "views", "claude-code_abcdef12_sub-editor-q.tsx"));
  assert.ok(existsSync(j.view.file));
  const plain = await cb(local, codex, "source", "print");
  assert.equal(plain.code, 2);
  assert.match(plain.err, /plain `source print` is Cardboard's own command/);
  const bad = await cb(local, codex, "source", "print", "--view", "no/slashes", "--json");
  assert.equal(bad.code, 1, bad.out);
  assert.match(JSON.parse(bad.out).error, /invalid view name/);
});

test("source print --view with no app open: views need the app (nothing printed, exit 1)", async () => {
  const { dir, projectId } = bundle("print-view-closed");
  const local = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: codex });
  try {
    const r = await cb(local, codex, "source", "print", "--view", "mine", "--json");
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.out).error, /views need the app open/);
    assert.equal(existsSync(join(dir, ".scratch", "views", "mine.tsx")), false);
  } finally {
    await local.close();
  }
});

// ---- commander as Cardboard's bundle has it: `action(fn)` stores `_actionHandler(args)`, which calls fn with the
// positionals, the options and the command (commander 12's code, as in 1.4.0's cardboard.mjs)
class Cmd {
  _name: string; registeredArguments: string[] = []; options: { long: string; flags: string }[] = []; commands: Cmd[] = []; _opts: Record<string, unknown> = {}; _desc = "";
  _actionHandler: ((args: unknown[]) => unknown) | null = null;
  constructor(name: string) { this._name = name; }
  name() { return this._name; }
  command(n: string) { const c = new Cmd(n); this.commands.push(c); return c; }
  description(d: string) { this._desc = d; return this; }
  argument(a: string) { this.registeredArguments.push(a); return this; }
  option(flags: string) { this.options.push({ flags, long: flags.split(" ")[0] }); return this; }
  opts() { return this._opts; }
  action(fn: (...a: any[]) => unknown) {
    this._actionHandler = (args) => { const s = args.slice(0, this.registeredArguments.length); s[this.registeredArguments.length] = this.opts(); s.push(this); return fn.apply(this, s); };
    return this;
  }
  /** What commander does for `cb source print <project> [--view x]`. */
  run(args: unknown[], opts: Record<string, unknown> = {}) { this._opts = opts; return this._actionHandler!(args); }
}

test("Cardboard's cb: 1.4.0's `source print` gains --view; without it, 1.4.0's own action runs as before", async () => {
  const program = new Cmd("cb");
  const source = program.command("source");
  const seen: unknown[][] = [];
  const print = source.command("print").argument("<project>").option("--from <line>").option("--lines <n>").action(async (project: string, o: Record<string, unknown>, c: Cmd) => { seen.push([project, { ...o }, c === print]); });
  const printed: { json: any; text: string }[] = [];
  const asked: unknown[] = [];
  const project = { carton: {} as never, projectDir: "/p/Demo.cardboard", write: async (op: unknown) => { asked.push(op); return { status: "confirmed", seq: 0, ref: "Main@1~ab b:cd p:ef", notices: [], view: { name: "mine", path: ".scratch/views/mine.tsx", ref: "Main@1~ab b:cd p:ef", status: ".scratch/views/mine.status" } }; } } as unknown as CbProject;
  register(program, { open: async () => ({ project, actor: codex }), out: (json, text) => printed.push({ json, text: text() }) });
  assert.deepEqual(source.commands.map((c) => c.name()), ["print"], "extended in place, not a second print");
  assert.ok(print.options.some((o) => o.long === "--view"), "it gained --view");

  await print.run(["Demo"], { from: 3 });
  assert.deepEqual(seen, [["Demo", { from: 3 }, true]], "1.4.0's action, with its own options");
  assert.deepEqual(asked, [], "Carton wasn't asked");

  await print.run(["Demo"], { view: "mine" });
  assert.equal(seen.length, 1);
  assert.deepEqual(asked, [{ kind: "printView", name: "mine" }]);
  assert.equal(printed[0].json.view.file, join("/p/Demo.cardboard", ".scratch", "views", "mine.tsx"));
  assert.match(printed[0].text, /^Your view "mine" is at /);

  // a program whose commands keep no action handler: its `source print` is left as it is
  const old = new Cmd("cb");
  const oldPrint = old.command("source").command("print").argument("<project>");
  oldPrint._actionHandler = null;
  register(old, { open: async () => ({ project, actor: codex }), out: () => {} });
  assert.ok(!oldPrint.options.some((o) => o.long === "--view"));
  // a host without `source`: Carton's own `source print <project> --view`
  const bare = new Cmd("other");
  register(bare, { open: async () => ({ project, actor: codex }), out: () => {} });
  const bp = bare.commands.find((c) => c.name() === "source")!.commands.find((c) => c.name() === "print")!;
  assert.deepEqual(bp.registeredArguments, ["<project>"]);
  assert.ok(bp.options.some((o) => o.long === "--view"));
});
