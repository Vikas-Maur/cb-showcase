// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the Store suite against your own client-side Store (here store-sqlite stands in for it, plus
// store-memory as the non-persistent, single-process case).
import { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeSuite } from "@carton/conformance";
import { openSqliteStore, type SqliteStore } from "@carton/store-sqlite"; // ← your Store's factory
import { createMemoryStore } from "@carton/store-memory";

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "store-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

// A persistent, multi-process store must give `second` (another process's handle on the same data) and `reopen`
// (close and open the same data); without them the cross-handle and reopen cases fail on purpose.
storeSuite("my-store", () => openSqliteStore(join(dir, `p${++n}`, "carton.db")), {
  second: (first) => openSqliteStore((first as SqliteStore).path),
  reopen: async (first) => {
    await first.close();
    return openSqliteStore((first as SqliteStore).path);
  },
});

// An in-memory, single-process store needs neither.
storeSuite("my-memory-store", async () => createMemoryStore());
