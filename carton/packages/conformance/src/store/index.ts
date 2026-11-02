// Store plug-in conformance (PLAN §3.1): the invariants on `Store` in @carton/core/plugins: atomic conditional
// batches, key order, range bounds and limits, JSON round trip, persistence, and (when a second handle is given)
// cross-process CAS with no lost append. Owner: stores.
//
//   storeSuite("sqlite", () => openSqliteStore(file()), { second: (s) => openSqliteStore(s.path), reopen: … });
//
// The cases themselves (`suite.ts`) use no Node API; store-idb runs them in headless Chromium.
import { test } from "node:test";
import type { Store } from "@carton/core/plugins";
import { storeCases, runStoreCase, type StoreSuiteOptions } from "./suite.ts";

export * from "./suite.ts";

/** Register every Store case as a node:test test. */
export function storeSuite(name: string, make: () => Promise<Store>, opts: StoreSuiteOptions = {}): void {
  for (const c of storeCases) test(`store conformance (${name}): ${c.name}`, () => runStoreCase(c, make, opts));
}
