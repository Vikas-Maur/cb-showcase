// Claude Code hooks (§6.2, §10, H9).
//
// - PreToolUse prefixer: given the hook input of a Bash call and the Director's chat and turn, returns the command
//   with `export CARDBOARD_ACTOR=director/<chat>/<turn>[/sub-<type>-<id>];` in front, when it runs `cb`/`cardboard`.
//   Cardboard's own Bash hook (the credit gate `sA`, which already rewrites commands) applies it to the command it
//   allows; host Claude Code gets the same logic as a command hook (`carton hook pre-tool-use`, with `--settings`).
//   One `export` in front, rather than editing each `cb` word, is safe for any shell text: pipes, `&&`, heredocs.
// - Stop/SubagentStop: late conflicts for this actor (a pending change that came back rejected after its turn) block
//   the stop **once** with the conflict text, so the agent resolves them before it ends ("Prevents the subagent from
//   stopping"). On `stop_hook_active` it never blocks again: whatever is left becomes a card for the human (R3-09).
// - Hook events for the holder's materializer (§6.4, H8): `hookEventFor` turns a Read of the shared timeline.tsx, a
//   Write/Edit/MultiEdit of timeline.tsx or project.json, and an allowed Stop/SubagentStop into a `hook` write
//   (`HookOp`), which `cb` hands to the lease holder like any write; the holder calls the materializer's
//   hookRead / hookWrite / hookStop (the freeze of the shared file, credits for a hooked agent's save, the turn's pins).
//   This file loads no engine: the PreToolUse hook runs before every tool call.
import { isAbsolute, relative, resolve } from "node:path";
import type { Actor } from "@carton/core";
import { parseActorId, safePart, subagentSuffix } from "./identity.ts";
import type { HookInput } from "./identity.ts";

/** A command mentions the CLI as a word (start, after a separator or `$(`/backtick, or a path ending in /cb). */
const CB_WORD = /(?:^|[\s;&|(`]|\$\()(?:[^\s;&|()`'"]*[\\/])?(?:cb|cardboard)(?:\.cmd|\.exe)?(?=$|[\s;&|)`])/;

export function mentionsCb(command: string): boolean {
  return CB_WORD.test(command);
}

export interface DirectorTurn { chat: string; turn: string }

/** The actor id for a hook call: the Director's turn (or a host session), plus the subagent suffix inside a subagent. */
export function actorIdForHook(input: HookInput, turn?: DirectorTurn | null): string {
  const base = turn ? `director/${safePart(turn.chat)}/${safePart(turn.turn)}` : `claude-code/${safePart(String(input.session_id ?? "session").slice(0, 8))}`;
  return base + subagentSuffix(input.agent_type, input.agent_id);
}

export interface PrefixResult { command: string; actor: string; note: string }

/** PreToolUse(Bash): the rewritten command, or null when it doesn't run `cb` (leave it alone). */
export function prefixCommand(input: HookInput, turn?: DirectorTurn | null): PrefixResult | null {
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !mentionsCb(command)) return null;
  const actor = actorIdForHook(input, turn);
  // actor ids are [A-Za-z0-9._:/-] only (safePart), so single quotes are enough
  return { command: `export CARDBOARD_ACTOR='${actor}'; ${command}`, actor, note: `cb calls are attributed to ${actor}` };
}

/** The data form for Cardboard's `sA` hook: the windows agent's patch calls `apply` on the command it allows. */
export const preToolUsePrefixer = {
  event: "PreToolUse",
  matcher: "Bash",
  envVar: "CARDBOARD_ACTOR",
  apply: prefixCommand,
  mentionsCb,
  actorIdForHook,
} as const;

/** Claude Code's PreToolUse hook output for a rewritten command. */
/**
 * Claude Code's PreToolUse hook output for a rewritten command. It carries the new input only: attribution must never
 * grant a permission, so no `permissionDecision` is given and the command goes through the user's normal permission
 * rules (a command that needs approval still asks). Claude Code applies `updatedInput` without a decision (checked
 * headless on Claude Code 2.1.314, 2026-10-31: a stub hook rewrote `echo before` to `echo after` with no decision, and
 * the tool ran `echo after` under the session's own allow rule; the docs only describe it with "allow" or "ask").
 */
export function preToolUseOutput(input: HookInput, r: PrefixResult | null): object {
  if (!r) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...(input.tool_input ?? {}), command: r.command },
      additionalContext: r.note,
    },
  };
}

// ---------------------------------------------------------------- Stop / SubagentStop

/** One late-conflict notice for an actor, as the store keeps it. */
export interface ConflictNotice {
  id: string;
  changeId: string;
  text: string;
  cards?: unknown[];
}

/**
 * Where the Stop hook reads and marks notices. Kept in carton.db so host Claude Code's hook, which runs as a fresh
 * process per event, remembers that it already blocked once for a conflict set.
 */
export interface NoticeBox {
  /** Conflict notices for the actor that no Stop hook has blocked on yet. */
  freshConflicts(actorId: string): ConflictNotice[];
  /** Mark notices as delivered by a blocking Stop hook. */
  markBlocked(actorId: string, ids: string[]): void;
  /** Notices a Stop hook blocked on and the agent left unresolved. */
  blocked(actorId: string): ConflictNotice[];
  /** Turn them into cards for the human and close them for the actor. */
  handToHuman(actorId: string, ids: string[]): void;
  /** The turn is over: release its pins (§5.2). */
  endTurn?(actorId: string): void;
}

export interface StopDecision { decision: "allow" | "block"; reason?: string; handedToHuman?: number }

export function stopHook(input: HookInput, box: NoticeBox, turn?: DirectorTurn | null): StopDecision {
  const actor = actorIdForHook(input, turn);
  if (input.stop_hook_active) {
    // the agent already had its one chance: what it left becomes a card for the human
    const left = box.blocked(actor);
    if (left.length) box.handToHuman(actor, left.map((n) => n.id));
    box.endTurn?.(actor);
    return { decision: "allow", handedToHuman: left.length };
  }
  const fresh = box.freshConflicts(actor);
  if (!fresh.length) {
    box.endTurn?.(actor);
    return { decision: "allow" };
  }
  box.markBlocked(actor, fresh.map((n) => n.id));
  const reason = [`${fresh.length} of your changes conflicted after your turn. Resolve them with \`cb conflicts\` and \`cb resolve\`, or leave them for the user:`, ...fresh.map((n) => `- ${n.text}`)].join("\n");
  return { decision: "block", reason };
}

/** Claude Code's Stop/SubagentStop hook output. */
export function stopOutput(d: StopDecision): object {
  return d.decision === "block" ? { decision: "block", reason: d.reason } : {};
}

// ---------------------------------------------------------------- hook events for the holder's materializer

/**
 * The `hook` write (WriteOp): an agent's hook event, for the lease holder's materializer. The actor is the request's.
 * - `read`: about to read the shared `timeline.tsx` (PreToolUse on Read): the freeze starts (`hookRead`).
 * - `write`: about to write `file`, project-relative with `/` (PreToolUse on Write/Edit/MultiEdit): the next foreign save
 *   of it is credited to the agent, down to the subagent (`hookWrite`); a write of the shared file also freezes it.
 * - `stop`: its turn ended (Stop/SubagentStop the late-conflict hook allowed): its pins go, the freeze may end
 *   (`hookStop`).
 */
export type HookEventKind = "read" | "write" | "stop";
export interface HookOp { kind: "hook"; event: HookEventKind; file?: string }
/** A hook event to send: who, and the write. */
export interface HookSend { actor: Actor; op: HookOp }

/** The shared file (a hooked agent reading it starts the freeze) and the files whose foreign saves a hook credits. */
export const SHARED_FILE = "timeline.tsx";
const CREDITED = new Set([SHARED_FILE, "project.json"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
/** Case-insensitive file systems (Windows, macOS): `Timeline.tsx` is the shared file there. */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

/** `file` (absolute, or relative to the hook's cwd) as a project-relative `/` path; null outside the project. */
export function projectRel(projectDir: string, file: string, cwd?: string): string | null {
  const rel = relative(resolve(projectDir), resolve(cwd ?? projectDir, file));
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/**
 * The hook event a Claude Code hook call means for the holder's materializer, or null (most tool calls). The actor is
 * the one the PreToolUse prefixer exports for the agent's `cb` calls (`actorIdForHook`), so the freeze, the credit and
 * the turn's pins are the same agent's, down to the subagent. `stop` is for a stop the late-conflict hook allowed: a
 * blocked stop goes on with the turn.
 */
export function hookEventFor(event: "pre-tool-use" | "stop", input: HookInput, o: { projectDir?: string | null; turn?: DirectorTurn | null; foldCase?: boolean } = {}): HookSend | null {
  const actor = parseActorId(actorIdForHook(input, o.turn));
  if (!actor) return null;
  if (event === "stop") return { actor, op: { kind: "hook", event: "stop" } };
  const tool = String(input.tool_name ?? "");
  const file = input.tool_input?.file_path;
  if (!o.projectDir || typeof file !== "string" || !file || (tool !== "Read" && !WRITE_TOOLS.has(tool))) return null;
  const rel = projectRel(o.projectDir, file, typeof input.cwd === "string" ? input.cwd : undefined);
  if (!rel) return null;
  const key = o.foldCase ?? FOLD_CASE ? rel.toLowerCase() : rel;
  if (tool === "Read") return key === SHARED_FILE ? { actor, op: { kind: "hook", event: "read", file: SHARED_FILE } } : null;
  return CREDITED.has(key) ? { actor, op: { kind: "hook", event: "write", file: key } } : null;
}
