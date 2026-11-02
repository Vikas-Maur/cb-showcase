// Registering the Carton commands on Cardboard's own `cb` (a commander program, in Cardboard's bundle), so they sit
// next to `history`, `undo`, `save-as`, `apply` and `check` and print through Cardboard's `--json`-aware result writer.
// Each takes `<project>` first, as Cardboard's commands do. No commander dependency: the program is passed in.
//
// 1.4.0 already has `history` and `undo`. With `extend` (default) their actions are replaced by the Carton ones, which
// keep the 1.4.0 forms (`history <project>`, `undo <project> [rev]`) and add `--cut`, `--stats`, `--turn`.
// 1.4.0's `source print` gains `--view <name>` (your own view, through the holder's materializer, H8); without it the
// command is 1.4.0's own, run by its own action (commander keeps it as `_actionHandler`; a program without one is left
// as it is, with no `--view`).
import { COMMANDS, GIT_ALIASES } from "./commands.ts";
import type { CbContext, CommandSpec, Output } from "./commands.ts";
import { UsageError } from "./refs.ts";

export interface RegisterDeps {
  /** Open the project named by `<project>` (id, name or bundle path), as the `cb` process's actor. */
  open(project: string, opts: { as?: string | null }): Promise<CbContext>;
  /** Cardboard's result writer: JSON with --json, else the text. */
  out(json: unknown, text: () => string): void;
  /** Replace the actions of 1.4.0's `history` and `undo` with Carton's (default true). */
  extend?: boolean;
  /** Register the git words as commands too (default true). */
  gitAliases?: boolean;
}

const flag = (o: { name: string; type: string; description: string }) => (o.type === "boolean" ? `--${o.name}` : o.type === "strings" ? `--${o.name} <value...>` : `--${o.name} <value>`);

function configure(cmd: any, spec: CommandSpec): any {
  cmd.description(spec.summary).argument("<project>", "project id, name or bundle path");
  for (const a of spec.args) cmd.argument(a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`, a.description);
  for (const o of spec.options) cmd.option(flag(o), o.description);
  if (!spec.options.some((o) => o.name === "as")) cmd.option("--as <agent>", "who you are, for agents without hooks (Codex, Gemini): e.g. codex/fix-captions");
  return cmd;
}

/** commander's options for a spec (camelCase keys) as the spec's named values. */
function optionValues(spec: CommandSpec, opts: Record<string, any>): Record<string, any> {
  const a: Record<string, any> = {};
  for (const o of spec.options) {
    const key = o.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = opts[key];
    if (v === undefined) continue;
    a[o.name] = o.type === "number" ? Number(v) : v;
  }
  return a;
}
const optsOf = (params: any[]): Record<string, any> => {
  const cmd = params.at(-1);
  return typeof cmd?.opts === "function" ? cmd.opts() : params.at(-2) ?? {};
};

function action(spec: CommandSpec, deps: RegisterDeps) {
  return async (...params: any[]) => {
    const opts = optsOf(params);
    const [project, ...pos] = params.slice(0, 1 + spec.args.length);
    const a: Record<string, any> = optionValues(spec, opts);
    spec.args.forEach((s, i) => { if (pos[i] !== undefined) a[s.name] = pos[i]; });
    const ctx = await deps.open(project, { as: opts.as ?? null });
    let o: Output;
    try {
      o = await spec.run(ctx, a);
    } catch (e) {
      if (e instanceof UsageError) { o = { json: { status: "error", error: e.message }, text: e.message, exitCode: 2 }; }
      else throw e;
    }
    deps.out(o.json, () => o.text);
    if (o.exitCode) process.exitCode = o.exitCode;
  };
}

/**
 * A command the host already has: keep the command object (help text order, aliases) and add Carton's options. Carton's
 * action replaces the host's, or (a spec with `only`) runs when `only.when` holds and hands the call to the host's own
 * action otherwise.
 */
function extendIn(old: any, spec: CommandSpec, deps: RegisterDeps): void {
  if (deps.extend === false) return;
  const own = old._actionHandler;
  if (spec.only && typeof own !== "function") return; // nothing to hand a plain call to: the host's command stays as it is
  for (const o of spec.options) if (!old.options?.some((x: any) => x.long === `--${o.name}`)) old.option(flag(o), o.description);
  // as on every Carton command: who you are, for agents without hooks
  if (!old.options?.some((x: any) => x.long === "--as")) old.option("--as <agent>", "who you are, for agents without hooks (Codex, Gemini): e.g. codex/fix-captions");
  if (!spec.only) {
    old.description(spec.summary);
    old.action(action(spec, deps));
    return;
  }
  const carton = action(spec, deps);
  // commander calls the handler with the parsed positionals; its action wrapper adds the options and the command
  old.action(async (...params: any[]) => (spec.only!.when(optionValues(spec, optsOf(params))) ? carton(...params) : own.call(old, params.slice(0, -2))));
}

/** Add the Carton commands to Cardboard's commander program. */
export function register(program: any, deps: RegisterDeps): void {
  const existing = (name: string) => program.commands?.find((c: any) => c.name() === name);
  const parents = new Map<string, any>();
  for (const spec of COMMANDS) {
    if (spec.path.length === 1) {
      const old = existing(spec.path[0]);
      if (old) { extendIn(old, spec, deps); continue; }
      configure(program.command(spec.path[0]), spec).action(action(spec, deps));
    } else {
      const [p, sub] = spec.path;
      let parent = parents.get(p) ?? existing(p);
      if (!parent) { parent = program.command(p).description(p === "cut" ? "Cuts: separate lines of the edit (git branches)" : p); parents.set(p, parent); }
      const old = parent.commands?.find((c: any) => c.name() === sub);
      if (old) { extendIn(old, spec, deps); continue; }
      configure(parent.command(sub), spec).action(action(spec, deps));
    }
  }
  if (deps.gitAliases === false) return;
  for (const [git, carton] of Object.entries(GIT_ALIASES)) {
    if (existing(git)) continue;
    const target = COMMANDS.find((c) => c.path.join(" ") === (git === "branch" ? "cut new" : carton));
    if (!target) continue;
    if (git === "branch") {
      // `branch <project>` lists cuts; `branch <project> <name>` starts one
      const list = COMMANDS.find((c) => c.path.join(" ") === "cut list")!;
      const cmd = program.command("branch").description(`git word for \`cut\`: list cuts, or start one`).argument("<project>", "project id, name or bundle path").argument("[name]", "a new cut's name").option("--from <value>", "version to start from").option("--as <agent>", "who you are");
      cmd.action(async (project: string, name: string | undefined, opts: any, c: any) => (name ? action(target, deps)(project, name, opts, c) : action(list, deps)(project, opts, c)));
      continue;
    }
    configure(program.command(git), target).description(`git word for \`${carton}\`: ${target.summary}`).action(action(target, deps));
  }
}
