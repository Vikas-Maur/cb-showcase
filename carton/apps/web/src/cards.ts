// Conflict cards in an editor's words (§7, §0.1 "Conflict card"): which clip, what each side did to it ("Ends at
// 0:15.6", the caption text), and why it's a card. @carton/react words a card generically from its path; Cardboard's
// clips have names and a time group, which the demo knows how to say.

import type { ConflictCard, Doc, Rec, Schema } from "@carton/core";
import { splitPathKey } from "@carton/react";
import { ITEMS } from "./demo-doc.ts";
import { formatTime } from "./timeline.ts";

const TIME = ["startTime", "endTime"] as const;
const quote = (v: unknown, n = 40) => {
  const s = String(v ?? "");
  return `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;
};

/** What one side's value of a clip's time group says, against the base: moved, trimmed, or both edges. */
export function timeWords(side: unknown, base: unknown): string {
  const v = (side ?? {}) as Record<string, number>;
  const b = (base ?? {}) as Record<string, number>;
  if (!side) return "Removed it";
  const ds = v.startTime - (b.startTime ?? v.startTime), de = v.endTime - (b.endTime ?? v.endTime);
  if (Math.abs(ds) < 1e-6 && Math.abs(de) > 1e-6) return `Ends at ${formatTime(v.endTime)}`;
  if (Math.abs(de) < 1e-6 && Math.abs(ds) > 1e-6) return `Starts at ${formatTime(v.startTime)}`;
  if (Math.abs(ds - de) < 1e-6 && Math.abs(ds) > 1e-6) return `Moved to ${formatTime(v.startTime)}`;
  return `${formatTime(v.startTime)} – ${formatTime(v.endTime)}`;
}

const REASONS: Record<string, string> = {
  group: "You both changed this clip's timing, differently.",
  field: "You both changed this, differently.",
  text: "You both changed the same words.",
  record: "One of you removed it while the other changed it.",
  parent: "Its track was removed while it was being changed.",
  remap: "A ripple moved it while it was being changed.",
};

/** `describeCard` for fromCarton: reads clip names from the current head (`doc()`). */
export function describeCardWith(doc: () => Doc) {
  return (card: ConflictCard, schema: Schema): { title: string; mine: string; theirs: string; reason?: string } => {
    const segs = splitPathKey(card.path);
    const reason = card.kind === "invalid" ? `The result would be invalid${card.reason ? `: ${card.reason}` : ""}.` : REASONS[card.kind];
    if (segs[0] !== ITEMS || !segs[1]) {
      const label = (schema.labels as Record<string, string> | undefined)?.[segs[0] ?? ""] ?? segs.join(" ");
      return { title: `The ${label}`, mine: quote(card.ours), theirs: quote(card.theirs), ...(reason ? { reason } : {}) };
    }
    const rec = ((doc()[ITEMS] ?? []) as Rec[]).find((r) => r.id === segs[1]) ?? ((card.ours ?? card.theirs ?? card.base) as Rec | undefined);
    const name = rec?.type === "caption" ? `Caption ${quote(rec.captionText, 24)}` : `'${String(rec?.name ?? segs[1])}'`;
    const field = segs[2];
    if (field === "#time" || (field && (TIME as readonly string[]).includes(field))) {
      const pick = (v: unknown) => (field === "#time" ? v : { [field]: v });
      return { title: `${name} timing`, mine: timeWords(pick(card.ours), pick(card.base)), theirs: timeWords(pick(card.theirs), pick(card.base)), ...(reason ? { reason } : {}) };
    }
    if (!field) return { title: name, mine: card.ours === undefined ? "Removed it" : "Changed it", theirs: card.theirs === undefined ? "Removed it" : "Changed it", ...(reason ? { reason } : {}) };
    const what = field === "captionText" ? "text" : field === "volume" ? "volume" : field === "opacity" ? "opacity" : field.replace(/^#/, "");
    const say = (v: unknown) => (field === "volume" ? `${String(v)} %` : field === "opacity" ? `${Math.round(Number(v) * 100)} %` : quote(v));
    return { title: `${name} ${what}`, mine: say(card.ours), theirs: say(card.theirs), ...(reason ? { reason } : {}) };
  };
}
