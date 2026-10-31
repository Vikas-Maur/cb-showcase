// The `cb` commands and MCP tools for Carton (PLAN §0.1, §6.2, §10): `cb history`, `cb undo --turn`, `cb cut
// list|new|switch`, `cb fold <cut> [--check]`, `cb credits <clip>`, `cb restore <version>`, `cb compare <a> <b>`,
// `cb publish`, `cb conflicts`, `cb resolve`, with git aliases (branch, merge, log, blame, revert). Every write
// returns {status: confirmed@seq | pending | conflicts, ref}. MCP keeps timeline_history, check_timeline and
// undo_timeline and adds timeline_cuts, timeline_fold, timeline_credits, timeline_publish. Owner: local-cli.
import type { CommitResult } from "@carton/core";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** git word -> Carton command. */
export const GIT_ALIASES: Readonly<Record<string, string>> = {
  branch: "cut",
  checkout: "cut switch",
  merge: "fold",
  log: "history",
  blame: "credits",
  revert: "restore",
  diff: "compare",
  tag: "publish",
};

export interface CbIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Run one `cb` Carton command; resolves the exit code. */
export async function runCb(argv: readonly string[], io: CbIo): Promise<number> {
  return todo("runCb");
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, io: CbIo): Promise<{ text: string; result?: CommitResult | unknown }>;
}

export function mcpTools(): McpTool[] {
  return todo("mcpTools");
}
