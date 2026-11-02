// A host's write limit (its daily write cap, `error`/`adoptError` code `write-limit`; cf review finding 2), on the
// client's side over a scripted connection: what it holds back, for how long, and what it sends when the wait ends.
// (The whole path, with the real sequencer and cap, is server-cloudflare's write-cap-sync.test.ts.)
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { hashDoc } from "../../src/engine/index.ts";
import { ReplicaQueue, SyncClient, type ClientMessage, type ServerMessage, type SyncEvent, type Timers } from "../../src/sync/index.ts";
import type { TransportConnection } from "../../src/plugins.ts";
import type { Doc, Op } from "../../src/types.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, timelineItems: { key: "id" } } });
const d0 = { tracks: [], timelineItems: [{ id: "c0" }] } as unknown as Doc;
const B = "b";
const me = { kind: "human" as const, id: "me" };
const set = (v: unknown): Op => ({ op: "set", path: ["timelineItems", "c0", "name"], value: v });
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

class Scripted implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(structuredClone(m));
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose() {}
  close() {
    this.open = false;
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(structuredClone(m));
  }
  of<T extends ClientMessage["type"]>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ClientMessage, { type: T }>[];
  }
}
function heldTimers() {
  const due = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const timers: Timers = { setTimeout: (fn, ms) => (due.set(++n, { fn, ms }), n), clearTimeout: (h) => void due.delete(h as number) };
  return { timers, pending: () => [...due.values()].map((d) => d.ms), fire: (ms: number) => [...due].forEach(([h, d]) => d.ms === ms && (due.delete(h), d.fn())) };
}

test("hello says the client waits out a write limit", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Scripted();
  const client = new SyncClient({ queue: q, branchId: B, schemaVersion: 1, connect: async () => conn, defer: (fn) => queueMicrotask(fn) }).start();
  await tick();
  assert.equal(conn.of("hello")[0]!.writeLimit, true);
  client.stop();
});

test("a push's write limit holds the queue for the host's wait plus jitter, then sends it again in a new epoch", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Scripted(), t = heldTimers(), events: SyncEvent[] = [];
  let now = 1_000_000;
  const client = new SyncClient({ queue: q, branchId: B, schemaVersion: 1, connect: async () => conn, timers: t.timers, clock: () => now, random: () => 0.5, defer: (fn) => queueMicrotask(fn), onEvent: (e) => events.push(e) }).start();
  await tick();
  conn.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [] });
  q.commit(B, { id: "r1.1", author: me, ops: [set("big")], at: 0 });
  await tick();
  const first = conn.of("push");
  assert.equal(first.length, 1);
  conn.feed({ type: "error", code: "write-limit", reason: "server words", retryAt: 0, retryAfterMs: 100_000, branchId: B, epoch: first[0]!.epoch });
  q.commit(B, { id: "r1.2", author: me, ops: [set("later")], at: 0 });
  await tick();
  assert.equal(conn.of("push").length, 1, "nothing pushed while held");
  // the host's relative wait (its clock's retryAt is ignored), plus random 0.5 × a tenth of it
  assert.deepEqual(t.pending(), [105_000]);
  const notice = events.find((e) => e.type === "error" && e.code === "write-limit") as Extract<SyncEvent, { type: "error" }>;
  assert.equal(notice.until, now + 105_000);
  assert.match(notice.error, /^The server's daily limit is reached\. Your edits are kept and will sync after /);
  now += 105_000;
  t.fire(105_000);
  await tick();
  const again = conn.of("push").slice(1);
  assert.deepEqual(again.flatMap((p) => p.changes.map((c) => c.id)), ["r1.1", "r1.2"], "both, in order");
  assert.ok(again.every((p) => p.epoch > first[0]!.epoch), "in a new epoch");
  client.stop();
});

test("a write limit with no epoch (nothing of this client's dropped) is told, and holds nothing", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Scripted(), t = heldTimers(), events: SyncEvent[] = [];
  const client = new SyncClient({ queue: q, branchId: B, schemaVersion: 1, connect: async () => conn, timers: t.timers, random: () => 0, defer: (fn) => queueMicrotask(fn), onEvent: (e) => events.push(e) }).start();
  await tick();
  conn.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [] });
  conn.feed({ type: "error", code: "write-limit", reason: "server words", retryAt: 0, retryAfterMs: 100_000 });
  q.commit(B, { id: "r1.1", author: me, ops: [set("x")], at: 0 });
  await tick();
  assert.equal(conn.of("push").length, 1, "pushed: nothing held");
  assert.deepEqual(t.pending(), []);
  assert.ok(events.some((e) => e.type === "error" && e.code === "write-limit"));
  client.stop();
});

test("a hand-off refused by a write limit uploads again only after the wait, asking first whether the server has it", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "handingOff", n: 0, stateHash: hashDoc(d0, schema) } }, d0);
  const conn = new Scripted(), t = heldTimers();
  const client = new SyncClient({
    queue: q,
    branchId: B,
    schemaVersion: 1,
    connect: async () => conn,
    timers: t.timers,
    random: () => 0,
    defer: (fn) => queueMicrotask(fn),
    adoptPayload: () => ({ rows: [], rec: { id: B, name: "main", forkOf: null, owner: "me", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: d0, closure: [] }),
  }).start();
  await tick();
  conn.feed({ type: "status", branchId: B, adopted: false, adoptKey: null, since: null, head: 0 });
  await tick();
  assert.equal(conn.of("adopt").length, 1);
  conn.feed({ type: "adoptError", branchId: B, reason: "server words", code: "write-limit", retryAt: 0, retryAfterMs: 30_000 });
  conn.feed({ type: "status", branchId: B, adopted: false, adoptKey: null, since: null, head: 0 }); // a late answer to an earlier ask
  await tick();
  assert.equal(conn.of("adopt").length, 1, "not uploaded again while held");
  assert.equal(conn.of("branchStatus").length, 1);
  t.fire(30_000);
  await tick();
  assert.equal(conn.of("branchStatus").length, 2, "asks again when the wait ends");
  conn.feed({ type: "status", branchId: B, adopted: false, adoptKey: null, since: null, head: 0 });
  await tick();
  assert.equal(conn.of("adopt").length, 2);
  client.stop();
});
