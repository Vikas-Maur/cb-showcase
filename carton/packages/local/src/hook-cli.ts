// The Claude Code hooks as commands, for host Claude Code started with `--settings` (§10, H9):
//   carton hook pre-tool-use [--project <dir>]  stdin: hook input JSON → stdout: the rewritten Bash command (or {});
//                                                a Read of timeline.tsx, a Write/Edit of it or project.json: told to
//                                                the holder's materializer (H8)
//   carton hook stop --project <dir>             stdin: Stop/SubagentStop input → stdout: {decision:"block",reason}
//                                                once, or {}; an allowed stop is told to the holder's materializer
// The Director runs the same logic in-process through Cardboard's hook `sA` (`prefixCommand`, `stopHook`).
// A hook never fails the agent's turn: on any error it prints {} and exits 0.
import { prefixCommand, preToolUseOutput, stopHook, stopOutput, actorIdForHook, hookEventFor } from "./hooks.ts";
import type { DirectorTurn, HookSend } from "./hooks.ts";
import type { HookInput } from "./identity.ts";
import { StoreNoticeBox } from "./notices.ts";
import type { Store } from "@carton/core/plugins";

export type HookEvent = "pre-tool-use" | "stop";

/** A Director turn from CARDBOARD_ACTOR (`director/<chat>/<turn>[/sub-…]`), when the hook runs inside one. */
export function turnFromEnv(env: Readonly<Record<string, string | undefined>>): DirectorTurn | null {
  const m = /^director\/([^/]+)\/([^/]+)/.exec(env.CARDBOARD_ACTOR ?? "");
  return m ? { chat: m[1], turn: m[2] } : null;
}

export interface RunHookOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** carton.db, for the Stop hook's late conflicts (closed after). */
  openStore?: () => Promise<Store | null>;
  /** The project folder: a pre-tool-use event's file is matched inside it (`hookEventFor`). */
  projectDir?: string | null;
  /**
   * Tell the lease holder's materializer (H8): `sendHookEvent`, or a `LocalCarton`'s `write(op, {actor})`. Without it,
   * nothing is sent (the hooks as before). Its failure is swallowed: a hook never fails the turn.
   */
  send?: (e: HookSend) => Promise<unknown>;
}

export async function runHook(event: HookEvent, input: HookInput, opts: RunHookOptions = {}): Promise<object> {
  const turn = turnFromEnv(opts.env ?? process.env);
  const tell = async (e: HookSend | null) => { if (e && opts.send) await opts.send(e).catch(() => {}); };
  if (event === "pre-tool-use") {
    const out = preToolUseOutput(input, prefixCommand(input, turn));
    if (opts.send) await tell(hookEventFor("pre-tool-use", input, { projectDir: opts.projectDir, turn }));
    return out;
  }
  const store = await opts.openStore?.();
  try {
    let out: object = {};
    let ends = true;
    if (store) {
      const box = new StoreNoticeBox(store);
      const d = await box.run(actorIdForHook(input, turn), (b) => stopHook(input, b, turn));
      out = stopOutput(d);
      ends = d.decision === "allow";
    }
    // a blocked stop goes on with the turn: its freeze and pins stay. Told before the store closes (a sender writing
    // through the same handle as `openStore`'s still has it)
    if (ends && opts.send) await tell(hookEventFor("stop", input, { turn }));
    return out;
  } finally {
    await store?.close();
  }
}

/**
 * One word for the shell Claude Code runs hook commands in (sh, or Git Bash on Windows): single quotes, so nothing in a
 * path (`$(…)`, backticks, `"`) is expanded; a single quote inside becomes `'\''`.
 */
export const shQuote = (s: string): string => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * `--settings` hooks for host Claude Code: the prefixer on Bash, the materializer's hook events on Read, Write, Edit
 * and MultiEdit (H8), the late-conflict hook on Stop and SubagentStop. `command` is already shell words (quote each with
 * `shQuote`); `projectDir` is quoted here.
 */
export function hookSettings({ command, projectDir }: { command: string; projectDir: string }): object {
  const q = shQuote;
  const stop = { hooks: [{ type: "command", command: `${command} hook stop --project ${q(projectDir)}` }] };
  return {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `${command} hook pre-tool-use` }] },
        { matcher: "Read|Write|Edit|MultiEdit", hooks: [{ type: "command", command: `${command} hook pre-tool-use --project ${q(projectDir)}` }] },
      ],
      Stop: [stop],
      SubagentStop: [stop],
    },
  };
}
