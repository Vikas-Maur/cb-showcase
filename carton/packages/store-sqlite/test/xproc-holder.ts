// Holds carton.db's write lock for `ms` milliseconds, as a slow or stalled process would, after writing seq 1 of
// cut "main" in the store's own format. argv: <db path> <ms>
import { DatabaseSync } from "node:sqlite";
import { encodeKey } from "../src/key.ts";

const [file, ms] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("BEGIN IMMEDIATE");
db.prepare(`INSERT INTO changes(k, v) VALUES (?, ?)`).run(encodeKey(["main", 1]), JSON.stringify({ id: "holder" }));
process.stdout.write("locked\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
db.exec("COMMIT");
db.close();
