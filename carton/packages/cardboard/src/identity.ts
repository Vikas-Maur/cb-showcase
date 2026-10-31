// Who is acting (PLAN §10, L1). Cardboard's in-process PreToolUse Bash hook (the credit gate `sA`) prefixes every
// `cb` command with `CARDBOARD_ACTOR=director/<chat>/<turn>`; inside a subagent the hook input carries `agent_id` and
// `agent_type`, so the actor gets `/sub-<type>-<id>`. Host Claude Code gets the same hook through `--settings`, under
// its own agent name. Codex, Gemini and other tools declare themselves (any other value), which we can't check (L1).
import type { Actor } from "@carton/core";
import type { IdentitySource } from "@carton/core/plugins";

/** The agents whose hook-provided ids we know how to read; any other first segment is still accepted. */
const NAMES: Readonly<Record<string, string>> = { director: "Director", "claude-code": "Claude Code" };
const PROVIDERS: Readonly<Record<string, string>> = { director: "claude", "claude-code": "claude" };
const SEG = /^[A-Za-z0-9._:-]+$/;
const SUB = /^sub-([A-Za-z0-9._:-]+?)-([A-Za-z0-9._:]+)$/;

/**
 * `director/<chat>/<turn>[/sub-<type>-<id>]` (or any `<agent>/<chat>/<turn>[…]`) is a hooked agent turn, down to the
 * subagent. Any other non-empty value is self-declared: an agent with that id and no turn (a windowless local actor,
 * which joins the window's undo group, §8). `defaults` fills fields the value doesn't carry (group, provider, model).
 */
export function parseActor(value: string, defaults: Partial<Actor> = {}): Actor | null {
  const v = value.trim();
  if (!v || /[\r\n\0]/.test(v)) return null;
  const parts = v.split("/");
  if (parts.length >= 3 && parts.length <= 4 && parts.every((p) => SEG.test(p))) {
    const [agent, chat, turn, sub] = parts as [string, string, string, string | undefined];
    const base: Actor = { ...defaults, kind: "agent", id: v, name: NAMES[agent] ?? agent, chat, turn };
    const provider = defaults.provider ?? PROVIDERS[agent];
    if (provider) base.provider = provider;
    if (sub === undefined) return base;
    const m = SUB.exec(sub);
    if (m) return { ...base, kind: "subagent", agentType: m[1], agentId: m[2], name: `${base.name} › ${m[1]}` };
  }
  return { ...defaults, kind: "agent", id: v, name: defaults.name ?? v };
}

/** The `id` a Claude Code hook gives a subagent turn: `<parent>/sub-<type>-<id>`. */
export function subagentActorId(parent: string, agentType: string, agentId: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._:-]/g, "_");
  return `${parent}/sub-${clean(agentType)}-${clean(agentId).replace(/-/g, "_")}`;
}

/** `CARDBOARD_ACTOR` from the environment; null when unset (the caller then decides: GUI human, or self-declared). */
export const cardboardIdentity: IdentitySource = {
  kind: "cardboard-env",
  current: (env = {}) => {
    const v = env.CARDBOARD_ACTOR;
    return v ? parseActor(v) : null;
  },
};
