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
import { safePart, subagentSuffix } from "./identity.ts";
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
 * rules (a command that needs approval still asks). [Needs a check on a real Claude Code: that `updatedInput` applies
 * without a decision. If it doesn't, the call simply runs unprefixed and the actor falls back to the environment.]
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
