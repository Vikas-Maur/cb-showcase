// `cb` as an agent or a person runs it in a terminal: the standalone `carton` bin (`@carton/cli-mcp`), one process per
// command, on the project bundle, with `--json`. Identity as the caller would have it: CARDBOARD_ACTOR from a hook,
// `--as` for a self-declared agent, or nothing (a terminal user).
import { pkg } from "./env.ts";
import type { Machine } from "./project.ts";
import { runOnce } from "./procs.ts";

export const CB_BIN = pkg("cli-mcp", "src", "bin.ts");

export interface CbRun {
  code: number | null;
  json: any;
  stdout: string;
  stderr: string;
}

export async function cb(m: Machine, args: string[], o: { actor?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): Promise<CbRun> {
  const r = await runOnce(`cb ${args[0]}`, [CB_BIN, "--project", m.bundle, ...args, "--json"], {
    env: { ...(o.actor ? { CARDBOARD_ACTOR: o.actor } : {}), ...o.env },
    input: o.input,
    timeoutMs: o.timeoutMs ?? 90_000,
  });
  const last = r.stdout.trim().split("\n").filter(Boolean).at(-1);
  let json: any = null;
  try { json = last ? JSON.parse(last) : null; } catch { /* not JSON: kept in stdout */ }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
}

/** A `cb` command that must succeed (exit 0, or 1 when it reports cards and `cards` is allowed). */
export async function cbOk(m: Machine, args: string[], o: Parameters<typeof cb>[2] & { allowCards?: boolean } = {}): Promise<any> {
  const r = await cb(m, args, o);
  if (r.code !== 0 && !(o.allowCards && r.json?.status === "conflicts")) throw new Error(`cb ${args.join(" ")} exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  return r.json;
}
