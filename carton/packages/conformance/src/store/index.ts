// Store plug-in conformance (PLAN §3.1): the invariants on `Store` in @carton/core/plugins: atomic conditional
// batches, key order, range bounds and limits, JSON round trip, and (when a second handle is given) cross-process
// CAS with no lost append. Owner: stores.
import type { Store } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface StoreSuiteOptions {
  /** A second, independent handle on the same store (another process for SQLite), for the CAS tests. */
  second?: (first: Store) => Promise<Store>;
}

export function storeSuite(name: string, make: () => Promise<Store>, opts: StoreSuiteOptions = {}): void {
  todo("storeSuite");
}
