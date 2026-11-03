// A clip's credits as History's "Only “clip”" says them (DESIGN §6.1: "Added by You on Oct 30 · trimmed by Director ·
// moved by You at 12:41 pm"), with the clip's kind for its chip. A credit line names a part ("Timing") and the change
// that last touched it (`versionId`): the verb comes from what that change did to the clip (design QA G7). A trim is
// "trimmed", a move "moved", both "trimmed and moved"; "timing changed" only when the change isn't known. Editors say
// "retimed" for a speed change, so the credits never do.

import type { Actor, CartonUi, ClipKind } from "./model.ts";
import type { Words } from "./words.ts";

/** One part of a clip's credits: the verb ("trimmed"), who, and when. */
export interface CreditPart {
  readonly verb: string;
  readonly author: Actor;
  readonly at?: number;
}

export interface ClipCreditsView {
  /** The clip's name (unquoted). */
  readonly clip: string;
  /** Its kind, for the chip before the name, when a change in its credits says it. */
  readonly kind?: ClipKind;
  /** Oldest first. */
  readonly parts: readonly CreditPart[];
}

const TIMING = new Set(["Trim", "Move", "TrimMove"]);

/**
 * What a change's sentence (DESIGN §8, core's describe) says it did to its clip, as a key of `words.creditVerb`: "Trim",
 * "Move", "TrimMove", "Added", "Name", or null for anything else.
 */
export function creditVerbOf(text: string): string | null {
  const trim = /^Trimmed\b|\btrimmed it\b/.test(text);
  const move = /^Moved\b|\bmoved it\b/.test(text);
  if (trim && move) return "TrimMove";
  if (trim) return "Trim";
  if (move) return "Move";
  if (/^Added\b/.test(text)) return "Added";
  if (/^Renamed\b/.test(text)) return "Name";
  return null;
}

/**
 * A clip's credits in words: each line's verb from its part, and for a timing line (or a part the words don't know,
 * the host's "Last change") from what its change did. Reads each named change once (`changesIn`, cached by the view
 * model); a line without one keeps its part's verb.
 */
export async function clipCredits(ui: CartonUi, item: string, words: Words): Promise<ClipCreditsView> {
  const credits = await ui.credits(item);
  const lines = [...credits.lines].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let kind: ClipKind | undefined;
  const parts = await Promise.all(
    lines.map(async (l): Promise<CreditPart> => {
      const known = words.creditVerb[l.what] !== undefined;
      let said: string | null = null;
      if (l.versionId !== undefined && (l.what === "Timing" || !known)) {
        const change = (await ui.changesIn(l.versionId).catch(() => [])).find((c) => c.itemId === item);
        if (change) {
          kind ??= change.clip;
          said = creditVerbOf(change.text);
        }
      }
      const key = l.what === "Timing" ? (said && TIMING.has(said) ? said : "Timing") : known ? l.what : (said ?? "Change");
      const verb = words.creditVerb[key] ?? words.creditVerb.Change ?? "changed";
      return { verb, author: l.author, ...(l.at !== undefined ? { at: l.at } : {}) };
    }),
  );
  return { clip: credits.clip, ...(kind ? { kind } : {}), parts };
}
