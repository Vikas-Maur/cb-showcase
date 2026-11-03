// Comparing two cuts (Carton UX v2, DESIGN-V2 §1.12): nobody made the differences, the cuts just differ, so a
// sentence says where a clip is, not what someone did: "Only in Main cut: “Drone shot”", "“Interview B” is 6 s shorter
// in “30s Instagram cut”", "“Intro” ends at 0:05 here, 0:03 in “30s Instagram cut”", "The title reads “Summer ’26” in
// “30s Instagram cut”". Rows as `changeList` makes them (one per change, the same count), with their text re-said.
// Outside the history bundle.
import type { ChangeRow, Doc, Rec } from "./types.ts";
import type { Schema } from "./schema.ts";
import * as E from "./engine/index.ts";

const timecode = E.timecode;
const secs = (d: number) => {
  const r = Math.round(Math.abs(d) * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} s`;
};

/**
 * The rows from `a` (the left cut) to `b` (the right), said as differences. `left`/`right`: the cuts' names as the
 * sentences show them ("“30s Instagram cut”", "Main cut"); `here`: the right side is the cut you're on ("here").
 */
export function betweenCuts(rows: readonly ChangeRow[], a: Doc, b: Doc, schema: Schema, names: { left: string; right: string; here?: boolean }): ChangeRow[] {
  const tl = schema.timeline;
  const inRight = names.here ? "here" : `in ${names.right}`;
  return rows.map((r) => {
    const name = r.one ?? (r.rec && r.coll ? `“${schema.label?.(r.coll, r.rec, r.kind === "remove" ? a : b) ?? r.id}”` : r.key);
    if (r.kind === "add") return { ...r, text: `Only in ${names.right}: ${name}` };
    if (r.kind === "remove") return { ...r, text: `Only in ${names.left}: ${name}` };
    if (!r.coll || r.id === undefined) return { ...r, text: `${capital(name)} differs in ${names.left}` };
    const x = E.getIn(a, [r.coll, r.id], schema) as Rec | undefined, y = E.getIn(b, [r.coll, r.id], schema) as Rec | undefined;
    if (!x || !y) return r;
    const words = schema.collections[r.coll]?.words;
    const tx = words?.(x)?.[0], ty = words?.(y)?.[0];
    if (tl && r.coll === tl.collection) {
      const [xs, xe, ys, ye] = [x[tl.start], x[tl.end], y[tl.start], y[tl.end]].map(Number);
      if ([xs, xe, ys, ye].every(Number.isFinite)) {
        const dx = xe! - xs!, dy = ye! - ys!;
        if (Math.abs(dx - dy) > 0.05 && Math.abs(xs! - ys!) <= 0.05) return { ...r, text: `${name} ends at ${timecode(ye!)} ${inRight}, ${timecode(xe!)} in ${names.left}` };
        if (Math.abs(dx - dy) > 0.05) return { ...r, text: `${name} is ${secs(dx - dy)} ${dx < dy ? "shorter" : "longer"} in ${names.left}` };
        if (Math.abs(xs! - ys!) > 0.05) return { ...r, text: `${name} is ${secs(xs! - ys!)} ${xs! < ys! ? "earlier" : "later"} in ${names.left}` };
      }
    }
    if (typeof tx === "string" && tx !== ty) {
      const noun = schema.collections[r.coll]?.nounOf?.(x) ?? "text";
      return { ...r, text: `The ${noun} reads “${tx}” in ${names.left}` };
    }
    return { ...r, text: `${name} is different in ${names.left}` };
  });
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
