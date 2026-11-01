// `absorbed` is emitted once the settle it comes with has run (web-demo REQ-U1): a rebase that empties an offline edit
// into a card brings the teammate's confirmed change with it, and a handler reading state at the event (fromCarton's
// nameOtherSide asks credits() for the card's other side) must find that change in History. Emitted before the settle,
// credits() answered null and the card said "Someone".
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CartonEvent } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };

test("credits() asked in an `absorbed` handler names the teammate whose confirmed change made the card", async () => {
  const w = world();
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  let b: Carton | undefined;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    b = await Carton.open({ adapter, store: await copyStore(raw), actor: bob, sync: w.sync("bob") });
    await until(() => b!.sync!.status === "up-to-date", 5000, "bob connected");
    // Bob renames the clip offline; Alice renames it too, confirmed; Bob's rebase empties his edit into a card
    await b.sync!.disconnect();
    assert.equal((await b.commit({ ops: [set("a", "name", "bob's")] })).status, "pending");
    assert.equal((await a.commit({ ops: [set("a", "name", "alice's")], wait: 5000 })).status, "confirmed");
    const seen: { cards: number; credit: Promise<Actor | null>; name: Promise<unknown> }[] = [];
    b.on((e: CartonEvent) => {
      if (e.type === "absorbed" && e.cards.length && !seen.length)
        seen.push({ cards: e.cards.length, credit: b!.credits(["items", "a"], { cut: e.branchId }), name: b!.head(e.branchId).then((h) => item(h.doc, "a")!.name) });
    });
    await b.sync!.connect();
    await until(() => seen.length > 0, 5000, "the absorbed event with its card");
    assert.ok(seen[0]!.cards > 0);
    assert.equal((await seen[0]!.credit)?.id, "alice", "the card's other side is Alice's change");
    assert.equal(await seen[0]!.name, "alice's", "head at the event has her value");
  } finally {
    await a.close();
    await b?.close();
    w.host.close();
  }
});
