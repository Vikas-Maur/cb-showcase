// A second machine gets a shared project: a copy of the first machine's carton.db without its local tables (pending
// queue, pins, notices, views, ephemeral data, sync lease, path map), made with store-sqlite's `exportCopy` while the
// first machine's app keeps running. (Core has no "join from the server" yet; this is the full-history `.cbproj` copy,
// the closest real path. Routed as a gap in e2e-qa's notes.)
//   clone <from carton.db> <to carton.db>
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteStore } from "@carton/store-sqlite";

// core's LOCAL_TABLES (core/src/history/common.ts)
const LOCAL = ["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"];
const [from, to] = process.argv.slice(2);
mkdirSync(dirname(to!), { recursive: true });
const store = await openSqliteStore(from!);
try {
  await store.exportCopy(to!, LOCAL);
} finally {
  await store.close();
}
process.stdout.write(JSON.stringify({ ok: true }) + "\n");
