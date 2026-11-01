// Assertions for suites that also run inside a browser page (no node:assert there).

export class CheckFailed extends Error {
  override readonly name = "CheckFailed";
}

export function ok(v: unknown, msg = "expected a truthy value"): asserts v {
  if (!v) throw new CheckFailed(msg);
}

export function eq<T>(actual: T, expected: T, msg = ""): void {
  if (!Object.is(actual, expected)) throw new CheckFailed(`${msg ? msg + ": " : ""}expected ${show(expected)}, got ${show(actual)}`);
}

export function deepEq(actual: unknown, expected: unknown, msg = ""): void {
  const where = diff(actual, expected, "$");
  if (where) throw new CheckFailed(`${msg ? msg + ": " : ""}${where}\n  expected ${show(expected)}\n  got      ${show(actual)}`);
}

export async function rejects(p: Promise<unknown> | (() => Promise<unknown>), msg = "expected a rejection"): Promise<unknown> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e;
  }
  throw new CheckFailed(msg);
}

function diff(a: unknown, b: unknown, at: string): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `at ${at}: ${show(a)} !== ${show(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `at ${at}: array vs object`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return `at ${at}: length ${a.length} !== ${bb.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], bb[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const bk = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ak.join("\u0000") !== bk.join("\u0000")) return `at ${at}: keys ${show(ak)} !== ${show(bk)}`;
  for (const k of ak) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(v);
  }
}
