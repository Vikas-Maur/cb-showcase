// The sequencer's per-connection presence cap (contract commit by hosts-plugins): a client flooding presence gets a
// burst through, then about 20 a second; the rest is dropped and counted, so it can't drive the relay's fan-out.
import test from "node:test";
import assert from "node:assert/strict";
import { world, fakeConn, memoryBlobs, BRANCH, clip, doc } from "./helpers.ts";
import { sync } from "@carton/core";

const hello = (): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1 });

test("a presence flood is capped per connection: a burst of 20, then about 20 a second; others are unaffected", async () => {
  let now = 1_000_000;
  const { seq } = await world(doc([clip("c0", 0, 5)]), { clock: () => now });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), c = fakeConn("carol/1");
  for (const x of [a, b, c]) await seq.handle(x, hello());
  b.inbox.length = 0;
  c.inbox.length = 0;
  const actor = { kind: "human" as const, id: "alice" };
  for (let i = 0; i < 200; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: i } });
  assert.equal(b.inbox.length, 20, "the burst");
  assert.equal(seq.stats.presenceDropped, 180);
  now += 1000; // a second later: about 20 more
  for (let i = 0; i < 50; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: 1000 + i } });
  assert.equal(b.inbox.length, 40);
  // a well-behaved client on the same branch is not throttled by the flooder
  for (let i = 0; i < 10; i++) await seq.handle(c, { type: "presence", branchId: BRANCH, actor: { kind: "human", id: "carol" }, state: { at: i } });
  assert.equal(a.inbox.filter((m) => m.type === "presence").length, 10);
  for (const x of [a, b, c]) seq.disconnect(x); // no trailing relay left waiting
});

test("a burst over the cap never loses its last state: the latest dropped update is relayed when the bucket refills", async () => {
  let now = 2_000_000;
  const { seq } = await world(doc([clip("c0", 0, 5)]), { clock: () => now });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  for (const x of [a, b]) await seq.handle(x, hello());
  b.inbox.length = 0;
  const actor = { kind: "human" as const, id: "alice" };
  // 30 updates queued behind a stalled upload, arriving together, ending with the drag's end
  for (let i = 0; i < 29; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: i, dragging: true } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: null });
  assert.equal(b.inbox.length, 20, "the burst");
  now += 1000; // the bucket refills; the trailing relay fires on its timer
  await new Promise((r) => setTimeout(r, 120));
  const last = b.inbox.at(-1) as sync.PresenceFanoutMsg;
  assert.equal(b.inbox.length, 21);
  assert.equal(last.state, null, "the drag's end was lost");
  seq.disconnect(a);
});

test("trailing presence is kept per branch: a burst on one branch never replaces another branch's last state", async () => {
  let now = 3_000_000;
  const { seq } = await world(doc([clip("c0", 0, 5)]), { clock: () => now });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  // a second branch, forked server-side, for the same connections
  const helloOn = (branchId: string): sync.HelloMsg => ({ type: "hello", branchId, have: 0, pending: [], rids: [], schemaVersion: 1 });
  await seq.createBranch({ id: "other", name: "other", forkOf: null, owner: "alice", kind: "variant", sequencer: { kind: "server", since: 0 } } as never, { doc0: doc([clip("c0", 0, 5)]) as never });
  for (const x of [a, b]) {
    await seq.handle(x, hello());
    await seq.handle(x, helloOn("other"));
  }
  b.inbox.length = 0;
  const actor = { kind: "human" as const, id: "alice" };
  for (let i = 0; i < 20; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: i, dragging: true } }); // the burst
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: null }); // dropped: waits on BRANCH
  await seq.handle(a, { type: "presence", branchId: "other", actor, state: { at: 1 } }); // dropped: waits on "other"
  now += 1000;
  await new Promise((r) => setTimeout(r, 300));
  const onMain = b.inbox.filter((m) => m.type === "presence" && (m as sync.PresenceFanoutMsg).branchId === BRANCH) as sync.PresenceFanoutMsg[];
  const onOther = b.inbox.filter((m) => m.type === "presence" && (m as sync.PresenceFanoutMsg).branchId === "other") as sync.PresenceFanoutMsg[];
  assert.equal(onMain.at(-1)?.state, null, "the main branch's drag end was replaced by the other branch's update");
  assert.equal(onOther.at(-1)?.state?.at, 1);
  seq.disconnect(a);
});

// foundation-core's owner check: a client that crashed or lost its network never sends `presence(null)`, so its
// teammates kept its cursor and ghosts forever. The server owes them a leave for each actor the connection showed.
const leaves = (c: { inbox: sync.ServerMessage[] }) => c.inbox.filter((m): m is sync.PresenceFanoutMsg => m.type === "presence" && m.state === null);

test("a connection that goes without a leave: each actor it showed gets `state: null` at its branch's others, once", async () => {
  const { seq } = await world(doc([clip("c0", 0, 5)]));
  await seq.createBranch({ id: "other", name: "other", forkOf: null, owner: "alice", kind: "variant", sequencer: { kind: "server", since: 0 } } as never, { doc0: doc([clip("c0", 0, 5)]) as never });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), elsewhere = fakeConn("carol/1");
  await seq.handle(a, hello());
  await seq.handle(b, hello());
  await seq.handle(elsewhere, { ...hello(), branchId: "other" });
  const human = { kind: "human" as const, id: "alice" };
  const agent = { kind: "agent" as const, id: "alice", agentId: "a-7", name: "Director" };
  const gone = { kind: "human" as const, id: "alice-2" };
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: human, state: { at: 1, dragging: true, ghosts: [{ item: "c0", track: "V1", start: 1, end: 2 }] } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: agent, state: { at: 2 } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: gone, state: { at: 3 } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: gone, state: null }); // withdrew itself
  assert.deepEqual(a.state?.shown?.map((s) => s.actor), [{ kind: "human", id: "alice" }, { kind: "agent", id: "alice", agentId: "a-7" }], "kept: only what names each actor");
  b.inbox.length = 0;
  seq.disconnect(a); // no presence(null) from the client: it crashed
  assert.deepEqual(leaves(b).map((m) => [m.branchId, m.actor]), [[BRANCH, { kind: "human", id: "alice" }], [BRANCH, { kind: "agent", id: "alice", agentId: "a-7" }]]);
  assert.equal(b.inbox.length, 2, "nothing but the two leaves");
  assert.equal(leaves(elsewhere).length, 0, "a connection on another branch never saw it");
  seq.disconnect(a);
  assert.equal(b.inbox.length, 2, "a second disconnect sends nothing");
  seq.disconnect(b);
  assert.equal(elsewhere.inbox.filter((m) => m.type === "presence").length, 0, "b showed nothing, so it owes nothing");
});

test("a leave waiting behind the rate cap goes out on disconnect, not dropped with the connection", async () => {
  const now = 4_000_000;
  const { seq } = await world(doc([clip("c0", 0, 5)]), { clock: () => now });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  for (const x of [a, b]) await seq.handle(x, hello());
  b.inbox.length = 0;
  const actor = { kind: "human" as const, id: "alice" };
  for (let i = 0; i < 25; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: i } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: null }); // behind the cap
  assert.equal(leaves(b).length, 0);
  seq.disconnect(a); // before the bucket refills
  assert.equal(leaves(b).length, 1, "the client's own leave, once");
  assert.equal(b.inbox.length, 21);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(b.inbox.length, 21, "no trailing relay after the disconnect");
  seq.disconnect(b);
});

test("the leave needs only the connection's state: a sequencer that never saw its presence (a host woken from hibernation) still sends it", async () => {
  const { seq } = await world(doc([clip("c0", 0, 5)]));
  const b = fakeConn("bob/1");
  await seq.handle(b, hello());
  b.inbox.length = 0;
  // the state a Durable Object kept in the socket's attachment, back after a wake
  const a = { ...fakeConn("alice/1"), state: { subs: [BRANCH], deadEpoch: -1, shown: [{ branchId: BRANCH, actor: { kind: "human" as const, id: "alice" } }] } };
  seq.attach(a);
  seq.disconnect(a);
  assert.deepEqual(leaves(b).map((m) => m.actor), [{ kind: "human", id: "alice" }]);
  seq.disconnect(b);
});

test("what a connection keeps for its leaves stays small: 4 actors at most, ids up to 200 characters; the rest is still relayed", async () => {
  const { seq } = await world(doc([clip("c0", 0, 5)]));
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  for (const x of [a, b]) await seq.handle(x, hello());
  b.inbox.length = 0;
  for (let i = 0; i < 6; i++) await seq.handle(a, { type: "presence", branchId: BRANCH, actor: { kind: "agent", id: `bot-${i}` }, state: { at: i } });
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: { kind: "human", id: "x".repeat(201) }, state: { at: 9 } });
  assert.equal(b.inbox.length, 7, "every update relayed");
  assert.deepEqual(a.state?.shown?.map((s) => s.actor.id), ["bot-0", "bot-1", "bot-2", "bot-3"]);
  assert.ok(JSON.stringify(a.state).length < 1024);
  seq.disconnect(a);
  seq.disconnect(b);
});

test("no leave while another connection shows the same actor there: a reconnect whose old socket times out later, or a second tab", async () => {
  const { seq } = await world(doc([clip("c0", 0, 5)]));
  const old = fakeConn("alice/1"), fresh = fakeConn("alice/1"), b = fakeConn("bob/1");
  for (const x of [old, fresh, b]) await seq.handle(x, hello());
  const actor = { kind: "human" as const, id: "alice" };
  await seq.handle(old, { type: "presence", branchId: BRANCH, actor, state: { at: 1 } });
  await seq.handle(fresh, { type: "presence", branchId: BRANCH, actor, state: { at: 2 } }); // back on a new socket
  b.inbox.length = 0;
  seq.disconnect(old); // the old socket's timeout, after the new one began
  assert.equal(leaves(b).length, 0, "the cursor alice still shows stays");
  seq.disconnect(fresh);
  assert.deepEqual(leaves(b).map((m) => m.actor), [{ kind: "human", id: "alice" }], "the last one out leaves");
  seq.disconnect(b);
});

// Round 2 (stage "CI #29 follow-ups"): presence that waited in the queue ran after its connection was gone, so its
// state reached the others and no leave ever followed.
test("presence still queued when its connection goes, sent directly or in an envelope, never reaches the others", async () => {
  const blobs = memoryBlobs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let stall = true;
  const get = blobs.get.bind(blobs);
  blobs.get = async (key, range) => {
    if (stall) {
      stall = false;
      await gate; // another client's envelope read, stalled: everything behind it waits
    }
    return get(key, range);
  };
  const { seq } = await world(doc([clip("c0", 0, 5)]), { blobs });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), c = fakeConn("carol/1");
  for (const x of [a, b, c]) await seq.handle(x, hello());
  b.inbox.length = 0;
  const key = (sha: string) => sync.clientEnvelopeKey(sha, Date.now());
  const enveloped = async (m: sync.ClientMessage) => ({ type: "blob" as const, ref: (await sync.seal(sync.oversized(m, 1)!, blobs, key)).ref });
  const stalled = seq.handle(c, await enveloped(hello()));
  const actor = { kind: "human" as const, id: "alice" };
  const direct = seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: 1 } });
  const inEnvelope = seq.handle(a, await enveloped({ type: "presence", branchId: BRANCH, actor, state: { at: 2 } }));
  seq.disconnect(a); // a crash: nothing it showed has reached anyone yet, so no leave is owed
  release();
  await Promise.all([stalled, direct, inEnvelope]);
  assert.deepEqual(b.inbox.filter((m) => m.type === "presence"), [], "nothing from a connection already gone");
});

test("presence still queued when its connection is replaced under the same id never reaches the others", async () => {
  // a host that hands a socket's id to its replacement (a restored socket, a reconnect): the old connection's queued
  // presence is not the new one's
  const blobs = memoryBlobs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let stall = true;
  const get = blobs.get.bind(blobs);
  blobs.get = async (key, range) => {
    if (stall) {
      stall = false;
      await gate;
    }
    return get(key, range);
  };
  const { seq } = await world(doc([clip("c0", 0, 5)]), { blobs });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), c = fakeConn("carol/1");
  for (const x of [a, b, c]) await seq.handle(x, hello());
  b.inbox.length = 0;
  const key = (sha: string) => sync.clientEnvelopeKey(sha, Date.now());
  const enveloped = async (m: sync.ClientMessage) => ({ type: "blob" as const, ref: (await sync.seal(sync.oversized(m, 1)!, blobs, key)).ref });
  const stalled = seq.handle(c, await enveloped(hello()));
  const actor = { kind: "human" as const, id: "alice" };
  const queued = seq.handle(a, { type: "presence", branchId: BRANCH, actor, state: { at: 1 } });
  seq.disconnect(a);
  const a2 = { ...fakeConn("alice/1"), id: a.id }; // its replacement, not yet subscribed
  seq.attach(a2);
  a2.state = { subs: [BRANCH], deadEpoch: -1 }; // as a host restores it, subscribed
  release();
  await Promise.all([stalled, queued]);
  assert.deepEqual(b.inbox.filter((m) => m.type === "presence"), [], "the replaced connection's presence");
  // the old connection's late close doesn't drop its replacement: the others' presence still reaches it, and its own
  // goes out
  seq.disconnect(a);
  await seq.handle(b, { type: "presence", branchId: BRANCH, actor: { kind: "human", id: "bob" }, state: { at: 9 } });
  assert.deepEqual(a2.inbox.filter((m) => m.type === "presence").map((m) => (m as sync.PresenceFanoutMsg).state), [{ at: 9 }]);
  await seq.handle(a2, { type: "presence", branchId: BRANCH, actor, state: { at: 3 } });
  assert.deepEqual(b.inbox.filter((m) => m.type === "presence").map((m) => (m as sync.PresenceFanoutMsg).state), [{ at: 3 }]);
});

// Round 4: with the replacement attached before the old connection's close, what the sequencer kept per id (the
// outbox, whose callback sends on the old socket; the presence cap; a relay waiting on it) went on serving the old one.
test("a replacement attached before the old connection closes gets its own sends, cap and waiting presence", async () => {
  let now = 1_000_000;
  const { seq } = await world(doc([clip("c0", 0, 5)]), { clock: () => now });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  await seq.handle(a, hello());
  await seq.handle(b, hello());
  const presence = (at: number) => ({ type: "presence" as const, branchId: BRANCH, actor: { kind: "human" as const, id: "alice" }, state: { at } });
  // the old connection over its cap: its last update waits for a refill
  for (let i = 0; i < 21; i++) await seq.handle(a, presence(i));
  const a2 = { ...fakeConn("alice/1"), id: a.id, state: structuredClone(a.state) };
  seq.attach(a2);
  seq.disconnect(a); // late: a no-op for the replacement
  a.inbox.length = 0;
  b.inbox.length = 0;
  // fan-out reaches the replacement, on its own socket
  await seq.handle(b, { type: "presence", branchId: BRANCH, actor: { kind: "human", id: "bob" }, state: { at: 7 } });
  assert.deepEqual(a2.inbox.filter((m) => m.type === "presence").map((m) => (m as sync.PresenceFanoutMsg).state), [{ at: 7 }]);
  assert.deepEqual(a.inbox, [], "nothing more on the old socket");
  // the replacement's own presence goes out at once (a cap of its own), and the old relay never replaces it
  await seq.handle(a2, presence(99));
  now += 1000;
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(b.inbox.filter((m) => m.type === "presence").map((m) => (m as sync.PresenceFanoutMsg).state), [{ at: 99 }]);
});

// Round 5: a message of the old connection still queued when it was replaced and closed got its reply, which made an
// outbox for it again that nothing would ever remove.
test("a replaced connection's queued message gets no reply on the old socket", async () => {
  const blobs = memoryBlobs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let stall = true;
  const get = blobs.get.bind(blobs);
  blobs.get = async (key, range) => {
    if (stall) {
      stall = false;
      await gate;
    }
    return get(key, range);
  };
  const { seq } = await world(doc([clip("c0", 0, 5)]), { blobs });
  const a = fakeConn("alice/1"), c = fakeConn("carol/1");
  await seq.handle(c, hello());
  await seq.handle(a, hello());
  const key = (sha: string) => sync.clientEnvelopeKey(sha, Date.now());
  const stalled = seq.handle(c, { type: "blob", ref: (await sync.seal(sync.oversized(hello(), 1)!, blobs, key)).ref });
  const queued = seq.handle(a, { type: "branchStatus", branchId: BRANCH } as sync.ClientMessage);
  const a2 = { ...fakeConn("alice/1"), id: a.id, state: structuredClone(a.state) };
  seq.attach(a2);
  seq.disconnect(a);
  a.inbox.length = 0;
  release();
  await Promise.all([stalled, queued]);
  assert.deepEqual(a.inbox, [], "nothing on the old socket");
  // the replacement is served as usual
  await seq.handle(a2, { type: "branchStatus", branchId: BRANCH } as sync.ClientMessage);
  assert.ok(a2.inbox.length > 0);
});
