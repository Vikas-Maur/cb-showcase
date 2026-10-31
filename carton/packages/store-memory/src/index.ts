// In-memory Store plug-in (PLAN §3.1): tests, previews, and the web demo before IndexedDB. Keeps references to the
// values it is given (values are immutable once written, per the Store contract), so reads cost no copies. Each
// table is a sorted key array (binary search; appends at the end, the common case, are O(1)) plus a map for gets.
// Several handles can share one backing store (`shared`), which acts like several processes on one carton.db.
// Owner: foundation-core.
import { canonical } from "@carton/core";
import type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite } from "@carton/core/plugins";

export interface MemoryStoreData {
  readonly tables: Map<string, Table>;
  readonly listeners: Set<(tables: readonly string[]) => void>;
}
export interface MemoryStoreOptions {
  /** Shared backing data, so several handles act like several processes on one store (tests). */
  shared?: MemoryStoreData;
}

interface Entry {
  key: StoreKey;
  value: unknown;
}
class Table {
  readonly keys: StoreKey[] = [];
  readonly byKey = new Map<string, Entry>();
}

const rank = (x: string | number): number => (typeof x === "number" ? 0 : 1);
/** Key order of the Store contract: element-wise, number < string, numbers numerically, then shorter first. */
function validKey(key: StoreKey): void {
  for (const el of key) {
    if (typeof el === "number" ? !Number.isFinite(el) : typeof el !== "string") throw new TypeError(`store key: ${String(el)} is not a string or a finite number`);
  }
}

export function compareKeys(a: StoreKey, b: StoreKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!,
      y = b[i]!;
    if (x === y) continue;
    const rx = rank(x),
      ry = rank(y);
    if (rx !== ry) return rx - ry;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.length - b.length;
}
const enc = (k: StoreKey): string => JSON.stringify(k);
const hasPrefix = (k: StoreKey, p: StoreKey): boolean => {
  if (k.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (k[i] !== p[i]) return false;
  return true;
};
/** First index whose key is >= k (or > k when `strict`). */
function bound(keys: readonly StoreKey[], k: StoreKey, strict: boolean): number {
  let lo = 0,
    hi = keys.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    const c = compareKeys(keys[m]!, k);
    if (c < 0 || (strict && c === 0)) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export function createMemoryData(): MemoryStoreData {
  return { tables: new Map(), listeners: new Set() };
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): Store & { readonly data: MemoryStoreData } {
  const data = opts.shared ?? createMemoryData();
  let closed = false;
  const table = (name: string, create: boolean): Table | undefined => {
    let t = data.tables.get(name);
    if (!t && create) data.tables.set(name, (t = new Table()));
    return t;
  };
  const check = () => {
    if (closed) throw new Error("store-memory: closed");
  };
  const info: StoreInfo = { kind: "memory", persistent: false, multiProcess: false };
  const holds = (c: StoreCondition): boolean => {
    const e = table(c.table, false)?.byKey.get(enc(c.key));
    if (c.expect === "absent") return !e;
    if (c.expect === "present") return !!e;
    return !!e && canonical(e.value) === canonical(c.expect.equals);
  };
  return {
    info,
    data,
    async get<T>(name: string, key: StoreKey): Promise<T | undefined> {
      check();
      return table(name, false)?.byKey.get(enc(key))?.value as T | undefined;
    },
    async range<T>(name: string, r: StoreRange = {}): Promise<{ key: StoreKey; value: T }[]> {
      check();
      const t = table(name, false);
      if (!t) return [];
      const keys = t.keys;
      let lo = 0,
        hi = keys.length;
      if (r.prefix) {
        // a prefix's keys are contiguous, starting at the prefix itself: find where they end
        lo = bound(keys, r.prefix, false);
        let a = lo,
          b = keys.length;
        while (a < b) {
          const m = (a + b) >> 1;
          if (hasPrefix(keys[m]!, r.prefix)) a = m + 1;
          else b = m;
        }
        hi = a;
      }
      if (r.gte) lo = Math.max(lo, bound(keys, r.gte, false));
      if (r.gt) lo = Math.max(lo, bound(keys, r.gt, true));
      if (r.lt) hi = Math.min(hi, bound(keys, r.lt, false));
      if (r.lte) hi = Math.min(hi, bound(keys, r.lte, true));
      const out: { key: StoreKey; value: T }[] = [];
      const limit = r.limit ?? Infinity;
      if (!r.reverse) for (let i = lo; i < hi && out.length < limit; i++) out.push({ key: keys[i]!, value: t.byKey.get(enc(keys[i]!))!.value as T });
      else for (let i = hi - 1; i >= lo && out.length < limit; i--) out.push({ key: keys[i]!, value: t.byKey.get(enc(keys[i]!))!.value as T });
      return out;
    },
    async write(writes: readonly StoreWrite[], conditions: readonly StoreCondition[] = []): Promise<boolean> {
      check();
      // Refuse keys the other stores can't store (NaN would also break the sort), before anything is applied.
      for (const w of writes) validKey(w.key);
      for (const c of conditions) validKey(c.key);
      // check and apply in one synchronous step: nothing else can run in between (one event loop)
      for (const c of conditions) if (!holds(c)) return false;
      const touched = new Set<string>();
      for (const w of writes) {
        const t = table(w.table, true)!;
        const k = enc(w.key);
        const e = t.byKey.get(k);
        if (w.value === undefined) {
          if (!e) continue;
          t.byKey.delete(k);
          const i = bound(t.keys, w.key, false);
          t.keys.splice(i, 1);
        } else if (e) e.value = w.value;
        else {
          const key = Object.freeze([...w.key]);
          t.byKey.set(k, { key, value: w.value });
          const last = t.keys[t.keys.length - 1];
          if (!last || compareKeys(last, key) < 0) t.keys.push(key);
          else t.keys.splice(bound(t.keys, key, false), 0, key);
        }
        touched.add(w.table);
      }
      if (touched.size) {
        const tables = [...touched];
        // The batch is applied whatever a listener does: a throwing listener is reported, not turned into a failure.
        for (const l of data.listeners) {
          try {
            l(tables);
          } catch (e) {
            console.error("carton store: a watch listener threw", e);
          }
        }
      }
      return true;
    },
    watch(listener) {
      data.listeners.add(listener);
      return () => void data.listeners.delete(listener);
    },
    async close() {
      closed = true;
    },
  };
}

export type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite };
