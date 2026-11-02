// Who is acting (§10, §3.1 `IdentitySource`). Each source looks at what a `cb` process was started with and either
// names the actor or passes; `identify` asks them in order and the first answer wins:
//   1. `CARDBOARD_ACTOR` (set by Cardboard's Director hook, or by our PreToolUse prefixer for host Claude Code):
//      `director/<chat>/<turn>`, plus `/sub-<type>-<id>` inside a subagent. This is the trusted path: Claude Code gives
//      a subagent's `agent_id`/`agent_type` to the hook, never to the subagent's own environment.
//   2. Claude Code hook input (`session_id`, `agent_id`, `agent_type`), when a hook script itself is the caller.
//   3. Self-declared (L1): `--as codex/fix-captions` or `CARTON_AGENT=gemini`. Codex and Gemini have no hook that can
//      rewrite a command, so they say who they are; only the shape is checked, and `director/…` is refused.
//   4. Fallback: the agent CLI recognised from its environment (Claude Code sets CLAUDECODE=1, Gemini CLI sets
//      GEMINI_CLI=1, Codex sets CODEX_* variables), else a terminal user.
// Every local actor gets the same undo group, `local:<os user>@<machine>`: your edits, the agent turns you started, and
// windowless `cb` callers on this machine and OS user, as `cb undo` and History's Undo see it (§8). Remote teammates
// never share it. An actor named by `CARDBOARD_ACTOR` (sources 1 and 2) is the app's own: Cardboard's main sets it for
// every agent it starts, so it is marked `app`, as the person at the editor is. The app's Ctrl+Z sees only those
// (laptop report 90c4127, bug 3): a terminal's `cb` is undone from History or with `cb undo --turn`.
import { hostname, userInfo } from "node:os";
import type { Actor } from "@carton/core";
import type { IdentitySource } from "@carton/core/plugins";

export type Env = Readonly<Record<string, string | undefined>>;

/** Claude Code hook input (JSON on the hook's stdin), the fields Carton reads. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: { command?: string; [k: string]: unknown };
  stop_hook_active?: boolean;
  cwd?: string;
  [k: string]: unknown;
}

// Actor ids travel through shell commands, file names (per-agent views) and the log: keep them to a safe alphabet.
const UNSAFE = /[^A-Za-z0-9._:-]/g;
export const safePart = (s: string): string => String(s).replace(UNSAFE, "-").slice(0, 64);

let groupCache: string | null = null;
/** The undo group shared by every local actor on this machine and OS user (§8). */
export function localGroup(): string {
  if (groupCache) return groupCache;
  let user = "user";
  try { user = userInfo().username; } catch { /* no passwd entry (containers) */ }
  return (groupCache = `local:${safePart(user)}@${safePart(hostname())}`);
}

/**
 * `/sub-<type>-<id>` for a Claude Code subagent (§10). The id is the last `-`-separated part, so hyphens inside it
 * become `_`; types such as `general-purpose` keep theirs.
 */
export const subagentSuffix = (agentType?: string, agentId?: string): string =>
  agentId ? `/sub-${safePart(agentType || "agent")}-${safePart(agentId).replace(/-/g, "_")}` : "";

const SUB = /^sub-([A-Za-z0-9._:-]+)-([A-Za-z0-9._:]+)$/;
const PROVIDER_NAMES: Record<string, string> = { codex: "Codex", gemini: "Gemini", cursor: "Cursor", "claude-code": "Claude Code" };

/** Parses an actor id: `director/<chat>/<turn>[/sub-<type>-<id>]`, `claude-code/<session>[/sub-…]`, or `<provider>[/<name>]`. */
export function parseActorId(id: string, extra: Partial<Actor> = {}): Actor | null {
  const parts = id.split("/");
  if (!parts.length || parts.some((p) => !p || p !== safePart(p))) return null;
  const sub = parts.length > 1 ? SUB.exec(parts.at(-1)!) : null;
  const head = sub ? parts.slice(0, -1) : parts;
  const a: Actor = { kind: sub ? "subagent" : "agent", id: parts.join("/"), name: PROVIDER_NAMES[head[0]] ?? head[0], group: localGroup(), ...extra };
  if (head[0] === "director") {
    a.name = "Director";
    a.provider = "claude-code";
    if (head[1]) a.chat = head[1];
    if (head[2]) a.turn = head[2];
  } else if (head[0] === "claude-code") {
    a.provider = "claude-code";
  }
  if (sub) {
    a.agentType = sub[1];
    a.agentId = sub[2];
    a.name = `${a.name} › ${sub[1]}`;
  }
  return a;
}

/** 1. `CARDBOARD_ACTOR`, set by Cardboard's Director hook or our prefixer. */
export const cardboardActorIdentity: IdentitySource = {
  kind: "cardboard-actor",
  current(env = process.env) {
    const id = env.CARDBOARD_ACTOR?.trim();
    return id ? parseActorId(id, { app: true }) : null;
  },
};

/** 2. Claude Code hook input: a hook script is the caller (host Claude Code with `--settings`). */
export function claudeHookIdentity(hook: HookInput | null | undefined): IdentitySource {
  return {
    kind: "claude-code-hook",
    current(env = process.env) {
      if (!hook?.session_id) return null;
      const given = env.CARDBOARD_ACTOR?.trim().replace(/\/sub-[^/]*$/, "");
      const base = given || `claude-code/${safePart(hook.session_id.slice(0, 8))}`;
      // the app's agent when the app named it; a terminal's Claude Code with Carton's hooks otherwise
      return parseActorId(base + subagentSuffix(hook.agent_type, hook.agent_id), given ? { app: true } : {});
    },
  };
}

const DECLARED = /^([a-z][a-z0-9-]{1,31})(?:\/([A-Za-z0-9._:-]{1,64}))?$/;

/** 3. Self-declared (L1): `--as <provider>[/<name>]` or `CARTON_AGENT`. */
export function declaredIdentity(declared?: string | null): IdentitySource {
  return {
    kind: "self-declared",
    current(env = process.env) {
      const raw = (declared ?? env.CARTON_AGENT ?? "").trim();
      const m = DECLARED.exec(raw);
      if (!m || m[1] === "director") return null; // a Director id only ever comes from the hook
      const label = PROVIDER_NAMES[m[1]] ?? m[1];
      // named by its product, as people know it ("Codex"); the name it gave itself stays in the id (ui-words)
      return { kind: "agent", id: raw, name: label, provider: m[1], group: localGroup() };
    },
  };
}

/** 4. Fallback: the agent CLI recognised from its environment, else a terminal user. Never null. */
export const environmentIdentity: IdentitySource = {
  kind: "environment",
  current(env = process.env) {
    const host = safePart(hostname());
    const provider = env.CLAUDECODE === "1" ? "claude-code" : env.GEMINI_CLI === "1" ? "gemini" : Object.keys(env).some((k) => k.startsWith("CODEX_")) ? "codex" : env.CURSOR_TRACE_ID ? "cursor" : null;
    if (provider) return { kind: "agent", id: `${provider}@${host}`, name: PROVIDER_NAMES[provider]!, provider, group: localGroup() };
    // the person at this machine, typing `cb`: History tells it as "You" (a teammate's, as that teammate); never shown
    // by this name
    return { kind: "external", id: `terminal:${localGroup().slice("local:".length)}`, name: "Terminal", group: localGroup() };
  },
};

export interface IdentifyInput {
  env?: Env;
  hook?: HookInput | null;
  declared?: string | null;
}

export function identitySources({ hook, declared }: Omit<IdentifyInput, "env"> = {}): IdentitySource[] {
  return [cardboardActorIdentity, claudeHookIdentity(hook), declaredIdentity(declared), environmentIdentity];
}

/** Who this `cb` process is acting for. */
export function identify(input: IdentifyInput = {}, sources: readonly IdentitySource[] = identitySources(input)): Actor {
  const env = input.env ?? process.env;
  for (const s of sources) {
    const a = s.current(env);
    if (a) return a;
  }
  return environmentIdentity.current(env)!;
}

/** The environment fallback (source 4): a terminal user or an agent CLI recognised only by its environment. */
export const isFallbackActor = (a: Actor): boolean => a.id.startsWith("terminal:") || /^[a-z][a-z0-9-]*@/.test(a.id);

/** True when the actor's late conflicts can be delivered by a Stop/SubagentStop hook (L1: Claude Code only). */
export const hookDelivered = (a: Actor): boolean => a.provider === "claude-code" && (a.id.startsWith("director/") || a.id.startsWith("claude-code/"));
