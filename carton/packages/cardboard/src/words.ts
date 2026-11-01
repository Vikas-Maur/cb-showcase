// Conflict cards in Cardboard's words (ui-words): core's describeCard (each side's own change, times as History words
// them, the schema's field labels, never ids) with Cardboard's units: speed "2×", volume and opacity in percent, a
// clip's media by its file name. The History panel passes it to fromCarton's `describeCard`.
import { describeCard } from "@carton/core";
import type { ConflictCard, Doc, Rec, Schema } from "@carton/core";
import { cardboardSchema, mediaName, MEDIA } from "./schema.ts";

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : undefined);

/** A Cardboard field's value in the editor's words; undefined: core's default. */
export function cardboardValue(key: string, v: unknown, doc: Doc | undefined): string | undefined {
  switch (key) {
    case "playbackSpeed":
      return typeof v === "number" ? `${+v.toFixed(2)}×` : undefined;
    case "volume":
    case "opacity":
    case "lutIntensity":
      return pct(v);
    case "hidden":
      return typeof v === "boolean" ? (v ? "hidden" : "shown") : undefined;
    case "muted":
      return typeof v === "boolean" ? (v ? "muted" : "on") : undefined;
    case "audioDisabled":
      return typeof v === "boolean" ? (v ? "off" : "on") : undefined;
    case "mediaItemId": {
      const m = doc && typeof v === "string" ? ((doc[MEDIA] as Rec[] | undefined) ?? []).find((x) => x.id === v) : undefined;
      const name = m && mediaName(m);
      return name ? `'${name}'` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Plain words for a conflict card in Cardboard (fromCarton's `describeCard`): `mine` words core's `ours` side and
 * `theirs` core's `theirs`, as that option takes them. `doc` (the cut's head) names the clip, its media and its track.
 */
export function describeCardboardCard(card: ConflictCard, schema: Schema = cardboardSchema, doc?: Doc): { title: string; mine: string; theirs: string; reason?: string } {
  const w = describeCard(card, schema, doc, { value: cardboardValue });
  return { title: w.title, mine: w.ours, theirs: w.theirs, ...(w.reason ? { reason: w.reason } : {}) };
}
