// Regressions from review rounds 3 and 4, on real Carton (store-memory): a save with cards lands except its cards, which
// core's own rebase loop decides "ours" and reports; they are written as a notice in the same batch as the append, so
// no crash or concurrent writer separates them; a writer that wins the append race adds its card; root fields and
// explicit nulls keep their cards; a retried request never brings a resolved card back; the base is fixed once per
// request; handing cards to the person is atomic; only idempotent writes are re-run after lost append races.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import type { Store, StoreWrite } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "@carton/store-memory";
import { runWrite, actorKey, withRaceRetry } from "../src/writes.ts";
import { StoreNoticeBox, humanCards, HUMAN_CARDS } from "../src/notices.ts";
import { adapter, doc0 } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "codex/x", name: "Codex" };
const bob: Actor = { kind: "human", id: "bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const item = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as Rec[]).find((i) => i.id === id)!;
const cardsIn = async (store: Store) => (await store.range<any>("notices", { prefix: [actorKey(agent)] })).flatMap((r) => r.value.cards ?? []).map((c: any) => c.path).sort();

/** Two handles on one store (two processes); the agent's store can be wrapped to watch or perturb its writes. */
async function two(wrap?: (base: Store) => Store) {
  const data = createMemoryData();
  const base = createMemoryStore({ shared: data });
  const store = wrap ? wrap(base) : base;
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  return { a, b, store: base };
}
const wrapWrite = (base: Store, write: Store["write"]): Store => ({ ...base, info: base.info, get: base.get.bind(base), range: base.range.bind(base), close: base.close.bind(base), write });
const root = async (a: Carton) => ({ branchId: (await a.cuts())[0]!.id, seq: 0 }) as any;

test("the cards are written in the same batch as the append that resolves them", async () => {
  const batches: StoreWrite[][] = [];
  const { a, b, store } = await two((base) => wrapWrite(base, (w, c) => (batches.push([...w]), base.write(w, c))));
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const r = await runWrite(a, { id: "agent.1", actor: agent, op: { kind: "commit", base: await root(a), ops: [set("c1", "name", "mine-1"), set("c3", "name", "mine-3")] } });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  assert.equal((await item(a, "c3")).name, "mine-3", "the rest landed");
  assert.equal((await item(a, "c1")).name, "bob-1", "the card kept head's value");
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name"]);
  const append = batches.find((w) => w.some((x) => x.table === "changes"));
  assert.ok(append?.some((x) => x.table === "notices"), "the notice row is part of the append's batch");
});

test("a writer that wins the append race adds its card: the cards of the pass that committed are the ones kept", async () => {
  let bobRef: Carton | null = null;
  let raced = false;
  const { a, b, store } = await two((base) => wrapWrite(base, async (w, c) => {
    if (!raced && bobRef && w.some((x) => x.table === "changes")) { raced = true; await bobRef.commit({ ops: [set("c2", "name", "bob-2")], author: bob }); }
    return base.write(w, c);
  }));
  bobRef = b;
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const r = await runWrite(a, { id: "agent.2", actor: agent, op: { kind: "commit", base: await root(a), ops: [set("c1", "name", "mine-1"), set("c2", "name", "mine-2"), set("c3", "name", "mine-3")] } });
  assert.ok(raced);
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  assert.deepEqual((r as any).conflicts.map((c: any) => c.path).sort(), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  assert.deepEqual(await cardsIn(store), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  assert.deepEqual([(await item(a, "c1")).name, (await item(a, "c2")).name, (await item(a, "c3")).name], ["bob-1", "bob-2", "mine-3"]);
});

test("a root field's card and an explicit null against an unset keep their cards (no path guessing)", async () => {
  const { a, b, store } = await two();
  await b.commit({ ops: [{ op: "set", path: ["name"], value: "Bob's film" }, { op: "unset", path: ["timelineItems", "c4", "opacity"] }], author: bob });
  const r = await runWrite(a, { id: "agent.3", actor: agent, op: { kind: "commit", base: await root(a), ops: [{ op: "set", path: ["name"], value: "Agent's film" }, set("c4", "opacity", null), set("c5", "name", "clean")] } });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  const paths = (r as any).conflicts.map((c: any) => c.path);
  assert.ok(paths.includes("name"), JSON.stringify(paths));
  assert.equal((await a.head()).doc.name, "Bob's film");
  assert.equal((await item(a, "c5")).name, "clean");
  assert.deepEqual(await cardsIn(store), [...paths].sort());
});

test("a retried request (same id) never brings back a card resolved after it landed", async () => {
  const { a, b, store } = await two();
  await b.commit({ ops: [set("c1", "name", "bob-1")], author: bob });
  const req = { id: "agent.4", actor: agent, op: { kind: "commit" as const, base: await root(a), ops: [set("c1", "name", "mine-1"), set("c3", "name", "mine-3")] } };
  await runWrite(a, structuredClone(req));
  for (const row of await store.range<any>("notices", { prefix: [actorKey(agent)] })) await store.write([{ table: "notices", key: row.key, value: undefined }]);
  const again = await runWrite(a, structuredClone(req));
  assert.equal(again.status, "confirmed", "deduplicated by the change id");
  assert.deepEqual(await cardsIn(store), []);
});

test("the base is fixed once per request: a re-run after lost append races never re-applies the save on a newer head", async () => {
  const { a, b } = await two();
  const proposal = structuredClone((await a.head()).doc) as any;
  proposal.timelineItems.find((i: Rec) => i.id === "c1").name = "mine-1";
  const realCommit = a.commit.bind(a);
  let first = true;
  (a as any).commit = async (input: any) => {
    if (first) {
      first = false;
      await b.commit({ ops: [set("c2", "name", "bob-2")], author: bob }); // another writer lands meanwhile
      throw new Error("Carton: the store changed under this write (lost the append race or a condition failed)");
    }
    return realCommit(input);
  };
  const req = { id: "agent.5", actor: agent, op: { kind: "commit" as const, doc: proposal } };
  const r = await withRaceRetry(true, () => runWrite(a, req));
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal((await item(a, "c1")).name, "mine-1");
  assert.equal((await item(a, "c2")).name, "bob-2", "the other writer's edit survives (merged from the request's own base)");
});

test("handing cards to the person is one batch: a crash leaves them with the agent, the next stop hands them over", async () => {
  const base = createMemoryStore();
  const key = [actorKey({ kind: "agent", id: "codex/y" } as Actor), 1, 0];
  await base.write([{ table: "notices", key, value: { to: key[0], kind: "late-conflict", text: "t", change: "r.9", cards: [{ kind: "field", path: "timelineItems/c1/name", base: 1, ours: 2, theirs: 3 }], blockedAt: 1 } }]);
  let crash = true;
  const faulty = wrapWrite(base, async (w, c) => { if (crash && w.some((x) => x.key[0] === HUMAN_CARDS)) { crash = false; throw new Error("crash"); } return base.write(w, c); });
  await assert.rejects(new StoreNoticeBox(faulty, { keyOf: () => key[0] as string }).handToHumanAsync("codex/y", [JSON.stringify(key)]), /crash/);
  assert.equal(((await base.get("notices", key)) as any).handedToHuman, undefined, "not hidden from the agent");
  assert.equal((await humanCards(base)).length, 0);
  await new StoreNoticeBox(base, { keyOf: () => key[0] as string }).handToHumanAsync("codex/y", [JSON.stringify(key)]);
  assert.equal((await humanCards(base)).length, 1);
  assert.ok(((await base.get("notices", key)) as any).handedToHuman);
});

test("an idempotent write is run again after core lost its append race too often; others are not", async () => {
  let n = 0;
  const lost = () => { n++; if (n < 3) throw new Error("Carton: the store changed under this write (lost the append race or a condition failed)"); return Promise.resolve("ok"); };
  assert.equal(await withRaceRetry(true, async () => lost()), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRaceRetry(false, async () => lost()), /store changed/);
  assert.equal(n, 1, "a fold or undo is never run twice");
  await assert.rejects(withRaceRetry(true, async () => { throw new Error("other"); }), /other/);
});
