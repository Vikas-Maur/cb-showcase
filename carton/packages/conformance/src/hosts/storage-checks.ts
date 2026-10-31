// SequencerStorage invariants as plain checks, with no test runner and no node:* import, so they also run inside
// workerd against a Durable Object's `ctx.storage.sql` (server-cloudflare's test worker returns their results).

import type { SequencerStorage } from "@carton/core/plugins";

export interface StorageCheck {
  name: string;
  run(s: SequencerStorage): void;
}

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));

// The invariants of `SequencerStorage`, as checks that need no test runner. Each runs on fresh tables of its own.
export function storageChecks(): StorageCheck[] {
  return [
    {
      name: "exec binds ? parameters and returns rows keyed by column name",
      run(s) {
        s.exec("CREATE TABLE sc_bind (k TEXT PRIMARY KEY, n INTEGER, f REAL, z TEXT) WITHOUT ROWID");
        s.exec("INSERT INTO sc_bind (k, n, f, z) VALUES (?, ?, ?, ?)", "a", 42, 1.5, null);
        s.exec("INSERT INTO sc_bind (k, n, f, z) VALUES (?, ?, ?, ?)", "b'; DROP TABLE sc_bind; --", -7, 0, "x");
        const rows = s.exec("SELECT k, n, f, z FROM sc_bind ORDER BY k");
        ok(rows.length === 2, `2 rows, got ${rows.length}`);
        ok(rows[0]!.k === "a" && num(rows[0]!.n) === 42 && rows[0]!.f === 1.5 && rows[0]!.z === null, `row 0 ${JSON.stringify(rows[0], (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
        ok(rows[1]!.k === "b'; DROP TABLE sc_bind; --" && num(rows[1]!.n) === -7, "parameters are bound, never spliced");
        ok(s.exec("SELECT count(*) AS c FROM sc_bind WHERE n > ?", 0).map((r) => num(r.c))[0] === 1, "aggregate with a binding");
        ok(s.exec("SELECT * FROM sc_bind WHERE k = ?", "nope").length === 0, "no rows is an empty array");
      },
    },
    {
      name: "BLOBs round-trip as bytes; large integers stay exact",
      run(s) {
        s.exec("CREATE TABLE sc_blob (k INTEGER PRIMARY KEY, b BLOB, big INTEGER) WITHOUT ROWID");
        const bytes = new Uint8Array(256).map((_, i) => i);
        s.exec("INSERT INTO sc_blob (k, b, big) VALUES (?, ?, ?)", 1, bytes, 2 ** 52 + 1);
        const [r] = s.exec("SELECT b, big FROM sc_blob WHERE k = ?", 1);
        const b = r!.b instanceof ArrayBuffer ? new Uint8Array(r!.b) : (r!.b as Uint8Array);
        ok(b instanceof Uint8Array && b.byteLength === 256 && b.every((x, i) => x === i), "blob bytes differ");
        ok(num(r!.big) === 2 ** 52 + 1, "2^52 + 1 survived");
      },
    },
    {
      name: "transaction commits as a unit, and a throw rolls back every statement it ran",
      run(s) {
        s.exec("CREATE TABLE sc_tx (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID");
        const r = s.transaction(() => {
          s.exec("INSERT INTO sc_tx (k, v) VALUES (?, ?)", 1, "one");
          s.exec("INSERT INTO sc_tx (k, v) VALUES (?, ?)", 2, "two");
          return "done";
        });
        ok(r === "done", "transaction returns fn's value");
        let threw = false;
        try {
          s.transaction(() => {
            s.exec("INSERT INTO sc_tx (k, v) VALUES (?, ?)", 3, "three");
            s.exec("UPDATE sc_tx SET v = ? WHERE k = ?", "changed", 1);
            throw new Error("boom");
          });
        } catch (e) {
          threw = (e as Error).message === "boom";
        }
        ok(threw, "the throw reaches the caller");
        const rows = s.exec("SELECT k, v FROM sc_tx ORDER BY k");
        ok(rows.length === 2 && rows[0]!.v === "one", `rolled back: ${JSON.stringify(rows)}`);
        let dupThrew = false;
        try {
          s.transaction(() => {
            s.exec("INSERT INTO sc_tx (k, v) VALUES (?, ?)", 4, "four");
            s.exec("INSERT INTO sc_tx (k, v) VALUES (?, ?)", 1, "dup"); // primary-key violation
          });
        } catch {
          dupThrew = true;
        }
        ok(dupThrew && s.exec("SELECT k FROM sc_tx WHERE k = ?", 4).length === 0, "a constraint error rolls back the whole transaction");
      },
    },
    {
      name: "WITHOUT ROWID primary-key range reads, ascending and descending with LIMIT (the §6.3 access paths)",
      run(s) {
        s.exec("CREATE TABLE sc_rng (branch TEXT, seq INTEGER, id TEXT, PRIMARY KEY (branch, seq)) WITHOUT ROWID");
        s.transaction(() => {
          for (let i = 1; i <= 50; i++) {
            s.exec("INSERT INTO sc_rng (branch, seq, id) VALUES (?, ?, ?)", "b", i, `c${i}`);
            s.exec("INSERT INTO sc_rng (branch, seq, id) VALUES (?, ?, ?)", "a", i, `x${i}`);
          }
        });
        const tail = s.exec("SELECT seq, id FROM sc_rng WHERE branch = ? AND seq > ? ORDER BY seq", "b", 45);
        ok(tail.map((r) => num(r.seq)).join() === "46,47,48,49,50", `tail ${tail.map((r) => r.seq)}`);
        const newest = s.exec("SELECT seq FROM sc_rng WHERE branch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", "b", 30);
        ok(newest.length === 1 && num(newest[0]!.seq) === 30, "descending LIMIT 1");
        const head = s.exec("SELECT seq FROM sc_rng WHERE branch = ? ORDER BY seq DESC LIMIT 1", "a");
        ok(num(head[0]!.seq) === 50, "head of a branch");
      },
    },
    {
      name: "stats, when offered, count rows written: 1 per row into a WITHOUT ROWID table (P5)",
      run(s) {
        if (!s.stats) return;
        s.exec("CREATE TABLE sc_rows (branch TEXT, seq INTEGER, v TEXT, PRIMARY KEY (branch, seq)) WITHOUT ROWID");
        const w0 = s.stats().rowsWritten;
        s.transaction(() => {
          s.exec("INSERT INTO sc_rows (branch, seq, v) VALUES (?, ?, ?)", "b", 1, "x");
        });
        const w1 = s.stats().rowsWritten;
        ok(w1 - w0 === 1, `one change row should be 1 row written, was ${w1 - w0}`);
        const r0 = s.stats().rowsRead;
        s.exec("SELECT v FROM sc_rows WHERE branch = ? AND seq = ?", "b", 1);
        ok(s.stats().rowsRead >= r0, "rowsRead never decreases");
      },
    },
  ];
}

