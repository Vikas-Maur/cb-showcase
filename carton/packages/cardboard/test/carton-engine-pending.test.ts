// apply-ryw review #3: the changes a pinned head holds past its seq (`Pinned.pending`) are head's own, as the pin was
// made. Core hands back the pending list of an earlier pin of the same state (cut, seq and hash), so edits that cancel
// out (a name changed and back, offline on a shared cut) came back without their ids, and a write waiting to show in
// timeline.tsx was told "later" though the file showed it. Core's list is taken only when head moved during the pin.
import test from "node:test";
import assert from "node:assert/strict";
import { cartonMaterializerEngine } from "../src/node/carton-engine.ts";

/** A Carton stand-in: head's pending ids (`heads`, one per read), and a pin that answers an earlier pin's list. */
function fakeCarton(heads: string[][], stale: string[]) {
  let reads = 0;
  const ref = (pending: string[]) => ({ branchId: "cut-1", seq: 7, hash8: "0badf00d", pending });
  return {
    cut: "cut-1",
    store: { get: async () => undefined, write: async () => true, range: async () => [] },
    head: async () => ({ ref: ref(heads[Math.min(reads++, heads.length - 1)]!), doc: {} }),
    pin: async () => ({ ref: ref(stale), header: "Main cut@7~0badf00d b:cut-1xxx p:00000000 by carton" }),
    checkout: async () => ({}),
  };
}

test("apply-ryw review #3: a pinned head's pending changes are head's as pinned, not an earlier pin's of the same state", async () => {
  const engine = cartonMaterializerEngine(fakeCarton([["p1", "p2"]], []) as never, { shared: () => true });
  const p = await engine.pin({ owner: "shared-file", ttlMs: 1000, deferRecord: true });
  assert.deepEqual(p.pending, ["p1", "p2"]);
});

test("apply-ryw review #3: head moved during the pin: core's list is kept", async () => {
  const engine = cartonMaterializerEngine(fakeCarton([["p1"], ["p1", "p2"]], ["p1"]) as never, { shared: () => true });
  const p = await engine.pin({ owner: "shared-file", ttlMs: 1000, deferRecord: true });
  assert.deepEqual(p.pending, ["p1"]);
});

test("apply-ryw review #3: a held state's pending changes are the causal past it was pinned with", async () => {
  const engine = cartonMaterializerEngine(fakeCarton([["x"]], ["old"]) as never, { shared: () => true });
  const p = await engine.pin({ owner: "shared-view", ttlMs: 1000, doc: {}, seq: 7, causal: ["a", "b"], deferRecord: true });
  assert.deepEqual(p.pending, ["a", "b"]);
});
