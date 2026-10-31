// Regressions found by review round 8 (GPT 6.1 Sol), on the real engine's adapter.
import test from "node:test";
import assert from "node:assert/strict";
import type { Carton } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cartonMaterializerEngine } from "@carton/cardboard/node";

test("review 8 #3: the head key moves with a pending change (a shared cut offline), not only with the confirmed seq", async () => {
  let pending: string[] = [];
  const carton = { store: createMemoryStore(), cut: "main", head: async () => ({ ref: { branchId: "main", seq: 4, pending }, doc: {} }) } as unknown as Carton;
  const engine = cartonMaterializerEngine(carton);
  const before = await engine.headRef!();
  pending = ["r1.7"]; // a commit queued offline: the optimistic doc changed, seq 4 still
  assert.notEqual(await engine.headRef!(), before);
  assert.equal(await engine.headRef!(), await engine.headRef!(), "and stable while nothing moves");
});
