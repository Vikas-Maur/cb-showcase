// The change declaration (PLAN §6.1): what a change tells its sequencer, computed at commit from the base it was made
// on. Port of core-v5 `declare` plus system-v11's additions (group paths, structural flag, span annotation).
//  - paths: every op's path key, plus `<coll>/<id>/#<group>` for each record field group it touches, so two edits of
//    one clip's timing always meet in merge3 and the edit algebra;
//  - reads: the existence of the records it sets, of the lane it places items on, and the `#pos` of the neighbours an
//    insert or move was placed between;
//  - spans: per lane, the half-open time range an op changes ([min, max) of old and new edges; an item's extent for
//    insert/remove; [t0, ∞) for a remap, `hi: null`; both lanes for a lane change);
//  - trackOrder: lanes whose `#pos` changed; structural: an item insert/remove, a lane change, or a remap.
import { POS } from "../types.ts";
import type { Schema } from "../schema.ts";
import type { Declaration, Doc, Intent, Op, Rec, RemapMaps, Span } from "../types.ts";
import { getIn } from "./doc.ts";
import { pathKey } from "./json.ts";

export function declare(schema: Schema, base: Doc, ops: readonly Op[], intent: Intent | null = null): Declaration {
  const tl = schema.timeline;
  const paths: string[] = [],
    groups = new Set<string>(),
    reads = new Set<string>(),
    spans: Span[] = [],
    trackOrder = new Set<string>();
  const items = new Map<string, Op[]>();
  const remapMaps: RemapMaps[] = [];
  if (intent?.maps) remapMaps.push(intent.maps);
  let structural = false;
  for (const op of ops) {
    if (op.op === "remap") {
      // its effect is declared by its span; the op path is a marker, not a record
      remapMaps.push(op.maps);
      continue;
    }
    paths.push(pathKey(op.path));
    const cs = schema.collections[op.path[0] as string];
    if (cs && op.path.length > 2) reads.add(pathKey(op.path.slice(0, 2)));
    if (cs && op.path.length === 3) {
      const g = cs.groupOf.get(op.path[2] as string);
      if (g) groups.add(pathKey([op.path[0]!, op.path[1]!, "#" + g.name]));
    }
    if ((op.op === "insert" || op.op === "set") && op.nb) {
      const sp = op.path.at(-1) === POS ? op.path.slice(0, -2) : op.path.slice(0, -1);
      for (const n of op.nb) if (n != null) reads.add(pathKey([...sp, n, POS]));
    }
    if (cs?.parent) {
      const { field, collection } = cs.parent;
      if (op.path.length === 2 && op.op === "insert" && (op.value as Rec | undefined)?.[field] !== undefined) reads.add(pathKey([collection, (op.value as Rec)[field] as string]));
      if (op.path.length === 3 && op.path[2] === field && op.op === "set") reads.add(pathKey([collection, op.value as string]));
    }
    if (cs?.seq && op.path[2] === POS) trackOrder.add(op.path[1] as string);
    if (tl && op.path[0] === tl.collection) {
      let it = items.get(op.path[1] as string);
      if (!it) items.set(op.path[1] as string, (it = []));
      it.push(op);
      if (op.path.length === 2 || (op.path[2] === tl.lane && op.op === "set")) structural = true;
    }
  }
  if (tl)
    for (const [id, list] of items) {
      const old = getIn(base, [tl.collection, id], schema) as Rec | undefined;
      const whole = list.find((op) => op.path.length === 2);
      const itemStructural = list.some((op) => op.path.length === 2 || op.path[2] === tl.lane);
      const span = (track: unknown, lo: unknown, hi: unknown) => spans.push({ track: track as string, lo: lo as number, hi: hi as number, item: id, structural: itemStructural });
      if (whole) {
        if (old) span(old[tl.lane], old[tl.start], old[tl.end]);
        if (whole.op === "insert" && whole.value) {
          const v = whole.value as Rec;
          span(v[tl.lane], v[tl.start], v[tl.end]);
        }
        continue;
      }
      if (!old) continue;
      const nw: Rec = { ...old };
      let timing = false;
      for (const op of list) {
        if (op.path.length !== 3) continue;
        const f = op.path[2];
        if (f === tl.start || f === tl.end || f === tl.source || f === tl.sourceEnd || f === tl.speed || f === tl.lane) {
          timing = true;
          nw[f as string] = op.op === "unset" ? undefined : (op as { value: unknown }).value;
        }
      }
      if (!timing) continue;
      const os = old[tl.start] as number,
        oe = old[tl.end] as number;
      if (nw[tl.lane] !== old[tl.lane]) {
        span(old[tl.lane], os, oe);
        span(nw[tl.lane], nw[tl.start] ?? os, nw[tl.end] ?? oe);
      } else span(old[tl.lane], Math.min(os, (nw[tl.start] as number) ?? os), Math.max(oe, (nw[tl.end] as number) ?? oe));
    }
  const remapped = new Map<string, number>();
  for (const maps of remapMaps)
    for (const [track, chain] of Object.entries(maps)) {
      let t0 = Infinity;
      for (const st of chain) for (const [a] of [...st.d, ...st.i]) t0 = Math.min(t0, a);
      if (t0 < Infinity) remapped.set(track, Math.min(t0, remapped.get(track) ?? Infinity));
    }
  for (const [track, t0] of remapped) spans.push({ track, lo: t0, hi: null, item: null, structural: true });
  if (remapped.size) structural = true;
  return { paths: groups.size ? [...paths, ...groups] : paths, reads: [...reads], spans, trackOrder: [...trackOrder], structural };
}
