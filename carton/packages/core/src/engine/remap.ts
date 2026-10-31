// Remap intents (PLAN §7): piecewise time maps. A remap is a chain of steps; each step is a set of simultaneous events
// in its input coordinates: `d` deleted ranges [a, b) (content removed, later times pulled left) and `i` inserted gaps
// [p, len] (later times pushed right). A time is mapped as a start edge ("s": right-continuous) or an end edge ("e":
// left-continuous); null means the time sat inside deleted content.
import type { Schema } from "../schema.ts";
import type { Doc, Op, Path, Rec, RemapChain, RemapMaps, RemapOp, RemapStep, SetOp } from "../types.ts";
import { posOf } from "./doc.ts";
import { cmp, EMPTY } from "./json.ts";

export const EPS = 1e-6;
export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
export const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** One step from deleted ranges and inserted gaps (an insertion strictly inside a deleted range moves to its start). */
export const step = (d: [number, number][] = [], i: [number, number][] = []): RemapStep => {
  const ds = [...d].sort((x, y) => x[0] - y[0]);
  const is = i
    .map(([p, len]): [number, number] => [ds.find(([a, b]) => a < p - EPS && p < b - EPS)?.[0] ?? p, len])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return { d: ds, i: is };
};
/** Ripple delete: remove [at, at + len), later times pull left. */
export const rippleDelete = (at: number, len: number): RemapChain => [step([[at, at + len]])];
/** Ripple insert: a gap of `len` at `at`, later times push right. */
export const rippleInsert = (at: number, len: number): RemapChain => [step([], [[at, len]])];

function stepPoint(st: RemapStep, x: number, edge: "s" | "e"): number | null {
  let dx = 0;
  for (const [a, b] of st.d) {
    if (edge === "s" ? a <= x + EPS && x < b - EPS : a < x - EPS && x <= b + EPS) return null;
    if (b <= x + (edge === "s" ? EPS : -EPS)) dx -= b - a;
  }
  for (const [p, len] of st.i) if (edge === "s" ? p <= x + EPS : p < x - EPS) dx += len;
  return r6(x + dx);
}
/** Image of time `x` as a start edge ("s") or end edge ("e"); null when it sat inside deleted content. */
export function remapPoint(chain: RemapChain | null | undefined, x: number, edge: "s" | "e" = "s"): number | null {
  let y: number | null = x;
  for (const st of chain ?? EMPTY) {
    y = stepPoint(st, y, edge);
    if (y === null) return null;
  }
  return y;
}
/** Image of an item [s, e]; it keeps its length only if no event falls strictly inside it (else null). */
export function remapSpan(chain: RemapChain | null | undefined, s: number, e: number): [number, number] | null {
  let a: number | null = s,
    b: number | null = e;
  for (const st of chain ?? EMPTY) {
    for (const [x, y] of st.d) if (x < b - EPS && y > a + EPS) return null;
    for (const [p] of st.i) if (p > a + EPS && p < b - EPS) return null;
    a = stepPoint(st, a, "s");
    b = stepPoint(st, b, "e");
    if (a === null || b === null) return null;
  }
  return [a, b];
}
export const isIdentity = (chain: RemapChain | null | undefined): boolean => !chain || chain.every((st) => !st.d.length && !st.i.length);

// Express step a in the output coordinates of step b (both from the same input coordinates). Overlapping deletions
// count once (union); content b inserted inside a deleted range survives; two gaps inserted at one point are ordered
// shorter first (equal gaps are the same edit: kept once).
function tStep(a: RemapStep, b: RemapStep): RemapStep {
  const d: [number, number][] = [];
  for (const [x, y] of a.d) {
    // [x, y) minus b's deletions, split at b's insertions strictly inside
    let pieces: [number, number][] = [[x, y]];
    for (const [c, e] of b.d) pieces = pieces.flatMap(([u, v]): [number, number][] => (e <= u || c >= v ? [[u, v]] : [...(c > u ? [[u, c] as [number, number]] : []), ...(e < v ? [[e, v] as [number, number]] : [])]));
    for (const [p] of b.i) pieces = pieces.flatMap(([u, v]): [number, number][] => (p > u + EPS && p < v - EPS ? [[u, p], [p, v]] : [[u, v]]));
    for (const [u, v] of pieces) if (v - u > EPS) d.push([stepPoint(b, u, "s")!, r6(stepPoint(b, u, "s")! + (v - u))]);
  }
  const ins: [number, number][] = [];
  for (const [p, len] of a.i) {
    if (b.i.some(([q, l]) => near(q, p) && near(l, len))) continue; // the same gap made twice: once
    // image of the insertion point: a point strictly inside one of b's deleted ranges collapses to the range's start
    // (after b's gaps there); at a tie with b's gaps at the same point the shorter gap goes first
    let x = p,
      inside = false;
    for (const [c, e] of b.d)
      if (c < p - EPS && p < e - EPS) {
        x = c;
        inside = true;
        break;
      }
    let dx = 0;
    for (const [c, e] of b.d) if (e <= x + EPS) dx -= e - c;
    for (const [q, l] of b.i) if (q < x - EPS || (near(q, x) && (inside || l < len - EPS))) dx += l;
    ins.push([r6(x + dx), len]);
  }
  return step(d, ins);
}
/** Chain A expressed in the output coordinates of chain B (both from the same input coordinates). */
export function transformChain(A: RemapChain | null | undefined, B: RemapChain | null | undefined): RemapChain {
  let Bcur = B ?? [];
  const out: RemapChain = [];
  for (const a of A ?? []) {
    let acur = a;
    const next: RemapStep[] = [];
    for (const b of Bcur) {
      const a2 = tStep(acur, b);
      next.push(tStep(b, acur));
      acur = a2;
    }
    out.push(acur);
    Bcur = next;
  }
  return out;
}
export const composeChain = (...chains: (RemapChain | null | undefined)[]): RemapChain => chains.flatMap((c) => c ?? []).filter((st) => st.d.length || st.i.length);
/** Per-lane maps composed in order. */
export const composeMaps = (...ms: (RemapMaps | null | undefined)[]): RemapMaps => {
  const out: RemapMaps = {};
  for (const m of ms) for (const [t, c] of Object.entries(m ?? {})) out[t] = composeChain(out[t], c);
  return out;
};
/**
 * The inverse of a remap (§8: undo inverts intents as intents): steps reversed, each step's deletions become gaps
 * inserted at their images and its inserted gaps become deletions of their images. `invertChain(c)` after `c` is the
 * identity on every time `c` didn't delete.
 */
export function invertChain(chain: RemapChain | null | undefined): RemapChain {
  return (chain ?? [])
    .slice()
    .reverse()
    .map((st) => {
      // image of an event point: content entirely deleted before it pulls it left, gaps inserted before it push it right
      const image = (x: number): number => {
        let dx = 0;
        for (const [a, b] of st.d) if (b <= x + EPS) dx -= b - a;
        for (const [p, len] of st.i) if (p < x - EPS) dx += len;
        return r6(x + dx);
      };
      const d: [number, number][] = st.i.map(([p, len], k) => {
        let x = image(p);
        for (let j = 0; j < k; j++) if (near(st.i[j]![0], p)) x = r6(x + st.i[j]![1]); // gaps at one point sit side by side
        return [x, r6(x + len)];
      });
      const i: [number, number][] = st.d.map(([a, b]) => [image(a), r6(b - a)]);
      return step(d, i);
    });
}
export const invertMaps = (m: RemapMaps | null | undefined): RemapMaps => Object.fromEntries(Object.entries(m ?? {}).map(([t, c]) => [t, invertChain(c)]));
export const isEmptyMap = (m: RemapMaps | null | undefined): boolean => !m || Object.values(m).every((c) => !c?.length);

/**
 * A remap op as the per-item sets it stands for, against `doc`: every item on a mapped lane whose extent maps cleanly
 * to a different place moves there. Deterministic, so every replica expands it the same way.
 */
export function expandRemap(schema: Schema, doc: Doc, op: Pick<RemapOp, "maps">): SetOp[] {
  const tl = schema.timeline;
  if (!tl) return [];
  const ops: SetOp[] = [];
  const items = (doc[tl.collection] as Rec[] | undefined) ?? EMPTY;
  const key = schema.collections[tl.collection]!.key;
  // record order is not canonical (swap-remove), so emit in id order: the ops are the same on every replica
  const hit: Rec[] = [];
  for (const it of items) if (op.maps[it[tl.lane] as string]) hit.push(it);
  hit.sort((x, y) => cmp(x[key], y[key]));
  for (const it of hit) {
    const s = it[tl.start] as number,
      e = it[tl.end] as number;
    if (typeof s !== "number" || typeof e !== "number") continue;
    const m = remapSpan(op.maps[it[tl.lane] as string], s, e);
    if (!m || (m[0] === s && m[1] === e)) continue;
    const id = it[key] as string;
    ops.push({ op: "set", path: [tl.collection, id, tl.start], value: m[0] }, { op: "set", path: [tl.collection, id, tl.end], value: m[1] });
  }
  return ops;
}

/**
 * Remaps implied by one side's ops when unambiguous (PLAN §7, L9): on a lane, every base item at or after the first
 * changed point was shifted (start and end by the same delta, trims untouched), removed, or end-trimmed at the
 * boundary; deltas only decrease (deleted ranges lie in gaps, removed items or trimmed tails) or are one uniform
 * positive shift (a gap inserted); and at least two items shifted, or the deleted space is explained by a removed item,
 * a trimmed tail or a closed gap.
 */
export function inferRemaps(schema: Schema, base: Doc, entries: readonly { path: Path; op: Op }[]): RemapMaps {
  const tl = schema.timeline;
  if (!tl) return {};
  const coll = tl.collection,
    key = schema.collections[coll]!.key,
    arr = (base[coll] as Rec[] | undefined) ?? EMPTY;
  const times = new Map<unknown, Record<string, Op>>(),
    removed = new Set<unknown>();
  const TF = new Set([tl.start, tl.end, tl.source, tl.sourceEnd, tl.speed, tl.lane]);
  let anyEnd = false;
  for (const e of entries) {
    const p = e.path,
      op = e.op;
    if (p[0] !== coll) continue;
    if (p.length === 2) {
      if (op.op === "remove") removed.add(p[1]);
      continue;
    }
    if (p.length !== 3 || !TF.has(p[2] as string)) continue; // other fields don't change placement
    if (p[2] === tl.end) anyEnd = true;
    let r = times.get(p[1]);
    if (!r) times.set(p[1], (r = {}));
    r[p[2] as string] = op;
  }
  if (!anyEnd) return {};
  // only lanes where some item's start and end both moved can hold a ripple
  const lanes = new Map<unknown, true>();
  for (const [id, r] of times) {
    if (!r[tl.start] || !r[tl.end]) continue;
    const i = posOf(arr, key, id);
    if (i >= 0) lanes.set(arr[i]![tl.lane], true);
  }
  const num = (op: Op | undefined): number | undefined => (op?.op === "set" && typeof op.value === "number" ? op.value : undefined);
  const out: RemapMaps = {};
  type Cls = { rec: Rec; k: "R" | "U" | "S" | "T" | "X"; d?: number };
  for (const lane of lanes.keys()) {
    const items = arr.filter((r) => r[tl.lane] === lane).sort((x, y) => (x[tl.start] as number) - (y[tl.start] as number) || cmp(x[key], y[key]));
    const cls: Cls[] = items.map((rec): Cls => {
      const id = rec[key];
      if (removed.has(id)) return { rec, k: "R" };
      const r = times.get(id);
      if (!r) return { rec, k: "U" };
      const others = Object.keys(r).filter((f) => f !== tl.start && f !== tl.end);
      const s = r[tl.start],
        e = r[tl.end];
      const sv = num(s),
        ev = num(e);
      if (!others.length && sv !== undefined && ev !== undefined) {
        const ds = r6(sv - (rec[tl.start] as number)),
          de = r6(ev - (rec[tl.end] as number));
        if (near(ds, de) && !near(ds, 0)) return { rec, k: "S", d: ds };
      }
      // end trim only: start and trims at the start untouched, end and trimEnd moved together
      const te = r[tl.sourceEnd];
      if (!s && ev !== undefined && others.every((f) => f === tl.sourceEnd)) {
        const de = r6(ev - (rec[tl.end] as number));
        if (de < 0 && (!te || near((te as { value: number }).value - (rec[tl.sourceEnd] as number), de * ((rec[tl.speed] as number) ?? 1)))) return { rec, k: "T", d: de };
      }
      return { rec, k: "X" };
    });
    const first = cls.findIndex((c) => c.k !== "U");
    if (first < 0 || !cls.some((c) => c.k === "S")) continue;
    let ok = true,
      cur = 0,
      shifted = 0,
      explained = false;
    const dels: ({ del: [number, number] } | { ins: [number, number] })[] = [];
    let pending: [number, number][] | null = null; // deleted space available before the next shifted item
    let lastEnd = -Infinity;
    const ups = new Set<number>();
    for (let n = 0; n < cls.length && ok; n++) {
      const c = cls[n]!,
        s = c.rec[tl.start] as number,
        e = c.rec[tl.end] as number;
      if (n < first) {
        lastEnd = Math.max(lastEnd, e);
        continue;
      }
      if (c.k === "U") {
        ok = cur === 0 && !dels.length;
        pending = null; // a removal followed by unmoved items was a plain delete, not a ripple
        lastEnd = Math.max(lastEnd, e);
        continue;
      }
      if (c.k === "X") ok = false;
      else if (c.k === "R") (pending ??= []).push([s, e]), (explained = true);
      else if (c.k === "T") {
        (pending ??= []).push([r6(e + c.d!), e]);
        explained = true;
        lastEnd = Math.max(lastEnd, r6(e + c.d!));
      } else {
        const d = c.d!;
        shifted++;
        if (d > 0) ups.add(d);
        if (near(d, cur)) {
          lastEnd = Math.max(lastEnd, e);
          continue;
        }
        if (d > cur) {
          ok = cur === 0 && !dels.length;
          if (ok) {
            cur = d;
            dels.push({ ins: [s, d] });
          }
          lastEnd = Math.max(lastEnd, e);
          continue;
        }
        // d < cur: cur - d seconds were deleted before s: removed items, trimmed tails, then the gap
        let need = r6(cur - d);
        const parts: [number, number][] = [];
        for (const [a, b] of (pending ?? []).sort((x, y) => x[0] - y[0])) {
          const take = Math.min(need, b - a);
          if (take > EPS) parts.push([a, r6(a + take)]), (need = r6(need - take));
        }
        if (need > EPS) {
          // the rest comes from the gap right before s
          const gapStart = Math.max(lastEnd, ...(pending ?? []).map(([, b]) => b));
          if (r6(s - need) >= gapStart - EPS) parts.push([r6(s - need), s]);
          else ok = false;
          if (s - gapStart > EPS && near(s - gapStart, need)) explained = true;
        }
        for (const p of parts) dels.push({ del: p });
        pending = null;
        cur = d;
        lastEnd = Math.max(lastEnd, e);
      }
    }
    if (!ok || pending?.length || ups.size > 1 || (ups.size && dels.some((x) => "del" in x))) continue;
    if (shifted < 2 && !explained) continue;
    const d = dels.flatMap((x) => ("del" in x ? [x.del] : [])),
      ins = dels.flatMap((x) => ("ins" in x ? [x.ins] : []));
    if (!d.length && !ins.length) continue;
    // the map must reproduce every shifted item
    const chain = [step(d, ins)];
    const ok2 = cls.every((c) => {
      if (c.k === "S") return near(remapSpan(chain, c.rec[tl.start] as number, c.rec[tl.end] as number)?.[0] ?? NaN, (c.rec[tl.start] as number) + c.d!);
      if (c.k === "U") return near(remapSpan(chain, c.rec[tl.start] as number, c.rec[tl.end] as number)?.[0] ?? NaN, c.rec[tl.start] as number);
      return true;
    });
    if (!ok2) continue;
    out[lane as string] = chain;
  }
  return out;
}
