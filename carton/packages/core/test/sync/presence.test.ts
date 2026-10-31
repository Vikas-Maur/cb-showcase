// The sync client's presence throttle (contract commit by hosts-plugins): at most PRESENCE_PER_SEC updates a second,
// coalesced, so the latest state always arrives and a 60 Hz drag costs the relay 10 messages a second.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { ReplicaQueue, SyncClient, PRESENCE_PER_SEC, type ClientMessage, type ServerMessage, type Timers } from "../../src/sync/index.ts";
import type { TransportConnection } from "../../src/plugins.ts";
import type { Doc } from "../../src/types.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, timelineItems: { key: "id" } } });
const d0 = { tracks: [], timelineItems: [] } as unknown as Doc;

class Conn implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(m);
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose() {}
  close() {
    this.open = false;
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(m);
  }
}

// virtual time: timers fire only when the test advances the clock
function virtualTime() {
  let now = 0;
  const due: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const timers: Timers = {
    setTimeout(fn, ms) {
      const id = ++ids;
      due.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout(h) {
      const i = due.findIndex((d) => d.id === h);
      if (i >= 0) due.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next || next.at > end) break;
      due.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { timers, clock: () => now, advance };
}

test("a 60 Hz drag sends at most PRESENCE_PER_SEC presence messages a second, and the last state always arrives", async () => {
  const vt = virtualTime();
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Conn();
  const client = new SyncClient({ queue: q, branchId: "b", schemaVersion: 1, connect: async () => conn, timers: vt.timers, clock: vt.clock, defer: (fn) => queueMicrotask(fn) }).start();
  await new Promise((r) => setTimeout(r, 0));
  conn.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  const me = { kind: "human" as const, id: "me" };
  for (let i = 0; i < 60; i++) {
    client.sendPresence(me, { at: i, dragging: true });
    vt.advance(1000 / 60);
  }
  vt.advance(500); // the trailing update goes out when its interval ends
  const sent = conn.sent.filter((m) => m.type === "presence") as Extract<ClientMessage, { type: "presence" }>[];
  assert.ok(sent.length <= PRESENCE_PER_SEC + 1, `${sent.length} presence messages for one second of dragging`);
  assert.ok(sent.length >= PRESENCE_PER_SEC - 1, `only ${sent.length}: the throttle drops more than it should`);
  assert.equal(sent.at(-1)!.state?.at, 59, "the last position was lost");
  client.stop();
  vt.advance(1000); // no timer left behind after stop
});
