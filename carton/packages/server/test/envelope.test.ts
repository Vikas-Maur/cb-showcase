// The sequencer's side of the oversized-message envelope: a client's envelope is opened, checked and deleted before
// its message is handled; a bad one is answered with an error that makes the client reconnect; an oversized server
// message is uploaded once for a whole fan-out and goes as an envelope only to connections whose hello said
// `envelopes`; the order of messages on a connection is kept; maintain() sweeps old envelope blobs.
import test from "node:test";
import assert from "node:assert/strict";
import { sync, type Change, type Op } from "@carton/core";
import { BRANCH, clip, declare, doc, fakeConn, memoryBlobs, world, type FakeConn } from "./helpers.ts";

const KB = 1024;
const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
const hello = (envelopes: boolean) => ({ type: "hello" as const, branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1, ...(envelopes ? { envelopes: true } : {}) });
let N = 0;
function change(conn: FakeConn, ops: Op[], base = 0): Change {
  return { id: `${conn.auth.credential.replaceAll("/", "")}.${++N}`, hash: "h", author: { kind: "human", id: conn.auth.account }, branchId: BRANCH, base: { seq: base, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, ...declare(d0, ops, null) };
}
const rename = (id: string, name: string): Op => ({ op: "set", path: ["timelineItems", id, "name"], value: name });

test("envelope (server): a client's oversized push is opened, handled and its blob deleted; the fan-out goes once, as an envelope to readers and inline to the rest", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, envelopeBytes: 4 * KB });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), old = fakeConn("carol/1");
  await seq.handle(a, hello(true));
  await seq.handle(b, hello(true));
  await seq.handle(old, hello(false));
  const ch = change(a, [rename("c0", "é".repeat(5 * KB))]);
  const big = sync.oversized({ type: "push", branchId: BRANCH, epoch: 1, changes: [ch] }, 4 * KB)!;
  const env = await sync.seal(big, blobs, (sha) => sync.clientEnvelopeKey(sha, Date.now()));
  for (const c of [a, b, old]) c.inbox.length = 0;
  await seq.handle(a, env);
  assert.equal(blobs.map.has(env.ref.key), false, "read once, then deleted");
  assert.equal(seq.stats.envelopesIn, 1);
  assert.deepEqual(a.inbox.map((m) => m.type), ["blob", "ack"], "the row (as an envelope) before the ack");
  const [ea, eb] = [a.inbox[0] as sync.EnvelopeMsg, b.inbox[0] as sync.EnvelopeMsg];
  assert.equal(ea.ref.key, eb.ref.key, "one upload for the whole fan-out");
  assert.equal(seq.stats.envelopesOut, 1);
  const row = (await sync.unseal(eb.ref, blobs, { from: "server", maxBytes: 1 << 20 })) as sync.ChangesMsg;
  assert.equal(row.type, "changes");
  assert.equal(row.rows[0]!.id, ch.id);
  assert.deepEqual(old.inbox.map((m) => m.type), ["changes"], "a client that can't read envelopes gets it inline");
});

test("envelope (server): small messages after an oversized one on the same connection wait for its upload", async () => {
  const blobs = memoryBlobs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => (args[0].startsWith("messages/") ? (await gate, blobs.put(...args)) : blobs.put(...args)) };
  const { seq } = await world(d0, { blobs: slow, envelopeBytes: 4 * KB });
  const a = fakeConn("alice/1");
  await seq.handle(a, hello(true));
  a.inbox.length = 0;
  const done = seq.handle(a, { type: "push", branchId: BRANCH, epoch: 1, changes: [change(a, [rename("c0", "x".repeat(8 * KB))]), change(a, [rename("c1", "small")])] });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.inbox.length, 0, "nothing overtakes the row being uploaded (and handle() hasn't resolved)");
  release();
  await done;
  assert.deepEqual(a.inbox.map((m) => m.type), ["blob", "ack", "changes", "ack"]);
});

test("envelope (server): a bad envelope is answered with a reconnect error; an oversize one is dropped unread; neither is handled", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, envelopeBytes: 4 * KB, maxEnvelopeBytes: 64 * KB });
  const a = fakeConn("alice/1");
  await seq.handle(a, hello(true));
  const ch = change(a, [rename("c0", "y".repeat(8 * KB))]);
  const env = await sync.seal(sync.oversized({ type: "push", branchId: BRANCH, epoch: 1, changes: [ch] }, 4 * KB)!, blobs, (sha) => sync.clientEnvelopeKey(sha, Date.now()));
  const errors = async (m: sync.EnvelopeMsg) => {
    a.inbox.length = 0;
    await seq.handle(a, m);
    return a.inbox.map((x) => (x.type === "error" ? `${x.reason}${x.reconnect ? " +reconnect" : ""}` : x.type));
  };
  assert.match((await errors({ type: "blob", ref: { ...env.ref, key: `changes/${BRANCH}/${env.ref.sha256}` } }))[0]!, /isn't an envelope's \+reconnect/);
  assert.match((await errors({ type: "blob", ref: { ...env.ref, size: env.ref.size - 1 } }))[0]!, /bytes, not .* \+reconnect/);
  const sizeOnly = await errors({ type: "blob", ref: { ...env.ref, size: 65 * KB } });
  assert.match(sizeOnly[0]!, /the limit is 65536\)$/, "too big: no reconnect (resending can't help)");
  assert.equal(blobs.map.has(env.ref.key), false, "and its blob is deleted unread");
  assert.equal(seq.tables.head(BRANCH), 0, "nothing was handled");
  const { seq: noBlobs } = await world(d0);
  const c = fakeConn("carol/1");
  await noBlobs.handle(c, env);
  assert.match((c.inbox[0] as sync.ErrorMsg).reason, /no blob store/);
});

test("envelope (server): maintain() deletes envelope blobs past their keep and nothing else", async () => {
  const blobs = memoryBlobs();
  const H = 3_600_000;
  const now = 100 * H;
  const { seq } = await world(d0, { blobs, clock: () => now });
  const sha = "a".repeat(64);
  const keep = [sync.serverEnvelopeKey(sha, 99 * H), sync.clientEnvelopeKey(sha, 80 * H), `changes/${BRANCH}/${sha}`];
  const gone = [sync.serverEnvelopeKey(sha, 90 * H), sync.clientEnvelopeKey(sha, 70 * H)];
  for (const k of [...keep, ...gone]) await blobs.put(k, new Uint8Array([1]));
  const r = await seq.maintain();
  assert.equal(r.swept, 2);
  for (const k of keep) assert.ok(blobs.map.has(k), k);
  for (const k of gone) assert.ok(!blobs.map.has(k), k);
});

test("presence over 64 KiB is dropped, not relayed (a client can't make the 10–20 Hz relay costly); under it is relayed", async () => {
  const { seq } = await world(d0, { blobs: memoryBlobs() });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  await seq.handle(a, hello(true));
  await seq.handle(b, hello(true));
  b.inbox.length = 0;
  const actor = { kind: "human" as const, id: "alice" };
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { selection: ["x".repeat(65 * KB)] } });
  assert.equal(b.inbox.length, 0, "dropped");
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: 3, selection: ["c0"] } });
  assert.deepEqual(b.inbox.map((m) => m.type), ["presence"]);
  assert.equal(seq.stats.envelopesOut, 0, "presence is never sized for an envelope");
});

test("envelope (server): an oversized history reply goes as an envelope to a client that reads them (Stage F round 5)", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, envelopeBytes: 4 * KB });
  const a = fakeConn("alice/1");
  await seq.handle(a, hello(true));
  const ch = change(a, [rename("c0", "é".repeat(5 * KB))]);
  const big = sync.oversized({ type: "push", branchId: BRANCH, epoch: 1, changes: [ch] }, 4 * KB)!;
  await seq.handle(a, await sync.seal(big, blobs, (sha) => sync.clientEnvelopeKey(sha, Date.now())));
  assert.equal(a.last("ack")?.id, ch.id);
  a.inbox.length = 0;
  await seq.handle(a, { type: "history", branchId: BRANCH, req: 7, after: 0, upTo: 1 });
  assert.deepEqual(a.inbox.map((m) => m.type), ["blob"], "the reply, over the threshold, inline");
  const reply = (await sync.unseal((a.inbox[0] as sync.EnvelopeMsg).ref, blobs, { from: "server", maxBytes: 1 << 20 })) as sync.HistoryReplyMsg;
  assert.equal(reply.type, "history");
  assert.equal(reply.req, 7);
  assert.equal(reply.rows[0]!.id, ch.id);
});
