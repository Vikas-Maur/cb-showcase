// Who is acting (PLAN §10, L1). Cardboard's in-process PreToolUse Bash hook (the credit gate `sA`) prefixes every
// `cb` command with `CARDBOARD_ACTOR=director/<chat>/<turn>`; inside a subagent the hook input carries `agent_id` and
// `agent_type`, so the actor gets `/sub-<type>-<id>`. Host Claude Code is `claude-code/<session>[/sub-…]` (our hook,
// passed with `--settings`). Codex, Gemini and other tools declare `<provider>[/<name>]`, which we can't check (L1).
//
// This is the platform-free parser. It gives the same Actor as `@carton/local`'s `parseActorId` for the same id; the
// undo `group` (local to a machine and OS user, §8) comes from the caller.
import type { Actor } from "@carton/core";
import type { IdentitySource } from "@carton/core/plugins";

// Actor ids travel through shell commands, view file names and the log: a safe alphabet only.
const SAFE = /^[A-Za-z0-9._:-]{1,64}$/;
const SUB = /^sub-([A-Za-z0-9._:-]+)-([A-Za-z0-9._:]+)$/;
const NAMES: Readonly<Record<string, string>> = { director: "Director", codex: "Codex", gemini: "Gemini", cursor: "Cursor", "claude-code": "Claude Code" };

/** Parses an actor id; null when it isn't one (an empty part, or a character outside the safe alphabet). */
export function parseActor(value: string, defaults: Partial<Actor> = {}): Actor | null {
  const parts = value.trim().split("/");
  if (!parts.length || parts.some((p) => !SAFE.test(p))) return null;
  const sub = parts.length > 1 ? SUB.exec(parts.at(-1)!) : null;
  const head = sub ? parts.slice(0, -1) : parts;
  const a: Actor = { ...defaults, kind: sub ? "subagent" : "agent", id: parts.join("/"), name: NAMES[head[0]!] ?? head[0]! };
  if (head[0] === "director") {
    a.provider = "claude-code";
    if (head[1]) a.chat = head[1];
    if (head[2]) a.turn = head[2];
  } else if (head[0] === "claude-code") a.provider = "claude-code";
  if (sub) {
    a.agentType = sub[1];
    a.agentId = sub[2];
    a.name = `${a.name} › ${sub[1]}`;
  }
  return a;
}

/** `/sub-<type>-<id>` for a Claude Code subagent: the id is the last `-`-separated part, so its hyphens become `_`. */
export function subagentActorId(parent: string, agentType: string, agentId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64);
  return `${parent}/sub-${safe(agentType || "agent")}-${safe(agentId).replace(/-/g, "_")}`;
}

/** `CARDBOARD_ACTOR` from the environment; null when unset or not an actor id. */
export const cardboardIdentity: IdentitySource = {
  kind: "cardboard-env",
  current: (env = {}) => {
    const v = env.CARDBOARD_ACTOR;
    return v ? parseActor(v) : null;
  },
};
