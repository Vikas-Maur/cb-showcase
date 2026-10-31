// Small IndexedDB helpers.
//
// The local sequencer's compare-and-swap in a browser is one readwrite transaction: IndexedDB runs readwrite
// transactions with overlapping scopes one at a time, across every tab and worker of the origin, so "read the head,
// check, write head + 1" inside one transaction cannot lose a write (the browser's BEGIN IMMEDIATE).
//
// A transaction commits by itself once no request is pending at the end of a task. Awaiting a promise that a
// request's success event resolves keeps it alive (the continuation runs as a microtask of that event); awaiting
// anything else (a timer, fetch, crypto.subtle) lets it commit early, and the next request throws
// TransactionInactiveError. So the function passed to `run` awaits only `req(...)` results.

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = (ev) => upgrade(r.result, ev.oldVersion, r.transaction!);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    // Another tab holds an older version open and did not close it on `versionchange`.
    r.onblocked = () => reject(new Error(`IndexedDB ${name}: upgrade blocked by another tab`));
  });
}

/**
 * Run `fn` in one transaction and resolve once it has committed. If `fn` throws or rejects, the transaction is
 * aborted and nothing it wrote is kept.
 */
export function run<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T> | T, durability: "relaxed" | "strict" | "default" = "relaxed"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode, { durability });
    } catch (e) {
      reject(e);
      return;
    }
    let out: T;
    let failed: unknown = null;
    let settled = false;
    tx.oncomplete = () => {
      if (failed) reject(failed);
      // The transaction committed while `fn` was still awaiting something that was not a request: what it wrote
      // after that point was never part of it. A programming error, never a silent half-write.
      else if (!settled) reject(new Error("IndexedDB transaction committed before its function finished (it awaited a non-IndexedDB promise)"));
      else resolve(out);
    };
    tx.onabort = () => reject(failed ?? tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = (ev) => ev.preventDefault(); // handled by onabort, once
    Promise.resolve()
      .then(() => fn(tx))
      .then(
        (v) => {
          settled = true;
          out = v;
          // Ask for the commit now rather than at the end of the task: saves a turn of the event loop per commit.
          try { tx.commit(); } catch { /* already committing */ }
        },
        (e) => {
          settled = true;
          failed = e;
          try { tx.abort(); } catch { /* already finished */ }
        },
      );
  });
}

/** The last [key, value] in `range` (or the whole store), or null. One cursor step, no array. */
export async function last<V>(source: IDBObjectStore | IDBIndex, range?: IDBKeyRange): Promise<[IDBValidKey, V] | null> {
  const c = await req(source.openCursor(range, "prev"));
  return c ? [c.primaryKey, c.value as V] : null;
}

/** The last key in `range`, without reading its value. */
export async function lastKey(source: IDBObjectStore, range?: IDBKeyRange): Promise<IDBValidKey | null> {
  const c = await req(source.openKeyCursor(range, "prev"));
  return c ? c.primaryKey : null;
}
