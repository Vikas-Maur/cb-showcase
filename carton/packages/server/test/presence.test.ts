// The sequencer's per-connection presence cap (contract commit by hosts-plugins): a client flooding presence gets a
// burst through, then about 20 a second; the rest is dropped and counted, so it can't drive the relay's fan-out.
import test from "node:test";
import assert from "node:assert/strict";
import { world, fakeConn, BRANCH, clip, doc } from "./helpers.ts";
import type { sync } from "@carton/core";

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
