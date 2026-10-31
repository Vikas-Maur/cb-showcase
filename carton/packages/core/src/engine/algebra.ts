// The time-group edit algebra (PLAN §4.1). Edit kinds against a base clip (s, e, a = trimStart, b = trimEnd, v = speed):
//   move Δ: s, e +Δ;  trim-in δ: s +δ, a +δ·v;  trim-out δ: e +δ, b +δ·v;  slip σ: a, b +σ;
//   speed v': v -> v', e = s + (b − a)/v' (the duration follows).
// The four time deltas have three degrees of freedom, so a delta pattern can have several minimal decompositions
// (fewest kinds). Recorded kinds win; for unrecorded edits every minimal decomposition is tried, and the result
// composes only if all of them compose to the same values (R4-06).
import type { AlgebraMerge, GroupAlgebra, TimeEdit, TimelineConfig } from "../schema.ts";
import type { Rec } from "../types.ts";
import { canonical } from "./json.ts";
import { EPS, near, r6 } from "./remap.ts";

type Kind = keyof TimeEdit;
const KINDS: Kind[] = ["move", "tin", "tout", "slip", "speed"];
type Rule = "eq" | "c" | "x";
const TABLE: Partial<Record<Kind, Partial<Record<Kind, Rule>>>> = {
  move: { move: "eq", tin: "c", tout: "c", slip: "c", speed: "c" },
  tin: { tin: "eq", tout: "c", slip: "c", speed: "x" },
  tout: { tout: "eq", slip: "c", speed: "x" },
  slip: { slip: "eq", speed: "x" },
  speed: { speed: "eq" },
};
const rule = (a: Kind, b: Kind): Rule | undefined => TABLE[a]?.[b] ?? TABLE[b]?.[a];

/** A clip's time values: start, end, trimStart, trimEnd, speed. */
export type TimeVals = {
  s: number;
  e: number;
  a: number;
  b: number;
  v: number;
};

export interface TimeAlgebra extends GroupAlgebra {
  get(r: Rec): TimeVals;
  put(vals: TimeVals): Record<string, number>;
  apply(base: TimeVals, k: TimeEdit): TimeVals;
  decompositions(base: TimeVals, x: TimeVals): TimeEdit[];
  merge(base: Rec, ours: Rec, theirs: Rec, recordedOurs?: TimeEdit, recordedTheirs?: TimeEdit): AlgebraMerge & { vals?: TimeVals };
  readonly fields: Pick<TimelineConfig, "start" | "end" | "source" | "sourceEnd" | "speed">;
}

export function timeAlgebra(f: Pick<TimelineConfig, "start" | "end" | "source" | "sourceEnd" | "speed">): TimeAlgebra {
  const get = (r: Rec): TimeVals => ({ s: r[f.start] as number, e: r[f.end] as number, a: (r[f.source] as number) ?? 0, b: (r[f.sourceEnd] as number) ?? 0, v: (r[f.speed] as number) ?? 1 });
  const apply = (B: TimeVals, k: TimeEdit): TimeVals => {
    const s = r6(B.s + (k.move ?? 0) + (k.tin ?? 0));
    if (k.speed !== undefined) return { s, e: r6(s + (B.b - B.a) / k.speed), a: B.a, b: B.b, v: k.speed };
    return { s, e: r6(B.e + (k.move ?? 0) + (k.tout ?? 0)), a: r6(B.a + (k.tin ?? 0) * B.v + (k.slip ?? 0)), b: r6(B.b + (k.tout ?? 0) * B.v + (k.slip ?? 0)), v: B.v };
  };
  const same = (x: TimeVals, y: TimeVals): boolean => near(x.s, y.s) && near(x.e, y.e) && near(x.a, y.a) && near(x.b, y.b) && near(x.v, y.v);
  const clean = (k: TimeEdit): TimeEdit => {
    const out: TimeEdit = {};
    for (const n of Object.keys(k) as Kind[]) {
      const v = k[n];
      if (n === "speed" ? v !== undefined : !near(v as number, 0)) out[n] = r6(v as number);
    }
    return out;
  };
  function decompositions(B: TimeVals, X: TimeVals): TimeEdit[] {
    if (!near(X.v, B.v)) {
      if (!near(X.a, B.a) || !near(X.b, B.b)) return [];
      const k = clean({ move: X.s - B.s, speed: X.v });
      return same(apply(B, k), X) ? [k] : [];
    }
    const Ds = X.s - B.s,
      De = X.e - B.e,
      Da = X.a - B.a,
      Db = X.b - B.b,
      v = B.v;
    if (!near(Db - Da, (De - Ds) * v)) return [];
    const cands = [
      { move: 0, tin: Ds, tout: De, slip: Da - Ds * v },
      { move: Ds, tin: 0, tout: De - Ds, slip: Da },
      { move: De, tin: Ds - De, tout: 0, slip: Db },
      { move: Ds - Da / v, tin: Da / v, tout: De - Ds + Da / v, slip: 0 },
    ].map(clean);
    const n = (k: TimeEdit) => Object.keys(k).length;
    const min = Math.min(...cands.map(n));
    const out: TimeEdit[] = [];
    for (const k of cands) if (n(k) === min && !out.some((o) => canonical(o) === canonical(k))) out.push(k);
    return out;
  }
  function compose(B: TimeVals, x: TimeEdit, y: TimeEdit): TimeVals | null {
    const k: TimeEdit = {};
    for (const a of Object.keys(x) as Kind[])
      for (const b of Object.keys(y) as Kind[]) {
        const r = rule(a, b);
        if (r === "x") return null;
        if (r === "eq" && !near(x[a]!, y[b]!)) return null;
      }
    for (const n of KINDS) {
      if (x[n] !== undefined && y[n] !== undefined) k[n] = x[n];
      else if (x[n] !== undefined || y[n] !== undefined) k[n] = n === "speed" ? (x[n] ?? y[n]) : (x[n] ?? 0) + (y[n] ?? 0);
    }
    return apply(B, k);
  }
  function merge(baseRec: Rec, oRec: Rec, tRec: Rec, recO?: TimeEdit, recT?: TimeEdit): AlgebraMerge & { vals?: TimeVals } {
    const B = get(baseRec),
      O = get(oRec),
      T = get(tRec);
    if (same(O, T)) return { ok: true, vals: O, how: "equal" };
    const dec = (X: TimeVals, rec?: TimeEdit): TimeEdit[] => (rec && same(apply(B, rec), X) ? [clean(rec)] : decompositions(B, X));
    const dO = dec(O, recO),
      dT = dec(T, recT);
    if (!dO.length || !dT.length) return { ok: false, reason: "unclassified" };
    let res: TimeVals | null = null;
    for (const x of dO)
      for (const y of dT) {
        const r = compose(B, x, y);
        if (!r) return { ok: false, reason: "same kind or incompatible", kinds: [dO, dT] };
        if (res && !same(res, r)) return { ok: false, reason: "ambiguous", kinds: [dO, dT] };
        res = r;
      }
    const v = res!;
    if (!(v.e > v.s + EPS && v.b > v.a + EPS && v.s >= -EPS && v.a >= -EPS)) return { ok: false, reason: "invalid", vals: v };
    return { ok: true, vals: v, how: "composed", kinds: [dO, dT] };
  }
  const put = (vals: TimeVals): Record<string, number> => ({ [f.start]: vals.s, [f.end]: vals.e, [f.source]: vals.a, [f.sourceEnd]: vals.b, [f.speed]: vals.v });
  return {
    get,
    merge,
    decompositions: decompositions as GroupAlgebra["decompositions"] & TimeAlgebra["decompositions"],
    put,
    apply,
    fields: f,
  };
}
