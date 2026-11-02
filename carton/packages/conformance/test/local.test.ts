// Runs the local suite: the lease on store-memory (two handles on shared data act as two processes) and on
// store-sqlite (two connections to one carton.db), and the identity invariants on @carton/local's sources.
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import { leaseSuite, identitySuite } from "../src/local/index.ts";

leaseSuite("store-memory", async () => createMemoryStore(), { second: async (s) => createMemoryStore({ shared: (s as any).data }) });
const dir = join(process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "local-cli", "test"));
mkdirSync(dir, { recursive: true });
leaseSuite("store-sqlite", async () => openSqliteStore(join(mkdtempSync(join(dir, "lease-conf-")), "carton.db")), { second: async (s) => openSqliteStore((s as any).path) });
identitySuite("@carton/local defaults");
