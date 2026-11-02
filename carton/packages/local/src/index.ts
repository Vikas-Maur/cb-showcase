// Carton on one machine (PLAN §6.2, §10, §21 L1/L14): opens `.carton/carton.db` for a project bundle (or app data in
// synced folders and FAT volumes, L15), runs the engine and the sync-lease holder on their own thread, starts the
// detached headless-sync helper, hands `cb`/MCP writes to the lease holder over its control socket (a Unix socket, or
// a named pipe on Windows) and waits for confirmed / pending / conflicts, identifies the actor (Director turns,
// Claude Code subagents, self-declared agents), and provides the Claude Code PreToolUse prefixer and the Stop /
// SubagentStop late-conflict hook. Owner: local-cli.
export * from "./ipc.ts";
export * from "./lease.ts";
export * from "./holder.ts";
export * from "./client.ts";
export * from "./helper.ts";
export * from "./identity.ts";
export * from "./hooks.ts";
export * from "./writes.ts";
export * from "./engine-thread.ts";
export * from "./follow.ts";
export { nodeHasher } from "./hasher.ts";
export * from "./notices.ts";
export * from "./hook-cli.ts";
export * from "./hook-send.ts";
export { openLocal, readProjectId, nextChangeId, defaultFactory, CartonHolderEngine } from "./open.ts";
export type { LocalOptions, LocalCarton, HolderEngineOptions } from "./open.ts";

// The materializer (project.json, the shared timeline.tsx, per-agent views and their `.status` sidecars), its engine on
// Carton, displace-then-install and `.cbproj` are `@carton/cardboard/node`'s (agreed with cardboard-adapter); re-exported
// here so hosts that open a project through `@carton/local` find them in one place. The holder's materializer gets
// `cartonMaterializerEngine(carton)` as is (it reads whether the cut is shared and cards invalid records itself, `b4c9b5f`;
// local's CartonMaterializerEngine wrapper is gone).
export { cartonMaterializerEngine, displaceThenInstall, DisplacedFiles, Materializer, viewPath, statusPath } from "@carton/cardboard/node";
export type { CartonEngine, ShowTarget, Showing } from "@carton/cardboard/node";
