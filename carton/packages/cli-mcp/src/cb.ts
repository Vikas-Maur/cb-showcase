// `runCb`: parse one Carton command line against the registry and run it. Used by the standalone `carton` bin and by
// tests; Cardboard's own `cb` registers the same specs on its commander program instead (commander.ts).
//   <command> [args] [--json] [--as <agent>] [options]
// git words work as aliases: `branch` (lists cuts, or `branch <name>` starts one), `merge`, `log`, `blame`, `revert`,
// `checkout`, `diff`, `tag`.
import { parseArgs } from "node:util";
import type { Actor } from "@carton/core";
import { COMMANDS, GIT_ALIASES } from "./commands.ts";
import type { CbContext, CbProject, CommandSpec, Output } from "./commands.ts";
import { UsageError } from "./refs.ts";

export interface CbIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RunOptions {
  /** Open the project (once per call). */
  open(): Promise<CbProject>;
  /** Who is acting; `declared` is `--as`. */
  actor(declared: string | null): Actor;
  now?: () => number;
}

/** Find the command: the longest spec path that prefixes argv, after mapping a git word. */
export function findCommand(argv: readonly string[]): { spec: CommandSpec; rest: string[] } | null {
  const words = [...argv];
  if (words[0] && GIT_ALIASES[words[0]]) {
    // `branch <name>` starts a cut; `branch` alone lists them
    if (words[0] === "branch") words.splice(0, 1, "cut", words.length > 1 && !words[1].startsWith("-") ? "new" : "list");
    else words.splice(0, 1, ...GIT_ALIASES[words[0]].split(" "));
  }
  if (words[0] === "cut" && (words.length === 1 || words[1].startsWith("-"))) words.splice(1, 0, "list");
  let best: CommandSpec | null = null;
  for (const s of COMMANDS) if (s.path.every((p, i) => words[i] === p) && (!best || s.path.length > best.path.length)) best = s;
  return best ? { spec: best, rest: words.slice(best.path.length) } : null;
}

export function usage(): string {
  const lines = ["Carton commands (git words in brackets):", ""];
  for (const s of COMMANDS) {
    const args = s.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
    lines.push(`  ${[...s.path, args].filter(Boolean).join(" ").padEnd(28)} ${s.summary}${s.gitAlias ? ` [${s.gitAlias.join(", ")}]` : ""}`);
  }
  lines.push("", "Every command takes --json. Writes answer confirmed, pending or conflicts.");
  return lines.join("\n");
}

/** Parse argv for one spec: positionals to args, options by type. */
export function parseFor(spec: CommandSpec, rest: readonly string[]): { a: Record<string, any>; json: boolean; as: string | null } {
  const options: Record<string, { type: "boolean" | "string"; multiple?: boolean; short?: string }> = {
    json: { type: "boolean" },
    as: { type: "string" },
  };
  for (const o of spec.options) options[o.name] = { type: o.type === "boolean" ? "boolean" : "string", ...(o.type === "strings" ? { multiple: true } : {}), ...(o.short ? { short: o.short } : {}) };
  // `--turn` with no value means "my own turn"
  const argv = rest.map((x, i) => (x === "--turn" && (i === rest.length - 1 || rest[i + 1].startsWith("-")) ? "--turn=" : x));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e: any) {
    throw new UsageError(String(e?.message ?? e).replace(/^.*?: /, ""));
  }
  const a: Record<string, any> = {};
  for (const o of spec.options) {
    const v = (parsed.values as Record<string, unknown>)[o.name];
    if (v === undefined) continue;
    if (o.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UsageError(`--${o.name} wants a number`);
      a[o.name] = n;
    } else a[o.name] = v;
  }
  const pos = [...parsed.positionals];
  for (const arg of spec.args) {
    if (arg.variadic) { a[arg.name] = pos.splice(0); continue; }
    const v = pos.shift();
    if (v === undefined && arg.required) throw new UsageError(`missing <${arg.name}>: ${arg.description}`);
    if (v !== undefined) a[arg.name] = v;
  }
  if (pos.length) throw new UsageError(`unexpected argument "${pos[0]}"`);
  return { a, json: !!parsed.values.json, as: (parsed.values.as as string | undefined) ?? null };
}

/** Run one command line; resolves the exit code. */
export async function runCb(argv: readonly string[], io: CbIo, opts: RunOptions): Promise<number> {
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { io.stdout(usage() + "\n"); return 0; }
  const found = findCommand(argv);
  if (!found) { io.stderr(`unknown command "${argv[0]}"\n\n${usage()}\n`); return 2; }
  let json = argv.includes("--json");
  try {
    const p = parseFor(found.spec, found.rest);
    json = p.json;
    const ctx: CbContext = { project: await opts.open(), actor: opts.actor(p.as), now: opts.now };
    const o: Output = await found.spec.run(ctx, p.a);
    io.stdout((json ? JSON.stringify(o.json) : o.text) + "\n");
    return o.exitCode ?? 0;
  } catch (e: any) {
    const usageErr = e instanceof UsageError;
    const msg = String(e?.message ?? e);
    if (json) io.stdout(JSON.stringify({ status: "error", error: msg, code: e?.code ?? null }) + "\n");
    else io.stderr(`${usageErr ? "" : "Error: "}${msg}\n`);
    return usageErr ? 2 : 1;
  }
}
