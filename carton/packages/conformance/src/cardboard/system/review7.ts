// Regressions found by review round 7 (GPT 6.1 Sol), on the real engine's adapter.
import test from "node:test";
import assert from "node:assert/strict";
import type { Carton, ConflictCard } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cartonMaterializerEngine, TIMELINE_FILE } from "@carton/cardboard/node";

test("review 7 #4: a retry answered `pending` by id (a shared cut offline) still reports the cards of its first attempt", async () => {
  const store = createMemoryStore();
  const cards: ConflictCard[] = [{ kind: "field", path: "timelineItems/a/opacity", base: 1, ours: 0.6, theirs: 0.33 } as ConflictCard];
  let calls = 0;
  // the parts of Carton the engine's commit uses: the first attempt merges with cards, the choosing commit and every
  // retry by id are queued (pending) on the shared cut
  const carton = {
    store,
    cut: "main",
    commit: async (i: { id?: string }) => (calls++ === 0 ? { status: "conflicts", cards } : { status: "pending", id: i.id }),
  } as unknown as Carton;
  const engine = cartonMaterializerEngine(carton);
  const author = { kind: "agent" as const, id: "director/c/t1", name: "director/c/t1" };
  const input = { doc: {}, base: { baseDoc: {}, baseSeq: 0, causal: [] }, author, meta: { file: TIMELINE_FILE }, id: "save-1" };
  const first = await engine.commit(input);
  assert.equal(first.status, "conflicts");
  // the materializer failed to record that result; its retry commits with the same id
  const again = await engine.commit(input);
  assert.equal(again.status, "conflicts", JSON.stringify(again));
  assert.deepEqual(again.cards?.map((c) => c.path), ["timelineItems/a/opacity"]);
});
