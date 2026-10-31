// In-memory Store plug-in (PLAN §3.1): tests, previews, and the web demo before IndexedDB. Keeps references to the
// values it is given (values are immutable once written, per the Store contract), so reads cost no copies.
// Owner: foundation-core.
import type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface MemoryStoreOptions {
  /** Shared backing maps, so several handles act like several processes on one store (tests). */
  shared?: MemoryStoreData;
}
export interface MemoryStoreData {
  readonly tables: Map<string, unknown>;
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): Store & { readonly data: MemoryStoreData } {
  return todo("createMemoryStore");
}

/** Key order of the Store contract: element-wise, number < string, shorter prefix first. */
export function compareKeys(a: StoreKey, b: StoreKey): number {
  return todo("compareKeys");
}

export type { Store, StoreCondition, StoreInfo, StoreKey, StoreRange, StoreWrite };
