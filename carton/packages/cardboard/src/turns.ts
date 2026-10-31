// Director turns as named versions (PLAN §0.1 "Version": made after every Director turn; chat checkpoints are
// versions). When a turn ends, the app names the turn's last version with the turn's short label ("tighter intro",
// from the user's prompt), so History reads in the user's words. The windows agent's H9 wiring calls this from the
// Stop hook. The label is the user's own text: it goes into the project's history only, never into telemetry or the
// activity log, so nothing here logs it.
import type { Carton, Version } from "@carton/core";

export interface TurnRef {
  /** The turn id (the `<turn>` of `director/<chat>/<turn>`). */
  turn: string;
  /** The chat it belongs to, when known: turn ids are only unique within a chat. */
  chat?: string;
}

/** A version name from a free-text label: one line, trimmed, at most 120 characters. */
export function turnName(label: string): string {
  const one = label.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
}

/**
 * Names the newest version a turn made (the agent's or any of its subagents' changes) on `cut` (default: current) with
 * `label`. Returns that version, or null when the turn made none among the latest `scan` versions.
 */
export async function nameTurn(carton: Pick<Carton, "log" | "name">, turn: TurnRef, label: string, opts: { cut?: string; scan?: number } = {}): Promise<Version | null> {
  const name = turnName(label);
  if (!name) return null;
  const versions = await carton.log({ ...(opts.cut ? { cut: opts.cut } : {}), limit: opts.scan ?? 500 });
  const last = versions.find((v) => v.change && v.author?.turn === turn.turn && (turn.chat === undefined || v.author.chat === turn.chat));
  if (!last) return null;
  await carton.name(last.ref, name);
  return { ...last, name };
}
