// The `cuts` event (laptop re-check of merge/prod-2, P3 #1): a cut made by `cb cut new` with no edit yet never showed in
// the History panel's cut menu, even after reopening the panel, until you switched to it. The panel's view model
// re-read the cuts only on `change` events, and a new cut with no edit moves no head: nothing told it. The handle now
// tells `cuts` whenever the cuts it knows change, its own writes and another process's alike (another handle on the
// same store here, as `cb` and the app's worker are on carton.db), seen at the handle's next read of the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type CartonEvent } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

const counter = (c: Carton) => {
  let n = 0;
  c.on((e: CartonEvent) => void (e.type === "cuts" && n++));
  return () => n;
};

test("a cut made, renamed or published by another handle is told as `cuts` at this handle's next read", async () => {
  const store = createMemoryStore();
  const app = await Carton.open({ adapter, store, init: { doc: doc0() } });
  const cb = await Carton.open({ adapter, store });
  const told = counter(app);
  await app.log({ limit: 1 });
  assert.equal(told(), 0, "nothing changed: nothing told");

  // cb cut new: a cut with no edit, so no change row anywhere
  const alt = await cb.fork("Alt cut");
  await app.log({ limit: 1 }); // the app's next read of the store (the panel's poll reads the head)
  assert.equal(told(), 1, "the new cut is told");
  assert.ok((await app.cuts()).some((c) => c.id === alt.id && c.name === "Alt cut"));

  // a rename by another process
  await cb.renameCut(alt.id, "30s Instagram cut");
  await app.log({ limit: 1 });
  assert.equal(told(), 2, "the rename is told");
  assert.equal((await app.cuts()).find((c) => c.id === alt.id)?.name, "30s Instagram cut");

  // reads that find nothing new tell nothing, an edit on a cut tells `change` only
  await app.log({ limit: 1 });
  await app.cuts();
  await app.commit({ ops: [set("a", "startTime", 1)] });
  await app.log({ limit: 1 });
  assert.equal(told(), 2, "no cut changed: nothing more told");
  await app.close();
  await cb.close();
});

test("this handle's own new cut and rename are told too", async () => {
  const app = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const told = counter(app);
  const alt = await app.fork("Alt");
  assert.equal(told(), 1);
  await app.renameCut(alt.id, "Alt 2");
  assert.equal(told(), 2);
  await app.renameCut(alt.id, "Alt 2"); // the same name again: nothing changed
  await app.publish();
  assert.equal(told(), 3, "a publication is a cut too");
  await app.close();
});
