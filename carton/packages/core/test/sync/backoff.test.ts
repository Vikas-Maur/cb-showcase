// Reconnecting backs off (cf-lab): a host that refuses (a Workers daily limit, a room that errors) used to get a new
// connection attempt from every client every 500 ms, each one a billed Worker request. Now each failure in a row
// doubles the wait up to maxBackoffMs, with jitter, and a connection the host answers starts over.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { ReplicaQueue, SyncClient, type ClientMessage, type ServerMessage, type Timers } from "../../src/sync/index.ts";
import type { TransportConnection } from "../../src/plugins.ts";
import type { Doc } from "../../src/types.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, timelineItems: { key: "id" } } });
const d0 = { tracks: [], timelineItems: [] } as unknown as Doc;

class Conn implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  private onCl: ((why: string) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(m);
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose(f: (why: string) => void) {
    this.onCl.push(f);
  }
  close() {
    this.drop("closed");
  }
  drop(why: string) {
    if (!this.open) return;
    this.open = false;
    for (const f of this.onCl.splice(0)) f(why);
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(m);
  }
}

/** Timers that record every delay asked for and fire only when told to. */
function recordingTimers() {
  const delays: number[] = [];
  const due: (() => void)[] = [];
  const timers: Timers = {
    setTimeout(fn, ms) {
      delays.push(ms);
      due.push(fn);
      return due.length;
    },
    clearTimeout() {},
  };
  return { timers, delays, fireAll: () => due.splice(0).forEach((f) => f()) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const queue = () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  return q;
};

test("refused connects back off exponentially, with jitter, up to maxBackoffMs", async () => {
  const rt = recordingTimers();
  let attempts = 0;
  const client = new SyncClient({ queue: queue(), branchId: "b", schemaVersion: 1, timers: rt.timers, random: () => 1, connect: async () => (attempts++, Promise.reject(Object.assign(new Error("refused"), { code: "unreachable" }))) }).start();
  for (let i = 0; i < 10; i++) {
    await tick();
    rt.fireAll();
  }
  await tick();
  client.stop();
  // the first retry as before; then random 1 = the whole delay: 1000, 2000 … capped at 15 s
  assert.deepEqual(rt.delays.slice(0, 8), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.ok(attempts >= 8);
});

test("jitter spreads the wait over its second half", async () => {
  const rt = recordingTimers();
  const client = new SyncClient({ queue: queue(), branchId: "b", schemaVersion: 1, timers: rt.timers, random: () => 0, backoffMs: 1000, maxBackoffMs: 4000, connect: async () => Promise.reject(new Error("refused")) }).start();
  for (let i = 0; i < 4; i++) {
    await tick();
    rt.fireAll();
  }
  client.stop();
  // the first retry is backoffMs exactly; then half of 2000, of 4000, of 4000 (the cap)
  assert.deepEqual(rt.delays.slice(0, 4), [1000, 1000, 2000, 2000]);
});

test("a connection the host answers resets the backoff; one that drops before the answer doesn't", async () => {
  const rt = recordingTimers();
  const conns: Conn[] = [];
  let refuse = 3;
  const client = new SyncClient({
    queue: queue(),
    branchId: "b",
    schemaVersion: 1,
    timers: rt.timers,
    random: () => 1,
    connect: async () => {
      if (refuse-- > 0) throw new Error("refused");
      const c = new Conn();
      conns.push(c);
      return c;
    },
  }).start();
  for (let i = 0; i < 4; i++) {
    await tick();
    rt.fireAll();
  }
  await tick();
  assert.deepEqual(rt.delays, [500, 1000, 2000], "three failures in a row");
  assert.equal(conns.length, 1);
  // open, but dropped before the host answered the hello: still failing, so the next wait keeps growing
  conns[0]!.drop("reset");
  assert.equal(rt.delays.at(-1), 4000);
  rt.fireAll();
  await tick();
  conns[1]!.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  assert.ok(client.online);
  // answered: a later drop retries at the first step again
  conns[1]!.drop("blip");
  assert.equal(rt.delays.at(-1), 500);
  client.stop();
});

test("a refused session backs off up to unauthorizedBackoffMs, longer than an unreachable host", async () => {
  const rt = recordingTimers();
  const client = new SyncClient({ queue: queue(), branchId: "b", schemaVersion: 1, timers: rt.timers, random: () => 1, connect: async () => Promise.reject(Object.assign(new Error("refused"), { code: "unauthorized" })) }).start();
  for (let i = 0; i < 14; i++) {
    await tick();
    rt.fireAll();
  }
  client.stop();
  assert.deepEqual(rt.delays.slice(0, 12), [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
});

test("maxBackoffMs = backoffMs keeps a fixed retry", async () => {
  const rt = recordingTimers();
  const client = new SyncClient({ queue: queue(), branchId: "b", schemaVersion: 1, timers: rt.timers, random: () => 1, backoffMs: 500, maxBackoffMs: 500, connect: async () => Promise.reject(new Error("refused")) }).start();
  for (let i = 0; i < 4; i++) {
    await tick();
    rt.fireAll();
  }
  client.stop();
  assert.deepEqual(rt.delays.slice(0, 4), [500, 500, 500, 500]);
});
