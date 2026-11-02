// JSON utilities every hash and comparison in Carton goes through.
import type { Path, PathKey } from "../types.ts";

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Structural equality of JSON values; `undefined` object members count as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  let n = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    n++;
    if (!deepEqual(x[k], y[k])) return false;
  }
  for (const k in y) if (y[k] !== undefined) n--;
  return n === 0;
}

/** One path segment escaped: `~` → `~0`, `/` → `~1`. */
export const escapeSegment = (s: unknown): string => {
  const t = String(s);
  return t.includes("/") || t.includes("~") ? t.replaceAll("~", "~0").replaceAll("/", "~1") : t;
};
/** The inverse of `escapeSegment`. */
export const unescapeSegment = (s: string): string => (s.includes("~") ? s.replaceAll("~1", "/").replaceAll("~0", "~") : s);
/** Path -> `a/b/c` with `~` and `/` escaped (`~0`, `~1`). */
export const pathKey = (path: Path): PathKey => path.map(escapeSegment).join("/");
/** The keys of every proper prefix of `path`, shortest first (built incrementally: no re-joining). */
export function prefixKeys(path: Path): PathKey[] {
  const out = new Array<PathKey>(path.length);
  let acc = "";
  for (let i = 0; i < path.length; i++) out[i] = acc = i ? acc + "/" + escapeSegment(path[i]) : escapeSegment(path[i]);
  return out;
}

const KEYS = new Map<string, string>();
/** `"key":` for an object key, cached (keys repeat across records). */
export function keyPrefix(k: string): string {
  let kk = KEYS.get(k);
  if (kk === undefined) KEYS.set(k, (kk = JSON.stringify(k) + ":"));
  return kk;
}
const PLAIN = /^[^"\\\u0000-\u001f\ud800-\udfff]*$/;
/**
 * Canonical JSON: keys sorted, `undefined` members dropped, `undefined` in arrays and non-finite numbers as `null`.
 * Byte-identical to `JSON.stringify` of a key-sorted copy. Every hash in Carton is over this form.
 */
export function canonical(v: unknown): string {
  switch (typeof v) {
    case "number":
      return Number.isFinite(v) ? "" + v : "null";
    case "string":
      return v.length < 256 && PLAIN.test(v) ? '"' + v + '"' : JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "undefined":
      return "null";
  }
  if (v === null) return "null";
  if (Array.isArray(v)) {
    let s = "[";
    for (let i = 0; i < v.length; i++) s += (i ? "," : "") + canonical(v[i]);
    return s + "]";
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  for (let i = 1; i < keys.length; i++)
    if (keys[i - 1]! > keys[i]!) {
      keys.sort();
      break;
    }
  let s = "{",
    first = true;
  for (const k of keys) {
    const x = o[k];
    if (x === undefined) continue;
    s += (first ? "" : ",") + keyPrefix(k) + canonical(x);
    first = false;
  }
  return s + "}";
}

export const cmp = (a: unknown, b: unknown): number => ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0);
export const EMPTY: readonly never[] = Object.freeze([]);
