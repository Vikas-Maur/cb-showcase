// Regressions from review round 3, on real Carton (store-memory): a save with cards lands except its cards; every merge
// pass's cards are kept, including a pass a concurrent writer causes; the cards are in carton.db before the append
// that resolves them; root fields and explicit nulls keep their cards; a card resolved meanwhile stays resolved; the
// hand-over to the person is atomic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "@carton/store-memory";
import { runWrite, actorKey } from "../src/writes.ts";
import { StoreNoticeBox, humanCards, HUMAN_CARDS } from "../src/notices.ts";
import { adapter, doc0 } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "codex/x", name: "Codex" };
const bob: Actor = { kind: "human", id: "bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const item = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as Rec[]).find((i) => i.id === id)!;
const cardsIn = async (store: Store) => (await store.range<any>("notices", { prefix: [actorKey(agent)] })).flatMap((r) => r.value.cards ?? []).map((c: any) => c.path).sort();

async function two() {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: agent });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  return { data, a, b, store: (a as any).store as Store };
}

test("a writer slipping in between merge passes adds a card; both cards are kept, the rest of the save lands", async () => {
  const { a, b, store } = await two();
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  // the agent saves from main@0: c1 (conflicts now), c2 (conflicts once bob's second edit slips in), c3 (clean)
  const realCommit = a.commit.bind(a);
  let passes = 0;
  (a as any).commit = async (input: any) => {
    const r = await realCommit(input);
    if (++passes === 1) await b.commit({ ops: [set("c2", "name", "bob-2")], author: bob });
    return r;
  };
  const r = await runWrite(a, { id: "agent.1", actor: agent, op: { kind: "commit", base: { branchId: (await a.cuts())[0]!.id, seq: 0 } as any, ops: [set("c1", "name", "mine-1"), set("c2", "name", "mine-2"), set("c3", "name", "mine-3")] } as any });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  assert.deepEqual((r as any).conflicts.map((c: any) => c.path).sort(), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  assert.deepEqual([(await item(a, "c1")).name, (await item(a, "c2")).name, (await item(a, "c3")).name], ["bob-1", "bob-2", "mine-3"]);
  assert.ok(passes >= 3, `passes: ${passes}`);
});

test("the cards are in carton.db before the append that resolves them: a holder that dies right after it loses none", async () => {
  const { a, b, store } = await two();
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const realCommit = a.commit.bind(a);
  let calls = 0;
  (a as any).commit = async (input: any) => {
    const r = await realCommit(input);
    if (++calls === 2) throw new Error("holder died after the append"); // the resolving pass appended, then the process died
    return r;
  };
  const op = { kind: "commit" as const, base: { branchId: (await a.cuts())[0]!.id, seq: 0 } as any, ops: [set("c1", "name", "mine-1"), set("c3", "name", "mine-3")] };
  await assert.rejects(runWrite(a, { id: "agent.2", actor: agent, op }), /holder died/);
  assert.equal((await item(a, "c3")).name, "mine-3", "the append happened");
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name"], "the card is there for cb conflicts / cb resolve");
  (a as any).commit = realCommit;
  const again = await runWrite(a, { id: "agent.2", actor: agent, op });
  assert.ok(again.status === "confirmed" || again.status === "conflicts", JSON.stringify(again));
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name"], "the retry neither loses nor duplicates it");
});

test("a root field's card and an explicit null against an unset keep their cards (no path guessing)", async () => {
  const { a, b, store } = await two();
  const cut = (await a.cuts())[0]!.id;
  await b.commit({ ops: [{ op: "set", path: ["name"], value: "Bob's film" }, { op: "unset", path: ["timelineItems", "c4", "opacity"] }], author: bob });
  const r = await runWrite(a, { id: "agent.3", actor: agent, op: { kind: "commit", base: { branchId: cut, seq: 0 } as any, ops: [{ op: "set", path: ["name"], value: "Agent's film" }, set("c4", "opacity", null), set("c5", "name", "clean")] } });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  const paths = (r as any).conflicts.map((c: any) => c.path);
  assert.ok(paths.includes("name"), JSON.stringify(paths));
  assert.equal((await a.head()).doc.name, "Bob's film");
  assert.equal((await item(a, "c5")).name, "clean");
  assert.deepEqual(await cardsIn(store), [...paths].sort());
});

test("a card resolved while a later pass is still running stays resolved", async () => {
  const { a, b, store } = await two();
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const realCommit = a.commit.bind(a);
  let passes = 0;
  (a as any).commit = async (input: any) => {
    if (++passes === 2) {
      // pass 0's card (c1) is in carton.db now; `cb resolve` closes it, and bob's second edit makes pass 1 conflict on c2
      assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name"]);
      for (const row of await store.range<any>("notices", { prefix: [actorKey(agent)] })) await store.write([{ table: "notices", key: row.key, value: undefined }]);
      await b.commit({ ops: [set("c2", "name", "bob-2")], author: bob });
    }
    return realCommit(input);
  };
  await runWrite(a, { id: "agent.4", actor: agent, op: { kind: "commit", base: { branchId: (await a.cuts())[0]!.id, seq: 0 } as any, ops: [set("c1", "name", "mine-1"), set("c2", "name", "mine-2")] } });
  // c1's card is written before pass 1; the resolve deleted it; pass 2 adds c2 only
  assert.deepEqual(await cardsIn(store), ["timelineItems/c2/name"]);
});

test("handing cards to the person is one batch: a crash leaves them with the agent, the next stop hands them over", async () => {
  const data = createMemoryData();
  const base = createMemoryStore({ shared: data });
  const key = [actorKey({ kind: "agent", id: "codex/y" } as Actor), 1, 0];
  await base.write([{ table: "notices", key, value: { to: key[0], kind: "late-conflict", text: "t", change: "r.9", cards: [{ kind: "field", path: "timelineItems/c1/name", base: 1, ours: 2, theirs: 3 }], blockedAt: 1 } }]);
  let crash = true;
  const faulty: Store = { ...base, info: base.info, get: base.get.bind(base), range: base.range.bind(base), close: base.close.bind(base),
    async write(w, c) { if (crash && w.some((x) => x.key[0] === HUMAN_CARDS)) { crash = false; throw new Error("crash"); } return base.write(w, c); } };
  await assert.rejects(new StoreNoticeBox(faulty, { keyOf: () => key[0] as string }).handToHumanAsync("codex/y", [JSON.stringify(key)]), /crash/);
  assert.equal(((await base.get("notices", key)) as any).handedToHuman, undefined, "not hidden from the agent");
  assert.equal((await humanCards(base)).length, 0);
  await new StoreNoticeBox(base, { keyOf: () => key[0] as string }).handToHumanAsync("codex/y", [JSON.stringify(key)]);
  assert.equal((await humanCards(base)).length, 1);
  assert.ok(((await base.get("notices", key)) as any).handedToHuman);
});

test("an idempotent write is run again after core lost its append race too often; others are not", async () => {
  const { withRaceRetry } = await import("../src/writes.ts");
  let n = 0;
  const lost = () => { n++; if (n < 3) throw new Error("Carton: the store changed under this write (lost the append race or a condition failed)"); return Promise.resolve("ok"); };
  assert.equal(await withRaceRetry(true, async () => lost()), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRaceRetry(false, async () => lost()), /store changed/);
  assert.equal(n, 1, "a fold or undo is never run twice");
  await assert.rejects(withRaceRetry(true, async () => { throw new Error("other"); }), /other/);
});
