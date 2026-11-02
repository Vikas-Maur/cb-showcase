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

test("presence after a quiet spell goes out at once; a leave right after a move still goes out when the client stops (owner check)", async () => {
  const vt = virtualTime();
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Conn();
  const client = new SyncClient({ queue: q, branchId: "b", schemaVersion: 1, connect: async () => conn, timers: vt.timers, clock: vt.clock, defer: (fn) => queueMicrotask(fn) }).start();
  await new Promise((r) => setTimeout(r, 0));
  conn.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  const me = { kind: "human" as const, id: "me" };
  const presence = () => conn.sent.filter((m) => m.type === "presence") as Extract<ClientMessage, { type: "presence" }>[];
  vt.advance(5000);
  client.sendPresence(me, { at: 1 });
  assert.deepEqual(presence().map((m) => m.state?.at), [1], "the first update after a quiet spell isn't delayed");
  vt.advance(1000);
  client.sendPresence(me, { at: 2 });
  vt.advance(20);
  client.sendPresence(me, null); // the editor closes: its leave, inside the 100 ms interval
  assert.deepEqual(presence().map((m) => m.state?.at ?? null), [1, 2], "the leave is coalesced, waiting");
  client.stop();
  assert.deepEqual(presence().map((m) => m.state?.at ?? null), [1, 2, null], "the leave went out before the close");
  vt.advance(1000);
  assert.equal(presence().length, 3, "nothing after stop");
});

// hosts-plugins' request: a host that restarts, or a room evicted outright on a deploy, drops every socket and keeps no
// one to send leaves for, so peers shown before would stay as ghosts. The client tells them gone when its own
// connection closes (and when it stops); a peer still there shows again with its next update after the reconnect (or
// as the host tells the new connection from what it keeps, `kept`: the server's own tests).
test("when its connection closes, the client tells every peer it showed gone; after the reconnect a peer's next update shows it again", async () => {
  const vt = virtualTime();
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  class Dropping extends Conn {
    private closed: ((why: string) => void)[] = [];
    override onClose(l?: (why: string) => void) {
      if (l) this.closed.push(l);
    }
    lose(why: string) {
      this.open = false;
      for (const l of this.closed) l(why);
    }
  }
  const conns: Dropping[] = [];
  const events: { actor: unknown; state: unknown }[] = [];
  const client = new SyncClient({
    queue: q,
    branchId: "b",
    schemaVersion: 1,
    connect: async () => (conns.push(new Dropping()), conns.at(-1)!),
    timers: vt.timers,
    clock: vt.clock,
    defer: (fn) => queueMicrotask(fn),
    onEvent: (e) => void (e.type === "presence" && events.push({ actor: e.actor, state: e.state })),
  }).start();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await tick();
  conns[0]!.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  const ann = { kind: "human" as const, id: "ann" },
    bob = { kind: "human" as const, id: "bob" },
    cat = { kind: "agent" as const, id: "cat" };
  conns[0]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 1 } });
  conns[0]!.feed({ type: "presence", branchId: "b", actor: bob, state: { at: 2 } });
  conns[0]!.feed({ type: "presence", branchId: "b", actor: cat, state: { at: 3 } });
  conns[0]!.feed({ type: "presence", branchId: "b", actor: bob, state: null }); // bob left: nothing to clear for him
  conns[0]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 4 } }); // ann moved: still one entry
  events.length = 0;
  conns[0]!.lose("host restarted");
  assert.deepEqual(events, [{ actor: ann, state: null }, { actor: cat, state: null }], "each peer shown is told gone once");
  // reconnect: nothing is told again until a peer's next update
  vt.advance(1000);
  await tick();
  assert.equal(conns.length, 2, "reconnected");
  conns[1]!.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  assert.equal(events.length, 2);
  conns[1]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 5 } });
  assert.deepEqual(events.at(-1), { actor: ann, state: { at: 5 } });
  // stopping tells them gone too (this replica no longer sees anyone)
  client.stop();
  assert.deepEqual(events.slice(3), [{ actor: ann, state: null }]);
  conns[1]!.lose("late close");
  assert.equal(events.length, 4, "nothing after stop");
});

// Presence P2 (the real app, merge/prod-2): after a host restart the first client back re-announced to a room the other
// hadn't rejoined yet; a host that restarted keeps nothing to tell the latecomer. A peer seen for the first time on a
// connection gets this replica's own presence again, once per arrival; one the host told from what it keeps (`kept`)
// was there when we came, and had ours.
test("a peer arriving on this connection gets our presence again, once; a kept one, a known one, a leave or no presence of our own send nothing", async () => {
  const vt = virtualTime();
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conn = new Conn();
  const client = new SyncClient({ queue: q, branchId: "b", schemaVersion: 1, connect: async () => conn, timers: vt.timers, clock: vt.clock, defer: (fn) => queueMicrotask(fn) }).start();
  await new Promise((r) => setTimeout(r, 0));
  conn.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  const presence = () => (conn.sent.filter((m) => m.type === "presence") as Extract<ClientMessage, { type: "presence" }>[]).map((m) => m.state);
  const ann = { kind: "human" as const, id: "ann" },
    bob = { kind: "human" as const, id: "bob" },
    cat = { kind: "human" as const, id: "cat" };
  conn.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 1 } });
  assert.deepEqual(presence(), [], "no presence of our own yet: nothing to say");
  const me = { kind: "human" as const, id: "me" };
  client.sendPresence(me, { idle: true });
  assert.deepEqual(presence(), [{ idle: true }]);
  vt.advance(1000);
  conn.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 2 } }); // known: no answer
  conn.feed({ type: "presence", branchId: "b", actor: bob, state: { at: 1 }, kept: true }); // told by the host: no answer
  conn.feed({ type: "presence", branchId: "b", actor: cat, state: null }); // a leave: no answer
  assert.deepEqual(presence(), [{ idle: true }]);
  conn.feed({ type: "presence", branchId: "b", actor: cat, state: { at: 1 } }); // arrives: ours again, at once
  assert.deepEqual(presence(), [{ idle: true }, { idle: true }]);
  conn.feed({ type: "presence", branchId: "b", actor: cat, state: null });
  conn.feed({ type: "presence", branchId: "b", actor: cat, state: { at: 2 } }); // back: once more, within the throttle
  conn.feed({ type: "presence", branchId: "b", actor: { kind: "human", id: "dan" }, state: { at: 1 } }); // coalesced with it
  vt.advance(500);
  assert.deepEqual(presence(), [{ idle: true }, { idle: true }, { idle: true }]);
  client.sendPresence(me, null); // our leave: a later arrival hears nothing from us
  conn.feed({ type: "presence", branchId: "b", actor: { kind: "human", id: "eve" }, state: { at: 1 } });
  vt.advance(500);
  assert.deepEqual(presence(), [{ idle: true }, { idle: true }, { idle: true }, null]);
  client.stop();
});

// Presence P2 review: a second tab of someone already shown (after a host lost what it keeps, a Durable Object's wake)
// says nothing new by its actor, so a connection's first presence says `arrived`, and peers answer that too.
test("a connection's first presence says `arrived` (again after a reconnect, never on a leave); an arrival is answered even from a known actor; agents of one person are told apart", async () => {
  const vt = virtualTime();
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: "b", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  class Dropping extends Conn {
    private closed: ((why: string) => void)[] = [];
    override onClose(l?: (why: string) => void) {
      if (l) this.closed.push(l);
    }
    lose(why: string) {
      this.open = false;
      for (const l of this.closed) l(why);
    }
  }
  const conns: Dropping[] = [];
  const client = new SyncClient({ queue: q, branchId: "b", schemaVersion: 1, connect: async () => (conns.push(new Dropping()), conns.at(-1)!), timers: vt.timers, clock: vt.clock, defer: (fn) => queueMicrotask(fn) }).start();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await tick();
  const sentOn = (c: Conn) => (c.sent.filter((m) => m.type === "presence") as Extract<ClientMessage, { type: "presence" }>[]).map((m) => [m.state, m.arrived ?? false]);
  conns[0]!.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  const me = { kind: "human" as const, id: "me" };
  client.sendPresence(me, null); // a leave first: not an arrival
  vt.advance(200);
  client.sendPresence(me, { at: 1 });
  vt.advance(200);
  client.sendPresence(me, { at: 2 });
  vt.advance(200);
  assert.deepEqual(sentOn(conns[0]!), [[null, false], [{ at: 1 }, true], [{ at: 2 }, false]]);
  const ann = { kind: "human" as const, id: "ann" };
  conns[0]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 1 } }); // arrives: answered
  vt.advance(200);
  conns[0]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 2 }, arrived: true }); // her second tab: answered
  vt.advance(200);
  conns[0]!.feed({ type: "presence", branchId: "b", actor: ann, state: { at: 3 } }); // known: not
  vt.advance(200);
  assert.equal(sentOn(conns[0]!).length, 5);
  // two agents of one person are two peers: the second's arrival is answered too
  conns[0]!.feed({ type: "presence", branchId: "b", actor: { kind: "agent", id: "ann", agentId: "a-1" }, state: { at: 1 } });
  vt.advance(200);
  conns[0]!.feed({ type: "presence", branchId: "b", actor: { kind: "agent", id: "ann", agentId: "a-2" }, state: { at: 1 } });
  vt.advance(200);
  assert.deepEqual(sentOn(conns[0]!).slice(3), [[{ at: 2 }, false], [{ at: 2 }, false], [{ at: 2 }, false], [{ at: 2 }, false]], "answers never say `arrived`");
  // a new connection: its first presence (the re-announce after the welcome) arrives again
  conns[0]!.lose("host restarted");
  vt.advance(1000);
  await tick();
  conns[1]!.feed({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  assert.deepEqual(sentOn(conns[1]!), [[{ at: 2 }, true]]);
  client.stop();
});
