// The `cb` commands and MCP tools for Carton (PLAN §0.1, §6.2, §10): `cb history`, `cb undo --turn`, `cb cut
// list|new|switch`, `cb fold <cut> [--check]` (with partial accept), `cb credits <clip>`, `cb restore <version>`,
// `cb compare <a> <b>`, `cb publish`, `cb conflicts`, `cb resolve`, `cb activity`, with git aliases (branch, merge,
// log, blame, revert, checkout, diff, tag). Every write returns {status: confirmed@seq | pending | conflicts, ref}
// as JSON (--json) and as short plain text. MCP keeps timeline_history, check_timeline and undo_timeline and adds
// timeline_cuts, timeline_fold, timeline_credits, timeline_publish. Owner: local-cli.
export { COMMANDS, GIT_ALIASES, stats, opsForChoice } from "./commands.ts";
export type { CbContext, CbProject, CommandSpec, Output, ArgSpec, OptSpec, OptType } from "./commands.ts";
export { runCb, findCommand, parseFor, usage } from "./cb.ts";
export type { CbIo, RunOptions } from "./cb.ts";
export { MCP_TOOLS, mcpTools, registerMcp, jsonSchema, zodShape } from "./mcp.ts";
export type { McpTool, McpToolSpec, RegisterMcpDeps, Shape } from "./mcp.ts";
export { register } from "./commander.ts";
export type { RegisterDeps } from "./commander.ts";
export { table, ago, who, cardLine, resultText, exitCodeOf } from "./format.ts";
export { resolveCut, resolveVersion, versionName, UsageError } from "./refs.ts";
