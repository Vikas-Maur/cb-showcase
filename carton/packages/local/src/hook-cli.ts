// The Claude Code hooks as commands, for host Claude Code started with `--settings` (§10, H9):
//   carton hook pre-tool-use            stdin: hook input JSON → stdout: the rewritten Bash command (or {})
//   carton hook stop --project <dir>    stdin: Stop/SubagentStop input → stdout: {decision:"block",reason} once, or {}
// The Director runs the same logic in-process through Cardboard's hook `sA` (`prefixCommand`, `stopHook`).
// A hook never fails the agent's turn: on any error it prints {} and exits 0.
import { prefixCommand, preToolUseOutput, stopHook, stopOutput, actorIdForHook } from "./hooks.ts";
import type { DirectorTurn } from "./hooks.ts";
import type { HookInput } from "./identity.ts";
import { StoreNoticeBox } from "./notices.ts";
import type { Store } from "@carton/core/plugins";

export type HookEvent = "pre-tool-use" | "stop";

/** A Director turn from CARDBOARD_ACTOR (`director/<chat>/<turn>[/sub-…]`), when the hook runs inside one. */
export function turnFromEnv(env: Readonly<Record<string, string | undefined>>): DirectorTurn | null {
  const m = /^director\/([^/]+)\/([^/]+)/.exec(env.CARDBOARD_ACTOR ?? "");
  return m ? { chat: m[1], turn: m[2] } : null;
}

export async function runHook(event: HookEvent, input: HookInput, opts: { env?: Readonly<Record<string, string | undefined>>; openStore?: () => Promise<Store | null> } = {}): Promise<object> {
  const turn = turnFromEnv(opts.env ?? process.env);
  if (event === "pre-tool-use") return preToolUseOutput(input, prefixCommand(input, turn));
  const store = await opts.openStore?.();
  if (!store) return {};
  try {
    const box = new StoreNoticeBox(store);
    const d = await box.run(actorIdForHook(input, turn), (b) => stopHook(input, b, turn));
    return stopOutput(d);
  } finally {
    await store.close();
  }
}

/** `--settings` hooks for host Claude Code: the prefixer on Bash, the late-conflict hook on Stop and SubagentStop. */
export function hookSettings({ command, projectDir }: { command: string; projectDir: string }): object {
  const q = (s: string) => (/^[A-Za-z0-9_./:\\-]+$/.test(s) ? s : JSON.stringify(s));
  const stop = { hooks: [{ type: "command", command: `${command} hook stop --project ${q(projectDir)}` }] };
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${command} hook pre-tool-use` }] }],
      Stop: [stop],
      SubagentStop: [stop],
    },
  };
}
