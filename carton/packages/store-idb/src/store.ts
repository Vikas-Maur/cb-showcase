// The Store plug-in on IndexedDB (PLAN §3.1, §15): one database per project, shared by every tab and worker of the
// origin.
//
// Every Carton table lives in one object store, `kv`, under the key `[table, ...key]`, with the value as JSON text. IndexedDB's own array-key order
// is the Store contract's key order (element-wise; numbers before strings; numbers numerically; strings by UTF-16 code
// units; a key before its extensions), so a range is one key range, and new tables never need a schema upgrade (which
// would have to wait for every other tab to close the database).
//
// `write` is one readwrite transaction: IndexedDB runs readwrite transactions on one object store one at a time across
// all tabs, so the conditions and the writes are the local sequencer's compare-and-swap. After a write commits, the
// other tabs hear about it on a BroadcastChannel and their `watch` listeners fire.
//
// Values are JSON text, not structured clones: in Chromium reading 10k changes back was faster as text plus
// JSON.parse than as clones, in every run of bench/exp-values.ts, and JSON gives exactly store-sqlite's value
// semantics (an `undefined` member dropped, -0 read back as 0).

import { canonical } from "@carton/core";
import type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite } from "@carton/core/plugins";
import { openDb, req, run } from "./idb.ts";

const KV = "kv";
const VERSION = 1;

export interface IdbStoreOptions {
  /** Default `carton:<projectId>`. */
  name?: string;
  /**
   * "relaxed" (default): a commit is in the OS once `write` resolves, as with store-sqlite's synchronous=NORMAL; a
   * power cut can lose the last writes, never tear one. "strict" flushes every commit to disk.
   */
  durability?: "relaxed" | "strict";
}

type Key = (string | number)[];

export class IdbStore implements Store {
  readonly info: StoreInfo = { kind: "idb", persistent: true, multiProcess: true };
  readonly name: string;
  readonly #db: IDBDatabase;
  readonly #durability: "relaxed" | "strict";
  readonly #listeners = new Set<(tables: readonly string[]) => void>();
  #channel: BroadcastChannel | null = null;
  #closed = false;

  private constructor(name: string, db: IDBDatabase, durability: "relaxed" | "strict") {
    this.name = name;
    this.#db = db;
    this.#durability = durability;
    // Another tab upgrading or deleting the database waits for every connection to close; never make it wait.
    db.onversionchange = () => void this.close();
    // The browser closed it (storage cleared, disk error): later calls say so instead of failing obscurely.
    db.onclose = () => void this.close();
    // Every handle announces its writes, whether or not it watches; listeners hear the other tabs'.
    if (typeof BroadcastChannel !== "undefined") {
      this.#channel = new BroadcastChannel(name);
      this.#channel.onmessage = (ev: MessageEvent<{ tables: string[] }>) => notify(this.#listeners, ev.data.tables);
      // In Node (a fake IndexedDB in tests) an open channel would keep the process alive.
      (this.#channel as { unref?: () => void }).unref?.();
    }
  }

  static async open(projectId: string, opts: IdbStoreOptions = {}): Promise<IdbStore> {
    const name = opts.name ?? `carton:${projectId}`;
    const db = await openDb(name, VERSION, (d, old) => {
      if (old < 1) d.createObjectStore(KV);
    });
    return new IdbStore(name, db, opts.durability ?? "relaxed");
  }

  async get<T = unknown>(table: string, key: StoreKey): Promise<T | undefined> {
    const k = idbKey(table, key);
    const v = await run(this.#open(), KV, "readonly", (tx) => req(tx.objectStore(KV).get(k) as IDBRequest<string | undefined>));
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  async range<T = unknown>(table: string, r: StoreRange = {}): Promise<{ key: StoreKey; value: T }[]> {
    const range = keyRange(table, r);
    // A limit counts whole rows: 2.7 reads 2, and anything below 1 reads none. (A count of 0 would mean "all" to
    // IndexedDB's getAll, so it never reaches it.)
    const limit = r.limit === undefined ? undefined : Math.floor(r.limit);
    if (!range || (limit !== undefined && !(limit >= 1))) return [];
    return run(this.#open(), KV, "readonly", async (tx) => {
      const s = tx.objectStore(KV);
      if (!r.reverse) {
        // Two bulk reads in one transaction see the same state, so keys and values line up.
        const [keys, values] = await Promise.all([req(s.getAllKeys(range, limit)), req(s.getAll(range, limit))]);
        const out = new Array<{ key: StoreKey; value: T }>(keys.length);
        for (let i = 0; i < keys.length; i++) out[i] = { key: (keys[i] as Key).slice(1), value: JSON.parse(values[i] as string) as T };
        return out;
      }
      const out: { key: StoreKey; value: T }[] = [];
      let c = await req(s.openCursor(range, "prev"));
      while (c && (limit === undefined || out.length < limit)) {
        out.push({ key: (c.primaryKey as Key).slice(1), value: JSON.parse(c.value as string) as T });
        c.continue();
        c = await req(c.request as IDBRequest<IDBCursorWithValue | null>);
      }
      return out;
    });
  }

  async write(writes: readonly StoreWrite[], conditions: readonly StoreCondition[] = []): Promise<boolean> {
    const conds = conditions.map((c) => ({ k: idbKey(c.table, c.key), expect: c.expect }));
    // Serialized before the transaction opens, so it stays short.
    const ops = writes.map((w) => ({ k: idbKey(w.table, w.key), v: w.value === undefined ? undefined : json(w.value) }));
    const ok = await run(
      this.#open(),
      KV,
      "readwrite",
      async (tx) => {
        const s = tx.objectStore(KV);
        if (conds.length) {
          const found = await Promise.all(conds.map((c) => req(s.get(c.k))));
          for (let i = 0; i < conds.length; i++) if (!holds(found[i], conds[i].expect)) return false;
        }
        for (const w of ops) {
          if (w.v === undefined) s.delete(w.k);
          else s.put(w.v, w.k);
        }
        return true;
      },
      this.#durability,
    );
    if (ok) {
      const tables = [...new Set(writes.map((w) => w.table))];
      notify(this.#listeners, tables);
      this.#channel?.postMessage({ tables });
    }
    return ok;
  }

  /** Fires after this handle's writes, and after every other tab's (heard on the BroadcastChannel). */
  watch(listener: (tables: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#channel?.close();
    this.#channel = null;
    this.#db.close();
  }

  #open(): IDBDatabase {
    if (this.#closed) throw new Error(`IndexedDB ${this.name} is closed (another tab may have upgraded it: reload)`);
    return this.#db;
  }
}

export function openIdbStore(projectId: string, opts: IdbStoreOptions = {}): Promise<IdbStore> {
  return IdbStore.open(projectId, opts);
}

/** Delete a project's database (tests, "remove from this browser"). Waits for other tabs to close it. */
export function deleteIdbStore(projectId: string, opts: { name?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(opts.name ?? `carton:${projectId}`);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function idbKey(table: string, key: StoreKey): Key {
  if (typeof table !== "string" || table.length === 0) throw new TypeError("store: a table name is a non-empty string");
  const out: Key = [table];
  for (const el of key) {
    if (typeof el === "number") {
      // IndexedDB would accept ±Infinity; the contract allows finite numbers only. -0 and 0 are one key.
      if (!Number.isFinite(el)) throw new TypeError(`store key: ${el} is not a finite number`);
      out.push(el === 0 ? 0 : el);
    } else if (typeof el === "string") out.push(el);
    else throw new TypeError(`store key: elements are strings or numbers, got ${typeof el}`);
  }
  return out;
}

// The range of `[table, ...]` keys a StoreRange asks for, or null when it is empty. `[]` is above every string and
// number, so `[table, ...prefix, []]` is above every extension of the prefix.
function keyRange(table: string, r: StoreRange): IDBKeyRange | null {
  const base = r.prefix ? idbKey(table, r.prefix) : [table];
  let lo: Key = base, loOpen = false;
  let hi: unknown[] = [...base, []], hiOpen = true;
  const raise = (k: StoreKey, open: boolean) => {
    const c = idbKey(table, k);
    const d = indexedDB.cmp(c, lo);
    if (d > 0) [lo, loOpen] = [c, open];
    else if (d === 0) loOpen ||= open;
  };
  const lower = (k: StoreKey, open: boolean) => {
    const c = idbKey(table, k);
    const d = indexedDB.cmp(c, hi);
    if (d < 0) [hi, hiOpen] = [c, open];
    else if (d === 0) hiOpen ||= open;
  };
  if (r.gt) raise(r.gt, true);
  if (r.gte) raise(r.gte, false);
  if (r.lt) lower(r.lt, true);
  if (r.lte) lower(r.lte, false);
  const d = indexedDB.cmp(lo, hi);
  if (d > 0 || (d === 0 && (loOpen || hiOpen))) return null;
  return IDBKeyRange.bound(lo, hi, loOpen, hiOpen);
}

function holds(found: unknown, expect: StoreCondition["expect"]): boolean {
  if (expect === "absent") return found === undefined;
  if (expect === "present") return found !== undefined;
  return found !== undefined && canonical(JSON.parse(found as string)) === canonical(expect.equals);
}

// The batch is committed whatever a listener does: a throwing listener is reported, never turned into a failed write.
function notify(listeners: Set<(tables: readonly string[]) => void>, tables: readonly string[]): void {
  for (const l of listeners) {
    try {
      l(tables);
    } catch (e) {
      (globalThis as { reportError?: (e: unknown) => void }).reportError?.(e) ?? console.error("carton store: a watch listener threw", e);
    }
  }
}

function json(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) throw new TypeError("store: value is not JSON");
  return s;
}
