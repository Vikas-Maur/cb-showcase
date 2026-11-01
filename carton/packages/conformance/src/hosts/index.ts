// SequencerHost, SequencerStorage, Transport and AuthProvider conformance (PLAN §3.1, §6.3). A new host or auth
// plug-in is accepted when it passes these, and nothing else changes. Owner: hosts-plugins.
//
// `storageChecks` (storage-checks.ts) is plain code with no test runner, so the same checks also run inside workerd
// against a Durable Object's `ctx.storage.sql`; `sequencerStorageSuite` wraps them in node:test.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AuthProvider, BlobStore, Role, SequencerHost, SequencerStorage, Transport } from "@carton/core/plugins";

export interface HostFixture {
  host: SequencerHost;
  transport: Transport;
  auth: AuthProvider;
  /** A token for a fresh device credential with the given role. */
  token(role?: "owner" | "editor" | "viewer"): Promise<string>;
  /** Within this, a connection that goes silent (no close, no keepalive, no pong) is dropped and its presence leaves
   * its peers. The suite's silent-client test runs only when it is set; a host's default is minutes. */
  presenceTimeoutMs?: number;
  /** Drop the host's memory but keep its connections, as a Durable Object's hibernation does: what the host needs
   * after it (who a connection shows, for its leaves) must come back from what it kept with each socket. */
  hibernate?(): Promise<void>;
  /** Restart the host on the same storage (hibernation / process restart). */
  restart?(): Promise<void>;
  close(): Promise<void>;
  /** A token for this exact credential (a reconnect of the same device), or for another project. */
  tokenFor?(o: { credential: string; account?: string; role?: Role; projectId?: string }): Promise<string>;
  /** Rows the host's storage has read and written so far (P5 cost accounting), when it can tell. */
  rows?(): Promise<{ rowsRead: number; rowsWritten: number }>;
  /** The BlobStore a client of this host passes as `blobs`, so messages over 1 MiB travel as envelopes. */
  clientBlobs?(token: string): BlobStore;
  /** The size of the big change the live suite sends as an envelope (default 33 MiB, over every WebSocket cap; a host
   * with a smaller message cap, such as a Durable Object's, says what it carries). */
  bigMessageBytes?: number;
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
      // Flip the low bits of a character's base64url value: at the end of a base64 run those bits can be unused, so
      // a lax decoder maps the changed token to the same bytes (a token it never issued, which must still be refused).
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const flip = (i: number, bit: number) => {
        const v = B64.indexOf(tok[i]!);
        const c = v < 0 ? (tok[i] === "A" ? "B" : "A") : B64[v ^ bit]!;
        return tok.slice(0, i) + c + tok.slice(i + 1);
      };
      for (const i of [0, 5, Math.floor(tok.length / 3), Math.floor(tok.length / 2), tok.length - 2, tok.length - 1])
        for (const bit of [1, 2, 32]) assert.equal(await auth.verify(flip(i, bit)), null, `flipped bit ${bit} of char ${i}`);
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

import { storageChecks, type StorageCheck } from "./storage-checks.ts";
export { storageChecks, type StorageCheck };
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));

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

export { sequencerHostSuite, transportSuite, HOST_SUITE_DOC } from "./host-suite.ts";
export { httpApiSuite, type HttpFixture } from "./http-suite.ts";
export { helloAtSchema } from "./schema.ts";
export { rawWebSocket, type RawConnection } from "./raw-ws.ts";
export { liveSyncSuite } from "./live-suite.ts";
