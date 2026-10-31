// SequencerHost, SequencerStorage, Transport and AuthProvider conformance (PLAN §3.1, §6.3). A new host or auth
// plug-in is accepted when it passes these, and nothing else changes. Owner: hosts-plugins.
//
// `storageChecks` is plain code with no test runner, so the same checks also run inside workerd against a Durable
// Object's `ctx.storage.sql` (server-cloudflare's test worker returns their results); `sequencerStorageSuite` wraps
// them in node:test.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AuthProvider, Role, SequencerHost, SequencerStorage, Transport } from "@carton/core/plugins";

export interface HostFixture {
  host: SequencerHost;
  transport: Transport;
  auth: AuthProvider;
  /** A token for a fresh device credential with the given role. */
  token(role?: "owner" | "editor" | "viewer"): Promise<string>;
  /** Restart the host on the same storage (hibernation / process restart). */
  restart?(): Promise<void>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ AuthProvider

export interface AuthSuiteOptions {
  /** Moves the provider's clock forward, for the expiry check. */
  advanceClock?: (ms: number) => void;
}

export function authProviderSuite(name: string, make: () => Promise<AuthProvider>, opts: AuthSuiteOptions = {}): void {
  describe(`AuthProvider conformance: ${name}`, () => {
    let auth: AuthProvider;
    before(async () => {
      auth = await make();
    });

    test("verify gives null, never an exception, for tokens it didn't issue", async () => {
      for (const t of ["", "x", "ct1.", "Bearer abc", "a".repeat(5000), "\u0000￿", "eyJhbGciOiJub25lIn0.e30.", null, undefined, 42])
        assert.equal(await auth.verify(t as unknown as string), null, String(t).slice(0, 16));
    });

    test("issue -> verify round-trips every claim, for every role", async (t) => {
      if (!auth.issue) return t.skip("no issue(): tokens come from outside (e.g. Cardboard accounts)");
      for (const role of ["owner", "editor", "commenter", "viewer"] as Role[]) {
        const claims = { account: "acct-1", credential: `acct-1/dev-${role}`, role, projectId: "proj-1", branches: ["b1", "b2"] };
        const before = Date.now();
        const ctx = await auth.verify(await auth.issue({ ...claims, ttlMs: 3600_000 }));
        assert.ok(ctx, role);
        assert.equal(ctx.account, claims.account);
        assert.equal(ctx.credential, claims.credential);
        assert.equal(ctx.role, role);
        assert.equal(ctx.projectId, claims.projectId);
        assert.deepEqual(ctx.branches, claims.branches);
        assert.ok(Math.abs(ctx.expires - (before + 3600_000)) < 120_000 || opts.advanceClock, "expires ≈ now + ttl");
      }
    });

    test("a token verifies to the same credential every time (a reconnect reclaims its replica ids)", async (t) => {
      if (!auth.issue) return t.skip("no issue()");
      const tok = await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 60_000 });
      const c1 = await auth.verify(tok), c2 = await auth.verify(tok);
      assert.equal(c1?.credential, "a/dev");
      assert.equal(c2?.credential, c1?.credential);
    });

    test("any change to a token makes it invalid", async (t) => {
      if (!auth.issue) return t.skip("no issue()");
      const tok = await auth.issue({ account: "a", credential: "a/dev", role: "viewer", projectId: "p", ttlMs: 60_000 });
      const flip = (i: number) => tok.slice(0, i) + (tok[i] === "A" ? "B" : "A") + tok.slice(i + 1);
      for (const i of [0, 5, Math.floor(tok.length / 3), Math.floor(tok.length / 2), tok.length - 2, tok.length - 1])
        if (flip(i) !== tok) assert.equal(await auth.verify(flip(i)), null, `flipped char ${i}`);
      assert.equal(await auth.verify(tok + "A"), null, "appended");
      assert.equal(await auth.verify(tok.slice(0, -1)), null, "truncated");
    });

    test("an expired token gives null", async (t) => {
      if (!auth.issue || !opts.advanceClock) return t.skip("needs issue() and a clock");
      const tok = await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "p", ttlMs: 1000 });
      assert.ok(await auth.verify(tok));
      opts.advanceClock(3600_000);
      assert.equal(await auth.verify(tok), null);
      opts.advanceClock(-3600_000);
    });
  });
}

// ------------------------------------------------------------------ SequencerStorage

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

export interface StorageSuiteOptions {
  /** Close and reopen the same storage (a restart); enables the durability check. */
  reopen?: (s: SequencerStorage) => Promise<SequencerStorage>;
  close?: (s: SequencerStorage) => Promise<void>;
}

export function sequencerStorageSuite(name: string, make: () => Promise<SequencerStorage>, opts: StorageSuiteOptions = {}): void {
  describe(`SequencerStorage conformance: ${name}`, () => {
    let s: SequencerStorage;
    before(async () => {
      s = await make();
    });
    after(async () => {
      await opts.close?.(s);
    });
    for (const c of storageChecks()) test(c.name, () => c.run(s));
    test("rows written by a committed transaction survive a restart", async (t) => {
      if (!opts.reopen) return t.skip("no reopen()");
      s.exec("CREATE TABLE sc_dur (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID");
      s.transaction(() => s.exec("INSERT INTO sc_dur (k, v) VALUES (?, ?)", 1, "kept"));
      try {
        s.transaction(() => {
          s.exec("INSERT INTO sc_dur (k, v) VALUES (?, ?)", 2, "dropped");
          throw new Error("rollback");
        });
      } catch {}
      s = await opts.reopen(s);
      const rows = s.exec("SELECT k, v FROM sc_dur ORDER BY k");
      assert.deepEqual(rows.map((r) => [num(r.k), r.v]), [[1, "kept"]]);
    });
  });
}

// ------------------------------------------------------------------ SequencerHost and Transport
// Filled in once `createSequencer` lands (sync-sequencer): hello/push/ack through the host, fan-out, presence
// relay, auth refusal, restart safety and rid binding across reconnects.

export function sequencerHostSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`SequencerHost conformance: ${name}`, () => {
    test("pending: needs createSequencer from @carton/server", (t) => t.todo("waiting for sync-sequencer"));
    void make;
  });
}

export function transportSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`Transport conformance: ${name}`, () => {
    test("pending: needs createSequencer from @carton/server", (t) => t.todo("waiting for sync-sequencer"));
    void make;
  });
}
