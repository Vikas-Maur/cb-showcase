// The demo HMAC AuthProvider and the in-process host + Transport.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmacAuth, createInProcessHost } from "../src/index.ts";
import { clip, doc, sqliteStorage, BRANCH } from "./helpers.ts";
import type { sync } from "@carton/core";

const claims = { account: "alice", credential: "alice/install-1", role: "editor" as const, projectId: "p1" };

test("HMAC auth: issue → verify round-trips; tampered, foreign, malformed and expired tokens verify to null", async () => {
  let now = 1_000_000;
  const auth = createHmacAuth({ secret: "a test secret of 32 bytes!!!!!!!", clock: () => now });
  const t = await auth.issue!({ ...claims, ttlMs: 60_000 });
  assert.deepEqual(await auth.verify(t), { ...claims, expires: 1_060_000 });
  assert.equal((await auth.verify(t))?.credential, "alice/install-1", "the same credential every time (a reconnect reclaims its rids)");
  const [body, sig] = t.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...claims, role: "owner", expires: 9e15 })).toString("base64url");
  assert.equal(await auth.verify(`${forgedBody}.${sig}`), null, "tampered claims");
  assert.equal(await auth.verify(`${body}.${sig!.slice(0, -2)}AA`), null, "tampered signature");
  const other = createHmacAuth({ secret: "another secret, also 32 bytes!!!" });
  assert.equal(await other.verify(t), null, "issued with another secret");
  for (const bad of ["", ".", "a.b.c", "!!.??", "x".repeat(10_000)]) assert.equal(await auth.verify(bad), null, `malformed ${bad.slice(0, 8)}`);
  now += 61_000;
  assert.equal(await auth.verify(t), null, "expired");
  assert.throws(() => createHmacAuth({ secret: "short" }), /16 bytes/);
});

test("in-process host: authenticated connect, ordered delivery, fan-out to subscribers, a dropped link closes both sides once", async () => {
  const auth = createHmacAuth({ secret: "a test secret of 32 bytes!!!!!!!" });
  const host = createInProcessHost({ storage: sqliteStorage(), auth });
  await host.sequencer.createBranch({ id: BRANCH, name: "main", forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 0 } }, { doc0: doc([clip("c0", 0, 5)]) as never });
  await assert.rejects(host.transport.connect(host.url, { token: "nope" }), /unauthorized/);
  const token = await auth.issue!({ ...claims, ttlMs: 60_000 });
  const a = await host.transport.connect(host.url, { token });
  const b = await host.transport.connect(host.url, { token: await auth.issue!({ ...claims, account: "bob", credential: "bob/i", ttlMs: 60_000 }) });
  const got: sync.ServerMessage[][] = [[], []];
  a.onMessage((m) => got[0]!.push(m));
  b.onMessage((m) => got[1]!.push(m));
  let closes = 0;
  a.onClose(() => closes++);
  const hello: sync.HelloMsg = { type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1 };
  a.send(hello);
  b.send(hello);
  const change = {
    id: "arid.1", hash: "h", author: { kind: "human" as const, id: "alice" }, branchId: BRANCH, base: { seq: 0, pending: [] },
    ops: [{ op: "set" as const, path: ["timelineItems", "c0", "name"], value: "x" }], intent: null, kinds: null, policy: "merge" as const, at: 0,
    paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [],
  };
  a.send({ type: "push", branchId: BRANCH, epoch: 1, changes: [change] });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got[0]!.map((m) => m.type), ["hello", "changes", "ack"], "the row before its ack");
  assert.deepEqual(got[1]!.map((m) => m.type), ["hello", "changes"]);
  host.drop();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(closes, 1);
  assert.equal(a.open, false);
  a.send(hello); // a no-op on a closed connection
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got[0]!.length, 3);
  assert.equal(host.connections, 0);
  await host.close();
});
