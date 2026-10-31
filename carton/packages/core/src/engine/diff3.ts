// Line diff3 for `text` fields (PLAN §4.1, §7): edits to different lines merge; overlapping or adjacent line edits
// are hunks (a card), as in diff3 and git.
import type { TextHunk } from "../types.ts";
import { lcs } from "./lcs.ts";

export function diff3(o: string, a: string, b: string): { text: string; hunks: TextHunk[] } {
  const O = o.split("\n"),
    A = a.split("\n"),
    B = b.split("\n");
  const ma = new Map(lcs(O, A)),
    mb = new Map(lcs(O, B));
  const out: string[] = [],
    hunks: TextHunk[] = [];
  let io = 0,
    ia = 0,
    ib = 0;
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  const flush = (ko: number, ka: number, kb: number) => {
    const oc = O.slice(io, ko),
      ac = A.slice(ia, ka),
      bc = B.slice(ib, kb);
    if (eq(ac, oc)) out.push(...bc);
    else if (eq(bc, oc) || eq(ac, bc)) out.push(...ac);
    else hunks.push({ at: out.length, base: oc.join("\n"), ours: ac.join("\n"), theirs: bc.join("\n") }), out.push(...ac);
  };
  for (let k = 0; k < O.length; k++) {
    if (!ma.has(k) || !mb.has(k)) continue;
    const ka = ma.get(k)!,
      kb = mb.get(k)!;
    if (ka < ia || kb < ib) continue;
    if (k > io || ka > ia || kb > ib) flush(k, ka, kb);
    out.push(O[k]!);
    io = k + 1;
    ia = ka + 1;
    ib = kb + 1;
  }
  if (io < O.length || ia < A.length || ib < B.length) flush(O.length, A.length, B.length);
  return { text: out.join("\n"), hunks };
}
