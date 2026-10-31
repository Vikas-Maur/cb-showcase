// The Store conformance suite on store-sqlite. Second handles are separate connections, as `cb` and the worker have;
// real separate processes are in xproc.test.ts.
import { after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { storeSuite } from "@carton/conformance";
import { openSqliteStore, type SqliteStore } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const dir = scratch("conf");
let n = 0;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

storeSuite("sqlite", () => openSqliteStore(path.join(dir, `p${++n}`, ".carton", "carton.db")), {
  second: (first) => openSqliteStore((first as SqliteStore).path),
  reopen: async (first) => {
    await first.close();
    return openSqliteStore((first as SqliteStore).path);
  },
});
