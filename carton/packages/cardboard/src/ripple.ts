// Ripple inference from an unrecorded edit (PLAN §6.1, §7, L9). The renderer's named actions (rippleDeleteGap,
// rippleDeleteAllGaps, splitTimelineItem, removeSilencesFromClips) and the matching CLI paths record their remap; an
// agent's file save carries none. When such a save is unambiguously a ripple (every later clip on a track shifted by
// the same amount, nothing else about them changed), the remap is inferred at commit and recorded on the change, so it
// declares its [t0, ∞) span and later merges map the other side's concurrent clips through it. Anything less clear is
// left as plain moves: a heuristic that refuses to guess (L9). The rules are core's `inferRemaps`, run on this schema.
import { diff, inferRemaps } from "@carton/core";
import type { Doc, Intent } from "@carton/core";
import { cardboardSchema } from "./schema.ts";

/** The remap intent an unrecorded edit from `base` to `saved` implies, or null when it isn't unambiguously a ripple. */
export function inferRipple(base: Doc, saved: Doc): Intent | null {
  const ops = diff(base, saved, cardboardSchema);
  const maps = inferRemaps(cardboardSchema, base, ops.map((op) => ({ path: op.path, op })));
  return Object.keys(maps).length ? { maps, inferred: true } : null;
}
