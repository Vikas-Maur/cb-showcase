// The Store conformance suite on store-memory. store-sqlite and store-idb run it in their own tests (idb in Chromium).
import { test } from "node:test";
import { createMemoryStore } from "@carton/store-memory";
import { storeSuite } from "../src/store/index.ts";

let ready = true;
try {
  createMemoryStore().close();
} catch (e) {
  if (!/not implemented/.test(String(e))) throw e;
  ready = false;
}
if (ready) {
  storeSuite("memory", async () => createMemoryStore(), {
    second: async (first) => createMemoryStore({ shared: (first as ReturnType<typeof createMemoryStore>).data }),
  });
} else test("store conformance (memory)", { skip: "store-memory is not implemented yet (foundation-core)" }, () => {});
