// Fractional-index keys for sequences (PLAN §4.1, M4). Keys are base-62 digit strings compared as JS strings.
// keyBetween never returns a key ending in "0" and never a proper prefix of `b`, so appending a suffix keeps a key
// inside (a, b). A single insert gets a key between its neighbours plus a 4-character suffix derived from its id; an
// insert right after an element the same author created nests inside that element's sub-interval, so one author's run
// stays contiguous whether it arrives as one change or one change per click.
import { POS } from "../types.ts";
import type { Rec } from "../types.ts";
import { sha256Raw } from "./hash.ts";
import { lcs } from "./lcs.ts";

const D62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Sequence keys longer than this trigger a rebalance (R4-05). */
export const MAX_KEY = 64;

function mid(a: string, b: string | null): string {
  if (b != null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = a ? D62.indexOf(a[0]!) : 0,
    db = b != null ? D62.indexOf(b[0]!) : 62;
  if (db - da > 1) return D62[(da + db) >> 1]!;
  return D62[da]! + mid(a.slice(1), null);
}
/** A key strictly between `a` and `b` (null: unbounded). */
export function keyBetween(a: string | null, b: string | null): string {
  a = a ?? "";
  if (b != null && !(a < b)) throw new Error(`keyBetween: ${a} !< ${b}`);
  return mid(a, b ?? null);
}
/** The smallest key above every extension of `k` (null: none). */
export function keyUp(k: string): string | null {
  let i = k.length - 1;
  while (i >= 0 && k[i] === "z") i--;
  return i < 0 ? null : k.slice(0, i) + D62[D62.indexOf(k[i]!) + 1];
}
// 4 pseudo-random base-62 chars derived from the element id (ids are random), last char 1..y
function suffix(id: unknown): string {
  const h = sha256Raw(String(id));
  let s = "";
  for (let i = 0; i < 3; i++) s += D62[h[i]! % 62];
  return s + D62[1 + (h[3]! % 60)];
}
/** Key for element `id` between `lo` and `hi`; `nest`: `lo` was created by the same author, so extend it (M4). */
export function keyAfter(lo: string | null | undefined, hi: string | null | undefined, id: unknown, nest = false): string {
  if (nest && lo != null && lo !== "") {
    const u = keyUp(lo);
    const b = hi != null && (u == null || hi < u) ? hi : u;
    return keyBetween(lo, b);
  }
  return keyBetween(lo ?? "", hi ?? null) + suffix(id);
}
/** `n` evenly spread keys between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  const m = keyBetween(a, b);
  const left = keysBetween(a, m, (n - 1) >> 1);
  return [...left, m, ...keysBetween(m, b, n - 1 - left.length)];
}
/** Sequence order: by `#pos`, ties by id. */
export const byPos =
  (key: string) =>
  (x: Rec, y: Rec): number => {
    const a = x[POS] as string,
      b = y[POS] as string;
    if (a < b) return -1;
    if (a > b) return 1;
    const i = x[key] as string,
      j = y[key] as string;
    return i < j ? -1 : i > j ? 1 : 0;
  };

/**
 * Keys for a sequence from a host save that only knows array order: LCS move recovery keeps unmoved elements' keys,
 * moved and new ones are keyed from their neighbours (runs nest under their first key), and a key past MAX_KEY
 * rebalances the whole sequence (order-preserving). `own(id)`: the author created that element (M4).
 */
export function assignKeys(oldElems: readonly Rec[], newIds: readonly string[], key = "id", own: (id: string) => boolean = () => false): { keys: Map<string, string>; rebalanced: boolean } {
  const oldKey = new Map(oldElems.map((e) => [e[key] as string, e[POS] as string]));
  const inNew = new Set(newIds);
  const oldOrder = [...oldElems].sort(byPos(key)).map((e) => e[key] as string);
  const oldCommon = oldOrder.filter((id) => inNew.has(id));
  const commonNew = newIds.filter((id) => oldKey.has(id));
  const keep = new Set(lcs(oldCommon, commonNew).map(([i]) => oldCommon[i]!));
  const out = new Map<string, string>();
  let i = 0;
  while (i < newIds.length) {
    if (keep.has(newIds[i]!)) {
      out.set(newIds[i]!, oldKey.get(newIds[i]!)!);
      i++;
      continue;
    }
    let j = i;
    while (j < newIds.length && !keep.has(newIds[j]!)) j++;
    const lo = i > 0 ? out.get(newIds[i - 1]!)! : null;
    const hi = j < newIds.length ? oldKey.get(newIds[j]!)! : null;
    const first = keyAfter(lo, hi, newIds[i], i > 0 && own(newIds[i - 1]!));
    out.set(newIds[i]!, first);
    const u = keyUp(first);
    const bound = hi != null && (u == null || hi < u) ? hi : u;
    const rest = keysBetween(first, bound, j - i - 1);
    for (let k = i + 1; k < j; k++) out.set(newIds[k]!, rest[k - i - 1]!);
    i = j;
  }
  let long = false;
  for (const k of out.values()) if (k.length > MAX_KEY) long = true;
  if (long) {
    const ks = keysBetween("", null, newIds.length);
    newIds.forEach((id, n) => out.set(id, ks[n]!));
  }
  return { keys: out, rebalanced: long };
}
