// Regressions from review round 5, on real Carton (store-memory): a losing copy of a request never overwrites the
// winning copy's cards; retrying a request whose every edit was carded (an empty confirmation) never brings back a card
// resolved since, nor clears the Stop hook's marks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "@carton/store-memory";
import { runWrite, actorKey } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "codex/x", name: "Codex" };
const bob: Actor = { kind: "human", id: "bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const cardsIn = async (store: Store) => (await store.range<any>("notices", { prefix: [actorKey(agent)] })).flatMap((r) => r.value.cards ?? []).map((c: any) => c.path).sort();
const wrapWrite = (base: Store, write: Store["write"]): Store => ({ ...base, info: base.info, get: base.get.bind(base), range: base.range.bind(base), close: base.close.bind(base), write });

test("a copy of a request that loses the append race to another copy never overwrites the winner's cards", async () => {
  const data = createMemoryData();
  let hook: (() => Promise<void>) | null = null;
  const baseA = createMemoryStore({ shared: data });
  const a = await Carton.open({ adapter, store: wrapWrite(baseA, async (w, c) => { if (hook && w.some((x) => x.table === "changes")) { const h = hook; hook = null; await h(); } return baseA.write(w, c); }), init: { doc: doc0() }, actor: agent });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: agent });
  const human = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  await human.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const cut = (await a.cuts())[0]!.id;
  const req = () => ({ id: "agent.1", actor: agent, op: { kind: "commit" as const, base: { branchId: cut, seq: 0 } as any, ops: [set("c1", "name", "mine-1"), set("c2", "name", "mine-2"), set("c3", "name", "mine-3")] } });
  // A has computed its pass (one card, c1) and is about to append; meanwhile bob edits c2, and the other copy (B, a retry
  // of the same request on another holder) commits with two cards
  hook = async () => {
    await human.commit({ ops: [set("c2", "name", "bob-2")], author: bob });
    const rb = await runWrite(b, req());
    assert.equal(rb.status, "conflicts");
  };
  const ra = await runWrite(a, req());
  assert.deepEqual(await cardsIn(baseA), ["timelineItems/c1/name", "timelineItems/c2/name"], "the winner's two cards stand");
  assert.equal(ra.status, "conflicts", "the losing copy answers with the winner's cards");
  assert.deepEqual((ra as any).conflicts.map((c: any) => c.path).sort(), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  const items = (await a.head()).doc.timelineItems as Rec[];
  assert.equal(items.find((i) => i.id === "c3")!.name, "mine-3");
});

test("retrying a request whose every edit was carded never brings back a card resolved since", async () => {
  const data = createMemoryData();
  const store = createMemoryStore({ shared: data });
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  const human = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  await human.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const cut = (await a.cuts())[0]!.id;
  const req = () => ({ id: "agent.2", actor: agent, op: { kind: "commit" as const, base: { branchId: cut, seq: 0 } as any, ops: [set("c1", "name", "mine-1")] } });
  const r1 = await runWrite(a, req());
  assert.equal(r1.status, "conflicts");
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name"]);
  const seq = (await a.head()).ref.seq;
  // the card is resolved (cb resolve closes it); then the same request comes again (a retry)
  for (const row of await store.range<any>("notices", { prefix: [actorKey(agent)] })) await store.write([{ table: "notices", key: row.key, value: undefined }]);
  const r2 = await runWrite(a, req());
  assert.equal(r2.status, "conflicts", "answered as the first time");
  assert.deepEqual(await cardsIn(store), [], "the resolved card stays resolved");
  assert.equal((await a.head()).ref.seq, seq, "nothing new was committed");
});
