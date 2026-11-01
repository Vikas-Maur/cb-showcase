// windows-sync (round 4 #2): `cb`'s Save As must not write history while the app's handle holds edits waiting for the
// server, and `cb`'s handle has no sync, so it read core's `pending` rows itself (a layout it shouldn't depend on).
// `pendingCount(cut)` is the public read: from the store, so every handle on the project sees the same count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };

test("pendingCount: a handle without sync counts the edits another handle holds waiting for the server", async () => {
  const w = world();
  const s = createMemoryStore();
  const app = await Carton.open({ adapter, store: s, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const local = (await app.fork("local copy")).id;
  await app.share();
  await until(async () => (await app.cuts()).find((c) => c.id === app.cut)!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = app.cut;
  const cb = await Carton.open({ adapter, store: s, actor: alice });
  assert.equal(cb.sync, null);
  assert.equal(await cb.pendingCount(cut), 0);
  await app.sync!.disconnect();
  for (const n of ["x", "y"]) assert.equal((await app.commit({ ops: [set("a", "name", n)] })).status, "pending");
  assert.equal(await cb.pendingCount(cut), 2, "cb sees the app's two waiting edits");
  assert.equal(await app.pendingCount(), 2, "the app's own handle, its current cut");
  assert.equal(app.sync!.state(cut).pending, 2, "the same as the sync state's count");
  assert.equal(await cb.pendingCount(local), 0, "a cut no server sequences");
  await app.sync!.connect({ timeoutMs: 5000 });
  await until(async () => (await cb.pendingCount(cut)) === 0, 5000, "both confirmed, nothing waiting");
  for (const c of [cb, app]) await c.close();
});
